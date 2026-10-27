# PROJECT-OS V1.4 — Contrato de escritura (motor de operaciones)

> **V1.8:** el modo `sheets` ya se puede activar, con una cuenta de escritura dedicada y solo para los escritores de la
> lista. Política y activación: [`escritura-v1-8.md`](escritura-v1-8.md). Lo que sigue describe el contrato de V1.4,
> que se mantiene salvo en ese punto.

**Estado:** diseño implementado en modo **simulado** (`mock`) para revisión (Misión 006, issue #7).
**No hay escritura real:** por defecto `PROJECT_OS_WRITE_MODE=disabled` y `AUTH_WRITER_EMAILS` vacío ⇒ ningún
endpoint permite mutaciones. El modo `sheets` está **reconocido pero bloqueado** en esta versión. Activarlo requiere
una aprobación separada del usuario y el runbook de `docs/operaciones-v1-4.md`.

Fuentes del contrato:

- `web/src/lib/schema.ts`, el diccionario de lectura de V1.2.
- Los encabezados reales, confirmados el 2026-10-09 en solo lectura.
- Los valores observados en la hoja maestra. Ninguna columna se agrega ni se renombra.

## 1. Alcance

| Operación | Entidad | Tipo | Incluida |
| --- | --- | --- | --- |
| Crear tarea en un proyecto existente | `TAREAS` | alta | ✅ |
| Editar campos permitidos / estado / prioridad | `TAREAS` | actualización con versión | ✅ (sin cierre) |
| Registrar sesión de trabajo | `TIEMPOS` | alta | ✅ |
| Registrar decisión en estado inicial | `DECISIONES` | alta | ✅ |
| Cerrar tareas (`COMPLETADO`/`CANCELADO`), reabrir, borrar | `TAREAS` | — | ❌ bloqueado |
| CRUD de proyectos, hitos, evidencias, dependencias, sincronizaciones | — | — | ❌ fuera de alcance |

## 2. Esquema (sin cambios)

| Pestaña | Encabezados exactos (se escriben por nombre, en el orden real de la fila 1) |
| --- | --- |
| `TAREAS` | `TAREA_ID, PROYECTO_ID, HITO_ID, TITULO, DESCRIPCION, TIPO, ESTADO, PRIORIDAD, RESPONSABLE, FECHA_PLAN, FECHA_LIMITE, HORAS_ESTIMADAS, CRITERIO_TERMINADO, BLOQUEO, VERSION, ACTUALIZADO_EN` |
| `TIEMPOS` | `SESION_ID, TAREA_ID, FECHA, RESPONSABLE, MINUTOS_REALES, TIPO_TRABAJO, NOTAS, CREADO_EN` |
| `DECISIONES` | `DECISION_ID, PROYECTO_ID, FECHA, ASUNTO, DECISION, JUSTIFICACION, RESPONSABLE, ESTADO, EVIDENCIA_URL` |
| `AUDITORIA` | `AUDIT_ID, FECHA_HORA, ACTOR, ENTIDAD, REGISTRO_ID, CAMPO, VALOR_ANTES, VALOR_DESPUES, ORIGEN` |

Antes de cualquier escritura se validan los encabezados de cada pestaña involucrada:

- Si falta una columna o hay duplicados, la operación se aborta con `esquema-invalido` y no se escribe nada.
- Si sobran columnas, se dejan vacías.

Los valores se escriben con `valueInputOption=RAW`, nunca como fórmulas.

## 3. Reglas por entidad

### 3.1 `TAREAS`

| Campo | Alta | Edición | Regla |
| --- | --- | --- | --- |
| `TAREA_ID` | generado | inmutable | `{PROYECTO_ID}-{NNN}` secuencial (convención real `POS-001`); único |
| `PROYECTO_ID` | requerido | inmutable | Debe existir en `PROYECTOS` |
| `HITO_ID` | opcional | editable | Debe existir en `HITOS` **y** pertenecer al mismo proyecto |
| `TITULO` | requerido | editable | 3–160 caracteres |
| `DESCRIPCION` | opcional | editable | ≤ 2000 |
| `TIPO` | requerido | editable | Código `^[A-Z][A-Z0-9_]{1,29}$`; la UI sugiere los valores reales (`TECNICO`, `SEGURIDAD`, `REVISION`, `DESARROLLO`, `AUTOMATIZACION`, `INTEGRACION`) |
| `ESTADO` | `PENDIENTE` fijo | editable | Solo `PENDIENTE`, `EN_PROGRESO`, `BLOQUEADO` |
| `PRIORIDAD` | requerido | editable | `ALTA`, `MEDIA`, `BAJA` |
| `RESPONSABLE` | opcional | editable | ≤ 80 (texto libre: la hoja usa nombres como "Usuario") |
| `FECHA_PLAN`, `FECHA_LIMITE` | opcional | editable | `AAAA-MM-DD` válida; `FECHA_LIMITE ≥ FECHA_PLAN` |
| `HORAS_ESTIMADAS` | opcional | editable | 0 < h ≤ 1000, máximo 2 decimales |
| `CRITERIO_TERMINADO` | requerido | editable (no vacío) | 3–1000. Es el criterio de aceptación humana |
| `BLOQUEO` | opcional | editable | ≤ 500. **Obligatorio si `ESTADO=BLOQUEADO`** |
| `VERSION` | `1` | sistema | Entero; +1 en cada edición. Concurrencia optimista (§6) |
| `ACTUALIZADO_EN` | sistema | sistema | Instante ISO 8601 en hora de Mérida (`2026-10-09T10:15:00-06:00`) |
| `INSTRUCCIONES` | opcional | editable | ≤ 4000, multilínea. **Columna opcional al final** (ORD-POS-105, [migración](migracion-instrucciones.md)): sin ella, enviar `instrucciones` da `instrucciones-sin-columna` (422) y no escribe nada |

Reglas de estado:

- **No se puede cerrar una tarea editándola.** `COMPLETADO` y `CANCELADO` se rechazan con `cierre-no-permitido`,
  porque requieren aceptación humana, evidencia y criterio verificados. La única vía es `POST /api/operaciones/tareas/<id>/completar`
  (ORD-POS-106, DEC-POS-023): solo a `COMPLETADO`, solo la sesión del propietario y solo con `TAREAS_CIERRE_PROPIETARIO`
  encendida ([escritura §7](escritura-v1-8.md)); si no, `cierre-no-permitido`. `CANCELADO` sigue sin vía.
- **Las tareas ya cerradas no se editan**: no se pueden reabrir ni cambiar sus campos (`tarea-cerrada`).
- Una edición sin cambios efectivos se rechaza (`sin-cambios`) y no genera auditoría ni sube la versión.
- Campos inmutables o desconocidos en el payload (p. ej. `version`, `proyectoId` en la edición) ⇒ `validacion`.
  No hay asignación masiva.

### 3.2 `TIEMPOS` (solo alta)

| Campo | Regla |
| --- | --- |
| `SESION_ID` | Generado: `SES-AAAAMMDD-xxxxxxxx` (aleatorio, 32 bits); se verifica que no exista |
| `TAREA_ID` | Requerido; debe existir. Se permite registrar tiempo de tareas cerradas (registro retroactivo) |
| `FECHA` | `AAAA-MM-DD`; no futura (hora de Mérida) y no anterior a 365 días |
| `RESPONSABLE` | Requerido, ≤ 80 |
| `MINUTOS_REALES` | Entero 1–960 |
| `TIPO_TRABAJO` | Código `^[A-Z][A-Z0-9_]{1,29}$` |
| `NOTAS` | ≤ 1000 |
| `CREADO_EN` | Sistema (instante ISO, Mérida) |

### 3.3 `DECISIONES` (solo alta, estado inicial no final)

| Campo | Regla |
| --- | --- |
| `DECISION_ID` | Generado: `DEC-{PROYECTO_ID}-{NNN}` secuencial |
| `PROYECTO_ID` | Requerido; debe existir |
| `FECHA` | `AAAA-MM-DD`; no futura. Por defecto, hoy en Mérida |
| `ASUNTO` | 3–200 |
| `DECISION`, `JUSTIFICACION` | 3–2000 cada uno |
| `RESPONSABLE` | Requerido, ≤ 80 |
| `ESTADO` | **`PENDIENTE` fijo.** La aprobación de decisiones queda fuera de V1.4 |
| `EVIDENCIA_URL` | Opcional; solo `https://`, sin credenciales en la URL, ≤ 500 |

### 3.4 Texto: saneamiento e inyección de fórmulas

- Se normaliza a Unicode NFC. Se eliminan los caracteres de control salvo el salto de línea (los tabuladores pasan a
  espacio) y se recortan los espacios extremos. En los campos de una línea, los saltos se convierten en espacios.
- **Inyección de fórmulas (Sheets/CSV):** si un texto empieza por `=`, `+`, `-`, `@`, se antepone `'`. Es la misma
  convención que `src/sync_sheets.py` (V1.1). Además se escribe en `RAW`, así que Sheets nunca evalúa el texto.
- Los IDs, códigos, fechas y números se validan con patrones estrictos, nunca como texto libre.
- Límite del cuerpo de la petición: **16 KiB**; JSON estricto (claves desconocidas ⇒ `validacion`).

## 4. Permisos

| Rol | Cómo se obtiene | Lectura | Escritura |
| --- | --- | --- | --- |
| Anónimo | — | ❌ (401 / redirección a login) | ❌ 401 |
| Lector | Sesión Google + `AUTH_ALLOWED_EMAILS` | ✅ | ❌ 403 `sin-permiso-escritura` |
| Escritor | Lector **y** `AUTH_WRITER_EMAILS` | ✅ | ✅ solo si el modo de escritura está activo |

- **La allowlist de login no da permiso de escritura.** `AUTH_WRITER_EMAILS` está vacío por defecto, y vacío significa
  que nadie escribe. Un correo que esté en la lista de escritores pero no en la de lectores no puede escribir.
- La autorización se verifica **en el servidor, en cada API de escritura**, aunque la UI oculte los botones:
  1. sesión (401);
  2. lector (403);
  3. origen / CSRF (403);
  4. modo de escritura (403 `escritura-deshabilitada`);
  5. escritor (403);
  6. tipo de contenido (415), tamaño (413), límite de frecuencia (429);
  7. validación (422);
  8. reglas de negocio (404/409/422).
- **`PROJECT_OS_WRITE_MODE`:**
  - `disabled` (por defecto): no hay escrituras.
  - `mock`: repositorio en memoria del proceso. Solo se permite con `DASHBOARD_DATA_SOURCE=fixtures` y fuera de Cloud
    Run (`K_SERVICE`), para que nunca se mezcle con datos reales. La UI lo marca como **simulado**.
  - `sheets`: **rechazado en esta versión**; la escritura queda deshabilitada y se registra el motivo.
- **Nunca se deriva permiso de escritura del lector.** El cliente de lectura (`sheets-client.ts`, alcance
  `spreadsheets.readonly`, solo `GET`) no cambia. La escritura usaría otro adaptador (`sheets-table-store.ts`) con
  credenciales distintas. En este PR ese adaptador **no se importa desde la app** (lo verifica una prueba) y solo se
  ejercita contra un servidor de Sheets simulado en las pruebas de contrato.

### 4.1 Credencial de escritura futura (no configurada)

- Cuenta de servicio **dedicada a escritura**, distinta de la del lector y de la de V1.1.
- Rol **Editor solo del spreadsheet maestro**, compartido desde Sheets. Sin roles de proyecto GCP ni acceso a Drive.
- Token con alcance `https://www.googleapis.com/auth/spreadsheets` (**no** `drive`). En Cloud Run, ADC con una
  segunda identidad no es posible en el mismo servicio. Alternativas (decisión pendiente, ver PR):
  - **(a) recomendada:** suplantación de cuenta de servicio, la runtime con `roles/iam.serviceAccountTokenCreator`
    solo sobre la cuenta de escritura;
  - (b) un servicio de escritura separado.
- No se configura ni se usa en el PR ni en CI.

## 5. Protección de las APIs de escritura

| Control | Implementación |
| --- | --- |
| CSRF / origen | Exige `Origin` igual al origen de `NEXTAUTH_URL` (o del propio host si no está definido); rechaza `Sec-Fetch-Site` distinto de `same-origin`; exige `Content-Type: application/json` y la cabecera `X-Project-OS-CSRF: 1`, que fuerza un preflight CORS que nunca se aprueba. La cookie de sesión es `SameSite=Lax` |
| Frecuencia | Por actor: 10 escrituras inmediatas y 1 adicional cada 20 s (por instancia; ver §6) |
| Tamaño | 16 KiB máximo (cabecera y cuerpo real) |
| Respuestas | `{ ok, operacion, id, version?, modo, requestId, repetida }` o `{ ok:false, error:{ codigo, mensaje, campos? } }`. Nunca devuelven filas, otros datos ni mensajes internos |
| Logs | Solo `codigo` + `requestId`. Nunca correos, payloads, tokens ni valores |
| Caché | `Cache-Control: no-store` |

## 6. Concurrencia (límites honestos)

Google Sheets **no ofrece compare-and-swap** sobre valores de celdas. Solución pragmática:

1. **Serialización por proceso:** un mutex en memoria serializa todas las escrituras de una instancia. **No sirve
   entre instancias.** V1.3 despliega con `maxScale: 1`, lo que hace del dashboard un **escritor único** mientras
   esa configuración se mantenga.
2. **Concurrencia optimista con `VERSION`:**
   - El formulario de edición envía la versión que vio (`expectedVersion`).
   - Antes de escribir se relee la fila: si la versión cambió ⇒ `409 conflicto-version` y la UI pide recargar.
   - Justo antes de escribir se relee **la misma fila** y se comprueba que conserva `TAREA_ID` y `VERSION`. Si alguien
     insertó o borró filas, el número de fila ya no corresponde ⇒ `409 conflicto-concurrente`.
3. **Verificación posterior:** se relee la fila o el ID escrito. Si no coincide o el ID aparece duplicado ⇒
   `409 verificacion-fallida`; queda registrado y aparece en la conciliación.
4. **Riesgo residual (sin CAS atómico):** entre la relectura y la escritura hay una ventana sin garantía. Estos
   controles **no garantizan** que no se pierdan actualizaciones en Sheets.
   - Una prueba con dos escritores independientes (`operations-audit-integrity.test.ts`) demuestra la carrera:
     ambos leen `VERSION=N`, y el segundo pisa al primero si escribe dentro de esa ventana.
   - La conciliación la **detecta** como `actualizacion-perdida`: dos ediciones auditadas parten de la misma
     `VERSION`.
   - Si una persona edita la hoja a mano a la vez, también puede perderse su cambio. Si en el futuro hay varios escritores o varias
   instancias, se recomienda, por orden y sin crear nada sin autorización:
   - (i) mantener un escritor único (`maxScale: 1`);
   - (ii) una cola de un solo consumidor;
   - (iii) metadatos de desarrollador por fila (`batchUpdateByDataFilter`), para no depender del número de fila;
   - (iv) un almacenamiento transaccional como fuente de las escrituras (requiere aprobación: Sheets dejaría de
     ser la única fuente).

## 7. Auditoría y consistencia (sin prometer atomicidad)

Cada operación genera filas en `AUDITORIA`, **una por campo afectado**, que es el esquema real:

| Columna | Valor |
| --- | --- |
| `AUDIT_ID` | `AUD-AAAAMMDDHHMMSS-xxxxxxxx-NN-TT`: índice de la fila y total de filas de la solicitud, para detectar auditorías parciales |
| `FECHA_HORA` | Instante ISO (Mérida) |
| `ACTOR` | Correo del escritor autenticado (dato personal: solo en la hoja privada, nunca en logs) |
| `ENTIDAD` | `TAREAS` / `TIEMPOS` / `DECISIONES` |
| `REGISTRO_ID` | ID afectado |
| `CAMPO` | Columna afectada (incluye `VERSION` y `ACTUALIZADO_EN`) |
| `VALOR_ANTES` / `VALOR_DESPUES` | Valores saneados. No contienen secretos: solo campos de negocio |
| `ORIGEN` | `dashboard-v1.4;modo=mock;op=tarea.editar;req=<uuid>;h=<hash>` |

`ORIGEN` lleva el **request ID** y un hash del payload validado porque el esquema no tiene columnas para ello. Un
cambio de esquema futuro se propondría como migración aparte.

**Orden "auditoría primero" (fail-closed):**

1. Se validan los permisos, la entrada, las referencias y la versión.
2. Se escribe la auditoría. **Si falla, no se escribe la entidad** (`503 auditoria-fallida`).
3. Se escribe la entidad. Si falla, la auditoría ya registró la intención: `503 escritura-fallida` con el `requestId`.
4. Se verifica la escritura releyendo.

**Escenarios de error explícitos:**

| Falla | Estado resultante | Recuperación |
| --- | --- | --- |
| Validación / permisos / referencia / versión | Nada escrito | Corregir y reenviar |
| Escribir la auditoría | Nada escrito | Reintentar |
| Escribir la entidad tras la auditoría | Intención auditada sin efecto | **Reintentar con el mismo `requestId` completa la operación** (roll-forward); si no se reintenta, la conciliación la lista |
| Verificación posterior | Escrito, pero posible interferencia | Revisar en conciliación; no se reescribe automáticamente |

**Conciliación verificable:** compara la última operación auditada **completa** de cada registro con el estado
actual de la entidad. En `mock` se muestra en `/operaciones`. Lista:

| Motivo | Cuándo |
| --- | --- |
| `sin-efecto` | La entidad no recibió la escritura auditada |
| `divergente` | La entidad no coincide con lo auditado (por ejemplo, un cambio a mano sin operación auditada) |
| `auditoria-parcial` | Faltan filas (índices `NN-TT`) o campos obligatorios de la operación |
| `auditoria-inconsistente` | Filas de la misma solicitud con distinta operación, hash, entidad, registro o lote, índices repetidos o el mismo campo con valores distintos |
| `actualizacion-perdida` | Dos ediciones auditadas parten de la misma `VERSION` del mismo registro |

Una auditoría parcial o contradictoria **nunca** se da por conciliada ni se usa para un reintento: responde
`409 auditoria-inconsistente`.

## 8. Idempotencia

- Cada envío genera un `requestId` (UUID v4). Reintentar **el mismo payload** tras `escritura-fallida` o un error de
  red reutiliza el mismo `requestId`; el botón se desactiva mientras se envía, para evitar dobles clics.
- Antes de escribir se busca `req=<requestId>` en `AUDITORIA`, que es **persistente en la propia hoja**:
  - **Misma operación y mismo hash, entidad aplicada** ⇒ se devuelve el resultado original (`repetida: true`,
    `200`), sin escribir. También cuenta como aplicada si después hubo ediciones **auditadas** del mismo registro
    (reintento legítimo).
  - **La entidad existe pero no coincide con lo auditado y ninguna operación auditada posterior lo explica** ⇒
    `409 estado-divergente`. Nunca se responde como repetición.
  - **Misma operación y mismo hash, entidad no aplicada** ⇒ se completa la operación con los valores auditados
    (roll-forward).
  - **Mismo `requestId` con otro payload u otra operación** ⇒ `409 conflicto-idempotencia`.
- **Límite:** dos peticiones con el mismo `requestId` que lleguen a la vez a **instancias distintas** pueden
  escribir ambas, porque no hay bloqueo persistente. Con un escritor único (mutex más `maxScale: 1`) no ocurre. No
  se promete deduplicación multiinstancia.

## 9. Integración con V1.2 / V1.3

- Lectura: el cliente `spreadsheets.readonly` y su política de credenciales (V1.3, `credentials.ts`) no cambian.
- En `mock`, el dashboard lee el estado del repositorio simulado, de modo que las operaciones se ven al instante y
  marcadas como simuladas. Tras cada escritura correcta se invalida la caché del dashboard.
- Tras el merge de V1.3 (PR #6), esta rama se rebasa sobre `main` y se repiten todas las pruebas. Únicos puntos de
  contacto previstos: `web/src/lib/data.ts` (2 líneas), `package.json` (script) y `web-validation.yml` (un paso).
