# Colector con Workload Identity Federation

Guía del propietario (ORD-POS-174 y ORD-POS-176, POS-071). El colector deja de escribir en la hoja con la clave JSON de una cuenta de
servicio y entra a Google sin claves, con Workload Identity Federation (WIF), como ya hace el
[botón de despliegue](despliegue-boton.md). Cierra la deuda X-8, que el preflight declara en P15.

**Hasta el paso 6 no cambia nada:** el workflow que corre cada noche sigue siendo el de la clave. **Mientras exista el
secreto** `PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON`, esa ruta sigue funcionando y a ella se puede [volver](#volver-atrás).

Nombres (son los del código; si quieres otros, se cambia la fuente y el script con una orden, antes de copiar): cuenta
`project-os-colector`, pool `github-colector`, proveedor `github-actions` y variable `COLECTOR_WIF_PROVIDER`.

Piezas:

| Pieza | Qué hace |
|---|---|
| [`web/deploy/github/manual-github-evidence.yml`](../web/deploy/github/manual-github-evidence.yml) | La fuente nueva del workflow, con WIF. Corre la copia de `.github/workflows/`, que pones tú (paso 6). |
| [`web/deploy/github/manual-github-evidence.anterior.yml`](../web/deploy/github/manual-github-evidence.anterior.yml) | La fuente anterior, con la clave: es, byte a byte, el workflow de hoy. Queda congelada para la transición y para volver atrás. |
| [`web/deploy/infra/wif-colector.sh`](../web/deploy/infra/wif-colector.sh) | Crea la cuenta del colector y su identidad de GitHub, sin claves. Simula por defecto; aplica con `--apply`. |
| [`src/sync_sheets.py`](../src/sync_sheets.py) | Acepta las dos rutas, elegidas de forma explícita: la clave (la de hoy) o las credenciales por defecto (ADC) de la cuenta esperada. |

## Qué cambia en el workflow

- **Dos jobs.** `report` lee GitHub con su token de solo lectura, como hoy, y no tiene identidad de Google. `sync` es el
  único con `id-token: write`: entra a Google como la cuenta del colector y añade las filas. Solo corre con el horario
  o, a mano, con `sync_to_sheets`.
- **Sin clave ni secretos de Google.** `sync` no usa `secrets`: usa la variable `COLECTOR_WIF_PROVIDER` y la cuenta
  `project-os-colector@project-os-511102.iam.gserviceaccount.com`, escrita en la fuente. `sync_sheets.py` se niega a
  escribir si la identidad no es esa cuenta.
- **Cuenta propia, de mínimo privilegio.** No es la del despliegue ni comparte su pool. No tiene ningún rol en el
  proyecto: lo único que puede hacer es editar la hoja maestra, porque tú se la compartes (paso 4).
- **El horario no cambia:** 05:00 UTC, las 23:00 de Mérida (DEC-POS-044). `sync` sincroniza el informe que dejó
  `report` en la misma corrida, sin volver a calcular la fecha.

## Pasos

Los pasos 1 a 5 se hacen una vez y no afectan a la corrida de la noche. `gcloud` se usa en Cloud Shell, no en la Mac
(DEC-POS-040, punto 3). Requisito: esta orden fusionada en `main` y el clon al día.

### 1. Variables de shell

Pega esto tal cual en Cloud Shell, dentro del clon de PROJECT-OS:

```bash
PROJECT_ID=project-os-511102
NUMERO_PROYECTO="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
CUENTA_COLECTOR="project-os-colector@${PROJECT_ID}.iam.gserviceaccount.com"
COLECTOR_WIF_PROVIDER="projects/${NUMERO_PROYECTO}/locations/global/workloadIdentityPools/github-colector/providers/github-actions"
echo "$NUMERO_PROYECTO"
```

`echo` debe mostrar solo dígitos. Si sale vacío, tu sesión de `gcloud` no apunta al proyecto: no sigas.

### 2. Simular la identidad

```bash
bash web/deploy/infra/wif-colector.sh
```

No llama a `gcloud`: imprime lo que haría. Revisa que el proveedor solo acepte `jlpulido107-bit/PROJECT-OS`, la rama
`main` y el workflow `manual-github-evidence.yml`, que el único rol sea `roles/iam.workloadIdentityUser` y que su
miembro termine en `attribute.repository/jlpulido107-bit/PROJECT-OS`.

### 3. Crear la cuenta de servicio y el binding WIF

```bash
bash web/deploy/infra/wif-colector.sh --apply
```

Pide escribir `AUTORIZO WIF COLECTOR`. Crea, si faltan, el pool `github-colector`, su proveedor y la cuenta
`project-os-colector`, y permite que la identidad de GitHub use esa cuenta (el binding). Lo que ya existe no se vuelve a
crear. No crea ninguna clave.

Desde ORD-POS-176 el binding es **por repositorio** (`principalSet` por `attribute.repository`), que es el que funcionó
el 27-nov-2026, y ya no por subject ([por qué](#por-qué-no-sirvió-el-binding-por-subject)). Quién puede entrar lo
sigue limitando la condición del proveedor: este repositorio, `main` y el workflow del colector. Si corriste el script
de ORD-POS-174, tienes además el binding por subject, que no sirve:
[quítalo](#quitar-el-binding-por-subject). Comprueba el resultado:

```bash
echo "$COLECTOR_WIF_PROVIDER"
gcloud iam service-accounts get-iam-policy "$CUENTA_COLECTOR" --project "$PROJECT_ID"
gcloud projects get-iam-policy "$PROJECT_ID" --flatten="bindings[].members" \
  --filter="bindings.members:serviceAccount:${CUENTA_COLECTOR}" --format="value(bindings.role)"
```

- El `echo` debe coincidir con el `COLECTOR_WIF_PROVIDER` que imprimió el script.
- El segundo comando debe listar `roles/iam.workloadIdentityUser` con un solo miembro: empieza por `principalSet://` y
  termina en `workloadIdentityPools/github-colector/attribute.repository/jlpulido107-bit/PROJECT-OS`. No debe haber
  ninguno que termine en `/*` (todo el pool) ni que nombre otro repositorio. Si además sale uno con
  `subject/repo:jlpulido107-bit/PROJECT-OS:ref:refs/heads/main`, es el de ORD-POS-174: [quítalo](#quitar-el-binding-por-subject).
- El tercero no debe imprimir nada: la cuenta no tiene ningún rol en el proyecto.

#### Quitar el binding por subject

Solo si la comprobación lo muestra. Es opcional (no da acceso a nadie más: solo sobra) y se puede repetir: si el
binding ya no está, no cambia nada.

```bash
bash web/deploy/infra/wif-colector.sh --apply --quitar-subject
```

Pide la misma frase. Vuelve a conceder el binding por repositorio (si ya está, queda igual), lee la política de la
cuenta y quita el de subject solo si está, y solo ese. Si prefieres el comando directo, hace lo mismo:

```bash
gcloud iam service-accounts remove-iam-policy-binding "$CUENTA_COLECTOR" --project "$PROJECT_ID" \
  --role roles/iam.workloadIdentityUser \
  --member "principal://iam.googleapis.com/projects/${NUMERO_PROYECTO}/locations/global/workloadIdentityPools/github-colector/subject/repo:jlpulido107-bit/PROJECT-OS:ref:refs/heads/main"
```

Si ese binding ya no existe, el comando directo termina con un error que lo dice: no pasa nada. Repite después la
comprobación del paso 3 y, de día, la [prueba a mano](#7-probar-a-mano-y-esperar-una-noche-buena).

### 4. Compartir la hoja maestra

En la [hoja maestra](https://docs.google.com/spreadsheets/d/16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic/edit):
**Compartir** → pega `project-os-colector@project-os-511102.iam.gserviceaccount.com` → **Editor** → desmarca
«Notificar». Solo esta hoja: no le compartas ninguna otra ni una carpeta.

No quites todavía a nadie: la cuenta de la clave sigue haciendo la corrida de la noche hasta el paso 6.

### 5. Variable en GitHub

En el repositorio, *Settings → Secrets and variables → Actions → Variables* (variables, no secrets), crea
`COLECTOR_WIF_PROVIDER` con el valor que imprimió el `echo` del paso 3. No es un secreto: no da acceso por sí sola.

### 6. Copiar el workflow

En un PR tuyo (ningún agente edita `.github/workflows`; `main` exige PR). Hazlo de día, lejos de las 23:00 de Mérida,
para tener tiempo de probar (paso 7):

```bash
git switch main
git pull
git switch -c propietario/colector-wif
cp web/deploy/github/manual-github-evidence.yml .github/workflows/manual-github-evidence.yml
cmp web/deploy/github/manual-github-evidence.yml .github/workflows/manual-github-evidence.yml && echo IDENTICOS
git add .github/workflows/manual-github-evidence.yml
git commit -m "Colector: sincronización con WIF, sin clave JSON (ORD-POS-174)"
git push -u origin propietario/colector-wif
```

Copia el archivo entero, sin retocarlo: el preflight solo tolera el colector si es **idéntico byte a byte** a su
fuente. Con esa copia, `P15` pasa a OK.

### 7. Probar a mano y esperar una noche buena

1. **Prueba a mano**, en cuanto fusiones el PR: *Actions → PROJECT-OS — Manual GitHub evidence report → Run workflow*,
   rama `main`, con `sync_to_sheets` activado. Deben quedar en verde los dos jobs, `report` y `sync`, y `SYNC_RUNS` debe
   tener una fila nueva. No repite evidencias. Si `sync` queda en rojo, mira [Si falla](#si-falla).
2. **Noche buena.** A la mañana siguiente, la corrida de las 23:00 (evento `schedule`) debe estar en verde, con su fila
   en `SYNC_RUNS`. Esa es la noche buena: la primera corrida con horario que escribió con WIF.

Si la prueba a mano falla y no queda arreglada antes de las 23:00, [vuelve atrás](#volver-atrás): esa noche corre con
la clave, como hasta ahora.

### 8. Retirar el secreto JSON y la clave

Solo después de una noche buena. Retirar el secreto de GitHub no basta: la clave sigue valiendo en Google hasta que
se borra.

1. **GitHub:** *Settings → Secrets and variables → Actions → Secrets* → borra `PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON`.
2. **Google:** borra la clave de la cuenta anterior. Su correo es el de la cuenta de servicio que hoy es **Editor** de
   la hoja y no es `project-os-colector@…` ni `project-os-writer@…` (la de escritura del dashboard).
   **Hipótesis:** no sé en qué proyecto vive esa cuenta ni cómo se llama; no está en el repositorio.

   ```bash
   read -r -p "Correo de la cuenta de servicio de la clave anterior: " CUENTA_ANTERIOR
   gcloud iam service-accounts keys list --iam-account "$CUENTA_ANTERIOR" --managed-by user
   read -r -p "KEY_ID de la clave que se borra: " CLAVE_ANTERIOR
   gcloud iam service-accounts keys delete "$CLAVE_ANTERIOR" --iam-account "$CUENTA_ANTERIOR"
   ```

3. **Hoja:** en **Compartir**, quita a esa cuenta anterior. No quites `project-os-colector@…`,
   `project-os-writer@…` ni `project-os-dashboard-run@…`.
4. **Avisa al PM:** con el secreto retirado ya no hay vuelta atrás, y toca otra orden que quite del repositorio la
   fuente anterior y la ruta de la clave en `sync_sheets.py`.

## Volver atrás

Mientras exista el secreto, la ruta de la clave sigue funcionando. Si la prueba a mano o la primera noche fallan y no
se arregla a tiempo, restaura el workflow anterior en otro PR:

```bash
git switch main
git pull
git switch -c propietario/colector-clave
cp web/deploy/github/manual-github-evidence.anterior.yml .github/workflows/manual-github-evidence.yml
cmp web/deploy/github/manual-github-evidence.anterior.yml .github/workflows/manual-github-evidence.yml && echo IDENTICOS
git add .github/workflows/manual-github-evidence.yml
git commit -m "Colector: volver a la clave JSON (reversa de ORD-POS-174)"
git push -u origin propietario/colector-clave
```

El preflight tolera las dos copias: con la anterior, `P11` y `P12` siguen en OK y `P15` vuelve a NO VERIFICADO. La
validación de los PR no queda en rojo en ningún sentido. Para recuperar un día sin informe, corre el workflow a mano con
`report_date` y `sync_to_sheets`.

## Si falla

En *Actions*, abre la corrida en rojo y mira en qué paso de `sync` se detuvo:

| Paso | Qué dice | Qué revisar |
|---|---|---|
| *Check the collector identity provider variable* | `Missing repository variable COLECTOR_WIF_PROVIDER` | Falta la variable del paso 5, o está vacía. |
| *Download the report collected by the report job* | No encuentra el artefacto | `report` no subió el informe. Vuelve a correr el workflow completo. |
| *Authenticate to Google Cloud* | Cualquier error | El valor de `COLECTOR_WIF_PROVIDER`: debe ser, entero, el que imprimió el paso 3. |
| *Sync verified evidence* | `ADC identity is not SHEETS_EXPECTED_SERVICE_ACCOUNT` | El workflow no es la copia exacta de la fuente. Repite el paso 6. |
| *Sync verified evidence* | `google.auth.exceptions.RefreshError: ('Unable to acquire impersonated credentials', …)` con `"code": 403`, `Permission 'iam.serviceAccounts.getAccessToken' denied on resource (or it may not exist)` y `"reason": "IAM_PERMISSION_DENIED"` | Es el error real del 26 y el 27-nov-2026: la identidad entró al pool (*Authenticate to Google Cloud* pasó), pero ningún binding de la cuenta la nombraba. Falta el binding por repositorio: repite el paso 3 con el script al día y su comprobación. Recién concedido puede tardar unos minutos. [Por qué](#por-qué-no-sirvió-el-binding-por-subject). |
| *Sync verified evidence* | Un error que nombra la «attribute condition» o el «audience» | **Hipótesis** (no lo probé contra Google): el valor de `COLECTOR_WIF_PROVIDER` no es el del paso 3, o la corrida no salió de `main`. |
| *Sync verified evidence* | `Google Sheets request failed (HTTP 403)` | La hoja no está compartida con `project-os-colector@…` como Editor (paso 4). Menos probable: la API de Sheets apagada en el proyecto; el dashboard ya la usa. |
| *Sync verified evidence* | `Expected exactly one report from the report job` | El artefacto de `report` no trae un informe, o trae más de uno. |

Lo demás no cambia: el paso que falló en `report`, la última fila de `SYNC_RUNS` y cómo apagar el horario están en
[operación](operacion.md#horario-del-colector-ord-pos-172-dec-pos-044-pendiente).

## Por qué no sirvió el binding por subject

Lo observado (logs de *Actions*, job `sync`, las tres corridas con `workflow_dispatch` desde `main` en el commit `48653e7`):

- [45862659405](https://github.com/jlpulido107-bit/PROJECT-OS/actions/runs/45862659405) (26-nov) y
  [46024134102](https://github.com/jlpulido107-bit/PROJECT-OS/actions/runs/46024134102) (27-nov, 15:21 UTC):
  *Authenticate to Google Cloud* pasó y *Sync verified evidence* falló con el 403 de la tabla de arriba.
- [46025090830](https://github.com/jlpulido107-bit/PROJECT-OS/actions/runs/46025090830) (27-nov, 15:27 UTC): en verde,
  seis minutos después y con el mismo código, cuando agregaste a mano el binding
  `principalSet://…/workloadIdentityPools/github-colector/attribute.repository/jlpulido107-bit/PROJECT-OS`.

Lo que eso prueba: el proveedor aceptó el token (su condición usa `repository`, `ref` y `workflow_ref`, no `sub`) y el
atributo `repository` valía `jlpulido107-bit/PROJECT-OS`. Lo que no coincidía era el subject: el del token no era
`repo:jlpulido107-bit/PROJECT-OS:ref:refs/heads/main`, que es el que nombraba el binding. No fue un retraso de
propagación: el binding por subject llevaba al menos un día puesto.

**Hipótesis** de la causa (no vi el token; saberlo con certeza pide una prueba en vivo, que esta orden no hace): GitHub
cambió el formato del subject. Según su documentación, los repositorios creados después del 15-jul-2026 usan por
defecto un subject «inmutable», con los ID numéricos: `repo:OWNER@OWNER-ID/REPO@REPO-ID:ref:refs/heads/BRANCH` en vez
de `repo:OWNER/REPO:ref:refs/heads/BRANCH`
([GitHub, *OpenID Connect reference*, «Immutable subject claims»](https://docs.github.com/en/actions/reference/security/oidc)).
Este repositorio se creó el 2026-10-08 (API de GitHub), así que su subject llevaría esos ID y nunca sería igual al
texto sin ID que escribió ORD-POS-174. El claim `repository`, en cambio, sigue siendo `OWNER/REPO`, y por eso el
binding por `attribute.repository` sí coincide. Otras causas que no puedo descartar sin ver el token: una plantilla
de subject personalizada en el repositorio (misma página, «Customizing the subject claims») o una diferencia de
mayúsculas, que Google sí distingue
([google-github-actions/auth, *Troubleshooting*](https://github.com/google-github-actions/auth/blob/main/docs/TROUBLESHOOTING.md)).

Por qué el binding por repositorio es correcto y no más amplio de la cuenta: Google define `principal://…/subject/…`
para una sola identidad y `principalSet://…/attribute.NOMBRE/VALOR` para las identidades del pool con ese atributo
([Google, *Principal identifiers*](https://docs.cloud.google.com/iam/docs/principal-identifiers)); la guía de
`google-github-actions/auth` usa justo `attribute.repository` para `roles/iam.workloadIdentityUser`
([README](https://github.com/google-github-actions/auth#readme)). En este pool solo entra lo que deja pasar la
condición del proveedor (este repositorio, `main` y el workflow del colector), así que «todas las identidades de este
repositorio» son las mismas corridas de antes. Google recomienda además limitar por los ID numéricos, que no se
reutilizan ([Google, *Workload Identity Federation with deployment pipelines*](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)):
eso pediría modificar el proveedor y queda para otra orden.

Para confirmarlo sin tocar nada, tú puedes ver el subject real en Cloud Shell: en *Logs Explorer*, los registros de
auditoría de `sts.googleapis.com` o de `iamcredentials.googleapis.com` de una corrida muestran el `principalSubject`.
**Hipótesis:** solo aparecen si los registros de acceso a datos de esas API están activados; no lo comprobé.

## Qué no hace

- Ningún agente copia el workflow, ejecuta `wif-colector.sh --apply` (con o sin `--quitar-subject`), concede o quita
  bindings, crea la variable, comparte la hoja, retira el secreto ni borra la clave. Tampoco dispara el workflow.
- No crea claves de cuenta de servicio ni usa `secrets` de Google.
- No da a la cuenta del colector ningún rol en el proyecto, y no toca la cuenta ni el pool del despliegue.
- No cambia el horario, lo que se recoge ni lo que se escribe: sigue añadiendo filas a `EVIDENCIAS` y `SYNC_RUNS`, y
  nada más.
