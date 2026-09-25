import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  RootConfinementError,
  createRootConfinement,
  prepareCreateTarget,
  prepareReplaceableTarget,
  publishImmutableFile,
  publishReplaceablePointer,
} from "../src/index.js";
import {
  createAtomicPublicationTestOperations,
  type AtomicPublicationOperations,
} from "../src/atomic-publication-test.js";

let fixture: string | undefined;

async function roots() {
  fixture = await mkdtemp(join(tmpdir(), "particle-studio-atomic-"));
  const workspace = join(fixture, "workspace");
  const documents = join(fixture, "documents");
  const outputs = join(fixture, "outputs");
  await Promise.all([mkdir(workspace), mkdir(documents), mkdir(outputs)]);
  return { workspace, documents, outputs };
}

function expectCode(code: RootConfinementError["code"]) {
  return expect.objectContaining({ code });
}

async function setup() {
  const configured = await roots();
  return { configured, authority: await createRootConfinement(configured) };
}

async function stageFiles(parent: string) {
  return (await import("node:fs/promises")).readdir(parent).then((entries) =>
    entries.filter((entry) => entry.startsWith(".particle-studio-stage-")),
  );
}

afterEach(async () => {
  if (fixture !== undefined) await rm(fixture, { recursive: true, force: true });
  fixture = undefined;
});

describe("prepared replaceable targets", () => {
  it("accepts an absent leaf or a regular leaf canonically inside its role", async () => {
    const { configured, authority } = await setup();
    await writeFile(join(configured.outputs, "current"), "old");

    await expect(
      prepareReplaceableTarget(authority, { role: "outputs", path: "next" }),
    ).resolves.toMatchObject({ targetPath: join(configured.outputs, "next") });
    await expect(
      prepareReplaceableTarget(authority, { role: "outputs", path: "current" }),
    ).resolves.toMatchObject({ targetPath: join(configured.outputs, "current") });
  });

  it("rejects directories, symlinks, cross-role leaves, and forged objects", async () => {
    const { configured, authority } = await setup();
    await mkdir(join(configured.outputs, "directory"));
    await writeFile(join(configured.documents, "foreign"), "foreign");
    await (await import("node:fs/promises")).symlink(
      join(configured.documents, "foreign"),
      join(configured.outputs, "linked"),
    );
    await (await import("node:fs/promises")).symlink(
      configured.documents,
      join(configured.outputs, "documents-link"),
    );

    await expect(
      prepareReplaceableTarget(authority, { role: "outputs", path: "directory" }),
    ).rejects.toThrow(expectCode("PERSISTENCE_FS_REPLACE_TARGET_NOT_REGULAR"));
    await expect(
      prepareReplaceableTarget(authority, { role: "outputs", path: "linked" }),
    ).rejects.toThrow(expectCode("PERSISTENCE_FS_REPLACE_TARGET_NOT_REGULAR"));
    await expect(
      prepareReplaceableTarget(authority, {
        role: "outputs",
        path: "documents-link/current",
      }),
    ).rejects.toThrow(expectCode("PERSISTENCE_FS_REPLACE_TARGET_OUTSIDE_ROLE"));
    await expect(
      publishReplaceablePointer(authority, {
        role: "outputs",
        parentPath: configured.outputs,
        leafName: "forged",
        targetPath: join(configured.outputs, "forged"),
      }, Uint8Array.of(1))).rejects.toThrow(
      expectCode("PERSISTENCE_FS_PREPARED_TARGET_INVALID"),
    );
  });
});

describe("atomic confined publication", () => {
  it("publishes immutable bytes through an exclusive 0600 same-directory stage in durable order", async () => {
    const { configured, authority } = await setup();
    const prepared = await prepareCreateTarget(authority, {
      role: "outputs",
      path: "revision.bin",
    });
    const events: string[] = [];
    const publisher = createAtomicPublicationTestOperations({
      stageName: () => ".particle-studio-stage-order",
      observe: (event) => events.push(event),
    });

    await publisher.publishImmutableFile(authority, prepared, Uint8Array.of(1, 2, 3));

    expect(await readFile(join(configured.outputs, "revision.bin"))).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect((await stat(join(configured.outputs, "revision.bin"))).mode & 0o777).toBe(0o600);
    expect(events).toEqual([
      "stage-open",
      "stage-write",
      "stage-sync",
      "stage-close",
      "link",
      "final-verify",
      "directory-open",
      "directory-sync",
      "directory-close",
      "stage-unlink",
    ]);
    expect(await stageFiles(configured.outputs)).toEqual([]);
  });

  it("accepts genuine cross-realm bytes and copies them before its first await", async () => {
    const { configured, authority } = await setup();
    const prepared = await prepareCreateTarget(authority, { role: "outputs", path: "owned" });
    let releaseOpen: (() => void) | undefined;
    const opened = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const publisher = createAtomicPublicationTestOperations({
      beforeStageOpen: () => opened,
      stageName: () => ".particle-studio-stage-owned",
    });
    const source = runInNewContext("Uint8Array.of(4, 5, 6)") as Uint8Array;
    const publication = publisher.publishImmutableFile(authority, prepared, source);
    source.fill(9);
    releaseOpen!();
    await publication;
    expect(await readFile(join(configured.outputs, "owned"))).toEqual(Buffer.from([4, 5, 6]));
  });

  it("rejects incompatible, detached, forged, proxied, and hostile byte inputs", async () => {
    const { authority } = await setup();
    const prepared = await prepareCreateTarget(authority, { role: "outputs", path: "invalid" });
    const publisher = createAtomicPublicationTestOperations({
      stageName: () => ".particle-studio-stage-invalid",
    });
    const detached = Uint8Array.of(1);
    structuredClone(detached, { transfer: [detached.buffer] });
    const hostile = Object.defineProperty({}, Symbol.toStringTag, {
      get() { throw new Error("must not be read"); },
    });
    const invalid = [
      new Int8Array(1),
      new Uint16Array(1),
      new DataView(new ArrayBuffer(1)),
      new Uint8Array(new SharedArrayBuffer(1)),
      detached,
      { [Symbol.toStringTag]: "Uint8Array" },
      hostile,
      new Proxy(Uint8Array.of(1), {}),
    ];

    for (const bytes of invalid) {
      await expect(publisher.publishImmutableFile(authority, prepared, bytes)).rejects.toThrow(
        expectCode("PERSISTENCE_FS_PUBLICATION_BYTES_INVALID"),
      );
    }
  });

  it("does not replace an immutable collision and replaces pointers atomically", async () => {
    const { configured, authority } = await setup();
    const immutable = await prepareCreateTarget(authority, { role: "outputs", path: "immutable" });
    await writeFile(join(configured.outputs, "immutable"), "old");
    const collisionPublisher = createAtomicPublicationTestOperations({
      stageName: () => ".particle-studio-stage-collision",
    });

    await expect(
      collisionPublisher.publishImmutableFile(authority, immutable, Uint8Array.of(1)),
    ).rejects.toThrow(expectCode("PERSISTENCE_FS_PUBLICATION_ALREADY_EXISTS"));
    expect(await readFile(join(configured.outputs, "immutable"), "utf8")).toBe("old");
    expect(await stageFiles(configured.outputs)).toEqual([]);

    await writeFile(join(configured.outputs, "pointer"), "old-pointer");
    const pointer = await prepareReplaceableTarget(authority, { role: "outputs", path: "pointer" });
    await publishReplaceablePointer(authority, pointer, Uint8Array.of(7, 8));
    expect(await readFile(join(configured.outputs, "pointer"))).toEqual(Buffer.from([7, 8]));
  });

  it("rejects exclusive-stage collisions without touching a final target", async () => {
    const { configured, authority } = await setup();
    const prepared = await prepareCreateTarget(authority, { role: "outputs", path: "final" });
    await writeFile(join(configured.outputs, ".particle-studio-stage-clash"), "foreign");
    const publisher = createAtomicPublicationTestOperations({
      stageName: () => ".particle-studio-stage-clash",
    });

    await expect(
      publisher.publishImmutableFile(authority, prepared, Uint8Array.of(1)),
    ).rejects.toThrow(expectCode("PERSISTENCE_FS_PUBLICATION_STAGE_UNAVAILABLE"));
    await expect(readFile(join(configured.outputs, "final"))).rejects.toThrow();
    expect(await readFile(join(configured.outputs, ".particle-studio-stage-clash"), "utf8")).toBe("foreign");
  });

  it.each([
    ["write", "PERSISTENCE_FS_PUBLICATION_FAILED"],
    ["sync", "PERSISTENCE_FS_PUBLICATION_FAILED"],
    ["close", "PERSISTENCE_FS_PUBLICATION_FAILED"],
    ["link", "PERSISTENCE_FS_PUBLICATION_FAILED"],
    ["rename", "PERSISTENCE_FS_PUBLICATION_FAILED"],
  ] as const)("cleans its stage on pre-publication %s failure", async (boundary, code) => {
    const { configured, authority } = await setup();
    const immutable = await prepareCreateTarget(authority, { role: "outputs", path: `immutable-${boundary}` });
    const pointer = await prepareReplaceableTarget(authority, { role: "outputs", path: `pointer-${boundary}` });
    const publisher = createAtomicPublicationTestOperations({
      stageName: () => `.particle-studio-stage-${boundary}`,
      failAt: boundary,
    });
    const operation = boundary === "rename"
      ? publisher.publishReplaceablePointer(authority, pointer, Uint8Array.of(1))
      : publisher.publishImmutableFile(authority, immutable, Uint8Array.of(1));

    if (boundary === "rename") await writeFile(pointer.targetPath, "old-pointer");

    await expect(operation).rejects.toThrow(expectCode(code));
    expect(await stageFiles(configured.outputs)).toEqual([]);
    if (boundary === "rename") {
      expect(await readFile(pointer.targetPath, "utf8")).toBe("old-pointer");
    } else {
      await expect(readFile(immutable.targetPath)).rejects.toThrow();
    }
  });

  it.each(["final-verify", "directory-open", "directory-sync", "directory-close"] as const)(
    "reports durability uncertainty without rollback after %s failure",
    async (boundary) => {
      const { configured, authority } = await setup();
      const prepared = await prepareCreateTarget(authority, { role: "outputs", path: `final-${boundary}` });
      const publisher = createAtomicPublicationTestOperations({
        stageName: () => `.particle-studio-stage-${boundary}`,
        failAt: boundary,
      });

      await expect(
        publisher.publishImmutableFile(authority, prepared, Uint8Array.of(2)),
      ).rejects.toThrow(expectCode("PERSISTENCE_FS_PUBLICATION_DURABILITY_UNCERTAIN"));
      expect(await readFile(prepared.targetPath)).toEqual(Buffer.from([2]));
      expect(await stageFiles(configured.outputs)).toEqual([]);
    },
  );

  it("closes the underlying directory handle before injected close failure", async () => {
    const { authority } = await setup();
    const prepared = await prepareCreateTarget(authority, { role: "outputs", path: "directory-close" });
    let underlyingCloseCalls = 0;
    const publisher = createAtomicPublicationTestOperations({
      stageName: () => ".particle-studio-stage-directory-close",
      failAt: "directory-close",
      operations: {
        openDirectory: async () => ({
          write: async () => ({ bytesWritten: 0 }),
          sync: async () => {},
          close: async () => { underlyingCloseCalls += 1; },
        }),
      },
    });

    await expect(publisher.publishImmutableFile(authority, prepared, Uint8Array.of(1))).rejects.toThrow(
      expectCode("PERSISTENCE_FS_PUBLICATION_DURABILITY_UNCERTAIN"),
    );
    expect(underlyingCloseCalls).toBe(1);
  });

  it("preserves primary and late durability outcomes when stage cleanup unlink fails", async () => {
    const { configured, authority } = await setup();
    const cleanupFailure = async () => { throw new Error("injected cleanup unlink failure"); };
    const prePublication = createAtomicPublicationTestOperations({
      stageName: () => ".particle-studio-stage-cleanup-pre",
      failAt: "write",
      operations: { unlink: cleanupFailure },
    });
    const preTarget = await prepareCreateTarget(authority, { role: "outputs", path: "cleanup-pre" });
    await expect(prePublication.publishImmutableFile(authority, preTarget, Uint8Array.of(1))).rejects.toThrow(
      expectCode("PERSISTENCE_FS_PUBLICATION_FAILED"),
    );
    expect(await stageFiles(configured.outputs)).toEqual([".particle-studio-stage-cleanup-pre"]);

    const postPublication = createAtomicPublicationTestOperations({
      stageName: () => ".particle-studio-stage-cleanup-post",
      failAt: "directory-sync",
      operations: { unlink: cleanupFailure },
    });
    const postTarget = await prepareCreateTarget(authority, { role: "outputs", path: "cleanup-post" });
    await expect(postPublication.publishImmutableFile(authority, postTarget, Uint8Array.of(2))).rejects.toThrow(
      expectCode("PERSISTENCE_FS_PUBLICATION_DURABILITY_UNCERTAIN"),
    );
    expect(await readFile(postTarget.targetPath)).toEqual(Buffer.from([2]));
    expect(await stageFiles(configured.outputs)).toEqual([
      ".particle-studio-stage-cleanup-post",
      ".particle-studio-stage-cleanup-pre",
    ]);
  });

  it("writes short writes completely and closes handles during a pointer replacement", async () => {
    const { authority } = await setup();
    const pointer = await prepareReplaceableTarget(authority, { role: "outputs", path: "short" });
    const events: string[] = [];
    const publisher = createAtomicPublicationTestOperations({
      stageName: () => ".particle-studio-stage-short",
      maxWrite: 1,
      observe: (event) => events.push(event),
    });

    await publisher.publishReplaceablePointer(authority, pointer, Uint8Array.of(1, 2, 3));

    expect(await readFile(pointer.targetPath)).toEqual(Buffer.from([1, 2, 3]));
    expect(events.filter((event) => event === "stage-write")).toHaveLength(3);
    expect(events).toContain("stage-close");
    expect(events).toContain("directory-close");
  });
});
