import { createHash } from "node:crypto";

/**
 * Internal confinement layout primitives shared by every private-namespace
 * persistence family (revisions, pointers, assets). These deliberately stay
 * out of the package root export surface; consumers reach them through their
 * own persistence subpath modules.
 */

export const layoutNamespace = "particle-studio:persistence-fs:v1";
export const privateRootDirectory = "particle-studio-persistence-v1";

/**
 * Domain-separated SHA-256 hex path segments. Caller-controlled identifiers
 * never reach the filesystem: only fixed names and full-length hex digests do.
 */
export function domainSegment(domain: string, parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(layoutNamespace, "utf8");
  hash.update("\0", "utf8");
  hash.update(domain, "utf8");
  for (const part of parts) {
    hash.update("\0", "utf8");
    hash.update(part, "utf8");
  }
  return hash.digest("hex");
}

export function documentSegmentFor(documentId: string): string {
  return domainSegment("document-id", [documentId]);
}
