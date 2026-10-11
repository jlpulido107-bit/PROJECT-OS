# PROJECT-OS V1.6 — Matriz de aceptación con trazabilidad

> **Línea base:**
>
> - código desplegado: `7f44216bdf85a9832e014f45c27ac643e00ceff9`;
> - imagen: `sha256:f6e46596ef36522134096d97431f32036bb71298033f9694023137497d3d5c07`;
> - revisión: `project-os-dashboard-00001-gsk`.
>
> Fecha de corte: 2026-10-11. La identidad y el registro de evidencias (`EV-xx`) están en la
> [línea base](linea-base-v1-6.md). Si cambia el commit, la imagen o la revisión, **esta matriz deja de valer** hasta
> revalidarla: una prueba (`scripts/ops/matriz.mjs`) lo comprueba contra `produccion-v1-6.mjs`.
>
> **Versión final para la aceptación (Misión 014).** No ejecuta nada. Sus reglas son comprobables:
> `node web/scripts/ops/matriz.mjs` y `operacion-v1-6.test.ts`. Ningún estado se aprueba sin evidencia real del
> propietario. **El despliegue funciona; eso no significa que la aceptación esté completa.**

## 1. Criterio de estados y de evidencia

| Estado | Significado | Qué **no** basta |
| --- | --- | --- |
| **VERIFICADO** | Evidencia **real** del propietario con un resultado concreto (`P`, con su `EV-xx`, que en el registro de la línea base también es `P`). Para un control de **código** (hoy solo D3), una prueba en CI (marcado «(código)») | Un reporte sin dato (`R`), una simulación (`S`), una plantilla o «funciona» |
| **PARCIAL** | Hay evidencia real (`P` o `R`), pero incompleta. La columna *Falta* dice qué | — |
| **PENDIENTE** | Sin evidencia real; puede haber CI o simulación | — |
| **NO_APLICA** | El control no puede ejecutarse hoy, por una razón explícita y **hasta** una condición concreta. Solo G2 | Usarlo como sustituto de una prueba pendiente |

Etiquetas de evidencia. Cada una va en su columna: real, técnica, o tiempo y decisión.

| Etiqueta | Tipo | Columna | ¿Puede verificar producción? |
| --- | --- | --- | --- |
| **P** | Real, del propietario, con salida o resultado concreto y fecha (`EV-xx`) | Real | Sí |
| **R** | Real, reportada por el propietario, sin salida adjunta | Real | No: como mucho PARCIAL |
| **CI** | Prueba automatizada sobre el código del repositorio | Técnica | Solo los controles de código (D3) |
| **S** | Simulación con datos sintéticos (fixtures, `gcloud` falso, E2E locales) | Técnica | **Nunca**: prueba el diseño |
| **T** | Requisito que depende del **paso del tiempo**, con fecha o condición | Tiempo o decisión | Bloquea VERIFICADO hasta cumplirse |
| **DEC** | **Decisión de riesgo** del propietario todavía no tomada | Tiempo o decisión | Bloquea VERIFICADO hasta decidirse |

## 2. Matriz

| ID | Control | Estado | Real (propietario) | Técnica (CI / simulada) | Tiempo o decisión | Falta | Siguiente acción |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | La imagen servida es la revisada y está fijada por digest | VERIFICADO | **P:** EV-06 (la revisión activa sirve el digest `f6e46596…`) | **CI:** `render.mjs` exige `@sha256:` (`deploy-template.test.ts`) | — | — | Repetir tras cada despliegue (reabre la aceptación) |
| A2 | URL real = `NEXTAUTH_URL` = callback OAuth | PARCIAL | **P:** EV-06 (`A2_URL_ESTABLE: REVISAR`, porque el callback solo se ve en la consola); EV-03 y EV-12 usan la URL estable. **R:** EV-05 (callback «confirmado» al desplegar, sin evidencia) | **CI:** el plan pide las 3 partes y el evaluador las exige todas | — | ✅ del callback exacto en la consola OAuth | [Hoja](hoja-propietario.md), bloque 1 |
| A3 | Sonda de arranque válida | VERIFICADO | **P:** EV-03 y EV-12 (`/api/health` 200 en `smoke:remote` 26/26); EV-01 (revisión `Ready=True`) | **CI:** sonda en `docker:smoke` | — | — | Repetir tras cada despliegue |
| A4 | Sin modo de escritura en producción | VERIFICADO | **P:** EV-06 (sin variables de escritura en la revisión) | **CI:** `deploy-template.test.ts`, `integration-security.test.ts` (sonda 503 con escritura) | — | — | Repetir tras cada despliegue |
| A5 | La identidad del servicio no tiene roles de proyecto | VERIFICADO | **P:** EV-06 (cuenta runtime con 0 roles de proyecto) | **CI:** `credentials.test.ts` (cuenta esperada) | — | — | Repetir tras cambios de IAM |
| A6 | Solo la cuenta runtime lee los 3 secretos, con versión fijada | VERIFICADO | **P:** EV-06 (1 acceso directo por secreto); EV-12 (1 versión `ENABLED` por secreto, igual a la fijada) | **CI:** versiones numéricas en la plantilla (P4). **S:** salvaguardas de la remediación con `gcloud` falso | — | — | En cada rotación, destruir la versión sustituida. Confirmar con `estados=[…]` que la 1 de `google-client-secret` está `DESTROYED` (no cambia A6) |
| A7 | Límites de costo aplicados | VERIFICADO (configuración) | **P:** EV-11 y EV-12 (servicio 1, revisión 1, `minScale` 0, CPU por solicitud, misma revisión) | **CI:** plantilla sin `maxScale` de servicio (P1, P2) | — | — | Opcional: el máximo histórico de instancias ([hoja](hoja-propietario.md), bloque 4). Si es > 1, A7 pasa a FALLO |
| A8 | El build usó la cuenta dedicada | VERIFICADO | **P:** EV-06 (cuenta `project-os-build`, `SUCCESS`, 1 línea de identidad) | **CI:** `cloudbuild.test.ts` | — | — | Repetir en cada build |
| A9 | La imagen desplegada está protegida frente a la limpieza | VERIFICADO | **P:** EV-06 (etiqueta `produccion` creada en C9 y verificada contra el digest) | **CI:** Keep `produccion*` en la política (P6) | — | — | Mover `produccion` y `produccion-anterior` en cada despliegue (runbook §5.7) |
| B1 | Todo lo privado está cerrado sin sesión | VERIFICADO | **P:** EV-03, EV-08 y EV-12 (`smoke:remote` 26/26, tres ejecuciones) | **CI:** E2E de autenticación 63/63 | — | — | Repetir tras cada despliegue |
| C1 | El usuario autorizado entra y ve datos reales correctos | PARCIAL | **R:** EV-04 (login y uso sin errores, sin comparar las 12 pestañas ni los totales) | **CI:** E2E con datos sintéticos | — | «Leído de Google Sheets», 12/12 pestañas válidas y totales iguales a la hoja (✅/❌, sin cifras) | [Hoja](hoja-propietario.md), bloque 2 |
| C2 | Una cuenta no autorizada es rechazada | PENDIENTE | — | **CI:** `signIn` exige correo verificado y en la lista (`auth.ts`); E2E de auth con correos sintéticos | — | Intento real, en una ventana privada, con una cuenta fuera de la lista | [Hoja](hoja-propietario.md), bloque 1 |
| C3 | 401 sin sesión; 403 para una sesión ya no permitida | PARCIAL | **P:** EV-12 (401 en las 7 APIs privadas sin sesión; cubierto por B1) | **CI:** 403 en `authz.ts` y sus pruebas | **DEC:** el 403 real es opcional: exige retirar un correo (nueva versión del secreto y redespliegue), con autorización. No se simula como real | 403 real, o excepción expresa del propietario | Decidir en el [acta](acta-cierre-v1-6.md) |
| C4 | Las páginas del dashboard cargan con datos reales | PARCIAL | **R:** EV-04 («uso sin errores», sin detalle por página) | **CI:** E2E de integración | — | ✅/❌ de Inicio, Proyectos, Tareas, Actividad y Capacidad | [Hoja](hoja-propietario.md), bloque 2 |
| C5 | Planificación V1.5 simula sin escribir | PENDIENTE | — | **CI:** E2E de planificación; `planning-security.test.ts` | — | Recorrido real de `/planificacion`, con su aviso de simulación | [Hoja](hoja-propietario.md), bloque 2 |
| C6 | Centro de control V1.6 con aviso de simulación | PENDIENTE | — | **CI:** E2E de control; `governance-security.test.ts` | — | Recorrido real de `/control`, con el aviso «no se guardaron cambios» | [Hoja](hoja-propietario.md), bloque 2 |
| C7 | Operaciones V1.4 cerradas en producción | PARCIAL | **P:** EV-06 (sin variables de escritura: la escritura no puede activarse) | **CI:** sonda 503 con escritura; navegación sin Operaciones (`integration-security.test.ts`) | — | Menú sin Operaciones y formularios con el aviso de escritura deshabilitada | [Hoja](hoja-propietario.md), bloque 2 |
| D1 | La cuenta de servicio no editó la hoja | PENDIENTE | — | **CI:** el cliente solo emite `GET` con alcance de solo lectura (`security.test.ts`) | — | Historial de versiones de la hoja sin ediciones de la cuenta runtime | [Hoja](hoja-propietario.md), bloque 3 |
| D2 | Permiso mínimo en la hoja (Lector, acceso restringido) | PENDIENTE | — | — | — | Diálogo *Compartir*: la cuenta runtime solo como Lector y el acceso general Restringido | [Hoja](hoja-propietario.md), bloque 3 |
| D3 | Alcance del token y solo `GET` | VERIFICADO (código) | — | **CI:** `security.test.ts` («el cliente de Sheets solo emite GET», «ningún código usa el alcance de escritura») | — | — | D1 y D2 son la prueba real |
| E1 | Logs sin correos ni tokens | PARCIAL | **P:** EV-06 y EV-12 (`@` solo en auditoría de Google; 0 `ya29.` y 0 `Bearer`; 1 `code=` en el log de peticiones); EV-09 (exclusión añadida en `_Default`) | **CI:** el plan y el diagnóstico solo cuentan, sin contenido. **S:** diagnóstico con `gcloud` falso | **T:** la entrada `code=` del 2026-10-11 sale de la ventana de 30 días el 2026-11-11 | Estado `CORRECTA` de la exclusión (nunca se verificó); E1 = 0 a partir del 2026-11-11. La exclusión solo cubre `_Default`: no prueba nada sobre otros sinks, buckets o exportaciones | [Hoja](hoja-propietario.md), bloque 5 |
| E2 | Solo códigos de la app en los logs | PARCIAL | **P:** EV-12 (con `severity>=WARNING`: 0 avisos de la app y 29 de la plataforma, en contexto en la [remediación §5.1](remediacion-2026-10-11.md)); EV-06 y EV-12 (ninguna línea de la app con `@`, `ya29.`, `Bearer` o `code=`) | **CI:** las líneas de la app solo llevan códigos (`security.test.ts`). **S:** vocabulario cerrado con `gcloud` falso | — | Líneas `[project-os]` de **cualquier** severidad, por código: la lectura anterior no las veía (§3, D-12) | [Hoja](hoja-propietario.md), bloque 5 |
| F1 | Presupuesto y alertas existen | PARCIAL | **R:** EV-05 (presupuesto de USD 5 con alertas, reportado) | — | — | ✅ del presupuesto y de sus umbrales en la consola, sin el ID de facturación | [Hoja](hoja-propietario.md), bloque 4 |
| F2 | El costo real es coherente con la estimación | PENDIENTE | — | — | **T:** informes a las 24–48 h del despliegue y después cada mes | Gasto aproximado por servicio, sin IDs | [Hoja](hoja-propietario.md), bloque 4 |
| F3 | Retención de imágenes efectiva | PARCIAL | **P:** EV-06 (política activa `PERMITIDO`; 1 imagen) | **CI:** política revisada (P6); `limpieza-artifact-v1-6.sh --check` probado | **T:** el efecto solo es observable con ≥ 5 imágenes y alguna de más de 30 días | Lista de imágenes y etiquetas cuando se cumpla la condición | Runbook operativo §4, en el primer mantenimiento que la cumpla |
| G1 | Cerrar el acceso sin borrar nada | PENDIENTE | — | **S:** procedimiento documentado (runbook histórico §6, runbook operativo §6); no ensayado | **DEC:** el ensayo corta el servicio: solo con autorización y en una ventana acordada | Ensayo autorizado, o excepción expresa del propietario | Decidir en el [acta](acta-cierre-v1-6.md) |
| G2 | Volver a una revisión anterior | NO_APLICA hasta que exista una 2.ª revisión con su imagen | **P:** EV-06 y EV-12 (1 revisión con el 100 % del tráfico) | **CI:** el evaluador G2 exige un ensayo autorizado | — | Revisión anterior recuperable (`produccion-anterior`) y ensayo autorizado | Reevaluar tras el próximo despliegue; no se crea una revisión solo para cerrarlo |
| G3 | El propietario sabe desmantelar | PENDIENTE | — | **S:** procedimiento en el runbook §7 | — | ✅ de lectura del procedimiento | [Hoja](hoja-propietario.md), bloque 5 |
| H | Cierre de la aceptación | PENDIENTE | — | — | — | Los controles PARCIAL y PENDIENTE, con evidencia o con una excepción expresa del propietario (§5) | [Acta de cierre](acta-cierre-v1-6.md) |

**Resumen (Misión 014, línea base del 2026-10-11):**

| Estado | Controles |
| --- | --- |
| VERIFICADO (10) | A1, A3, A4, A5, A6, A7, A8, A9, B1, D3 (código) |
| PARCIAL (9) | A2, C1, C3, C4, C7, E1, E2, F1, F3 |
| PENDIENTE (9) | C2, C5, C6, D1, D2, F2, G1, G3, H |
| NO_APLICA (1) | G2 |

El resumen, las etiquetas, las referencias `EV-xx` y la identidad los comprueba `scripts/ops/matriz.mjs` en
`operacion-v1-6.test.ts`: la matriz no puede quedar desfasada ni aprobar un control sin evidencia real.

## 3. Discrepancias detectadas

| # | Discrepancia | Estado |
| --- | --- | --- |
| D-1 | `maxScale` de **servicio** 3 frente a revisión 1 | **Resuelta (2026-10-11):** servicio en 1 con `--max=1`, sin revisión nueva (EV-11) |
| D-2 | El checklist A7 solo miraba las anotaciones de revisión | Resuelta en la Misión 013: el plan y la matriz leen ambos niveles |
| D-3 | `web/README.md` decía «No está desplegado» | Corregida en la Misión 013 |
| D-4 | El runbook histórico §6 asume una revisión anterior | Vigente: G2 = NO_APLICA; runbook operativo §7 |
| D-5 | `check:client-secrets`: 0 valores reales comparados (EV-02); la CI compara 4 valores falsos | Aceptada: los valores reales se inyectan en tiempo de ejecución; autoprueba con canarios (`auditoria-seguridad.md` §5) |
| D-6 | `web/package.json` dice versión `1.3.0` | Cosmética; backlog V1.7 (Q2) |
| D-7 | El estimador de costo E4 suponía `maxScale` 1 | Resuelta con D-1 |
| D-8 | La imagen en uso no tenía la etiqueta `produccion` | **Resuelta (2026-10-11):** C9 (EV-06) |
| D-9 | **Preflight P12** decía «workflows sin credenciales ni comandos de Google Cloud», pero el colector V1.1 usa una clave de cuenta de servicio de Google en `pr-validation.yml` (lee la hoja en dry-run en cada PR del repositorio) y en `manual-github-evidence.yml` | **Corregida (Misión 014):** P12 cubre el dashboard y cualquier workflow nuevo; P15 declara el colector como riesgo pendiente de decisión (X-8), nunca como OK |
| D-10 | El registro de producción §7 decía «exclusión activa» | **Matizada (Misión 014):** la herramienta de entonces solo comprobaba el nombre; el filtro y `disabled` están sin verificar (E1) |
| D-11 | La matriz decía «28 avisos» de la plataforma | **Corregida (Misión 014):** eran **29** (21 × 401, 7 × 403, 1 × 404; EV-12) |
| D-12 | E2 estaba en VERIFICADO con una lectura `severity>=WARNING`. Según la documentación de Google para Cloud Run functions, `console.warn` y `console.error` no llevan nivel de log, y la app escribe así sus líneas `[project-os]` | **Corregida (Misión 014):** E2 → PARCIAL; el diagnóstico y el runbook leen las líneas `[project-os]` de **cualquier** severidad |
| D-13 | El diagnóstico mostraba «0 (sin coincidencias)» junto a `LECTURA_FALLIDA` cuando una lectura fallaba | **Corregida (Misión 014):** una lectura fallida nunca muestra un 0 y el diagnóstico sale con 3 (`remediacion-v1-6.test.ts`) |

## 4. Bloqueadores frente a deuda técnica

Ninguno impide que el servicio **funcione hoy**. Se clasifican respecto de la **puerta 4**, el acceso regular (regla del
checklist: A, B, D y E en ✅), y del **próximo despliegue**.

| Clase | Controles | Motivo |
| --- | --- | --- |
| **Bloquea la puerta 4** | A2, D1, D2, E2 | Solo faltan comprobaciones de navegador y de consola ([hoja](hoja-propietario.md)) |
| **Bloquea la puerta 4 hasta una fecha** | E1 | Exclusión `CORRECTA` ahora; recuento E1 = 0 a partir del 2026-11-11 |
| **Bloquea la puerta 4 por seguridad** | C2 | La barrera real es la lista de correos, y no se probó con una cuenta real fuera de ella |
| **Bloquea el próximo build o despliegue** | Ninguno | A9 y D-1 resueltos |
| **Requiere decisión del propietario** | C3 (403 real), G1 (ensayo), X-2 (dependencias), X-8 (clave del colector) | Excepción expresa o prueba autorizada ([acta](acta-cierre-v1-6.md)) |
| **Deuda no bloqueante** | C1, C4–C7, F1–F3, G2, G3, D-6 | Comprobaciones funcionales, de costo o de procedimiento sin exposición de datos |

## 5. Excepciones aceptadas por el propietario

Solo el propietario puede añadir filas aquí, con la fecha y la referencia a su aprobación (comentario o issue). Una fila
permite cerrar H con ese control sin evidencia; nunca convierte el control en VERIFICADO.

| ID | Excepción | Fecha | Referencia |
| --- | --- | --- | --- |

**Ninguna registrada** a fecha de esta versión. Las propuestas están en la [línea base §6](linea-base-v1-6.md) y en el
[acta](acta-cierre-v1-6.md).

## 6. Mutaciones que esta matriz **no** realiza

Cada una requiere una autorización específica del propietario y se ejecuta a mano:

- ensayar el cierre de acceso (G1) o el rollback (G2);
- retirar un correo para probar el 403 real (C3);
- redesplegar, rotar secretos o cambiar IAM, logs o la política de limpieza.

La matriz solo prepara lecturas y registra su resultado.
