import { expect, test } from "@playwright/test";

const fixtureUrl = "http://127.0.0.1:4274";
const toolNames = [
  "particle_studio.get_draft_summary",
  "particle_studio.validate_draft",
  "particle_studio.dispatch_draft_command",
  "particle_studio.undo",
  "particle_studio.redo",
];
const forbiddenAuthorityNames = new Set([
  "workspace",
  "repository",
  "service",
  "approval",
  "export",
  "assets",
  "release",
  "revisionId",
]);

function expectNoAuthority(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) expectNoAuthority(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    expect(forbiddenAuthorityNames.has(key)).toBe(false);
    expectNoAuthority(item);
  }
}

test("executes the isolated browser-agent fixture with real adapter and editor-port bytes", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto(fixtureUrl);
  await page.getByRole("button", { name: "Run browser agent proof" }).click();
  const result = JSON.parse(
    await page.getByTestId("browser-agent-fixture-result").textContent(),
  ) as {
    readonly tools: readonly string[];
    readonly operations: {
      readonly dispatch: {
        readonly direct: unknown;
        readonly adapter: unknown;
      };
      readonly undo: { readonly direct: unknown; readonly adapter: unknown };
      readonly redo: { readonly direct: unknown; readonly adapter: unknown };
      readonly snapshots: {
        readonly initial: {
          readonly direct: unknown;
          readonly adapter: unknown;
        };
        readonly dispatch: {
          readonly direct: unknown;
          readonly adapter: unknown;
        };
        readonly undo: { readonly direct: unknown; readonly adapter: unknown };
        readonly redo: { readonly direct: unknown; readonly adapter: unknown };
      };
    };
    readonly summary: {
      readonly result: unknown;
      readonly expected: unknown;
      readonly keys: readonly string[];
    };
    readonly validation: {
      readonly result: unknown;
      readonly expected: unknown;
      readonly snapshotBefore: unknown;
      readonly snapshotAfter: unknown;
    };
    readonly denied: { readonly response: unknown; readonly portCalls: number };
    readonly responses: readonly unknown[];
    readonly browserRuntime: {
      readonly structuredClone: boolean;
      readonly promiseSettlement: boolean;
    };
  };

  expect(result.tools).toEqual(toolNames);
  expect(result.operations.dispatch.adapter).toEqual(
    result.operations.dispatch.direct,
  );
  expect(result.operations.undo.adapter).toEqual(result.operations.undo.direct);
  expect(result.operations.redo.adapter).toEqual(result.operations.redo.direct);
  expect(result.operations.snapshots.initial.adapter).toEqual(
    result.operations.snapshots.initial.direct,
  );
  expect(result.operations.snapshots.dispatch.adapter).toEqual(
    result.operations.snapshots.dispatch.direct,
  );
  expect(result.operations.snapshots.undo.adapter).toEqual(
    result.operations.snapshots.undo.direct,
  );
  expect(result.operations.snapshots.redo.adapter).toEqual(
    result.operations.snapshots.redo.direct,
  );
  expect(result.summary.keys).toEqual([
    "documentId",
    "revision",
    "schemaVersion",
    "durationUs",
    "playbackRange",
    "loop",
    "elementCount",
    "trackCount",
  ]);
  expect(result.summary.result).toEqual(result.summary.expected);
  expect(result.validation.result).toEqual(result.validation.expected);
  expect(result.validation.snapshotAfter).toEqual(
    result.validation.snapshotBefore,
  );
  expect(result.denied).toEqual({
    response: {
      schemaVersion: 1,
      requestId: "denied",
      error: { code: "WEBMCP_TOOL_NOT_FOUND" },
    },
    portCalls: 0,
  });
  for (const response of result.responses) expectNoAuthority(response);
  expect(result.browserRuntime).toEqual({
    structuredClone: true,
    promiseSettlement: true,
  });
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("keeps the production editor free of browser-agent host and fixture authority", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => requests.push(request.url()));

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Editor foundation" }),
  ).toBeVisible();

  const declaredEntryResourceHashes = async () =>
    page.evaluate(async () => {
      const urls = [
        ...document.querySelectorAll<HTMLScriptElement>("script[src]"),
        ...document.querySelectorAll<HTMLLinkElement>(
          'link[rel~="stylesheet"][href]',
        ),
      ].map((element) =>
        element instanceof HTMLScriptElement ? element.src : element.href,
      );

      return Promise.all(
        [...new Set(urls)].sort().map(async (url) => {
          const response = await fetch(url, { cache: "no-store" });
          if (!response.ok) throw new Error(`Failed to fetch ${url}`);
          const bytes = await response.arrayBuffer();
          const digest = new Uint8Array(
            await crypto.subtle.digest("SHA-256", bytes),
          );
          return {
            url,
            sha256: Array.from(digest, (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join(""),
            byteLength: bytes.byteLength,
          };
        }),
      );
    });

  const hashesBeforeAuthorityAssertions = await declaredEntryResourceHashes();
  expect(hashesBeforeAuthorityAssertions).not.toHaveLength(0);
  expect(
    hashesBeforeAuthorityAssertions.every(({ byteLength }) => byteLength > 0),
  ).toBe(true);

  await expect(page.getByTestId("browser-agent-fixture-result")).toHaveCount(0);

  const hostAuthority = await page.evaluate(() => {
    const names = [
      ...Object.getOwnPropertyNames(window),
      ...Object.getOwnPropertyNames(globalThis),
      ...Object.getOwnPropertyNames(navigator),
    ];
    return names.filter((name) => /webmcp|browser.?agent/i.test(name));
  });
  expect(hostAuthority).toEqual([]);
  expect(requests.some((url) => new URL(url).port === "4274")).toBe(false);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);

  const hashesAfterAuthorityAssertions = await declaredEntryResourceHashes();
  expect(hashesAfterAuthorityAssertions).toEqual(
    hashesBeforeAuthorityAssertions,
  );
});
