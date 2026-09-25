# Standalone browser-agent adapter

`createBrowserAgentAdapter(workspacePort)` exposes a five-tool, in-process request dispatcher over a caller-supplied `BrowserAgentWorkspacePort`. It does **not** register browser/WebMCP tools, connect to the editor or headless server, provide a sandbox, or prove end-to-end security. The host owns the workspace implementation and any registration, authentication, and authorization around this seam.

## Tool contract

The returned adapter has a frozen ordered `tools` allowlist and `execute(request: unknown): Promise<BrowserAgentResponse>`. Its workspace port supplies `getDraftSummary()`, `validateDraft(document)`, `dispatch(command)`, `undo()`, and `redo()`; each may return a value or a Promise. Only these mappings are available:

| Tool name | Exact `input` | Workspace call |
| --- | --- | --- |
| `particle_studio.get_draft_summary` | `{}` | `getDraftSummary()` |
| `particle_studio.validate_draft` | `{ "document": <JSON-like value> }` | `validateDraft(document)` |
| `particle_studio.dispatch_draft_command` | `{ "command": { "commandSchemaVersion": 1, "commandId": <nonempty string>, "documentId": <nonempty string>, "expectedRevision": <nonnegative safe integer>, "payload": <JSON-like value> } }` | `dispatch(command)` |
| `particle_studio.undo` | `{}` | `undo()` |
| `particle_studio.redo` | `{}` | `redo()` |

Requests have **exactly** `{ "schemaVersion": 1, "requestId": <nonempty string>, "tool": <string>, "input": <object> }` (the input shape depends on the tool). The command input cannot supply `actorCapability`; the adapter adds `actorCapability: "browser-agent"` to the isolated command passed to `dispatch`. The workspace remains responsible for enforcing domain rules; the adapter does not interpret domain success or failure.

Success returns `{ schemaVersion: 1, requestId, result }`, where `result` is the workspace's JSON-like domain value (including `{ ok: false, error: ... }` domain failures), cloned and deeply frozen. Adapter errors contain `{ schemaVersion: 1, requestId, error: { code } }`, with no raw exception details:

- `WEBMCP_MALFORMED_REQUEST`: invalid envelope, input, or request transport; `requestId: null`.
- `WEBMCP_TOOL_NOT_FOUND`: well-formed envelope naming a tool outside the allowlist; original `requestId`.
- `WEBMCP_WORKSPACE_UNAVAILABLE`: workspace throw/rejection, unsupported async value, timeout, or invalid result transport; original `requestId`.

## Transport boundary and limits

Before a port call, the adapter validates the original request, clones the whole envelope with `structuredClone`, and validates the copy again. Workspace outputs are similarly validated and cloned before freezing. Accepted transport values are null, booleans, strings, finite numbers (safe integers where integral), dense arrays, and same-realm plain objects with enumerable own data properties; accessors, symbols, cycles, extra envelope/command fields, and non-enumerable properties are rejected. Shared non-cyclic references are permitted by traversal, but cloning removes caller-owned references from forwarded inputs and returned results. Cross-realm objects and arrays are not accepted as plain transport values.

`TRANSPORT_BUDGET` applies independently to request and result validation (including property names and array index names): maximum depth **64**, visited nodes **50,000**, array length **4,096**, own object properties **256**, per-string length **16,384 UTF-16 code units**, and cumulative string length **1,000,000 UTF-16 code units**. Invalid or over-budget requests become `WEBMCP_MALFORMED_REQUEST`; invalid or over-budget outputs become `WEBMCP_WORKSPACE_UNAVAILABLE`.

For asynchronous workspace results, only same-realm native Promise instances are awaited using the intrinsic `Promise.prototype.then`; foreign Promises, arbitrary thenables, and proxied Promises are not supported. A pending accepted Promise is bounded by `WORKSPACE_PROMISE_TIMEOUT_MS` (**15,000 ms**); a late settlement does not change the response. This deadline does not cancel workspace work or bound synchronous port execution, transport inspection/cloning, or hostile Proxy traps; it is not a general execution sandbox.

## Verify from a clean checkout

With the repository's pinned Node/npm toolchain (CI uses Node `24.20.x` and npm `12.0.2`), run from the repository root:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run validator:prepare
npx vitest run --project core packages/webmcp-adapter/tests
npx tsc -p packages/webmcp-adapter/tsconfig.json --noEmit --pretty false
```

The validator preparation is retained in CI; the adapter's focused test and typecheck commands are independent package checks, not a browser registration or editor/headless integration test.
