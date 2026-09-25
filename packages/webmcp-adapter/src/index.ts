export type BrowserAgentToolName =
  | "particle_studio.get_draft_summary"
  | "particle_studio.validate_draft"
  | "particle_studio.dispatch_draft_command"
  | "particle_studio.undo"
  | "particle_studio.redo";

export interface BrowserAgentToolDefinition {
  readonly name: BrowserAgentToolName;
}

export interface BrowserAgentWorkspacePort {
  getDraftSummary(): unknown | Promise<unknown>;
  validateDraft(document: unknown): unknown | Promise<unknown>;
  dispatch(command: unknown): unknown | Promise<unknown>;
  undo(): unknown | Promise<unknown>;
  redo(): unknown | Promise<unknown>;
}

export type BrowserAgentResponse =
  | Readonly<{
      schemaVersion: 1;
      requestId: string;
      result: unknown;
    }>
  | Readonly<{
      schemaVersion: 1;
      requestId: string | null;
      error: Readonly<{
        code:
          | "WEBMCP_MALFORMED_REQUEST"
          | "WEBMCP_TOOL_NOT_FOUND"
          | "WEBMCP_WORKSPACE_UNAVAILABLE";
      }>;
    }>;

export interface BrowserAgentAdapter {
  readonly tools: readonly BrowserAgentToolDefinition[];
  execute(request: unknown): Promise<BrowserAgentResponse>;
}

type SafeTransportValue =
  | null
  | boolean
  | string
  | number
  | readonly SafeTransportValue[]
  | { readonly [key: string]: SafeTransportValue };

type ParsedRequest = {
  readonly requestId: string;
  readonly tool: string;
  readonly input:
    | { readonly kind: "empty" }
    | { readonly kind: "document"; readonly document: unknown }
    | { readonly kind: "command"; readonly command: unknown };
};

const tools = Object.freeze([
  Object.freeze({ name: "particle_studio.get_draft_summary" as const }),
  Object.freeze({ name: "particle_studio.validate_draft" as const }),
  Object.freeze({ name: "particle_studio.dispatch_draft_command" as const }),
  Object.freeze({ name: "particle_studio.undo" as const }),
  Object.freeze({ name: "particle_studio.redo" as const }),
]);

const knownTools = new Set<string>(tools.map(({ name }) => name));

/**
 * Bounded JSON-like transport accepted by the adapter. A node is every visited
 * value (including the root and every object property or array element value).
 * Bounds admit MVP documents with roughly 1,000 elements while bounding
 * validation, cloning, and freezing work for untrusted transport values.
 */
export const TRANSPORT_BUDGET = Object.freeze({
  maxDepth: 64,
  maxVisitedNodes: 50_000,
  maxArrayLength: 4_096,
  maxOwnProperties: 256,
  maxStringCodeUnits: 16_384,
  maxCumulativeStringCodeUnits: 1_000_000,
});

/** Maximum time an accepted native workspace Promise may remain pending. */
export const WORKSPACE_PROMISE_TIMEOUT_MS = 15_000;

const NativePromise = Promise;
const nativePromiseThen = NativePromise.prototype.then;
declare const workspaceTimer: unique symbol;
type WorkspaceTimer = { readonly [workspaceTimer]: never };
// SAFETY: browsers provide these timer methods; their opaque handle returns only
// to the matching clearTimeout method and is never inspected by the adapter.
const timers = globalThis as unknown as {
  setTimeout(callback: () => void, delay: number): WorkspaceTimer;
  clearTimeout(timeout: WorkspaceTimer): void;
};

type WorkspacePromiseSettlement =
  | { readonly fulfilled: true; readonly value: unknown }
  | { readonly fulfilled: false };

type TransportBudget = {
  visitedNodes: number;
  stringCodeUnits: number;
};

function createTransportBudget(): TransportBudget {
  return { visitedNodes: 0, stringCodeUnits: 0 };
}

function consumeString(value: string, budget: TransportBudget): boolean {
  budget.stringCodeUnits += value.length;
  return (
    value.length <= TRANSPORT_BUDGET.maxStringCodeUnits &&
    budget.stringCodeUnits <= TRANSPORT_BUDGET.maxCumulativeStringCodeUnits
  );
}

function isSafeNumber(value: number): boolean {
  return (
    Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  );
}

function ownData(
  value: Record<string, unknown> | readonly unknown[],
  key: string,
): unknown | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    return false;
  }
  const names = Object.getOwnPropertyNames(value);
  return (
    names.length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        names.includes(key) &&
        descriptor !== undefined &&
        "value" in descriptor &&
        descriptor.enumerable
      );
    })
  );
}

function consumeNode(budget: TransportBudget): boolean {
  budget.visitedNodes += 1;
  return budget.visitedNodes <= TRANSPORT_BUDGET.maxVisitedNodes;
}

function isSafeTransportValue(
  value: unknown,
  budget = createTransportBudget(),
  depth = 0,
  ancestors = new WeakSet<object>(),
): value is SafeTransportValue {
  try {
    if (!consumeNode(budget)) return false;
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "string") return consumeString(value, budget);
    if (typeof value === "number") return isSafeNumber(value);
    if (typeof value !== "object" || depth > TRANSPORT_BUDGET.maxDepth) {
      return false;
    }
    if (
      ancestors.has(value) ||
      Object.getOwnPropertySymbols(value).length !== 0
    ) {
      return false;
    }

    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false;
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value > TRANSPORT_BUDGET.maxArrayLength
      ) {
        return false;
      }
      const length = lengthDescriptor.value;
      const names = Object.getOwnPropertyNames(value);
      // Array index names and the intrinsic non-enumerable `length` name are
      // charged exactly like plain-object keys, so arrays cannot bypass either
      // string budget.
      if (
        lengthDescriptor.enumerable ||
        lengthDescriptor.configurable ||
        names.length !== length + 1 ||
        !names.includes("length") ||
        !names.every((name) => consumeString(name, budget))
      ) {
        return false;
      }
      ancestors.add(value);
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          !descriptor.enumerable ||
          !isSafeTransportValue(descriptor.value, budget, depth + 1, ancestors)
        ) {
          return false;
        }
      }
      ancestors.delete(value);
      return true;
    }

    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    const names = Object.getOwnPropertyNames(value);
    if (names.length > TRANSPORT_BUDGET.maxOwnProperties) return false;
    ancestors.add(value);
    for (const key of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !consumeString(key, budget) ||
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        !isSafeTransportValue(descriptor.value, budget, depth + 1, ancestors)
      ) {
        return false;
      }
    }
    ancestors.delete(value);
    return true;
  } catch {
    return false;
  }
}

function cloneSafe(value: unknown): SafeTransportValue | undefined {
  if (!isSafeTransportValue(value)) return undefined;
  try {
    // SAFETY: Node 24 and supported browsers provide structuredClone.
    const copied = (
      globalThis as unknown as {
        structuredClone(input: unknown): SafeTransportValue;
      }
    ).structuredClone(value);
    return isSafeTransportValue(copied) ? copied : undefined;
  } catch {
    return undefined;
  }
}

function freezeDeep<T>(value: T, depth = 0): T {
  if (value !== null && typeof value === "object") {
    if (depth > TRANSPORT_BUDGET.maxDepth) {
      throw new TypeError("TRANSPORT_BUDGET_EXCEEDED");
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      if (Array.isArray(value) && key === "length") continue;
      const child = ownData(
        value as Record<string, unknown> | readonly unknown[],
        key,
      );
      if (child !== undefined) freezeDeep(child, depth + 1);
    }
    Object.freeze(value);
  }
  return value;
}

function adapterError(
  requestId: string | null,
  code:
    | "WEBMCP_MALFORMED_REQUEST"
    | "WEBMCP_TOOL_NOT_FOUND"
    | "WEBMCP_WORKSPACE_UNAVAILABLE",
): BrowserAgentResponse {
  return Object.freeze({
    schemaVersion: 1 as const,
    requestId,
    error: Object.freeze({ code }),
  });
}

/**
 * Only same-realm native Promise instances cross the asynchronous boundary.
 * `instanceof` excludes foreign Promises; the intrinsic call supplies the final
 * brand check and bypasses an instance-level `then` override.
 */
function awaitNativeWorkspacePromise(
  value: unknown,
): Promise<WorkspacePromiseSettlement> | undefined {
  try {
    if (!(value instanceof NativePromise)) return undefined;
  } catch {
    return undefined;
  }

  return new NativePromise<WorkspacePromiseSettlement>((resolve) => {
    let settled = false;
    let timeout: WorkspaceTimer;
    const complete = (settlement: WorkspacePromiseSettlement) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timeout);
      resolve(settlement);
    };

    timeout = timers.setTimeout(() => {
      complete({ fulfilled: false });
    }, WORKSPACE_PROMISE_TIMEOUT_MS);

    try {
      nativePromiseThen.call(
        value,
        (result: unknown) => complete({ fulfilled: true, value: result }),
        () => complete({ fulfilled: false }),
      );
    } catch {
      complete({ fulfilled: false });
    }
  });
}

function parseRequest(value: unknown): ParsedRequest | undefined {
  if (!isSafeTransportValue(value)) return undefined;
  try {
    if (
      !isExactRecord(value, ["schemaVersion", "requestId", "tool", "input"])
    ) {
      return undefined;
    }
    const schemaVersion = ownData(value, "schemaVersion");
    const requestId = ownData(value, "requestId");
    const tool = ownData(value, "tool");
    const input = ownData(value, "input");
    if (
      schemaVersion !== 1 ||
      typeof requestId !== "string" ||
      requestId.length === 0 ||
      typeof tool !== "string"
    ) {
      return undefined;
    }
    if (!knownTools.has(tool)) {
      return { requestId, tool, input: { kind: "empty" } };
    }
    if (
      tool === "particle_studio.get_draft_summary" ||
      tool === "particle_studio.undo" ||
      tool === "particle_studio.redo"
    ) {
      return isExactRecord(input, [])
        ? { requestId, tool, input: { kind: "empty" } }
        : undefined;
    }
    if (tool === "particle_studio.validate_draft") {
      if (!isExactRecord(input, ["document"])) return undefined;
      return {
        requestId,
        tool,
        input: { kind: "document", document: ownData(input, "document") },
      };
    }
    if (!isExactRecord(input, ["command"])) return undefined;
    const command = ownData(input, "command");
    if (
      !isExactRecord(command, [
        "commandSchemaVersion",
        "commandId",
        "documentId",
        "expectedRevision",
        "payload",
      ])
    ) {
      return undefined;
    }
    const commandSchemaVersion = ownData(command, "commandSchemaVersion");
    const commandId = ownData(command, "commandId");
    const documentId = ownData(command, "documentId");
    const expectedRevision = ownData(command, "expectedRevision");
    const payload = ownData(command, "payload");
    if (
      commandSchemaVersion !== 1 ||
      typeof commandId !== "string" ||
      commandId.length === 0 ||
      typeof documentId !== "string" ||
      documentId.length === 0 ||
      typeof expectedRevision !== "number" ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0
    ) {
      return undefined;
    }
    return {
      requestId,
      tool,
      input: {
        kind: "command",
        command: {
          commandSchemaVersion,
          commandId,
          documentId,
          expectedRevision,
          payload,
          actorCapability: "browser-agent",
        },
      },
    };
  } catch {
    return undefined;
  }
}

export function createBrowserAgentAdapter(
  workspacePort: BrowserAgentWorkspacePort,
): BrowserAgentAdapter {
  const execute = async (request: unknown): Promise<BrowserAgentResponse> => {
    // Validate the caller-owned envelope without invoking user getters, then
    // clone the whole envelope. Parsing is repeated with a fresh budget so
    // workspace calls can consume only values from the isolated clone.
    if (parseRequest(request) === undefined) {
      return adapterError(null, "WEBMCP_MALFORMED_REQUEST");
    }
    const copiedRequest = cloneSafe(request);
    const parsed =
      copiedRequest === undefined ? undefined : parseRequest(copiedRequest);
    if (parsed === undefined) {
      return adapterError(null, "WEBMCP_MALFORMED_REQUEST");
    }
    if (!knownTools.has(parsed.tool)) {
      return adapterError(parsed.requestId, "WEBMCP_TOOL_NOT_FOUND");
    }

    try {
      let rawResult: unknown;
      switch (parsed.tool) {
        case "particle_studio.get_draft_summary":
          rawResult = workspacePort.getDraftSummary();
          break;
        case "particle_studio.validate_draft":
          rawResult = workspacePort.validateDraft(
            (parsed.input as { readonly document: unknown }).document,
          );
          break;
        case "particle_studio.dispatch_draft_command":
          rawResult = workspacePort.dispatch(
            (parsed.input as { readonly command: unknown }).command,
          );
          break;
        case "particle_studio.undo":
          rawResult = workspacePort.undo();
          break;
        case "particle_studio.redo":
          rawResult = workspacePort.redo();
          break;
        default:
          return adapterError(parsed.requestId, "WEBMCP_TOOL_NOT_FOUND");
      }
      const asynchronousResult = awaitNativeWorkspacePromise(rawResult);
      let result: unknown = rawResult;
      if (asynchronousResult !== undefined) {
        const settlement = await asynchronousResult;
        if (!settlement.fulfilled) {
          return adapterError(parsed.requestId, "WEBMCP_WORKSPACE_UNAVAILABLE");
        }
        result = settlement.value;
      }
      const copiedResult = cloneSafe(result);
      if (copiedResult === undefined) {
        return adapterError(parsed.requestId, "WEBMCP_WORKSPACE_UNAVAILABLE");
      }
      return Object.freeze({
        schemaVersion: 1 as const,
        requestId: parsed.requestId,
        result: freezeDeep(copiedResult),
      });
    } catch {
      return adapterError(parsed.requestId, "WEBMCP_WORKSPACE_UNAVAILABLE");
    }
  };

  return Object.freeze({ tools, execute });
}
