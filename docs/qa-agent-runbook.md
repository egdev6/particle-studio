# Runbook de QA para agentes (Playwright y familia pública)

Guía ejecutable para un agente de QA que verifique el proyecto **implementado hoy**.
No es un recibo de ejecución: los comandos y resultados esperados son instrucciones.
Durante la autoría de este runbook **no** se ejecutaron tests, servidores ni builds
(estado `NOT_RUN`); esa condición histórica se conserva. La ejecución QA es otra cosa:
cuando el agente la corra, graba reporte/trace/screens/video en directorios owned como
artefactos y no deriva un `PASS` de lo que este documento describe.

Ruta: [inicio](../README.md) · [manual funcional](functional-guide.md) ·
[matriz de capacidades](boundary-matrix.md) · [headless](../apps/headless-mcp/README.md).

## 1. Preflight y versiones

Baseline observado de este árbol, no garantía atemporal: Node 24.20.x, npm 12.0.2,
`@playwright/test` **1.63.0** (Chromium revision **1243** fijada por esa versión).
Registra el entorno real y, si cambió, trátalo como entorno distinto.

| Superficie | Puerto / ruta | Qué es |
| --- | --- | --- |
| Dev Vite | `127.0.0.1:4173` | `npm run dev`; loopback, `strictPort` |
| Fixture API | `127.0.0.1:4175` | Harness de tests con exports `window`; **no** producción |
| Preview de build | `127.0.0.1:4176` | `npm run build && npm run preview`; producto real |

[`vite.config.ts`](../vite.config.ts) fija puertos estrictos. Si un puerto está
ocupado, **BLOCKED**: no reutilices ni mates un servidor desconocido.

## 2. Config nativa de Playwright

[`playwright.config.ts`](../playwright.config.ts) define `workers: 1`, `retries: 0`,
`headless: true`, `reuseExistingServer: false` y **dos** `webServer` owned: el fixture
(4175) y `npm run build && npm run preview` (4176). Ambos arrancan **aunque** el
comando sea enfocado. Sintaxis exacta, con la ruta **antes** del flag:

```sh
npx playwright test apps/editor/tests/browser/rectangle-create.spec.ts --project=chromium-preview
npx playwright test apps/editor/tests/browser/set-shape-opacity-api.spec.ts --project=chromium
```

`npm run test:browser` ejecuta ambos proyectos. No inventes proyectos nuevos ni un
framework distinto. La selección de CI (rama develop/main) no autoriza cambios de ruteo.

## 3. Aislamiento obligatorio

- Usa un **contexto/perfil fresco y owned** y datos QA propios. El editor restaura el
  slot IndexedDB `particle-studio-browser-viewer`, documento `browser-document`, del
  origen abierto.
- **Nunca** borres, resetees ni “sembres” ese slot en un perfil real/ajeno, ni uses un
  fallback para ocultar un draft del usuario. Si no puedes garantizar aislamiento, **BLOCKED**.
- Playwright MCP interactivo sólo con perfil/contexto owned garantizado; si no,
  **BLOCKED** (`browser_reset` no es workaround). La ruta portable `@playwright/test`
  es la preferida; si falta Chromium, **BLOCKED**.
- Registra IDs de contexto/recurso, PID de servidor, logs y rutas propias; cierra
  **sólo** tus recursos y conserva la evidencia.
- `page.reload` en el **mismo** contexto owned prueba lectura en frío del draft
  persistido. Un contexto nuevo no garantiza restaurar datos efímeros (p. ej. selección).

## 4. Semántica de resultados

| Estado | Significado |
| --- | --- |
| `PASS` | El resultado observado coincide con lo esperado y la evidencia lo respalda |
| `FAIL` | Resultado observado distinto de lo esperado |
| `BLOCKED` | Falta entorno/capacidad (proyecto, aislamiento, Docker) o hay colisión de puerto |
| `NOT_RUN` | No ejecutado; este runbook no afirma ejecución |

Un `PASS` de UI happy-path o screenshot **no** demuestra toda la biblioteca. Screenshots
y jsdom solos no prueban CAS, historial/pointers, bytes canónicos, SHA de assets nativos,
holds forzados ni cierre de bitmap una vez.

## 5. Clases de evidencia

| Clase | Superficie | Puede probar | No prueba por sí sola |
| --- | --- | --- | --- |
| Producción | Preview 4176, entrada real | Nueve acciones + Inspector con bytes/IDB reales | Biblioteca completa |
| Fixture API | 4175, exports `window` | Facade/API con SHA/PNG/IDB nativos | Que los controles reales existan |
| UI jsdom | Vitest `ui` | Inputs, selección, activity, listeners | Entrada build, bytes nativos |
| SDK Node | Vitest `core` | Workflows, guards, invariantes | Native CAS/bitmap |
| Headless stdio | Vitest `integration` | Protocolo MCP, persistencia FS | HTTP/servicio |
| Docker | Contrato/smoke | Contenedor y lifecycle | deployment estático |

## 6. Escenarios de UI (producción 4176)

Selección por labels exactos. Preflight: bootstrap (sección 8), `build`+`preview`, contexto owned.

| Paso | Selector / campo exacto | Entrada | Resultado esperado |
| --- | --- | --- | --- |
| 1 | **Create blank scene** | ninguno | Status primario **Scene created**; canvas 256×160 en blanco |
| 2 | **Add rectangle** (Rectangle x/y/width/height) | 16 / 100 / 20 / 12 | Rectángulo en root; **Rectangle creation status** |
| 3 | **Position X**, **Position Y**, **Apply position** | 20 / 100 | Se publica par; selección se limpia |
| 4 | **Dimension width**, **Dimension height**, **Apply dimensions** | 24 / 14 | Par publicado; **Dimension status** |
| 5 | **Shape opacity**, **Apply opacity** | 0.5 | Negro alpha≈128 en píxel (24,104) |
| 6 | **Shape fill color**, **Apply fill color** | `#FF0000` | Rojo `[255,0,0,128]` con la opacidad previa; **Fill color status** |
| 7 | **PNG file** + PNG x/y/width/height | File PNG, 180 / 40 / 8 / 8 | Imagen black alpha255 en (181,45); sin ocluir |
| 8 | **Shape visible**, **Apply visibility** | sin marcar | Bandera `false` authored; la shape no se dibuja y el PNG permanece; **Visibility status** |
| 9 | **Scene element** + **Published element JSON** | ninguna | Metadata read-only del elemento elegido |

Tras **cada** publicación (pasos 3–8), **reselecciona** en **Scene element** antes de
editar: toda publicación nueva avanza revisión aunque el valor sea igual. Los edits
son sólo para **shape**; group y las demás variantes no-shape quedan read-only y no
hay picking por coordenadas. La visibilidad se prefija marcada (`true`) sin insertar
nada hasta **Apply visibility**; aplicar el mismo booleano vuelve a publicar, y una
marca local `true` no anula un group ancestro oculto.

### Escena JSON manual (root y nested)

Importa con **Editable JSON** + **Import editable JSON**. El documento completo es el
del [manual funcional, sección 2](functional-guide.md): root `shape-root` en
x/y 100/24, 40×48; grupo con `transform [1,0,0,1,24,12]`; `shape-nested` local 16/24,
32×24. Comportamiento esperado tras **Import complete**:

- Selecciona `shape-nested`: **Position X/Y** muestra **16/24** authored, **no** el
  mundo 40/36 (el grupo traslada al dibujar).
- `shape-nested` opacity 0 → alfa 0 en (44,40); `shape-root` sigue alfa 255 en (110,30).
- **page.reload** en el mismo contexto mantiene esos píxeles y **limpia** selección.

Tracks pueden sobrescribir la opacidad base. La fuente es el fixture de
[set-shape-opacity.spec.ts](../apps/editor/tests/browser/set-shape-opacity.spec.ts):
con playback start 500000 y un track linear 0.25→0.75, el valor evaluado es 0.5
(alfa 128) frente a 0.25 (alfa 64) en tiempo 0 del [API](../apps/editor/tests/browser/set-shape-opacity-api.spec.ts). El JSON manual y el seed de
[headless](../apps/headless-mcp/README.md) declaran `tracks: []`, así que aquí
authored == evaluado.

### Exclusión, busy y warnings

Con un paso en vuelo, las nueve acciones y la selección quedan excluidas. Un rechazo
de guard (vacío/no finito/fuera de rango; >0 en dimensiones, 0..1 en opacidad;
`#RRGGBB` ASCII exacto sin recorte, normalización ni coerción en color; booleano
estricto en visibilidad) exige corrección y activación explícita: no hay clamp, retry
ni rebase. Un mensaje **published, but rendering failed** significa commit durable,
**no** rollback ni rechazo. No hay UI de undo/redo, timeline, autosave, rotation,
export/download ni vídeo.

### Prueba nativa directa y casos negativos

Los guards duros (CAS, historial/pointers, bytes canónicos, SHA de assets, cierre de
bitmap una vez, holds forzados) viven en specs nativos instrumentados, no en
screenshots ni hooks privados. Producción `chromium-preview` (4176):

| Flujo | Spec nativo |
| --- | --- |
| Startup/saved-only y creación blank | [static-viewer.spec.ts](../apps/editor/tests/browser/static-viewer.spec.ts) · [durable-import.spec.ts](../apps/editor/tests/browser/durable-import.spec.ts) |
| Import JSON/PNG, CAS, pagehide | [durable-import.spec.ts](../apps/editor/tests/browser/durable-import.spec.ts) · [png-import.spec.ts](../apps/editor/tests/browser/png-import.spec.ts) |
| Rectangle, holds, assets | [rectangle-create.spec.ts](../apps/editor/tests/browser/rectangle-create.spec.ts) |
| Inspector, metadata, zero-effect | [element-inspector.spec.ts](../apps/editor/tests/browser/element-inspector.spec.ts) |
| Position | [set-shape-position.spec.ts](../apps/editor/tests/browser/set-shape-position.spec.ts) |
| Dimensions (17 casos, seis holds) | [set-shape-dimensions.spec.ts](../apps/editor/tests/browser/set-shape-dimensions.spec.ts) |
| Opacity (24 casos, siete holds) | [set-shape-opacity.spec.ts](../apps/editor/tests/browser/set-shape-opacity.spec.ts) |
| Fill color (17 casos, mismo spec de opacidad) | [set-shape-opacity.spec.ts](../apps/editor/tests/browser/set-shape-opacity.spec.ts) |
| Visibility (21 casos) | [set-shape-visibility.spec.ts](../apps/editor/tests/browser/set-shape-visibility.spec.ts) |

No hay `create-blank-scene.spec.ts`: la creación blank se prueba dentro de
`durable-import.spec.ts`. API de fixture no productiva `chromium` (4175):
[browser-platform.spec.ts](../apps/editor/tests/browser/browser-platform.spec.ts) ·
[editor-frame.spec.ts](../apps/editor/tests/browser/editor-frame.spec.ts) ·
[set-shape-dimensions-api.spec.ts](../apps/editor/tests/browser/set-shape-dimensions-api.spec.ts) ·
[set-shape-opacity-api.spec.ts](../apps/editor/tests/browser/set-shape-opacity-api.spec.ts).

Son expectativas del flujo manual, no coordenadas exactas del fixture nativo. Los
conteos son históricos y de este árbol, no universales: la base pública de navegador
es 197 casos (35 del fixture API `chromium` y 162 de `chromium-preview`), medida antes
de esta sesión y no un recibo fresco; un screenshot no sustituye estas pruebas
instrumentadas.

### Receta portable ejecutable (API @playwright/test)

Asume un preview OWN en 4176 ya arrancado con PID conocido y readiness verificada; si
el puerto está tomado o falta Chromium, **BLOCKED** (no reutilices ni mates servidores
ajenos). El driver importa sólo `@playwright/test`, `node:fs` y `node:assert`; lee el
JSON manual del primer fence de [functional-guide](functional-guide.md), usa el PNG 1×1
canónico ya verificado vía `setInputFiles` en memoria y no toca exports `window` ni
fixtures de 4176. No evalúes el SDK por bare Node ESM (limitación known de Ajv/loader).

Desde la raíz, crea `QA_ROOT=$(mktemp -d)` y guarda el bloque sólo en
`"$QA_ROOT/driver.mjs"`. Ejecútalo con
`node --input-type=module - < "$QA_ROOT/driver.mjs"`: los imports resuelven desde la raíz.

```js
// Bloque para "$QA_ROOT/driver.mjs"; ejecútalo por stdin desde la raíz del repo.
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const BASE = "http://127.0.0.1:4176";
const manualJson = readFileSync("docs/functional-guide.md", "utf8").match(/```json\n([\s\S]*?)```/)[1];
const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

const browser = await chromium.launch();
const context = await browser.newContext();
try {
  const page = await context.newPage();
  const waitText = (sel, text) => page.waitForFunction(([s, t]) => document.querySelector(s)?.textContent.includes(t), [sel, text]);
  const waitCleared = () => page.waitForFunction(() => document.querySelector("#scene-element")?.value === "");
  const waitOptions = (n) => page.waitForFunction((c) => document.querySelectorAll("#scene-element option:not([value=''])").length >= c, n);
  const lastOptionId = () => page.locator("#scene-element option:not([value=''])").last().getAttribute("value");
  const pixel = (x, y) => page.evaluate(({ x, y }) => {
    const canvas = document.querySelector("#scene");
    return Array.from(canvas.getContext("2d").getImageData(x, y, 1, 1).data);
  }, { x, y });

  await page.goto(BASE);
  await page.getByRole("button", { name: "Create blank scene" }).click();
  await waitText("#status", "Scene created");

  await page.locator("#rectangle-x").fill("16");
  await page.locator("#rectangle-y").fill("100");
  await page.locator("#rectangle-width").fill("20");
  await page.locator("#rectangle-height").fill("12");
  await page.getByRole("button", { name: "Add rectangle" }).click();
  await waitOptions(2);
  const shapeId = await lastOptionId();
  await page.locator("#scene-element").selectOption(shapeId);

  await page.locator("#position-x").fill("20");
  await page.locator("#position-y").fill("100");
  await page.getByRole("button", { name: "Apply position" }).click();
  await waitCleared();
  await page.locator("#scene-element").selectOption(shapeId);

  await page.locator("#dimension-width").fill("24");
  await page.locator("#dimension-height").fill("14");
  await page.getByRole("button", { name: "Apply dimensions" }).click();
  await waitCleared();
  await page.locator("#scene-element").selectOption(shapeId);

  await page.locator("#shape-opacity-value").fill("0.5");
  await page.getByRole("button", { name: "Apply opacity" }).click();
  await waitText("#opacity-status", "complete");
  await waitCleared();
  await page.locator("#scene-element").selectOption(shapeId);
  assert.deepEqual(await pixel(24, 104), [0, 0, 0, 128]);

  await page.locator("#shape-fill-color-value").fill("#FF0000");
  await page.getByRole("button", { name: "Apply fill color" }).click();
  await waitText("#fill-color-status", "complete");
  await waitCleared();
  await page.locator("#scene-element").selectOption(shapeId);
  assert.deepEqual(await pixel(24, 104), [255, 0, 0, 128]);
  assert.equal(JSON.parse(await page.locator("#element-details").textContent()).fillColor, "#FF0000");

  await page.locator("#png-file").setInputFiles({ name: "one.png", mimeType: "image/png", buffer: onePixelPng });
  await page.locator("#png-x").fill("180");
  await page.locator("#png-y").fill("40");
  await page.locator("#png-width").fill("8");
  await page.locator("#png-height").fill("8");
  await page.getByRole("button", { name: "Import PNG" }).click();
  await waitText("#png-status", "PNG import complete");
  assert.deepEqual(await pixel(181, 45), [0, 0, 0, 255]);

  await page.locator("#scene-element").selectOption(shapeId);
  await page.locator("#shape-visible").uncheck();
  await page.getByRole("button", { name: "Apply visibility" }).click();
  await waitText("#visibility-status", "complete");
  await waitCleared();
  await page.locator("#scene-element").selectOption(shapeId);
  assert.equal(JSON.parse(await page.locator("#element-details").textContent()).visible, false);
  assert.equal((await pixel(24, 104))[3], 0);
  assert.deepEqual(await pixel(181, 45), [0, 0, 0, 255]);
  await page.reload();
  await waitText("#status", "restored");
  await page.locator("#scene-element").selectOption(shapeId);
  assert.equal(await page.locator("#shape-visible").isChecked(), false);
  assert.equal((await pixel(24, 104))[3], 0);
  assert.deepEqual(await pixel(181, 45), [0, 0, 0, 255]);
  await page.locator("#shape-visible").check();
  await page.getByRole("button", { name: "Apply visibility" }).click();
  await waitText("#visibility-status", "complete");
  await waitCleared();
  await page.locator("#scene-element").selectOption(shapeId);
  assert.deepEqual(await pixel(24, 104), [255, 0, 0, 128]);
  const revisionBefore = await page.locator("#element-status").textContent();
  await page.getByRole("button", { name: "Apply visibility" }).click();
  await waitText("#visibility-status", "complete");
  await waitCleared();
  await page.locator("#scene-element").selectOption(shapeId);
  assert.notEqual(await page.locator("#element-status").textContent(), revisionBefore);

  await page.locator("#editable-json").fill(manualJson);
  await page.getByRole("button", { name: "Import editable JSON" }).click();
  await waitText("#status", "Import complete");
  await page.locator("#scene-element").selectOption("shape-nested");
  assert.equal(await page.locator("#position-x").inputValue(), "16");
  assert.equal(await page.locator("#position-y").inputValue(), "24");
  assert.match(await page.locator("#element-details").textContent(), /shape/);

  await page.locator("#shape-opacity-value").fill("0");
  await page.getByRole("button", { name: "Apply opacity" }).click();
  await waitText("#opacity-status", "complete");
  await waitCleared();
  await page.locator("#scene-element").selectOption("shape-nested");
  assert.equal((await pixel(44, 40))[3], 0);
  assert.deepEqual(await pixel(110, 30), [0, 0, 0, 255]);

  await page.reload();
  await waitText("#status", "restored");
  assert.equal(await page.locator("#scene-element").inputValue(), "");
  assert.equal((await pixel(44, 40))[3], 0);
  assert.deepEqual(await pixel(110, 30), [0, 0, 0, 255]);
} finally {
  await context.close();
  await browser.close();
}
```

### Batería visual integral (Playwright, ejecutable)

El recorrido progresivo encadena las nueve acciones y el Inspector mediante UI pública
en **chromium-preview** (4176). El spec registrado es
`apps/editor/tests/browser/qa-production-journey.spec.ts`: seis casos, root/nested en
viewport desktop 1440×1000 y estrecho 390×900, ancestro oculto e inputs inválidos/no-shape.
Los inválidos son texto/números/JSON representables en la UI; un booleano inválido no
puede introducirse por el checkbox nativo. Comando sobre la config raíz:

```sh
npx playwright test apps/editor/tests/browser/qa-production-journey.spec.ts --project=chromium-preview --workers=1 --retries=0 --headed --trace=on
```

El reporte HTML, trace, screenshots y vídeo van a directorios owned elegidos en runtime
por el parent; no fijes rutas absolutas ni privadas. Los viewports desktop/mobile sólo
comprueban que la UI es alcanzable: no son una auditoría WCAG ni un `PASS` de
accesibilidad.

## 7. Complementos de familia pública (Vitest y CLI)

Comandos exactos por capa; sustituye rutas por las de `--project` correspondiente.

| Familia | Comando enfocado | Esperado | Fuente |
| --- | --- | --- | --- |
| Schema/canónico/validator | `npx vitest run --project core packages/scene-document/tests` | Validación, JCS, contrato/generación del validador | [tests](../packages/scene-document/tests) |
| Commands | `npx vitest run --project core packages/commands/tests` | Actor, historial y 5 primitivas shape | [tests](../packages/commands/tests) |
| Runtime | `npx vitest run --project core packages/runtime/tests` | `evaluateScene`/`createTimelineTransport` | [tests](../packages/runtime/tests) |
| Renderer | `npx vitest run --project integration packages/renderer-canvas2d/tests` | Contrato de comandos Canvas2D | [tests](../packages/renderer-canvas2d/tests) |
| Editor SDK/facade | `npx vitest run --project core apps/editor/tests` | Session/facade, reload, IDs | [tests](../apps/editor/tests) |
| Editor UI jsdom | `npx vitest run --project ui apps/editor/tests` | Controles, listener, activity | [tests](../apps/editor/tests) |
| IDB / FS | `npx vitest run --project core packages/persistence-indexeddb/tests packages/persistence-fs/tests` | CAS, assets, límites | [IDB](../packages/persistence-indexeddb/tests) · [FS](../packages/persistence-fs/tests) |
| Persistence core (dominio, no GUI) | `npx vitest run --project core packages/persistence/tests` | Revisiones/pointers, recovery, coordinator y dominio autosave | [tests](../packages/persistence/tests) |
| Headless workspace | `npx vitest run --project core apps/headless-mcp/tests` | Workspace, envelope y política de actor | [tests](../apps/headless-mcp/tests) |
| Export | `npx vitest run --project core packages/export/tests` | 4 mapas virtuales y bound HTML | [tests](../packages/export/tests) |
| WebMCP | `npx vitest run --project core packages/webmcp-adapter/tests` | Dispatcher y política human-only | [tests](../packages/webmcp-adapter/tests) |
| Headless stdio | `npx vitest run --project integration apps/headless-mcp/tests-integration` | 5 tools, lifecycle, drenado | [tests](../apps/headless-mcp/tests-integration) |

Export: ESM/web component/IIFE/self-contained HTML en **memoria**; sin descarga UI ni
vídeo. HTML limita a 10,485,760 bytes de assets únicos embebidos. WebMCP/browser-agent:
cinco comandos shape estrechos exigen human-ui (política de envelope, no autenticación).
Headless: 5 tools por stdio
(`stdout` protocolo, `stderr` diagnósticos), EOF/SIGTERM drenan hasta 5 s; exit 0 solo
no prueba respuestas completas; **no** hay HTTP/health/puerto. El envelope de dispatch
tiene exactamente 5 keys: `commandSchemaVersion`, `commandId`, `documentId`,
`expectedRevision`, `payload`. `commandId`/`documentId` los aporta el caller; el
workspace inyecta **sólo** `actorCapability: "headless-agent"` y no acepta una key de
actor del caller. En `create-element` no envías `id`: la fuente UUID con prefijo lo
asigna. Detalle: [headless](../apps/headless-mcp/README.md).

## 8. Bootstrap y límites de toolchain

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run validator:prepare
npm run build
```

`validator:prepare` genera y verifica el validador; un mismatch falla cerrado (no
editar output/huellas). Ejecútalo tras la familia scene-document y **antes** de
SDK/UI/headless/build. Los tests de generación pueden limpiar el `.mjs` y **no**
re-preparan solos: vuelve a correr `validator:prepare`. En CI, `npm run typecheck`
ejecuta el mismo guion ordenado (persistence emite antes de headless).

- `npm run typecheck` (raíz) ejecuta las pruebas de contrato del runner integrado y
  luego los once proyectos ordenados: persistence emite declaraciones y el resto usa
  `--noEmit`. Es el mismo guion que invoca la CI; no requiere `tsconfig.json` raíz.
- Performance no está implementado: no hay proyecto `chromium-performance` ni script
  que ejecutar. No inventes el proyecto ni declares performance verde.
- Importar el SDK por bare Node ESM (`-e`) puede fallar por contexto de loader/Ajv
  (`require`) en este árbol; no lo presentes como salud universal del SDK. La entrada
  headless documentada sí funciona desde raíz: `node --import tsx apps/headless-mcp/src/main.ts`.
- Los tests de generación del validador pueden borrar el `.mjs`; **no** re-preparan
  solos. Stderr `VALIDATOR_*` / `ERR_PACKAGE_PATH_NOT_EXPORTED` en casos negativos son
  intencionales: distingue salida real de fallo.

## 9. Docker opcional

Si existe Docker en tu entorno, el contrato/contenedor se verifica con los comandos de
[deployment](deployment.md). Sin Docker, marca **BLOCKED**; no hay limpieza global ni
reset. Conserva datos QA propios y detén procesos antes de cualquier limpieza explícita
de tus propios artefactos.

## 10. Plantilla de evidencia

```text
resultado: PASS | FAIL | BLOCKED | NOT_RUN
gitsha: <fddacf6...>   tree: <a063...>
untracked_scope: <rutas propias>
versiones: node/npm/playwright/chromium
origen: <URL:puerto>   clase: producción|fixture|jsdom|SDK|stdio|docker
contexto: <id owned>   servidor_pid: <pid>   raiz_qa: <path owned>
comando: <exacto>   exit: <code>   counts: <n passed/ failed>
trace/log/screenshot: <path propio>
RGBA esperado: <px, valor>   observado: <valor>
prueba nativa: <spec + comando/status observado>
```

Triaje: reproduce en contexto owned; si un guard rechaza, corrige la entrada, no la
assertion; nunca borres el slot real; si falta proyecto/entorno, reporta **BLOCKED** con
el comando exacto. Este runbook no ejecuta ni aprueba el producto completo, ni fija un
conteo universal de suite.
