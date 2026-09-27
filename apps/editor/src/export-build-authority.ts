import {
  buildApprovedSelfContainedHtmlVirtualMap,
  type ApprovedSelfContainedHtmlVirtualExport,
  type PortableIifeBundle,
  type PortableSelfContainedRuntimeProvider,
} from "@particle-studio/export";

import type { AssetPersistencePort } from "@particle-studio/persistence";

declare const __PARTICLE_STUDIO_SELF_CONTAINED_RUNTIME_SOURCE__: string;

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", copy.buffer),
  );
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Wraps editor-build-time runtime source as a no-input authority. Approval data
 * never reaches this provider, so it cannot specialize bytes per snapshot.
 */
export function createEditorSelfContainedRuntimeProvider(
  runtimeSource: string,
): PortableSelfContainedRuntimeProvider {
  const stableBytes = new TextEncoder().encode(runtimeSource);
  return {
    async provide(): Promise<PortableIifeBundle> {
      const bytes = stableBytes.slice();
      return {
        path: "particle-studio.iife.js",
        bytes,
        sha256: await sha256(bytes),
        globalName: "ParticleStudio",
      };
    },
  };
}

export interface BuildEditorApprovedSelfContainedHtmlInput {
  readonly approval: unknown;
  readonly assets: Pick<AssetPersistencePort, "readAsset">;
}

/** Equivalent production seam for a fixed, no-input precompiled authority. */
export function createEditorApprovedSelfContainedHtmlBuilder(
  selfContainedRuntimeProvider: PortableSelfContainedRuntimeProvider,
): (
  input: BuildEditorApprovedSelfContainedHtmlInput,
) => Promise<ApprovedSelfContainedHtmlVirtualExport> {
  return (input) =>
    buildApprovedSelfContainedHtmlVirtualMap({
      ...input,
      selfContainedRuntimeProvider,
    });
}

/** Production editor seam for the accepted one-file delivery exporter. */
export function buildEditorApprovedSelfContainedHtml(
  input: BuildEditorApprovedSelfContainedHtmlInput,
): Promise<ApprovedSelfContainedHtmlVirtualExport> {
  return createEditorApprovedSelfContainedHtmlBuilder(
    createEditorSelfContainedRuntimeProvider(
      __PARTICLE_STUDIO_SELF_CONTAINED_RUNTIME_SOURCE__,
    ),
  )(input);
}
