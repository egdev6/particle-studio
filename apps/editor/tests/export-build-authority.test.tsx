// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  buildEditorApprovedSelfContainedHtml,
  createEditorApprovedSelfContainedHtmlBuilder,
  createEditorSelfContainedRuntimeProvider,
} from "../src/export-build-authority.js";

import type { ApprovalRecord } from "@particle-studio/persistence";

const {
  FIRST_SLICE_DOCUMENT,
  createApprovalEnvelope,
  readCanonicalApprovalEvidence,
} = await import("@particle-studio/scene-document");
const { createApprovalRecord } = await import("@particle-studio/persistence");
const { RUNTIME_VERSION } = await import("@particle-studio/runtime");

async function approvedFixture(): Promise<ApprovalRecord> {
  const envelope = await createApprovalEnvelope({
    document: structuredClone(FIRST_SLICE_DOCUMENT),
    runtimeVersion: RUNTIME_VERSION,
    verifiedAssetManifest: [],
  });
  const evidence = readCanonicalApprovalEvidence(envelope);
  return createApprovalRecord({
    documentId: "editor-export-document",
    revisionId: "editor-export-revision",
    approvalEnvelope: envelope,
    snapshotHash: evidence.snapshotHash,
    approvalEnvelopeBytes: evidence.approvalEnvelopeBytes,
    canonicalDocumentBytes: evidence.canonicalDocumentBytes,
    verifiedAssetManifest: evidence.verifiedAssetManifest,
    audit: { approvedAt: 1, actorLabel: "local-human" },
  });
}

describe("editor self-contained export build authority", () => {
  it("uses Vite's fixed precompiled runtime through the production export function", async () => {
    const approval = await approvedFixture();
    const exported = await buildEditorApprovedSelfContainedHtml({
      approval,
      assets: { readAsset: async () => Promise.reject(new Error("unused")) },
    });

    const html = new TextDecoder().decode(
      exported.files.get("particle-studio.html")!,
    );
    const runtimeUrl = html.match(/<script src="([^"]+)"><\/script>/)?.[1];
    const boundEnvelope = html.match(
      /<script id="particle-studio-approved-envelope" type="application\/json">([^<]+)<\/script>/,
    )?.[1];

    expect(exported.files.paths).toEqual(["particle-studio.html"]);
    expect(exported.manifest.snapshotHash).toBe(approval.snapshotHash);
    expect(JSON.parse(boundEnvelope!)).toEqual({
      snapshotHash: approval.snapshotHash,
      envelope: JSON.parse(
        new TextDecoder().decode(approval.approvalEnvelopeBytes),
      ),
    });
    expect(runtimeUrl).toBe(
      "data:text/javascript;charset=utf-8;base64,Z2xvYmFsVGhpcy5QYXJ0aWNsZVN0dWRpbyA9IE9iamVjdC5mcmVlemUoeyBtb3VudCgpIHsgcmV0dXJuIE9iamVjdC5mcmVlemUoeyByZWFkeTogUHJvbWlzZS5yZXNvbHZlKCksIHJlbmRlckF0KCkge30sIGRlc3Ryb3koKSB7fSB9KTsgfSB9KTsK",
    );
  });

  it("uses the fixed precompiled runtime through the production-equivalent exporter seam", async () => {
    const precompiledRuntime =
      "globalThis.ParticleStudio = Object.freeze({ mount() { return Object.freeze({ ready: Promise.resolve(), renderAt() {}, destroy() {} }); } });\n";
    const provider =
      createEditorSelfContainedRuntimeProvider(precompiledRuntime);
    const build = createEditorApprovedSelfContainedHtmlBuilder(provider);
    const exported = await build({
      approval: await approvedFixture(),
      assets: { readAsset: async () => Promise.reject(new Error("unused")) },
    });

    const html = new TextDecoder().decode(
      exported.files.get("particle-studio.html")!,
    );
    expect(exported.files.paths).toEqual(["particle-studio.html"]);
    expect(html).toContain("particle-studio-approved-envelope");
    expect(html).not.toContain("particle-studio-approved-document");
    expect(html).toContain("data:text/javascript;charset=utf-8;base64,");

    const [first, second] = await Promise.all([
      provider.provide(),
      provider.provide(),
    ]);
    expect(first).toEqual(second);
    expect(new TextDecoder().decode(first.bytes)).toBe(precompiledRuntime);
    expect(first.bytes).not.toBe(second.bytes);
  });
});
