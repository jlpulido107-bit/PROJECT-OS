# PROJECT-OS V1.6 — Runbook operativo

> **Instrucción no es ejecución.** Este documento describe qué observar y qué hacer. **No ejecuta nada, no programa
> nada y no autoriza ninguna mutación.** Cada acción marcada **[M]** cambia producción y exige una autorización
> específica del propietario. **[L]** es una lectura que ejecuta el propietario y **[C]** algo que Claude hace offline.
> No se configuran horarios, alertas automáticas, acciones de facturación ni workflows con credenciales.
>
> Servicio `project-os-dashboard` (`project-os-511102`, `northamerica-south1`), revisión
> `project-os-dashboard-00001-gsk`, código `7f44216`. Comandos de lectura: `node web/scripts/ops/plan-inspeccion.mjs`.

## 1. Principios

- **Fuente operativa:** Google Sheets. La app solo la **lee**; la escritura está deshabilitada en Cloud Run.
- **Evidencia:** cualquier resultado se registra con `evidencia.mjs` ([formato](evidencia.md)), sin correos,
  tokens, IDs de facturación, valores de variables ni líneas de log.
- **Seguridad del PR:** nunca se pegan en un PR o issue capturas con datos de la hoja, correos de la lista,
  contenido de logs ni salidas de `gcloud` sin revisar.

## 2. Rutinas

| Cuándo | Señal | Origen | Acción | Responsable | Umbral o motivo |
| --- | --- | --- | --- | --- | --- |
| Tras cada despliegue | Rutas privadas cerradas | `npm run smoke:remote -- --url URL` [L] | Si no da 26/26: §6, incidente "fallo de sonda" o "exposición" | Propietario | 26/26 obligatorio |
| Tras cada despliegue | Login real y datos | Navegador [L] | Checklist C1 y C2 | Propietario | ✅ |
| Tras cada despliegue | Imagen protegida | Lectura A9 [L]; si falta, C9 [M] | Etiquetar `produccion` y mover `produccion-anterior` | Propietario | A9 = OK |
| Tras cada despliegue | Límites de escala | Lectura A7 [L] | Si el `maxScale` de servicio ≠ 1: decisión D-1 | Propietario | Revisión 1; servicio `ninguno` o 1 |
| Primeras 24–48 h | Gasto real | *Facturación → Informes*, filtrado por el proyecto [L] | Comparar con la estimación E1/E2 | Propietario | Cualquier cargo inesperado se investiga (§6) |
| Primeras 24–48 h | Errores de la app | Logs Explorer, conteos de severidad ≥ WARNING (§5) [L] | Agrupar por código `[project-os] …`; no copiar líneas | Propietario | > 0 errores `unavailable`/`auth`/`permission` → §6 |
| Semanal | Solicitudes y bots | *Cloud Run → Métricas → Request count*, por código de respuesta [L] | Distinguir uso normal de bots (abajo) | Propietario | Tendencia, no un número fijo |
| Semanal | Latencia | *Cloud Run → Métricas → Request latency* p95 [L] | Si sube de forma sostenida: revisar cuota de Sheets y arranques en frío | Propietario | p95 sostenido > 5 s (indicativo) |
| Semanal | Logs sin PII | Conteos E1 (§5) [L] | Si hay coincidencias: §5.3 | Propietario | 0 |
| Mensual | Presupuesto y gasto | *Facturación → Presupuestos* e *Informes* [L] | Revisar el umbral (D6/D7) | Propietario | Alerta USD 5: **avisa, no corta** |
| Mensual | Cuota de Sheets | *APIs → Google Sheets API → Cuotas* [L] | Si se acerca al límite: subir la caché o reducir lecturas (V1.7) | Propietario | 300 lecturas/min por proyecto |
| Mensual | Artifact Registry | `limpieza-artifact-v1-6.sh --check` y lista de imágenes (§4) [L] | Si `BLOQUEADO`: no compilar | Propietario | `PERMITIDO` |
| Mensual | Secretos | Versiones de los 3 secretos (lectura A6) [L] | Destruir las versiones sustituidas [M] | Propietario | Una versión `ENABLED` por secreto |

## 3. Costos

- **El presupuesto de USD 5 es una alerta, no un límite.** Las alertas llegan con retraso y no detienen el
  servicio. Ningún nivel gratuito ni promoción se da por garantizado sin verlo en *Informes*: se cuentan **por cuenta
  de facturación**, y otros proyectos pueden consumirlos.
- **Uso normal frente a bots.**
  - El login es público: los bots pueden generar solicitudes a `/login`, `/api/auth/*` y rutas inexistentes.
  - Lo normal para 1–2 personas son decenas o cientos de solicitudes al día, en horario laboral y con códigos
    200/307.
  - Indicios de bots: picos nocturnos, muchos 404 o 307, rutas como `/wp-login.php` y user-agents automáticos.
  - Las solicitudes rechazadas por la app **sí** se facturan como solicitudes, pero sin leer la hoja.
- **Techos.**
  - `maxScale: 1` de revisión acota el cómputo (escenario E4: ≈ USD 65 al mes si la instancia estuviera ocupada
    todo el mes).
  - Si el máximo efectivo fuera el de servicio (3, D-1), el techo se triplicaría.
  - Las solicitudes y la salida a Internet no tienen techo.
- **Si el gasto se dispara:** §6, incidente "costo inesperado".

## 4. Retención de imágenes

- **Política activa** (`--check` `PERMITIDO` según el registro):
  - Keep de las etiquetas `produccion*`;
  - Keep de las 3 versiones más recientes;
  - Delete de lo que tenga más de 30 días.

  Keep tiene prioridad sobre Delete.
- **Comprobar el efecto real**, solo cuando haya **≥ 5 imágenes y alguna de más de 30 días**: lectura F3 [L]
  (`gcloud artifacts docker images list … --include-tags`). Debe quedar solo `produccion`, `produccion-anterior` y las
  3 más recientes. Se registra con `evidencia.mjs` (F3: `imagenes`, `mayores_30_dias_no_protegidas`).
- **Antes del próximo build:** lectura A9 y, si falta la etiqueta, C9 [M]. Sin la etiqueta, la imagen en uso solo
  está protegida mientras sea una de las 3 más recientes.

## 5. Revisión de logs sin exponer datos

### 5.1 Filtros seguros (Logs Explorer o `gcloud logging read`)

Base del filtro:

```
resource.type="cloud_run_revision" AND resource.labels.service_name="project-os-dashboard"
```

- **Errores de la app:** base + `severity>=WARNING AND textPayload:"[project-os]"`. Las líneas de la app solo
  contienen **códigos** (`Configuración inválida`, `operación rechazada: …`, nombres de error), nunca valores.
- **PII y tokens:** base + el texto **sin campo** (`"@"`, `"ya29."`, `"Bearer "` o `"code="`). Una búsqueda sin
  campo se aplica a **todos** los campos del registro: `textPayload`, `jsonPayload`, `protoPayload`, `httpRequest`…
  La ventana es de **30 días**, la retención de `_Default`. Se ejecutan como **conteo** (comandos E1 del plan, que
  terminan en `| wc -l`).
- **Límite:** cero coincidencias de esos 4 patrones no demuestra la ausencia de toda PII. E2 (revisión humana de los
  códigos) sigue siendo necesaria. La semántica de búsqueda en todos los campos es la documentada por Cloud Logging
  [M]: confírmala la primera vez en Logs Explorer.

### 5.2 Reglas

- Se registran **conteos** y códigos, nunca líneas.
- No se exportan logs ni se crean *sinks*.
- En la consola, se mira el resumen y se cierra. No se hacen capturas con el panel de detalle abierto.

### 5.3 Si aparece PII o un token

1. **No copiar** la línea a ningún sitio.
2. Anotar solo el control (E1), la fecha y el tipo (correo, token…).
3. Si es un **token**: tratarlo como un posible secreto expuesto (§6, "exposición de datos").
4. Si es un **correo**: identificar el origen por el **código** de la línea (app o NextAuth) y abrir un issue sin el
   dato.
5. Los logs caducan solos (30 días en `_Default`). Borrarlos antes es una mutación [M] y una decisión del propietario.

## 6. Incidentes

| Incidente | Síntoma | Diagnóstico (solo lectura) | Respuesta | Verificación |
| --- | --- | --- | --- | --- |
| **401 inesperado** | Una API privada responde 401 con la sesión iniciada | ¿Expiró la sesión (8 h)? ¿Cambió `NEXTAUTH_SECRET` (nueva versión desplegada)? ¿La cookie se perdió por usar la URL con hash en vez de la estable? | Cerrar sesión y volver a entrar **por la URL estable**. Si se rotó el secreto, es esperado: todas las sesiones se invalidan | La API responde 200 tras el login |
| **403 de un usuario permitido** | `/login?error=AccessDenied` o 403 | ¿El correo está en la versión **desplegada** del secreto? (nombres de variables y versión fijada, A4 y A6; **nunca** leer el valor). ¿Google lo reporta verificado? ¿Mayúsculas o espacios? (se normalizan) | Nueva versión del secreto con la lista correcta, `SECRET_VERSION_ALLOWLIST` y redespliegue [M] | Checklist C1 |
| **Callback OAuth** | `redirect_uri_mismatch` o `error=Callback` | ¿Se entró por la URL estable? URLs publicadas (A2) frente a las registradas en el cliente OAuth. ¿Cambió el estado *Testing* o los usuarios de prueba? | Corregir el cliente OAuth en la consola [M]; esperar de 5 min a horas de propagación | Login real |
| **Lectura de Sheets 503** | La página muestra el error y las APIs devuelven 503 con un `code` | Por código: `permission` → el diálogo *Compartir* (D2); `quota` → cuota (§2); `auth` → identidad (A5); `not-found` → ID de hoja en la plantilla; `timeout`/`unavailable` → estado de Google | `permission`: volver a compartir como Lector [M]. `quota`: esperar; si se repite, V1.7. El resto: según la causa | La página vuelve a "Leído de Google Sheets" |
| **Fallo de sonda** | Una revisión nueva no recibe tráfico (`Ready=False`) | El log `[project-os] Configuración incompleta o insegura` trae solo **códigos** (`nextauth-url`, `write-mode`…) | Corregir la configuración y redesplegar [M]. **La revisión anterior sigue sirviendo**: no hay corte | `smoke:remote` 26/26 |
| **Costo inesperado** | Alerta de presupuesto o cargo raro en *Informes* | *Informes* por servicio; solicitudes por código (bots); instancias (A7); imágenes (F3); versiones de secretos (A6) | Por causa: bots → evaluar IAP o cerrar el acceso [M]; imágenes → `--check`; secretos → destruir versiones [M]. Último recurso: cerrar el acceso o desmantelar (runbook §6–§7) [M] | Gasto diario de vuelta a la línea base |
| **Posible exposición de datos** | Una ruta privada responde sin sesión, o un token o dato aparece donde no debe | `smoke:remote` (B1); conteos E1 | **1)** Cerrar el acceso de inmediato: quitar `allUsers` [M] (runbook §6). **2)** Si hay un secreto implicado: rotarlo [M]. **3)** Issue sin datos. **4)** Reabrir solo con autorización | B1 26/26 antes de reabrir |
| **Bloqueo de acceso** | Hay que cerrar el servicio a todos ya | — | Quitar `allUsers` [M]. Sin borrar nada; reversible volviendo a añadirlo | La URL devuelve un error de Google sin llegar a la app |

## 7. Recuperación y rollback

- **Estado actual: una sola revisión** (`…-00001-gsk`). Un rollback de **tráfico** a una revisión anterior **no es
  posible ni está ensayado** (G2 = NO_APLICA). Se habilita tras el próximo despliegue, siempre que la imagen anterior
  se conserve (`produccion-anterior`, A9).
- **Sin segunda revisión**, las opciones son:
  1. *Fix forward:* corregir y redesplegar [M].
  2. Volver a aplicar el mismo manifiesto con la **misma imagen por digest** [M], si el problema fue de configuración.
  3. Cerrar el acceso mientras tanto [M].
- **Con segunda revisión:** `gcloud run services update-traffic … --to-revisions=REVISION=100` [M], solo si su
  imagen sigue en el repositorio (lectura A9 o F3 antes).
- **Sesiones:** rotar `project-os-nextauth-secret` invalida todas [M]. Quitar un correo de la lista lo bloquea en la
  siguiente petición, tras la nueva versión y el redespliegue [M].
- **No se ensaya** ningún corte en producción sin una decisión explícita y una ventana acordada (G1).

## 8. Permisos mínimos y quién aporta cada evidencia

| Acción | Permiso mínimo | Quién | Evidencia que puede dar Claude, sin identidad humana |
| --- | --- | --- | --- |
| Lecturas A1–A9, E1, F3, G2 | Lector del proyecto (`roles/viewer`) o roles de lectura por servicio | Propietario | Generar los comandos y evaluar la evidencia saneada |
| Login real (C1, C2) | Una cuenta de la lista y otra fuera | Propietario | Ninguna: requiere identidad humana |
| Historial y *Compartir* de la hoja (D1, D2) | Editor de la hoja | Propietario | Ninguna; D3 (código) sí |
| Facturación (F1, F2) | Visor de facturación | Propietario | Ninguna |
| Etiquetar imagen (C9) | `artifactregistry.writer` en el repositorio | Propietario [M] | Comando propuesto, sin ejecutar |
| Desplegar o redesplegar | `run.admin` + `iam.serviceAccountUser` sobre la cuenta runtime | Propietario [M] | Manifiesto renderizado y pruebas offline |
| Rotar secretos | `secretmanager.secretVersionManager` (añadir y destruir versiones) | Propietario [M] | Procedimiento |
| Cerrar el acceso | `run.admin` | Propietario [M] | Procedimiento |
| Código, pruebas, preflight, CI | Ninguno en GCP | Claude [C] | Todo, en PR |

## 9. Plan de validación: Claude frente a propietario

| Bloque | Claude, offline (hecho en este PR) | Propietario |
| --- | --- | --- |
| Diseño y código | Preflight P1–P14, auditoría, pruebas unitarias, E2E sintéticas, build y `check:client-secrets` con valores falsos | — |
| Configuración real | Comandos (`plan-inspeccion.mjs`) y evaluación (`evidencia.mjs`) | Ejecutar las lecturas y rellenar la evidencia ([hoja](hoja-propietario.md), paso 1) |
| Personas y datos | — | C1, C2, D1, D2 ([hoja](hoja-propietario.md), pasos 2–4) |
| Logs y costos | Filtros y reglas | E1, E2, F1, F2 ([hoja](hoja-propietario.md), pasos 5–6) |
| Mutaciones | Propuestas (C9, D-1) | Decidir y autorizar cada una por separado |

## 10. Cambios autorizados

### 10.1 Antes de un cambio

1. Issue o PR con el alcance exacto.
2. Autorización explícita del propietario para **ese** alcance.
3. Preflight offline en verde.
4. `limpieza --check` `PERMITIDO`, si hay un build.

### 10.2 Checklist después del cambio

- [ ] `smoke:remote` 26/26.
- [ ] Lecturas A1, A2, A4 y A7 con `evidencia.mjs` sin FALLO.
- [ ] Si hubo una imagen nueva: C9 (`produccion` y `produccion-anterior`) y A9 = OK.
- [ ] Login real (C1).
- [ ] Registro fechado en `docs/` con commit, digest y revisión, sin datos sensibles.
