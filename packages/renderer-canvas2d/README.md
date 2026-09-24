# Canvas2D renderer

`@particle-studio/renderer-canvas2d` draws ordered runtime commands into a caller-provided Canvas2D-like context. It is a command sink: scene evaluation, image loading, canvas creation, and DOM/browser wiring belong to the caller, not this package.

## Contributor quick path

From a clean checkout at the repository root, use Node 24.20.x and npm 12.0.2. These are intended commands, not checks performed by this README change:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npx vitest run --project integration packages/renderer-canvas2d/tests/entrypoint.smoke.test.ts
npx tsc -p packages/renderer-canvas2d/tsconfig.json --noEmit --pretty false
```

No validator preparation is needed for these focused checks: the renderer imports only the runtime `RenderCommand` type, and its integration smoke test supplies commands directly. This is not a claim about the root suite or runtime evaluation tests.

## Public contract

The [`src/index.ts`](src/index.ts) entrypoint exports `renderCommands(context, commands)` and the `Canvas2DContextLike` interface. Pass an ordered, readonly array of runtime `RenderCommand` values and a context providing the listed Canvas2D operations and properties; the interface also supports lightweight recording contexts without a browser.

| Command | Canvas2D operation |
| --- | --- |
| `draw-shape` | `fillRect` with destination geometry |
| `draw-line` | `beginPath`, `moveTo`, `lineTo`, `stroke` |
| `draw-text` | Set `${fontSize}px sans-serif`, then `fillText` |
| `draw-particles` | `fillRect` for each point in order, using `size` |
| `draw-image` | `drawImage` with the resolved handle and destination geometry |

Commands execute in input order. Each command calls `save()`, sets `globalAlpha` to its opacity, applies its optional six-value affine transform, draws, then calls `restore()` to isolate Canvas state between commands.

For `draw-image`, `resolved` must be a non-null object. A non-object handle throws `CANVAS_IMAGE_HANDLE_INVALID` before any context operation for that command. This guard does **not** verify that the object is a valid browser `CanvasImageSource`; the caller is responsible for supplying a drawable resolved image.

See [`tests/entrypoint.smoke.test.ts`](tests/entrypoint.smoke.test.ts) for the recording-context contract and [`../runtime/README.md`](../runtime/README.md) for scene evaluation and image resolution.
