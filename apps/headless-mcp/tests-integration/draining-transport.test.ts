import type {
  JSONRPCMessage,
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { withRequestDrain } from "../src/draining-transport.js";
import { createRequestDrain, type RequestDrain } from "../src/request-drain.js";

const requestMessage = (id: number | string): JSONRPCMessage => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: {},
} as JSONRPCMessage);

const responseMessage = (id: number | string): JSONRPCMessage => ({
  jsonrpc: "2.0",
  id,
  result: { ok: true },
} as JSONRPCMessage);

/**
 * Minimal recording transport: only `start`, `send`, and `close` exist; every
 * optional `Transport` member is deliberately absent so the wrapper must keep
 * working without them.
 */
const createBareTransport = () => {
  const calls: string[] = [];
  const sent: Array<{ message: JSONRPCMessage; options?: TransportSendOptions }> = [];
  let pendingSend: Promise<void> = Promise.resolve();
  const transport = {
    startCalls: 0,
    closed: 0,
    start(): Promise<void> {
      this.startCalls += 1;
      calls.push("start");
      return Promise.resolve();
    },
    send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
      calls.push("send");
      sent.push({ message, options });
      return pendingSend;
    },
    close(): Promise<void> {
      this.closed += 1;
      calls.push("close");
      return Promise.resolve();
    },
  };
  return { transport, calls, sent, setPendingSend: (p: Promise<void>) => { pendingSend = p; } };
};

/** Drain spy that records the order in which the wrapper touches accounting. */
const createDrainSpy = (): RequestDrain & { events: string[] } => {
  const events: string[] = [];
  const inner = createRequestDrain();
  return {
    events,
    trackInbound(message: unknown): void {
      events.push("trackInbound");
      inner.trackInbound(message);
    },
    trackOutbound(message: unknown): void {
      events.push("trackOutbound");
      inner.trackOutbound(message);
    },
    pending: () => inner.pending(),
    whenIdle: (timeoutMs: number) => inner.whenIdle(timeoutMs),
  };
};

describe("withRequestDrain", () => {
  it("forwards start to the inner transport", async () => {
    const { transport, calls } = createBareTransport();
    const wrapped = withRequestDrain(transport as unknown as Transport, createRequestDrain());
    await wrapped.start();
    expect(transport.startCalls).toBe(1);
    expect(calls).toEqual(["start"]);
  });

  it("forwards close to the inner transport", async () => {
    const { transport, calls } = createBareTransport();
    const wrapped = withRequestDrain(transport as unknown as Transport, createRequestDrain());
    await wrapped.close();
    expect(transport.closed).toBe(1);
    expect(calls).toEqual(["close"]);
  });

  it("tracks outbound send before delegating and returns the inner promise unchanged", async () => {
    const { transport, calls, sent } = createBareTransport();
    const drain = createDrainSpy();
    const wrapped = withRequestDrain(transport as unknown as Transport, drain);
    const message = responseMessage(1);
    const returned = wrapped.send(message);
    expect(returned).toBeInstanceOf(Promise);
    await returned;

    expect(drain.events).toEqual(["trackOutbound"]);
    expect(calls).toEqual(["send"]);
    expect(sent).toEqual([{ message, options: undefined }]);
    expect(drain.pending()).toBe(0);
  });

  it("forwards send options untouched", async () => {
    const { transport, sent } = createBareTransport();
    const wrapped = withRequestDrain(transport as unknown as Transport, createRequestDrain());
    const options = { relatedRequestId: "req-1" } as TransportSendOptions;
    await wrapped.send(responseMessage(1), options);
    expect(sent[0]?.options).toBe(options);
  });

  it("propagates a rejected inner send unchanged", async () => {
    const { transport, setPendingSend } = createBareTransport();
    const failure = Promise.reject(new Error("wire down"));
    setPendingSend(failure);
    const drain = createRequestDrain();
    const wrapped = withRequestDrain(transport as unknown as Transport, drain);
    const result = wrapped.send(responseMessage(1));
    expect(result).toBe(failure);
    await expect(result).rejects.toThrow("wire down");
  });

  it("tracks inbound messages before delegating them to the installed handler", async () => {
    const { transport } = createBareTransport();
    const drain = createDrainSpy();
    const wrapped = withRequestDrain(transport as unknown as Transport, drain);
    const received: JSONRPCMessage[] = [];
    wrapped.onmessage = (message) => {
      received.push(message);
    };

    const message = requestMessage(1);
    (transport as unknown as Transport).onmessage?.(message);
    expect(drain.events).toEqual(["trackInbound"]);
    expect(received).toEqual([message]);
    expect(drain.pending()).toBe(1);
  });

  it("wraps a handler that already existed on the inner transport", () => {
    const { transport } = createBareTransport();
    const drain = createRequestDrain();
    const received: JSONRPCMessage[] = [];
    const inner = transport as unknown as Transport;
    inner.onmessage = (message) => {
      received.push(message);
    };
    const wrapped = withRequestDrain(inner, drain);
    wrapped.onmessage?.(requestMessage(1));
    expect(received).toHaveLength(1);
    expect(drain.pending()).toBe(1);
  });

  it("does not transform, reorder, or swallow inbound messages, including extra info", () => {
    const { transport } = createBareTransport();
    const wrapped = withRequestDrain(transport as unknown as Transport, createRequestDrain());
    const received: Array<{ message: JSONRPCMessage; extra: unknown }> = [];
    wrapped.onmessage = (message, extra) => {
      received.push({ message, extra });
    };
    const inner = transport as unknown as Transport;
    const first = requestMessage("a");
    const second = requestMessage("b");
    const extra = { authInfo: { token: "t" } } as never;
    inner.onmessage?.(first, extra);
    inner.onmessage?.(second);
    expect(received.map((entry) => entry.message)).toEqual([first, second]);
    expect(received[0]?.extra).toBe(extra);
    expect(received[1]?.extra).toBeUndefined();
  });

  it("keeps onclose and onerror forwarding live in both directions", () => {
    const { transport } = createBareTransport();
    const wrapped = withRequestDrain(transport as unknown as Transport, createRequestDrain());
    const inner = transport as unknown as Transport;

    const onClose = () => {};
    const onError = (error: Error) => void error;
    wrapped.onclose = onClose;
    wrapped.onerror = onError;
    expect(inner.onclose).toBe(onClose);
    expect(inner.onerror).toBe(onError);
    expect(wrapped.onclose).toBe(onClose);
    expect(wrapped.onerror).toBe(onError);

    const errors: Error[] = [];
    wrapped.onerror = (error) => errors.push(error);
    inner.onerror?.(new Error("boom"));
    expect(errors.map((error) => error.message)).toEqual(["boom"]);

    wrapped.onclose = undefined;
    wrapped.onerror = undefined;
    expect(inner.onclose).toBeUndefined();
    expect(inner.onerror).toBeUndefined();
  });

  it("forwards sessionId live", () => {
    const { transport } = createBareTransport();
    const inner = transport as unknown as Transport;
    const wrapped = withRequestDrain(inner, createRequestDrain());
    expect(wrapped.sessionId).toBeUndefined();
    inner.sessionId = "session-1";
    expect(wrapped.sessionId).toBe("session-1");
  });

  it("forwards setProtocolVersion and setSupportedProtocolVersions when present", () => {
    const versionsSet: string[][] = [];
    const protocolVersions: string[] = [];
    const inner = {
      ...createBareTransport().transport,
      setProtocolVersion: (version: string) => protocolVersions.push(version),
      setSupportedProtocolVersions: (versions: string[]) => {
        versionsSet.push(versions);
      },
    } as unknown as Transport;
    const wrapped = withRequestDrain(inner, createRequestDrain());
    wrapped.setProtocolVersion?.("2025-06-18");
    wrapped.setSupportedProtocolVersions?.(["2025-06-18"]);
    expect(protocolVersions).toEqual(["2025-06-18"]);
    expect(versionsSet).toEqual([["2025-06-18"]]);
  });

  it("leaves optional members undefined when the inner transport lacks them", () => {
    const { transport } = createBareTransport();
    const wrapped = withRequestDrain(transport as unknown as Transport, createRequestDrain());
    expect(wrapped.setProtocolVersion).toBeUndefined();
    expect(wrapped.setSupportedProtocolVersions).toBeUndefined();
    expect(wrapped.hasPerRequestStream).toBeUndefined();
  });

  it("forwards hasPerRequestStream when the inner transport defines it", () => {
    const inner = {
      ...createBareTransport().transport,
      hasPerRequestStream: true,
    } as unknown as Transport;
    const wrapped = withRequestDrain(inner, createRequestDrain());
    expect(wrapped.hasPerRequestStream).toBe(true);
  });

  it("end-to-end: an unanswered request keeps the drain busy and a response settles it", async () => {
    const { transport } = createBareTransport();
    const drain = createRequestDrain();
    const wrapped = withRequestDrain(transport as unknown as Transport, drain);
    wrapped.onmessage = () => {};
    const inner = transport as unknown as Transport;

    inner.onmessage?.(requestMessage(1));
    inner.onmessage?.(requestMessage(2));
    expect(drain.pending()).toBe(2);
    await wrapped.send(responseMessage(1));
    expect(drain.pending()).toBe(1);
    await wrapped.send(responseMessage(2));
    expect(drain.pending()).toBe(0);
    await expect(drain.whenIdle(0)).resolves.toBe(true);
  });
});
