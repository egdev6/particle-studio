import { evaluateScene, type EvaluationResult, type ImageResolver } from "@particle-studio/runtime";
import { renderCommands, type Canvas2DContextLike } from "@particle-studio/renderer-canvas2d";
import type { CachedPngImage } from "./png-image-cache.js";

export interface EditorFrameContext extends Canvas2DContextLike {
  clearRect(x: number, y: number, width: number, height: number): void;
}

/** Borrows a readonly image view; ownership and verification remain with the caller. */
export function createRuntimeImageResolver(images: readonly CachedPngImage[]): ImageResolver {
  const byHash = new Map(images.map((image) => [image.sha256, image]));
  return {
    resolve(asset) {
      const image = byHash.get(asset.sha256);
      if (!image) return undefined;
      return {
        handle: image.handle,
        sha256: image.sha256,
        mimeType: image.mimeType,
        byteLength: image.byteLength,
        intrinsicWidth: image.width,
        intrinsicHeight: image.height,
      };
    },
  };
}

/** Evaluate completely before touching the caller-owned context. */
export function renderEditorFrame(
  context: EditorFrameContext,
  document: unknown,
  images: readonly CachedPngImage[],
  timeUs: number,
  viewport: { readonly width: number; readonly height: number },
): EvaluationResult {
  const evaluation = evaluateScene(document, timeUs, {
    imageResolver: createRuntimeImageResolver(images),
  });
  context.clearRect(0, 0, viewport.width, viewport.height);
  renderCommands(context, evaluation.commands);
  return evaluation;
}
