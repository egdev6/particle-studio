import { open, link, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { isUint8Array } from "node:util/types";
import { RootConfinementError, type RootConfinement, type ResolvedPath } from "./confinement-contracts.js";

export interface PreparedPublicationTarget {
  readonly role: "workspace" | "documents" | "outputs";
  readonly parentPath: string;
  readonly leafName: string;
  readonly targetPath: string;
}

interface WritableHandle {
  write(
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicPublicationOperations {
  readonly openStage: (path: string) => Promise<WritableHandle>;
  readonly link: (existingPath: string, newPath: string) => Promise<void>;
  readonly rename: (oldPath: string, newPath: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
  readonly openDirectory: (path: string) => Promise<WritableHandle>;
}

export interface AtomicPublicationTestConfiguration {
  readonly stageName?: () => string;
  readonly observe?: (event: string) => void;
  readonly beforeStageOpen?: () => Promise<void>;
  readonly maxWrite?: number;
  readonly failAt?:
    | "write"
    | "sync"
    | "close"
    | "link"
    | "rename"
    | "final-verify"
    | "directory-open"
    | "directory-sync"
    | "directory-close";
  readonly operations?: Partial<AtomicPublicationOperations>;
}

type TargetValidator<T> = (authority: RootConfinement, prepared: T) => PreparedPublicationTarget;
type FinalVerifier<T> = (authority: RootConfinement, prepared: T) => Promise<ResolvedPath>;

const defaultOperations: AtomicPublicationOperations = {
  openStage: async (path) => open(path, "wx", 0o600),
  link,
  rename,
  unlink,
  openDirectory: async (path) => open(path, "r"),
};

let testConfiguration: AtomicPublicationTestConfiguration | undefined;

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const arrayBufferSlice = ArrayBuffer.prototype.slice;
const uint8ArraySet = Uint8Array.prototype.set;

/** This is intentionally reachable only through a relative test-only module. */
export function setAtomicPublicationTestConfiguration(
  configuration: AtomicPublicationTestConfiguration | undefined,
): void {
  testConfiguration = configuration;
}

function publicationError(
  code:
    | "PERSISTENCE_FS_PUBLICATION_BYTES_INVALID"
    | "PERSISTENCE_FS_PUBLICATION_STAGE_UNAVAILABLE"
    | "PERSISTENCE_FS_PUBLICATION_ALREADY_EXISTS"
    | "PERSISTENCE_FS_PUBLICATION_FAILED"
    | "PERSISTENCE_FS_PUBLICATION_DURABILITY_UNCERTAIN",
): RootConfinementError {
  return new RootConfinementError(code);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function ownBytes(value: unknown): Uint8Array {
  try {
    if (!isUint8Array(value)) throw new TypeError();
    const backing = typedArrayBuffer.call(value);
    arrayBufferSlice.call(backing, 0, 0);
    const copy = new Uint8Array(typedArrayByteLength.call(value));
    uint8ArraySet.call(copy, value);
    return copy;
  } catch {
    throw publicationError("PERSISTENCE_FS_PUBLICATION_BYTES_INVALID");
  }
}

function stageName(): string {
  return testConfiguration?.stageName?.() ?? `.particle-studio-stage-${randomBytes(18).toString("hex")}`;
}

function operations(): AtomicPublicationOperations {
  const configured = testConfiguration;
  const base = { ...defaultOperations, ...configured?.operations };
  const observe = configured?.observe;
  const fail = (boundary: AtomicPublicationTestConfiguration["failAt"]) => {
    if (configured?.failAt === boundary) throw new Error(`injected ${boundary} failure`);
  };
  return {
    openStage: async (path) => {
      await configured?.beforeStageOpen?.();
      observe?.("stage-open");
      return base.openStage(path);
    },
    link: async (existingPath, newPath) => {
      observe?.("link");
      fail("link");
      return base.link(existingPath, newPath);
    },
    rename: async (oldPath, newPath) => {
      observe?.("rename");
      fail("rename");
      return base.rename(oldPath, newPath);
    },
    unlink: async (path) => {
      observe?.("stage-unlink");
      return base.unlink(path);
    },
    openDirectory: async (path) => {
      observe?.("directory-open");
      fail("directory-open");
      const handle = await base.openDirectory(path);
      let closed = false;
      return {
        write: handle.write.bind(handle),
        sync: async () => {
          observe?.("directory-sync");
          fail("directory-sync");
          await handle.sync();
        },
        close: async () => {
          if (!closed) {
            closed = true;
            await handle.close();
          }
          observe?.("directory-close");
          fail("directory-close");
        },
      };
    },
  };
}

async function closeQuietly(handle: WritableHandle | undefined): Promise<void> {
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch {
      // A primary publication error remains authoritative; cleanup is best effort.
    }
  }
}

async function unlinkQuietly(fs: AtomicPublicationOperations, path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch {
    // The stage is owned but cleanup cannot obscure the primary outcome.
  }
}

export function createAtomicPublisher<T>(dependencies: {
  readonly validate: TargetValidator<T>;
  readonly verifyFinal: FinalVerifier<T>;
}) {
  return async function publish(
    authority: RootConfinement,
    prepared: T,
    bytes: unknown,
    replace: boolean,
  ): Promise<ResolvedPath> {
    const owned = ownBytes(bytes);
    const target = dependencies.validate(authority, prepared);
    const fs = operations();
    const temporaryPath = join(target.parentPath, stageName());
    let stage: WritableHandle | undefined;
    let stageOwned = false;
    let published = false;

    try {
      try {
        stage = await fs.openStage(temporaryPath);
        stageOwned = true;
      } catch {
        throw publicationError("PERSISTENCE_FS_PUBLICATION_STAGE_UNAVAILABLE");
      }
      let offset = 0;
      while (offset < owned.length) {
        const maximum = testConfiguration?.maxWrite;
        const length = maximum === undefined ? owned.length - offset : Math.min(maximum, owned.length - offset);
        testConfiguration?.observe?.("stage-write");
        if (testConfiguration?.failAt === "write") throw new Error("injected write failure");
        const result = await stage.write(owned, offset, length, null);
        if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0 || result.bytesWritten > length) {
          throw new Error("invalid short write");
        }
        offset += result.bytesWritten;
      }
      testConfiguration?.observe?.("stage-sync");
      if (testConfiguration?.failAt === "sync") throw new Error("injected sync failure");
      await stage.sync();
      testConfiguration?.observe?.("stage-close");
      if (testConfiguration?.failAt === "close") throw new Error("injected close failure");
      await stage.close();
      stage = undefined;

      if (replace) await fs.rename(temporaryPath, target.targetPath);
      else {
        try {
          await fs.link(temporaryPath, target.targetPath);
        } catch (error) {
          if (isNodeError(error, "EEXIST")) {
            throw publicationError("PERSISTENCE_FS_PUBLICATION_ALREADY_EXISTS");
          }
          throw error;
        }
      }
      published = true;

      testConfiguration?.observe?.("final-verify");
      if (testConfiguration?.failAt === "final-verify") throw new Error("injected final verification failure");
      const resolved = await dependencies.verifyFinal(authority, prepared);
      let directory: WritableHandle | undefined;
      try {
        directory = await fs.openDirectory(target.parentPath);
        await directory.sync();
        await directory.close();
        directory = undefined;
      } finally {
        await closeQuietly(directory);
      }
      await unlinkQuietly(fs, temporaryPath);
      return resolved;
    } catch (error) {
      await closeQuietly(stage);
      if (stageOwned) await unlinkQuietly(fs, temporaryPath);
      if (published) {
        throw publicationError("PERSISTENCE_FS_PUBLICATION_DURABILITY_UNCERTAIN");
      }
      if (error instanceof RootConfinementError) throw error;
      throw publicationError("PERSISTENCE_FS_PUBLICATION_FAILED");
    }
  };
}
