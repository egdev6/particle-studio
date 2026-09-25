/**
 * Dependency-free build input for the editor's trusted precompiled runtime.
 * Its returned program is bundled at editor build time, never in the browser.
 */
export function selfContainedRuntimeEntrySource(): string {
  return `import { createApprovalEnvelope, readCanonicalApprovalEvidence } from "@particle-studio/scene-document";
import { evaluateScene, RUNTIME_VERSION } from "@particle-studio/runtime";
import { renderCommands } from "@particle-studio/renderer-canvas2d";

const bindingError = () => new Error("PARTICLE_STUDIO_APPROVED_BINDING_INVALID");
const readBinding = (id) => {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLScriptElement) || node.type !== "application/json") throw bindingError();
  try { return JSON.parse(node.textContent ?? ""); } catch { throw bindingError(); }
};
const safeObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sameAsset = (left, right) => left.sha256 === right.sha256 && left.mimeType === right.mimeType && left.byteLength === right.byteLength;
const assetMetadata = (value) => {
  if (!safeObject(value) || Object.keys(value).length !== 6 || typeof value.path !== "string" || typeof value.sha256 !== "string" || typeof value.mimeType !== "string" || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || !Number.isSafeInteger(value.intrinsicWidth) || value.intrinsicWidth < 1 || !Number.isSafeInteger(value.intrinsicHeight) || value.intrinsicHeight < 1) throw bindingError();
  const matched = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value.path);
  if (matched === null || matched[1] !== value.mimeType) throw bindingError();
  return value;
};
const bytesFromDataUrl = (asset) => {
  const matched = /^data:[^;,]+;base64,([A-Za-z0-9+/]*={0,2})$/.exec(asset.path);
  if (matched === null) throw bindingError();
  let decoded;
  try { decoded = atob(matched[1]); } catch { throw bindingError(); }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
};
const sha256 = async (bytes) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return "sha256:" + [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
const canvasSize = (documentValue) => {
  let width = 1; let height = 1;
  for (const element of documentValue.elements) {
    if (element.type === "shape" || element.type === "image") { width = Math.max(width, element.x + element.width); height = Math.max(height, element.y + element.height); }
    else if (element.type === "line") { width = Math.max(width, element.x1, element.x2); height = Math.max(height, element.y1, element.y2); }
    else if (element.type === "text") { width = Math.max(width, element.x); height = Math.max(height, element.y + element.fontSize); }
    else if (element.type === "particle") { width = Math.max(width, element.x + element.spread + element.size); height = Math.max(height, element.y + element.spread + element.size); }
  }
  return { width: Math.max(1, Math.ceil(width)), height: Math.max(1, Math.ceil(height)) };
};
const approvedBinding = async () => {
  let evidence;
  try {
    const binding = readBinding("particle-studio-approved-envelope");
    if (!safeObject(binding) || Object.keys(binding).length !== 2 || typeof binding.snapshotHash !== "string" || !safeObject(binding.envelope)) throw bindingError();
    const envelope = await createApprovalEnvelope(binding.envelope);
    evidence = readCanonicalApprovalEvidence(envelope);
    if (evidence.snapshotHash !== binding.snapshotHash) throw bindingError();
  } catch { throw bindingError(); }
  if (evidence.runtimeVersion !== RUNTIME_VERSION) throw bindingError();
  let approvedDocument;
  try { approvedDocument = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(evidence.canonicalDocumentBytes)); } catch { throw bindingError(); }
  const boundAssets = readBinding("particle-studio-approved-assets");
  if (!Array.isArray(boundAssets) || evidence.verifiedAssetManifest.length !== boundAssets.length) throw bindingError();
  const references = approvedDocument.elements.filter((element) => element.type === "image");
  const expected = new Map();
  for (const manifestAsset of evidence.verifiedAssetManifest) {
    if (!safeObject(manifestAsset) || expected.has(manifestAsset.sha256)) throw bindingError();
    expected.set(manifestAsset.sha256, manifestAsset);
  }
  const assets = []; const seen = new Set();
  for (const boundAsset of boundAssets) {
    const asset = assetMetadata(boundAsset);
    const manifestAsset = expected.get(asset.sha256);
    if (manifestAsset === undefined || seen.has(asset.sha256) || !sameAsset(manifestAsset, asset)) throw bindingError();
    const matches = references.filter((reference) => reference.asset.sha256 === asset.sha256);
    if (matches.length === 0 || matches.some((reference) => !sameAsset(reference.asset, asset) || reference.asset.intrinsicWidth !== asset.intrinsicWidth || reference.asset.intrinsicHeight !== asset.intrinsicHeight)) throw bindingError();
    seen.add(asset.sha256); assets.push(asset);
  }
  if (references.some((reference) => !seen.has(reference.asset.sha256)) || seen.size !== expected.size) throw bindingError();
  return { document: approvedDocument, assets, canvas: canvasSize(approvedDocument) };
};
const createBrowserController = (canvas) => {
  let status = "loading"; let approvedDocument; const controller = new AbortController(); const handles = new Map();
  const release = () => { for (const handle of handles.values()) if (typeof handle.close === "function") handle.close(); handles.clear(); };
  const ready = (async () => {
    try {
      const approved = await approvedBinding();
      canvas.width = approved.canvas.width; canvas.height = approved.canvas.height;
      for (const asset of approved.assets) {
        const bytes = bytesFromDataUrl(asset);
        if (bytes.byteLength !== asset.byteLength || await sha256(bytes) !== asset.sha256) throw new Error("PARTICLE_STUDIO_ASSET_HASH_MISMATCH");
        const handle = await createImageBitmap(new Blob([bytes], { type: asset.mimeType }));
        if (controller.signal.aborted || handle.width !== asset.intrinsicWidth || handle.height !== asset.intrinsicHeight) { handle.close(); throw new Error(controller.signal.aborted ? "PARTICLE_STUDIO_DESTROYED" : "PARTICLE_STUDIO_ASSET_DIMENSIONS_MISMATCH"); }
        handles.set(asset.sha256, handle);
      }
      if (controller.signal.aborted) throw new Error("PARTICLE_STUDIO_DESTROYED");
      approvedDocument = approved.document;
      status = "ready";
    } catch (error) { release(); if (controller.signal.aborted) throw new Error("PARTICLE_STUDIO_DESTROYED"); status = "failed"; throw error instanceof Error ? error : bindingError(); }
  })();
  return Object.freeze({
    ready,
    renderAt(timeUs) {
      if (status !== "ready") throw new Error("PARTICLE_STUDIO_NOT_READY");
      const context = canvas.getContext("2d"); if (!context) throw new Error("PARTICLE_STUDIO_CANVAS_UNAVAILABLE");
      const result = evaluateScene(approvedDocument, timeUs, { imageResolver: { resolve: (asset) => { const handle = handles.get(asset.sha256); return handle === undefined ? undefined : { handle, ...asset }; } } });
      canvas.width = canvas.width; renderCommands(context, result.commands); return result;
    },
    destroy() { if (status === "destroyed") return; status = "destroyed"; controller.abort(); release(); },
  });
};
if ("ParticleStudio" in globalThis) throw new Error("PARTICLE_STUDIO_GLOBAL_COLLISION");
const mount = (target) => {
  if (!(target instanceof HTMLElement)) throw new Error("PARTICLE_STUDIO_TARGET_INVALID");
  const canvas = document.createElement("canvas"); target.append(canvas);
  const controller = createBrowserController(canvas); let destroyed = false;
  return Object.freeze({
    ready: controller.ready,
    renderAt(timeUs) { if (destroyed) throw new Error("PARTICLE_STUDIO_DESTROYED"); return controller.renderAt(timeUs); },
    destroy() { if (destroyed) return; destroyed = true; controller.destroy(); canvas.remove(); },
  });
};
globalThis.ParticleStudio = Object.freeze({ mount });
`;
}
