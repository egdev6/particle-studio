/**
 * Node-only canonical hashing for the frozen reference fixture.
 *
 * This module deliberately stays out of every browser bundle. The browser
 * performance harness hashes the same scene-document canonical bytes through
 * Web Crypto instead, and the pinned SHA-256 binds both paths to one fixture
 * identity.
 */

import { canonicalizeSceneDocument } from "@particle-studio/scene-document";

import { createReferenceFixture } from "./reference-fixture.js";

// apps/editor/tsconfig.json restricts "types" to vitest/globals, so @types/node
// is not part of this program and "node:*" module specifiers do not resolve
// (same constraint the fixture module documented before the R1b split).
// process.getBuiltinModule reaches the same Node built-ins at runtime without
// changing the editor compiler options.
type NodeCryptoModule = {
  createHash(algorithm: "sha256"): {
    update(bytes: Uint8Array): { digest(encoding: "hex"): string };
  };
};
// SAFETY: this Node-only module never loads in a browser; Node 24 exposes
// process.getBuiltinModule. The required crypto surface is restated here
// because the compiler options exclude @types/node.
const nodeCrypto = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: "node:crypto"): NodeCryptoModule };
  }
).process.getBuiltinModule("node:crypto");

/**
 * Returns the lowercase SHA-256 hex digest of the fixture's scene-document
 * canonical bytes (JCS via the scene-document canonicalization plus
 * node:crypto). Pure Node work only: no DOM, no browser globals, no timers.
 */
export function referenceFixtureCanonicalHash(): string {
  const { bytes } = canonicalizeSceneDocument(createReferenceFixture());
  return nodeCrypto.createHash("sha256").update(bytes).digest("hex");
}
