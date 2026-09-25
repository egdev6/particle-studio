import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SHUTDOWN_DRAIN_TIMEOUT_MS,
  createRequestDrain,
  decidePreReadyExitCode,
  decideShutdownExitCode,
  formatDrainTimeoutDiagnostic,
  formatShutdownBeforeReadyDiagnostic,
  type RequestDrain,
} from "../src/request-drain.js";

const request = (id: number | string, method = "tools/call") => ({
  jsonrpc: "2.0",
  id,
  method,
  params: {},
});

const response = (id: number | string, result: unknown = { ok: true }) => ({
  jsonrpc: "2.0",
  id,
  result,
});

const cancellation = (requestId: number | string) => ({
  jsonrpc: "2.0",
  method: "notifications/cancelled",
  params: { requestId },
});

describe("request-drain", () => {
  describe("constants", () => {
    it("fixes the shutdown drain timeout at five seconds", () => {
      expect(SHUTDOWN_DRAIN_TIMEOUT_MS).toBe(5_000);
    });
  });

  describe("inbound classification", () => {
    let drain: RequestDrain;

    beforeEach(() => {
      drain = createRequestDrain();
    });

    it("counts an inbound JSON-RPC request as pending", () => {
      drain.trackInbound(request(1));
      expect(drain.pending()).toBe(1);
    });

    it("ignores inbound notifications", () => {
      drain.trackInbound({ jsonrpc: "2.0", method: "notifications/initialized" });
      expect(drain.pending()).toBe(0);
    });

    it("ignores inbound responses", () => {
      drain.trackInbound(response(1));
      expect(drain.pending()).toBe(0);
    });

    it("ignores inbound requests without a present id", () => {
      drain.trackInbound({ jsonrpc: "2.0", method: "tools/call", params: {} });
      expect(drain.pending()).toBe(0);
    });

    it("ignores inbound requests whose id is not a string or number", () => {
      drain.trackInbound({ jsonrpc: "2.0", id: null, method: "tools/call" });
      drain.trackInbound({ jsonrpc: "2.0", id: { value: 1 }, method: "tools/call" });
      expect(drain.pending()).toBe(0);
    });

    it("counts string and number ids independently", () => {
      drain.trackInbound(request(1));
      drain.trackInbound(request("1"));
      expect(drain.pending()).toBe(2);
    });

    it("ignores non-object messages", () => {
      drain.trackInbound("not a message");
      drain.trackInbound(null);
      drain.trackInbound(undefined);
      drain.trackInbound(42);
      expect(drain.pending()).toBe(0);
    });
  });

  describe("settlement", () => {
    let drain: RequestDrain;

    beforeEach(() => {
      drain = createRequestDrain();
    });

    it("settles a pending request when a response with the same id is sent", () => {
      drain.trackInbound(request(7));
      expect(drain.pending()).toBe(1);
      drain.trackOutbound(response(7));
      expect(drain.pending()).toBe(0);
    });

    it("settles error responses as well as result responses", () => {
      drain.trackInbound(request(1));
      drain.trackInbound(request(2));
      drain.trackOutbound({ jsonrpc: "2.0", id: 2, error: { code: -32602, message: "bad" } });
      expect(drain.pending()).toBe(1);
      drain.trackOutbound(response(1));
      expect(drain.pending()).toBe(0);
    });

    it("ignores outbound messages that carry a method (server requests and notifications)", () => {
      drain.trackInbound(request(1));
      drain.trackOutbound({ jsonrpc: "2.0", id: 9, method: "sampling/createMessage", params: {} });
      drain.trackOutbound({ jsonrpc: "2.0", method: "notifications/message" });
      expect(drain.pending()).toBe(1);
    });

    it("ignores outbound messages without a result or error", () => {
      drain.trackInbound(request(1));
      drain.trackOutbound({ jsonrpc: "2.0", id: 1 });
      expect(drain.pending()).toBe(1);
    });

    it("ignores outbound messages without a present id", () => {
      drain.trackOutbound({ jsonrpc: "2.0", result: {} });
      expect(drain.pending()).toBe(0);
    });

    it("does not go negative when a response settles an unknown id", () => {
      drain.trackInbound(request(1));
      drain.trackOutbound(response(999));
      drain.trackOutbound(response(999));
      expect(drain.pending()).toBe(1);
    });

    it("does not go negative for repeated responses to the same id", () => {
      drain.trackInbound(request(1));
      drain.trackOutbound(response(1));
      drain.trackOutbound(response(1));
      expect(drain.pending()).toBe(0);
    });

    it("settles a pending request when a cancellation for its id arrives", () => {
      drain.trackInbound(request(5));
      expect(drain.pending()).toBe(1);
      drain.trackInbound(cancellation(5));
      expect(drain.pending()).toBe(0);
    });

    it("ignores a cancellation for an unknown id without going negative", () => {
      drain.trackInbound(request(5));
      drain.trackInbound(cancellation(999));
      expect(drain.pending()).toBe(1);
    });

    it("ignores a cancellation whose params lack a string or number requestId", () => {
      drain.trackInbound(request(5));
      drain.trackInbound({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} });
      drain.trackInbound({ jsonrpc: "2.0", method: "notifications/cancelled" });
      drain.trackInbound({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: null },
      });
      expect(drain.pending()).toBe(1);
    });
  });

  describe("whenIdle", () => {
    let drain: RequestDrain;

    beforeEach(() => {
      drain = createRequestDrain();
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("resolves true immediately when nothing is pending", async () => {
      await expect(drain.whenIdle(1_000)).resolves.toBe(true);
    });

    it("resolves true as soon as the pending set empties", async () => {
      drain.trackInbound(request(1));
      const idle = drain.whenIdle(60_000);
      drain.trackOutbound(response(1));
      await expect(idle).resolves.toBe(true);
    });

    it("resolves false when the bound elapses with work still pending", async () => {
      drain.trackInbound(request(1));
      const idle = drain.whenIdle(1_000);
      const settled = vi.fn();
      void idle.then(settled);
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledWith(false);
      await expect(idle).resolves.toBe(false);
    });

    it("still works for later callers after a timed-out wait", async () => {
      drain.trackInbound(request(1));
      const timedOut = drain.whenIdle(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(timedOut).resolves.toBe(false);

      drain.trackOutbound(response(1));
      await expect(drain.whenIdle(1_000)).resolves.toBe(true);
    });

    it("resolves a still-waiting caller and does not double-resolve a timed-out one", async () => {
      drain.trackInbound(request(1));
      const outcomes: boolean[] = [];
      const timedOut = drain.whenIdle(500).then((value: boolean) => {
        outcomes.push(value);
        return value;
      });
      const stillWaiting = drain.whenIdle(60_000).then((value: boolean) => {
        outcomes.push(value);
        return value;
      });

      await vi.advanceTimersByTimeAsync(500);
      await expect(timedOut).resolves.toBe(false);
      expect(outcomes).toEqual([false]);

      drain.trackOutbound(response(1));
      await expect(stillWaiting).resolves.toBe(true);
      expect(outcomes).toEqual([false, true]);

      // The timed-out waiter was removed and its timer cleared: advancing the
      // clock must not resolve anything again or leave work behind.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(outcomes).toEqual([false, true]);
      expect(drain.pending()).toBe(0);
    });

    it("leaves no timer behind when the set empties before the bound", async () => {
      drain.trackInbound(request(1));
      const idle = drain.whenIdle(1_000);
      drain.trackOutbound(response(1));
      await expect(idle).resolves.toBe(true);
      // If the timer had leaked, this advance would fire a second resolution
      // against a removed waiter; the process must simply stay quiet.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(drain.pending()).toBe(0);
    });

    it("supports several concurrent pending requests", async () => {
      drain.trackInbound(request(1));
      drain.trackInbound(request("2"));
      const idle = drain.whenIdle(60_000);
      drain.trackOutbound(response(1));
      drain.trackOutbound(response("2"));
      await expect(idle).resolves.toBe(true);
    });

    it("does not resolve a waiter when only an unknown id settles", async () => {
      drain.trackInbound(request(1));
      const idle = drain.whenIdle(60_000);
      const settled = vi.fn();
      void idle.then(settled);
      drain.trackOutbound(response(999));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).not.toHaveBeenCalled();
      drain.trackOutbound(response(1));
      await expect(idle).resolves.toBe(true);
    });
  });

  describe("real-timer sanity", () => {
    it("resolves false with real timers when the bound elapses", async () => {
      const drain = createRequestDrain();
      drain.trackInbound(request(1));
      await expect(drain.whenIdle(20)).resolves.toBe(false);
    });
  });

  describe("decideShutdownExitCode", () => {
    it("returns the requested exit code when drained", () => {
      expect(decideShutdownExitCode({ drained: true, requestedExitCode: 0 })).toBe(0);
      expect(decideShutdownExitCode({ drained: true, requestedExitCode: 3 })).toBe(3);
    });

    it("returns a non-zero exit code when work was dropped", () => {
      expect(decideShutdownExitCode({ drained: false, requestedExitCode: 0 })).not.toBe(0);
      expect(decideShutdownExitCode({ drained: false, requestedExitCode: 0 })).toBe(1);
    });
  });

  describe("decidePreReadyExitCode", () => {
    it("returns 0 when nothing had been received on stdin", () => {
      expect(decidePreReadyExitCode({ receivedBytes: 0 })).toBe(0);
    });

    it("returns non-zero when any byte was received before readiness", () => {
      expect(decidePreReadyExitCode({ receivedBytes: 1 })).toBe(1);
      expect(decidePreReadyExitCode({ receivedBytes: 2 })).toBe(1);
      expect(decidePreReadyExitCode({ receivedBytes: 8192 })).toBe(1);
    });
  });

  describe("formatShutdownBeforeReadyDiagnostic", () => {
    it("names the trigger and the received byte count on one deterministic stderr-safe line", () => {
      const first = formatShutdownBeforeReadyDiagnostic({
        trigger: "SIGTERM",
        receivedBytes: 2048,
      });
      const second = formatShutdownBeforeReadyDiagnostic({
        trigger: "SIGTERM",
        receivedBytes: 2048,
      });
      expect(first).toBe(second);
      expect(first).toContain("SIGTERM");
      expect(first).toContain("2048");
      expect(first).not.toContain("\n");
      expect(first).not.toContain("\r");
      expect(
        formatShutdownBeforeReadyDiagnostic({ trigger: "stdin end", receivedBytes: 2048 }),
      ).not.toBe(first);
      expect(
        formatShutdownBeforeReadyDiagnostic({ trigger: "SIGTERM", receivedBytes: 0 }),
      ).not.toBe(first);
      expect(
        formatShutdownBeforeReadyDiagnostic({ trigger: "SIGTERM", receivedBytes: 0 }),
      ).toContain("0");
      expect(
        formatShutdownBeforeReadyDiagnostic({ trigger: "SIGINT", receivedBytes: 3 }),
      ).toContain("SIGINT");
    });
  });

  describe("formatDrainTimeoutDiagnostic", () => {
    it("names the pending count on a single deterministic stderr-safe line", () => {
      const first = formatDrainTimeoutDiagnostic(2);
      const second = formatDrainTimeoutDiagnostic(2);
      expect(first).toBe(second);
      expect(first).toContain("2");
      expect(first).not.toContain("\n");
      expect(first).not.toContain("\r");
      expect(formatDrainTimeoutDiagnostic(0)).toContain("0");
      expect(formatDrainTimeoutDiagnostic(0)).not.toBe(first);
    });
  });
});
