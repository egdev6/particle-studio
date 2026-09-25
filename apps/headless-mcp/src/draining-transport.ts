import type {
  JSONRPCMessage,
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/server";
import type { RequestDrain } from "./request-drain.js";

/**
 * Wraps any SDK `Transport` so every request that crosses the wire boundary is
 * accounted for in the given drain:
 *
 * - every inbound message the installed `onmessage` handler receives is
 *   tracked before delegation, and
 * - every outbound `send()` is tracked before delegation.
 *
 * Messages are never swallowed, reordered, or transformed; the inner `send`
 * promise is returned unchanged. Optional `Transport` members stay optional:
 * the wrapper keeps working when the inner transport does not implement them.
 */
export function withRequestDrain<T extends Transport>(
  transport: T,
  drain: RequestDrain,
): Transport {
  // A handler already installed on the inner transport before wrapping is
  // wrapped in place so its inbound messages are tracked too.
  const existingOnmessage = transport.onmessage;
  if (existingOnmessage !== undefined) {
    transport.onmessage = (message, extra) => {
      drain.trackInbound(message);
      existingOnmessage(message, extra);
    };
  }

  const wrapped: Transport = {
    start: () => transport.start(),
    send: (message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> => {
      drain.trackOutbound(message);
      return transport.send(message, options);
    },
    close: () => transport.close(),
    get onmessage() {
      return transport.onmessage;
    },
    set onmessage(handler) {
      transport.onmessage =
        handler === undefined
          ? undefined
          : (message, extra) => {
              drain.trackInbound(message);
              handler(message, extra);
            };
    },
    get onclose() {
      return transport.onclose;
    },
    set onclose(handler) {
      transport.onclose = handler;
    },
    get onerror() {
      return transport.onerror;
    },
    set onerror(handler) {
      transport.onerror = handler;
    },
    get sessionId() {
      return transport.sessionId;
    },
    set sessionId(sessionId) {
      transport.sessionId = sessionId;
    },
  };

  const setProtocolVersion = transport.setProtocolVersion;
  if (setProtocolVersion !== undefined) {
    wrapped.setProtocolVersion = (version: string) => setProtocolVersion(version);
  }

  const setSupportedProtocolVersions = transport.setSupportedProtocolVersions;
  if (setSupportedProtocolVersions !== undefined) {
    wrapped.setSupportedProtocolVersions = (versions: string[]) =>
      setSupportedProtocolVersions(versions);
  }

  if (transport.hasPerRequestStream !== undefined) {
    const hasPerRequestStream = transport.hasPerRequestStream;
    Object.defineProperty(wrapped, "hasPerRequestStream", {
      enumerable: true,
      get: () => hasPerRequestStream,
    });
  }

  return wrapped;
}
