# Botón de despliegue del dashboard

Guía del propietario (ORD-POS-163, POS-062). **DEC-POS-036: APROBADA**, corregida por **DEC-POS-040** (APROBADA):
el botón es la vía normal para desplegar la imagen; Cloud Shell queda para banderas, secretos, IAM y plan B
([operación](operacion.md#despliegue)).

Nombres vigentes (DEC-POS-040, punto 1): la cuenta de despliegue es `project-os-despliegue` y la variable del
repositorio es `DESPLIEGUE_BOTON`. Son los del código; los que traía el texto de DEC-POS-036 ya no valen.

Qué es: un botón en GitHub Actions («Desplegar dashboard») que construye la imagen del commit de `main`, la publica y
despliega **solo la imagen** con [`deploy.sh --desde-activa --solo-imagen`](../web/deploy/cloudrun/deploy.sh)
(ORD-POS-162). Sustituye el paso a mano en Cloud Shell; las reglas de [cuándo se despliega](operacion.md#cuándo-se-despliega-dec-pos-017-aprobada)
no cambian, y solo tú lo disparas y lo apruebas.

Piezas:

| Pieza | Qué hace |
|---|---|
| [`web/deploy/github/desplegar-dashboard.yml`](../web/deploy/github/desplegar-dashboard.yml) | La fuente del workflow. Corre la copia de `.github/workflows/`, que pusiste tú (paso 5); el preflight P15 exige que las dos sean idénticas (ORD-POS-167, [PR #373](https://github.com/jlpulido107-bit/PROJECT-OS/pull/373)). |
| [`web/deploy/infra/wif-despliegue.sh`](../web/deploy/infra/wif-despliegue.sh) | Da a GitHub acceso a Google Cloud sin claves (Workload Identity Federation). Simula por defecto; aplica con `--apply`. |
| `web/deploy/ci/imagen.sh` y `humo.sh` (llegan con ORD-POS-162, [PR #363](https://github.com/jlpulido107-bit/PROJECT-OS/pull/363)) | Construyen y publican la imagen, y verifican el despliegue con humo y reversión (ORD-POS-162). |

## Qué hace el workflow

1. **Compuerta** (sin permisos de Google Cloud): sigue solo si la variable `DESPLIEGUE_BOTON` es exactamente `true`
   (ni `TRUE`, ni ` true`, ni vacía), si se disparó desde `main` y si el commit es un SHA de 40 hexadecimales.
2. **Desplegar** (environment `produccion`, que tú apruebas en GitHub): es el único job con `id-token: write`. Entra a
   Google Cloud con la cuenta de despliegue, construye la imagen con la etiqueta del commit, corre el humo local, la
   publica, anota la revisión que hoy sirve el 100 %, despliega con `--solo-imagen` exportando solo `IMAGE` y
   `DEPLOY_COMMIT_SHA` (nunca `--quitar`) y corre el humo remoto. Si el humo remoto falla, el tráfico vuelve a la
   revisión anotada y el job queda en rojo.

No usa `secrets`, no cambia variables del servicio, no cambia IAM y no se dispara solo.

## Pasos (una sola vez, en Cloud Shell)

Requisito: ORD-POS-162 fusionada en `main` (aporta `--solo-imagen`, `imagen.sh` y `humo.sh`) y DEC-POS-036 aprobada;
las dos se cumplen. Los pasos 1 a 5 se hacen una vez; el uso de cada día es el paso 6. `gcloud` se usa en Cloud Shell,
no en la Mac (DEC-POS-040, punto 3).

### 1. Variables de shell

Pega esto tal cual en Cloud Shell, dentro del clon de PROJECT-OS. Cada valor sale de lo que ya usa
`deploy.sh` (proyecto) o del propio script de identidad (pool, proveedor y cuenta); `NUMERO_PROYECTO` lo da Google:

```bash
PROJECT_ID=project-os-511102
NUMERO_PROYECTO="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
POOL=github
PROVEEDOR=github-actions
CUENTA_DESPLIEGUE="project-os-despliegue@${PROJECT_ID}.iam.gserviceaccount.com"
WIF_PROVIDER="projects/${NUMERO_PROYECTO}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVEEDOR}"
WIF_SERVICE_ACCOUNT="$CUENTA_DESPLIEGUE"
echo "$NUMERO_PROYECTO"
```

`echo` debe mostrar solo dígitos. Si sale vacío, tu sesión de `gcloud` no apunta al proyecto: no sigas.

### 2. Simular la identidad

```bash
bash web/deploy/infra/wif-despliegue.sh
```

No llama a `gcloud`: imprime lo que haría. Revisa que el proveedor solo acepte `jlpulido107-bit/PROJECT-OS`, la rama
`main` y el environment `produccion`, y que los roles sean los cuatro de la cabecera del script.

### 3. Aplicar la identidad

```bash
bash web/deploy/infra/wif-despliegue.sh --apply
```

Pide escribir `AUTORIZO WIF`. Lo que ya existe no se vuelve a crear. Al final imprime `WIF_PROVIDER` y
`WIF_SERVICE_ACCOUNT`; deben coincidir con el paso 1:

```bash
echo "$WIF_PROVIDER"
echo "$WIF_SERVICE_ACCOUNT"
```

### 4. Environment y variables en GitHub

En el repositorio, *Settings → Environments → New environment*, nombre `produccion`:

- *Required reviewers*: tú.
- *Deployment branches and tags*: *Selected branches*, solo `main`.

En *Settings → Secrets and variables → Actions → Variables* (variables, no secrets), crea `WIF_PROVIDER` y
`WIF_SERVICE_ACCOUNT` con los dos valores que imprimió el `echo` anterior, y `DESPLIEGUE_BOTON` con `false`.

### 5. Copiar el workflow

En un PR tuyo (los agentes no tocan `.github/workflows`; `main` exige PR). Si la fuente cambia, se repite la copia:
P15 falla mientras no sean idénticas.

```bash
cp web/deploy/github/desplegar-dashboard.yml .github/workflows/desplegar-dashboard.yml
```

### 6. Encender, usar y apagar

- **Encender:** cambia `DESPLIEGUE_BOTON` a `true` (exactamente así, en minúsculas y sin espacios).
- **Usar:** *Actions → Desplegar dashboard → Run workflow*, rama `main`; aprueba el despliegue a `produccion`. Registra
  la revisión nueva como siempre ([operación](operacion.md#despliegue)).
- **Apagar:** cambia `DESPLIEGUE_BOTON` a `false`. Para cortar también el acceso a Google Cloud, quita el permiso
  `roles/iam.workloadIdentityUser` de la cuenta de despliegue.

Si algo sale mal después del despliegue, la reversión manual es la de siempre
([runbook §6](operacion-v1-6/runbook-operativo.md)).

## Errores conocidos

### 403 `iam.serviceAccounts.getAccessToken` en el primer intento (2026-11-21)

Qué pasó: el primer intento del botón, el 2026-11-21, falló con un 403 que nombra el permiso
`iam.serviceAccounts.getAccessToken` sobre la cuenta de despliegue. Fuente: orden ORD-POS-168
([issue #371](https://github.com/jlpulido107-bit/PROJECT-OS/issues/371)).

Causa: propagación de IAM. Ese permiso lo da `roles/iam.workloadIdentityUser`, que el paso 3 concede a la identidad de
GitHub sobre la cuenta de despliegue; un permiso recién concedido tarda en valer en todo Google Cloud. No es un error
del workflow ni de las variables.

Cómo verificarlo, en Cloud Shell y con las variables del paso 1:

```bash
gcloud iam service-accounts get-iam-policy "$CUENTA_DESPLIEGUE" --project "$PROJECT_ID"
```

Debe listar `roles/iam.workloadIdentityUser` con un miembro que termina en
`subject/repo:jlpulido107-bit/PROJECT-OS:environment:produccion`.

- **Sale:** el permiso está concedido y solo falta que se propague. Espera unos minutos y vuelve a disparar el botón;
  no repitas el paso 3 ni cambies nada.
- **No sale:** el permiso no se concedió. Repite el paso 3; lo que ya existe no se vuelve a crear.

Si el 403 sigue con el permiso ya listado, compara `WIF_PROVIDER` y `WIF_SERVICE_ACCOUNT` de GitHub con los del paso 1,
y revisa que el disparo fue desde `main` y pasó por el environment `produccion`: la identidad solo vale con las tres
cosas (paso 2).

## Qué no hace

- No lo copia, dispara ni aprueba ningún agente; ningún agente ejecuta `wif-despliegue.sh --apply` ni cambia
  `DESPLIEGUE_BOTON`, banderas, variables, secretos, IAM o GCP (DEC-POS-036).
- No crea claves de cuenta de servicio ni usa `secrets`.
- No cambia variables del servicio: `--solo-imagen` se detiene si hay algo más que la imagen y `DEPLOY_COMMIT_SHA`.
