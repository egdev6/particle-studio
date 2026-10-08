# Manual funcional de Particle Studio

Usa esta guía para operar el editor local y encontrar las interfaces de biblioteca
y headless del proyecto. **Los botones actuales son nueve acciones y un Inspector**;
no representan todas las capacidades del dominio. Los ejemplos describen el
comportamiento implementado, no pruebas ejecutadas ni una aprobación de QA.

Ruta: [inicio y bootstrap](../README.md) · [arquitectura](overview.md) ·
[matriz de capacidades y evidencia](boundary-matrix.md).

## 1. Abrir y reconocer el estado

Sigue el bootstrap del índice con Node 24.20.x/npm 12.0.2. Dev usa 4173;
`build` seguido de `preview` usa 4176. Ambos son loopback con puerto estricto.
El fixture API de tests en 4175 **no** es esta interfaz de producción.

El slot local es IndexedDB `particle-studio-browser-viewer`, documento
`browser-document`, en el perfil/origen abierto. Trabajar aquí publica datos locales:
no presupongas que está vacío ni lo borres para recuperar un error. Para QA abre
un contexto nuevo, aislado y propio; no manipules un perfil de trabajo compartido.

| Al abrir | Qué significa | Siguiente paso |
| --- | --- | --- |
| Muestra **unpersisted sample** | Slot vacío o saved-only sano; no hay draft editable | Crear una escena o importar JSON explícitamente |
| **restored draft** renderizado | Draft verificado con sus PNG locales; current genuino | Inspeccionar o editar |
| Loading/pending | Startup o trabajo aún no terminado | Esperar; no forzar submits |
| Error de startup | Storage, contenido, assets, contexto o render no utilizables | Diagnosticar; no seed/reset/fallback |

### Layout del editor

En escritorio, el canvas ocupa toda la pantalla por detrás del panel flotante, que reúne
todos los controles. Escala en proporción 16:10, sin deformar ni recortar la escena; el
panel tapa su parte derecha mientras editas:

- **Cabecera:** marca y título *JSON scene editor*.
- **Pestañas** *Scene* · *Create* · *Inspect*: son enlaces que desplazan el panel hasta
  cada sección. No ocultan contenido, así que todas las acciones siguen disponibles.
- **Pie:** el estado principal (`#status`).

**Hide panel**, arriba a la izquierda, oculta el panel para ver el canvas completo, y
**Show panel** lo recupera. Es solo un cambio de vista por ancla (`#canvas-focus`): no
cancela trabajo, no publica nada y no altera la selección.

Por debajo de 900 px el layout se apila (acciones de vista, canvas y panel) sin scroll
horizontal. El escalado del canvas es solo visual: el canvas lógico sigue siendo 256×160.

Los frames usan el `playbackRange.startUs` del documento en canvas 256×160.
La muestra no tiene autoridad de edición. Un error inicial mantiene controles
bloqueados; no convierte saved/sample en draft ni habilita creación de reemplazo.

## 2. Elegir una acción

| Acción exacta | Precondición / entrada | Resultado esperado al completar |
| --- | --- | --- |
| **Create blank scene** | Startup sano, sin current; ningún JSON/File | Draft real con group raíz vacío y canvas sin geometría |
| **Import editable JSON** | Startup sano; documento completo en **Editable JSON** | Nuevo draft validado y render de su playback start |
| **Import PNG** | Current genuino; **PNG file** y placement | Elemento image publicado con asset PNG local |
| **Add rectangle** | Current genuino; Rectangle x/y/width/height | Shape nueva en coordenadas raíz, opacity 1 |
| **Apply position** | Shape seleccionada; Position X/Y | Ambos ejes authored/local publicados juntos |
| **Apply dimensions** | Shape seleccionada; Dimension width/height | Ambas dimensiones authored/local publicadas juntas |
| **Apply opacity** | Shape seleccionada; Shape opacity | Sólo la opacidad base authored publicada |
| **Apply fill color** | Shape seleccionada; Shape fill color | Color `#RRGGBB` authored publicado, sin normalizar el caso |
| **Apply visibility** | Shape seleccionada; Shape visible | Bandera authored `true`/`false` publicada |

Cada activación captura su entrada una vez. Todas comparten activity frontend y
lane owned backend: mientras trabajan se excluyen las otras ocho, selección e inputs,
incluso ante eventos forzados o llamadas directas. No hay una cola UI de segundos edits.

### Crear sin JSON

1. En un slot sano sin current, pulsa **Create blank scene**.
2. Espera **Scene created** y el frame vacío; no esperes una shape seleccionada.
3. Usa **Add rectangle** o **Import PNG** para añadir geometría.

La escena creada tiene duración 1,000,000 µs, rango 0–1,000,000, loop true, seed 42,
tracks vacíos y una raíz group vacía. Se publica mediante el flujo JSON y conserva
saved en un slot saved-only. El botón queda deshabilitado si ya existe current:
**no es un reset ni una forma de sobrescribir el draft**.

### Importar una escena completa

Copia este JSON sin assets en **Editable JSON** y pulsa **Import editable JSON**.
Incluye una shape raíz y otra bajo un group trasladado, para reconocer coordenadas
locales. Pegar texto aún no cambia la publicación ni el Inspector.

```json
{
  "schemaVersion": 1,
  "durationUs": 1000000,
  "playbackRange": { "startUs": 0, "endUs": 1000000 },
  "loop": true,
  "seed": 42,
  "rootIds": ["shape-root", "group-1"],
  "elements": [
    {
      "id": "shape-root",
      "type": "shape",
      "x": 100, "y": 24,
      "width": 40, "height": 48,
      "opacity": 1
    },
    {
      "id": "group-1",
      "type": "group",
      "childrenIds": ["shape-nested"],
      "transform": [1, 0, 0, 1, 24, 12]
    },
    {
      "id": "shape-nested",
      "type": "shape",
      "x": 16, "y": 24,
      "width": 32, "height": 24,
      "opacity": 1
    }
  ],
  "tracks": []
}
```

Tras **Import complete**, el frame contiene ambas shapes; la nested mantiene X/Y
16/24 authored, aunque el group la traslade al dibujar. La selección queda vacía.
JSON importado puede sustituir un current; revisa lo que vas a publicar. No hay
botón de reset, export JSON/download ni autosave de lo escrito en el textarea.

JSON con imágenes requiere que sus assets referenciados ya existan en el storage
local; pegar SHA/metadatos no inserta bytes. JSON malformado, versión desconocida,
assets ausentes o fuente stale rechazan sin sustituir el frame/publicación usable.
Los contratos completos de las seis variantes están en [SceneDocument](../packages/scene-document/README.md).

### Insertar PNG y añadir rectangle

Para PNG, parte de una creación/importación/restauración genuina. Elige un archivo
PNG válido propio en **PNG file**: el repositorio no contiene un PNG físico que
esta guía pueda prometer. Un File no otorga autoridad sobre los bitmaps decodificados.

1. Ajusta **PNG x**, **PNG y**, **PNG width**, **PNG height**; defaults 0/0/64/64.
2. Por ejemplo, sobre la escena anterior usa 180/40/8/8 para no solapar sus shapes.
3. Pulsa **Import PNG** y espera **PNG import complete**; un PNG con contenido
   visible aparecerá en ese placement. No necesitas cambiar el JSON del textarea.
4. Elige su image en **Scene element** para ver SHA, MIME, longitud y tamaño intrínseco,
   no handles ni bytes. Recargar debe restaurar también sus referencias locales.

X/Y deben ser finitos; width/height, finitos positivos. Opacity de inserción es 1.
La publicación verifica SHA/bytes, decodifica PNG y conserva su handle útil.
Fallos de File, MIME/contenido, placement, reread/decode o fuente dejan el frame previo;
**pueden haber escrito bytes inmutables antes de fallar**. No prometen rollback de
assets, limpieza ni garbage collection. El mensaje específico está en **PNG import status**.

Para rectangle, introduce **Rectangle x/y/width/height** y pulsa **Add rectangle**.
Defaults 16/24/120/80, con opacity 1; mismas restricciones finito/positivo, sin File
ni JSON. Se añade en unidades de escena raíz, no como hija del group seleccionado.
Consulta **Rectangle creation status**; no modifica las referencias PNG existentes.

## 3. Inspeccionar y editar una shape publicada

Elige **Scene element**. El dropdown recorre elementos en orden documental, incluidos
groups y las variantes shape/line/particle/text/image. **Published element JSON**
es read-only y muestra metadata authored de esa publicación: no tracks evaluados,
texto JSON sin enviar, buffers ni handles. Crear un objeto no lo autoselecciona.
Groups y las otras cuatro variantes no-shape siguen inspeccionables, sin estos edits.
No hay picking por canvas, drag, highlights ni edición mediante el texto de una option.

Selecciona `shape-nested` del ejemplo para ver sus valores locales, no los mundiales.
El token de selección liga documentId/revisionId/elementId; no es permiso para editar
otra fuente ni para adoptar recursos. Los guards SDK vuelven a comprobar la fuente.

| Campos / botón | Regla para solicitudes nuevas | Ejemplo |
| --- | --- | --- |
| **Position X**, **Position Y** / **Apply position** | Par no vacío y finito; negativos/fracciones válidos | -4.5 / 30 |
| **Dimension width**, **Dimension height** / **Apply dimensions** | Par no vacío, finito y estrictamente positivo | 20.5 / 12 |
| **Shape opacity** / **Apply opacity** | No vacía, finita en [0,1]; 0/-0/fracciones/1 válidos | 0.5 |
| **Shape fill color** / **Apply fill color** | `#RRGGBB` ASCII exacto de siete caracteres, sin alfa ni shorthand; el caso se preserva | `#3Fa9F5` |
| **Shape visible** / **Apply visibility** | Booleano estricto `true`/`false`; no coerciona texto ni número | sin marcar (`false`) |

Los controles numéricos usan inputs `type=number`: el navegador puede convertir una
cadena inválida en valor vacío. El controlador rechaza vacío, no lo toma como cero;
y comprueba finitud/rango, sin depender sólo de validación HTML nativa. **Shape fill
color** usa un input de texto y **Shape visible** un checkbox: exigen `#RRGGBB` exacto
y booleano estricto, sin coerción, recorte, clamp ni migración de schema.

El prefill es authored genuino: dimensiones heredadas cero/negativas y opacidad
-0.25/2 siguen importables y visibles. Sólo el nuevo edit exige el rango estrecho;
no hay clamp, migración ni coerción automática. Los edits preservan ID, otros campos,
hierarchy/transforms, tracks, configuración, saved y assets PNG.

**Reselecciona después de cada publicación nueva**, incluso si aplicaste valores
iguales o quedó el mismo element ID: revisión/secuencia/pointer avanzan y la selección
se limpia. Un rechazo same-source retiene selección e input escrito. No hay retarget,
retry ni rebase automático para una selección stale o un ganador de otra pestaña.

La visibilidad es authored por shape: sin bandera escrita la shape se dibuja
(`visible` ausente equivale a `true`). Una marca local `true` no anula un group
ancestro oculto: la shape sigue sin pintarse, pero **Apply visibility** es una
edición legítima que publica igual. Una shape oculta sigue siendo inspeccionable y
seleccionable; marcar y aplicar el mismo valor visible vuelve a publicar
revisión/secuencia/pointer nuevos.

Opacidad cero de una shape no borra ni libera las imágenes de la escena. Tracks
preservados pueden sobrescribir su valor base en playback start: éxito no garantiza
píxeles distintos. El ejemplo anterior no tiene tracks; una escena importada puede tenerlos.
Consulta **Position status**, **Dimension status**, **Opacity status**, **Fill color status**
y **Visibility status** por separado. Los cinco controladores conservan su propio
resultado al terminar el trabajo compartido; un edit externo refresca guidance a la
fuente current real.

## 4. Resolver errores sin perder autoridad de fuente

| Síntoma | Acción del usuario | No asumir |
| --- | --- | --- |
| Inputs vacíos/no finitos/fuera de rango | Corregir ambos campos del par o la opacidad y activar explícitamente | Que vacío equivalga a 0 o exista clamp |
| Color inválido (shorthand, alfa, nombre, espacios) | Corregir a `#RRGGBB` ASCII exacto y activar explícitamente | Que se recorte, normalice o acepte shorthand |
| Shape dentro de un ancestor oculto | Revisar la visibilidad del group en el JSON | Que la marca local `true` dibuje a través del ancestro |
| Selección vacía tras éxito | Reseleccionar en **Scene element** | Que stable ID permita reutilizar el token anterior |
| Edit/PNG bloqueado en sample | Crear o importar tras startup sano | Que sample sea un draft |
| Import JSON/PNG falla | Revisar documento, archivo, placement y assets locales | Que todos los stores hicieron rollback |
| Otra pestaña cambió el draft | Esperar settlement, refrescar explícitamente para revisar, reseleccionar | Retry/reload/rebase automático |
| Startup corrupto/missing asset/context/render | Conservar datos y registrar el error; diagnosticar storage/entorno | Borrar DB, sembrar muestra o crear para ocultarlo |
| **published, but rendering failed** en un edit | Tratarlo como commit durable; refrescar para ver la publicación | Rechazo de edición o rollback |
| Éxito opacity pero frame igual | Revisar tracks/playback start y la shape elegida | Que authored sea el valor evaluado |

El status primario del canvas es distinto de los estados nombrados de Inspector,
PNG, rectangle y los cinco edits. Un error de dibujo posterior a commit no deshace
publicación; el Inspector se refresca desde actual current aunque no se pudo pintar.
No uses fallos de render como señal para reenviar un comando sin revisar la fuente.

### Recarga y cierre

Una recarga explícita restaura el draft durable verificado y sus PNG, pinta en
playback start y borra selección. Texto/input aún no publicado no es una versión
persistida; no cuentes con recuperarlo. Guardar draft local no es aprobar ni exportar.

En `pagehide`, los cinco edit controllers se disponen antes del null del Inspector.
Se suprimen DOM/status/frame tardíos; el owner espera trabajo resuelto/rechazado y
cierra cada bitmap owned una vez, incluidos duplicados legítimos de prehidratación.
No debes cerrar handles prestados, cancelar la cola, vaciar cache o cerrar/eliminar
la DB como workaround. Los [contratos editor](../apps/editor/README.md) detallan lifetime.

## 5. Usar capacidades sin botón UI

Para consumidores de bibliotecas, prepara el validador antes de importar la cadena
SceneDocument/SDK. No son APIs `window` ni endpoints del fixture. Sigue cada contrato:

| Necesidad | Ruta pública / siguiente lectura |
| --- | --- |
| Validar/importar/exportar bytes JSON | `validateSceneDocument`, `canonicalizeSceneDocument`: [SceneDocument](../packages/scene-document/README.md) |
| Crear sesión revisionada, jerarquía, keyframes, undo/redo/fork | `createCommandSession`: [Commands](../packages/commands/README.md); payloads/actor no equivalen a auth |
| Evaluar o mover transporte en memoria | `evaluateScene`, `createTimelineTransport`: [Runtime](../packages/runtime/README.md); caller posee reloj/resolver |
| Dibujar comandos ordenados | `renderCommands`: [Canvas2D](../packages/renderer-canvas2d/README.md); contexto/handles son del caller |
| Revisiones, saved/draft, recovery y approval records | [Persistence core](../packages/persistence/README.md); ofertas no son restauración automática |
| Almacenar en navegador / disco | [IndexedDB](../packages/persistence-indexeddb/README.md) / [Filesystem](../packages/persistence-fs/README.md); atomicidad depende del adapter |
| Exportar escena aprobada | [Export](../packages/export/README.md): crear evidencia genuina/approval, aportar assets verificados y providers confiables, construir mapa y persistirlo como caller |
| Despachar tools a un workspace port | [WebMCP adapter](../packages/webmcp-adapter/README.md); host registra/autoriza, no la entrada UI |
| Operar draft headless por MCP stdio | [Guía headless](../apps/headless-mcp/README.md); raíces propias y cinco tools |
| Crear→editar→persistir→aprobar→exportar ESM | [Cookbook del SDK](sdk-cookbook.md) |

Export tiene ESM/web component/IIFE/HTML, no PNG/WebM/vídeo ni descarga UI. No se
puede sustituir aprobación branded por JSON plano ni omitir providers/asset reader.
Autosave/approvals existen en IDB, pero no están conectados como controles editor.
Tampoco hay undo/redo, rotation, timeline/keyframes o playback controls en UI.

La [facade browser](../apps/editor/src/browser-editor-session.ts) expone `start`,
`createScene`, `importJson`, `importPng`, `addRectangle`, los cinco `setShape*`,
`current`, `disposed` y `dispose`. Las solicitudes shape llevan documentId,
revisionId, elementId y el valor/par capturado de la fuente actual. La capability
`human-ui` de esas familias estrechas es política de envelope, no autenticación.
Returned current es rendering data prestada; el consumidor dibuja y suprime efectos
tardíos sin adquirir release/cache authority. No crees una segunda facade para eludir
el lane ni confundas esa interfaz de módulo con una API global instalada por la página.

## Siguiente paso

Para verificar, separa UI manual, SDK y prueba nativa con la [matriz](boundary-matrix.md)
y [browser-testing](browser-testing.md). Screenshots o jsdom solos no prueban CAS,
full canonical bytes/history/pointers ni ownership de cada bitmap. Esta guía no
aporta un resultado de ejecución y no autoriza limpiar perfiles o workspaces ajenos.
