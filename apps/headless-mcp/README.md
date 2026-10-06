# Usar el workspace headless por MCP stdio

Esta app opera un draft durable confinado con **cinco tools MCP por stdin/stdout**.
No sirve HTTP, editor, puertos ni health endpoint; no concede aprobación humana.
Ruta: [índice](../../README.md) · [manual del proyecto](../../docs/functional-guide.md)
· [matriz](../../docs/boundary-matrix.md) · [contenedor local](../../docs/deployment.md).

## 1. Preparar un workspace propio

Desde la raíz del repositorio, completa el [bootstrap](../../README.md) con
Node 24.20.x/npm 12.0.2 y `npm run validator:prepare` antes de importar la cadena.
El ejemplo siguiente crea **sólo datos nuevos y propios**: no uses roots de trabajo
ajenos, ni copies sobre un workspace existente. Es una receta, no un recibo de ejecución.

```sh
QA_ROOT=$(mktemp -d)
mkdir "$QA_ROOT/workspace" "$QA_ROOT/documents" "$QA_ROOT/outputs"
tee "$QA_ROOT/documents/seed.json" >/dev/null <<'JSON'
{
  "schemaVersion": 1,
  "durationUs": 1000000,
  "playbackRange": { "startUs": 0, "endUs": 1000000 },
  "loop": true,
  "seed": 42,
  "rootIds": ["root"],
  "elements": [
    { "id": "root", "type": "group", "childrenIds": [] }
  ],
  "tracks": []
}
JSON
export PARTICLE_STUDIO_WORKSPACE_ROOT="$QA_ROOT/workspace"
export PARTICLE_STUDIO_DOCUMENTS_ROOT="$QA_ROOT/documents"
export PARTICLE_STUDIO_OUTPUTS_ROOT="$QA_ROOT/outputs"
export PARTICLE_STUDIO_DOCUMENT_ID=document-1
export PARTICLE_STUDIO_SEED_PATH=seed.json
```

Los tres roots deben existir, ser absolutos, canónicos y físicamente disjuntos;
estos hijos son siblings, no roots anidados. Workspace almacena assets, outputs
revisiones/pointers y documents es autoridad de entrada para el seed relativo.
Los cuatro primeros environment values son obligatorios; `SEED_PATH` sólo hace falta
sin draft persistido. Un resume lee el draft exacto, nunca hace fallback al seed.
El seed sin imágenes evita requerir assets previos; la app verifica las referencias
si existen, pero ninguna de sus cinco operaciones escribe assets.

## 2. Conectar un cliente MCP

Configura el cliente para lanzar `node` con argumentos
`["--import", "tsx", "apps/headless-mcp/src/main.ts"]`, **cwd en la raíz del repo**
y el environment anterior. El comando equivalente es:

```sh
node --import tsx apps/headless-mcp/src/main.ts
```

El cliente debe poseer los pipes stdin/stdout y leer stderr por separado. No es un
comando `curl`; abrir un proceso sin cliente no establece una sesión MCP útil.
El [manifest](package.json) define `start` como `node --import tsx src/main.ts` desde
la app; para transporte usa Node directo, sin banners de `npm run` en stdout.
Negocia `initialize`, envía `notifications/initialized` y consulta `tools/list`.
El [test stdio](tests-integration/headless-mcp-stdio.test.ts) muestra el intercambio
JSON-RPC completo y su lifecycle con el servidor actual, sin globals de fixture.

## 3. Tools y resultados

| Tool exacta | Arguments exactos | Resultado de dominio |
| --- | --- | --- |
| `particle_studio.get_draft_summary` | `{}` | `{ ok: true, summary }` del último commit; no espera la cola de mutaciones |
| `particle_studio.validate_draft` | `{ "document": <SceneDocument> }` | Resultado de validación schema/dominio, sin publicar ni verificar storage de assets |
| `particle_studio.dispatch_draft_command` | `{ "command": <envelope> }` | `{ ok: true, revision, document }` o `{ ok: false, error: { code } }` |
| `particle_studio.undo` | `{}` | Misma forma de mutación; undo de historial de esta sesión |
| `particle_studio.redo` | `{}` | Misma forma de mutación; redo de historial de esta sesión |

`summary` contiene documentId, revision, schemaVersion, durationUs, playbackRange,
loop, elementCount y trackCount, no documento completo ni assets/saved pointer.
El binding devuelve el envelope como JSON text en `content` y como `structuredContent`;
los rechazos de dominio llevan `isError: true`. Schemas de arguments son estrictos:
keys extra/ausentes fallan en MCP; una violación inesperada del workspace produce
`WORKSPACE_UNAVAILABLE`, sin cause/stack. Véase [server](src/mcp-headless-server.ts).

### Primera mutación del seed anterior

Envía este mensaje `tools/call` después del handshake y de comprobar summary revision 0:

```json
{
  "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": {
    "name": "particle_studio.dispatch_draft_command",
    "arguments": {
      "command": {
        "commandSchemaVersion": 1,
        "commandId": "command-1", "documentId": "document-1",
        "expectedRevision": 0,
        "payload": {
          "type": "create-element",
          "element": {
            "type": "shape",
            "x": 16, "y": 24,
            "width": 120, "height": 80,
            "opacity": 1
          }
        }
      }
    }
  }
}
```

`create-element` no recibe `id`: la fuente UUID prefijada lo asigna y el resultado
incluye la shape como nueva raíz. En este workspace fresco el primer éxito publica
revision 1; usa la revisión de summary/resultado para el próximo `expectedRevision`.
El envelope lleva exactamente version/commandId/documentId/expectedRevision/payload:
no envíes `actorCapability`. El workspace lo inyecta como `headless-agent`; las tres
`set-shape-position/dimensions/opacity` human-only rechazan con `MALFORMED_COMMAND`.
Eso es política de envelope, **no autenticación** ni nuevo permiso agent.
Consulta [Commands](../../packages/commands/README.md) para las otras familias.

## 4. Persistencia, errores y cierre

El seed arranca en revision 0 sin publicar un draft; una mutación publica antes del
commit en memoria. Al reabrir, revision expuesta viene de la secuencia draft durable:
no la confundas con la revisión interna reconstruida de CommandSession. Undo/redo
avanzan revisión, pero su historial empieza vacío en cada sesión, incluso al resumir.
Saved se conserva; no se aprueba automáticamente. Assets referenciados deben existir
y coincidir. `DURABLE_PUBLISH_FAILED` no avanza estado/historial de sesión; un fallo FS
puede dejar revisión huérfana o durabilidad incierta, no rollback global garantizado.

Startup falla cerrado con `HEADLESS_WORKSPACE_CONFINEMENT_REJECTED`,
`HEADLESS_WORKSPACE_PERSISTED_STATE_INVALID`, `HEADLESS_WORKSPACE_ASSET_UNAVAILABLE`,
`HEADLESS_WORKSPACE_SEED_UNAVAILABLE` o `HEADLESS_WORKSPACE_SEED_INVALID`.
Conserva datos y diagnóstico, no borres roots ni cambies seed para ocultar un resume corrupto.
[Filesystem](../../packages/persistence-fs/README.md) detalla amenazas, límites y publicación.

Mantén stdin abierto hasta leer todas las respuestas esperadas. EOF/SIGINT/SIGTERM
inician cierre idempotente: el servidor actual intenta drenar requests recibidas
hasta 5 s antes de cerrar; timeout sale no cero con diagnóstico. Un cierre pre-ready
con bytes pendientes también falla. Exit 0 solo no demuestra respuestas completas.
Stdout es protocolo y stderr diagnósticos; no introduzcas logs en el pipe MCP.
Conserva `$QA_ROOT` para inspección; cualquier limpieza posterior debe ser explícita,
limitada a esos datos propios y con el proceso detenido. No hay cleanup automático.

Los [tests core](tests) y [stdio/contrato Docker](tests-integration) definen cobertura;
no se ejecutaron por escribir esta guía. La nota antigua de EOF en deployment no
sustituye el drain actual de [main](src/main.ts) y [request-drain](src/request-drain.ts).
