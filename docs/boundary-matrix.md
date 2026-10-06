# Matriz de funcionalidad y fronteras de prueba

**Implementado no significa expuesto en UI ni verificado en esta sesión.** Esta
matriz organiza el proyecto completo por contratos públicos y clases de evidencia.
Los paths de tests indican dónde se especifica comportamiento, no un recibo GREEN,
aprobación nativa ni garantía sobre una cantidad histórica de casos.

Ruta: [índice](../README.md) → [arquitectura](overview.md) → contrato especializado.
Para instrucciones de navegador consulta [browser-testing](browser-testing.md).

## Cómo leer la evidencia

| Clase | Qué puede demostrar | Qué no demuestra por sí sola |
| --- | --- | --- |
| Core / Node | Dominio, workflows SDK, callbacks e invariantes | CAS real de Chromium o píxeles nativos |
| Core + fake-indexeddb | Composición real con storage simulado | Ownership de ImageBitmap o concurrencia IDB nativa |
| UI / jsdom | Inputs, selección, activity, listeners y feedback | Entrada build, bytes nativos o dibujo real |
| Integración / recording context | Contrato Canvas2D de comandos | Que un objeto sea un CanvasImageSource nativo válido |
| Chromium fixture, 4175 | SHA/PNG, facade API, canvas e IDB reales | Que los botones/controladores de producción estén conectados |
| Chromium preview, 4176 | Entrada construida y acciones UI con APIs nativas | Un resultado de ejecución no observado o auth general |
| Headless stdio / Docker | Protocolo, persistencia y lifecycle correspondientes | Un servicio HTTP o deployment estático |
| Manual / screenshots | Affordances visibles y síntomas | Full bytes, pointers, historial, CAS o cierres por identidad |

Las pruebas pueden instrumentar APIs nativas para holds/fallos y observar candidatos.
Eso no convierte hooks de fixture ni `window` de test en servicios productivos.
Una comparación independiente de bytes/SHA en un test tampoco es un hook de producción.

## Entrada editor: siete acciones reales

Todas están conectadas a la [entrada real](../apps/editor/src/editor-canvas-entry.ts)
y la [facade browser](../apps/editor/src/browser-editor-session.ts). Comparten activity
frontend **y** lane owned backend, también ante llamadas directas o eventos forzados.
El canvas de producción es `#scene`, 256×160; renderiza en playback start, sin controles
para animación. Selección/inputs no eluden exclusión durante trabajo pending.

| Acción UI exacta | Implementación / condición | Verificación preview |
| --- | --- | --- |
| **Create blank scene** | `createScene`; startup sano sin current; una raíz group vacía, no promoción de sample | [durable-import](../apps/editor/tests/browser/durable-import.spec.ts) |
| **Import editable JSON** | `importJson`; valida/publica JSON y requiere PNG referenciados ya locales | [durable-import](../apps/editor/tests/browser/durable-import.spec.ts) |
| **Import PNG** | `importPng`; current genuino, File y placement capturados | [png-import](../apps/editor/tests/browser/png-import.spec.ts) |
| **Add rectangle** | `addRectangle`; current genuino, shape nueva en coordenadas raíz | [rectangle-create](../apps/editor/tests/browser/rectangle-create.spec.ts) |
| **Apply position** | `setShapePosition`; selección source-bound de shape root/nested | [set-shape-position](../apps/editor/tests/browser/set-shape-position.spec.ts) |
| **Apply dimensions** | `setShapeDimensions`; selección source-bound de shape root/nested | [set-shape-dimensions](../apps/editor/tests/browser/set-shape-dimensions.spec.ts) |
| **Apply opacity** | `setShapeOpacity`; selección source-bound de shape root/nested | [set-shape-opacity](../apps/editor/tests/browser/set-shape-opacity.spec.ts) |

**Scene element** y **Published element JSON** añaden inspección read-only, no una
octava acción durable. [element-inspector](../apps/editor/tests/browser/element-inspector.spec.ts)
comprueba metadata, identidad y ausencia de efectos propios en storage/píxeles/bitmaps.
Los [tests de controles](../apps/editor/tests) separan esa prueba de las UI jsdom.
Los detalles de labels/payloads y códigos están en el [README editor](../apps/editor/README.md).

### Valores y selección

| Superficie | Valores nuevos aceptados | Conservación / frontera |
| --- | --- | --- |
| PNG / rectangle | X/Y finitos, width/height positivos finitos; inputs no vacíos | PNG defaults 0/0/64/64; rectangle 16/24/120/80, opacidad fija 1 |
| Position X/Y | Par finito atómico; negativos/fracciones válidos | Authored/local bajo grupos, no world ni tracks evaluados |
| Dimension width/height | Par finito estrictamente positivo; fracciones válidas | Tamaños heredados cero/negativos siguen importables |
| Shape opacity | Finita [0,1], incluye 0/-0, fracciones y 1 | Heredada -0.25/2 permanece sin clamp ni migración |
| Inspector | Las seis variantes, en orden documental | Metadata authored; no JSON sin enviar, handles ni valores animados |

Inspector entrega token documentId/revisionId/elementId; es identidad, no permiso
de acción. Los guards SDK comprueban fuente viva, tipo y valores antes de efectos.
Los tres edits preservan ID y campos ajenos, jerarquía, tracks, configuración,
historial saved y referencias PNG. No asignan otro element ID ni retargetean.
Tracks preservados pueden sobrescribir opacidad base en playback start: éxito no
promete un cambio visible en todos los píxeles.

Valores iguales también publican revisión/secuencia/pointer nuevos. Toda fuente
nueva limpia selección aunque el ID permanezca: hay que reseleccionar explícitamente.
Un rechazo same-source conserva selección e input escrito. No se hace retry/rebase.
Cada uno de los tres controladores conserva su propio éxito/rechazo/advertencia de
render a través de BEGIN/END; publicación ajena refresca guidance del actual current.
**Position status**, **Dimension status** y **Opacity status** son independientes del
status primario del canvas. Commit seguido de fallo de render no significa rollback.

### Startup, concurrencia y cierre

- Slot vacío o saved-only sano: muestra no persistida; no se escribe un draft oculto.
  Crear/importar explícitamente permite editar; saved-only conserva saved y su floor.
- Pending/corrupt/missing-assets/context ausente/fallo de render inicial: acciones
  bloqueadas, sin seed, borrado, reset ni fallback exitoso. Sample no es current.
- Fuente stale o ganador competing-tab: expectedSource/CAS rechazan sin rebase,
  retarget, retry ni recarga implícita. Guards y native CAS son fronteras diferentes.
- Fallo PNG puede dejar bytes inmutables escritos antes de rechazo; preservar
  documento/pointer/frame no promete rollback global de assets ni garbage collection.
- `pagehide` dispone los tres edit controllers **antes** de notificar null al Inspector;
  suprime DOM/status/frame tardíos. Owner espera settlements resueltos/rechazados y
  cierra cada bitmap owned una vez, incluidos duplicados legítimos prehidratados.
  No cancela cola workspace, cierra/elimina DB ni usa hacks de liberación de cache.

## Dominio completo frente a bindings actuales

| Dominio implementado | UI actual | Clase / referencias |
| --- | --- | --- |
| SceneDocument v1, seis variantes, jerarquía/range/tracks | Import JSON; Inspector de todas; creación estrecha | Core: [scene-document/tests](../packages/scene-document/tests), [contrato](../packages/scene-document/README.md) |
| Canonicalización, approval envelope/evidencia | No aprobación UI | Core: [scene-document](../packages/scene-document/README.md), [persistence](../packages/persistence/README.md) |
| Evaluación timestamp, seed/step, orden/transforms e imágenes | Frame en playback start | Core [runtime/tests](../packages/runtime/tests); native [editor-frame](../apps/editor/tests/browser/editor-frame.spec.ts) |
| Transporte seek/play/pause/advance y loop | No playback controls | Core: [runtime](../packages/runtime/README.md) |
| Canvas2D de shape/line/text/particle/image | Dibujo de escena importada/restaurada | Integración [renderer tests](../packages/renderer-canvas2d/tests), preview startup |
| Commands e historial revisionado, undo/redo/fork | Sólo acciones estrechas conectadas | Core: [commands/tests](../packages/commands/tests) |
| Workspace durable, imports y bridge source-bound | Las siete acciones | Core/fake IDB y UI: [editor/tests](../apps/editor/tests); preview separado |
| Revisiones/pointers y recovery offers | Reload draft, no recovery UI | Core: [persistence/tests](../packages/persistence/tests) |
| IDB assets, autosaves, approvals y transacciones | Assets/revisiones conectados; autosave/aprobación no | Fake IDB [adapter tests](../packages/persistence-indexeddb/tests); preview para rutas conectadas |
| FS confinado, revisiones/pointers/assets | No binding browser | Core [FS tests](../packages/persistence-fs/tests); headless integración |
| Cuatro builders export aprobados | No export/download UI | Core: [export/tests](../packages/export/tests), [contrato](../packages/export/README.md) |
| Dispatcher browser-agent standalone | No tools registradas por la entrada | Core: [webmcp tests](../packages/webmcp-adapter/tests) |
| Workspace-agent del editor | No UI agent autónoma | Core/UI: [editor/tests](../apps/editor/tests), [workspace](../apps/editor/src/editor-browser-agent-workspace.ts) |
| Workspace headless y cinco tools MCP stdio | No UI ni HTTP | [headless tests](../apps/headless-mcp/tests), [integración](../apps/headless-mcp/tests-integration) |

### Familias de comandos soportadas

El [entrypoint commands](../packages/commands/src/index.ts) acepta estas familias;
consulta su [README](../packages/commands/README.md) y tests para los envelopes exactos:

- Elementos: `create-element`, `remove-element`, `replace-element`.
- Jerarquía: `group-elements`, `ungroup-element`, `reparent-element`.
- Shape estrecha: `set-shape-position`, `set-shape-dimensions`, `set-shape-opacity`.
- Valor por identidad: `set-keyframe-value`.
- Timeline: `create-track`, `remove-track`, `create-keyframe`, `change-keyframe`,
  `move-keyframe`, `remove-keyframe` (propiedades `opacity` y `text.text`).

Las tres operaciones estrechas requieren `human-ui`; browser/headless devuelven
`MALFORMED_COMMAND`. Las familias anteriores conservan sus branches de actor;
no se deduce un rechazo global a agents. `actorCapability` es política del envelope,
no token de autenticación. Targets/IDs/candidatos/revisión se validan por dominio.
Undo/redo/fork son métodos de sesión; tenerlos no implica botones editor.

## Export y agentes: interfaces, no promesas de producto

| Ruta | Resultado / herramientas | Frontera |
| --- | --- | --- |
| ESM | `buildApprovedEsmVirtualMap`, `evaluateAt` | Módulos/documento/assets adyacentes en mapa virtual |
| Web component | `buildApprovedWebComponentVirtualMap` | `web-component.js` y grafo runtime virtual |
| IIFE | `buildApprovedIifeVirtualMap` | Script clásico `ParticleStudio.mount`, providers confiables |
| HTML | `buildApprovedSelfContainedHtmlVirtualMap` | Un HTML; máximo 10 MiB de assets únicos raw embebidos |
| Browser dispatcher | summary/validate/dispatch/undo/redo | Puerto suministrado por host, no registro WebMCP automático |
| Headless stdio | Las mismas cinco operaciones de draft | Workspace FS durable, envelopes MCP estrictos, no HTTP |

Los nombres exactos son `particle_studio.get_draft_summary`,
`particle_studio.validate_draft`, `particle_studio.dispatch_draft_command`,
`particle_studio.undo` y `particle_studio.redo`. Browser añade `browser-agent` al
command aislado; headless usa su autoridad `headless-agent`. Transportes distintos
no conceden aprobación, acceso genérico a filesystem ni nuevos payloads human-only.
[WebMCP](../packages/webmcp-adapter/README.md) detalla budgets y errores bounded;
[server headless](../apps/headless-mcp/src/mcp-headless-server.ts) registra su lista.

Headless requiere `PARTICLE_STUDIO_WORKSPACE_ROOT`, `PARTICLE_STUDIO_DOCUMENTS_ROOT`,
`PARTICLE_STUDIO_OUTPUTS_ROOT` y `PARTICLE_STUDIO_DOCUMENT_ID`;
`PARTICLE_STUDIO_SEED_PATH` es necesario sin draft persistido. Véase
[main](../apps/headless-mcp/src/main.ts) y [deployment](deployment.md): stdin/stdout
son protocolo, stderr diagnósticos; no hay puerto ni health endpoint.
FS limita assets raw a 16 MiB y registros serializados a 24 MiB; no extrapoles esos
límites a IDB ni confundas ese storage con el packaging HTML de 10 MiB.

## Selección de QA y límites no implementados

[playwright.config.ts](../playwright.config.ts) fija Chromium, un worker, cero
retries y `reuseExistingServer: false`. Proyecto `chromium` usa fixture 4175 para
platform/frame y APIs dimensions/opacity; `chromium-preview` usa build+preview 4176
para ocho specs de producción. Dev 4173 es otra ruta, no prueba de build equivalente.
El comando enfocado previsto es `npx playwright test <path> --project=chromium-preview`;
aun enfocado, la config inicia ambos servidores. No reutilices un harness vivo.

[CI](../.github/workflows/ci.yml) incluye validator preparation, core, jsdom,
integración stdio/contrato Docker, browser, once typechecks y smoke contenedor.
Cache/huella del validador y oráculos independientes de tests no sustituyen native
history/pointers/full bytes ni cierres por bitmap. No hay benchmark ni proyecto de
performance en el árbol; no se declara una salida de performance verde.

**No expuesto hoy:** undo/redo UI, color/rotation UI, timeline/keyframe UI, autosave UI,
export/download UI, playback controls, canvas picking/drag/highlights y recovery UI.
**No implementado como salida actual:** PNG/WebM/vídeo o export CLI documentada.
**No configurado en el árbol:** Netlify. La entrada editor sí está versionada;
la nota antigua en deployment que indica lo contrario no define el alcance actual.
Estas ausencias no son una hoja de ruta ni una promesa de implementación futura.
