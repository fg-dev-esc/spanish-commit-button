# Spanish Commit Button Architecture

## Producto activo

Extension de VS Code que obtiene los cambios de un repositorio Git, los envia a Groq y coloca el mensaje generado en el input de Source Control. No realiza el commit.

## Runtime activo

- Extension host de VS Code: `extension.js`.
- Git: extension integrada de VS Code y ejecutable `git`.
- IA: Groq mediante `GROQ_API_KEY` local y el modelo `qwen/qwen3.8-27b`.
- Persistencia: ninguna fuera del input de Source Control.

## Non-goals

- No hace stage, commit, push ni modificaciones de archivos.
- No usa backend central, cuentas ni telemetria.
- No genera mensajes en otros idiomas.
- No migra a TypeScript en esta fase.

## Datos

| Dato | Ubicacion o destino | Politica |
|---|---|---|
| API key de Groq | Entorno del extension host | Nunca se versiona ni se incluye en VSIX. |
| Diff y archivos untracked | Memoria durante el comando | Se envian a Groq con el limite activo. |
| Mensaje generado | Input de Source Control | No se persiste por la extension. |
| VSIX local | Archivo ignorado | Es artefacto generado, no fixture. |
| Diff sintetico | `test/fixtures/synthetic/` | No contiene codigo ni secretos reales. |

## Direccion objetivo

La migracion futura separara activacion en `extension/`, el caso de uso en `features/generar-commit` y los adapters de VS Code, Git y Groq en `shared/`.

## Invariantes

- El comando conserva el ID `spanishCommit.generate`.
- Solo se escribe `repository.inputBox.value`.
- El contexto enviado no supera 12000 caracteres.
- El codigo activo no importa desde `legacy/`.
- `legacy/` no entra en VSIX.
- Los fixtures no contienen cambios reales.
