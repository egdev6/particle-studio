import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  fail,
  getRoleAndPath,
  isContained,
  isNodeError,
  type RootConfinement,
  type RootRelativePath,
} from "./confinement-contracts.js";

/**
 * Internal generic confinement filesystem helpers. These deliberately stay out
 * of the package root export surface: revision persistence is their only
 * consumer, reached through the revision-persistence subpath.
 */

export type ConfinementFileSnapshot =
  | { readonly kind: "absent" }
  | { readonly kind: "regular"; readonly bytes: Uint8Array }
  | { readonly kind: "oversize"; readonly byteLength: number }
  | { readonly kind: "symlink" }
  | { readonly kind: "outside-role" }
  | { readonly kind: "other" };

/**
 * Provision exactly one directory level (recursive mkdir is denied) with mode
 * 0700, or verify an existing entry as a real directory. Containment is
 * reverified through realpath after the syscall.
 */
export async function ensureConfinementDirectory(
  authority: RootConfinement,
  input: RootRelativePath,
): Promise<void> {
  const { root, parts } = getRoleAndPath(authority, input);
  const target = resolve(root, ...parts);
  if (!isContained(root, target)) {
    fail("PERSISTENCE_FS_OPERATION_PATH_INVALID");
  }
  try {
    await mkdir(target, { recursive: false, mode: 0o700 });
  } catch (error: unknown) {
    if (!isNodeError(error, "EEXIST")) {
      fail("PERSISTENCE_FS_DIRECTORY_UNAVAILABLE");
    }
  }
  let details;
  let canonical: string;
  try {
    details = await lstat(target);
    canonical = await realpath(target);
  } catch {
    fail("PERSISTENCE_FS_DIRECTORY_UNAVAILABLE");
  }
  if (details.isSymbolicLink() || !details.isDirectory()) {
    fail("PERSISTENCE_FS_DIRECTORY_NOT_DIRECTORY");
  }
  if (!isContained(root, canonical, true)) {
    fail("PERSISTENCE_FS_DIRECTORY_OUTSIDE_ROLE");
  }
}

/**
 * Inspect one regular file without ever following a symlink at the final
 * component, refuse to read beyond maxBytes, and reverify containment of the
 * canonical path before reading. Absence is reported, not thrown.
 */
export async function inspectConfinementFile(
  authority: RootConfinement,
  input: RootRelativePath,
  maxBytes: number,
): Promise<ConfinementFileSnapshot> {
  const { root, parts } = getRoleAndPath(authority, input);
  const target = resolve(root, ...parts);
  if (!isContained(root, target)) {
    fail("PERSISTENCE_FS_OPERATION_PATH_INVALID");
  }
  let details;
  try {
    details = await lstat(target);
  } catch (error: unknown) {
    return isNodeError(error, "ENOENT") ? { kind: "absent" } : { kind: "other" };
  }
  if (details.isSymbolicLink()) return { kind: "symlink" };
  if (!details.isFile()) return { kind: "other" };
  if (details.size > maxBytes) {
    return { kind: "oversize", byteLength: details.size };
  }
  let canonical: string;
  try {
    canonical = await realpath(target);
  } catch {
    return { kind: "other" };
  }
  if (!isContained(root, canonical)) {
    return { kind: "outside-role" };
  }
  try {
    const bytes = await readFile(canonical);
    return { kind: "regular", bytes: new Uint8Array(bytes) };
  } catch {
    return { kind: "other" };
  }
}
