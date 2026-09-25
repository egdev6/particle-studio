import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
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

const rootModule = await import("../src/index.js");
const persistence = await import("@particle-studio/persistence");
const revisionModule = await import("../src/revision-persistence.js");
const assetModule = await import("../src/asset-persistence.js");
const { createAtomicPublicationTestOperations } = await import(
  "../src/atomic-publication-test.js"
);
const { createAssetPersistenceTestOperations } = await import(
  "../src/asset-persistence-test.js"
);

beforeAll(() => {
  prepareValidator();
});

const {
  createCompleteRevision,
  createRevisionPointersSnapshot,
  createSavedRevisionPointer,
} = persistence;
const { createRootConfinement } = rootModule;
const { createFileSystemPersistenceAdapter } = revisionModule;
const {
  MAX_ASSET_BYTES,
  MAX_ASSET_RECORD_BYTES,
  FileSystemAssetPersistenceError,
  createFileSystemAssetPersistenceAdapter,
} = assetModule;
type AssetError = InstanceType<typeof assetModule.FileSystemAssetPersistenceError>;

let fixture: string | undefined;

async function setup() {
  fixture = await mkdtemp(join(tmpdir(), "particle-studio-asset-persistence-"));
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
    adapter: createFileSystemAssetPersistenceAdapter({ authority }),
  };
}

afterEach(async () => {
  createAssetPersistenceTestOperations(undefined);
  createAtomicPublicationTestOperations({});
  if (fixture !== undefined) await rm(fixture, { recursive: true, force: true });
  fixture = undefined;
});

async function expectAssetErrorCode(
  run: () => Promise<unknown>,
  code: string,
): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(FileSystemAssetPersistenceError);
  const error = caught as AssetError;
  expect(error.code).toBe(code);
  expect(error.message).toBe(code);
  expect(error.name).toBe("FileSystemAssetPersistenceError");
  expect(error.cause).toBeUndefined();
}

function addressOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Test-local, independent derivation of the private asset layout. It locks
 * the namespace, domain names, separator scheme, and directory structure so
 * the adapter cannot drift from the accepted layout contract.
 */
const privateRoot = "particle-studio-persistence-v1";

function testDomainSegment(domain: string, parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update("particle-studio:persistence-fs:v1", "utf8");
  hash.update("\0", "utf8");
  hash.update(domain, "utf8");
  for (const part of parts) {
    hash.update("\0", "utf8");
    hash.update(part, "utf8");
  }
  return hash.digest("hex");
}

function assetRecordRelativePath(address: string): string {
  const dirSegment = testDomainSegment("asset-directory", [address]);
  const fileSegment = testDomainSegment("asset-file", [address]);
  return `${privateRoot}/assets/${dirSegment}/${fileSegment}.json`;
}

function assetRecordText(mimeType: string, byteLength: number, dataBase64: string): string {
  return JSON.stringify({ assetVersion: 1, mimeType, byteLength, dataBase64 });
}

function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function walkLayout(
  rootDir: string,
): Promise<{ dirs: string[]; files: string[] }> {
  const base = join(rootDir, privateRoot);
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
  await walk(base, privateRoot);
  return { dirs: dirs.sort(), files: files.sort() };
}

async function recordTimestamps(path: string) {
  const details = await stat(path);
  return { ino: details.ino, ctimeMs: details.ctimeMs, mtimeMs: details.mtimeMs, size: details.size };
}

const sampleBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0xff,
]);
const otherBytes = new Uint8Array([0x00, 0xff, 0x7f, 0x42, 0x13, 0x37]);

describe("filesystem asset persistence", () => {
  it("exposes the asset surface only through the dedicated subpath", async () => {
    expect("createFileSystemAssetPersistenceAdapter" in rootModule).toBe(false);
    expect("FileSystemAssetPersistenceError" in rootModule).toBe(false);
    expect("MAX_ASSET_BYTES" in rootModule).toBe(false);
    expect("MAX_ASSET_RECORD_BYTES" in rootModule).toBe(false);

    expect(MAX_ASSET_BYTES).toBe(16 * 1024 * 1024);
    expect(MAX_ASSET_RECORD_BYTES).toBe(24 * 1024 * 1024);
    expect(typeof createFileSystemAssetPersistenceAdapter).toBe("function");
    expect(FileSystemAssetPersistenceError).toBeInstanceOf(Function);

    const { adapter } = await setup();
    expect(typeof adapter.writeAsset).toBe("function");
    expect(typeof adapter.readAsset).toBe("function");
    let caught: unknown;
    try {
      createFileSystemAssetPersistenceAdapter({ authority: {} as RootConfinement });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FileSystemAssetPersistenceError);
    expect((caught as AssetError).code).toBe("PERSISTENCE_FS_AUTHORITY_INVALID");
  });

  it("writeAsset and readAsset round-trip content-addressed assets with mutation isolation", async () => {
    const { adapter } = await setup();
    const stored = await adapter.writeAsset({ mimeType: "image/png", bytes: sampleBytes });
    expect(stored.sha256).toBe(addressOf(sampleBytes));
    expect(stored.mimeType).toBe("image/png");
    expect(stored.byteLength).toBe(sampleBytes.byteLength);
    expect(stored.bytes).not.toBe(sampleBytes);
    expect(Array.from(stored.bytes)).toEqual(Array.from(sampleBytes));

    const first = await adapter.readAsset(stored.sha256);
    const second = await adapter.readAsset(stored.sha256);
    expect(first).not.toBe(second);
    expect(first.bytes).not.toBe(second.bytes);
    expect(Array.from(first.bytes)).toEqual(Array.from(sampleBytes));

    // Mutation isolation: mutating returned bytes never touches the store.
    first.bytes[0] = 0x00;
    const reread = await adapter.readAsset(stored.sha256);
    expect(Array.from(reread.bytes)).toEqual(Array.from(sampleBytes));
    expect(reread.mimeType).toBe("image/png");
  });

  it("publishes, reads, and reuses a zero-byte asset without rewrite", async () => {
    const { workspace, adapter } = await setup();
    // The standard SHA-256 of the empty input, pinned as a literal from the
    // published SHA-256 test vectors so the expected address is never derived
    // through the adapter under test.
    const emptyAddress =
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const emptyBytes = new Uint8Array(0);

    const events: string[] = [];
    createAssetPersistenceTestOperations({ observe: (event) => events.push(event) });

    const stored = await adapter.writeAsset({
      mimeType: "application/octet-stream",
      bytes: emptyBytes,
    });
    expect(stored.sha256).toBe(emptyAddress);
    expect(stored.mimeType).toBe("application/octet-stream");
    expect(stored.byteLength).toBe(0);
    expect(stored.bytes).not.toBe(emptyBytes);
    expect(stored.bytes.byteLength).toBe(0);
    // The first write published a fresh record: every provisioning and
    // publication event fired, and nothing was reused.
    expect(events).toEqual([
      "ensure-directory:private-root",
      "ensure-directory:assets",
      "ensure-directory:assets/asset-directory",
      "asset-record-published",
    ]);

    // The stored record is the canonical zero-byte form derived independently
    // from the record contract: byteLength 0 with empty canonical base64.
    const recordPath = join(workspace, assetRecordRelativePath(emptyAddress));
    const canonicalZeroRecord = assetRecordText("application/octet-stream", 0, "");
    expect(await readFile(recordPath, "utf8")).toBe(canonicalZeroRecord);
    const before = await recordTimestamps(recordPath);

    // A second identical write reuses the immutable record in place.
    events.length = 0;
    const reused = await adapter.writeAsset({
      mimeType: "application/octet-stream",
      bytes: emptyBytes,
    });
    expect(reused.sha256).toBe(emptyAddress);
    expect(reused.byteLength).toBe(0);
    expect(events).toEqual(["asset-record-reused"]);

    const after = await recordTimestamps(recordPath);
    expect(after.ino).toBe(before.ino);
    expect(after.ctimeMs).toBe(before.ctimeMs);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(await readFile(recordPath, "utf8")).toBe(canonicalZeroRecord);

    // readAsset returns an owned zero-length byte view: a fresh Uint8Array of
    // length zero on every access, never the caller's input or shared bytes.
    const first = await adapter.readAsset(emptyAddress);
    const second = await adapter.readAsset(emptyAddress);
    for (const read of [first, second]) {
      expect(read.sha256).toBe(emptyAddress);
      expect(read.mimeType).toBe("application/octet-stream");
      expect(read.byteLength).toBe(0);
      expect(read.bytes).toBeInstanceOf(Uint8Array);
      expect(read.bytes.byteLength).toBe(0);
      expect(read.bytes).not.toBe(stored.bytes);
    }
    expect(first.bytes).not.toBe(second.bytes);
  });

  it("readAsset reports a missing record explicitly", async () => {
    const { workspace, adapter } = await setup();
    await expectAssetErrorCode(
      () => adapter.readAsset(addressOf(otherBytes)),
      "PERSISTENCE_FS_ASSET_RECORD_MISSING",
    );
    expect(await readdir(workspace)).toEqual([]);
  });

  it("stores asset records at the domain-separated private layout with private modes", async () => {
    const { workspace, outputs, adapter } = await setup();
    const stored = await adapter.writeAsset({ mimeType: "image/png", bytes: sampleBytes });

    const { dirs, files } = await walkLayout(workspace);
    const dirSegment = testDomainSegment("asset-directory", [stored.sha256]);
    const fileSegment = testDomainSegment("asset-file", [stored.sha256]);
    const expectedDirs = [`${privateRoot}/assets`, `${privateRoot}/assets/${dirSegment}`];
    const expectedFiles = [`${privateRoot}/assets/${dirSegment}/${fileSegment}.json`];
    expect(dirs).toEqual(expectedDirs);
    expect(files).toEqual(expectedFiles);

    // The walk starts at the private root; its own mode is checked directly.
    const rootDetails = await stat(join(workspace, privateRoot));
    expect(rootDetails.mode & 0o777).toBe(0o700);
    const provisionedDirs = [privateRoot, ...dirs];
    for (const relative of provisionedDirs) {
      const details = await stat(join(workspace, relative));
      expect(details.mode & 0o777).toBe(0o700);
    }
    const recordPath = join(workspace, expectedFiles[0]!);
    const recordDetails = await stat(recordPath);
    expect(recordDetails.mode & 0o777).toBe(0o600);

    const recordBytes = await readFile(recordPath);
    expect(Buffer.from(recordBytes).toString("utf8")).toBe(
      assetRecordText("image/png", sampleBytes.byteLength, base64Of(sampleBytes)),
    );
    const parsed = JSON.parse(Buffer.from(recordBytes).toString("utf8")) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["assetVersion", "mimeType", "byteLength", "dataBase64"]);
    expect(parsed["assetVersion"]).toBe(1);

    // Assets live under the workspace role only; outputs stays untouched.
    expect(await readdir(outputs)).toEqual([]);
  });

  it("rejects invalid asset input before any filesystem access", async () => {
    const { workspace, adapter } = await setup();
    await expectAssetErrorCode(
      () => adapter.writeAsset({ mimeType: "", bytes: sampleBytes }),
      "PERSISTENCE_FS_ASSET_MIME_TYPE_INVALID",
    );
    await expectAssetErrorCode(
      () => adapter.writeAsset({ mimeType: "   ", bytes: sampleBytes }),
      "PERSISTENCE_FS_ASSET_MIME_TYPE_INVALID",
    );
    await expectAssetErrorCode(
      () => adapter.writeAsset({ mimeType: 42 as unknown as string, bytes: sampleBytes }),
      "PERSISTENCE_FS_ASSET_MIME_TYPE_INVALID",
    );
    await expectAssetErrorCode(
      () =>
        adapter.writeAsset({
          mimeType: "image/png",
          bytes: "not bytes" as unknown as Uint8Array,
        }),
      "PERSISTENCE_FS_ASSET_BYTES_INVALID",
    );
    await expectAssetErrorCode(
      () =>
        adapter.writeAsset({
          mimeType: "image/png",
          bytes: new ArrayBuffer(8) as unknown as Uint8Array,
        }),
      "PERSISTENCE_FS_ASSET_BYTES_INVALID",
    );
    // MIME validation precedes bytes validation.
    await expectAssetErrorCode(
      () =>
        adapter.writeAsset({
          mimeType: "",
          bytes: "nope" as unknown as Uint8Array,
        }),
      "PERSISTENCE_FS_ASSET_MIME_TYPE_INVALID",
    );
    expect(await readdir(workspace)).toEqual([]);
  });

  it("rejects raw bytes over 16 MiB before provisioning and accepts the boundary", async () => {
    const { workspace, adapter } = await setup();
    const oversize = new Uint8Array(16 * 1024 * 1024 + 1);
    await expectAssetErrorCode(
      () => adapter.writeAsset({ mimeType: "application/octet-stream", bytes: oversize }),
      "PERSISTENCE_FS_ASSET_BYTES_OVERSIZE",
    );
    expect(await readdir(workspace)).toEqual([]);

    const boundary = new Uint8Array(16 * 1024 * 1024);
    const stored = await adapter.writeAsset({
      mimeType: "application/octet-stream",
      bytes: boundary,
    });
    expect(stored.sha256).toBe(addressOf(boundary));
    const reread = await adapter.readAsset(stored.sha256);
    expect(reread.byteLength).toBe(boundary.byteLength);
  });

  it("rejects serialized records over 24 MiB before any filesystem mutation", async () => {
    const { workspace, adapter } = await setup();
    const hugeMime = `text/plain;x=${"a".repeat(25 * 1024 * 1024)}`;
    await expectAssetErrorCode(
      () => adapter.writeAsset({ mimeType: hugeMime, bytes: sampleBytes }),
      "PERSISTENCE_FS_ASSET_RECORD_OVERSIZE",
    );
    expect(await readdir(workspace)).toEqual([]);
  });

  it("reuses byte-identical records without rewriting them", async () => {
    const { workspace, adapter } = await setup();
    const stored = await adapter.writeAsset({ mimeType: "image/png", bytes: sampleBytes });
    const recordPath = join(workspace, assetRecordRelativePath(stored.sha256));
    const before = await recordTimestamps(recordPath);
    const recordBefore = await readFile(recordPath);

    const events: string[] = [];
    createAssetPersistenceTestOperations({ observe: (event) => events.push(event) });
    const reused = await adapter.writeAsset({ mimeType: "image/png", bytes: sampleBytes });
    expect(reused.sha256).toBe(stored.sha256);
    expect(events).toEqual(["asset-record-reused"]);

    const after = await recordTimestamps(recordPath);
    expect(after.ino).toBe(before.ino);
    expect(after.ctimeMs).toBe(before.ctimeMs);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(Array.from(await readFile(recordPath))).toEqual(Array.from(recordBefore));
  });

  it("rejects MIME conflicts without mutating the stored record", async () => {
    const { workspace, adapter } = await setup();
    const stored = await adapter.writeAsset({ mimeType: "image/png", bytes: sampleBytes });
    const recordPath = join(workspace, assetRecordRelativePath(stored.sha256));
    const before = await recordTimestamps(recordPath);
    const recordBefore = await readFile(recordPath);

    await expectAssetErrorCode(
      () => adapter.writeAsset({ mimeType: "text/plain", bytes: sampleBytes }),
      "PERSISTENCE_FS_ASSET_MIME_TYPE_CONFLICT",
    );

    const after = await recordTimestamps(recordPath);
    expect(after.ino).toBe(before.ino);
    expect(after.ctimeMs).toBe(before.ctimeMs);
    expect(Array.from(await readFile(recordPath))).toEqual(Array.from(recordBefore));
  });

  it("never overwrites corrupt, malformed, hash-mismatched, symlinked, or oversized records", async () => {
    const { workspace, adapter } = await setup();
    const address = addressOf(sampleBytes);
    const relative = assetRecordRelativePath(address);
    const recordPath = join(workspace, relative);
    await mkdir(join(workspace, privateRoot, "assets", testDomainSegment("asset-directory", [address])), {
      recursive: true,
    });

    const plant = async (content: string): Promise<string> => {
      await writeFile(recordPath, content, "utf8");
      return content;
    };
    const clearPlant = async (): Promise<void> => {
      await unlink(recordPath).catch(() => undefined);
    };
    const assertUnchanged = async (content: string) => {
      expect(await readFile(recordPath, "utf8")).toBe(content);
    };

    // Garbage bytes: malformed.
    let planted = await plant("this is not json at all");
    await expectAssetErrorCode(
      () => adapter.readAsset(address),
      "PERSISTENCE_FS_ASSET_RECORD_MALFORMED",
    );
    await expectAssetErrorCode(
      () => adapter.writeAsset({ mimeType: "image/png", bytes: sampleBytes }),
      "PERSISTENCE_FS_ASSET_RECORD_MALFORMED",
    );
    await assertUnchanged(planted);

    // Wrong JSON shape: extra key is malformed.
    planted = await plant(
      JSON.stringify({
        assetVersion: 1,
        mimeType: "image/png",
        byteLength: sampleBytes.byteLength,
        dataBase64: base64Of(sampleBytes),
        extra: true,
      }),
    );
    await expectAssetErrorCode(
      () => adapter.readAsset(address),
      "PERSISTENCE_FS_ASSET_RECORD_MALFORMED",
    );
    await expectAssetErrorCode(
      () => adapter.writeAsset({ mimeType: "image/png", bytes: sampleBytes }),
      "PERSISTENCE_FS_ASSET_RECORD_MALFORMED",
    );
    await assertUnchanged(planted);

    // Same data, non-canonical key order: corrupt.
    planted = await plant(
      JSON.stringify({
        mimeType: "image/png",
        assetVersion: 1,
        byteLength: sampleBytes.byteLength,
        dataBase64: base64Of(sampleBytes),
      }),
    );
    await expectAssetErrorCode(
      () => adapter.readAsset(address),
      "PERSISTENCE_FS_ASSET_RECORD_CORRUPT",
    );
    await expectAssetErrorCode(
      () => adapter.writeAsset({ mimeType: "image/png", bytes: sampleBytes }),
      "PERSISTENCE_FS_ASSET_RECORD_CORRUPT",
    );
    await assertUnchanged(planted);

    // Tampered payload with canonical JSON: hash mismatch.
    const tampered = base64Of(sampleBytes);
    const tamperedChar = tampered[0] === "A" ? "B" : "A";
    planted = await plant(
      assetRecordText("image/png", sampleBytes.byteLength, `${tamperedChar}${tampered.slice(1)}`),
    );
    await expectAssetErrorCode(
      () => adapter.readAsset(address),
      "PERSISTENCE_FS_ASSET_RECORD_HASH_MISMATCH",
    );
    await expectAssetErrorCode(
      () => adapter.writeAsset({ mimeType: "image/png", bytes: sampleBytes }),
      "PERSISTENCE_FS_ASSET_RECORD_HASH_MISMATCH",
    );
    await assertUnchanged(planted);

    // Over-padded base64: non-canonical encoding, corrupt.
    planted = await plant(
      assetRecordText("image/png", sampleBytes.byteLength, `${base64Of(sampleBytes)}=`),
    );
    await expectAssetErrorCode(
      () => adapter.readAsset(address),
      "PERSISTENCE_FS_ASSET_RECORD_CORRUPT",
    );
    await assertUnchanged(planted);

    // Symlink at the record path: never followed, never replaced.
    await clearPlant();
    const linkTarget = join(workspace, "link-target.txt");
    await writeFile(linkTarget, "precious", "utf8");
    await symlink(linkTarget, recordPath);
    await expectAssetErrorCode(
      () => adapter.readAsset(address),
      "PERSISTENCE_FS_ASSET_RECORD_SYMLINK",
    );
    await expectAssetErrorCode(
      () => adapter.writeAsset({ mimeType: "image/png", bytes: sampleBytes }),
      "PERSISTENCE_FS_ASSET_RECORD_SYMLINK",
    );
    expect((await lstat(recordPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(linkTarget, "utf8")).toBe("precious");
  });

  it("treats a non-regular record path as unavailable", async () => {
    const { workspace, adapter } = await setup();
    const address = addressOf(sampleBytes);
    const recordPath = join(
      workspace,
      assetRecordRelativePath(address),
    );
    await mkdir(recordPath, { recursive: true });
    await expectAssetErrorCode(
      () => adapter.readAsset(address),
      "PERSISTENCE_FS_ASSET_RECORD_UNAVAILABLE",
    );
    await expectAssetErrorCode(
      () => adapter.writeAsset({ mimeType: "image/png", bytes: sampleBytes }),
      "PERSISTENCE_FS_ASSET_RECORD_UNAVAILABLE",
    );
  });

  it("rejects stored records over the serialized limit without mutation", async () => {
    const { workspace, adapter } = await setup();
    const address = addressOf(sampleBytes);
    const recordPath = join(workspace, assetRecordRelativePath(address));
    await mkdir(join(workspace, privateRoot, "assets", testDomainSegment("asset-directory", [address])), {
      recursive: true,
    });
    const oversizeContent = Buffer.alloc(MAX_ASSET_RECORD_BYTES + 1);
    await writeFile(recordPath, oversizeContent);
    await expectAssetErrorCode(
      () => adapter.readAsset(address),
      "PERSISTENCE_FS_ASSET_RECORD_OVERSIZE",
    );
    await expectAssetErrorCode(
      () => adapter.writeAsset({ mimeType: "image/png", bytes: sampleBytes }),
      "PERSISTENCE_FS_ASSET_RECORD_OVERSIZE",
    );
    expect((await stat(recordPath)).size).toBe(MAX_ASSET_RECORD_BYTES + 1);
  });

  it("maps publication failures to the stable asset code without residue", async () => {
    const { workspace, adapter } = await setup();
    createAtomicPublicationTestOperations({ failAt: "link" });
    await expectAssetErrorCode(
      () => adapter.writeAsset({ mimeType: "image/png", bytes: sampleBytes }),
      "PERSISTENCE_FS_ASSET_PUBLICATION_FAILED",
    );
    const { files } = await walkLayout(workspace);
    expect(files).toEqual([]);
  });

  it("preserves durability-uncertain outcomes distinctly and recovers by reuse", async () => {
    const { workspace, adapter } = await setup();
    createAtomicPublicationTestOperations({ failAt: "directory-close" });
    await expectAssetErrorCode(
      () => adapter.writeAsset({ mimeType: "image/png", bytes: sampleBytes }),
      "PERSISTENCE_FS_ASSET_PUBLICATION_DURABILITY_UNCERTAIN",
    );
    // The record was linked before the uncertain directory sync; it exists and
    // is the canonical record.
    const recordPath = join(workspace, assetRecordRelativePath(addressOf(sampleBytes)));
    expect(await readFile(recordPath, "utf8")).toBe(
      assetRecordText("image/png", sampleBytes.byteLength, base64Of(sampleBytes)),
    );

    createAtomicPublicationTestOperations({});
    const reused = await adapter.writeAsset({ mimeType: "image/png", bytes: sampleBytes });
    expect(reused.sha256).toBe(addressOf(sampleBytes));
    const reread = await adapter.readAsset(addressOf(sampleBytes));
    expect(Array.from(reread.bytes)).toEqual(Array.from(sampleBytes));
  });

  it("maps an already-exists publication race to the asset collision code", async () => {
    const { workspace, adapter } = await setup();
    const address = addressOf(sampleBytes);
    const targetPath = join(
      workspace,
      privateRoot,
      "assets",
      testDomainSegment("asset-directory", [address]),
      `${testDomainSegment("asset-file", [address])}.json`,
    );
    const conflictingRecord = assetRecordText(
      "text/plain",
      sampleBytes.byteLength,
      base64Of(sampleBytes),
    );
    createAtomicPublicationTestOperations({
      operations: {
        openStage: async (stagePath) => {
          // Simulate a concurrent writer planting a conflicting record at the
          // target path after our absence check but before the hard link. The
          // stage is a sibling dotfile, so the target leaf name is recovered
          // from the precomputed record path.
          await writeFile(targetPath, conflictingRecord, "utf8");
          return open(stagePath, "wx", 0o600);
        },
        link: async () => {
          const error = new Error("EEXIST") as NodeJS.ErrnoException;
          error.code = "EEXIST";
          throw error;
        },
      },
    });
    await expectAssetErrorCode(
      () => adapter.writeAsset({ mimeType: "image/png", bytes: sampleBytes }),
      "PERSISTENCE_FS_ASSET_RECORD_COLLISION",
    );
    createAtomicPublicationTestOperations({});
    // The conflicting record is never overwritten.
    expect(await readFile(targetPath, "utf8")).toBe(conflictingRecord);
  });

  it("reuses a record planted by a concurrent writer when it is byte-identical", async () => {
    const { workspace, adapter } = await setup();
    const address = addressOf(sampleBytes);
    const targetPath = join(
      workspace,
      privateRoot,
      "assets",
      testDomainSegment("asset-directory", [address]),
      `${testDomainSegment("asset-file", [address])}.json`,
    );
    const identicalRecord = assetRecordText(
      "image/png",
      sampleBytes.byteLength,
      base64Of(sampleBytes),
    );
    const events: string[] = [];
    createAtomicPublicationTestOperations({
      operations: {
        openStage: async (stagePath) => {
          await writeFile(targetPath, identicalRecord, "utf8");
          return open(stagePath, "wx", 0o600);
        },
        link: async () => {
          const error = new Error("EEXIST") as NodeJS.ErrnoException;
          error.code = "EEXIST";
          throw error;
        },
      },
    });
    createAssetPersistenceTestOperations({ observe: (event) => events.push(event) });
    const reused = await adapter.writeAsset({ mimeType: "image/png", bytes: sampleBytes });
    expect(reused.sha256).toBe(address);
    // The race path provisions the layout before the link conflict, then
    // reuses the concurrent writer's record without republishing.
    expect(events).toEqual([
      "ensure-directory:private-root",
      "ensure-directory:assets",
      "ensure-directory:assets/asset-directory",
      "asset-record-reused",
    ]);
    expect(await readFile(targetPath, "utf8")).toBe(identicalRecord);
  });

  it("rejects invalid addresses before any filesystem access", async () => {
    const { workspace, adapter } = await setup();
    const invalidAddresses = [
      "sha256:",
      "sha256:CE66F9F252023A1594DA348C03577C506CA89766E56E1BFEFE19B577FCB89387",
      "sha256:ce66f9f252023a1594da348c03577c506ca89766e56e1bfefe19b577fcb8938",
      "sha256:ce66f9f252023a1594da348c03577c506ca89766e56e1bfefe19b577fcb893877",
      "sha256:zz66f9f252023a1594da348c03577c506ca89766e56e1bfefe19b577fcb89387",
      "ce66f9f252023a1594da348c03577c506ca89766e56e1bfefe19b577fcb89387",
      "",
      42 as unknown as string,
      "sha256:ce66f9f252023a1594da348c03577c506ca89766e56e1bfefe19b577fcb89387 extra",
    ];
    for (const invalid of invalidAddresses) {
      await expectAssetErrorCode(
        () => adapter.readAsset(invalid),
        "PERSISTENCE_FS_ASSET_ADDRESS_INVALID",
      );
    }
    expect(await readdir(workspace)).toEqual([]);
  });

  it("stores assets and revisions in their own roles without regression", async () => {
    const { workspace, outputs, authority, adapter } = await setup();
    const revisionAdapter = createFileSystemPersistenceAdapter({ authority });
    const revision = createCompleteRevision({
      documentId: "document-1",
      revisionId: "revision-1",
      sequence: 1,
      document: (await import("@particle-studio/scene-document")).FIRST_SLICE_DOCUMENT,
    });
    await revisionAdapter.writeCompleteRevision(
      revision,
      createRevisionPointersSnapshot({
        saved: createSavedRevisionPointer(revision),
        draft: null,
      }),
    );
    const stored = await adapter.writeAsset({ mimeType: "image/png", bytes: sampleBytes });

    const workspaceLayout = await walkLayout(workspace);
    expect(workspaceLayout.files).toEqual([assetRecordRelativePath(stored.sha256)]);
    const outputsLayout = await walkLayout(outputs);
    expect(outputsLayout.files.length).toBe(2);
    expect(outputsLayout.files.every((file) => !file.startsWith(`${privateRoot}/assets/`))).toBe(
      true,
    );

    const reread = await adapter.readAsset(stored.sha256);
    expect(Array.from(reread.bytes)).toEqual(Array.from(sampleBytes));
    const rereadRevision = await revisionAdapter.readRevision("document-1", "revision-1");
    expect(rereadRevision?.revisionId).toBe("revision-1");
    expect(rereadRevision?.sequence).toBe(1);
  });

  it("serves stored assets to a second authority over the same roots", async () => {
    const { workspace, documents, outputs, adapter } = await setup();
    const stored = await adapter.writeAsset({ mimeType: "image/png", bytes: sampleBytes });
    const secondAuthority = await createRootConfinement({ workspace, documents, outputs });
    const secondAdapter = createFileSystemAssetPersistenceAdapter({ authority: secondAuthority });
    const reread = await secondAdapter.readAsset(stored.sha256);
    expect(Array.from(reread.bytes)).toEqual(Array.from(sampleBytes));
    expect(reread.mimeType).toBe("image/png");
  });
});
