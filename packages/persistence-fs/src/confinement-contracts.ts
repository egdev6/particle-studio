import { isAbsolute, posix, relative, sep, win32 } from "node:path";

/**
 * Internal confinement contracts shared by the root entry and the atomic
 * publication layer. This module exists so the root entry never has to
 * re-export or import back from the publication modules: authority state and
 * the public error type live here, and both consumers import downward.
 */

export type RootRole = "workspace" | "documents" | "outputs";

export type RootConfinementErrorCode =
  | "PERSISTENCE_FS_AUTHORITY_INVALID"
  | "PERSISTENCE_FS_ROOT_INVALID"
  | "PERSISTENCE_FS_ROOT_UNAVAILABLE"
  | "PERSISTENCE_FS_ROOT_NOT_DIRECTORY"
  | "PERSISTENCE_FS_ROOT_OVERLAP"
  | "PERSISTENCE_FS_ROLE_INVALID"
  | "PERSISTENCE_FS_OPERATION_PATH_INVALID"
  | "PERSISTENCE_FS_EXISTING_PATH_UNAVAILABLE"
  | "PERSISTENCE_FS_EXISTING_PATH_OUTSIDE_ROLE"
  | "PERSISTENCE_FS_CREATE_TARGET_EXISTS"
  | "PERSISTENCE_FS_CREATE_TARGET_UNAVAILABLE"
  | "PERSISTENCE_FS_CREATE_PARENT_UNAVAILABLE"
  | "PERSISTENCE_FS_CREATE_PARENT_NOT_DIRECTORY"
  | "PERSISTENCE_FS_CREATE_TARGET_OUTSIDE_ROLE"
  | "PERSISTENCE_FS_PREPARED_TARGET_INVALID"
  | "PERSISTENCE_FS_CREATED_TARGET_UNAVAILABLE"
  | "PERSISTENCE_FS_CREATED_TARGET_OUTSIDE_ROLE"
  | "PERSISTENCE_FS_REPLACE_TARGET_UNAVAILABLE"
  | "PERSISTENCE_FS_REPLACE_TARGET_NOT_REGULAR"
  | "PERSISTENCE_FS_REPLACE_TARGET_OUTSIDE_ROLE"
  | "PERSISTENCE_FS_PUBLICATION_BYTES_INVALID"
  | "PERSISTENCE_FS_PUBLICATION_STAGE_UNAVAILABLE"
  | "PERSISTENCE_FS_PUBLICATION_ALREADY_EXISTS"
  | "PERSISTENCE_FS_PUBLICATION_FAILED"
  | "PERSISTENCE_FS_PUBLICATION_DURABILITY_UNCERTAIN"
  | "PERSISTENCE_FS_DIRECTORY_UNAVAILABLE"
  | "PERSISTENCE_FS_DIRECTORY_NOT_DIRECTORY"
  | "PERSISTENCE_FS_DIRECTORY_OUTSIDE_ROLE";

export class RootConfinementError extends Error {
  readonly name = "RootConfinementError";

  constructor(readonly code: RootConfinementErrorCode) {
    super(code);
  }
}

export interface RootRelativePath {
  readonly role: RootRole;
  readonly path: string;
}

export interface ResolvedPath {
  readonly role: RootRole;
  readonly path: string;
}

/** An opaque authority usable only by the narrow helpers in this package. */
export interface RootConfinement {
  readonly __rootConfinement?: never;
}

export type CanonicalRoots = Readonly<Record<RootRole, string>>;

export const confinementRoots = new WeakMap<object, CanonicalRoots>();

export const roles: readonly RootRole[] = ["workspace", "documents", "outputs"];

export const dosDeviceComponent = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export function fail(code: RootConfinementErrorCode): never {
  throw new RootConfinementError(code);
}

export function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function isRole(value: unknown): value is RootRole {
  return value === "workspace" || value === "documents" || value === "outputs";
}

export function isNativeAbsoluteDirectoryPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    isAbsolute(value)
  );
}

export function isContained(root: string, target: string, allowRoot = false): boolean {
  const difference = relative(root, target);
  if (difference === "") return allowRoot;
  return (
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

export function requireOperationPath(value: unknown): readonly string[] {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("PERSISTENCE_FS_OPERATION_PATH_INVALID");
  }
  if (
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    posix.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    fail("PERSISTENCE_FS_OPERATION_PATH_INVALID");
  }
  const parts = value.split(/[\\/]/u);
  if (
    parts.length === 0 ||
    parts.some(
      (part) =>
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        part.includes(":") ||
        part.endsWith(".") ||
        part.endsWith(" ") ||
        dosDeviceComponent.test(part),
    )
  ) {
    fail("PERSISTENCE_FS_OPERATION_PATH_INVALID");
  }
  return parts;
}

export function getAuthority(authority: RootConfinement): CanonicalRoots {
  if (authority === null || typeof authority !== "object") {
    fail("PERSISTENCE_FS_AUTHORITY_INVALID");
  }
  const roots = confinementRoots.get(authority);
  if (roots === undefined) fail("PERSISTENCE_FS_AUTHORITY_INVALID");
  return roots;
}

export function getRoleAndPath(
  authority: RootConfinement,
  input: RootRelativePath,
): { readonly root: string; readonly role: RootRole; readonly parts: readonly string[] } {
  const roots = getAuthority(authority);
  if (input === null || typeof input !== "object" || !isRole(input.role)) {
    fail("PERSISTENCE_FS_ROLE_INVALID");
  }
  return {
    root: roots[input.role],
    role: input.role,
    parts: requireOperationPath(input.path),
  };
}

/** Check, without exposing roots, that the value was issued by createRootConfinement. */
export function hasRootConfinementAuthority(authority: unknown): boolean {
  return (
    typeof authority === "object" &&
    authority !== null &&
    confinementRoots.has(authority)
  );
}
