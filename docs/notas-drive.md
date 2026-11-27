# NOTAS a Drive con el permiso mínimo

Guía del propietario (ORD-POS-177, POS-071). El workflow `sync-to-drive.yml` de NOTAS sube las notas a Drive con un
token que alcanza **todo** tu Drive (`scope = drive`) y que expiró el 2026-11-27. Esta orden lo cambia por un token que
solo alcanza la carpeta de las notas. **No usa WIF**: Google no lo permite en un Drive personal (abajo).

Nada cambia en NOTAS hasta que tú copies el workflow (paso 5). Ningún agente lo copia, crea el cliente de OAuth, pone
variables o secretos, ni corre `rclone` contra Drive.

## WIF con cuenta de servicio: no es viable

Verificado el 2026-11-27 en la documentación oficial de Google:

| Qué dice Google | Fuente |
|---|---|
| «Service accounts don't have storage quota and can't own files.» Deben subir a unidades compartidas o usar OAuth 2.0 a nombre de una persona. | [Shared drives overview](https://developers.google.com/workspace/drive/api/guides/about-shareddrives) |
| «Service accounts don't have storage quota and can't own any files.» (nota del error `storageQuotaExceeded`) | [Resolve errors](https://developers.google.com/workspace/drive/api/guides/handle-errors) |
| «Personal Google Accounts (`@gmail.com`) cannot create shared drives»; las unidades compartidas son de ediciones de Google Workspace. | [Shared drives overview](https://developers.google.com/workspace/drive/api/guides/about-shareddrives) |
| En Mi unidad, el dueño de un archivo es quien lo creó. | [Ayuda de unidades compartidas](https://support.google.com/a/users/answer/7212025) |

Conclusión: aunque compartas `Notas_Obsidian` con una cuenta de servicio como Editor, cada nota **nueva** la crearía
esa cuenta, sería su dueña y contaría contra su cuota, que no existe: la subida falla. La salida de Google para eso son
las unidades compartidas, que una cuenta de Gmail sin Workspace no puede crear. La otra salida oficial, OAuth a nombre
de una persona, es la de esta guía. Por eso no hay script `wif-*.sh` ni cuenta de servicio en esta orden.

**Hipótesis** (no está en esas páginas): una cuenta de servicio sí podría *modificar* notas que ya existen y son tuyas;
no sirve, porque el vault crea notas nuevas todo el tiempo.

## La alternativa: `rclone` con `drive.file`

| | Hoy | Con esta orden |
|---|---|---|
| Alcance del token | `drive`: «View and manage all your Drive files», alcance **restringido** | `drive.file`: solo los archivos que creó esta app, alcance **no sensible** ([alcances](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)) |
| Si el token se filtra | Lee, cambia y borra todo tu Drive | Lee, cambia y borra solo la carpeta de las notas |
| Cliente de OAuth | **Hipótesis:** el compartido de `rclone` o uno en modo «Testing» | Uno tuyo, publicado |
| Qué se sube | Lo que diga el workflow actual | Solo lo que está en git, sin `privado/` ni `.obsidian/workspace*`, con dos barreras |

Con `drive.file`, `rclone` «can read/view/modify only those files and folders it creates» y no ve lo subido por la web
([rclone, Drive](https://rclone.org/drive/)). Por eso **no puede usar la carpeta `Notas_Obsidian` de hoy**: se crea una
carpeta nueva con el token nuevo (paso 3) y la anterior se retira al final.

Piezas: la fuente [`web/deploy/github/notas-sync-to-drive.yml`](../web/deploy/github/notas-sync-to-drive.yml) y sus
pruebas con dobles, [`web/tests/notas-drive.test.ts`](../web/tests/notas-drive.test.ts) (un NOTAS local y un `rclone`
falso; ejecutan los bloques de shell del workflow tal cual).

Qué hace el workflow, al hacer push a `main` o a mano:

1. Arma una carpeta temporal solo con lo que está en git (`git ls-files`), sin ninguna carpeta `privado` ni
   `.obsidian/workspace*`, a cualquier nivel. Lo ignorado por `.gitignore` nunca llega; lo metido a la fuerza, tampoco.
2. Revisa esa carpeta: si aparece algo prohibido, se detiene sin subir.
3. `rclone sync` de esa carpeta a la carpeta de Drive, con las mismas exclusiones otra vez y `--max-delete 50`.

## Pasos

Los pasos 1 a 4 no afectan a NOTAS. `rclone` necesita un navegador para autorizar: hazlo en tu propio usuario de la Mac,
nunca en «taller» (DEC-POS-034).

### 1. Cliente de OAuth propio

En la [consola de Google Cloud](https://console.cloud.google.com/), proyecto `project-os-511102`:

1. *APIs y servicios → Biblioteca* → activa **Google Drive API**.
2. *Pantalla de consentimiento de OAuth*: tipo **Externo**; en alcances agrega solo `.../auth/drive.file`.
3. **Publica la app** («En producción»). En «Testing», Google emite un token de actualización que expira en 7 días
   ([OAuth 2.0](https://developers.google.com/identity/protocols/oauth2)). **Hipótesis:** eso fue lo que expiró el
   27-nov. **Hipótesis:** con solo `drive.file`, publicar no exige verificación de Google; si la pide, detente y avisa al PM.
4. *Credenciales → Crear credenciales → ID de cliente de OAuth* → tipo **App de escritorio**. Guarda el ID y el secreto.

### 2. Autorizar con `drive.file`

```bash
read -r -p "ID de cliente: " NOTAS_ID
read -r -s -p "Secreto de cliente: " NOTAS_SECRETO; echo
rclone config create notas-drive drive scope drive.file client_id "$NOTAS_ID" client_secret "$NOTAS_SECRETO"
```

Se abre el navegador: entra con tu cuenta y acepta. La pantalla debe pedir solo «ver, editar, crear y eliminar los
archivos de Drive que uses con esta app»; si pide todo tu Drive, cancela.

### 3. Crear la carpeta nueva

```bash
rclone mkdir notas-drive:Notas_Obsidian_v2
rclone lsjson notas-drive: --dirs-only
```

Copia el `ID` de `Notas_Obsidian_v2`. Prueba en seco desde tu clon de NOTAS, sin subir nada:

```bash
rclone sync . notas-drive:Notas_Obsidian_v2 --exclude '.git/**' --exclude 'privado/**' --exclude '.obsidian/workspace*' --dry-run -v
```

No debe listar nada de `privado/` ni `workspace`.

### 4. Variables y secretos en NOTAS

En NOTAS, *Settings → Secrets and variables → Actions*:

| Tipo | Nombre | Valor |
|---|---|---|
| Variable | `NOTAS_DRIVE_FOLDER_ID` | El ID del paso 3 |
| Variable | `NOTAS_DRIVE_CLIENT_ID` | El ID de cliente del paso 1 |
| Secret | `NOTAS_DRIVE_CLIENT_SECRET` | El secreto de cliente del paso 1 |
| Secret | `NOTAS_DRIVE_TOKEN` | El valor de `token` (el JSON entero, entre llaves) que muestra `rclone config show notas-drive` |

No pegues el token ni el secreto en un chat, un issue ni una nota.

### 5. Copiar el workflow

En un PR tuyo en NOTAS, con los clones de NOTAS y PROJECT-OS (con esta orden fusionada) uno junto al otro:

```bash
git switch main && git pull
git switch -c propietario/drive-permiso-minimo
git diff --no-index .github/workflows/sync-to-drive.yml ../PROJECT-OS/web/deploy/github/notas-sync-to-drive.yml
cp ../PROJECT-OS/web/deploy/github/notas-sync-to-drive.yml .github/workflows/sync-to-drive.yml
git add .github/workflows/sync-to-drive.yml
git commit -m "Drive: token con drive.file y solo la carpeta de notas (ORD-POS-177)"
git push -u origin propietario/drive-permiso-minimo
```

Mira el `git diff` antes de copiar: quien implementó **no pudo leer** el workflow actual de NOTAS. Si el actual corre
con otro disparador o excluye más cosas, detente y avisa al PM antes de fusionar.

### 6. Probar

Al fusionar corre solo; o *Actions → NOTAS — Sync to Drive → Run workflow*. Debe quedar en verde y `Notas_Obsidian_v2`
debe tener las notas, sin `privado/` ni `.obsidian/workspace*`. Lo que lea las notas desde Drive debe apuntar a la
carpeta nueva.

| Paso en rojo | Qué revisar |
|---|---|
| *Check the Drive folder and OAuth client variables* | Las dos variables del paso 4. |
| *Stage only tracked notes* | `privado/ or .obsidian/workspace* reached the upload folder`: avisa al PM; no se subió nada. |
| *Sync notes* con `Missing secret` | Los dos secretos del paso 4. |
| *Sync notes* con `invalid_grant` | El token expiró o se revocó: revisa que la app esté publicada (paso 1) y repite los pasos 2 y 4. |
| *Sync notes* con un 404 de la carpeta | `NOTAS_DRIVE_FOLDER_ID` no es una carpeta creada con este cliente (paso 3). |
| *Sync notes* con `--max-delete` | Hay más de 50 borrados de golpe: confirma que es lo esperado antes de subir el límite con una orden. |

### 7. Retirar el `GDRIVE_TOKEN`

Solo después de una corrida buena:

1. NOTAS → *Settings → Secrets and variables → Actions → Secrets* → borra `GDRIVE_TOKEN`.
2. Revoca el acceso anterior en [tu cuenta de Google](https://myaccount.google.com/connections): quita la app que tenía
   «ver, editar, crear y eliminar todos tus archivos de Drive». Borrar el secreto no revoca nada en Google.
3. Manda `Notas_Obsidian` (la anterior) a la papelera cuando confirmes que la nueva está completa.
4. En la Mac: `rclone config delete notas-drive`, para no dejar el token en disco.

## Riesgo que queda

- **Sigue habiendo un secreto de larga vida** en GitHub. Quien pueda cambiar un workflow en NOTAS puede usarlo, pero solo
  alcanza la carpeta de las notas, no el resto del Drive. WIF lo habría eliminado; Google no lo permite aquí.
- `rclone sync` borra en Drive lo que ya no está en git; `--max-delete 50` limita el daño de un error.
- **No probado contra Drive real** ni en GitHub Actions: las pruebas usan dobles. **Hipótesis:** el `rclone` de `apt` en
  `ubuntu-latest` acepta la configuración por variables `RCLONE_CONFIG_NOTAS_*`.
- La carpeta cambia de ID: lo que lea `Notas_Obsidian` desde Drive hay que reapuntarlo.
- Si algún día hay Google Workspace, una unidad compartida haría viable WIF, con otra orden.
