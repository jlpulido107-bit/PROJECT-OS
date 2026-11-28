# NOTAS a Drive con el permiso mínimo

Guía del propietario (ORD-POS-177 y ORD-POS-178, POS-071). El workflow `sync-to-drive.yml` de NOTAS sube las notas a
Drive con un token que alcanza **todo** tu Drive (`scope = drive`) y que expiró el 2026-11-27. La ORD-POS-177 lo cambia
por un token que solo alcanza la carpeta de las notas. **No usa WIF**: Google no lo permite en un Drive personal
(abajo).

Desde la ORD-POS-178 el cliente de OAuth propio es **opcional**: el 28-nov Google no dejó publicarlo (paso 1). Sin él,
el workflow usa el cliente integrado de `rclone`, con el mismo alcance `drive.file`.

**Lee esto antes de empezar.** `rclone` anunció que retira ese cliente integrado: «This shared client_id is being
retired and will stop working during 2026. To avoid interruption you must create and use your own client_id, so
creating one is now required rather than merely recommended»
([rclone, Drive](https://rclone.org/drive/#making-your-own-client-id), página del 2026-11-06, leída el 2026-11-28).
No da fecha: la ruta sin cliente propio puede dejar de funcionar cualquier día, y entonces harán falta el cliente
propio y otra carpeta nueva ([riesgo que queda](#riesgo-que-queda)).

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

| | Hoy | Con esta guía |
|---|---|---|
| Alcance del token | `drive`: «View and manage all your Drive files», alcance **restringido** | `drive.file`: solo los archivos que creó esta app, alcance **no sensible** ([alcances](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)) |
| Si el token se filtra | Lee, cambia y borra todo tu Drive | Lee, cambia y borra solo la carpeta de las notas |
| Cliente de OAuth | El integrado de `rclone`, según la ORD-POS-178 ([#394](https://github.com/jlpulido107-bit/PROJECT-OS/issues/394)) | El integrado de `rclone`; uno tuyo solo si logras publicarlo (paso 1) |
| Qué se sube | Lo que diga el workflow actual | Solo lo que está en git, sin `privado/` ni `.obsidian/workspace*`, con dos barreras |

Con `drive.file`, `rclone` «can read/view/modify only those files and folders it creates» y no ve lo subido por la web
([rclone, Drive](https://rclone.org/drive/)). Por eso, y porque al quitar el permiso viejo (paso 2) la app pierde lo
que había creado, **no usa la carpeta `Notas_Obsidian` de hoy**: se crea una carpeta nueva con el token nuevo (paso 3)
y la anterior se retira al final.

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

### 1. Cliente de OAuth propio (opcional)

Sáltalo si no tienes un dominio verificado: sin cliente propio, el workflow usa el integrado de `rclone` (paso 2).

Por qué es opcional: el 28-nov, al aplicar la ORD-POS-177, Google no dejó publicar la app sin un dominio verificado
del propietario; un Gmail personal no tiene ninguno y `docs.google.com` no sirve
([#394](https://github.com/jlpulido107-bit/PROJECT-OS/issues/394)). Sin publicar, la app queda en «Prueba» y Google le
emite un token de actualización que expira en 7 días
([OAuth 2.0](https://developers.google.com/identity/protocols/oauth2#expiration)).

`rclone` describe el mismo tope: si el botón de publicar está apagado, «Google now requires a homepage URL and a
privacy policy URL before publishing, even for a personal single-user app», y dice que una página gratuita de GitHub
Pages sirve para las dos, con su dominio en «Authorized domains»
([rclone, Drive](https://rclone.org/drive/#making-your-own-client-id)). **Hipótesis:** eso bastaría para publicar; no se
probó, y una página así es pública.

Si tienes el dominio, en la [consola de Google Cloud](https://console.cloud.google.com/), proyecto `project-os-511102`:

1. *APIs y servicios → Biblioteca* → activa **Google Drive API**.
2. *Pantalla de consentimiento de OAuth*: tipo **Externo**; en alcances agrega solo `.../auth/drive.file`.
3. **Publica la app** («En producción»); antes Google pide la página de inicio y la política de privacidad en tu
   dominio (arriba). Si no te deja, detente: en «Prueba» el token expira cada 7 días.
4. *Credenciales → Crear credenciales → ID de cliente de OAuth* → tipo **App de escritorio**. Guarda el ID y el secreto.

### 2. Autorizar con `drive.file`

**Primero quita el permiso viejo.** Sin cliente propio, el `GDRIVE_TOKEN` y el token nuevo son de la misma app, el
cliente integrado de `rclone` ([#394](https://github.com/jlpulido107-bit/PROJECT-OS/issues/394)), y Google quita el
acceso por app, no por token: «Si quitas el acceso, la app no podrá acceder a tu Cuenta de Google»
([ayuda de Google](https://support.google.com/accounts/answer/13533235)). Hazlo **antes** de autorizar: después
tumbaría también el token nuevo.

En [tu cuenta de Google](https://myaccount.google.com/connections) abre la app que tiene «ver, editar, crear y
eliminar todos tus archivos de Drive» (según la orden, `rclone`) y elige *Quitar acceso*; si no hay ninguna, ya no
queda permiso viejo que quitar. No rompe nada que hoy funcione: ese token expiró el 27-nov. Si usas `rclone` con Drive
para otra cosa, tendrás que autorizarlo de nuevo.

Luego autoriza, sin cliente:

```bash
rclone config create notas-drive drive scope drive.file
```

Se abre el navegador: entra con tu cuenta y acepta. La pantalla debe pedir solo «ver, editar, crear y eliminar los
archivos de Drive que uses con esta app»; si pide todo tu Drive, cancela.

Si Google rechaza la app o el cliente, detente y avisa al PM; **hipótesis:** el retiro ya llegó. Tampoco sé por qué
dejó de funcionar el `GDRIVE_TOKEN` el 27-nov: pudo ser ya ese retiro. Un `rclone` 1.74.4 o posterior repite el aviso
del retiro en cada comando ([cambios](https://rclone.org/changelog/#v1-74-4-2026-07-08)).

Solo si hiciste el paso 1, autoriza con tu cliente en vez del comando de arriba:

```bash
read -r -p "ID de cliente: " NOTAS_ID
read -r -s -p "Secreto de cliente: " NOTAS_SECRETO; echo
rclone config create notas-drive drive scope drive.file client_id "$NOTAS_ID" client_secret "$NOTAS_SECRETO"
```

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
| Secret | `NOTAS_DRIVE_TOKEN` | El valor de `token` (el JSON entero, entre llaves) que muestra `rclone config show notas-drive` |
| Variable, opcional | `NOTAS_DRIVE_CLIENT_ID` | Solo con cliente propio: el ID de cliente del paso 1 |
| Secret, opcional | `NOTAS_DRIVE_CLIENT_SECRET` | Solo con cliente propio: el secreto de cliente del paso 1 |

Los dos datos del cliente van juntos: con ambos, el workflow usa tu cliente; sin ninguno, el integrado de `rclone`; con
uno solo se detiene sin subir nada. Si el 28-nov creaste alguno y ahora vas sin cliente propio, bórralo: un token solo
sirve con el cliente que lo emitió ([RFC 6749, §6](https://www.rfc-editor.org/rfc/rfc6749#section-6)).

No pegues el token ni el secreto en un chat, un issue ni una nota.

### 5. Copiar el workflow

En un PR tuyo en NOTAS, con los clones de NOTAS y PROJECT-OS (con la ORD-POS-178 fusionada) uno junto al otro:

```bash
git switch main && git pull
git switch -c propietario/drive-permiso-minimo
git diff --no-index .github/workflows/sync-to-drive.yml ../PROJECT-OS/web/deploy/github/notas-sync-to-drive.yml
cp ../PROJECT-OS/web/deploy/github/notas-sync-to-drive.yml .github/workflows/sync-to-drive.yml
git add .github/workflows/sync-to-drive.yml
git commit -m "Drive: token con drive.file y solo la carpeta de notas (ORD-POS-177 y ORD-POS-178)"
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
| *Check the Drive folder variable* | La variable `NOTAS_DRIVE_FOLDER_ID` del paso 4. |
| *Stage only tracked notes* | `privado/ or .obsidian/workspace* reached the upload folder`: avisa al PM; no se subió nada. |
| *Sync notes* con `Missing secret` | El secreto `NOTAS_DRIVE_TOKEN` del paso 4. |
| *Sync notes* con `Set both` | Del cliente propio hay un dato y falta el otro: pon los dos o borra el que sobra (paso 4). No se subió nada. |
| *Sync notes* con `invalid_grant` u otro error al renovar el token | El token expiró, se revocó o no es del cliente que dice la línea `OAuth client:` del registro: repite los pasos 2 y 4. Con cliente propio, revisa que la app esté publicada (paso 1). Con `rclone built-in`, **hipótesis:** también puede ser que `rclone` ya retiró su cliente ([riesgo que queda](#riesgo-que-queda)). |
| *Sync notes* con un 404 de la carpeta | `NOTAS_DRIVE_FOLDER_ID` no es una carpeta creada con este cliente (paso 3). |
| *Sync notes* con `--max-delete` | Hay más de 50 borrados de golpe: confirma que es lo esperado antes de subir el límite con una orden. |

### 7. Retirar el `GDRIVE_TOKEN`

Solo después de una corrida buena:

1. NOTAS → *Settings → Secrets and variables → Actions → Secrets* → borra `GDRIVE_TOKEN`. Borrar el secreto no revoca
   nada en Google: el permiso viejo lo quitaste en el paso 2.
2. **No quites `rclone` de tu cuenta de Google ahora.** Con el cliente integrado, el token viejo y el nuevo son de esa
   misma app: quitarla tumba también el nuevo, y la app pierde la carpeta que creó («File authorization is revoked when
   the user deauthorizes the app», [rclone, Drive](https://rclone.org/drive/#drive-scope)). Si te saltaste esa parte del
   paso 2, el permiso viejo sigue vivo: quítala y repite los pasos 2 a 4, con carpeta nueva. La app que sí puedes
   quitar cuando quieras es la de un cliente propio que ya no uses, como uno del 28-nov que quedó en «Prueba»: lleva el
   nombre que le pusiste y no es la del token nuevo.
3. Manda `Notas_Obsidian` (la anterior) a la papelera cuando confirmes que la nueva está completa.
4. En la Mac: `rclone config delete notas-drive`, para no dejar el token en disco.

## Riesgo que queda

- **Sigue habiendo un secreto de larga vida** en GitHub. Quien pueda cambiar un workflow en NOTAS puede usarlo, pero solo
  alcanza la carpeta de las notas, no el resto del Drive. WIF lo habría eliminado; Google no lo permite aquí.
- **El cliente integrado de `rclone` es compartido y lo van a retirar.** Lo usan todos los que no ponen el suyo, y la
  cuota es por cliente: «There is a global rate limit on the number of queries per second that each client_id can do
  set by Google»; una corrida puede ir lenta o fallar por el uso de otros. Además `rclone` dice que dejará de funcionar
  «during 2026», sin fecha, y que el cliente propio pasa a ser «required rather than merely recommended»
  ([rclone, Drive](https://rclone.org/drive/#making-your-own-client-id), leída el 2026-11-28). Cuando pase, *Sync notes*
  fallará y la salida es el cliente propio (paso 1). Otro cliente es otra app: no verá la carpeta de hoy, así que habrá
  que repetir los pasos 2 a 4 con carpeta nueva.
- `drive.file` es por app ([alcances](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)), y
  con el cliente integrado «esta app» es cualquier `rclone` sin cliente propio en tu cuenta, no solo este workflow: el
  token alcanza también lo que ese `rclone` cree en tu Drive después del paso 2. Además, el ID y el secreto de ese
  cliente son públicos, están en el
  [código de `rclone`](https://github.com/rclone/rclone/blob/v1.76.0/backend/drive/drive.go): quien tenga el token no
  necesita nada más para usarlo.
- `rclone sync` borra en Drive lo que ya no está en git; `--max-delete 50` limita el daño de un error.
- **No probado contra Drive real** ni en GitHub Actions: las pruebas usan dobles. Que `rclone` se configure por
  variables `RCLONE_CONFIG_NOTAS_*` y que sin `client_id` use su cliente es lo documentado
  ([variables](https://rclone.org/docs/#config-file), [`client_id`](https://rclone.org/drive/#drive-client-id)), y así
  lo hizo el `rclone` 1.60.1 de `apt` (Ubuntu 24.04) en una comprobación local de quien implementó, sin red y con un
  servidor de token falso (2026-11-28). **Hipótesis:** `ubuntu-latest` instala ese mismo `rclone`.
- La carpeta cambia de ID: lo que lea `Notas_Obsidian` desde Drive hay que reapuntarlo.
- Si algún día hay Google Workspace, una unidad compartida haría viable WIF, con otra orden.
