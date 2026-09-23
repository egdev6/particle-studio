# Runtime

`@particle-studio/runtime` evaluates validated SceneDocument v1 scenes at explicit microsecond timestamps and emits ordered, renderer-independent draw commands. It does not render pixels or own a clock.

## Contributor quick path

From a clean checkout at the repository root, use the pinned Node 24.20.x and npm 12.0.2 toolchain. These are **intended commands**, not checks verified by this README change:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run validator:prepare
npx vitest run --project core packages/runtime/tests/entrypoint.smoke.test.ts
npx tsc -p packages/runtime/tsconfig.json --noEmit --pretty false
```

Run `validator:prepare` **before importing runtime**: its SceneDocument dependency imports the generated validator. The focused test and package-scoped typecheck are not a claim about the root full suite.

## Public contract

The package entrypoint is [`src/index.ts`](src/index.ts). Its runtime values are `RUNTIME_VERSION` (`particle-studio-runtime-v1`), `deriveCompletedStep(timeUs)`, `evaluateScene(document, timeUs, options?)`, and `createTimelineTransport(document, options?)`. It also exports TypeScript types/interfaces for `EvaluatedElement`, `EvaluatedScene`, `RenderCommand`, `EvaluationResult`, `ResolvedImage`, `ImageResolver`, `EvaluationOptions`, `TimelineSnapshot`, and `TimelineTransport`.

- `evaluateScene` validates its document and accepts a nonnegative, safe-integer `timeUs` through the document duration. It returns `{ state, commands }`; `state` includes `timeUs`, `completedStep`, and visible evaluated elements. Evaluation uses the supplied time, not prior calls. Invalid documents and times throw runtime errors rather than returning validation results.
- `deriveCompletedStep` computes `floor(timeUs * 60 / 1_000_000)` with integer arithmetic: 16,666 µs is step 0; 16,667 µs is step 1. Opacity tracks interpolate with the document's easing; text tracks step at keyframes. Particle positions use the document seed, element ID, and completed step rather than a mutable random stream.
- `createTimelineTransport` starts paused at `playbackRange.startUs`. `snapshot()` includes playhead, playing flag, and evaluation; `seek(timeUs)` updates the playhead (within document duration), `play()`/`pause()` change the flag, and `advance(elapsedUs)` accepts a nonnegative safe-integer microsecond delta. Advance leaves a paused playhead unchanged; while playing it wraps beyond the range end when `loop` is true, or stops at the end otherwise. An exact arrival at the end remains there for a looping transport until the next advance. Transport state is in memory, not persisted.

## Drawing and images

Visible leaves are traversed in root/child order, with group visibility and composed transforms applied. Commands correspond to evaluated shape, line, text, particle, and image elements (`draw-shape`, `draw-line`, `draw-text`, `draw-particles`, `draw-image`); they are drawing instructions, not a renderer. A non-identity effective transform is included on the element and command.

For a visible image, pass `{ imageResolver }` to evaluation or transport. `resolve(asset)` must return a non-null handle and metadata matching the document asset's SHA-256, MIME type, byte length, and intrinsic dimensions; missing resolvers, unresolved assets, and mismatches throw. The command carries the returned opaque handle as `resolved`; runtime does not load or decode the asset. Invisible images are not resolved.

See [`tests/entrypoint.smoke.test.ts`](tests/entrypoint.smoke.test.ts) for executable examples and [`../scene-document/README.md`](../scene-document/README.md) for document validation and the generated-validator contract.
