# Cookbook del SDK (ESM de extremo a extremo)

Recorrido ejecutable del SDK público: crear una escena válida → editarla con
commands → persistir y releer en un filesystem **propio** → construir evidencia de
aprobación de **demo** → generar un mapa virtual ESM con un provider genuino →
evaluarlo. La evaluación final usa el SDK `evaluateAt` **en memoria**: no se ejecuta
la entrada ESM emitida ni un contexto de navegador. Desde ESM, los otros tres formatos
se enlazan al final.

Ruta: [inicio](../README.md) · [manual funcional](functional-guide.md) ·
[matriz](boundary-matrix.md) · [export](../packages/export/README.md).

## Requisitos

- Node 24.20.x y npm 12.0.2; `npm ci --ignore-scripts --no-audit --no-fund` y
  `npm run validator:prepare` (el validador va antes que cualquier consumidor SDK).
- Un archivo de driver **temporal y propio**, fuera del repo; no se añade código nuevo.
- El grafo SDK se carga con `require(esm)` desde la raíz porque el validador
  generado usa `require()` interno; no uses `import` ESM directo del SDK.

## Guion completo

Guarda este bloque como `"$QA_ROOT/sdk-cookbook.mjs"` y ejecútalo (ver «Ejecutar»).
Copia defensiva y guards tipados son del SDK; aquí solo se orquestan.

```js
// $QA_ROOT/sdk-cookbook.mjs — archivo temporal PROPIO, fuera del repositorio.
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const require = createRequire(resolve(process.cwd(), "package.json"));
const { validateSceneDocument, createApprovalEnvelope, readCanonicalApprovalEvidence } =
  require("@particle-studio/scene-document");
const { createCommandSession } = require("@particle-studio/commands");
const {
  createCompleteRevision, createSavedRevisionPointer, createDraftRevisionPointer,
  createRevisionPointersSnapshot, createApprovalRecord,
} = require("@particle-studio/persistence");
const { createRootConfinement } = require("@particle-studio/persistence-fs");
const { createFileSystemPersistenceAdapter } =
  require("@particle-studio/persistence-fs/revision-persistence");
const { createFileSystemAssetPersistenceAdapter } =
  require("@particle-studio/persistence-fs/asset-persistence");
const { RUNTIME_VERSION } = require("@particle-studio/runtime");
const { buildApprovedEsmVirtualMap } = require("@particle-studio/export");

const sha256Of = (bytes) =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");

// 1) Escena válida sin imágenes: un group raíz vacío (manifest de assets queda vacío).
const draft = {
  schemaVersion: 1,
  durationUs: 1_000_000,
  playbackRange: { startUs: 0, endUs: 1_000_000 },
  loop: true,
  seed: 42,
  rootIds: ["root"],
  elements: [{ id: "root", type: "group", childrenIds: [] }],
  tracks: [],
};
const validated = validateSceneDocument(draft);
if (!validated.ok) throw new Error("SDK_COOKBOOK_VALIDATION:" + validated.error.code);

// 2) Commands: crear una shape y editar su opacidad. idSource es solo del demo.
let minted = 0;
const idSource = () => ({ kind: "id", id: "shape-" + ++minted });
const session = createCommandSession("cookbook-doc", validated.value, idSource);
const command = (payload) => ({
  commandSchemaVersion: 1,
  commandId: "cmd-" + minted + "-" + session.snapshot().revision,
  documentId: "cookbook-doc",
  expectedRevision: session.snapshot().revision,
  actorCapability: "human-ui",
  payload,
});
const created = session.dispatch(command({
  type: "create-element",
  element: { type: "shape", x: 16, y: 24, width: 120, height: 80, opacity: 1 },
}));
if (!created.ok) throw new Error("SDK_COOKBOOK_CREATE:" + created.error.code);
const shapeId = created.document.rootIds[created.document.rootIds.length - 1];
const edited = session.dispatch(
  command({ type: "set-shape-opacity", elementId: shapeId, opacity: 0.5 }),
);
if (!edited.ok) throw new Error("SDK_COOKBOOK_EDIT:" + edited.error.code);
const approvedSource = session.snapshot().document;

// 3) Persistencia real: tres roots temporales propios, disjuntos y existentes.
const qaRoot = await mkdtemp(join(tmpdir(), "sdk-cookbook-"));
const workspace = join(qaRoot, "workspace");
const documents = join(qaRoot, "documents");
const outputs = join(qaRoot, "outputs");
await Promise.all([mkdir(workspace), mkdir(documents), mkdir(outputs)]);
const authority = await createRootConfinement({ workspace, documents, outputs });
const revisions = createFileSystemPersistenceAdapter({ authority });
const assets = createFileSystemAssetPersistenceAdapter({ authority });
const readAsset = assets.readAsset.bind(assets);

const revision = createCompleteRevision({
  documentId: "cookbook-doc", revisionId: "revision-1", sequence: 1,
  document: approvedSource,
});
const pointers = createRevisionPointersSnapshot({
  saved: createSavedRevisionPointer(revision),
  draft: createDraftRevisionPointer(revision),
});
await revisions.writeCompleteRevision(revision, pointers);
const readBack = await revisions.readRevision("cookbook-doc", "revision-1");
const readPointers = await revisions.readPointers("cookbook-doc");
if (readBack === null || readPointers.saved?.revisionId !== "revision-1") {
  throw new Error("SDK_COOKBOOK_PERSIST");
}

// 4) Aprobación DEMO explícita del ejemplo (NO es revisión humana ni autenticación).
if (process.env.SDK_COOKBOOK_APPROVE !== "demo-only") {
  throw new Error("SDK_COOKBOOK_APPROVAL: exporta SDK_COOKBOOK_APPROVE=demo-only para esta demo aislada");
}
const approvalEnvelope = await createApprovalEnvelope({
  document: readBack.document,
  runtimeVersion: RUNTIME_VERSION,
  verifiedAssetManifest: [],
});
const evidence = readCanonicalApprovalEvidence(approvalEnvelope);
const approval = createApprovalRecord({
  documentId: "cookbook-doc",
  revisionId: "revision-1",
  approvalEnvelope,
  snapshotHash: evidence.snapshotHash,
  approvalEnvelopeBytes: evidence.approvalEnvelopeBytes,
  canonicalDocumentBytes: evidence.canonicalDocumentBytes,
  verifiedAssetManifest: evidence.verifiedAssetManifest,
  audit: { approvedAt: Date.now(), actorLabel: "local-human" },
});

// 5) Provider genuino: Rolldown empaqueta runtime + renderer desde entradas públicas.
const { rolldown } = await import(pathToFileURL(require.resolve("rolldown")).href);
async function buildRuntimeGraph() {
  const bridge = "virtual:cookbook-runtime";
  const bundle = await rolldown({
    input: { entry: bridge },
    external: [],
    plugins: [{
      name: "cookbook-runtime",
      resolveId: (source) => (source === bridge ? bridge : null),
      load: (id) => (id === bridge
        ? "export { evaluateScene } from '@particle-studio/runtime';\n" +
          "export { renderCommands } from '@particle-studio/renderer-canvas2d';\n"
        : null),
    }],
  });
  try {
    const generated = await bundle.generate({
      format: "es",
      preserveModules: true,
      entryFileNames: "entry.js",
      chunkFileNames: "chunks/[name]-[hash].js",
      sourcemap: false,
    });
    const files = [];
    for (const output of generated.output) {
      if (output.type !== "chunk" || !output.fileName.endsWith(".js")) {
        throw new Error("SDK_COOKBOOK_GRAPH_OUTPUT");
      }
      const bytes = new TextEncoder().encode(output.code);
      files.push({ path: "runtime/" + output.fileName, bytes, sha256: sha256Of(bytes) });
    }
    if (!files.some((file) => file.path === "runtime/entry.js")) {
      throw new Error("SDK_COOKBOOK_GRAPH_ENTRY");
    }
    return {
      entryPath: "runtime/entry.js",
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
    };
  } finally {
    await bundle.close();
  }
}
const graphs = [await buildRuntimeGraph(), await buildRuntimeGraph()];
let graphIndex = 0;
const runtimeGraphProvider = {
  provide: async () => graphs[Math.min(graphIndex++, graphs.length - 1)],
};

// 6) Construir el mapa ESM aprobado y evaluar la escena en un tiempo concreto.
const exported = await buildApprovedEsmVirtualMap({
  approval,
  assets: { readAsset },
  runtimeGraphProvider,
});
const manifest = JSON.parse(
  new TextDecoder().decode(exported.files.get("manifest.json")),
);
const evaluated = exported.evaluateAt(0);
console.log(JSON.stringify({
  qaRoot,
  persistedRevision: readBack.sequence,
  fileCount: exported.files.paths.length,
  manifestRuntimeVersion: manifest.runtimeVersion,
  snapshotHash: approval.snapshotHash,
  evaluatedTimeUs: evaluated.state.timeUs,
}, null, 2));
```

## Paso a paso

| Paso | API pública | Guard / frontera |
| --- | --- | --- |
| 1 Validar | `validateSceneDocument` → `{ ok, value }` o `{ ok:false, error }` | Comprueba `ok` antes de `value` |
| 2 Editar | `createCommandSession`, `dispatch`, `snapshot` | `expectedRevision` y `actorCapability` son del envelope; `human-ui` es política de dominio, no identidad |
| 3 Persistir | `createCompleteRevision`, `create*Pointer`, `createRevisionPointersSnapshot`, `PersistenceAdapterPort.writeCompleteRevision` | `session.revision` y `revision.sequence` son relojes distintos; no prometas lifecycle igual al reanudar |
| 4 Aprobar | `createApprovalEnvelope` + `readCanonicalApprovalEvidence` + `createApprovalRecord` | El sello solo deriva de evidencia branded; nunca fabriques hashes a mano |
| 5 Provider | `PortableRuntimeGraphProvider.provide()` | Dos snapshots idénticos, bytes reales, hashes reales, grafo cerrado |
| 6 Export | `buildApprovedEsmVirtualMap` → `files`, `manifest`, `document`, `evaluateAt` | Revalida approval/runtime/assets antes de emitir |

`create-element` no lleva `id`: lo asigna `idSource` (`shape-<n>`). El contador es
válido solo en una demo fresca; no afirma unicidad durable ni reanuda la sesión.

## Ejecutar

Desde la **raíz del repo** (imports resuelven desde ahí), con un `$QA_ROOT` propio:

```sh
QA_ROOT=$(mktemp -d)
# guarda el bloque de arriba en "$QA_ROOT/sdk-cookbook.mjs"
export SDK_COOKBOOK_APPROVE=demo-only
node --import tsx "$QA_ROOT/sdk-cookbook.mjs"
```

`SDK_COOKBOOK_APPROVE` es un flag modelado del ejemplo: por defecto el guion se
detiene sin decisión. El corte ocurre **después** de escribir revisión/pointers en el
store QA propio (no hay dry-run ni rollback), así que deja datos propios; sin el flag
no existe un «modo sin efectos». No implica consentimiento humano real ni confianza de
terceros. `snapshotHash` identifica el contenido aprobado (documento, runtime y
manifest); el audit registra datos de demo, no autentica al usuario
ni concede permisos.

## Otros tres formatos

Comparten el contrato de aprobación/assets, pero cada formato exige providers y
opciones propios:

- [Web component](../packages/export/README.md) — usa el mismo `runtimeGraphProvider`,
  sin bundle.
- [IIFE](../packages/export/README.md) — `buildApprovedIifeVirtualMap` exige además un
  `iifeBundleProvider` (bundle clásico fijo `particle-studio.iife.js`).
- [HTML autocontenido](../packages/export/README.md) — `buildApprovedSelfContainedHtmlVirtualMap`
  usa `selfContainedRuntimeProvider` o el par runtime+IIFE; límite de 10.485.760 bytes.

## Decisiones y límites

- El flag `SDK_COOKBOOK_APPROVE` no equivale a revisión humana, autenticación ni veredicto de
  provider confiable. Una app real necesita revisión externa y política de acceso.
- El manifest de assets vacío es correcto porque la escena no tiene imágenes; el store
  de assets usa roots propios y no adopta datos de usuario. No demuestra cobertura PNG.
- `ApprovalRecord` vive **solo en memoria**: revisiones/pointers persistidos no guardan
  aprobación y `saved` no significa `approved`; no prometas supervivencia a un reinicio.
- `writeCompleteRevision` es no condicional sobre un store propio fresco: no prueba CAS;
  `saved` y `draft` apuntan a la misma revisión de demo (`revision-1`), no a aprobación.
- Filesystem usa roots disjuntos y confinados; la publicación puede dejar una
  revisión huérfana o durabilidad incierta, sin rollback global.
- Los límites de assets FS (16 MiB/24 MiB) no aplican aquí por ser sin imágenes.
- El mapa vive en memoria; no hay descarga UI, vídeo ni PNG de escena.
- Confía solo en la cadena de build del repo (Rolldown + entradas públicas); no
  aceptes providers arbitrarios como sandbox.
- Conserva `$QA_ROOT` para inspección; no limpies ni adoptes perfiles o
  workspaces ajenos.

## No incluido

No hay factory de escena vacía (`createSceneDocument`), ni adaptador en memoria, ni
`save`/`approveRevision`, ni CLI de export. Los ejemplos de este cookbook están
**sin ejecutar** en autoría (`NOT_RUN`): reprodúcelos y verifícalos en tu propio entorno.
