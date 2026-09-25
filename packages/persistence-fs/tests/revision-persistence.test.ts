import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  CompleteSceneRevision,
  DraftRevisionPointer,
  SavedRevisionPointer,
} from "@particle-studio/persistence";
import type { RootConfinement } from "../src/index.js";

// The persistence and scene-document chains load the generated scene-document
// validator. Prepare it before any dynamic import and restore it before each
// test block so focused runs stay repeatable after a full core run removes
// the generated module.
const workspaceRoot = new URL("../../../", import.meta.url);
const prepareValidator = () => {
  execFileSync("npm", ["run", "validator:prepare"], {
    cwd: workspaceRoot,
    stdio: "pipe",
  });
};

prepareValidator();

const { FIRST_SLICE_DOCUMENT } = await import("@particle-studio/scene-document");
const persistence = await import("@particle-studio/persistence");
const rootModule = await import("../src/index.js");
const revisionModule = await import("../src/revision-persistence.js");
const { createAtomicPublicationTestOperations } = await import(
  "../src/atomic-publication-test.js"
);
const { createRevisionPersistenceTestOperations } = await import(
  "../src/revision-persistence-test.js"
);

beforeAll(() => {
  prepareValidator();
});

const {
  createCompleteRevision,
  createDraftRevisionPointer,
  createRevisionPointersSnapshot,
  createSavedRevisionPointer,
} = persistence;
const { createRootConfinement } = rootModule;
const {
  MAX_POINTER_RECORD_BYTES,
  MAX_REVISION_RECORD_BYTES,
  FileSystemPersistenceError,
  createFileSystemPersistenceAdapter,
} = revisionModule;
type FileSystemPersistenceErrorInstance = InstanceType<
  typeof revisionModule.FileSystemPersistenceError
>;

let fixture: string | undefined;

async function setup() {
  fixture = await mkdtemp(join(tmpdir(), "particle-studio-revision-persistence-"));
  const workspace = join(fixture, "workspace");
  const documents = join(fixture, "documents");
  const outputs = join(fixture, "outputs");
  await Promise.all([mkdir(workspace), mkdir(documents), mkdir(outputs)]);
  const authority = await createRootConfinement({ workspace, documents, outputs });
  return {
    workspace,
    documents,
    outputs,
    authority,
    adapter: createFileSystemPersistenceAdapter({ authority }),
  };
}

afterEach(async () => {
  createRevisionPersistenceTestOperations(undefined);
  createAtomicPublicationTestOperations({});
  if (fixture !== undefined) await rm(fixture, { recursive: true, force: true });
  fixture = undefined;
});

function expectCode(code: string) {
  return expect.objectContaining({ code });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

const conflictingDocument = {
  ...FIRST_SLICE_DOCUMENT,
  elements: [
    {
      ...FIRST_SLICE_DOCUMENT.elements[0],
      x: FIRST_SLICE_DOCUMENT.elements[0].x + 16,
    },
  ],
};

const revision = (
  revisionId: string,
  sequence: number,
  documentId = "document-1",
) =>
  createCompleteRevision({
    documentId,
    revisionId,
    sequence,
    document: FIRST_SLICE_DOCUMENT,
  });

const savedSnapshot = (
  saved: SavedRevisionPointer,
  draft: DraftRevisionPointer | null = null,
) => createRevisionPointersSnapshot({ saved, draft });

const draftSnapshot = (draft: DraftRevisionPointer) =>
  createRevisionPointersSnapshot({ saved: null, draft });

const emptySnapshot = () =>
  createRevisionPointersSnapshot({ saved: null, draft: null });

async function layout(outputs: string): Promise<{ dirs: string[]; files: string[] }> {
  const root = join(outputs, "particle-studio-persistence-v1");
  const dirs: string[] = [];
  const files: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        dirs.push(relative);
        await walk(join(dir, entry.name), relative);
      } else {
        files.push(relative);
      }
    }
  };
  await walk(root, "particle-studio-persistence-v1");
  return {
    dirs: dirs.sort(),
    files: files.sort(),
  };
}

function privatePath(outputs: string, relative: string): string {
  return join(outputs, relative);
}

async function onlyRevisionRecordPath(outputs: string): Promise<string> {
  const { files } = await layout(outputs);
  const matches = files.filter((file) => file.includes("/revisions/"));
  expect(matches).toHaveLength(1);
  return privatePath(outputs, matches[0]!);
}

async function pointerSnapshotPath(outputs: string): Promise<string> {
  const { files } = await layout(outputs);
  const matches = files.filter(
    (file) => file.includes("/pointers/") && file.endsWith("/pointers.json"),
  );
  expect(matches).toHaveLength(1);
  return privatePath(outputs, matches[0]!);
}

describe("revision persistence limits", () => {
  it("exports the delegated record size limits from the adapter subpath", () => {
    expect(MAX_REVISION_RECORD_BYTES).toBe(16 * 1024 * 1024);
    expect(MAX_POINTER_RECORD_BYTES).toBe(64 * 1024);
  });
});

describe("package surface boundaries", () => {
  it("keeps the root entry free of revision adapter and generic file internals", () => {
    for (const forbidden of [
      "createFileSystemPersistenceAdapter",
      "FileSystemPersistenceError",
      "MAX_REVISION_RECORD_BYTES",
      "MAX_POINTER_RECORD_BYTES",
      "setRevisionPersistenceTestConfiguration",
      "ensureConfinementDirectory",
      "inspectConfinementFile",
      "hasRootConfinementAuthority",
    ]) {
      expect(forbidden in rootModule, forbidden).toBe(false);
    }
    for (const required of [
      "createRootConfinement",
      "resolveExistingPath",
      "prepareCreateTarget",
      "verifyCreatedTarget",
      "prepareReplaceableTarget",
      "publishImmutableFile",
      "publishReplaceablePointer",
      "RootConfinementError",
    ]) {
      const value: unknown = (rootModule as Record<string, unknown>)[required];
      expect(typeof value, required).toBe("function");
    }
  });

  it("exposes the revision adapter only through the revision-persistence subpath", () => {
    expect(Object.keys(revisionModule).sort()).toEqual([
      "FileSystemPersistenceError",
      "MAX_POINTER_RECORD_BYTES",
      "MAX_REVISION_RECORD_BYTES",
      "createFileSystemPersistenceAdapter",
    ]);
  });

  it("declares exactly the root and persistence subpath exports", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { exports: Record<string, string> };
    expect(Object.keys(packageJson.exports).sort()).toEqual([
      ".",
      "./asset-persistence",
      "./revision-persistence",
    ]);
    expect(packageJson.exports["."]).toBe("./src/index.ts");
    expect(packageJson.exports["./revision-persistence"]).toBe(
      "./src/revision-persistence.ts",
    );
    expect(packageJson.exports["./asset-persistence"]).toBe(
      "./src/asset-persistence.ts",
    );
  });

  it("keeps root and atomic tests independent of the persistence validator chain", async () => {
    for (const relative of [
      "../src/index.ts",
      "../src/atomic-publication.ts",
      "./root-confinement.test.ts",
      "./atomic-publication.test.ts",
    ]) {
      const source = await readFile(new URL(relative, import.meta.url), "utf8");
      expect(source, relative).not.toMatch(
        /@particle-studio\/(persistence|scene-document)/,
      );
      expect(source, relative).not.toMatch(/revision-persistence/);
    }
  });

  it("keeps atomic publication decoupled from the root entry", async () => {
    const source = await readFile(
      new URL("../src/atomic-publication.ts", import.meta.url),
      "utf8",
    );
    expect(source, "atomic-publication must not import the root entry").not.toMatch(
      /["']\.\/index(\.js)?["']/,
    );
    expect(source, "atomic-publication must bind confinement contracts directly").toMatch(
      /from\s+["']\.\/confinement-contracts\.js["']/,
    );
  });
});

describe("deterministic private layout", () => {
  it("writes hex-segmented records and one pointer snapshot inside the outputs private layout", async () => {
    const { adapter, outputs, workspace, documents } = await setup();
    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(
      r1,
      savedSnapshot(createSavedRevisionPointer(r1), createDraftRevisionPointer(r1)),
    );

    const { dirs, files } = await layout(outputs);
    expect(files.every((file) => file.startsWith("particle-studio-persistence-v1/"))).toBe(
      true,
    );

    const revisionFiles = files.filter((file) => file.includes("/revisions/"));
    expect(revisionFiles).toHaveLength(1);
    expect(revisionFiles[0]).toMatch(
      /^particle-studio-persistence-v1\/revisions\/[0-9a-f]{64}\/[0-9a-f]{64}\.json$/,
    );

    const documentSegment = revisionFiles[0]!.split("/")[2]!;
    const pointerFiles = files.filter((file) => file.includes("/pointers/"));
    expect(pointerFiles).toEqual([
      `particle-studio-persistence-v1/pointers/${documentSegment}/pointers.json`,
    ]);

    expect(dirs).toEqual([
      "particle-studio-persistence-v1/pointers",
      `particle-studio-persistence-v1/pointers/${documentSegment}`,
      "particle-studio-persistence-v1/revisions",
      `particle-studio-persistence-v1/revisions/${documentSegment}`,
    ]);

    for (const dir of dirs) {
      const details = await stat(privatePath(outputs, dir));
      expect(details.mode & 0o777).toBe(0o700);
    }
    for (const file of files) {
      const details = await stat(privatePath(outputs, file));
      expect(details.mode & 0o777).toBe(0o600);
    }

    expect(await readdir(workspace)).toEqual([]);
    expect(await readdir(documents)).toEqual([]);
  });

  it("maps distinct documents to distinct stable hex segments", async () => {
    const { adapter, outputs } = await setup();
    await adapter.writeCompleteRevision(
      revision("revision-1", 1, "document-1"),
      emptySnapshot(),
    );
    await adapter.writeCompleteRevision(
      revision("revision-1", 1, "document-2"),
      emptySnapshot(),
    );

    const { files } = await layout(outputs);
    const revisionFiles = files.filter((file) => file.includes("/revisions/"));
    expect(revisionFiles).toHaveLength(2);
    const segments = new Set(revisionFiles.map((file) => file.split("/")[2]));
    expect(segments.size).toBe(2);
    for (const file of revisionFiles) {
      expect(file.split("/")[3]).not.toBe(file.split("/")[2]);
    }
  });

  it("provisions only the needed directories, one at a time", async () => {
    const events: string[] = [];
    createRevisionPersistenceTestOperations({
      observe: (event) => events.push(event),
    });
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(r1, draftSnapshot(createDraftRevisionPointer(r1)));

    expect(events).toEqual([
      "ensure-directory:private-root",
      "ensure-directory:revisions",
      "ensure-directory:revisions/document",
      "revision-record-published",
      "ensure-directory:pointers",
      "ensure-directory:pointers/document",
      "pointer-snapshot-published",
    ]);

    const { files } = await layout(outputs);
    expect(
      files.filter((file) => file.includes("/pointers/") && !file.endsWith("pointers.json")),
    ).toEqual([]);
  });

  it("publishes an all-null snapshot record when the snapshot has no pointers", async () => {
    const events: string[] = [];
    createRevisionPersistenceTestOperations({
      observe: (event) => events.push(event),
    });
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(r1, emptySnapshot());

    expect(events).toEqual([
      "ensure-directory:private-root",
      "ensure-directory:revisions",
      "ensure-directory:revisions/document",
      "revision-record-published",
      "ensure-directory:pointers",
      "ensure-directory:pointers/document",
      "pointer-snapshot-published",
    ]);

    expect(JSON.parse(await readFile(await pointerSnapshotPath(outputs), "utf8"))).toEqual({
      recordVersion: 1,
      recordKind: "revision-pointers-snapshot",
      documentId: "document-1",
      saved: null,
      draft: null,
    });
    expect(await adapter.readPointers("document-1")).toEqual({
      saved: null,
      draft: null,
    });
  });

  it("reuses an identical revision publication and republishes the all-null snapshot", async () => {
    const events: string[] = [];
    createRevisionPersistenceTestOperations({
      observe: (event) => events.push(event),
    });
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(r1, emptySnapshot());
    events.length = 0;

    await adapter.writeCompleteRevision(revision("revision-1", 1), emptySnapshot());

    expect(events).toEqual([
      "revision-record-reused",
      "ensure-directory:pointers",
      "ensure-directory:pointers/document",
      "pointer-snapshot-published",
    ]);
    const { files } = await layout(outputs);
    expect(files.filter((file) => file.includes("/pointers/"))).toHaveLength(1);
    expect(await adapter.readPointers("document-1")).toEqual({
      saved: null,
      draft: null,
    });
  });
});

describe("revision record reuse and collision", () => {
  it("reuses a byte-identical stored revision without rewriting it and keeps publishing pointers", async () => {
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(r1, savedSnapshot(createSavedRevisionPointer(r1)));
    const recordPath = await onlyRevisionRecordPath(outputs);
    const beforeBytes = await readFile(recordPath);
    const beforeStat = await stat(recordPath);

    const events: string[] = [];
    createRevisionPersistenceTestOperations({
      observe: (event) => events.push(event),
    });
    await adapter.writeCompleteRevision(
      revision("revision-1", 1),
      savedSnapshot(createSavedRevisionPointer(r1), createDraftRevisionPointer(r1)),
    );

    expect(events).toEqual([
      "revision-record-reused",
      "ensure-directory:pointers",
      "ensure-directory:pointers/document",
      "pointer-snapshot-published",
    ]);
    expect(await readFile(recordPath)).toEqual(beforeBytes);
    const afterStat = await stat(recordPath);
    expect(afterStat.ino).toBe(beforeStat.ino);

    expect((await adapter.readRevision("document-1", "revision-1"))?.sequence).toBe(1);
    const pointers = await adapter.readPointers("document-1");
    expect(pointers.saved?.revisionId).toBe("revision-1");
    expect(pointers.draft?.revisionId).toBe("revision-1");
  });

  it("fails explicitly when the stored revision content conflicts with the write", async () => {
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(r1, emptySnapshot());
    const recordPath = await onlyRevisionRecordPath(outputs);
    const originalBytes = await readFile(recordPath);
    const originalStat = await stat(recordPath);

    const conflicting = createCompleteRevision({
      documentId: "document-1",
      revisionId: "revision-1",
      sequence: 1,
      document: conflictingDocument,
    });
    await expect(adapter.writeCompleteRevision(conflicting, emptySnapshot())).rejects.toEqual(
      expectCode("PERSISTENCE_FS_REVISION_RECORD_COLLISION"),
    );

    expect(await readFile(recordPath)).toEqual(originalBytes);
    expect((await stat(recordPath)).ino).toBe(originalStat.ino);
    expect((await adapter.readRevision("document-1", "revision-1"))?.sequence).toBe(1);
  });

  it("fails explicitly when the stored revision sequence conflicts with the write", async () => {
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(r1, emptySnapshot());
    const recordPath = await onlyRevisionRecordPath(outputs);
    const originalBytes = await readFile(recordPath);

    const conflicting = createCompleteRevision({
      documentId: "document-1",
      revisionId: "revision-1",
      sequence: 2,
      document: FIRST_SLICE_DOCUMENT,
    });
    await expect(adapter.writeCompleteRevision(conflicting, emptySnapshot())).rejects.toEqual(
      expectCode("PERSISTENCE_FS_REVISION_RECORD_COLLISION"),
    );

    expect(await readFile(recordPath)).toEqual(originalBytes);
  });

  it("fails explicitly instead of reusing a corrupt stored revision", async () => {
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(r1, emptySnapshot());
    const recordPath = await onlyRevisionRecordPath(outputs);
    const original = await readFile(recordPath, "utf8");
    const tampered = original.replace('"document":{', '"document": {');
    expect(tampered).not.toBe(original);
    await writeFile(recordPath, tampered);

    await expect(adapter.writeCompleteRevision(revision("revision-1", 1), emptySnapshot())).rejects.toEqual(
      expectCode("PERSISTENCE_FS_REVISION_RECORD_CORRUPT"),
    );
    expect(await readFile(recordPath, "utf8")).toBe(tampered);
  });
});

describe("revision roundtrip", () => {
  it("reads back a complete revision with owned canonical bytes", async () => {
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(r1, emptySnapshot());

    const recordPath = await onlyRevisionRecordPath(outputs);
    const recordText = await readFile(recordPath, "utf8");
    expect(recordText).toContain('"documentId":"document-1"');
    expect(recordText).toContain('"revisionId":"revision-1"');

    const read = await adapter.readRevision("document-1", "revision-1");
    expect(read).not.toBeNull();
    expect(read!.documentId).toBe("document-1");
    expect(read!.revisionId).toBe("revision-1");
    expect(read!.sequence).toBe(1);
    expect(read!.canonicalization.identifier).toBe("jcs-1");
    expect(read!.canonicalization.byteLength).toBe(r1.canonicalization.byteLength);
    expect(sameBytes(read!.canonicalBytes, r1.canonicalBytes)).toBe(true);
    expect(read!.document).toEqual(FIRST_SLICE_DOCUMENT);
  });

  it("returns null only for genuinely absent revisions", async () => {
    const { adapter } = await setup();
    expect(await adapter.readRevision("document-1", "revision-1")).toBeNull();

    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(r1, emptySnapshot());
    expect(await adapter.readRevision("document-1", "revision-other")).toBeNull();
    expect(await adapter.readRevision("document-other", "revision-1")).toBeNull();
    expect(await adapter.readRevision("document-1", "revision-1")).not.toBeNull();
  });

  it("owns canonical bytes and ignores forged caller canonical fields", async () => {
    const { adapter } = await setup();
    const r1 = revision("revision-1", 1);
    const forged = {
      documentId: r1.documentId,
      revisionId: r1.revisionId,
      sequence: r1.sequence,
      document: FIRST_SLICE_DOCUMENT,
      canonicalization: { identifier: "jcs-1" as const, byteLength: 9999 },
      canonicalBytes: Uint8Array.of(1, 2, 3),
    } satisfies CompleteSceneRevision;
    await adapter.writeCompleteRevision(forged, emptySnapshot());

    const read = await adapter.readRevision("document-1", "revision-1");
    expect(read).not.toBeNull();
    expect(read!.canonicalization.byteLength).toBe(r1.canonicalization.byteLength);
    expect(sameBytes(read!.canonicalBytes, r1.canonicalBytes)).toBe(true);
  });

  it("rejects invalid revision identifiers with a stable error", async () => {
    const { adapter } = await setup();
    await expect(adapter.readRevision("", "revision-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_REVISION_INPUT_INVALID"),
    );
    await expect(adapter.readRevision("document-1", "  ")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_REVISION_INPUT_INVALID"),
    );
    await expect(adapter.readPointers("")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_POINTER_INPUT_INVALID"),
    );
  });
});

describe("pointer snapshot roundtrip", () => {
  it("stores saved and draft pointers in one versioned snapshot record", async () => {
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    const approvalHash = `sha256:${"ab".repeat(32)}`;
    await adapter.writeCompleteRevision(
      r1,
      savedSnapshot(
        createSavedRevisionPointer(r1),
        createDraftRevisionPointer(r1, approvalHash),
      ),
    );

    const snapshotText = await readFile(await pointerSnapshotPath(outputs), "utf8");
    expect(JSON.parse(snapshotText)).toEqual({
      recordVersion: 1,
      recordKind: "revision-pointers-snapshot",
      documentId: "document-1",
      saved: {
        kind: "saved",
        documentId: "document-1",
        revisionId: "revision-1",
        sequence: 1,
      },
      draft: {
        kind: "draft",
        documentId: "document-1",
        revisionId: "revision-1",
        sequence: 1,
        parentApprovalHash: approvalHash,
      },
    });

    expect(await adapter.readPointers("document-1")).toEqual({
      saved: {
        kind: "saved",
        documentId: "document-1",
        revisionId: "revision-1",
        sequence: 1,
      },
      draft: {
        kind: "draft",
        documentId: "document-1",
        revisionId: "revision-1",
        sequence: 1,
        parentApprovalHash: approvalHash,
      },
    });
    expect(await adapter.readPointers("document-other")).toEqual({
      saved: null,
      draft: null,
    });
  });

  it("advances the one snapshot by replacement while revisions stay immutable", async () => {
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(r1, savedSnapshot(createSavedRevisionPointer(r1)));
    const r2 = revision("revision-2", 2);
    await adapter.writeCompleteRevision(r2, savedSnapshot(createSavedRevisionPointer(r2)));

    const { files } = await layout(outputs);
    expect(files.filter((file) => file.includes("/pointers/"))).toHaveLength(1);
    const pointers = await adapter.readPointers("document-1");
    expect(pointers.saved?.revisionId).toBe("revision-2");
    expect((await adapter.readRevision("document-1", "revision-1"))?.sequence).toBe(1);
    expect((await adapter.readRevision("document-1", "revision-2"))?.sequence).toBe(2);
  });

  it("clears previously stored pointers by publishing an all-null snapshot in the same file", async () => {
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(r1, savedSnapshot(createSavedRevisionPointer(r1)));
    const snapshotPath = await pointerSnapshotPath(outputs);
    expect((await adapter.readPointers("document-1")).saved?.revisionId).toBe("revision-1");

    await adapter.writeCompleteRevision(revision("revision-1", 1), emptySnapshot());

    expect(await pointerSnapshotPath(outputs)).toBe(snapshotPath);
    expect(JSON.parse(await readFile(snapshotPath, "utf8"))).toEqual({
      recordVersion: 1,
      recordKind: "revision-pointers-snapshot",
      documentId: "document-1",
      saved: null,
      draft: null,
    });
    expect(await adapter.readPointers("document-1")).toEqual({
      saved: null,
      draft: null,
    });
  });

  it("accepts pointers referencing previously stored revisions", async () => {
    const { adapter } = await setup();
    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(
      r1,
      savedSnapshot(createSavedRevisionPointer(r1), createDraftRevisionPointer(r1)),
    );
    const r2 = revision("revision-2", 2);
    await adapter.writeCompleteRevision(
      r2,
      createRevisionPointersSnapshot({
        saved: createSavedRevisionPointer(r1),
        draft: createDraftRevisionPointer(r2),
      }),
    );

    const pointers = await adapter.readPointers("document-1");
    expect(pointers.saved?.revisionId).toBe("revision-1");
    expect(pointers.draft?.revisionId).toBe("revision-2");
  });

  it("reads back a draft pointer without a parent approval hash", async () => {
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 0);
    await adapter.writeCompleteRevision(r1, draftSnapshot(createDraftRevisionPointer(r1)));

    const snapshotText = await readFile(await pointerSnapshotPath(outputs), "utf8");
    expect(snapshotText).toContain('"saved":null');
    expect(await adapter.readPointers("document-1")).toEqual({
      saved: null,
      draft: {
        kind: "draft",
        documentId: "document-1",
        revisionId: "revision-1",
        sequence: 0,
      },
    });
    const read = await adapter.readRevision("document-1", "revision-1");
    expect(read?.sequence).toBe(0);
  });
});

describe("write ordering and failure semantics", () => {
  it("publishes no pointer when the revision record publication fails", async () => {
    const { adapter, outputs } = await setup();
    createAtomicPublicationTestOperations({ failAt: "link" });
    const r1 = revision("revision-1", 1);

    await expect(
      adapter.writeCompleteRevision(r1, savedSnapshot(createSavedRevisionPointer(r1))),
    ).rejects.toEqual(expectCode("PERSISTENCE_FS_REVISION_PUBLICATION_FAILED"));

    const { files } = await layout(outputs);
    expect(files).toEqual([]);
  });

  it("reports durability-uncertain when the revision publication result is unknown", async () => {
    const { adapter, outputs } = await setup();
    createAtomicPublicationTestOperations({ failAt: "final-verify" });
    const r1 = revision("revision-1", 1);

    await expect(
      adapter.writeCompleteRevision(r1, savedSnapshot(createSavedRevisionPointer(r1))),
    ).rejects.toEqual(expectCode("PERSISTENCE_FS_REVISION_PUBLICATION_DURABILITY_UNCERTAIN"));

    const { files } = await layout(outputs);
    expect(files.filter((file) => file.includes("/pointers/"))).toEqual([]);
  });

  it("leaves at most an orphan revision when the pointer snapshot publication fails", async () => {
    const { adapter, outputs } = await setup();
    createRevisionPersistenceTestOperations({
      failPointerPublication: () => true,
    });
    const r1 = revision("revision-1", 1);

    let caught: unknown;
    try {
      await adapter.writeCompleteRevision(
        r1,
        savedSnapshot(createSavedRevisionPointer(r1), createDraftRevisionPointer(r1)),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FileSystemPersistenceError);
    expect((caught as FileSystemPersistenceErrorInstance).code).toBe(
      "PERSISTENCE_FS_POINTER_PUBLICATION_FAILED",
    );

    const recordPath = await onlyRevisionRecordPath(outputs);
    expect(await readFile(recordPath, "utf8")).toContain('"revisionId":"revision-1"');
    const { files } = await layout(outputs);
    expect(files.filter((file) => file.includes("/pointers/"))).toEqual([]);
  });

  it("reports durability-uncertain when the pointer snapshot publication result is unknown", async () => {
    const { adapter, outputs } = await setup();
    let directoryOpens = 0;
    createAtomicPublicationTestOperations({
      operations: {
        openDirectory: async (path: string) => {
          directoryOpens += 1;
          if (directoryOpens === 2) {
            throw new Error("injected pointer directory open failure");
          }
          return open(path, "r");
        },
      },
    });
    const r1 = revision("revision-1", 1);

    await expect(
      adapter.writeCompleteRevision(
        r1,
        savedSnapshot(createSavedRevisionPointer(r1), createDraftRevisionPointer(r1)),
      ),
    ).rejects.toEqual(expectCode("PERSISTENCE_FS_POINTER_PUBLICATION_DURABILITY_UNCERTAIN"));

    expect(await onlyRevisionRecordPath(outputs)).toBeTruthy();
  });

  it("validates pointers before publishing anything", async () => {
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    const missing = revision("revision-missing", 7);

    await expect(
      adapter.writeCompleteRevision(r1, savedSnapshot(createSavedRevisionPointer(missing))),
    ).rejects.toEqual(expectCode("PERSISTENCE_FS_POINTER_INCOMPLETE"));

    expect(await readdir(outputs)).toEqual([]);
  });

  it("rejects pointers whose stored revision identity mismatches", async () => {
    const { adapter } = await setup();
    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(r1, emptySnapshot());
    const mismatched = createSavedRevisionPointer({
      documentId: "document-1",
      revisionId: "revision-1",
      sequence: 9,
      document: FIRST_SLICE_DOCUMENT,
      canonicalization: r1.canonicalization,
      canonicalBytes: r1.canonicalBytes,
    } satisfies CompleteSceneRevision);

    await expect(
      adapter.writeCompleteRevision(r1, savedSnapshot(mismatched)),
    ).rejects.toEqual(expectCode("PERSISTENCE_FS_POINTER_INCOMPLETE"));
    expect(await adapter.readPointers("document-1")).toEqual({
      saved: null,
      draft: null,
    });
  });

  it("rejects pointers bound to a foreign document", async () => {
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    const foreign = revision("revision-foreign", 1, "document-2");

    await expect(
      adapter.writeCompleteRevision(r1, savedSnapshot(createSavedRevisionPointer(foreign))),
    ).rejects.toEqual(expectCode("PERSISTENCE_FS_POINTER_INCOMPLETE"));
    expect(await readdir(outputs)).toEqual([]);
  });

  it("size-checks every record before publishing anything", async () => {
    const { adapter, outputs } = await setup();
    const hugeDocumentId = `d${"x".repeat(MAX_POINTER_RECORD_BYTES)}`;
    const huge = revision("revision-1", 1, hugeDocumentId);

    await expect(
      adapter.writeCompleteRevision(huge, draftSnapshot(createDraftRevisionPointer(huge))),
    ).rejects.toEqual(expectCode("PERSISTENCE_FS_POINTER_RECORD_OVERSIZE"));

    expect(await readdir(outputs)).toEqual([]);
  });

  it("size-checks the all-null snapshot before publishing anything", async () => {
    const { adapter, outputs } = await setup();
    const hugeDocumentId = `d${"x".repeat(MAX_POINTER_RECORD_BYTES)}`;
    const huge = revision("revision-1", 1, hugeDocumentId);

    await expect(
      adapter.writeCompleteRevision(huge, emptySnapshot()),
    ).rejects.toEqual(expectCode("PERSISTENCE_FS_POINTER_RECORD_OVERSIZE"));

    expect(await readdir(outputs)).toEqual([]);
  });
});

describe("validated revision reads", () => {
  it("rejects non-canonical record bytes", async () => {
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(r1, emptySnapshot());
    const recordPath = await onlyRevisionRecordPath(outputs);
    const original = await readFile(recordPath, "utf8");
    const tampered = original.replace('"document":{', '"document": {');
    expect(tampered).not.toBe(original);
    await writeFile(recordPath, tampered);

    await expect(adapter.readRevision("document-1", "revision-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_REVISION_RECORD_CORRUPT"),
    );
  });

  it("rejects tampered canonicalization metadata", async () => {
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(r1, emptySnapshot());
    const recordPath = await onlyRevisionRecordPath(outputs);
    const parsed = JSON.parse(await readFile(recordPath, "utf8")) as {
      canonicalization: { byteLength: number };
    };
    parsed.canonicalization.byteLength += 1;
    await writeFile(recordPath, JSON.stringify(parsed));

    await expect(adapter.readRevision("document-1", "revision-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_REVISION_RECORD_CORRUPT"),
    );
  });

  it("rejects malformed records", async () => {
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(r1, emptySnapshot());
    const recordPath = await onlyRevisionRecordPath(outputs);
    const parsed = JSON.parse(await readFile(recordPath, "utf8")) as Record<
      string,
      unknown
    >;

    await writeFile(recordPath, "not json");
    await expect(adapter.readRevision("document-1", "revision-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_REVISION_RECORD_MALFORMED"),
    );

    await writeFile(recordPath, "");
    await expect(adapter.readRevision("document-1", "revision-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_REVISION_RECORD_MALFORMED"),
    );

    await writeFile(recordPath, Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    await expect(adapter.readRevision("document-1", "revision-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_REVISION_RECORD_MALFORMED"),
    );

    await writeFile(
      recordPath,
      JSON.stringify({ ...parsed, recordVersion: 2 }),
    );
    await expect(adapter.readRevision("document-1", "revision-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_REVISION_RECORD_MALFORMED"),
    );

    await writeFile(
      recordPath,
      JSON.stringify({
        ...parsed,
        canonicalization: { identifier: "jcs-2", byteLength: 1 },
      }),
    );
    await expect(adapter.readRevision("document-1", "revision-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_REVISION_RECORD_MALFORMED"),
    );

    await writeFile(
      recordPath,
      JSON.stringify({ ...parsed, document: { bogus: true } }),
    );
    await expect(adapter.readRevision("document-1", "revision-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_REVISION_RECORD_MALFORMED"),
    );
  });

  it("rejects oversize records", async () => {
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(r1, emptySnapshot());
    const recordPath = await onlyRevisionRecordPath(outputs);
    await writeFile(recordPath, Buffer.alloc(MAX_REVISION_RECORD_BYTES + 1, 0x20));

    await expect(adapter.readRevision("document-1", "revision-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_REVISION_RECORD_OVERSIZE"),
    );
  });

  it("rejects symlinked records", async () => {
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(r1, emptySnapshot());
    const recordPath = await onlyRevisionRecordPath(outputs);
    const target = join(fixture!, "outside-target.txt");
    await writeFile(target, "outside");
    await unlink(recordPath);
    await symlink(target, recordPath);

    await expect(adapter.readRevision("document-1", "revision-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_REVISION_RECORD_SYMLINK"),
    );
  });

  it("rejects identity mismatch between the record and the request", async () => {
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(r1, emptySnapshot());
    const recordPath = await onlyRevisionRecordPath(outputs);
    const parsed = JSON.parse(await readFile(recordPath, "utf8")) as Record<
      string,
      unknown
    >;
    parsed.revisionId = "revision-imposter";
    await writeFile(recordPath, JSON.stringify(parsed));

    await expect(adapter.readRevision("document-1", "revision-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_REVISION_RECORD_IDENTITY_MISMATCH"),
    );
  });

  it("rejects records with unknown injected properties", async () => {
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(r1, emptySnapshot());
    const recordPath = await onlyRevisionRecordPath(outputs);
    const parsed = JSON.parse(await readFile(recordPath, "utf8")) as Record<
      string,
      unknown
    >;
    parsed.injected = "value";
    await writeFile(recordPath, JSON.stringify(parsed));

    await expect(adapter.readRevision("document-1", "revision-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_REVISION_RECORD_CORRUPT"),
    );
  });

  it("rejects non-regular files at the record path", async () => {
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(r1, emptySnapshot());
    const recordPath = await onlyRevisionRecordPath(outputs);
    await unlink(recordPath);
    await mkdir(recordPath);

    await expect(adapter.readRevision("document-1", "revision-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_REVISION_RECORD_UNAVAILABLE"),
    );
  });
});

describe("validated pointer snapshot reads", () => {
  it("rejects dangling pointers whose referenced revision is absent", async () => {
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(r1, savedSnapshot(createSavedRevisionPointer(r1)));
    await unlink(await onlyRevisionRecordPath(outputs));

    await expect(adapter.readPointers("document-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_POINTER_INCOMPLETE"),
    );
  });

  it("rejects malformed pointer snapshot records", async () => {
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    const approvalHash = `sha256:${"ab".repeat(32)}`;
    await adapter.writeCompleteRevision(
      r1,
      savedSnapshot(
        createSavedRevisionPointer(r1),
        createDraftRevisionPointer(r1, approvalHash),
      ),
    );
    const snapshotPath = await pointerSnapshotPath(outputs);
    const parsed = JSON.parse(await readFile(snapshotPath, "utf8")) as Record<
      string,
      unknown
    >;

    await writeFile(snapshotPath, "junk");
    await expect(adapter.readPointers("document-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_POINTER_RECORD_MALFORMED"),
    );

    await writeFile(snapshotPath, "");
    await expect(adapter.readPointers("document-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_POINTER_RECORD_MALFORMED"),
    );

    await writeFile(snapshotPath, Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    await expect(adapter.readPointers("document-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_POINTER_RECORD_MALFORMED"),
    );

    await writeFile(snapshotPath, JSON.stringify({ ...parsed, recordVersion: 2 }));
    await expect(adapter.readPointers("document-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_POINTER_RECORD_MALFORMED"),
    );

    await writeFile(
      snapshotPath,
      JSON.stringify({ ...parsed, recordKind: "saved-revision-pointer" }),
    );
    await expect(adapter.readPointers("document-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_POINTER_RECORD_MALFORMED"),
    );

    const savedWithHash = parsed.saved as Record<string, unknown>;
    await writeFile(
      snapshotPath,
      JSON.stringify({
        ...parsed,
        saved: { ...savedWithHash, parentApprovalHash: approvalHash },
      }),
    );
    await expect(adapter.readPointers("document-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_POINTER_RECORD_MALFORMED"),
    );

    await writeFile(snapshotPath, JSON.stringify(parsed));
    const draftWithBadHash = {
      ...(parsed.draft as Record<string, unknown>),
      parentApprovalHash: "sha256:xyz",
    };
    await writeFile(
      snapshotPath,
      JSON.stringify({ ...parsed, draft: draftWithBadHash }),
    );
    await expect(adapter.readPointers("document-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_POINTER_RECORD_MALFORMED"),
    );
  });

  it("rejects non-canonical, identity-mismatched, oversize, and symlinked snapshots", async () => {
    const { adapter, outputs } = await setup();
    const r1 = revision("revision-1", 1);
    await adapter.writeCompleteRevision(r1, savedSnapshot(createSavedRevisionPointer(r1)));
    const snapshotPath = await pointerSnapshotPath(outputs);
    const original = await readFile(snapshotPath, "utf8");

    const tampered = original.replace(',"revisionId":', ', "revisionId":');
    expect(tampered).not.toBe(original);
    await writeFile(snapshotPath, tampered);
    await expect(adapter.readPointers("document-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_POINTER_RECORD_CORRUPT"),
    );

    const parsed = JSON.parse(original) as Record<string, unknown>;
    await writeFile(
      snapshotPath,
      JSON.stringify({ ...parsed, injected: "value" }),
    );
    await expect(adapter.readPointers("document-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_POINTER_RECORD_CORRUPT"),
    );

    await writeFile(
      snapshotPath,
      JSON.stringify({ ...parsed, documentId: "document-other" }),
    );
    await expect(adapter.readPointers("document-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_POINTER_RECORD_IDENTITY_MISMATCH"),
    );

    const saved = parsed.saved as Record<string, unknown>;
    await writeFile(
      snapshotPath,
      JSON.stringify({ ...parsed, saved: { ...saved, documentId: "document-other" } }),
    );
    await expect(adapter.readPointers("document-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_POINTER_RECORD_IDENTITY_MISMATCH"),
    );

    await writeFile(snapshotPath, Buffer.alloc(MAX_POINTER_RECORD_BYTES + 1, 0x20));
    await expect(adapter.readPointers("document-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_POINTER_RECORD_OVERSIZE"),
    );

    const target = join(fixture!, "pointer-target.txt");
    await writeFile(target, "outside");
    await unlink(snapshotPath);
    await symlink(target, snapshotPath);
    await expect(adapter.readPointers("document-1")).rejects.toEqual(
      expectCode("PERSISTENCE_FS_POINTER_RECORD_SYMLINK"),
    );
  });
});

describe("authority binding", () => {
  it("fails with a stable adapter error when the authority is not a confinement", async () => {
    let caught: unknown;
    try {
      createFileSystemPersistenceAdapter({
        authority: Object.freeze({}) as RootConfinement,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FileSystemPersistenceError);
    expect((caught as FileSystemPersistenceErrorInstance).code).toBe(
      "PERSISTENCE_FS_AUTHORITY_INVALID",
    );

    let undefinedCaught: unknown;
    try {
      createFileSystemPersistenceAdapter(undefined as never);
    } catch (error) {
      undefinedCaught = error;
    }
    expect(undefinedCaught).toBeInstanceOf(FileSystemPersistenceError);
    expect((undefinedCaught as FileSystemPersistenceErrorInstance).code).toBe(
      "PERSISTENCE_FS_AUTHORITY_INVALID",
    );

    const { authority, adapter } = await setup();
    expect(authority).toBeDefined();
    const r1 = revision("revision-1", 1);
    await expect(adapter.writeCompleteRevision(r1, emptySnapshot())).resolves.toBeUndefined();
  });
});
