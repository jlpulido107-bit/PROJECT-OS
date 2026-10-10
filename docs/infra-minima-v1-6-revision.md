# PROJECT-OS V1.6 — Infraestructura mínima (Puerta B): revisión de la V3

> **Estado: preparado para revisión.** Script: [`web/deploy/infra/project-os-infra-minima-v1-6.sh`](../web/deploy/infra/project-os-infra-minima-v1-6.sh).
>
> - **No se ha ejecutado contra Google Cloud.** Ejecutarlo (`--apply`, e incluso `--check`) requiere una autorización
>   expresa posterior.
> - Este documento no autoriza crear recursos, modificar IAM, iniciar builds ni desplegar.

Proyecto `project-os-511102`, región `northamerica-south1`. El historial del repositorio conserva:

1. la V1 literal;
2. la V2, que corrige los 8 hallazgos de la primera revisión;
3. la V3, que atiende las 6 observaciones de supervisión del PR #19.

## 1. Modos del script

| Modo | Qué hace | Consulta GCP | Modifica GCP |
| --- | --- | --- | --- |
| `--plan` (predeterminado) | **Plan estático**: imprime lo que haría | **No**. No comprueba APIs, IAM ni recursos: no es un inventario real | No |
| `--check` | **Comprobación real de solo lectura**: el mismo preflight de `--apply`, incluidas las flags del gcloud instalado (con `--help`, sin red) | Sí, solo lecturas | **Nunca**: termina antes de pedir confirmación |
| `--apply` | Preflight de solo lectura → confirmación `AUTORIZO INFRA PROJECT-OS` → cambios → auditoría | Sí | Sí, solo tras la confirmación |

## 2. Requisitos previos (los verifican `--check` y `--apply`)

- `gcloud` y `python3` disponibles, y una cuenta de gcloud activa con permisos sobre el proyecto.
- El gcloud instalado acepta todas las flags de los comandos mutantes (lista `MUTATING_FLAGS`, comprobada con
  `--help`).
- APIs **ya habilitadas**: `cloudbuild`, `artifactregistry`, `iam` y `storage`. El script no habilita ninguna.
- La cuenta `project-os-build` **ya existe** y, como roles **directos de proyecto**, solo tiene
  `roles/logging.logWriter` o ninguno.
- No existen todavía el repositorio, el bucket ni la cuenta runtime.

## 3. Comandos mutantes (solo en `--apply`, tras `AUTORIZO`)

| # | Comando exacto (resumido) | Resultado y ámbito | Permiso que necesita quien ejecuta (rol típico) | Precondiciones | Costo potencial | Verificación en la auditoría |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `gcloud storage buckets create gs://project-os-511102-project-os-build-src --project=… --location=northamerica-south1 --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=0 --lifecycle-file=…` | Bucket regional privado. Los objetos se borran a los 7 días; sin borrado diferido | `storage.buckets.create` (`roles/storage.admin`) | El nombre está libre (es global) | Almacenamiento Standard regional del código subido (pocos MB, máximo 7 días). Sin costo fijo | Ubicación, acceso uniforme, prevención de acceso público, `retentionDurationSeconds` = 0 y ciclo de vida exacto |
| 2 | `gcloud artifacts repositories create project-os --project=… --location=northamerica-south1 --repository-format=docker` | Repositorio Docker privado | `artifactregistry.repositories.create` (`roles/artifactregistry.admin`) | No existe | Imágenes: 0,5 GiB-mes gratuitos por cuenta de facturación, luego unos USD 0,10/GiB-mes ([preparación §4.1](despliegue-v1-6-preparacion.md#41-precios-y-niveles-gratuitos)). **Sin política de limpieza (§6)** | Formato `DOCKER` |
| 3 | `gcloud iam service-accounts create project-os-dashboard-run --project=…` | Cuenta runtime sin roles ni claves | `iam.serviceAccounts.create` (`roles/iam.serviceAccountCreator`) | No existe | Ninguno | Sin roles directos de proyecto; sin claves gestionadas por el usuario |
| 4 | `gcloud projects add-iam-policy-binding project-os-511102 --project=… --condition=None --member=serviceAccount:project-os-build… --role=roles/logging.logWriter --format=none` | `logWriter` en el proyecto, para la cuenta de compilación | `resourcemanager.projects.setIamPolicy` (`roles/resourcemanager.projectIamAdmin`) | Lista permitida cumplida | Ninguno (los logs entran en el nivel gratuito) | Roles directos de proyecto dentro de la lista permitida, con `logWriter` presente |
| 5 | `gcloud artifacts repositories add-iam-policy-binding project-os --project=… --location=… --member=serviceAccount:project-os-build… --role=roles/artifactregistry.writer --format=none` | `artifactregistry.writer` solo en el repositorio | `artifactregistry.repositories.setIamPolicy` (`roles/artifactregistry.admin`) | Repositorio creado (paso 2) | Ninguno | Binding presente en el repositorio |
| 6 | `gcloud storage buckets add-iam-policy-binding gs://… --project=… --member=serviceAccount:project-os-build… --role=roles/storage.objectViewer --format=none` | `storage.objectViewer` solo en el bucket | `storage.buckets.setIamPolicy` (`roles/storage.admin`) | Bucket creado (paso 1) | Ninguno | Binding presente en el bucket |

El propietario del proyecto tiene todos esos permisos. Los roles típicos son orientativos y no se han verificado contra
el proyecto real.

## 4. Correcciones

### 4.1 Primera revisión: V1 → V2

| # | Hallazgo en la V1 | Corrección | Prueba (`web/tests/infra-minima.test.ts`) |
| --- | --- | --- | --- |
| 1 | `add-iam-policy-binding` imprimía la política completa (con correos) y se mostraba la cuenta activa | `--format=none`; la cuenta se muestra como `***@dominio`; las políticas IAM se procesan en memoria | Bindings con `--format=none`; cuenta enmascarada; ningún `get-iam-policy` en `yaml`/`table`; un único archivo escrito |
| 2 | La auditoría del bucket pedía claves `camelCase` que el SDK no devuelve | Claves `snake_case` del SDK 570.0.0 (`full_resource_formatter.py`, `gcs_json/metadata_util.py`), verificadas una por una | Formato exacto; 1 caso correcto y 8 incorrectos |
| 3 | Solo rechazaba Editor y Owner | Lista **permitida** de roles directos de proyecto (`roles/logging.logWriter`) | Editor, Owner, `run.admin`, otro miembro, JSON no válido |
| 4 | El bucket se creaba tarde y el ciclo de vida se aplicaba con un `update` | Bucket primero, con `--lifecycle-file` en la creación | Orden exacto; sin `update` |
| 5 | Cinco consultas `services list \| grep -q` | Una consulta; los errores de consulta tienen su propio mensaje | Una llamada; `missing_apis` |
| 6 | Repositorio detectado solo por nombre completo | Nombre corto o completo | 7 casos |
| 7 | Requisitos previos implícitos | Enumerados en el plan | Texto del plan |
| 8 | Faltaba `--project` | En todo comando salvo `auth list` | Todas las invocaciones |

### 4.2 Supervisión del PR #19: V2 → V3

| # | Observación | Atención en la V3 | Prueba |
| --- | --- | --- | --- |
| 1 | `--plan` podía tomarse por una validación real | El plan dice **"PLAN ESTÁTICO… NO consulta GCP"**. Nuevo modo **`--check`**: preflight real de solo lectura que termina antes de la confirmación. La ayuda describe los tres modos | Textos del plan y de la ayuda; `--check` llama al preflight y retorna antes de `read` y de cualquier cambio; el preflight no tiene comandos mutantes; 3 combinaciones de argumentos inválidas → código 2 |
| 2 | Falta evidencia integral de `--apply` | Arnés [`simular-infra-minima.sh`](../web/deploy/infra/simular-infra-minima.sh) con `gcloud` falso y 19 escenarios, para un **entorno autorizado** (§8). **No se ejecutó en esta sesión.** El preflight comprueba además las flags con el gcloud instalado (`verify_flags`), que es lo que confirma la versión de Cloud Shell | `verify_flags` con un gcloud falso (todas las flags / falta una); cada flag usada en un comando mutante está declarada; revisión estática del arnés (`bash -n`, sin gcloud real, escenarios) |
| 3 | La auditoría mezclaba errores de lectura con fallos y podía cortarse a mitad | Tres estados: **OK**, **FALLA** (configuración incorrecta) y **NO VERIFICADO** (lectura fallida o formato no reconocido). La auditoría siempre termina y solo al final sale con error. Todo mensaje de error del SDK pasa por `mask_emails` (correos de personas → `***@***`; las cuentas de servicio se conservan) | 4 casos de `check_json` con contadores; solo dos `die`, al final; máscara probada con un gcloud falso |
| 4 | La lista IAM tiene alcance limitado | El plan, la auditoría y este informe dicen "roles **directos** de proyecto" y que **no** certifica herencia, roles en otros recursos ni permisos efectivos. La revisión de IAM heredado sigue siendo manual (consola) | Texto del plan |
| 5 | Limpieza de imágenes sin criterio de bloqueo | Bloqueo verificable **antes del primer build o push** (§6), en el plan y en el runbook | El runbook comprueba la política antes de `gcloud builds submit` y de `docker push` |
| 6 | Fallos parciales sin procedimiento | Matriz de conciliación (§5) | — (documental) |

### 4.3 Simulación local autorizada (gcloud falso, sin GCP)

El propietario autorizó ejecutar el arnés en esta sesión. Resultados y correcciones:

| Hallazgo | Causa | Corrección | Prueba |
| --- | --- | --- | --- |
| 1.ª ejecución: 16/19; `apply-correcto`, `auditoria-no-verificada` y `auditoria-falla` con "orden de cambios inesperado" | **Error del arnés**, no del script. Comparaba las tres primeras palabras de cada comando, y `projects add-iam-policy-binding` tiene dos. El orden real del script era el esperado | Normalización del nombre del comando (dos palabras para `projects add-iam-policy-binding`) | Los 3 escenarios pasan |
| **Error latente del script:** `printf … \| grep -q` con `set -o pipefail` | Con textos mayores que una tubería (~64 KB), `grep -q` termina antes de que `printf` acabe y el SIGPIPE da un falso negativo. En una prueba aislada con 200 KB falló 200/200 veces. Con las ayudas reales del SDK 570.0.0 (≤ 10,5 KB) no falló (0/500), pero una ayuda o una lista más larga haría que `verify_flags` o `in_list` detuvieran el script sin motivo | Here-strings (`grep … <<< "$texto"`) en `in_list`, `repo_in_list`, `bucket_in_list`, `verify_flags` y en la comprobación de correos del arnés | Prueba estática (ningún `\| grep -q`) y funcional con ~200 KB, que falla con el patrón anterior |
| Revisión del PR: el `IFS=$'\n\t'` del arnés podría impedir que el gcloud falso dividiera por espacios las flags, las APIs y los roles | Comprobado: no ocurre. El falso es otro proceso bash, y bash **no hereda `IFS`** del entorno (ni exportado ni con `env`); además se lanza con `env -i`. Las 21 ejecuciones con `apply-correcto` en verde lo confirman, porque ese escenario necesita esas listas bien divididas | Igualmente, tokenización **explícita**: el falso fija `IFS=$' \t\n'` y usa arrays (`read -r -a`) | 6 pruebas que ejecutan **solo el gcloud falso**, con un `IFS` hostil en el entorno: una flag por línea, una API por línea y JSON con varios bindings. Con `IFS=$'\n\t'` forzado dentro del falso, 5 de ellas fallan |
| Un fallo intermitente de `check-con-api-faltante` (falta el texto esperado) en 1 de 22 ejecuciones | **No identificada.** No se reprodujo en las ejecuciones siguientes | El arnés imprime ahora las últimas líneas de la salida, sin correos, cuando un escenario falla | — |

### 4.4 Corrección tras el `--check` real en Cloud Shell (SDK 587.0.0)

El propietario ejecutó `--check` desde `main` (`9dd40b3`) en Cloud Shell. El script se detuvo **sin cambios** y dijo
que faltaban seis flags que sí están en la ayuda real: `storage buckets create` `--public-access-prevention`,
`--soft-delete-duration` y `--lifecycle-file`; `artifacts repositories create` `--location` y `--description`;
`artifacts repositories add-iam-policy-binding` `--location`. El error era de `verify_flags`, no de la versión del SDK.

| Tema | Hallazgo | Corrección |
| --- | --- | --- |
| **Causa raíz** | En una terminal con color, `gcloud … --help` marca las flags con negrita ANSI aunque la salida se capture: `ESC[1m--soft-delete-durationESC[m=ESC[4mSOFT_DELETE_DURATIONESC[m`. El patrón exigía `--flag` seguido de `=`, espacio, `]` o fin de línea, y lo que seguía era `ESC`. Las demás flags pasaban porque también aparecen en texto sin formato (ejemplos o descripciones). Reproducido aquí con el SDK 570.0.0 y `TERM=xterm-256color` (66 líneas con escapes): el patrón anterior marca **exactamente las mismas seis flags**. Con `TERM=dumb`, la ayuda sale sin escapes | La ayuda se pide con `TERM=dumb`. Además se eliminan los escapes ANSI y el sobreimpreso `x<BS>x` (`plain_text`), por si una versión no respeta `TERM`. La flag se busca como **palabra completa** (`--flag` o `--[no-]flag`), sin depender de lo que la rodea. `CLOUDSDK_CORE_DISABLE_COLOR=true` no quita estas negritas (comprobado) |
| `IFS=$'\n\t'` y `command gcloud $cmd --help` | No era la causa: había flags que sí coincidían, así que se obtenía la ayuda del subcomando correcto. Aun así, dividir `$cmd` dependía de un `IFS` local | El comando y las flags se pasan como **arrays** (`IFS=' ' read -r -a`, `"${words[@]}"`). Una prueba comprueba que el gcloud recibe `[storage][buckets][create][--help]` como argumentos separados |
| Mensaje de error | Recomendaba actualizar gcloud, lo cual era engañoso | Ahora pide revisarlo con `gcloud <comando> --help`, sin recomendar ninguna actualización |

**Pruebas de regresión** (`infra-minima.test.ts`, bloque «regresión Cloud Shell»): un gcloud falso que **siempre**
responde con negritas ANSI, con las líneas de sinopsis copiadas de la ayuda real. Las pruebas cubren:

- se aceptan las 17 flags, también con sobreimpreso;
- se llama al comando con argumentos separados y `TERM=dumb`;
- una flag que de verdad falta se sigue detectando (`--soft-delete-duration`, `--location`, `--description`);
- `--condition` no se confunde con `--condition-from-file`.

Contra el `verify_flags` de `9dd40b3`, **4 de estas pruebas fallan**. Con la corrección pasan todas.

**Qué se probó de verdad y qué no.** El patrón nuevo, con `plain_text`, se aplicó a la ayuda **real** capturada del
SDK 570.0.0 con escapes, y encontró las 17 flags. No hay aquí un SDK 587.0.0: la ayuda de las pruebas reproduce su
formato a partir del 570.0.0 y del síntoma que se observó en Cloud Shell. Lo confirmará el `--check` del propietario
en Cloud Shell una vez aprobada la corrección. **No se ejecutó `--check` ni `--apply` contra GCP.**

## 5. Fallo a mitad de `--apply`: conciliación manual

No hay rollback automático. **No se borra nada automáticamente ni se reejecuta a ciegas.** Si se reejecuta, el preflight
se detendrá porque ya existe algún recurso, y eso es intencionado. Identifica el último paso completado con la salida y
estas consultas de **solo lectura**:

| Último paso completado | Estado probable | Consultas de conciliación (solo lectura) | Siguiente acción (manual, con autorización) |
| --- | --- | --- | --- |
| Ninguno (falló el paso 1) | Nada creado. Causa típica: nombre de bucket ocupado o permiso | `gcloud storage buckets describe gs://project-os-511102-project-os-build-src --project=project-os-511102 --format='json(name,location)'` | Si el nombre es ajeno, decidir otro nombre (cambio revisado del script). Si es por permiso, corregirlo y reejecutar |
| 1 (bucket) | Bucket sí; repositorio, cuenta runtime y permisos no | La de arriba y `gcloud artifacts repositories list --project=… --location=northamerica-south1 --format='value(name)'` | Revisar el bucket con la auditoría manual (mismas protecciones). Ejecutar a mano los pasos 2–6 del script, uno a uno y revisados |
| 2 (repositorio) | Además el repositorio | `gcloud iam service-accounts list --project=… --format='value(email)'` | Ejecutar a mano los pasos 3–6 |
| 3 (cuenta runtime) | Además la cuenta runtime, sin roles | `gcloud iam service-accounts keys list --iam-account=project-os-dashboard-run@… --project=… --managed-by=user` | Ejecutar a mano los pasos 4–6 |
| 4–5 (algunos permisos) | Faltan bindings | `get-iam-policy` del proyecto, del repositorio y del bucket con `--format=json`, procesado sin imprimir miembros (como hace la auditoría) | Aplicar solo los bindings que falten |
| 6 (todo), auditoría con FALLA o NO VERIFICADO | Recursos creados; alguna verificación no pasó o no se pudo leer | Repetir la lectura indicada en la línea de la auditoría | FALLA: corregir esa configuración concreta. NO VERIFICADO: repetir la lectura (permiso o red). Nunca borrar sin decisión expresa |

Borrar un recurso creado es una decisión del propietario. Los comandos están en el runbook §7.

## 6. Bloqueo: política de limpieza de imágenes antes del primer build o push

El script crea el repositorio **sin** política de limpieza. **No se compila ni se sube ninguna imagen** hasta que esta
consulta muestre las políticas `conservar-3-recientes` y `borrar-mayores-30-dias`
([`artifact-cleanup-policy.json`](../web/deploy/cloudrun/artifact-cleanup-policy.json)):

```bash
gcloud artifacts repositories list-cleanup-policies project-os --project=project-os-511102 --location=northamerica-south1
```

El runbook (§5.5) incluye esta comprobación antes de las opciones A (Cloud Build) y B (Docker local), y una prueba
asegura que la comprobación aparece antes de ambas. Aplicar la política es otra decisión (`set-cleanup-policies`,
runbook §5.5).

## 7. Evidencia (2026-10-10), por tipo

| Tipo | Qué | Resultado |
| --- | --- | --- |
| **Estática** | `bash -n` del script y del arnés | OK |
| **Estática** | ShellCheck 0.11.0 `-S style`, script y arnés | Sin avisos |
| **Estática** | Pruebas del texto del script (orden, alcance, flags, privacidad, `--check`, auditoría) y del arnés; `bash -n` y ShellCheck también del gcloud falso extraído | Incluidas en las 77 pruebas de `infra-minima.test.ts` |
| **Funciones aisladas** | Funciones cargadas con `source` (no ejecuta `main`): listas, roles, bucket, `check_json`, máscara, `verify_flags` con un gcloud **falso**, también con textos de ~200 KB y con ayuda en negrita ANSI (§4.4). El gcloud falso del arnés, ejecutado solo | Incluidas en las 77 pruebas |
| **Ejecución local limitada** | `--plan`, sin argumentos y con argumentos inválidos, con un gcloud falso que deja una marca si se invoca | Código 0 o 2; gcloud nunca invocado |
| **Mutaciones** | Variantes deliberadamente incorrectas del script y del runbook | Cada una hace fallar al menos una prueba |
| **Simulación de `--plan`, `--check` y `--apply` con gcloud falso** | Arnés `simular-infra-minima.sh`, ejecutado en esta sesión con **autorización expresa del propietario**. El primer intento, sin esa autorización, fue bloqueado por el entorno y no se eludió | Versión final (con la tokenización explícita): **19/19 en 11 ejecuciones consecutivas**; antes de ese cambio, 19/19 en otras 21. Con la corrección de `verify_flags` (§4.4), 19/19. Ninguna llamada salió del gcloud falso (el arnés aborta si `gcloud` no resuelve al falso). Historial en §4.3 |
| **Contra GCP real** | Cualquier modo salvo `--plan` | **No ejecutado** |

Los resultados de CI de cada SHA se publican en el PR.

## 8. Prueba en un entorno autorizado (antes de pedir `--apply`)

1. En un equipo o en Cloud Shell, con autorización del propietario, clonar el repositorio en el SHA revisado.
2. Ejecutar `bash web/deploy/infra/simular-infra-minima.sh`. Usa **solo** un gcloud falso: entorno vacío, `PATH` con el
   falso primero y aborta si `gcloud` resolviera a otro. Recorre 19 escenarios:
   - `--plan`;
   - `--check`;
   - `--apply` completo;
   - confirmación incorrecta, línea vacía y sin entrada;
   - API faltante y error de consulta;
   - cuenta de compilación ausente o con roles extra (`run.admin`, Editor);
   - cuenta runtime, repositorio (nombre corto o completo) o bucket existentes;
   - gcloud sin una flag;
   - `--check` con una API faltante;
   - auditoría NO VERIFICADO y FALLA.
3. Resultado esperado: `19 escenarios correctos, 0 con problemas`. Registrar la salida sin datos sensibles; no
   contiene correos de personas.
4. Después, con autorización separada, ejecutar `--check` en Cloud Shell contra el proyecto real (solo lectura) y
   revisar su salida.
5. Solo entonces solicitar autorización para `--apply`.

## 9. Uso cuando se autorice `--apply`

1. Leer el script completo y este informe.
2. `--plan` (estático) y `--check` (solo lectura) en Cloud Shell.
3. `--apply`: revisar el preflight y escribir `AUTORIZO INFRA PROJECT-OS`.
4. La auditoría debe terminar con `FINALIZADO: auditoría correcta`. Ante FALLA, NO VERIFICADO o un error: §5.
5. Registrar el resultado sin correos ni datos sensibles.

## 10. Riesgos pendientes

| # | Riesgo | Mitigación / estado |
| --- | --- | --- |
| P1 | Nunca ejecutado contra GCP: permisos efectivos, políticas de organización y comportamiento real sin probar | `--check` (solo lectura) y luego `--apply` con autorización. `verify_flags` cubre la versión del SDK. El primer `--check` real (SDK 587.0.0) se detuvo sin cambios por un falso negativo de `verify_flags`; está corregido (§4.4) y el propietario debe repetir `--check` |
| P2 | La simulación usa un gcloud falso: valida el flujo, el orden, los abortos y la privacidad, no el comportamiento real de GCP. Hubo un fallo intermitente sin causa identificada (§4.3) | `--check` real (solo lectura) con autorización separada. Ejecutar el arnés en CI sería otra opción, pero cambia los workflows y requiere aprobación |
| P3 | Sin rollback automático | Orden con el paso más frágil primero; matriz de conciliación (§5) |
| P4 | Nombre de bucket global | Fallaría el primer cambio sin dejar nada más creado |
| P5 | Ventana entre el preflight y la creación | La creación fallaría y no modificaría recursos ajenos |
| P6 | La lista permitida solo cubre roles **directos de proyecto**; no certifica herencia, roles en otros recursos ni permisos efectivos | IAM heredado revisado a mano en la consola. Esa evidencia sigue siendo manual |
| P7 | La auditoría depende del formato de salida del SDK | Un formato distinto da NO VERIFICADO o FALLA (seguro) y requiere revisión manual |
| P8 | Política de limpieza de imágenes no aplicada | **Bloqueo** antes del primer build o push (§6) |
| P9 | La persona no puede actuar como `project-os-build` | Autorización separada (runbook §5.5, A.1) |
| P10 | Secret Manager API no habilitada | Necesaria antes del lote de secretos |
| P11 | La cuenta predeterminada de Compute puede tener Editor | No se usa. Quitárselo es una decisión aparte |
| P12 | Costos del bucket y del repositorio; no se crea presupuesto | Un presupuesto no es un límite ([preparación §4.4](despliegue-v1-6-preparacion.md#44-presupuestos-y-alertas)) |
| P13 | La máscara de correos usa una expresión regular | Cubre formatos habituales. Revisar la salida antes de publicarla como evidencia |
