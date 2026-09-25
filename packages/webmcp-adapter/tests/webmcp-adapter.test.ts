import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TRANSPORT_BUDGET,
  WORKSPACE_PROMISE_TIMEOUT_MS,
  createBrowserAgentAdapter,
} from "../src/index.js";

const toolNames = [
  "particle_studio.get_draft_summary",
  "particle_studio.validate_draft",
  "particle_studio.dispatch_draft_command",
  "particle_studio.undo",
  "particle_studio.redo",
] as const;

const request = (
  tool: (typeof toolNames)[number],
  input: unknown,
  requestId = "request-1",
) => ({ schemaVersion: 1, requestId, tool, input });

function createPort() {
  const calls = {
    getDraftSummary: 0,
    validateDraft: 0,
    dispatch: 0,
    undo: 0,
    redo: 0,
  };
  const received: unknown[] = [];
  const port = {
    getDraftSummary: () => {
      calls.getDraftSummary += 1;
      return { ok: true, summary: { revision: 3 } };
    },
    validateDraft: (document: unknown) => {
      calls.validateDraft += 1;
      received.push(document);
      return { ok: false, error: { code: "INVALID_DRAFT" } };
    },
    dispatch: (command: unknown) => {
      calls.dispatch += 1;
      received.push(command);
      return { ok: true, revision: 4 };
    },
    undo: () => {
      calls.undo += 1;
      return { ok: false, error: { code: "NOTHING_TO_UNDO" } };
    },
    redo: () => {
      calls.redo += 1;
      return { ok: false, error: { code: "NOTHING_TO_REDO" } };
    },
  };
  return { calls, received, port };
}

describe("browser agent adapter", () => {
  it("exposes exactly the immutable ordered tool allowlist", () => {
    const { port } = createPort();
    const adapter = createBrowserAgentAdapter(port);

    expect(adapter.tools.map((tool) => tool.name)).toEqual(toolNames);
    expect(Object.isFrozen(adapter.tools)).toBe(true);
    expect(Object.isFrozen(adapter.tools[0])).toBe(true);
    expect(() =>
      (adapter.tools as Array<{ name: string }>).push({ name: "x" }),
    ).toThrow();
  });

  it("preserves a valid requestId and nests the exact cloned domain result", async () => {
    const { port } = createPort();
    const adapter = createBrowserAgentAdapter(port);

    await expect(
      adapter.execute(
        request("particle_studio.get_draft_summary", {}, "summary-7"),
      ),
    ).resolves.toEqual({
      schemaVersion: 1,
      requestId: "summary-7",
      result: { ok: true, summary: { revision: 3 } },
    });
  });

  it("maps every no-input allowlisted tool to its exact workspace method", async () => {
    const { port, calls } = createPort();
    const adapter = createBrowserAgentAdapter(port);

    await expect(
      adapter.execute(request("particle_studio.get_draft_summary", {})),
    ).resolves.toMatchObject({
      result: { ok: true, summary: { revision: 3 } },
    });
    await expect(
      adapter.execute(request("particle_studio.undo", {})),
    ).resolves.toMatchObject({
      result: { ok: false, error: { code: "NOTHING_TO_UNDO" } },
    });
    await expect(
      adapter.execute(request("particle_studio.redo", {})),
    ).resolves.toMatchObject({
      result: { ok: false, error: { code: "NOTHING_TO_REDO" } },
    });
    expect(calls).toEqual({
      getDraftSummary: 1,
      validateDraft: 0,
      dispatch: 0,
      undo: 1,
      redo: 1,
    });
  });

  it("forwards isolated validation input and rejected domain results", async () => {
    const { port, received } = createPort();
    const adapter = createBrowserAgentAdapter(port);
    const document = { frames: [{ time: 0.5 }] };

    await expect(
      adapter.execute(request("particle_studio.validate_draft", { document })),
    ).resolves.toEqual({
      schemaVersion: 1,
      requestId: "request-1",
      result: { ok: false, error: { code: "INVALID_DRAFT" } },
    });
    expect(received[0]).toEqual(document);
    expect(received[0]).not.toBe(document);
    document.frames[0]!.time = 1;
    expect(received[0]).toEqual({ frames: [{ time: 0.5 }] });
  });

  it("constructs an isolated browser-agent command without accepting capability", async () => {
    const { port, received } = createPort();
    const adapter = createBrowserAgentAdapter(port);
    const command = {
      commandSchemaVersion: 1,
      commandId: "command-1",
      documentId: "document-1",
      expectedRevision: 3,
      payload: { type: "set-keyframe-value", value: 0.25 },
    };

    await expect(
      adapter.execute(
        request("particle_studio.dispatch_draft_command", { command }),
      ),
    ).resolves.toMatchObject({ result: { ok: true, revision: 4 } });
    expect(received[0]).toEqual({
      ...command,
      actorCapability: "browser-agent",
    });
    expect(received[0]).not.toBe(command);
    expect(command).not.toHaveProperty("actorCapability");
  });

  it("rejects extra keys and caller capability before any port call", async () => {
    const { port, calls } = createPort();
    const adapter = createBrowserAgentAdapter(port);
    const command = {
      commandSchemaVersion: 1,
      commandId: "command-1",
      documentId: "document-1",
      expectedRevision: 0,
      payload: {},
      actorCapability: "human-ui",
    };

    for (const malformed of [
      { ...request("particle_studio.get_draft_summary", {}), extra: true },
      request("particle_studio.undo", { ignored: true }),
      request("particle_studio.dispatch_draft_command", { command }),
    ]) {
      await expect(adapter.execute(malformed)).resolves.toEqual({
        schemaVersion: 1,
        requestId: null,
        error: { code: "WEBMCP_MALFORMED_REQUEST" },
      });
    }
    expect(calls).toEqual({
      getDraftSummary: 0,
      validateDraft: 0,
      dispatch: 0,
      undo: 0,
      redo: 0,
    });
  });

  it("rejects unknown and prohibited tools without invoking the port", async () => {
    const { port, calls } = createPort();
    const adapter = createBrowserAgentAdapter(port);

    for (const tool of [
      "particle_studio.approve_draft",
      "particle_studio.export_final",
      "particle_studio.import_asset",
      "particle_studio.fetch",
      "particle_studio.eval",
    ]) {
      await expect(
        adapter.execute(request(tool as never, {})),
      ).resolves.toEqual({
        schemaVersion: 1,
        requestId: "request-1",
        error: { code: "WEBMCP_TOOL_NOT_FOUND" },
      });
    }
    expect(Object.values(calls).every((count) => count === 0)).toBe(true);
  });

  it("normalizes malformed, accessor, prototype, symbol, cyclic, and unsafe inputs", async () => {
    const { port, calls } = createPort();
    const adapter = createBrowserAgentAdapter(port);
    const accessor = request("particle_studio.get_draft_summary", {});
    Object.defineProperty(accessor, "input", {
      get: () => ({}),
      enumerable: true,
    });
    const cyclic = request("particle_studio.validate_draft", { document: {} });
    (cyclic.input as { document: { self?: unknown } }).document.self = cyclic;
    const symbol = request("particle_studio.get_draft_summary", {});
    Object.defineProperty(symbol, Symbol("hidden"), { value: true });

    for (const malformed of [
      [],
      Object.create({
        schemaVersion: 1,
        requestId: "x",
        tool: toolNames[0],
        input: {},
      }),
      accessor,
      symbol,
      cyclic,
      request("particle_studio.get_draft_summary", {}, ""),
      request("particle_studio.get_draft_summary", {
        value: Number.POSITIVE_INFINITY,
      }),
      request("particle_studio.get_draft_summary", {
        value: Number.MAX_SAFE_INTEGER + 1,
      }),
    ]) {
      await expect(adapter.execute(malformed)).resolves.toEqual({
        schemaVersion: 1,
        requestId: null,
        error: { code: "WEBMCP_MALFORMED_REQUEST" },
      });
    }
    expect(Object.values(calls).every((count) => count === 0)).toBe(true);
  });

  it("normalizes workspace throws, rejections, thenable traps, and hostile results", async () => {
    const failures = [
      () => {
        throw new Error("private detail");
      },
      () => Promise.reject(new Error("private detail")),
      () => ({
        get then() {
          throw new Error("private detail");
        },
      }),
      () => ({
        get result() {
          throw new Error("private detail");
        },
      }),
    ];

    for (const getDraftSummary of failures) {
      const adapter = createBrowserAgentAdapter({
        getDraftSummary,
        validateDraft: () => ({ ok: true }),
        dispatch: () => ({ ok: true }),
        undo: () => ({ ok: true }),
        redo: () => ({ ok: true }),
      });
      await expect(
        adapter.execute(request("particle_studio.get_draft_summary", {})),
      ).resolves.toEqual({
        schemaVersion: 1,
        requestId: "request-1",
        error: { code: "WEBMCP_WORKSPACE_UNAVAILABLE" },
      });
    }
  });

  it("isolates workspace results and keeps concurrent requests independent", async () => {
    const shared = { ok: true, value: { mutable: 1 } };
    const adapter = createBrowserAgentAdapter({
      getDraftSummary: async () => shared,
      validateDraft: () => ({ ok: true }),
      dispatch: () => ({ ok: true }),
      undo: () => ({ ok: true }),
      redo: () => ({ ok: true }),
    });

    const [first, second] = await Promise.all([
      adapter.execute(request("particle_studio.get_draft_summary", {}, "one")),
      adapter.execute(request("particle_studio.get_draft_summary", {}, "two")),
    ]);
    shared.value.mutable = 9;
    expect(first).toEqual({
      schemaVersion: 1,
      requestId: "one",
      result: { ok: true, value: { mutable: 1 } },
    });
    expect(second).toEqual({
      schemaVersion: 1,
      requestId: "two",
      result: { ok: true, value: { mutable: 1 } },
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen((first as { result: object }).result)).toBe(true);
  });

  it("rejects request transport values at every budget +1 boundary", async () => {
    const { port, calls } = createPort();
    const adapter = createBrowserAgentAdapter(port);
    const nestedContainers = (count: number) => {
      let value: unknown = null;
      for (let index = 0; index < count; index += 1) value = { value };
      return value;
    };
    const wideObject = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `property-${index}`,
          null,
        ]),
      );
    const tool = "particle_studio.validate_draft";
    const cumulativeStrings = (count: number) => {
      const strings: string[] = [];
      let remaining = count;
      while (remaining > 0) {
        const length = Math.min(remaining, TRANSPORT_BUDGET.maxStringCodeUnits);
        strings.push("s".repeat(length));
        remaining -= length;
      }
      return strings;
    };
    const transportUnits = (value: unknown): number => {
      if (typeof value === "string") return value.length;
      if (value === null || typeof value !== "object") return 0;
      return Object.getOwnPropertyNames(value).reduce((total, name) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        return (
          total +
          name.length +
          (descriptor !== undefined && "value" in descriptor
            ? transportUnits(descriptor.value)
            : 0)
        );
      }, 0);
    };
    const cumulativeStringsAtBoundary = (extra: number) => {
      const strings = cumulativeStrings(
        TRANSPORT_BUDGET.maxCumulativeStringCodeUnits,
      );
      const envelope = request(tool, { document: strings }, "r");
      const excess =
        transportUnits(envelope) -
        TRANSPORT_BUDGET.maxCumulativeStringCodeUnits;
      const lastIndex = strings.length - 1;
      strings[lastIndex] = strings[lastIndex]!.slice(0, -excess + extra);
      return strings;
    };
    const nodeDocument = (additionalNodes: number) => {
      const document: Record<string, unknown> = {};
      let remaining = additionalNodes;
      let index = 0;
      while (remaining > 0) {
        const length = Math.min(
          TRANSPORT_BUDGET.maxArrayLength,
          Math.max(0, remaining - 1),
        );
        document[`chunk-${index}`] = Array.from({ length }, () => null);
        remaining -= length + 1;
        index += 1;
      }
      return document;
    };

    expect(Object.isFrozen(TRANSPORT_BUDGET)).toBe(true);
    for (const [label, value] of [
      ["depth boundary", nestedContainers(TRANSPORT_BUDGET.maxDepth - 1)],
      [
        "array boundary",
        Array.from({ length: TRANSPORT_BUDGET.maxArrayLength }, () => null),
      ],
      ["object boundary", wideObject(TRANSPORT_BUDGET.maxOwnProperties)],
      ["string boundary", "s".repeat(TRANSPORT_BUDGET.maxStringCodeUnits)],
      ["cumulative string boundary", cumulativeStringsAtBoundary(0)],
      ["node boundary", nodeDocument(TRANSPORT_BUDGET.maxVisitedNodes - 6)],
    ] as const) {
      await expect(
        adapter.execute(
          request("particle_studio.validate_draft", { document: value }, "r"),
        ),
        label,
      ).resolves.toMatchObject({ result: expect.anything() });
    }

    for (const [label, value] of [
      ["depth +1", nestedContainers(TRANSPORT_BUDGET.maxDepth)],
      [
        "array +1",
        Array.from({ length: TRANSPORT_BUDGET.maxArrayLength + 1 }, () => null),
      ],
      ["object +1", wideObject(TRANSPORT_BUDGET.maxOwnProperties + 1)],
      ["string +1", "s".repeat(TRANSPORT_BUDGET.maxStringCodeUnits + 1)],
      ["cumulative string +1", cumulativeStringsAtBoundary(1)],
      ["node +1", nodeDocument(TRANSPORT_BUDGET.maxVisitedNodes - 5)],
    ] as const) {
      await expect(
        adapter.execute(
          request("particle_studio.validate_draft", { document: value }, "r"),
        ),
        label,
      ).resolves.toEqual({
        schemaVersion: 1,
        requestId: null,
        error: { code: "WEBMCP_MALFORMED_REQUEST" },
      });
    }
    expect(calls.validateDraft).toBe(6);
  });

  it("admits a realistic thousand-element document below the transport budget", async () => {
    const { port, calls, received } = createPort();
    const adapter = createBrowserAgentAdapter(port);
    const document = {
      schemaVersion: 1,
      elements: Array.from({ length: 1_000 }, (_, index) => ({
        id: `element-${index}`,
        type: "shape",
        opacity: 1,
      })),
    };

    await expect(
      adapter.execute(request("particle_studio.validate_draft", { document })),
    ).resolves.toMatchObject({ result: { ok: false } });
    expect(calls.validateDraft).toBe(1);
    expect(received[0]).toEqual(document);
  });

  it("normalizes over-budget workspace outputs and remains usable", async () => {
    let attempt = 0;
    const adapter = createBrowserAgentAdapter({
      getDraftSummary: () => {
        attempt += 1;
        if (attempt === 1) {
          return {
            entries: Array.from({
              length: TRANSPORT_BUDGET.maxArrayLength + 1,
            }),
          };
        }
        if (attempt === 2) {
          return {
            detail: "s".repeat(TRANSPORT_BUDGET.maxStringCodeUnits + 1),
          };
        }
        return { ok: true };
      },
      validateDraft: () => ({ ok: true }),
      dispatch: () => ({ ok: true }),
      undo: () => ({ ok: true }),
      redo: () => ({ ok: true }),
    });

    for (const requestId of ["array-output", "string-output"]) {
      await expect(
        adapter.execute(
          request("particle_studio.get_draft_summary", {}, requestId),
        ),
      ).resolves.toEqual({
        schemaVersion: 1,
        requestId,
        error: { code: "WEBMCP_WORKSPACE_UNAVAILABLE" },
      });
    }
    await expect(
      adapter.execute(
        request("particle_studio.get_draft_summary", {}, "recovered"),
      ),
    ).resolves.toEqual({
      schemaVersion: 1,
      requestId: "recovered",
      result: { ok: true },
    });
  });

  it("enforces all workspace-output resource dimensions and recovers", async () => {
    const nestedContainers = (count: number) => {
      let value: unknown = null;
      for (let index = 0; index < count; index += 1) value = { value };
      return value;
    };
    const wideObject = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `property-${index}`,
          null,
        ]),
      );
    const cumulativeStrings = (count: number) => {
      const strings: string[] = [];
      let remaining = count;
      while (remaining > 0) {
        const length = Math.min(remaining, TRANSPORT_BUDGET.maxStringCodeUnits);
        strings.push("s".repeat(length));
        remaining -= length;
      }
      return strings;
    };
    const transportUnits = (value: unknown): number => {
      if (typeof value === "string") return value.length;
      if (value === null || typeof value !== "object") return 0;
      return Object.getOwnPropertyNames(value).reduce((total, name) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        return (
          total +
          name.length +
          (descriptor !== undefined && "value" in descriptor
            ? transportUnits(descriptor.value)
            : 0)
        );
      }, 0);
    };
    const cumulativeOutputAtBoundary = (extra: number) => {
      const output = {
        data: cumulativeStrings(TRANSPORT_BUDGET.maxCumulativeStringCodeUnits),
      };
      const excess =
        transportUnits(output) - TRANSPORT_BUDGET.maxCumulativeStringCodeUnits;
      const lastIndex = output.data.length - 1;
      output.data[lastIndex] = output.data[lastIndex]!.slice(
        0,
        -excess + extra,
      );
      return output;
    };
    const nodeOutput = (additionalNodes: number) => {
      const output: Record<string, unknown> = {};
      let remaining = additionalNodes;
      let index = 0;
      while (remaining > 0) {
        const length = Math.min(
          TRANSPORT_BUDGET.maxArrayLength,
          Math.max(0, remaining - 1),
        );
        output[`chunk-${index}`] = Array.from({ length }, () => null);
        remaining -= length + 1;
        index += 1;
      }
      return output;
    };
    const outputs = [
      { data: nestedContainers(TRANSPORT_BUDGET.maxDepth) },
      {
        data: Array.from(
          { length: TRANSPORT_BUDGET.maxArrayLength },
          () => null,
        ),
      },
      { data: wideObject(TRANSPORT_BUDGET.maxOwnProperties) },
      { data: "s".repeat(TRANSPORT_BUDGET.maxStringCodeUnits) },
      cumulativeOutputAtBoundary(0),
      nodeOutput(TRANSPORT_BUDGET.maxVisitedNodes - 1),
      { data: nestedContainers(TRANSPORT_BUDGET.maxDepth + 1) },
      {
        data: Array.from(
          { length: TRANSPORT_BUDGET.maxArrayLength + 1 },
          () => null,
        ),
      },
      { data: wideObject(TRANSPORT_BUDGET.maxOwnProperties + 1) },
      { data: "s".repeat(TRANSPORT_BUDGET.maxStringCodeUnits + 1) },
      cumulativeOutputAtBoundary(1),
      nodeOutput(TRANSPORT_BUDGET.maxVisitedNodes),
      { ok: true },
    ];
    const adapter = createBrowserAgentAdapter({
      getDraftSummary: () => outputs.shift(),
      validateDraft: () => ({ ok: true }),
      dispatch: () => ({ ok: true }),
      undo: () => ({ ok: true }),
      redo: () => ({ ok: true }),
    });

    for (const requestId of [
      "depth-boundary",
      "array-boundary",
      "object-boundary",
      "string-boundary",
      "cumulative-boundary",
      "node-boundary",
    ]) {
      await expect(
        adapter.execute(
          request("particle_studio.get_draft_summary", {}, requestId),
        ),
      ).resolves.toMatchObject({ requestId, result: expect.anything() });
    }
    for (const requestId of [
      "depth-plus-one",
      "array-plus-one",
      "object-plus-one",
      "string-plus-one",
      "cumulative-plus-one",
      "node-plus-one",
    ]) {
      await expect(
        adapter.execute(
          request("particle_studio.get_draft_summary", {}, requestId),
        ),
      ).resolves.toEqual({
        schemaVersion: 1,
        requestId,
        error: { code: "WEBMCP_WORKSPACE_UNAVAILABLE" },
      });
    }
    await expect(
      adapter.execute(
        request("particle_studio.get_draft_summary", {}, "recovered"),
      ),
    ).resolves.toEqual({
      schemaVersion: 1,
      requestId: "recovered",
      result: { ok: true },
    });
  });

  it("charges own property names against per-string and cumulative budgets", async () => {
    const { port, calls } = createPort();
    const adapter = createBrowserAgentAdapter(port);
    const tool = "particle_studio.validate_draft";
    const units = (value: unknown): number => {
      if (typeof value === "string") return value.length;
      if (value === null || typeof value !== "object") return 0;
      return Object.getOwnPropertyNames(value).reduce((total, name) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        return (
          total +
          name.length +
          (descriptor !== undefined && "value" in descriptor
            ? units(descriptor.value)
            : 0)
        );
      }, 0);
    };
    const keyDocument = (total: number) => {
      const document: Record<string, null> = {};
      let remaining = total;
      let index = 0;
      while (remaining > 0) {
        const suffix = String(index);
        const length = Math.min(
          TRANSPORT_BUDGET.maxStringCodeUnits,
          Math.max(suffix.length, remaining),
        );
        document[`${"k".repeat(length - suffix.length)}${suffix}`] = null;
        remaining -= length;
        index += 1;
      }
      return document;
    };
    const staticUnits = units(request(tool, { document: {} }, "r"));

    for (const document of [
      { ["k".repeat(TRANSPORT_BUDGET.maxStringCodeUnits)]: null },
      keyDocument(TRANSPORT_BUDGET.maxCumulativeStringCodeUnits - staticUnits),
    ]) {
      await expect(
        adapter.execute(request(tool, { document }, "r")),
      ).resolves.toMatchObject({ result: { ok: false } });
    }
    for (const document of [
      { ["k".repeat(TRANSPORT_BUDGET.maxStringCodeUnits + 1)]: null },
      keyDocument(
        TRANSPORT_BUDGET.maxCumulativeStringCodeUnits - staticUnits + 1,
      ),
    ]) {
      await expect(
        adapter.execute(request(tool, { document }, "r")),
      ).resolves.toEqual({
        schemaVersion: 1,
        requestId: null,
        error: { code: "WEBMCP_MALFORMED_REQUEST" },
      });
    }
    expect(calls.validateDraft).toBe(2);
  });

  it("rejects original proxy, getter, and non-enumerable envelopes before authority", async () => {
    const { port, calls } = createPort();
    const adapter = createBrowserAgentAdapter(port);
    const command = {
      commandSchemaVersion: 1,
      commandId: "command-1",
      documentId: "document-1",
      expectedRevision: 0,
      payload: {},
    };
    let getterCalls = 0;
    const getterEnvelope = request("particle_studio.get_draft_summary", {});
    Object.defineProperty(getterEnvelope, "input", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return {};
      },
    });
    const nonEnumerableExtra = request("particle_studio.get_draft_summary", {});
    Object.defineProperty(nonEnumerableExtra, "ignored", { value: true });
    const nestedNonEnumerable = request("particle_studio.validate_draft", {
      document: {},
    });
    Object.defineProperty(
      (nestedNonEnumerable.input as { document: Record<string, unknown> })
        .document,
      "hidden",
      { value: true },
    );
    const nonEnumerableRequiredDocument = request(
      "particle_studio.validate_draft",
      { document: {} },
    );
    Object.defineProperty(nonEnumerableRequiredDocument.input, "document", {
      enumerable: false,
      value: {},
    });
    const nonEnumerableRequiredPayload = request(
      "particle_studio.dispatch_draft_command",
      { command: { ...command } },
    );
    Object.defineProperty(
      (
        nonEnumerableRequiredPayload.input as {
          command: Record<string, unknown>;
        }
      ).command,
      "payload",
      { enumerable: false, value: {} },
    );
    const inputProxy = request("particle_studio.validate_draft", {
      document: {},
    });
    inputProxy.input = new Proxy(inputProxy.input, {});
    const revoked = Proxy.revocable(
      request("particle_studio.get_draft_summary", {}),
      {},
    );
    revoked.revoke();
    const throwing = new Proxy(
      request("particle_studio.get_draft_summary", {}),
      {
        ownKeys: () => {
          throw new Error("private");
        },
      },
    );

    for (const malformed of [
      new Proxy(request("particle_studio.get_draft_summary", {}), {}),
      inputProxy,
      getterEnvelope,
      nonEnumerableExtra,
      nestedNonEnumerable,
      nonEnumerableRequiredDocument,
      nonEnumerableRequiredPayload,
      revoked.proxy,
      throwing,
      request("particle_studio.validate_draft", {
        document: new Proxy({}, {}),
      }),
      request("particle_studio.dispatch_draft_command", {
        command: new Proxy(command, {}),
      }),
      request("particle_studio.dispatch_draft_command", {
        command: { ...command, payload: new Proxy({}, {}) },
      }),
    ]) {
      await expect(adapter.execute(malformed)).resolves.toEqual({
        schemaVersion: 1,
        requestId: null,
        error: { code: "WEBMCP_MALFORMED_REQUEST" },
      });
    }
    expect(getterCalls).toBe(0);
    expect(Object.values(calls).every((count) => count === 0)).toBe(true);
  });

  it("normalizes proxy and non-enumerable workspace outputs and recovers", async () => {
    let attempt = 0;
    const adapter = createBrowserAgentAdapter({
      getDraftSummary: () => {
        attempt += 1;
        if (attempt === 1) return new Proxy({ ok: true }, {});
        if (attempt === 2) {
          const result = { ok: true };
          Object.defineProperty(result, "hidden", { value: true });
          return result;
        }
        return { ok: true };
      },
      validateDraft: () => ({ ok: true }),
      dispatch: () => ({ ok: true }),
      undo: () => ({ ok: true }),
      redo: () => ({ ok: true }),
    });

    for (const requestId of ["proxy-output", "non-enumerable-output"]) {
      await expect(
        adapter.execute(
          request("particle_studio.get_draft_summary", {}, requestId),
        ),
      ).resolves.toEqual({
        schemaVersion: 1,
        requestId,
        error: { code: "WEBMCP_WORKSPACE_UNAVAILABLE" },
      });
    }
    await expect(
      adapter.execute(
        request("particle_studio.get_draft_summary", {}, "recovered"),
      ),
    ).resolves.toEqual({
      schemaVersion: 1,
      requestId: "recovered",
      result: { ok: true },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects callable resolving and stalling thenables without invoking then", async () => {
    vi.useFakeTimers();
    let resolvingThenCalls = 0;
    let stallingThenCalls = 0;
    const outputs = [
      Object.assign(() => undefined, {
        then(resolve: (value: unknown) => void) {
          resolvingThenCalls += 1;
          resolve({ ok: true });
        },
      }),
      {
        then() {
          stallingThenCalls += 1;
        },
      },
    ];
    const adapter = createBrowserAgentAdapter({
      getDraftSummary: () => outputs.shift(),
      validateDraft: () => ({ ok: true }),
      dispatch: () => ({ ok: true }),
      undo: () => ({ ok: true }),
      redo: () => ({ ok: true }),
    });

    for (const requestId of ["callable", "stalling"]) {
      let response: unknown;
      void adapter
        .execute(request("particle_studio.get_draft_summary", {}, requestId))
        .then((value) => {
          response = value;
        });
      await vi.advanceTimersByTimeAsync(0);
      expect(response).toEqual({
        schemaVersion: 1,
        requestId,
        error: { code: "WEBMCP_WORKSPACE_UNAVAILABLE" },
      });
    }
    expect(resolvingThenCalls).toBe(0);
    expect(stallingThenCalls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects proxied and foreign thenables without calling their then methods", async () => {
    vi.useFakeTimers();
    let proxiedThenCalls = 0;
    let foreignThenCalls = 0;
    const proxied = new Proxy(
      {
        then() {
          proxiedThenCalls += 1;
        },
      },
      {},
    );
    const proxiedNativeTarget = Promise.resolve({ ok: true });
    Object.defineProperty(proxiedNativeTarget, "then", {
      value() {
        proxiedThenCalls += 1;
        throw new Error("must not be invoked through proxy");
      },
    });
    const proxiedNative = new Proxy(proxiedNativeTarget, {});
    const foreign = runInNewContext(
      "Promise.resolve({ ok: true })",
    ) as Promise<unknown>;
    const foreignThen = foreign.then;
    Object.defineProperty(foreign, "then", {
      value(onFulfilled: (value: unknown) => unknown, onRejected: unknown) {
        foreignThenCalls += 1;
        return foreignThen.call(this, onFulfilled, onRejected);
      },
    });
    const outputs = [proxied, proxiedNative, foreign];
    const adapter = createBrowserAgentAdapter({
      getDraftSummary: () => outputs.shift(),
      validateDraft: () => ({ ok: true }),
      dispatch: () => ({ ok: true }),
      undo: () => ({ ok: true }),
      redo: () => ({ ok: true }),
    });

    for (const requestId of ["proxied", "proxied-native", "foreign"]) {
      let response: unknown;
      void adapter
        .execute(request("particle_studio.get_draft_summary", {}, requestId))
        .then((value) => {
          response = value;
        });
      await vi.advanceTimersByTimeAsync(0);
      expect(response).toEqual({
        schemaVersion: 1,
        requestId,
        error: { code: "WEBMCP_WORKSPACE_UNAVAILABLE" },
      });
    }
    expect(proxiedThenCalls).toBe(0);
    expect(foreignThenCalls).toBe(0);
  });

  it("uses intrinsic Promise.then for native promises and clears its timer", async () => {
    vi.useFakeTimers();
    let overriddenThenCalls = 0;
    const native = Promise.resolve({ ok: true });
    Object.defineProperty(native, "then", {
      value() {
        overriddenThenCalls += 1;
        throw new Error("must not use overridden then");
      },
    });
    const adapter = createBrowserAgentAdapter({
      getDraftSummary: () => native,
      validateDraft: () => ({ ok: true }),
      dispatch: () => ({ ok: true }),
      undo: () => ({ ok: true }),
      redo: () => ({ ok: true }),
    });

    await expect(
      adapter.execute(request("particle_studio.get_draft_summary", {})),
    ).resolves.toMatchObject({ result: { ok: true } });
    expect(overriddenThenCalls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    const rejectingAdapter = createBrowserAgentAdapter({
      getDraftSummary: () => Promise.reject(new Error("private detail")),
      validateDraft: () => ({ ok: true }),
      dispatch: () => ({ ok: true }),
      undo: () => ({ ok: true }),
      redo: () => ({ ok: true }),
    });
    await expect(
      rejectingAdapter.execute(
        request("particle_studio.get_draft_summary", {}),
      ),
    ).resolves.toMatchObject({
      error: { code: "WEBMCP_WORKSPACE_UNAVAILABLE" },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds native promises stalled by thenable assimilation", async () => {
    vi.useFakeTimers();
    let thenCalls = 0;
    const stalled = new Promise<unknown>((resolve) => {
      resolve({
        then() {
          thenCalls += 1;
        },
      });
    });
    const adapter = createBrowserAgentAdapter({
      getDraftSummary: () => stalled,
      validateDraft: () => ({ ok: true }),
      dispatch: () => ({ ok: true }),
      undo: () => ({ ok: true }),
      redo: () => ({ ok: true }),
    });

    const result = adapter.execute(
      request("particle_studio.get_draft_summary", {}, "assimilated"),
    );
    await vi.advanceTimersByTimeAsync(WORKSPACE_PROMISE_TIMEOUT_MS);
    await expect(result).resolves.toEqual({
      schemaVersion: 1,
      requestId: "assimilated",
      error: { code: "WEBMCP_WORKSPACE_UNAVAILABLE" },
    });
    expect(thenCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds native promises, ignores late settlement, and recovers", async () => {
    vi.useFakeTimers();
    let settle!: (value: unknown) => void;
    const neverSettling = new Promise<unknown>((resolve) => {
      settle = resolve;
    });
    const outputs = [neverSettling, { ok: true }];
    const adapter = createBrowserAgentAdapter({
      getDraftSummary: () => outputs.shift(),
      validateDraft: () => ({ ok: true }),
      dispatch: () => ({ ok: true }),
      undo: () => ({ ok: true }),
      redo: () => ({ ok: true }),
    });

    const timedOut = adapter.execute(
      request("particle_studio.get_draft_summary", {}, "timeout"),
    );
    await vi.advanceTimersByTimeAsync(WORKSPACE_PROMISE_TIMEOUT_MS);
    await expect(timedOut).resolves.toEqual({
      schemaVersion: 1,
      requestId: "timeout",
      error: { code: "WEBMCP_WORKSPACE_UNAVAILABLE" },
    });
    expect(vi.getTimerCount()).toBe(0);

    settle({ ok: false });
    await vi.advanceTimersByTimeAsync(0);
    await expect(
      adapter.execute(
        request("particle_studio.get_draft_summary", {}, "recovered"),
      ),
    ).resolves.toEqual({
      schemaVersion: 1,
      requestId: "recovered",
      result: { ok: true },
    });
  });
});
