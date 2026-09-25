# Approved export virtual maps

`@particle-studio/export` builds portable, in-memory file maps from an approved scene. It does not write files or bundle a runtime on its own: callers provide approved evidence, an asset reader, and the trusted build-time provider(s) required by the chosen output.

## Choose an output

| Builder | Provider input | Output |
| --- | --- | --- |
| `buildApprovedEsmVirtualMap` | `runtimeGraphProvider` (exports `evaluateScene`) | Adjacent content-addressed assets, canonical document, generated ESM adapter and runtime modules; returned `evaluateAt(timeUs, options?)` uses the current runtime. |
| `buildApprovedWebComponentVirtualMap` | `runtimeGraphProvider` (exports `evaluateScene` and `renderCommands`) | Adjacent assets and `web-component.js` with its virtual runtime graph. |
| `buildApprovedIifeVirtualMap` | `runtimeGraphProvider` plus `iifeBundleProvider` | Adjacent assets and `particle-studio.iife.js` (classic script exposing `ParticleStudio.mount`), with the generated ESM graph retained in the virtual map. |
| `buildApprovedSelfContainedHtmlVirtualMap` | Either `selfContainedRuntimeProvider`, or `runtimeGraphProvider` plus `iifeBundleProvider` | One `particle-studio.html` file with approved evidence, MIME data-URL assets, and an embedded classic-script runtime. |

Each builder takes `{ approval, assets, ...providers }`, where `assets.readAsset(sha256)` retrieves content-addressed bytes. The returned object exposes `files.paths`, `files.get(path)`, `files.entries()`, `manifest`, and `document`; only ESM also exposes `evaluateAt`. File reads return copies. The manifest records the snapshot/runtime versions, adapter, packaging policy, asset hashes, and SHA-256 file hashes; for HTML it records embedded bytes and the limit. HTML's one-file packaging does not include a separate `manifest.json` (the manifest is returned to the caller).

## Validation and provider boundary

Before producing a map, the builders validate the approval record against current runtime version and reconstruct its canonical envelope/document evidence and snapshot hash. They reread every approved asset and compare its SHA-256, MIME type, and byte length against the verified manifest; missing or changed assets fail the build. Runtime graph providers must supply sorted, canonical, hashed virtual modules with a closed relative-import graph, the required exports, and identical bytes on repeated calls. Reserved generated paths and asset paths cannot be supplied by a provider.

The IIFE provider receives only a cloned, hashed virtual graph and a fixed entry/global name. The exporter checks the returned bundle's path, global, hash, UTF-8 module syntax constraints, and repeated bytes; it does **not** execute arbitrary provider JavaScript or prove its semantics. Use a trusted, pinned bundler/provider (the tests use Rolldown) rather than treating these checks as a sandbox. The standalone HTML alternative `selfContainedRuntimeProvider.provide()` receives no approval, scene, assets, or virtual graph; the exporter binds validated evidence and assets after accepting its deterministic bundle. `selfContainedRuntimeEntrySource()` supplies the generic browser runtime source for a trusted precompiled provider; it is build input, not a browser-side build service.

Adjacent-asset outputs use `adjacent-assets-v1`; HTML uses `self-contained-data-urls-v1`. HTML permits at most **10 MiB (10,485,760 bytes)** of unique verified embedded assets in total; the limit applies to source asset bytes, not encoded HTML size. Packaging is deterministic for identical approved evidence, assets, and provider bytes. The focused tests exercise genuine browser bundles, fixed-time evaluation, asset tampering, provider instability and the inclusive HTML size boundary. These checks are not a claim of general script security, persistent storage, or durable publication: consumers still own trusted provider selection, deployment, and file persistence.

## Contributor checks (clean checkout)

From the repository root, with the repository's pinned Node/npm toolchain:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run validator:prepare
npx vitest run --project core packages/export/tests
npx tsc -p packages/export/tsconfig.json --noEmit --pretty false
```

The export test module also prepares the validator at module load and in `beforeAll`; the explicit preparation command remains necessary in CI for the other focused packages.
