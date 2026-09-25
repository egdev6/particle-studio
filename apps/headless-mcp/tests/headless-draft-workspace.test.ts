import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SceneDocumentV1 } from "@particle-studio/scene-document";
import type { HeadlessDraftWorkspace } from "../src/headless-draft-workspace.js";

// The scene-document validation chain loads the generated validator. Prepare
// it before any dynamic import and again before each test block so focused
// runs stay repeatable after a full core run removes the generated module.
const repositoryRoot = new URL("../../../", import.meta.url);
const prepareValidator = () => {
  execFileSync("npm", ["run", "validator:prepare"], {
    cwd: repositoryRoot,
    stdio: "pipe",
  });
};

prepareValidator();

const { FIRST_SLICE_DOCUMENT, validateSceneDocument } = await import(
  "@particle-studio/scene-document"
);
const persistence = await import("@particle-studio/persistence");
const rootConfinementModule = await import("@particle-studio/persistence-fs");
const revisionPersistence = await import(
  "@particle-studio/persistence-fs/revision-persistence"
);
const assetPersistence = await import(
  "@particle-studio/persistence-fs/asset-persistence"
);
const commandsModule = await import("@particle-studio/commands");
const workspaceModule = await import("../src/headless-draft-workspace.js");
const indexModule = await import("../src/index.js");
const testSeam = await import("../src/headless-draft-workspace-test.js");

beforeAll(() => {
  prepareValidator();
});

const {
  createCompleteRevision,
  createDraftRevisionPointer,
  createRevisionPointersSnapshot,
  createSavedRevisionPointer,
} = persistence;
const { createRootConfinement } = rootConfinementModule;
const { createFileSystemPersistenceAdapter } = revisionPersistence;
const { createFileSystemAssetPersistenceAdapter } = assetPersistence;
const { createCommandSession } = commandsModule;
const { createHeadlessDraftWorkspace, HeadlessWorkspaceError } = workspaceModule;
const { configureHeadlessWorkspaceTestOperations } = testSeam;

const DOCUMENT_ID = "document-1";
const SEED_RELATIVE_PATH = "seed.json";
const ASSET_BYTES = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 4, 5,
]);

type Roots = {
  readonly parent: string;
  readonly workspaceRoot: string;
  readonly documentsRoot: string;
  readonly outputsRoot: string;
};

const temporaryParents: string[] = [];

afterEach(async () => {
  configureHeadlessWorkspaceTestOperations(undefined);
  const parents = temporaryParents.splice(0, temporaryParents.length);
  await Promise.all(
    parents.map((parent) => rm(parent, { recursive: true, force: true })),
  );
});

async function createRoots(): Promise<Roots> {
  const parent = await mkdtemp(join(tmpdir(), "headless-mcp-"));
  temporaryParents.push(parent);
  const workspaceRoot = join(parent, "workspace");
  const documentsRoot = join(parent, "documents");
  const outputsRoot = join(parent, "outputs");
  await Promise.all([
    mkdir(workspaceRoot),
    mkdir(documentsRoot),
    mkdir(outputsRoot),
  ]);
  return { parent, workspaceRoot, documentsRoot, outputsRoot };
}

const workspaceOptions = (
  roots: Roots,
  overrides: Record<string, unknown> = {},
) => ({
  documentId: DOCUMENT_ID,
  workspaceRoot: roots.workspaceRoot,
  documentsRoot: roots.documentsRoot,
  outputsRoot: roots.outputsRoot,
  seedPath: SEED_RELATIVE_PATH,
  ...overrides,
});

async function writeSeed(
  roots: Roots,
  document: unknown,
  relativePath: string = SEED_RELATIVE_PATH,
): Promise<void> {
  await writeFile(join(roots.documentsRoot, relativePath), JSON.stringify(document));
}

async function testConfinement(roots: Roots) {
  return createRootConfinement({
    workspace: roots.workspaceRoot,
    documents: roots.documentsRoot,
    outputs: roots.outputsRoot,
  });
}

const pngAsset = async (roots: Roots): Promise<{ sha256: string; byteLength: number }> => {
  const assets = createFileSystemAssetPersistenceAdapter({
    authority: await testConfinement(roots),
  });
  const asset = await assets.writeAsset({
    mimeType: "image/png",
    bytes: ASSET_BYTES,
  });
  return { sha256: asset.sha256, byteLength: asset.byteLength };
};

const imageDocumentWith = (
  asset: { sha256: string; byteLength: number },
  declared: { byteLength?: number; mimeType?: string } = {},
) => ({
  schemaVersion: 1,
  durationUs: 2_000_000,
  playbackRange: { startUs: 0, endUs: 2_000_000 },
  loop: false,
  seed: 7,
  rootIds: ["image-1"],
  elements: [
    {
      id: "image-1",
      type: "image",
      asset: {
        sha256: asset.sha256,
        mimeType: declared.mimeType ?? "image/png",
        byteLength: declared.byteLength ?? asset.byteLength,
        intrinsicWidth: 4,
        intrinsicHeight: 4,
      },
      x: 0,
      y: 0,
      width: 32,
      height: 32,
      opacity: 1,
    },
  ],
  tracks: [],
});

const setKeyframePayload = (value: number) => ({
  type: "set-keyframe-value",
  trackId: "shape-1:opacity",
  keyframeId: "shape-1:opacity:0",
  value,
});

const envelopeCommand = (
  overrides: Record<string, unknown> = {},
  payload: unknown = setKeyframePayload(0.5),
) => ({
  commandSchemaVersion: 1,
  commandId: "command-1",
  documentId: DOCUMENT_ID,
  expectedRevision: 0,
  payload,
  ...overrides,
});

const expectStartupFailure = async (
  options: Record<string, unknown>,
  code: string,
): Promise<void> => {
  let caught: unknown;
  try {
    await createHeadlessDraftWorkspace(
      options as Parameters<typeof createHeadlessDraftWorkspace>[0],
    );
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HeadlessWorkspaceError);
  expect(
    (caught as InstanceType<typeof HeadlessWorkspaceError>).code,
  ).toBe(code);
};

async function layout(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(join(current, entry.name), relative);
      } else {
        files.push(relative);
      }
    }
  };
  await walk(root, "");
  return files.sort();
}

async function findSingleFile(
  root: string,
  matches: (relative: string) => boolean,
): Promise<string> {
  const found = (await layout(root)).filter(matches);
  expect(found).toHaveLength(1);
  return join(root, found[0]!);
}

const pointerSnapshotPath = (outputsRoot: string): Promise<string> =>
  findSingleFile(
    outputsRoot,
    (relative) => relative.includes("/pointers/") && relative.endsWith("/pointers.json"),
  );

const onlyRevisionRecordPath = (outputsRoot: string): Promise<string> =>
  findSingleFile(outputsRoot, (relative) => relative.includes("/revisions/"));

const onlyAssetRecordPath = (workspaceRoot: string): Promise<string> =>
  findSingleFile(workspaceRoot, (relative) => relative.includes("/assets/"));

async function treeFingerprint(root: string): Promise<string> {
  const parts: string[] = [];
  for (const relative of await layout(root)) {
    const bytes = await readFile(join(root, relative));
    parts.push(`${relative}:${createHash("sha256").update(bytes).digest("hex")}`);
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

async function garbleFile(path: string): Promise<void> {
  const bytes = await readFile(path);
  const corrupted = Buffer.from(bytes);
  expect(corrupted.byteLength).toBeGreaterThan(0);
  corrupted[0] = corrupted[0]! ^ 0xff;
  await writeFile(path, corrupted);
}

async function persistDraft(
  roots: Roots,
  document: unknown,
  {
    revisionId = "revision-1",
    sequence = 1,
    saved = null,
  }: {
    revisionId?: string;
    sequence?: number;
    saved?: { documentId: string; revisionId: string; sequence: number } | null;
  } = {},
): Promise<void> {
  const adapter = createFileSystemPersistenceAdapter({
    authority: await testConfinement(roots),
  });
  const draft = createCompleteRevision({
    documentId: DOCUMENT_ID,
    revisionId,
    sequence,
    document,
  });
  await adapter.writeCompleteRevision(
    draft,
    createRevisionPointersSnapshot({
      saved: saved as never,
      draft: createDraftRevisionPointer(draft),
    }),
  );
}

describe("headless draft workspace surface", () => {
  it("exposes exactly the five result-only operations plus the document id", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const workspace = await createHeadlessDraftWorkspace(workspaceOptions(roots));

    expect(Object.isFrozen(workspace)).toBe(true);
    expect(Object.keys(workspace).sort()).toEqual([
      "dispatch",
      "documentId",
      "getDraftSummary",
      "redo",
      "undo",
      "validateDraft",
    ]);
    for (const operation of [
      workspace.getDraftSummary,
      workspace.validateDraft,
      workspace.dispatch,
      workspace.undo,
      workspace.redo,
    ]) {
      expect(typeof operation).toBe("function");
    }
    expect(workspace.documentId).toBe(DOCUMENT_ID);
  });

  it("exposes only the public factory and error type from the package entry", () => {
    expect(Object.keys(indexModule).sort()).toEqual([
      "HeadlessWorkspaceError",
      "createHeadlessDraftWorkspace",
    ]);
    expect("configureHeadlessWorkspaceTestOperations" in indexModule).toBe(false);
    expect("setHeadlessWorkspaceTestConfiguration" in indexModule).toBe(false);
  });

  it("starts from the seed document with revision zero and the port summary shape", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const workspace = await createHeadlessDraftWorkspace(workspaceOptions(roots));

    const summaryResult = await workspace.getDraftSummary();
    expect(Object.keys(summaryResult).sort()).toEqual(["ok", "summary"]);
    if (!summaryResult.ok) throw new Error("summary must succeed");
    expect(Object.keys(summaryResult.summary).sort()).toEqual([
      "documentId",
      "durationUs",
      "elementCount",
      "loop",
      "playbackRange",
      "revision",
      "schemaVersion",
      "trackCount",
    ]);
    expect(summaryResult.summary).toEqual({
      documentId: DOCUMENT_ID,
      revision: 0,
      schemaVersion: 1,
      durationUs: 1_000_000,
      playbackRange: { startUs: 0, endUs: 1_000_000 },
      loop: true,
      elementCount: 1,
      trackCount: 1,
    });
  });

  it("denies overlapping, non-absolute, and missing confinement roots", async () => {
    const nested = await createRoots();
    const nestedOutputs = join(nested.workspaceRoot, "nested-outputs");
    await mkdir(nestedOutputs);
    await expectStartupFailure(
      workspaceOptions(nested, { outputsRoot: nestedOutputs }),
      "HEADLESS_WORKSPACE_CONFINEMENT_REJECTED",
    );

    const equal = await createRoots();
    await expectStartupFailure(
      workspaceOptions(equal, { outputsRoot: equal.workspaceRoot }),
      "HEADLESS_WORKSPACE_CONFINEMENT_REJECTED",
    );

    const relative = await createRoots();
    await expectStartupFailure(
      workspaceOptions(relative, { workspaceRoot: "not-absolute" }),
      "HEADLESS_WORKSPACE_CONFINEMENT_REJECTED",
    );

    const missing = await createRoots();
    await expectStartupFailure(
      workspaceOptions(missing, {
        documentsRoot: join(missing.parent, "missing-documents"),
      }),
      "HEADLESS_WORKSPACE_CONFINEMENT_REJECTED",
    );
  });

  it("keeps envelope authority exact: extra keys and caller capabilities are malformed", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const workspace = await createHeadlessDraftWorkspace(workspaceOptions(roots));

    for (const malformed of [
      envelopeCommand({ actorCapability: "browser-agent" }),
      envelopeCommand({ actorCapability: "human-ui" }),
      envelopeCommand({ extra: "key" }),
      envelopeCommand({ payload: undefined }),
      envelopeCommand({ commandSchemaVersion: 2 }),
      envelopeCommand({ commandId: "" }),
      envelopeCommand({ expectedRevision: "0" }),
      envelopeCommand({ expectedRevision: -1 }),
      envelopeCommand({ payload: "not-a-record" }),
      {},
      undefined,
    ]) {
      const result = await workspace.dispatch(malformed);
      expect(result).toEqual({
        ok: false,
        error: { code: "MALFORMED_COMMAND" },
      });
    }
  });

  it("keeps document identity and revision authority with the domain layer", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const workspace = await createHeadlessDraftWorkspace(workspaceOptions(roots));

    const mismatch = await workspace.dispatch(
      envelopeCommand({ documentId: "document-2" }),
    );
    expect(mismatch).toEqual({ ok: false, error: { code: "DOCUMENT_MISMATCH" } });

    const conflict = await workspace.dispatch(
      envelopeCommand({ expectedRevision: 7 }),
    );
    expect(conflict).toEqual({ ok: false, error: { code: "REVISION_CONFLICT" } });

    const failure = conflict;
    expect(Object.keys(failure).sort()).toEqual(["error", "ok"]);
    expect(Object.keys((failure as { error: { code: string } }).error)).toEqual([
      "code",
    ]);
  });

  it("commits a well-formed command and returns the result-only success shape", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const workspace = await createHeadlessDraftWorkspace(workspaceOptions(roots));

    const result = await workspace.dispatch(envelopeCommand());
    expect(Object.keys(result).sort()).toEqual(["document", "ok", "revision"]);
    if (!result.ok) throw new Error("dispatch must succeed");
    expect(result.revision).toBe(1);
    const track = result.document.tracks[0];
    expect(track?.keyframes[0]?.value).toBe(0.5);
  });
});

describe("seed resolution confinement", () => {
  it("rejects startup when no seed path is configured and nothing is persisted", async () => {
    const roots = await createRoots();
    await expectStartupFailure(
      workspaceOptions(roots, { seedPath: undefined }),
      "HEADLESS_WORKSPACE_SEED_UNAVAILABLE",
    );
  });

  it("rejects a missing seed file, an absolute seed path, and traversal", async () => {
    const missing = await createRoots();
    await expectStartupFailure(
      workspaceOptions(missing, { seedPath: "missing.json" }),
      "HEADLESS_WORKSPACE_SEED_UNAVAILABLE",
    );

    const absolute = await createRoots();
    await writeSeed(absolute, FIRST_SLICE_DOCUMENT);
    await expectStartupFailure(
      workspaceOptions(absolute, {
        seedPath: join(absolute.documentsRoot, SEED_RELATIVE_PATH),
      }),
      "HEADLESS_WORKSPACE_SEED_UNAVAILABLE",
    );

    const traversal = await createRoots();
    await writeSeed(traversal, FIRST_SLICE_DOCUMENT);
    await expectStartupFailure(
      workspaceOptions(traversal, { seedPath: "../documents/seed.json" }),
      "HEADLESS_WORKSPACE_SEED_UNAVAILABLE",
    );
  });

  it("rejects a seed symlink that escapes the documents role", async () => {
    const roots = await createRoots();
    const escapeTarget = join(roots.parent, "outside-seed.json");
    await writeFile(escapeTarget, JSON.stringify(FIRST_SLICE_DOCUMENT));
    await symlink(escapeTarget, join(roots.documentsRoot, "escape.json"));
    await expectStartupFailure(
      workspaceOptions(roots, { seedPath: "escape.json" }),
      "HEADLESS_WORKSPACE_SEED_UNAVAILABLE",
    );
  });

  it("rejects a seed path that resolves to a directory", async () => {
    const roots = await createRoots();
    await mkdir(join(roots.documentsRoot, "seed-dir"));
    await expectStartupFailure(
      workspaceOptions(roots, { seedPath: "seed-dir" }),
      "HEADLESS_WORKSPACE_SEED_UNAVAILABLE",
    );
  });

  it("rejects malformed seed JSON and schema-invalid seed documents", async () => {
    const malformed = await createRoots();
    await writeFile(join(malformed.documentsRoot, SEED_RELATIVE_PATH), "{not json");
    await expectStartupFailure(
      workspaceOptions(malformed),
      "HEADLESS_WORKSPACE_SEED_INVALID",
    );

    const invalid = await createRoots();
    await writeSeed(invalid, {});
    await expectStartupFailure(
      workspaceOptions(invalid),
      "HEADLESS_WORKSPACE_SEED_INVALID",
    );
  });
});

describe("asset verification", () => {
  it("starts when every referenced asset record is readable and consistent", async () => {
    const roots = await createRoots();
    const asset = await pngAsset(roots);
    await writeSeed(roots, imageDocumentWith(asset));
    const workspace = await createHeadlessDraftWorkspace(workspaceOptions(roots));
    const summaryResult = await workspace.getDraftSummary();
    if (!summaryResult.ok) throw new Error("summary must succeed");
    expect(summaryResult.summary.elementCount).toBe(1);
  });

  it("fails closed when a referenced asset record is missing", async () => {
    const roots = await createRoots();
    const written = await pngAsset(roots);
    await writeSeed(roots, imageDocumentWith(written));
    // Replace the document with a reference to an asset that was never written.
    await writeSeed(
      roots,
      imageDocumentWith({
        sha256: `sha256:${"a".repeat(64)}`,
        byteLength: ASSET_BYTES.byteLength,
      }),
    );
    await expectStartupFailure(
      workspaceOptions(roots),
      "HEADLESS_WORKSPACE_ASSET_UNAVAILABLE",
    );
  });

  it("fails closed when a referenced asset record is corrupt", async () => {
    const roots = await createRoots();
    const asset = await pngAsset(roots);
    await writeSeed(roots, imageDocumentWith(asset));
    await garbleFile(await onlyAssetRecordPath(roots.workspaceRoot));
    await expectStartupFailure(
      workspaceOptions(roots),
      "HEADLESS_WORKSPACE_ASSET_UNAVAILABLE",
    );
  });

  it("fails closed when the declared asset byte length or mime type conflicts", async () => {
    const wrongLength = await createRoots();
    const asset = await pngAsset(wrongLength);
    await writeSeed(wrongLength, imageDocumentWith(asset, { byteLength: asset.byteLength + 1 }));
    await expectStartupFailure(
      workspaceOptions(wrongLength),
      "HEADLESS_WORKSPACE_ASSET_UNAVAILABLE",
    );

    const wrongMime = await createRoots();
    const assets = createFileSystemAssetPersistenceAdapter({
      authority: await testConfinement(wrongMime),
    });
    const stored = await assets.writeAsset({
      mimeType: "text/plain",
      bytes: ASSET_BYTES,
    });
    await writeSeed(wrongMime, imageDocumentWith(stored));
    await expectStartupFailure(
      workspaceOptions(wrongMime),
      "HEADLESS_WORKSPACE_ASSET_UNAVAILABLE",
    );
  });

  it("fails closed when duplicate asset references declare conflicting metadata", async () => {
    // Causal ordering: the contradictory (wrong) declaration comes first and
    // the asset-consistent declaration last, so last-wins deduplication by
    // sha256 would verify only the final declaration and silently accept the
    // first. Every reference to a shared address must be verified.
    const roots = await createRoots();
    const asset = await pngAsset(roots);
    const conflicting = imageDocumentWith(asset, {
      byteLength: asset.byteLength + 1,
    });
    conflicting.elements = [
      ...conflicting.elements,
      {
        id: "image-2",
        type: "image",
        asset: {
          sha256: asset.sha256,
          mimeType: "image/png",
          byteLength: asset.byteLength,
          intrinsicWidth: 4,
          intrinsicHeight: 4,
        },
        x: 10,
        y: 10,
        width: 32,
        height: 32,
        opacity: 1,
      },
    ];
    conflicting.rootIds = ["image-1", "image-2"];
    await writeSeed(roots, conflicting);

    const before = await treeFingerprint(roots.parent);
    await expectStartupFailure(
      workspaceOptions(roots),
      "HEADLESS_WORKSPACE_ASSET_UNAVAILABLE",
    );
    expect(await treeFingerprint(roots.parent)).toBe(before);
  });

  it("starts when duplicate asset references declare consistent metadata", async () => {
    const roots = await createRoots();
    const asset = await pngAsset(roots);
    const duplicate = imageDocumentWith(asset);
    duplicate.elements = [
      ...duplicate.elements,
      {
        id: "image-2",
        type: "image",
        asset: {
          sha256: asset.sha256,
          mimeType: "image/png",
          byteLength: asset.byteLength,
          intrinsicWidth: 4,
          intrinsicHeight: 4,
        },
        x: 10,
        y: 10,
        width: 32,
        height: 32,
        opacity: 1,
      },
    ];
    duplicate.rootIds = ["image-1", "image-2"];
    await writeSeed(roots, duplicate);

    const workspace = await createHeadlessDraftWorkspace(workspaceOptions(roots));
    const summary = await workspace.getDraftSummary();
    if (!summary.ok) throw new Error("summary must succeed");
    expect(summary.summary.elementCount).toBe(2);
  });

  it("fails closed when a referenced asset record is missing on the persisted-draft resume branch", async () => {
    // No seed exists at all: eager asset verification must run on the resume
    // branch, not only on the seed branch.
    const roots = await createRoots();
    await persistDraft(
      roots,
      imageDocumentWith({
        sha256: `sha256:${"a".repeat(64)}`,
        byteLength: ASSET_BYTES.byteLength,
      }),
    );
    await expectStartupFailure(
      workspaceOptions(roots, { seedPath: undefined }),
      "HEADLESS_WORKSPACE_ASSET_UNAVAILABLE",
    );
  });

  it("fails closed when a referenced asset record is corrupt on the persisted-draft resume branch", async () => {
    const roots = await createRoots();
    const asset = await pngAsset(roots);
    await persistDraft(roots, imageDocumentWith(asset));
    await garbleFile(await onlyAssetRecordPath(roots.workspaceRoot));
    await expectStartupFailure(
      workspaceOptions(roots, { seedPath: undefined }),
      "HEADLESS_WORKSPACE_ASSET_UNAVAILABLE",
    );
  });

  it("never writes asset records from workspace operations", async () => {
    const roots = await createRoots();
    const asset = await pngAsset(roots);
    await writeSeed(roots, imageDocumentWith(asset));
    const before = await treeFingerprint(roots.workspaceRoot);
    const workspace = await createHeadlessDraftWorkspace(workspaceOptions(roots));
    await workspace.dispatch(envelopeCommand());
    await workspace.undo();
    expect(await treeFingerprint(roots.workspaceRoot)).toBe(before);
  });
});

describe("direct and headless equivalence", () => {
  it("matches direct session dispatch, undo, and redo results on identical inputs", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const workspace = await createHeadlessDraftWorkspace(workspaceOptions(roots));

    // The direct session models the identical headless input, including the
    // injected headless capability.
    const directSession = createCommandSession(
      DOCUMENT_ID,
      structuredClone(FIRST_SLICE_DOCUMENT),
    );
    const headlessCommand = envelopeCommand();
    const directCommand = {
      ...structuredClone(headlessCommand),
      actorCapability: "headless-agent",
    };

    const dispatchedDirect = directSession.dispatch(directCommand);
    const dispatchedHeadless = await workspace.dispatch(headlessCommand);
    expect(dispatchedHeadless).toEqual(dispatchedDirect);

    const undoneDirect = directSession.undo();
    const undoneHeadless = await workspace.undo();
    expect(undoneHeadless).toEqual(undoneDirect);

    const redoneDirect = directSession.redo();
    const redoneHeadless = await workspace.redo();
    expect(redoneHeadless).toEqual(redoneDirect);

    expect(directSession.snapshot().revision).toBe(3);
    const summary = await workspace.getDraftSummary();
    if (!summary.ok) throw new Error("summary must succeed");
    expect(summary.summary.revision).toBe(3);
  });

  it("matches direct results at a nonzero persisted revision offset through translated revisions", async () => {
    // Resume at persisted sequence 6 (saved pointer at 5). The direct session
    // is rebuilt from the same document with its counter at zero, so every
    // expectedRevision is translated down and every result revision up by the
    // offset while documents and result shapes stay equivalent.
    const roots = await createRoots();
    const adapter = createFileSystemPersistenceAdapter({
      authority: await testConfinement(roots),
    });
    const saved = createCompleteRevision({
      documentId: DOCUMENT_ID,
      revisionId: "saved-revision",
      sequence: 5,
      document: FIRST_SLICE_DOCUMENT,
    });
    const draftDocument = {
      ...structuredClone(FIRST_SLICE_DOCUMENT),
      durationUs: 3_000_000,
    };
    const draft = createCompleteRevision({
      documentId: DOCUMENT_ID,
      revisionId: "draft-revision",
      sequence: 6,
      document: draftDocument,
    });
    await adapter.writeCompleteRevision(
      saved,
      createRevisionPointersSnapshot({
        saved: createSavedRevisionPointer(saved),
        draft: null,
      }),
    );
    await adapter.writeCompleteRevision(
      draft,
      createRevisionPointersSnapshot({
        saved: createSavedRevisionPointer(saved),
        draft: createDraftRevisionPointer(draft),
      }),
    );

    const offset = 6;
    const workspace = await createHeadlessDraftWorkspace(
      workspaceOptions(roots, { seedPath: undefined }),
    );
    const directSession = createCommandSession(
      DOCUMENT_ID,
      structuredClone(draftDocument),
    );
    const directCommand = (expectedRevision: number) => ({
      commandSchemaVersion: 1 as const,
      commandId: "command-1",
      documentId: DOCUMENT_ID,
      expectedRevision,
      payload: setKeyframePayload(0.6),
      actorCapability: "headless-agent" as const,
    });

    const dispatchedDirect = directSession.dispatch(directCommand(0));
    const dispatchedHeadless = await workspace.dispatch(
      envelopeCommand(
        { expectedRevision: offset },
        setKeyframePayload(0.6),
      ),
    );
    if (!dispatchedDirect.ok) throw new Error("direct dispatch must succeed");
    if (!dispatchedHeadless.ok) throw new Error("dispatch must succeed");
    expect({ ...dispatchedHeadless, revision: dispatchedHeadless.revision - offset }).toEqual(
      dispatchedDirect,
    );

    const undoneDirect = directSession.undo();
    const undoneHeadless = await workspace.undo();
    if (!undoneDirect.ok) throw new Error("direct undo must succeed");
    if (!undoneHeadless.ok) throw new Error("undo must succeed");
    expect({ ...undoneHeadless, revision: undoneHeadless.revision - offset }).toEqual(
      undoneDirect,
    );

    const redoneDirect = directSession.redo();
    const redoneHeadless = await workspace.redo();
    if (!redoneDirect.ok) throw new Error("direct redo must succeed");
    if (!redoneHeadless.ok) throw new Error("redo must succeed");
    expect({ ...redoneHeadless, revision: redoneHeadless.revision - offset }).toEqual(
      redoneDirect,
    );

    // Conflict authority stays with the domain layer at the offset too.
    const conflictDirect = directSession.dispatch(directCommand(99));
    const conflictHeadless = await workspace.dispatch(
      envelopeCommand(
        { commandId: "command-conflict", expectedRevision: offset + 99 },
        setKeyframePayload(0.4),
      ),
    );
    expect(conflictHeadless).toEqual(conflictDirect);

    const summary = await workspace.getDraftSummary();
    if (!summary.ok) throw new Error("summary must succeed");
    expect(summary.summary.revision).toBe(
      offset + directSession.snapshot().revision,
    );
  });

  it("projects the same summary derivation as the browser workspace port", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const workspace = await createHeadlessDraftWorkspace(workspaceOptions(roots));
    const summaryResult = await workspace.getDraftSummary();
    if (!summaryResult.ok) throw new Error("summary must succeed");

    // Same derivation as browser-agent-workspace-port.ts DraftSummary.
    const document = FIRST_SLICE_DOCUMENT;
    const expected = {
      documentId: DOCUMENT_ID,
      revision: 0,
      schemaVersion: document.schemaVersion,
      durationUs: document.durationUs,
      playbackRange: {
        startUs: document.playbackRange.startUs,
        endUs: document.playbackRange.endUs,
      },
      loop: document.loop,
      elementCount: document.elements.length,
      trackCount: document.tracks.length,
    };
    expect(summaryResult.summary).toEqual(expected);
  });
});

describe("resume precedence and durability", () => {
  it("resumes the persisted draft without reading the seed", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const first = await createHeadlessDraftWorkspace(workspaceOptions(roots));
    const dispatched = await first.dispatch(envelopeCommand());
    if (!dispatched.ok) throw new Error("dispatch must succeed");

    // The seed file disappears; resume must not need it.
    await unlink(join(roots.documentsRoot, SEED_RELATIVE_PATH));
    const resumed = await createHeadlessDraftWorkspace(
      workspaceOptions(roots, { seedPath: undefined }),
    );
    const summary = await resumed.getDraftSummary();
    if (!summary.ok) throw new Error("summary must succeed");
    expect(summary.summary.revision).toBe(1);
    const reloaded = await resumed.dispatch(
      envelopeCommand({ commandId: "command-2", expectedRevision: 1 }, setKeyframePayload(0.75)),
    );
    if (!reloaded.ok) throw new Error("resumed dispatch must succeed");
    expect(reloaded.revision).toBe(2);
    expect(reloaded.document.tracks[0]?.keyframes[0]?.value).toBe(0.75);
  });

  it("prefers the persisted draft over a provided seed", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const first = await createHeadlessDraftWorkspace(workspaceOptions(roots));
    await first.dispatch(envelopeCommand());

    const divergentSeed = {
      ...structuredClone(FIRST_SLICE_DOCUMENT),
      durationUs: 9_000_000,
    };
    await writeSeed(roots, divergentSeed, "divergent-seed.json");
    const resumed = await createHeadlessDraftWorkspace(
      workspaceOptions(roots, { seedPath: "divergent-seed.json" }),
    );
    const summary = await resumed.getDraftSummary();
    if (!summary.ok) throw new Error("summary must succeed");
    expect(summary.summary.durationUs).toBe(1_000_000);
  });

  it("starts session-local history empty after resume", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const first = await createHeadlessDraftWorkspace(workspaceOptions(roots));
    await first.dispatch(envelopeCommand());

    const resumed = await createHeadlessDraftWorkspace(
      workspaceOptions(roots, { seedPath: undefined }),
    );
    expect(await resumed.undo()).toEqual({
      ok: false,
      error: { code: "NOTHING_TO_UNDO" },
    });
    expect(await resumed.redo()).toEqual({
      ok: false,
      error: { code: "NOTHING_TO_REDO" },
    });
  });

  it("preserves the saved pointer across resumed drafts", async () => {
    const roots = await createRoots();
    const adapter = createFileSystemPersistenceAdapter({
      authority: await testConfinement(roots),
    });
    const saved = createCompleteRevision({
      documentId: DOCUMENT_ID,
      revisionId: "saved-revision",
      sequence: 5,
      document: FIRST_SLICE_DOCUMENT,
    });
    const draft = createCompleteRevision({
      documentId: DOCUMENT_ID,
      revisionId: "draft-revision",
      sequence: 6,
      document: {
        ...structuredClone(FIRST_SLICE_DOCUMENT),
        durationUs: 3_000_000,
      },
    });
    await adapter.writeCompleteRevision(
      saved,
      createRevisionPointersSnapshot({
        saved: createSavedRevisionPointer(saved),
        draft: null,
      }),
    );
    await adapter.writeCompleteRevision(
      draft,
      createRevisionPointersSnapshot({
        saved: createSavedRevisionPointer(saved),
        draft: createDraftRevisionPointer(draft),
      }),
    );

    const workspace = await createHeadlessDraftWorkspace(
      workspaceOptions(roots, { seedPath: undefined }),
    );
    const summary = await workspace.getDraftSummary();
    if (!summary.ok) throw new Error("summary must succeed");
    expect(summary.summary.revision).toBe(6);
    expect(summary.summary.durationUs).toBe(3_000_000);

    const dispatched = await workspace.dispatch(
      envelopeCommand({ expectedRevision: 6 }),
    );
    if (!dispatched.ok) throw new Error("dispatch must succeed");
    expect(dispatched.revision).toBe(7);

    const pointers = await adapter.readPointers(DOCUMENT_ID);
    expect(pointers.saved).toEqual({
      kind: "saved",
      documentId: DOCUMENT_ID,
      revisionId: "saved-revision",
      sequence: 5,
    });
    expect(pointers.draft?.sequence).toBe(7);
  });

  it("carries a saved-only pointer through a seed start and its first mutation", async () => {
    // Causal coverage for the seed branch: persistence may hold saved != null
    // with draft == null. Startup must seed from the documents root while
    // retaining the saved pointer so the first published snapshot does not
    // erase it.
    const roots = await createRoots();
    const adapter = createFileSystemPersistenceAdapter({
      authority: await testConfinement(roots),
    });
    const saved = createCompleteRevision({
      documentId: DOCUMENT_ID,
      revisionId: "saved-revision",
      sequence: 5,
      document: FIRST_SLICE_DOCUMENT,
    });
    await adapter.writeCompleteRevision(
      saved,
      createRevisionPointersSnapshot({
        saved: createSavedRevisionPointer(saved),
        draft: null,
      }),
    );
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);

    const workspace = await createHeadlessDraftWorkspace(workspaceOptions(roots));
    const summary = await workspace.getDraftSummary();
    if (!summary.ok) throw new Error("summary must succeed");
    expect(summary.summary.revision).toBe(0);

    const dispatched = await workspace.dispatch(envelopeCommand());
    if (!dispatched.ok) throw new Error("dispatch must succeed");
    expect(dispatched.revision).toBe(1);

    const pointers = await adapter.readPointers(DOCUMENT_ID);
    expect(pointers.saved).toEqual({
      kind: "saved",
      documentId: DOCUMENT_ID,
      revisionId: "saved-revision",
      sequence: 5,
    });
    expect(pointers.draft?.sequence).toBe(1);
  });

  it("reloads committed revisions durably across workspace instances", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const first = await createHeadlessDraftWorkspace(workspaceOptions(roots));
    await first.dispatch(envelopeCommand());
    await first.undo();
    const redone = await first.redo();
    if (!redone.ok) throw new Error("redo must succeed");

    const reloaded = await createHeadlessDraftWorkspace(
      workspaceOptions(roots, { seedPath: undefined }),
    );
    const summary = await reloaded.getDraftSummary();
    if (!summary.ok) throw new Error("summary must succeed");
    expect(summary.summary.revision).toBe(3);

    const pointerText = await readFile(await pointerSnapshotPath(roots.outputsRoot), "utf8");
    expect(pointerText).toContain('"sequence":3');
    const revisionRecords = (await layout(roots.outputsRoot)).filter((relative) =>
      relative.includes("/revisions/"),
    );
    expect(revisionRecords).toHaveLength(3);
  });
});

describe("fail-closed persisted state", () => {
  it("fails closed when the draft revision record is missing", async () => {
    const roots = await createRoots();
    await persistDraft(roots, FIRST_SLICE_DOCUMENT);
    await unlink(await onlyRevisionRecordPath(roots.outputsRoot));
    await expectStartupFailure(
      workspaceOptions(roots, { seedPath: undefined }),
      "HEADLESS_WORKSPACE_PERSISTED_STATE_INVALID",
    );
  });

  it("fails closed when the draft revision record is corrupt", async () => {
    const roots = await createRoots();
    await persistDraft(roots, FIRST_SLICE_DOCUMENT);
    await garbleFile(await onlyRevisionRecordPath(roots.outputsRoot));
    await expectStartupFailure(
      workspaceOptions(roots, { seedPath: undefined }),
      "HEADLESS_WORKSPACE_PERSISTED_STATE_INVALID",
    );
  });

  it("fails closed when the pointer snapshot is malformed or incomplete", async () => {
    const malformed = await createRoots();
    await persistDraft(malformed, FIRST_SLICE_DOCUMENT);
    await garbleFile(await pointerSnapshotPath(malformed.outputsRoot));
    await expectStartupFailure(
      workspaceOptions(malformed, { seedPath: undefined }),
      "HEADLESS_WORKSPACE_PERSISTED_STATE_INVALID",
    );

    const incomplete = await createRoots();
    await persistDraft(incomplete, FIRST_SLICE_DOCUMENT);
    await writeFile(
      await pointerSnapshotPath(incomplete.outputsRoot),
      JSON.stringify({
        pointerSnapshotVersion: 1,
        documentId: DOCUMENT_ID,
        saved: null,
        draft: { kind: "draft", documentId: DOCUMENT_ID, revisionId: "revision-1" },
      }),
    );
    await expectStartupFailure(
      workspaceOptions(incomplete, { seedPath: undefined }),
      "HEADLESS_WORKSPACE_PERSISTED_STATE_INVALID",
    );
  });

  it("never falls back to the seed when persisted state is invalid", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    await persistDraft(roots, FIRST_SLICE_DOCUMENT);
    await garbleFile(await onlyRevisionRecordPath(roots.outputsRoot));
    await expectStartupFailure(
      workspaceOptions(roots),
      "HEADLESS_WORKSPACE_PERSISTED_STATE_INVALID",
    );
  });
});

describe("mutation tail, durability, and failure isolation", () => {
  it("returns nothing-to-undo and nothing-to-redo before any mutation", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const workspace = await createHeadlessDraftWorkspace(workspaceOptions(roots));
    expect(await workspace.undo()).toEqual({
      ok: false,
      error: { code: "NOTHING_TO_UNDO" },
    });
    expect(await workspace.redo()).toEqual({
      ok: false,
      error: { code: "NOTHING_TO_REDO" },
    });
  });

  it("serializes concurrent dispatches onto one committed tail", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const workspace = await createHeadlessDraftWorkspace(workspaceOptions(roots));

    const pending = Promise.all([
      workspace.dispatch(envelopeCommand({ commandId: "command-1" }, setKeyframePayload(0.3))),
      workspace.dispatch(
        envelopeCommand({ commandId: "command-2", expectedRevision: 1 }, setKeyframePayload(0.6)),
      ),
      workspace.dispatch(
        envelopeCommand({ commandId: "command-3", expectedRevision: 2 }, setKeyframePayload(0.9)),
      ),
    ]);

    // A read issued while operations are in flight observes the last
    // committed state (the seed), never a fork result.
    const duringFlight = await workspace.getDraftSummary();
    expect(duringFlight.ok && duringFlight.summary.revision).toBe(0);

    const results = await pending;
    results.forEach((result, index) => {
      if (!result.ok) throw new Error(`dispatch ${index} must succeed`);
      expect(result.revision).toBe(index + 1);
    });

    const summary = await workspace.getDraftSummary();
    if (!summary.ok) throw new Error("summary must succeed");
    expect(summary.summary.revision).toBe(3);
  });

  it("maps injected publication failures to DURABLE_PUBLISH_FAILED and keeps the committed state", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const workspace = await createHeadlessDraftWorkspace(workspaceOptions(roots));

    configureHeadlessWorkspaceTestOperations({ failPublication: () => true });
    const failed = await workspace.dispatch(envelopeCommand());
    expect(failed).toEqual({ ok: false, error: { code: "DURABLE_PUBLISH_FAILED" } });

    const summary = await workspace.getDraftSummary();
    if (!summary.ok) throw new Error("summary must succeed");
    expect(summary.summary.revision).toBe(0);

    configureHeadlessWorkspaceTestOperations(undefined);
    const recovered = await workspace.dispatch(envelopeCommand());
    if (!recovered.ok) throw new Error("recovery dispatch must succeed");
    expect(recovered.revision).toBe(1);
  });

  it("maps real adapter collisions to DURABLE_PUBLISH_FAILED and recovers on a fresh id", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const revisionIds = ["fixed-revision-id", "fixed-revision-id", "recovery-id"];
    const workspace = await createHeadlessDraftWorkspace(
      workspaceOptions(roots, {
        revisionIdSource: () => {
          const next = revisionIds.shift();
          if (next === undefined) throw new Error("deterministic id queue exhausted");
          return next;
        },
      }),
    );

    const first = await workspace.dispatch(envelopeCommand());
    if (!first.ok) throw new Error("first dispatch must succeed");
    expect(first.revision).toBe(1);

    const collided = await workspace.dispatch(
      envelopeCommand({ commandId: "command-2", expectedRevision: 1 }, setKeyframePayload(0.8)),
    );
    expect(collided).toEqual({ ok: false, error: { code: "DURABLE_PUBLISH_FAILED" } });

    // Pointer-last: the failed operation published no pointer snapshot.
    const pointerText = await readFile(await pointerSnapshotPath(roots.outputsRoot), "utf8");
    expect(pointerText).toContain('"revisionId":"fixed-revision-id"');
    expect(pointerText).toContain('"sequence":1');
    const summary = await workspace.getDraftSummary();
    if (!summary.ok) throw new Error("summary must succeed");
    expect(summary.summary.revision).toBe(1);

    const recovered = await workspace.dispatch(
      envelopeCommand({ commandId: "command-3", expectedRevision: 1 }, setKeyframePayload(0.8)),
    );
    if (!recovered.ok) throw new Error("recovery dispatch must succeed");
    expect(recovered.revision).toBe(2);
    expect(recovered.document.tracks[0]?.keyframes[0]?.value).toBe(0.8);

    const reloaded = await createHeadlessDraftWorkspace(
      workspaceOptions(roots, { seedPath: undefined }),
    );
    const reloadedSummary = await reloaded.getDraftSummary();
    if (!reloadedSummary.ok) throw new Error("summary must succeed");
    expect(reloadedSummary.summary.revision).toBe(2);
  });

  it("keeps persisted revisions monotonic through undo and redo", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const workspace = await createHeadlessDraftWorkspace(workspaceOptions(roots));

    const dispatched = await workspace.dispatch(envelopeCommand());
    if (!dispatched.ok) throw new Error("dispatch must succeed");
    const undone = await workspace.undo();
    if (!undone.ok) throw new Error("undo must succeed");
    expect(undone.revision).toBe(2);
    expect(undone.document).toEqual(structuredClone(FIRST_SLICE_DOCUMENT));
    const redone = await workspace.redo();
    if (!redone.ok) throw new Error("redo must succeed");
    expect(redone.revision).toBe(3);

    const reloaded = await createHeadlessDraftWorkspace(
      workspaceOptions(roots, { seedPath: undefined }),
    );
    const summary = await reloaded.getDraftSummary();
    if (!summary.ok) throw new Error("summary must succeed");
    expect(summary.summary.revision).toBe(3);
    expect(summary.summary.elementCount).toBe(1);
  });
});

// create-element, replace-element, and group-elements mint element ids.
// The headless workspace must accept an injectable deterministic id source so
// these commands behave exactly like the direct domain session; the
// production default is a safe random source.
const INJECTED_IDS = ["injected-id-1", "injected-id-2", "injected-id-3"];

const makeInjectedIdSource = () => {
  let cursor = 0;
  return () => {
    const id = INJECTED_IDS[cursor];
    cursor += 1;
    return id === undefined
      ? ({ kind: "unavailable" } as const)
      : ({ kind: "id", id } as const);
  };
};

const shapeCreatePayload = {
  type: "create-element",
  element: { type: "shape", x: 1, y: 2, width: 30, height: 40, opacity: 1 },
};

const shapeReplacePayload = {
  type: "replace-element",
  elementId: "shape-1",
  element: { type: "shape", x: 5, y: 6, width: 60, height: 70, opacity: 0.5 },
};

const imageCreatePayload = (asset: {
  sha256: string;
  byteLength: number;
}) => ({
  type: "create-element",
  element: {
    type: "image",
    asset: {
      sha256: asset.sha256,
      mimeType: "image/png",
      byteLength: asset.byteLength,
      intrinsicWidth: 4,
      intrinsicHeight: 4,
    },
    x: 0,
    y: 0,
    width: 32,
    height: 32,
    opacity: 1,
  },
});

const parityRunner = (
  workspace: HeadlessDraftWorkspace,
  directSession: ReturnType<typeof createCommandSession>,
) => {
  let expectedRevision = 0;
  return async (payload: unknown) => {
    const commandId = `command-parity-${expectedRevision + 1}`;
    const direct = directSession.dispatch({
      commandSchemaVersion: 1,
      commandId,
      documentId: DOCUMENT_ID,
      expectedRevision,
      payload: structuredClone(payload),
      actorCapability: "headless-agent",
    });
    const headless = await workspace.dispatch({
      commandSchemaVersion: 1,
      commandId,
      documentId: DOCUMENT_ID,
      expectedRevision,
      payload: structuredClone(payload),
    });
    expect(headless).toEqual(direct);
    if (!direct.ok) throw new Error("direct step must succeed");
    expectedRevision += 1;
    return direct;
  };
};

describe("ID-minting command capability", () => {
  it("runs create-element, replace-element, and group-elements with exact direct-session parity under an injected id source", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const workspace = await createHeadlessDraftWorkspace(
      workspaceOptions(roots, { elementIdSource: makeInjectedIdSource() }),
    );
    const directSession = createCommandSession(
      DOCUMENT_ID,
      structuredClone(FIRST_SLICE_DOCUMENT),
      makeInjectedIdSource(),
    );
    const parity = parityRunner(workspace, directSession);

    const created = await parity(shapeCreatePayload);
    const replaced = await parity(shapeReplacePayload);
    if (!created.ok || !replaced.ok) throw new Error("parity steps must succeed");
    // After replace, the surviving root ids are the minted ones on both
    // sides; grouping them mints the third injected id.
    await parity({
      type: "group-elements",
      elementIds: [...replaced.document.rootIds],
    });

    const summary = await workspace.getDraftSummary();
    if (!summary.ok) throw new Error("summary must succeed");
    expect(summary.summary.revision).toBe(3);
    expect(summary.summary.elementCount).toBe(3);
    expect(directSession.snapshot().revision).toBe(3);
  });

  it("persists a successful image introduction and keeps replace and group parity with the direct session", async () => {
    const roots = await createRoots();
    const asset = await pngAsset(roots);
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const workspaceRootBefore = await treeFingerprint(roots.workspaceRoot);
    const workspace = await createHeadlessDraftWorkspace(
      workspaceOptions(roots, { elementIdSource: makeInjectedIdSource() }),
    );
    const directSession = createCommandSession(
      DOCUMENT_ID,
      structuredClone(FIRST_SLICE_DOCUMENT),
      makeInjectedIdSource(),
    );
    const parity = parityRunner(workspace, directSession);

    // The candidate references a valid pre-existing asset, so eager
    // verification passes and the image is published durably.
    const created = await parity(imageCreatePayload(asset));
    const replaced = await parity(shapeReplacePayload);
    if (!created.ok || !replaced.ok) throw new Error("parity steps must succeed");
    const grouped = await parity({
      type: "group-elements",
      elementIds: [...replaced.document.rootIds],
    });
    if (!grouped.ok) throw new Error("group step must succeed");
    expect(grouped.document.elements.map((element) => element.type).sort())
      .toEqual(["group", "image", "shape"]);

    // The published revision reloads with the introduced image.
    const reloaded = await createHeadlessDraftWorkspace(
      workspaceOptions(roots, { seedPath: undefined }),
    );
    const summary = await reloaded.getDraftSummary();
    if (!summary.ok) throw new Error("summary must succeed");
    expect(summary.summary.revision).toBe(3);
    expect(summary.summary.elementCount).toBe(3);

    // Assets stay read-only: no operation wrote asset records.
    expect(await treeFingerprint(roots.workspaceRoot)).toBe(workspaceRootBefore);
  });

  it("mints safe random element ids by default without an injected source", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const workspace = await createHeadlessDraftWorkspace(workspaceOptions(roots));

    const created = await workspace.dispatch(
      envelopeCommand(undefined, shapeCreatePayload),
    );
    if (!created.ok) throw new Error("default create-element must succeed");
    const minted = created.document.elements.filter(
      (element) => element.id !== "shape-1",
    );
    expect(minted).toHaveLength(1);
    expect(minted[0]!.id).toMatch(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/);

    const second = await workspace.dispatch(
      envelopeCommand(
        { commandId: "command-2", expectedRevision: 1 },
        shapeCreatePayload,
      ),
    );
    if (!second.ok) throw new Error("second default create-element must succeed");
    const ids = second.document.elements.map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("candidate asset verification before publication", () => {
  const expectFailedPublicationState = async (
    workspace: HeadlessDraftWorkspace,
  ): Promise<void> => {
    const summary = await workspace.getDraftSummary();
    if (!summary.ok) throw new Error("summary must succeed");
    expect(summary.summary.revision).toBe(0);
    expect(summary.summary.elementCount).toBe(1);
    expect(await workspace.undo()).toEqual({
      ok: false,
      error: { code: "NOTHING_TO_UNDO" },
    });
    expect(await workspace.redo()).toEqual({
      ok: false,
      error: { code: "NOTHING_TO_REDO" },
    });
  };

  it("fails an asset-introducing mutation with a missing asset as DURABLE_PUBLISH_FAILED and leaves state unpublished", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const workspaceRootBefore = await treeFingerprint(roots.workspaceRoot);
    const outputsBefore = await treeFingerprint(roots.outputsRoot);
    const workspace = await createHeadlessDraftWorkspace(
      workspaceOptions(roots, { elementIdSource: makeInjectedIdSource() }),
    );

    const failed = await workspace.dispatch(
      envelopeCommand(
        undefined,
        imageCreatePayload({
          sha256: `sha256:${"a".repeat(64)}`,
          byteLength: ASSET_BYTES.byteLength,
        }),
      ),
    );
    expect(failed).toEqual({
      ok: false,
      error: { code: "DURABLE_PUBLISH_FAILED" },
    });

    await expectFailedPublicationState(workspace);
    expect(await treeFingerprint(roots.workspaceRoot)).toBe(workspaceRootBefore);
    expect(await treeFingerprint(roots.outputsRoot)).toBe(outputsBefore);

    const recovered = await workspace.dispatch(
      envelopeCommand({ commandId: "command-recovered", expectedRevision: 0 }),
    );
    if (!recovered.ok) throw new Error("recovery dispatch must succeed");
    expect(recovered.revision).toBe(1);
  });

  it("fails an asset-introducing mutation with a corrupt asset as DURABLE_PUBLISH_FAILED and leaves state unpublished", async () => {
    const roots = await createRoots();
    const asset = await pngAsset(roots);
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    // The corrupt record is unreferenced by the seed, so startup succeeds;
    // only the mutation-time candidate verification can catch it.
    await garbleFile(await onlyAssetRecordPath(roots.workspaceRoot));
    const workspaceRootBefore = await treeFingerprint(roots.workspaceRoot);
    const outputsBefore = await treeFingerprint(roots.outputsRoot);
    const workspace = await createHeadlessDraftWorkspace(
      workspaceOptions(roots, { elementIdSource: makeInjectedIdSource() }),
    );

    const failed = await workspace.dispatch(
      envelopeCommand(undefined, imageCreatePayload(asset)),
    );
    expect(failed).toEqual({
      ok: false,
      error: { code: "DURABLE_PUBLISH_FAILED" },
    });

    await expectFailedPublicationState(workspace);
    expect(await treeFingerprint(roots.workspaceRoot)).toBe(workspaceRootBefore);
    expect(await treeFingerprint(roots.outputsRoot)).toBe(outputsBefore);

    const recovered = await workspace.dispatch(
      envelopeCommand({ commandId: "command-recovered", expectedRevision: 0 }),
    );
    if (!recovered.ok) throw new Error("recovery dispatch must succeed");
    expect(recovered.revision).toBe(1);
  });
});

describe("returned document ownership", () => {
  // Returned success documents are caller-owned: mutating them happens
  // outside the five operations and must never reach the workspace's active
  // state, a later summary, or subsequent behavior. Every corrupted field
  // below is summary-visible, so a leak cannot hide.
  const corruptSummaryVisibleFields = (document: SceneDocumentV1): void => {
    document.durationUs = 9_876_543;
    document.playbackRange.endUs = 424_242;
    document.loop = false;
    document.elements.push(structuredClone(document.elements[0]!));
    document.tracks.pop();
  };

  const expectPristineSummary = async (
    workspace: HeadlessDraftWorkspace,
    revision: number,
  ): Promise<void> => {
    const summary = await workspace.getDraftSummary();
    if (!summary.ok) throw new Error("summary must succeed");
    expect(summary.summary).toEqual({
      documentId: DOCUMENT_ID,
      revision,
      schemaVersion: 1,
      durationUs: 1_000_000,
      playbackRange: { startUs: 0, endUs: 1_000_000 },
      loop: true,
      elementCount: 1,
      trackCount: 1,
    });
  };

  it("isolates the active summary from mutations of a returned dispatch document", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const workspace = await createHeadlessDraftWorkspace(workspaceOptions(roots));

    const dispatched = await workspace.dispatch(envelopeCommand());
    if (!dispatched.ok) throw new Error("dispatch must succeed");
    expect(dispatched.document.tracks[0]?.keyframes[0]?.value).toBe(0.5);
    corruptSummaryVisibleFields(dispatched.document);

    await expectPristineSummary(workspace, 1);

    // Subsequent behavior must observe the uncorrupted internal state.
    const undone = await workspace.undo();
    if (!undone.ok) throw new Error("undo must succeed");
    expect(undone.document).toEqual(structuredClone(FIRST_SLICE_DOCUMENT));
    await expectPristineSummary(workspace, 2);
  });

  it("isolates the active summary from mutations of a returned undo document", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const workspace = await createHeadlessDraftWorkspace(workspaceOptions(roots));
    const dispatched = await workspace.dispatch(envelopeCommand());
    if (!dispatched.ok) throw new Error("dispatch must succeed");

    const undone = await workspace.undo();
    if (!undone.ok) throw new Error("undo must succeed");
    corruptSummaryVisibleFields(undone.document);

    await expectPristineSummary(workspace, 2);
  });

  it("isolates the active summary from mutations of a returned redo document", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const workspace = await createHeadlessDraftWorkspace(workspaceOptions(roots));
    await workspace.dispatch(envelopeCommand());
    await workspace.undo();

    const redone = await workspace.redo();
    if (!redone.ok) throw new Error("redo must succeed");
    corruptSummaryVisibleFields(redone.document);

    await expectPristineSummary(workspace, 3);

    // A later dispatch still observes the true internal revision and content.
    const later = await workspace.dispatch(
      envelopeCommand(
        { commandId: "command-2", expectedRevision: 3 },
        setKeyframePayload(0.9),
      ),
    );
    if (!later.ok) throw new Error("later dispatch must succeed");
    expect(later.revision).toBe(4);
    expect(later.document.tracks[0]?.keyframes[0]?.value).toBe(0.9);
  });

  it("isolates resumed active state from mutations of a returned dispatch document", async () => {
    const roots = await createRoots();
    await persistDraft(roots, FIRST_SLICE_DOCUMENT);
    const workspace = await createHeadlessDraftWorkspace(
      workspaceOptions(roots, { seedPath: undefined }),
    );

    const dispatched = await workspace.dispatch(
      envelopeCommand({ expectedRevision: 1 }),
    );
    if (!dispatched.ok) throw new Error("dispatch must succeed");
    corruptSummaryVisibleFields(dispatched.document);

    await expectPristineSummary(workspace, 2);
  });
});

describe("documents-root authority", () => {
  it("never mutates the documents root across startup and mutations", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const before = await treeFingerprint(roots.documentsRoot);
    const workspace = await createHeadlessDraftWorkspace(workspaceOptions(roots));
    await workspace.dispatch(envelopeCommand());
    await workspace.undo();
    await workspace.dispatch(envelopeCommand({ commandId: "command-2", expectedRevision: 2 }, setKeyframePayload(0.4)));
    expect(await treeFingerprint(roots.documentsRoot)).toBe(before);
  });
});

describe("validateDraft", () => {
  it("delegates validation result-only and matches the domain validator", async () => {
    const roots = await createRoots();
    await writeSeed(roots, FIRST_SLICE_DOCUMENT);
    const workspace = await createHeadlessDraftWorkspace(workspaceOptions(roots));

    expect(workspace.validateDraft(structuredClone(FIRST_SLICE_DOCUMENT))).toEqual(
      validateSceneDocument(structuredClone(FIRST_SLICE_DOCUMENT)),
    );
    expect(workspace.validateDraft({})).toEqual(validateSceneDocument({}));
    expect(workspace.validateDraft(null)).toEqual(validateSceneDocument(null));
  });
});
