# Mapa del proyecto y sus contratos

El flujo central es **SceneDocument validado → edición revisionada → publicación
canónica durable → evaluación temporal → comandos de dibujo → Canvas2D**.
Aprobación y exportación forman otra ruta explícita; ni pintar una escena ni
persistir un draft otorgan por sí solos autoridad de aprobación.

Vuelve al [índice](../README.md) o consulta la [matriz de fronteras](boundary-matrix.md)
para distinguir capacidad de dominio, acción UI y clase de verificación.

## Responsabilidades directas

| Superficie | Responsabilidad | No le corresponde |
| --- | --- | --- |
| [scene-document](../packages/scene-document/README.md) | Esquema v1, validación, bytes canónicos, evidencia de aprobación | Migrar versiones desconocidas o escribir storage |
| [commands](../packages/commands/README.md) | Candidatos validados, revisiones, patches, undo/redo/fork | Persistencia, autenticación o recursos gráficos |
| [persistence](../packages/persistence/README.md) | Revisiones completas, pointers saved/draft, puertos, recuperación, approval records | I/O o atomicidad de un adapter |
| [persistence-fs](../packages/persistence-fs/README.md) | Confinamiento de roots, revisiones/pointers y assets en disco | Transacción global o defensa ante adversario same-user |
| [persistence-indexeddb](../packages/persistence-indexeddb/README.md) | Revisiones/pointers, assets, autosaves, approvals locales | Transacción única entre todas las llamadas |
| [runtime](../packages/runtime/README.md) | Evaluar tiempo explícito y emitir comandos ordenados | Reloj, píxeles, carga/decodificación de PNG |
| [renderer-canvas2d](../packages/renderer-canvas2d/README.md) | Consumir comandos sobre contexto proporcionado | Crear canvas, evaluar escenas o adoptar bitmaps |
| [export](../packages/export/README.md) | Validar aprobación/assets/providers y construir mapas virtuales | Guardar archivos o ofrecer un botón de descarga |
| [webmcp-adapter](../packages/webmcp-adapter/README.md) | Validar transporte y despachar cinco tools a un puerto | Registrar WebMCP o conectarse automáticamente al editor |
| [editor](../apps/editor/README.md) | Componer workspace durable, imports, recursos, facade y controles | Exponer toda capacidad del dominio como UI |
| [headless MCP](../apps/headless-mcp/src/index.ts) | Workspace durable confinado y binding MCP stdio | Servidor HTTP, UI o aprobación humana implícita |

Son nueve paquetes y dos apps en workspaces npm privados. Sus entrypoints de
biblioteca apuntan a TypeScript fuente; no se presupone una publicación externa npm.
Vite construye la entrada del editor. El [manifest headless](../apps/headless-mcp/package.json)
define por separado su arranque Node con `tsx`.

## Documento, validación y bytes

`SceneDocumentV1` describe duración/rango en microsegundos, loop, seed, roots,
elementos y tracks. Sus seis variantes son `shape`, `line`, `group`, `particle`,
`text` e `image`; un group es estructura, no un comando drawable adicional.
La validación comprueba también jerarquía, rango de playback y tracks.

`validateSceneDocument` devuelve éxito o código tipado; `importEditableJson` parsea,
valida y clona. Versiones desconocidas se rechazan, no se migran.
`canonicalizeSceneDocument` valida y produce bytes UTF-8 identificados como `jcs-1`;
`exportEditableJson` devuelve una copia. No confundas texto editable con evidencia.

`validator:prepare` genera el standalone v1 y verifica bytes/huellas fijados por
el contrato. Un mismatch falla cerrado: no se corrige editando output generado o
huellas para hacer pasar un check. Véase el [contrato del validador](../packages/scene-document/README.md).

`createApprovalEnvelope` liga documento, `runtimeVersion` no vacío y manifest de
assets verificados a bytes canónicos y hash SHA-256. Política, esquema, runtime,
canonicalización y hash tienen identificadores versionados separados.
La autoridad es evidencia branded en proceso; deserializar JSON no la reconstruye.
Persistence agrega identidad de revisión y auditoría local-human a esa evidencia.

## Edición, revisión y fuente durable

`createCommandSession` trabaja en memoria sobre una copia validada. `dispatch`
comprueba envelope v1, IDs, `expectedRevision`, actor y payload; valida el candidato
antes de avanzar historial. Undo/redo también avanzan revisión; fork copia el
historial, pero comparte el callback externo de IDs. Un ID consumido en un rechazo
no implica que la asignación externa pueda deshacerse.

`actorCapability` distingue `human-ui`, `browser-agent` y `headless-agent` como
política de envelope, **no autenticación**. Los tres comandos estrechos de shape
(posición, dimensiones, opacidad) requieren human-ui; los anteriores conservan su
manejo de actor. Los [comandos](../packages/commands/README.md) detallan códigos como
`MALFORMED_COMMAND`, `TARGET_NOT_FOUND`, `INVALID_CANDIDATE` y errores de IDs.

El [workspace durable del editor](../apps/editor/src/durable-draft-workspace.ts)
compone verificación, hidratación y publicación. Las acciones estrechas capturan
fuente/valores una vez y usan un bridge nuevo con revisión de comando 0: esa
revisión en memoria no es la secuencia durable. `expectedSource` vincula la
publicación a document/revision y la secuencia siguiente; CAS rechaza competidores.
No hay retry, rebase ni retarget automático. Un render fallido tras commit no revierte
la publicación; la UI refresca el actual current y lo comunica.

## Persistencia y recuperación

Las revisiones completas son inmutables y llevan documento, bytes canónicos,
identificador y longitud. Saved y draft son pointers distintos; preservar saved
no equivale a aprobar el draft. El core modela ofertas de recovery, aceptación,
rechazo y descarte explícitos; no restaura automáticamente.

IndexedDB publica revisión/pointers en una transacción; assets se escriben aparte.
Ofrece storage de autosave y approvals, pero el editor no conecta autosave ni una
UI de recovery/aprobación. No hay `close()` en el adapter retornado.

Filesystem necesita tres roots absolutos existentes, canónicos y disjuntos:
workspace para assets, outputs para revisiones/pointers y documents como autoridad
de entrada. Sus assets tienen límites de 16 MiB raw y 24 MiB de registro serializado.
Una publicación de pointer fallida puede dejar una revisión huérfana; después de
publicación ciertos fallos indican durabilidad incierta, no rollback garantizado.
El constructor de asset del core comprueba formato/longitud, no calcula el digest;
los adapters y los workflows de verificación mantienen esa frontera.

## Tiempo, dibujo y propiedad de recursos

`evaluateScene` recibe un timestamp entero seguro, no negativo, dentro de duración.
No depende de evaluaciones previas ni posee reloj. `deriveCompletedStep` calcula
`floor(timeUs * 60 / 1_000_000)` con aritmética entera; partículas usan seed, ID y
step completado, no un stream aleatorio mutable. Esto no promete identidad universal
de píxeles flotantes entre plataformas. El transporte empieza pausado en playback start.

Runtime recorre hojas visibles en orden con transformaciones de grupos y emite
shape/line/text/particles/image. El renderer usa operaciones Canvas2D, no WebGL.
Un resolver debe aportar handle y metadatos coincidentes para imágenes visibles;
no realiza decodificación. [renderEditorFrame](../apps/editor/src/editor-frame.ts)
evalúa antes de tocar el contexto: un rechazo no borra el frame, pero una excepción
mid-draw no tiene rollback transaccional.

`BrowserCurrent` es una vista prestada de revisión/imágenes, no permiso de release.
El propietario conserva handles durante dibujo, espera trabajo owned tanto resuelto
como rechazado y libera los recursos una vez. Prehidratación puede decodificar un
duplicado legítimo: se cierra ese handle, no el retained aún útil. Inspector y
controles no adquieren autoridad de cache, bitmap ni base de datos.

## Exportación y agentes: rutas separadas

Los cuatro builders aprobados producen ESM, web component, IIFE con
`ParticleStudio.mount` y HTML autocontenido. Devuelven mapas virtuales en memoria;
los callers proporcionan asset reader y providers confiables y guardan los archivos.
Se vuelven a verificar aprobación, runtime y assets. HTML limita a 10 MiB los bytes
únicos de assets embebidos; no es el límite raw del adapter filesystem.
No existe aquí export PNG/WebM/vídeo ni una CLI de exportación asumida.

El adapter browser standalone recibe un workspace port; su timeout no cancela
trabajo ni constituye sandbox. El editor tiene una composición de workspace-agent,
pero la entrada UI no registra esas tools como servicio de navegador.
Headless sí registra las cinco tools sobre stdio y usa persistencia filesystem;
[deployment](deployment.md) explica roots/environment y lifecycle sin endpoint HTTP.
Su sección estática conserva notas históricas: hoy hay entrada editor versionada,
pero no `netlify.toml`. Para QA separa fixture, SDK y entrada real usando la
[guía existente de navegador](browser-testing.md), nunca globals de fixture como API productiva.
