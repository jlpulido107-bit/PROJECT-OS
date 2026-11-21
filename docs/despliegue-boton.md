# Botón de despliegue del dashboard

Guía del propietario (ORD-POS-163, POS-062). **DEC-POS-036: PENDIENTE.** Hasta que la apruebes, nada de esto se usa: el
workflow vive fuera de `.github/` y no corre, y el script de identidad solo simula.

Qué es: un botón en GitHub Actions («Desplegar dashboard») que construye la imagen del commit de `main`, la publica y
despliega **solo la imagen** con [`deploy.sh --desde-activa --solo-imagen`](../web/deploy/cloudrun/deploy.sh)
(ORD-POS-162). Sustituye el paso a mano en Cloud Shell; las reglas de [cuándo se despliega](operacion.md#cuándo-se-despliega-dec-pos-017-aprobada)
no cambian, y solo tú lo disparas y lo apruebas.

Piezas:

| Pieza | Qué hace |
|---|---|
| [`web/deploy/github/desplegar-dashboard.yml`](../web/deploy/github/desplegar-dashboard.yml) | El workflow. Va fuera de `.github/`: solo corre cuando tú lo copias a `.github/workflows/` (paso 5). |
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

Requisito: ORD-POS-162 fusionada en `main` (aporta `--solo-imagen`, `imagen.sh` y `humo.sh`) y DEC-POS-036 aprobada.

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

En un PR tuyo (los agentes no tocan `.github/workflows`):

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

## Qué no hace

- No lo copia, dispara ni aprueba ningún agente; ningún agente ejecuta `wif-despliegue.sh --apply` ni cambia
  `DESPLIEGUE_BOTON`.
- No crea claves de cuenta de servicio ni usa `secrets`.
- No cambia variables del servicio: `--solo-imagen` se detiene si hay algo más que la imagen y `DEPLOY_COMMIT_SHA`.
