# Candados de la Mac — plantilla de managed-settings y verificación

Para qué: que los agentes locales (Claude Code en la cuenta «taller») no puedan fusionar, empujar a `main`, usar `clasp`
o `gcloud`, ni leer credenciales o carpetas `privado/`, aunque el repositorio o el propio agente pidan lo contrario.

Fuentes: **DEC-POS-034** y **DEC-POS-040** punto 3 (pestaña DECISIONES de la hoja de PROJECT-OS; paquete
PAQ-2026-11-21-06), orden ORD-POS-169 ([issue #370](https://github.com/jlpulido107-bit/PROJECT-OS/issues/370)).
**Hipótesis:** el texto de las dos decisiones no está en el repositorio y la sesión que escribió esta guía no lo leyó
de la hoja; lo que sigue sale de los criterios de la orden. Si la decisión dice otra cosa, manda la decisión.

Esta orden no instaló nada: todos los pasos de abajo los hace solo el propietario, en la Mac.

## Qué hay

| Archivo | Qué es |
| --- | --- |
| [`managed-settings.plantilla.json`](managed-settings.plantilla.json) | La plantilla. Vive fuera de `.claude/` para que ninguna sesión la tome como configuración del repositorio. |
| [`scripts/mac-verificar.sh`](../../scripts/mac-verificar.sh) | Verificación de solo lectura: OK o FALLA por punto. |

## Qué hace la plantilla

Formato de managed-settings de Claude Code, consultado el 2026-11-22 en su documentación oficial:
[managed settings](https://code.claude.com/docs/en/managed-settings), [permisos](https://code.claude.com/docs/en/permissions),
[modos de permiso](https://code.claude.com/docs/en/permission-modes) y [sandbox](https://code.claude.com/docs/en/sandboxing).

- `permissions.deny` niega: `gh pr merge`; `git push` con `main` como destino (`… main`, `…:main`, `+main`,
  `refs/heads/main`); `clasp` (también con `npx`); `gcloud`; y la lectura de `~/.clasprc.json`, `~/.config/gcloud/**`
  y cualquier ruta bajo una carpeta `privado/` (`//**/privado/**`, en todo el disco).
- `permissions.disableBypassPermissionsMode: "disable"`: el modo bypass no se puede activar. La plantilla no trae
  `defaultMode` ni reglas `allow`.
- `sandbox.enabled: true`, con `failIfUnavailable: true` (si el sandbox no arranca, Claude Code no abre) y
  `allowUnsandboxedCommands: false` (no hay reintento fuera del sandbox). El sandbox además niega al shell leer
  `~/.clasprc.json` y `~/.config/gcloud`.

Las reglas de managed-settings ganan a las del usuario y a las del repositorio; ninguna de las dos las afloja.

### Límites que conviene saber

- Las reglas `Bash(...)` comparan el texto del comando: la documentación avisa de que no son una frontera de
  seguridad. No frenan `/usr/local/bin/gcloud …`, `sh -c 'gcloud …'`, `git -C . push origin main` ni un `git push`
  sin argumentos estando en `main`. El candado real de `main` es la protección de rama en GitHub, y el de `gcloud`
  y `clasp` es que no haya sesión abierta: por eso el script verifica las sesiones y no solo la plantilla.
- La lectura de `privado/` queda negada para las herramientas de Claude Code y para comandos que nombran el archivo
  (`cat`, `head`…). El sandbox no lleva una regla para `privado/`: su `denyRead` usa rutas fijas y no se verificó que
  acepte comodines. Un script que abra por su cuenta un archivo de `privado/` no queda bloqueado por esta plantilla;
  el candado ahí son los permisos 700 de la carpeta del propietario.
- No se verificó en la documentación qué dueño y permisos exige el archivo instalado; los de abajo (root, 644) son
  los mínimos para que «taller» lo lea y no lo cambie.

## Cómo instalar (propietario, con sudo)

Desde la raíz del repositorio, en la cuenta del propietario:

```bash
sudo mkdir -p "/Library/Application Support/ClaudeCode"
sudo install -o root -g wheel -m 644 docs/mac/managed-settings.plantilla.json \
  "/Library/Application Support/ClaudeCode/managed-settings.json"
```

Después, en la cuenta «taller», abre Claude Code y ejecuta `/status`: en «Setting sources» debe aparecer
`Enterprise managed settings (file)`. Si la plantilla cambia en el repositorio, se repite la instalación.

Para quitarla: `sudo rm "/Library/Application Support/ClaudeCode/managed-settings.json"`.

## Cómo verificar

```bash
bash scripts/mac-verificar.sh
```

Si la carpeta de «taller» no se deja leer desde tu cuenta, con sudo (el script toma tu cuenta de `SUDO_USER`):

```bash
sudo bash scripts/mac-verificar.sh
```

Opciones: `--propietario <cuenta>`, `--taller <cuenta>` (por defecto `taller`) y `--plantilla <archivo>`.
Termina con 0 si todo está OK y con 1 si hay alguna FALLA.

| Punto | OK cuando | Si sale FALLA |
| --- | --- | --- |
| 1 | `/Users/<propietario>` tiene permisos 700 | `chmod 700 ~` |
| 2a | «taller» existe y no está en el grupo `admin` | Ajustes del Sistema → Usuarios y grupos: cuenta estándar |
| 2b | «taller» no tiene sesión en `~/.config/gh/hosts.yml` | En «taller»: `gh auth logout` |
| 2c | «taller» no tiene sesión de gcloud | En «taller»: `gcloud auth revoke --all` y `gcloud auth application-default revoke` |
| 3 | el propietario no tiene sesión de gcloud | Lo mismo, en tu cuenta, al terminar de desplegar |
| 4 | no existe `~/.clasprc.json` en ninguna de las dos cuentas | `clasp logout` |
| 5 | el archivo instalado es idéntico, byte a byte, a la plantilla | Repite la instalación |

El script solo lee. Usa `id` y `stat` y mira archivos; no ejecuta `gh`, `gcloud` ni `clasp`, no cierra sesiones y no
escribe nada. Para gcloud da FALLA si encuentra `application_default_credentials.json`, cuentas en
`legacy_credentials/` o una línea `account =` en `configurations/config_*`; no abre `credentials.db`. Para gh mira
solo `hosts.yml`: un token en la variable `GH_TOKEN` de «taller» no lo ve.

Las pruebas ([`tests/test_mac_verificar.py`](../../tests/test_mac_verificar.py)) corren el script contra una Mac
simulada en una carpeta temporal, con `id` y `stat` falsos: ninguna prueba ni esta orden tocó una Mac real.
