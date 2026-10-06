# Particle Studio

Particle Studio es un proyecto modular para validar, editar, persistir y evaluar
escenas 2D. Incluye un editor local Canvas2D, bibliotecas de dominio y un workspace
headless con MCP por stdio. Este índice describe el **alcance implementado hoy**:
no presenta un producto terminado ni equipara capacidades del SDK con botones UI.

## Empezar con el editor local

Desde la raíz, con **Node 24.20.x y npm 12.0.2**, versiones declaradas en
[`package.json`](package.json):

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run validator:prepare
npm run dev
```

Abre `http://127.0.0.1:4173`. Para servir el resultado de producción, en lugar del
dev server:

```sh
npm run build
npm run preview
```

Preview usa `http://127.0.0.1:4176`; ambos servidores son loopback con puerto
estricto. `build` escribe `apps/editor/dist`. Los scripts dev/build/preview preparan
el validador mediante sus hooks; prepararlo explícitamente sirve también al SDK.
Estos comandos son instrucciones, **no un recibo de ejecución de esta guía**.

El editor restaura el slot IndexedDB `particle-studio-browser-viewer`, documento
`browser-document`, del perfil/origen abierto. No presupongas un estado vacío.
En un slot sano sin draft muestra una muestra **no persistida**: usa **Create blank
scene** o importa JSON para obtener un documento editable. Un fallo de startup no
habilita un reset ni una creación de reemplazo.

Para QA usa un contexto nuevo, aislado y propio; no borres ni reutilices datos de
un perfil de trabajo. Consulta [pruebas de navegador](docs/browser-testing.md)
antes de arrancar Playwright: su fixture API usa 4175, no la entrada de producción.

## Ruta de lectura

| Necesidad | Documento |
| --- | --- |
| Entender responsabilidades y contratos | Mapa del proyecto (`docs/overview.md`, pendiente en esta cadena) |
| Saber qué existe en dominio, SDK, UI y QA | Matriz de fronteras (`docs/boundary-matrix.md`, pendiente en esta cadena) |
| Operar el editor y encontrar rutas no UI | Manual funcional (`docs/functional-guide.md`, pendiente en esta cadena) |
| Usar acciones, selección y edición de shapes | [Editor](apps/editor/README.md) |
| Distinguir preview real de fixtures nativos | [Browser testing](docs/browser-testing.md) |
| Ejecutar QA reproducible con un agente Playwright | Runbook de QA (`docs/qa-agent-runbook.md`, pendiente en esta cadena) |
| Crear, editar, persistir y exportar una escena por SDK | Cookbook del SDK (`docs/sdk-cookbook.md`, pendiente en esta cadena) |
| Conectar las cinco tools MCP sobre un workspace propio | Headless MCP (`apps/headless-mcp/README.md`, pendiente en esta cadena) |
| Ejecutar el contenedor headless local por stdio | [Deployment](docs/deployment.md) |

## Contratos por paquete

- [SceneDocument](packages/scene-document/README.md): esquema v1, validación y aprobación canónica.
- [Runtime](packages/runtime/README.md): evaluación temporal y transporte en memoria.
- [Canvas2D](packages/renderer-canvas2d/README.md): dibujo de comandos ordenados.
- [Commands](packages/commands/README.md): edición revisionada, historial y políticas de actor.
- [Persistence](packages/persistence/README.md): revisiones, puertos, recuperación y aprobación.
- [Filesystem](packages/persistence-fs/README.md): confinamiento y publicación en disco.
- [IndexedDB](packages/persistence-indexeddb/README.md): almacenamiento local y transacciones.
- [Export](packages/export/README.md): cuatro formatos de mapas virtuales aprobados.
- [WebMCP adapter](packages/webmcp-adapter/README.md): dispatcher standalone, no registro automático.

## Verificación y límites

La [CI enfocada](.github/workflows/ci.yml) separa core, controles UI, integración,
Chromium y once proyectos TypeScript. Usa las instrucciones enfocadas de cada
paquete y respeta su preparación/orden: persistence emite antes de sus consumidores.
`npm run typecheck` ejecuta las pruebas de contrato del runner integrado y luego el
mismo guion ordenado de once proyectos que usa la CI. Vite tampoco typecheckea.

Undo/redo, timeline, autosave y exportación existen en capas de dominio, pero no
son controles del editor actual. Los exports son archivos virtuales en memoria,
no descargas UI ni PNG/vídeo. El headless no sirve HTTP; tampoco hay configuración
Netlify versionada. El código y la configuración actuales prevalecen sobre notas
históricas de las guías especializadas; cobertura descrita no significa prueba ejecutada.
