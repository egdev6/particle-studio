# Cierre automático de issues al fusionar una PR

Estado: **candidato local, no activo**. Todavía no hay evidencia E2E; su
activación requiere un fixture propio y la entrega mediante PR.

La rama por defecto `main` es la única autoridad del flujo
`close-issue-on-merge.yml`. El objetivo de ejecución es `develop`.

## Comportamiento
Cuando llega un evento `pull_request_target` de tipo `closed` sobre
`develop` con `merged == true`, el job valida número y snapshot de cuerpo
del evento contra la PR real por API. Autoriza el cierre solo si la cadena
del evento es igual al cuerpo fresco; si falta o difiere (edición posterior
o re-ejecución) avisa y omite, usando siempre el cuerpo fresco inmutable.

## Gramática reconocida (estrecha)
- Palabras clave (sin distinguir mayúsculas): `close`, `closes`, `closed`,
  `fix`, `fixes`, `fixed`, `resolve`, `resolves`, `resolved`.
- Dos puntos opcionales después de la palabra clave.
- Referencia local `#N` o del mismo repositorio `owner/repo#N`.
- Se ignoran `Refs`, repositorios ajenos, URLs, vallas de código (>=3
  backticks o tildes), código en línea, comentarios y citas.
- Se deduplican los números y se rechazan `0`, negativos, decimales,
  fragmentos parciales (`#2abc`, `#2.3`) y enteros fuera de rango seguro.

Esta gramática es más estrecha que el parser oficial de GitHub; no se
promete paridad total con él.

## Permisos y token
El job declara `permissions: issues: write` y `pull-requests: read`
únicamente. No hace checkout, no ejecuta código de la PR y no usa secretos
ni tokens de acceso personal.

## Verificación local
`node --test tests/close-issue-on-merge.test.mjs` usa una API falsa; no
existe prueba E2E real. Escribir `Closes` en una PR futura autoriza cerrar
la issue referenciada, pero **no aprueba ni fusiona** esa PR.

## Notas de seguridad
`zizmor` marca `dangerous-triggers` aquí de forma intencional (evento
privilegiado solo de metadatos, sin supresiones); no se reclama aprobación
humana nativa ni permisos por issue tras verificar el snapshot.
