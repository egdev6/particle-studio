import { lstat, realpath, stat } from "node:fs/promises";
import { createAtomicPublisher } from "./atomic-publication.js";
import {
  confinementRoots,
  fail,
  getAuthority,
  getRoleAndPath,
  isContained,
  isNativeAbsoluteDirectoryPath,
  isNodeError,
  RootConfinementError,
  roles,
  type CanonicalRoots,
  type RootConfinement,
  type RootRelativePath,
  type ResolvedPath,
  type RootRole,
} from "./confinement-contracts.js";
import { dirname, join, resolve } from "node:path";

export { RootConfinementError };
export type {
  RootConfinement,
  RootConfinementErrorCode,
  RootRelativePath,
  ResolvedPath,
  RootRole,
} from "./confinement-contracts.js";

export interface RootConfinementOptions {
  readonly workspace: unknown;
  readonly documents: unknown;
  readonly outputs: unknown;
}

export interface PreparedCreateTarget {
  readonly role: RootRole;
  readonly parentPath: string;
  readonly leafName: string;
  readonly targetPath: string;
}

/** An opaque authority for atomic replacement of a regular pointer leaf. */
export interface PreparedReplaceableTarget {
  readonly role: RootRole;
  readonly parentPath: string;
  readonly leafName: string;
  readonly targetPath: string;
}

type PreparedTargetState = Readonly<{
  authority: RootConfinement;
  role: RootRole;
  parentPath: string;
  leafName: string;
  targetPath: string;
}>;

const preparedTargets = new WeakMap<object, PreparedTargetState>();

async function canonicalRoot(value: unknown): Promise<string> {
  if (!isNativeAbsoluteDirectoryPath(value)) {
    fail("PERSISTENCE_FS_ROOT_INVALID");
  }
  let canonical: string;
  try {
    canonical = await realpath(value);
  } catch {
    fail("PERSISTENCE_FS_ROOT_UNAVAILABLE");
  }
  let details;
  try {
    details = await stat(canonical);
  } catch {
    fail("PERSISTENCE_FS_ROOT_UNAVAILABLE");
  }
  if (!details.isDirectory()) fail("PERSISTENCE_FS_ROOT_NOT_DIRECTORY");
  return canonical;
}

/**
 * Canonicalize startup roots and deny any equality or ancestor relationship.
 */
export async function createRootConfinement(
  options: RootConfinementOptions,
): Promise<RootConfinement> {
  if (options === null || typeof options !== "object") {
    fail("PERSISTENCE_FS_ROOT_INVALID");
  }
  const [workspace, documents, outputs] = await Promise.all([
    canonicalRoot(options.workspace),
    canonicalRoot(options.documents),
    canonicalRoot(options.outputs),
  ]);
  const roots: CanonicalRoots = Object.freeze({
    workspace,
    documents,
    outputs,
  });
  for (let outer = 0; outer < roles.length; outer += 1) {
    const first = roots[roles[outer]!];
    for (let inner = outer + 1; inner < roles.length; inner += 1) {
      const second = roots[roles[inner]!];
      if (
        isContained(first, second, true) ||
        isContained(second, first, true)
      ) {
        fail("PERSISTENCE_FS_ROOT_OVERLAP");
      }
    }
  }
  const authority: RootConfinement = Object.freeze({});
  confinementRoots.set(authority, roots);
  return authority;
}

/** Resolve an existing path and reassert canonical containment in its role. */
export async function resolveExistingPath(
  authority: RootConfinement,
  input: RootRelativePath,
): Promise<ResolvedPath> {
  const { root, role, parts } = getRoleAndPath(authority, input);
  const candidate = resolve(root, ...parts);
  if (!isContained(root, candidate)) {
    fail("PERSISTENCE_FS_OPERATION_PATH_INVALID");
  }
  let canonical: string;
  try {
    await stat(candidate);
    canonical = await realpath(candidate);
    await stat(canonical);
  } catch {
    fail("PERSISTENCE_FS_EXISTING_PATH_UNAVAILABLE");
  }
  if (!isContained(root, canonical)) {
    fail("PERSISTENCE_FS_EXISTING_PATH_OUTSIDE_ROLE");
  }
  return Object.freeze({ role, path: canonical });
}

async function ensureLeafAbsent(targetPath: string): Promise<void> {
  try {
    await lstat(targetPath);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    fail("PERSISTENCE_FS_CREATE_TARGET_UNAVAILABLE");
  }
  fail("PERSISTENCE_FS_CREATE_TARGET_EXISTS");
}

/**
 * Verify an existing canonical parent and reserve no filesystem state. Later
 * writers must use the returned targetPath and call verifyCreatedTarget.
 */
export async function prepareCreateTarget(
  authority: RootConfinement,
  input: RootRelativePath,
): Promise<PreparedCreateTarget> {
  const { root, role, parts } = getRoleAndPath(authority, input);
  const lexicalTarget = resolve(root, ...parts);
  if (!isContained(root, lexicalTarget)) {
    fail("PERSISTENCE_FS_OPERATION_PATH_INVALID");
  }
  let canonicalParent: string;
  let details;
  try {
    canonicalParent = await realpath(dirname(lexicalTarget));
    details = await stat(canonicalParent);
  } catch {
    fail("PERSISTENCE_FS_CREATE_PARENT_UNAVAILABLE");
  }
  if (!details.isDirectory())
    fail("PERSISTENCE_FS_CREATE_PARENT_NOT_DIRECTORY");
  if (!isContained(root, canonicalParent, true)) {
    fail("PERSISTENCE_FS_CREATE_TARGET_OUTSIDE_ROLE");
  }
  await ensureLeafAbsent(lexicalTarget);

  const leafName = parts[parts.length - 1]!;
  const targetPath = join(canonicalParent, leafName);
  const prepared: PreparedCreateTarget = Object.freeze({
    role,
    parentPath: canonicalParent,
    leafName,
    targetPath,
  });
  preparedTargets.set(prepared, Object.freeze({ authority, ...prepared }));
  return prepared;
}

function getPreparedTarget(
  authority: RootConfinement,
  prepared: PreparedCreateTarget | PreparedReplaceableTarget,
): PreparedTargetState {
  getAuthority(authority);
  if (prepared === null || typeof prepared !== "object") {
    fail("PERSISTENCE_FS_PREPARED_TARGET_INVALID");
  }
  const state = preparedTargets.get(prepared);
  if (state === undefined || state.authority !== authority) {
    fail("PERSISTENCE_FS_PREPARED_TARGET_INVALID");
  }
  return state;
}

/**
 * Recheck a target after creation. This stable-pathname check intentionally
 * does not claim protection from concurrent namespace swaps, hard links, or
 * mount indirection controlled by the same user.
 */
async function verifyPublishedTarget(
  authority: RootConfinement,
  prepared: PreparedCreateTarget | PreparedReplaceableTarget,
): Promise<ResolvedPath> {
  const state = getPreparedTarget(authority, prepared);
  const roots = getAuthority(authority);
  let canonical: string;
  try {
    canonical = await realpath(state.targetPath);
    await stat(canonical);
  } catch {
    fail("PERSISTENCE_FS_CREATED_TARGET_UNAVAILABLE");
  }
  if (!isContained(roots[state.role], canonical)) {
    fail("PERSISTENCE_FS_CREATED_TARGET_OUTSIDE_ROLE");
  }
  return Object.freeze({ role: state.role, path: canonical });
}

export async function verifyCreatedTarget(
  authority: RootConfinement,
  prepared: PreparedCreateTarget,
): Promise<ResolvedPath> {
  return verifyPublishedTarget(authority, prepared);
}

/**
 * Prepare an absent or regular existing leaf for atomic pointer replacement.
 * Symlinks and non-files are denied rather than followed or overwritten.
 */
export async function prepareReplaceableTarget(
  authority: RootConfinement,
  input: RootRelativePath,
): Promise<PreparedReplaceableTarget> {
  const { root, role, parts } = getRoleAndPath(authority, input);
  const lexicalTarget = resolve(root, ...parts);
  if (!isContained(root, lexicalTarget))
    fail("PERSISTENCE_FS_OPERATION_PATH_INVALID");
  let canonicalParent: string;
  let parentDetails;
  try {
    canonicalParent = await realpath(dirname(lexicalTarget));
    parentDetails = await stat(canonicalParent);
  } catch {
    fail("PERSISTENCE_FS_CREATE_PARENT_UNAVAILABLE");
  }
  if (!parentDetails.isDirectory())
    fail("PERSISTENCE_FS_CREATE_PARENT_NOT_DIRECTORY");
  if (!isContained(root, canonicalParent, true)) {
    fail("PERSISTENCE_FS_REPLACE_TARGET_OUTSIDE_ROLE");
  }
  try {
    const details = await lstat(lexicalTarget);
    if (!details.isFile() || details.isSymbolicLink()) {
      fail("PERSISTENCE_FS_REPLACE_TARGET_NOT_REGULAR");
    }
    const canonical = await realpath(lexicalTarget);
    const canonicalDetails = await stat(canonical);
    if (!canonicalDetails.isFile())
      fail("PERSISTENCE_FS_REPLACE_TARGET_NOT_REGULAR");
    if (!isContained(root, canonical))
      fail("PERSISTENCE_FS_REPLACE_TARGET_OUTSIDE_ROLE");
  } catch (error) {
    if (error instanceof RootConfinementError) throw error;
    if (!isNodeError(error, "ENOENT"))
      fail("PERSISTENCE_FS_REPLACE_TARGET_UNAVAILABLE");
  }
  const leafName = parts[parts.length - 1]!;
  const prepared: PreparedReplaceableTarget = Object.freeze({
    role,
    parentPath: canonicalParent,
    leafName,
    targetPath: join(canonicalParent, leafName),
  });
  preparedTargets.set(prepared, Object.freeze({ authority, ...prepared }));
  return prepared;
}

const publishImmutable = createAtomicPublisher<PreparedCreateTarget>({
  validate: getPreparedTarget,
  verifyFinal: verifyPublishedTarget,
});
const publishPointer = createAtomicPublisher<PreparedReplaceableTarget>({
  validate: getPreparedTarget,
  verifyFinal: verifyPublishedTarget,
});

/** Publish bytes without ever replacing a pre-existing final leaf. */
export async function publishImmutableFile(
  authority: RootConfinement,
  prepared: PreparedCreateTarget,
  bytes: unknown,
): Promise<ResolvedPath> {
  return publishImmutable(authority, prepared, bytes, false);
}

/** Atomically create or replace a prepared regular pointer leaf. */
export async function publishReplaceablePointer(
  authority: RootConfinement,
  prepared: PreparedReplaceableTarget,
  bytes: unknown,
): Promise<ResolvedPath> {
  return publishPointer(authority, prepared, bytes, true);
}
