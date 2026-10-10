# PROJECT-OS V1.6 — Puerta C: preparación segura del despliegue

> **Misión 012.** Solo preparación: documentación, verificaciones y un script con modos de solo lectura.
>
> - **No se ejecutó nada contra GCP** desde esta sesión: ni lecturas ni cambios.
> - No se crearon recursos, secretos, builds ni despliegues, y no se modificó Google Sheets.
> - Este documento **no autoriza** ninguna operación: cada mutación de §3 está *pendiente de autorización*.
>
> Proyecto `project-os-511102`, región `northamerica-south1`. Runbook: [despliegue privado](despliegue-privado-v1-3.md).

## 1. Estado real de partida

La Puerta B (infraestructura mínima) la ejecutó el propietario con el script V3 y **reportó** una auditoría final
correcta. Ese resultado no se verificó desde este repositorio: la operación de solo lectura **C0** (§3) lo confirma
antes de seguir. **No se vuelve a ejecutar el script de infraestructura.**

| Recurso | Estado | Fuente |
| --- | --- | --- |
| APIs `cloudbuild`, `artifactregistry`, `iam` y `storage` | Existente (Puerta B) | Requisito de `--check` del script V3, que se detiene si falta alguna |
| Bucket privado `project-os-511102-project-os-build-src` (ciclo de vida de 7 días, sin borrado diferido) | Existente (Puerta B) | Auditoría del script V3, según el propietario |
| Repositorio Docker `project-os` en `northamerica-south1` | Existente (Puerta B), **sin política de limpieza** | El script V3 no la aplica ([revisión §6](infra-minima-v1-6-revision.md)) |
| Cuenta runtime `project-os-dashboard-run`, sin roles ni claves | Existente (Puerta B) | Auditoría del script V3 |
| Cuenta de compilación `project-os-build` con 3 permisos acotados | Existente (Puerta B) | Auditoría del script V3 |
| Política de limpieza del repositorio | Pendiente: **C1** (bloquea el primer build) | §2 |
| APIs `run`, `secretmanager` y `sheets` | Pendiente: **C2** | — |
| Presupuesto y alertas | Pendiente: **C3** | §6 |
| Pantalla de consentimiento y cliente OAuth de producción | Pendiente: **C4** | §5 |
| 3 secretos y su acceso para la cuenta runtime | Pendiente: **C5**, **C6** | §4 |
| Acceso Lector de la cuenta runtime al Sheets maestro | Pendiente: **C7** | §5 |
| Imagen, servicio de Cloud Run, invocación pública | Fuera de la Puerta C (puerta 3 del runbook, autorización aparte) | Runbook §5.5–§5.7 |

## 2. Revisión de la política de limpieza

Archivo: [`web/deploy/cloudrun/artifact-cleanup-policy.json`](../web/deploy/cloudrun/artifact-cleanup-policy.json).

| Regla | Acción | Selección | Efecto |
| --- | --- | --- | --- |
| `conservar-3-recientes` | Keep | `mostRecentVersions.keepCount: 3` | Conserva las 3 versiones más recientes de cada paquete (aquí, la imagen `dashboard`) |
| `borrar-mayores-30-dias` | Delete | `tagState: ANY`, `olderThan: 2592000s` (30 días) | Marca para borrar toda versión de más de 30 días, **tenga etiqueta o no** |

**Prioridad.** Si una versión cumple una regla Keep y una Delete, **se conserva**: Keep tiene prioridad sobre
Delete [M] ([política de limpieza](https://cloud.google.com/artifact-registry/docs/repositories/cleanup-policy)).
El resultado neto es:

- se conserva toda versión de 30 días o menos;
- de las versiones de más de 30 días, se conservan solo las que estén entre las 3 más recientes;
- **siempre quedan al menos las 3 imágenes más recientes**, aunque no se compile en meses.

| Escenario | Resultado |
| --- | --- |
| 1 build al mes durante un año | Quedan las 3 últimas; las anteriores se borran |
| 10 builds en una semana | Quedan las 10 mientras tengan ≤ 30 días; después, solo las 3 últimas |
| Sin builds durante 6 meses | Quedan las 3 últimas: la regla Keep impide quedarse sin imagen |
| Revisión desplegada con una imagen que ya no está entre las 3 últimas y tiene más de 30 días | **Se borra.** Ver el riesgo PC1 (§8) |

**Compatibilidad con el repositorio Docker.**

- **Formato aceptado por el SDK.** El archivo se procesó con el parser del propio SDK 570.0.0, en local y sin red
  (`cleanup_policy_util.ParseCleanupPolicy`):
  - lista de políticas con `name` único;
  - `action.type`;
  - en cada política, `condition` o `mostRecentVersions`, nunca los dos;
  - duración convertida a `2592000.0s`.
- **Repositorios Docker.** Admiten políticas de limpieza [M]. La política no usa prefijos de etiqueta, de versión ni
  de paquete, así que se aplica a todas las imágenes del repositorio. Hoy solo existe `dashboard`.
- **`set-cleanup-policies` reemplaza el mapa completo de políticas** del repositorio: actualiza el campo con
  `read_modify_update`, según la definición del comando en el SDK. Por eso el script se detiene si ya hay **otras**
  políticas.
- **Dry run.** El comando trata `--[no-]dry-run` como un booleano de tres estados (`default: null`): sin la flag,
  conserva el valor que tenga el repositorio. El script fija `--no-dry-run` y después comprueba
  `cleanupPolicyDryRun=false`. Si el dry run siguiera activo, la política solo registraría lo que borraría.
- **Cuándo actúa.** Las políticas se evalúan en segundo plano y de forma periódica, no al instante [M]. El borrado lo
  hace el agente de servicio de Artifact Registry, que ya tiene el permiso por defecto [M]. Que la política esté
  aplicada no significa que ya haya borrado nada.
- **Costo.** La política reduce el almacenamiento (≈ 104 MB por imagen; 0,5 GiB-mes gratis por cuenta de facturación,
  [preparación §4.1](despliegue-v1-6-preparacion.md#41-precios-y-niveles-gratuitos)).

**Conclusión:** la política es correcta para V1.6 y **se mantiene sin cambios**. La regla adicional opcional (D-C1)
queda como decisión del propietario (§7).

## 3. Operaciones de la Puerta C

Orden propuesto (cada paso de **mutación** necesita autorización expresa y separada):

| Paso | Operación | Tipo |
| --- | --- | --- |
| 1 | C0 — Preflight de la Puerta C | Solo lectura |
| 2 | C3 — Presupuesto y alertas (antes de cualquier cosa facturable) | Mutación |
| 3 | C1 — Aplicar la política de limpieza | Mutación |
| 4 | C1v — Verificar la política (bloqueo antes del primer build) | Solo lectura |
| 5 | C2 — Habilitar las APIs de Cloud Run, Secret Manager y Sheets | Mutación |
| 6 | C4 — Pantalla de consentimiento y cliente OAuth | Mutación |
| 7 | C5 — Crear los 3 secretos | Mutación |
| 8 | C6 — Acceso de la cuenta runtime a los 3 secretos | Mutación |
| 9 | C7 — Compartir el Sheets maestro como Lector | Mutación |
| 10 | C8 — Verificación final de la Puerta C | Solo lectura |

Variables comunes (no secretas), en una terminal **bash** autenticada como el propietario:

```bash
export PROJECT_ID="project-os-511102" REGION="northamerica-south1" REPO="project-os"
export RUNTIME_SA="project-os-dashboard-run@${PROJECT_ID}.iam.gserviceaccount.com"
export BUILD_SA="project-os-build@${PROJECT_ID}.iam.gserviceaccount.com"
```

### 3.1 Operaciones de solo lectura

#### C0 — Preflight de la Puerta C

- **Tipo:** Solo lectura. No cambia nada; se puede repetir.
- **Comando:**

  ```bash
  gcloud services list --enabled --project="$PROJECT_ID" --format='value(config.name)' | sort
  gcloud artifacts repositories describe "$REPO" --project="$PROJECT_ID" --location="$REGION" \
    --format='value(format,cleanupPolicyDryRun)'
  gcloud iam service-accounts describe "$RUNTIME_SA" --project="$PROJECT_ID" --format='value(disabled)'
  gcloud projects get-iam-policy "$PROJECT_ID" --flatten='bindings[].members' \
    --filter="bindings.members:serviceAccount:${RUNTIME_SA}" --format='value(bindings.role)'
  gcloud iam service-accounts keys list --iam-account="$RUNTIME_SA" --project="$PROJECT_ID" \
    --managed-by=user --format='value(name)'
  bash web/deploy/infra/limpieza-artifact-v1-6.sh --plan
  ```

- **Precondiciones:** `gcloud` autenticado con la cuenta propietaria; repositorio en `main` actualizado.
- **Impacto:** ninguno. Consultas de lectura sin costo apreciable. No imprime políticas completas ni correos de
  personas.
- **Verificación (esperado):**
  - las APIs de la Puerta B aparecen;
  - el repositorio es `DOCKER`;
  - la cuenta runtime existe y no está deshabilitada;
  - la consulta de roles de proyecto y la de claves salen **vacías**;
  - `--plan` termina con "archivo de la política correcto".
- **Si falla:** **detenerse**. Una diferencia con el estado de la Puerta B (falta un recurso o la runtime tiene
  roles o claves) se revisa a mano con la [matriz de conciliación](infra-minima-v1-6-revision.md); **no** se vuelve
  a ejecutar el script de infraestructura.

#### C1v — Verificar la política de limpieza (bloqueo antes del primer build)

- **Tipo:** Solo lectura. Es el **bloqueo antes del primer build o push**.
- **Comando:** `bash web/deploy/infra/limpieza-artifact-v1-6.sh --check`
- **Precondiciones:** C1 aplicada.
- **Impacto:** ninguno: un único `describe` del repositorio.
- **Verificación (esperado):** código 0 y `PERMITIDO`. El script comprueba formato `DOCKER`, exactamente las dos
  políticas del archivo (mismas acciones, `keepCount` y antigüedad) y `cleanupPolicyDryRun=false`.
- **Si falla:** termina con `BLOQUEADO` y código 1. **No se compila ni se sube ninguna imagen** (ni Cloud Build ni
  Docker local) hasta que pase. Revisar la línea `FALLA` y volver a C1.

#### C8 — Verificación final de la Puerta C

- **Tipo:** Solo lectura. Se ejecuta al terminar C1–C7, antes de pedir la autorización del primer build.
- **Comando:**

  ```bash
  bash web/deploy/infra/limpieza-artifact-v1-6.sh --check
  gcloud services list --enabled --project="$PROJECT_ID" --format='value(config.name)' \
    | grep -E '^(run|secretmanager|sheets)\.googleapis\.com$'
  for s in project-os-nextauth-secret project-os-google-client-secret project-os-allowed-emails; do
    gcloud secrets versions list "$s" --project="$PROJECT_ID" --format='value(name,state)'
    gcloud secrets get-iam-policy "$s" --project="$PROJECT_ID" --flatten='bindings[].members' \
      --format='value(bindings.role,bindings.members)'
  done
  gcloud projects get-iam-policy "$PROJECT_ID" --flatten='bindings[].members' \
    --filter="bindings.members:serviceAccount:${RUNTIME_SA}" --format='value(bindings.role)'
  ```

- **Precondiciones:** C1–C7 completadas.
- **Impacto:** ninguno. **Nunca** se lee el contenido de un secreto.
- **Verificación (esperado):**
  - `--check` dice `PERMITIDO`;
  - aparecen las 3 APIs;
  - cada secreto tiene solo la versión `1`, en estado `ENABLED`;
  - cada política de secreto tiene **una sola** fila: `roles/secretmanager.secretAccessor` para
    `serviceAccount:${RUNTIME_SA}`;
  - la cuenta runtime sigue **sin** roles de proyecto;
  - en la consola están el presupuesto (C3), el cliente OAuth (C4) y el Lector de la hoja (C7).
- **Si falla:** no se pide el primer build. Se corrige la operación correspondiente y se repite C8. El resultado se
  registra con ✅/❌, sin secretos, correos ni IDs de facturación.

### 3.2 Mutaciones (cada una requiere autorización expresa)

#### C1 — Aplicar la política de limpieza

- **Tipo:** Mutación — requiere autorización. **Estado:** Pendiente de autorización.
- **Comando:**

  ```bash
  bash web/deploy/infra/limpieza-artifact-v1-6.sh --apply   # pide escribir: AUTORIZO LIMPIEZA PROJECT-OS
  ```

  Equivale a `gcloud artifacts repositories set-cleanup-policies project-os --project=project-os-511102
  --location=northamerica-south1 --policy=web/deploy/cloudrun/artifact-cleanup-policy.json --no-dry-run`, con los
  controles del script.
- **Precondiciones:**
  - C0 correcto;
  - el repositorio existe, es `DOCKER` y no tiene **otras** políticas (el script lo comprueba antes de preguntar);
  - el archivo de la política es el revisado (el script lo compara con la política fijada en él).
- **Impacto:**
  - un único cambio de configuración del repositorio;
  - hoy no hay imágenes, así que no borra nada;
  - en el futuro borrará versiones según §2;
  - sin costo propio.
- **Verificación:** el script repite C1v al terminar y dice `FINALIZADO`. Además, en la consola
  (*Artifact Registry → project-os → Políticas de limpieza*) aparecen las dos reglas, sin dry run.
- **Si falla:**
  - Si se cancela o el preflight se detiene, no hubo cambios.
  - Si `set-cleanup-policies` falla, ejecutar C1v: si el repositorio no cambió, no hay nada que revertir.
  - Si la verificación posterior falla, **no compilar**. Revisar en la consola. Se revierte con
    `gcloud artifacts repositories delete-cleanup-policies project-os --project="$PROJECT_ID" --location="$REGION"
    --policynames=conservar-3-recientes,borrar-mayores-30-dias`, lo que deja el repositorio como lo dejó la
    Puerta B.

#### C2 — Habilitar las APIs de Cloud Run, Secret Manager y Sheets

- **Tipo:** Mutación — requiere autorización. **Estado:** Pendiente de autorización.
- **Comando:**

  ```bash
  gcloud services enable run.googleapis.com secretmanager.googleapis.com sheets.googleapis.com --project="$PROJECT_ID"
  ```

- **Precondiciones:** C0 correcto; facturación vinculada al proyecto (ya lo está, porque la Puerta B creó recursos).
- **Impacto:**
  - habilitar una API no cuesta por sí mismo; se paga el uso;
  - Google crea los agentes de servicio de esas APIs;
  - no se conceden roles a cuentas del proyecto;
  - `sheets` es necesaria porque el token de la cuenta runtime consume la cuota de este proyecto.
- **Verificación:** la línea de APIs de C8 muestra las tres.
- **Si falla:** es idempotente y se puede repetir. Un error de permisos o de facturación no deja cambios parciales
  relevantes. Para revertir: `gcloud services disable … --project="$PROJECT_ID"`, solo mientras no existan recursos
  que dependan de la API.

#### C3 — Presupuesto y alertas

- **Tipo:** Mutación — requiere autorización. **Estado:** Pendiente de autorización.
- **Comando:** la **consola** es la opción recomendada: *Facturación → Presupuestos y alertas → Crear presupuesto*,
  con estos valores:
  - Alcance: solo el proyecto `project-os-511102`, todos los servicios.
  - Periodo: mensual. Importe: decisión D6 (propuesta: USD 5).
  - Umbrales (D7): 50 %, 90 % y 100 % del gasto **real**, y 100 % del gasto **previsto**.
  - Avisos: correo a administradores y usuarios de la cuenta de facturación. **Sin** acciones automáticas.

  Alternativa por CLI: el comando del runbook §5.2. Requiere además la API `billingbudgets.googleapis.com`, que es
  otra mutación; por eso se prefiere la consola.
- **Precondiciones:**
  - decisiones D6 y D7;
  - la persona tiene permiso para gestionar presupuestos en la cuenta de facturación (administrador de facturación
    o gestor de costos).
- **Impacto:** sin costo. **No limita el gasto**: solo avisa, y con retraso (§6).
- **Verificación:** el presupuesto aparece en la consola con el alcance y los umbrales acordados. Se registra solo
  "creado", sin el ID de la cuenta de facturación.
- **Si falla:** no afecta a otros recursos. Corregir en la consola o borrar el presupuesto y crearlo de nuevo.

#### C4 — Pantalla de consentimiento y cliente OAuth de producción

- **Tipo:** Mutación — requiere autorización. **Estado:** Pendiente de autorización.
- **Comando:** se hace en la consola, en *Google Auth Platform*. La lista detallada está en §5.1.
- **Precondiciones:**
  - D9 (tipo de usuario) y D5 (correos), decididos fuera del repositorio;
  - `SERVICE_URL` calculada (§5.1). El número de proyecto no se escribe en el repositorio.
- **Impacto:**
  - sin costo;
  - crea una credencial: el secreto del cliente se copia **directamente** a C5 y no se guarda en archivos, chats ni
    capturas;
  - el cliente de localhost no se reutiliza ni se modifica.
- **Verificación:**
  - los orígenes y la redirección coinciden carácter por carácter con §5.1;
  - los alcances son solo `openid`, `email` y `profile`;
  - con tipo *Externo*, el estado es *Prueba* y los usuarios de prueba son los de D5.
- **Si falla:**
  - Los cambios pueden tardar de 5 minutos a horas en aplicarse [M]: crear el cliente **antes** de la ventana de
    despliegue.
  - Si el secreto del cliente se pierde o se expone, se añade un secreto nuevo al cliente y se desactiva el anterior.
  - Para revertir, se borra el cliente.

#### C5 — Crear los 3 secretos

- **Tipo:** Mutación — requiere autorización. **Estado:** Pendiente de autorización.
- **Comando** (los valores se teclean ocultos; ninguno aparece en pantalla, en el historial ni en este documento):

  ```bash
  # Secreto de sesión NUEVO, generado en local (no reutilizar el de localhost):
  openssl rand -base64 32 | tr -d '\n' | gcloud secrets create project-os-nextauth-secret \
    --project="$PROJECT_ID" --replication-policy=automatic --data-file=-

  # Secreto del cliente OAuth de producción (C4):
  read -r -s -p "GOOGLE_CLIENT_SECRET de producción: " V; echo
  printf '%s' "$V" | gcloud secrets create project-os-google-client-secret \
    --project="$PROJECT_ID" --replication-policy=automatic --data-file=-; unset V

  # Correos permitidos (D5), separados por comas:
  read -r -s -p "AUTH_ALLOWED_EMAILS: " V; echo
  printf '%s' "$V" | gcloud secrets create project-os-allowed-emails \
    --project="$PROJECT_ID" --replication-policy=automatic --data-file=-; unset V
  ```

- **Precondiciones:**
  - C2 (API de Secret Manager habilitada);
  - C4 (secreto del cliente);
  - D5 (lista de correos);
  - D-C2: replicación decidida (§7);
  - terminal bash sin `set -x`.
- **Impacto:**
  - 3 secretos con una versión activa cada uno;
  - costo: 6 versiones activas gratis por cuenta de facturación; si no quedan, ≈ USD 0,18 al mes
    ([preparación §4.1](despliegue-v1-6-preparacion.md#41-precios-y-niveles-gratuitos));
  - nadie más que el propietario tiene acceso hasta C6.
- **Verificación:**
  - `gcloud secrets versions list SECRETO --project="$PROJECT_ID" --format='value(name,state)'` → `1 ENABLED` en
    cada uno;
  - **nunca** se usa `versions access`: el contenido de la lista se comprueba con el login real (checklist C1 y C2).
- **Si falla:**
  - Si el secreto se creó pero la versión no, se añade con `gcloud secrets versions add SECRETO --data-file=-`,
    con la misma entrada oculta.
  - Si se tecleó un valor equivocado, se añade una versión nueva y se **destruye** la incorrecta: las
    deshabilitadas siguen contando como activas.
  - Para revertir: `gcloud secrets delete SECRETO --project="$PROJECT_ID"`.

#### C6 — Acceso de la cuenta runtime a los 3 secretos

- **Tipo:** Mutación — requiere autorización. **Estado:** Pendiente de autorización.
- **Comando:**

  ```bash
  for s in project-os-nextauth-secret project-os-google-client-secret project-os-allowed-emails; do
    gcloud secrets add-iam-policy-binding "$s" --project="$PROJECT_ID" --condition=None \
      --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor --format=none
  done
  ```

- **Precondiciones:** C5 completado; C0 confirma que la cuenta runtime existe y no tiene roles de proyecto.
- **Impacto:**
  - permiso de **solo lectura de valores**, y **solo** en esos 3 secretos;
  - ningún rol de proyecto;
  - ningún otro principal recibe permisos;
  - `--format=none` evita imprimir la política resultante.
- **Verificación:** C8, con una sola fila por secreto. En la consola, *Secret Manager → secreto → Permisos* con
  *Mostrar concesiones heredadas*: revisar quién más lee secretos por roles de **proyecto** (Propietario y, si la
  tiene, la cuenta de Compute con Editor [M]). Quitar esos roles es una decisión aparte.
- **Si falla:** el bucle es idempotente: se repite. Para revertir un permiso:
  `gcloud secrets remove-iam-policy-binding SECRETO --project="$PROJECT_ID" --member="serviceAccount:${RUNTIME_SA}"
  --role=roles/secretmanager.secretAccessor`.

#### C7 — Compartir el Sheets maestro como Lector

- **Tipo:** Mutación — requiere autorización. **Estado:** Pendiente de autorización. Cambia los **permisos** del
  documento; no modifica sus datos.
- **Comando:** en Google Sheets, abrir el maestro y pulsar **Compartir**:
  - pegar el correo de `RUNTIME_SA`;
  - rol **Lector**;
  - desmarcar *Notificar*;
  - **Acceso general: Restringido**.
- **Precondiciones:** la cuenta runtime existe (Puerta B). No se comparten carpetas ni otros documentos.
- **Impacto:** la cuenta runtime puede **leer** ese único documento. Sin costo.
- **Verificación:** el diálogo *Compartir* muestra la cuenta runtime como **Lector** y el acceso general
  *Restringido* (checklist D2). La lectura real solo se prueba tras el despliegue (checklist C1).
- **Si falla:** si se eligió *Editor* por error, cambiarlo a *Lector* de inmediato. Para revertir, quitar a la cuenta
  del *Compartir*.

### 3.3 Fuera de la Puerta C

- El primer build o push, el despliegue en Cloud Run y la invocación pública (runbook §5.5–§5.7) son la **puerta 3**
  del runbook y tienen autorización aparte. Requieren C8 correcto.
- **No se concede `actAs` adicional.** La cuenta propietaria ya puede actuar como `project-os-build` y como la
  cuenta runtime. El binding `iam.serviceAccountUser` del runbook (A.1, última línea) solo hace falta si despliega
  otra persona (D-C3, §7).

## 4. Revisión del procedimiento de Secret Manager

| Punto | Antes (runbook §5.6) | Ahora (C5 y C6) |
| --- | --- | --- |
| Proyecto | Dependía del proyecto activo de gcloud | `--project` explícito en cada comando |
| Política resultante | `add-iam-policy-binding` imprimía la política completa | `--format=none` y `--condition=None` |
| Verificación | Solo en el checklist A6, tras desplegar | C8 **antes** del primer build: versiones en `ENABLED` y una sola fila de acceso por secreto |
| Rotación | §6 decía *deshabilitar* la versión anterior | Se **destruye** después de comprobar la nueva: las versiones deshabilitadas siguen facturándose (runbook §4) |
| Lectura de valores | No se usaba `versions access` | Igual: el contenido de la lista se valida con el login real |
| Permisos | `secretAccessor` solo para la cuenta runtime | Igual; además, revisión de concesiones heredadas de proyecto |

Formato de `AUTH_ALLOWED_EMAILS` (`web/src/lib/access.ts`):

- correos separados por comas (también se aceptan espacios o `;`);
- se comparan en minúsculas;
- una entrada sin formato de correo se **ignora**;
- una lista vacía no deja entrar a nadie (falla cerrada).

## 5. Checklist de OAuth, callback, allowlist y Sheets

### 5.1 OAuth y URL de callback (C4)

- [ ] `PROJECT_NUMBER` obtenido con
  `gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)'` (lectura), sin escribirlo en el
  repositorio.
- [ ] `SERVICE_URL="https://project-os-dashboard-${PROJECT_NUMBER}.northamerica-south1.run.app"`, la URL determinista
  (runbook §5.0).
- [ ] Tipo de usuario según D9:
  - *Interno*, si el proyecto pertenece a una organización y todas las personas autorizadas son de ella;
  - si no, *Externo* en *Prueba*, con los usuarios de prueba de D5.
- [ ] Alcances: solo `openid`, `email` y `profile`. No hay alcances sensibles, así que no hace falta verificación [M].
- [ ] Cliente **nuevo** de tipo *Aplicación web*, distinto del de localhost.
- [ ] Orígenes autorizados de JavaScript: exactamente `SERVICE_URL`, sin `/` final.
- [ ] URI de redirección: exactamente `SERVICE_URL/api/auth/callback/google`. HTTPS, sin comodines y sin la URL con
  hash.
- [ ] El ID de cliente (no es secreto) se guarda para `OAUTH_CLIENT_ID`. El secreto del cliente va directo a C5. La
  consola puede no volver a mostrarlo después de crearlo [M].
- [ ] Tras desplegar, la URL real incluye `SERVICE_URL` (runbook §5.7 y checklist A2). Si no, se corrige el cliente
  **antes** del primer login.

### 5.2 Allowlist (`project-os-allowed-emails`)

- [ ] Lista mínima según D5: el propietario y, como máximo, 1 invitado de prueba.
- [ ] Una cuenta adicional **fuera** de la lista para la prueba de rechazo (checklist C2).
- [ ] En *Externo/Prueba*, los mismos correos figuran como usuarios de prueba. La lista de la app sigue siendo la
  barrera real.
- [ ] Los correos solo se escriben en la entrada oculta de C5 y en la consola de OAuth; **nunca** en el repositorio,
  PRs, issues ni logs.
- [ ] Para quitar a alguien: nueva versión del secreto, actualizar `SECRET_VERSION_ALLOWLIST`, redesplegar y
  destruir la versión anterior.

### 5.3 Acceso Viewer de Google Sheets (C7)

- [ ] Solo el Sheets maestro, cuyo ID está en `service.template.yaml`, compartido con `RUNTIME_SA` como **Lector**.
- [ ] *Notificar* desmarcado; acceso general **Restringido**.
- [ ] Ninguna carpeta ni otro documento compartido con la cuenta.
- [ ] No se edita ningún dato de la hoja durante la preparación.

## 6. Presupuesto, alertas y controles de costo

| Control | Estado | Nota |
| --- | --- | --- |
| Presupuesto mensual del proyecto (D6) y umbrales 50/90/100 % real + 100 % previsto (D7) | Pendiente (C3) | **Avisa, no corta.** El gasto se registra con retraso; los presupuestos con tope para Cloud Run están en Preview y no se asumen ([preparación §4.4](despliegue-v1-6-preparacion.md#44-presupuestos-y-alertas)) |
| Política de limpieza de imágenes | Pendiente (C1, C1v) | Bloquea el primer build |
| Bucket de origen: borrar a los 7 días, sin borrado diferido | Existente (Puerta B) | — |
| Cloud Run `minScale 0` / `maxScale 1`, CPU por solicitud, 1 vCPU, 512 MiB | En la plantilla | Acota el cómputo (techo teórico ≈ USD 65/mes, escenario E4), no las solicitudes ni la salida |
| Secretos: una versión activa por secreto; destruir las versiones sustituidas | Procedimiento (C5, §4) | Las deshabilitadas siguen facturándose |
| Builds: solo bajo demanda, sin *triggers* | Runbook §3.4 | 2 500 min/mes gratis por cuenta de facturación |
| Revisión manual en *Facturación → Informes* | Checklist F | A las 24–48 h del despliegue y luego mensual |
| Corte automático de facturación | **No recomendado** | Es destructivo y requiere aprobación aparte |

Antes de autorizar la puerta 3, el propietario revisa la calculadora oficial con `northamerica-south1`: los precios
del runbook se verificaron el 2026-10-10.

## 7. Decisiones pendientes del propietario

| # | Decisión | Opciones | Recomendación (no vinculante) |
| --- | --- | --- | --- |
| D-C1 | Proteger la imagen desplegada frente a la limpieza | (a) dejar la política como está; (b) añadir una regla Keep para una etiqueta de despliegue (p. ej. prefijo `desplegada-`), aplicando esa etiqueta a la imagen en producción | (a) en la prueba: con builds solo para desplegar, la imagen en uso está entre las 3 últimas. (b) si se compila sin desplegar o se quiere conservar un rollback de más de 30 días. Cambiar la política requiere revisar el archivo, el script y las pruebas |
| D-C2 | Replicación de los secretos | (a) `automatic`, la del runbook; (b) `user-managed` en `northamerica-south1` | (a) por simplicidad; (b) si se exige residencia de datos en México. Confirmar el precio por ubicación en la página oficial [M] antes de elegir (b) |
| D-C3 | Quién ejecuta las puertas 3 y 4 | (a) solo el propietario; (b) otra persona con los roles del runbook §3.2 | (a): no exige ampliar IAM. (b) exige `iam.serviceAccountUser` sobre las cuentas concretas, nunca sobre el proyecto |
| D5, D6, D7, D9 | Correos, presupuesto, alertas y tipo de OAuth | [Matriz de decisiones](despliegue-v1-6-preparacion.md#2-matriz-de-decisiones-del-propietario) | Necesarias antes de C3, C4 y C5 |

## 8. Riesgos

| # | Riesgo | Mitigación / estado |
| --- | --- | --- |
| PC1 | La limpieza puede borrar la imagen de una revisión en uso si tiene más de 30 días y ya no está entre las 3 últimas (por ejemplo, tras varios builds sin desplegar). No se verificó cómo responde Cloud Run al arrancar una instancia nueva sin la imagen | Compilar solo para desplegar; hacer rollback solo a revisiones cuyas imágenes sigan en el repositorio; D-C1 (b) |
| PC2 | Las políticas actúan en segundo plano y de forma periódica [M]: el efecto no se ve al instante | C1v verifica la **configuración**, no los borrados. El checklist F3 revisa el tamaño del repositorio |
| PC3 | Un build local con *attestations* (algunas configuraciones de Docker Desktop) sube un índice con varios manifiestos, y la cuenta de "versiones" puede no ser una imagen por build [M] | Revisar la primera subida en la consola. La opción A (Cloud Build) usa `docker build` con un solo manifiesto `linux/amd64` |
| PC4 | El secreto del cliente OAuth se expone al copiarlo | Copiarlo solo a la entrada oculta de C5; si se expone, rotarlo en el cliente y añadir una versión nueva |
| PC5 | Herencia de acceso a secretos por roles de proyecto (Propietario; Editor de la cuenta de Compute) [M] | Revisar en la consola (C6); quitar Editor es una decisión aparte (runbook §9) |
| PC6 | El estado de la Puerta B procede del reporte del propietario | C0 lo confirma con lecturas antes de cualquier cambio |
| PC7 | Datos [M] sin leer en la página oficial: el proxy de esta sesión no alcanza `docs.cloud.google.com` | El propietario los confirma en el navegador antes de autorizar la mutación correspondiente |

## 9. Evidencia (2026-10-10)

| Tipo | Qué | Resultado |
| --- | --- | --- |
| **Estática** | `bash -n` y ShellCheck 0.11.0 `-S style` del script `limpieza-artifact-v1-6.sh` | Sin avisos |
| **SDK local, sin red** | El archivo de la política, procesado con `ParseCleanupPolicy` del SDK 570.0.0 y convertido a la respuesta de `describe`, pasa la verificación del script | `OK` en los 3 puntos |
| **Pruebas** | `web/tests/puerta-c.test.ts` con un gcloud **falso**: controles del script; `--plan`, `--check` y `--apply` (aplicar, cancelar, sin entrada, otras políticas, ya aplicada, dry run, error del SDK y verificación posterior fallida); estructura de este documento y del runbook | Ver el PR |
| **Contra GCP real** | Cualquier modo salvo `--plan` | **No ejecutado** |
