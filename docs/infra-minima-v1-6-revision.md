# PROJECT-OS V1.6 — Infraestructura mínima (Puerta B): revisión de la V2

> **Estado: preparado para revisión.** Script: [`web/deploy/infra/project-os-infra-minima-v1-6.sh`](../web/deploy/infra/project-os-infra-minima-v1-6.sh).
>
> - **No se ha ejecutado contra Google Cloud.** Ejecutarlo (`--apply`) requiere una autorización expresa posterior.
> - Este documento no autoriza crear recursos, modificar IAM, iniciar builds ni desplegar.

Proyecto `project-os-511102`, región `northamerica-south1`. El historial del repositorio conserva la V1 literal (commit
anterior) para que el diff V1 → V2 sea verificable.

## 1. Alcance de la V2

**Cambios** (solo tras escribir exactamente `AUTORIZO INFRA PROJECT-OS`), en este orden:

1. Bucket de origen `PROJECT_ID-project-os-build-src` en `northamerica-south1`:
   - acceso uniforme;
   - prevención de acceso público;
   - borrado diferido desactivado;
   - ciclo de vida que borra los objetos a los 7 días, aplicado **en la misma creación**.
2. Repositorio Docker privado `project-os`.
3. Cuenta runtime `project-os-dashboard-run`, **sin roles ni claves**.
4. IAM mínimo **solo** para `project-os-build`:

   | Rol | Ámbito |
   | --- | --- |
   | `roles/logging.logWriter` | Proyecto |
   | `roles/artifactregistry.writer` | Solo el repositorio |
   | `roles/storage.objectViewer` | Solo el bucket |

5. Auditoría de solo lectura que **verifica** cada resultado, sin imprimir políticas ni correos.

**Excluido:** habilitar APIs (incluida Secret Manager), secretos, OAuth, acceso a Sheets, presupuesto, IAM de otras
cuentas, `actAs` de la persona, builds, Cloud Run, despliegue y claves JSON.

**Pendiente antes del primer despliegue:** la política de limpieza de imágenes del repositorio, como decisión aparte
([runbook §5.5](despliegue-privado-v1-3.md#55-artifact-registry-y-la-imagen) usa
`web/deploy/cloudrun/artifact-cleanup-policy.json`).

## 2. Requisitos previos (el script los comprueba)

- `gcloud` y `python3` disponibles, y una cuenta de gcloud activa con permisos sobre el proyecto.
- APIs **ya habilitadas**: `cloudbuild`, `artifactregistry`, `iam` y `storage`. El script no habilita ninguna: si
  falta alguna, se detiene sin cambios.
- La cuenta `project-os-build` **ya existe** y no tiene roles de proyecto distintos de `roles/logging.logWriter`.
- No existen todavía el repositorio, el bucket ni la cuenta runtime. Si alguno existe, el script se detiene para
  revisarlo.

## 3. Hallazgos de la revisión de la V1 y corrección en la V2

| # | Hallazgo en la V1 | Corrección en la V2 | Prueba (`web/tests/infra-minima.test.ts`) |
| --- | --- | --- | --- |
| 1 | `add-iam-policy-binding` imprime la política completa, con correos personales; se imprimía la cuenta activa | `--format=none` en los tres bindings; la cuenta se muestra como `***@dominio`; las políticas se leen en JSON y se procesan en memoria (antes se escribía la del proyecto a un temporal) | Bindings con `--format=none`; cuenta enmascarada; ningún `get-iam-policy` en `yaml`/`table`; un único archivo escrito (el ciclo de vida) |
| 2 | La auditoría del bucket pedía claves `camelCase` que `gcloud storage buckets describe` no devuelve sin `--raw` | Claves `snake_case` del SDK (`uniform_bucket_level_access`, `public_access_prevention`, `soft_delete_policy`, `lifecycle_config`), verificadas en `full_resource_formatter.py` y `gcs_json/metadata_util.py` del SDK 570.0.0. Cada protección se **comprueba** (OK/FALLA) | Formato exacto; 1 caso correcto y 8 incorrectos, incluido un JSON `camelCase` |
| 3 | Solo rechazaba Editor y Owner (lista negra) | Lista **permitida**: cualquier rol de proyecto de `project-os-build` distinto de `roles/logging.logWriter` detiene el script antes de cambiar nada; la auditoría lo repite | 6 casos (Editor, Owner, `run.admin`, Editor de otro miembro…) y JSON no válido |
| 4 | El bucket, el paso con más probabilidad de fallar (nombre global), iba después de habilitar la API y crear el repositorio; el ciclo de vida se aplicaba después con un `update` | El bucket es el **primer** cambio y se crea con `--lifecycle-file`; sin `buckets update` | Orden exacto de las 6 mutaciones; opciones de creación; sin `update` |
| 5 | Cinco `services list \| grep -q`: un error de permisos parecía "API no habilitada" y había riesgo de SIGPIPE | **Una** consulta guardada en variable; un error de consulta detiene con su propio mensaje | Una sola llamada; manejo de error explícito; `missing_apis` probado |
| 6 | Solo detectaba el repositorio por su nombre completo | `(^\|/)project-os$`: nombre corto o completo, sin confundir `my-project-os` o `project-os-old` | 7 casos |
| 7 | Requisitos previos implícitos | El plan los enumera: cuenta `project-os-build` existente, APIs y ausencia de recursos | `--plan` contiene los requisitos y los pendientes |
| 8 | Faltaba `--project` en varios comandos | `--project` explícito en todo comando de gcloud salvo `auth list` | Todas las invocaciones |

**Decisiones aplicadas:**

- Se excluye habilitar Secret Manager.
- No se crean secretos ni se configura OAuth.
- La limpieza de imágenes queda aplazada y documentada como pendiente.
- La cuenta runtime se crea sin roles ni claves; la auditoría verifica ambas cosas.
- No se modifica ninguna cuenta existente salvo los tres permisos de `project-os-build`.

**Otros cambios:**

- El script se carga con `source` sin ejecutar nada, porque `main` solo corre al invocarlo directamente. Así se
  prueban sus funciones sin gcloud.
- El archivo temporal del ciclo de vida, sin datos sensibles, se borra con un `trap` al salir.

## 4. Validación (sin contacto con GCP)

| Comprobación | Resultado |
| --- | --- |
| `bash -n` | OK |
| ShellCheck 0.11.0, `-S style` | Sin avisos (V1 y V2) |
| `--plan` y sin argumentos | Código 0; con un `gcloud` falso en el `PATH`, nunca se invoca |
| Argumentos inválidos | Código 2, sin invocar gcloud |
| `web/tests/infra-minima.test.ts` | 43/43 en V2; contra la V1, 37 de 43 fallan |
| Mutaciones de la V2 | Cada una hace fallar al menos una prueba. Ver la lista de abajo |

Mutaciones probadas sobre la V2:

- quitar `--format=none`;
- mostrar la cuenta sin enmascarar;
- permitir Editor en la lista;
- volver a una lista negra;
- habilitar Secret Manager antes del `AUTORIZO`;
- detectar el repositorio solo por su nombre completo;
- relajar la comprobación de acceso uniforme.

**No se simuló `--apply`.** El entorno de esta sesión bloquea ejecutar el script completo y no se intentó esquivar
esa restricción. Las pruebas cubren el texto del script, sus funciones cargadas con `source` y el modo `--plan`.

## 5. Uso cuando se autorice

1. Leer el script completo y este informe.
2. Ejecutar `bash web/deploy/infra/project-os-infra-minima-v1-6.sh --plan` en Cloud Shell, con el repositorio clonado
   o el `.sh` subido.
3. Solo con autorización expresa:
   - ejecutar `… --apply`;
   - revisar el preflight, que es de solo lectura;
   - escribir `AUTORIZO INFRA PROJECT-OS`.
4. La auditoría final debe mostrar solo líneas `OK`. Ante un error o una línea `FALLA`, **no reintentar a ciegas**:
   no hay rollback automático. Revisar y reconciliar a mano.
5. Registrar el resultado sin correos ni datos sensibles. La salida del script ya los omite.

## 6. Riesgos pendientes

| # | Riesgo | Mitigación / estado |
| --- | --- | --- |
| P1 | Nunca ejecutado contra GCP: flags, permisos efectivos, políticas de organización y versión del SDK de Cloud Shell sin probar | El primer `--apply` autorizado es la prueba real. El preflight se detiene ante cualquier error de lectura |
| P2 | Sin rollback automático: un fallo a mitad deja recursos parciales | El orden pone primero el paso más frágil (bucket). Reconciliar a mano |
| P3 | Nombre de bucket global: otro proyecto podría tenerlo | Fallaría el primer cambio, sin dejar nada más creado |
| P4 | Ventana entre el preflight y la creación (otro operador crea los recursos) | La creación fallaría y no modificaría recursos ajenos |
| P5 | La lista permitida solo cubre roles **directos de proyecto**. No evalúa roles heredados de carpeta u organización, roles en otros recursos ni el contenido de roles personalizados | La revisión de IAM heredado sigue siendo manual (consola) |
| P6 | La auditoría depende de la forma de salida del SDK: claves `snake_case` y `retentionDurationSeconds` como texto `"0"`, verificadas en el SDK 570.0.0 | Si otra versión cambiara el formato, la auditoría daría `FALLA` (falla segura) y habría que revisar a mano |
| P7 | Política de limpieza de imágenes no aplicada | Pendiente antes del primer despliegue (decisión aparte) |
| P8 | La persona no puede actuar como `project-os-build` (`iam.serviceAccountUser`), así que todavía no puede lanzar builds | Autorización separada (runbook §5.5, A.1) |
| P9 | Secret Manager API no habilitada | Necesaria antes del lote de secretos |
| P10 | La cuenta predeterminada de Compute puede tener Editor | Ni el build ni la runtime la usan. Quitárselo es una decisión aparte |
| P11 | El ID del proyecto queda escrito en el repositorio | No es un secreto: el acceso lo controla IAM |
| P12 | Costos: el bucket y el repositorio pueden generar cargos menores por almacenamiento. No se crea presupuesto | Un presupuesto no es un límite de gasto ([preparación §4.4](despliegue-v1-6-preparacion.md#44-presupuestos-y-alertas)) |
