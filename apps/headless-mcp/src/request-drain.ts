/**
 * Wire-boundary drain accounting for the headless MCP server.
 *
 * A request is pending from the moment the transport delivers it until a
 * result or error response with the same id is sent, or a
 * `notifications/cancelled` for that id arrives (mirroring the SDK's own
 * accounting). Only public JSON-RPC message shapes are inspected; no protocol
 * parsing happens beyond the classification rules below.
 */

/** Fixed bound for shutdown draining. Deliberately not configurable. */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;

export interface RequestDrain {
  /** Accounts for one message delivered inbound on the wire. */
  trackInbound(message: unknown): void;
  /** Accounts for one message written outbound on the wire. */
  trackOutbound(message: unknown): void;
  /** Number of requests currently awaiting their response. */
  pending(): number;
  /**
   * Resolves `true` as soon as nothing is pending, or `false` once
   * `timeoutMs` elapses with work still pending. Every path clears its timer
   * and removes its waiter.
   */
  whenIdle(timeoutMs: number): Promise<boolean>;
}

interface JsonRpcLike {
  readonly [key: string]: unknown;
}

const isRecord = (value: unknown): value is JsonRpcLike =>
  typeof value === "object" && value !== null;

const isRequestId = (value: unknown): value is string | number =>
  typeof value === "string" || typeof value === "number";

/** String and number ids must never collide (JSON-RPC treats `1` and `"1"` as different ids). */
const keyOf = (id: string | number): string => `${typeof id}:${id}`;

const CANCELLED_NOTIFICATION = "notifications/cancelled";

export function createRequestDrain(): RequestDrain {
  const pending = new Set<string>();
  const waiters = new Set<(drained: boolean) => void>();

  const settle = (id: string | number): void => {
    // Deleting an unknown key is a no-op, so the count can never go negative.
    if (!pending.delete(keyOf(id))) return;
    if (pending.size !== 0) return;
    for (const waiter of [...waiters]) waiter(true);
  };

  return {
    trackInbound(message: unknown): void {
      if (!isRecord(message)) return;
      const method = message.method;
      if (typeof method !== "string") return;
      if (method === CANCELLED_NOTIFICATION) {
        const params = message.params;
        if (isRecord(params) && isRequestId(params.requestId)) {
          settle(params.requestId);
        }
        return;
      }
      const id = message.id;
      if (!("id" in message) || !isRequestId(id)) return;
      pending.add(keyOf(id));
    },

    trackOutbound(message: unknown): void {
      if (!isRecord(message)) return;
      // Responses never carry a method; server-originated requests and
      // notifications do and must not settle anything.
      if ("method" in message) return;
      if (!("id" in message) || !isRequestId(message.id)) return;
      if (!("result" in message || "error" in message)) return;
      settle(message.id);
    },

    pending: () => pending.size,

    whenIdle(timeoutMs: number): Promise<boolean> {
      if (pending.size === 0) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const waiter = (drained: boolean): void => {
          if (timer !== undefined) clearTimeout(timer);
          waiters.delete(waiter);
          resolve(drained);
        };
        timer = setTimeout(() => waiter(false), timeoutMs);
        waiters.add(waiter);
      });
    },
  };
}

/** Shutdown exit-code decision: the requested code when drained, non-zero otherwise. */
export function decideShutdownExitCode({
  drained,
  requestedExitCode,
}: {
  drained: boolean;
  requestedExitCode: number;
}): number {
  return drained ? requestedExitCode : 1;
}

/**
 * One deterministic stderr-safe line naming the number of unanswered
 * requests. No causes, no stacks, no timestamps.
 */
export function formatDrainTimeoutDiagnostic(pending: number): string {
  return `headless-mcp: shutdown drain timed out with ${pending} unanswered request(s)`;
}

/**
 * Pre-ready shutdown exit-code decision: exit 0 only when the client had
 * written nothing before the server reached readiness. Any received byte is
 * buffered work that a pre-ready process cannot answer, so the exit must be
 * non-zero and honest about the dropped work.
 */
export function decidePreReadyExitCode({
  receivedBytes,
}: {
  receivedBytes: number;
}): number {
  return receivedBytes === 0 ? 0 : 1;
}

/**
 * One deterministic stderr-safe line naming the shutdown trigger and how
 * many bytes had already been received when the process was triggered before
 * readiness. No causes, no stacks, no timestamps.
 */
export function formatShutdownBeforeReadyDiagnostic({
  trigger,
  receivedBytes,
}: {
  trigger: string;
  receivedBytes: number;
}): string {
  return `headless-mcp: shutdown before startup completed (trigger=${trigger}, receivedBytes=${receivedBytes})`;
}
