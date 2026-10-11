# PROJECT-OS V1.6 — Hoja definitiva del propietario (cierre de la aceptación)

> **Para qué:** completar, en una sola sesión de unos **70 minutos**, las comprobaciones que solo puedes hacer tú, con
> tu identidad. Todo lo demás ya está hecho o probado:
>
> - [línea base](linea-base-v1-6.md);
> - [matriz](matriz-aceptacion.md).
>
> **Cómo responder:** cada fila se contesta solo con **OK / FALLO / NO_VERIFICADO**, más los conteos que se piden.
> Nunca compartas:
>
> - correos, nombres ni capturas;
> - valores de la hoja ni líneas de log;
> - URLs con parámetros;
> - IDs de facturación ni secretos.
>
> **Sin cambios:** ninguna fila te pide cambiar nada. Si algo falla, la última columna dice qué hacer. Toda corrección es
> una decisión aparte, con su autorización.

Orden: los bloques van por dependencia. El login del bloque 1 sirve también para el bloque 5: permite comprobar que la
exclusión de logs funciona. Necesitas:

- un navegador con ventanas privadas;
- tu cuenta autorizada y **otra cuenta de Google que no esté en la lista**;
- la consola de Google Cloud con tu cuenta de propietario;
- la hoja de cálculo;
- Cloud Shell, solo para el bloque 5.

URL estable: `https://project-os-dashboard-235975889400.northamerica-south1.run.app`

## Bloque 1. OAuth y acceso (≈ 15 min)

| Control | Dónde entrar | Acción | Resultado correcto | Qué reportar | Qué hacer si falla |
| --- | --- | --- | --- | --- | --- |
| 1.1 · A2 Callback | Consola de Google Cloud → *Google Auth Platform* → *Clientes* → cliente OAuth **de producción** (tipo *Aplicación web*) | Mira las *URI de redireccionamiento autorizados* | Aparece **exactamente** la URL estable seguida de `/api/auth/callback/google`, con `https` y sin barra final | `A2: OK / FALLO / NO_VERIFICADO` | No la cambies todavía. Reporta FALLO («callback distinto»). Corregirla es una mutación con autorización ([runbook operativo §6](runbook-operativo.md), «Callback OAuth») |
| 1.2 · C1 Login autorizado | Ventana **privada** nueva → URL estable | *Continuar con Google* con tu cuenta autorizada | Entras en el Inicio del panel | `Login: OK / FALLO` | [Runbook operativo §6](runbook-operativo.md): «Callback OAuth» o «403 de un usuario permitido» |
| 1.3 · C2 Cuenta no autorizada | **Otra** ventana privada nueva → URL estable | Entra con una cuenta de Google que **no** esté en la lista | Vuelves a `/login` con el aviso «Esta cuenta no está autorizada…» y no ves ningún dato ni nombre de pestaña | `C2: OK / FALLO` (nunca qué cuenta usaste) | Si ves datos: es un incidente. Cierra el acceso ([runbook operativo §6](runbook-operativo.md), «Posible exposición de datos») y reporta FALLO |

## Bloque 2. Dashboard y Sheets (≈ 20 min, con la sesión de 1.2)

| Control | Dónde entrar | Acción | Resultado correcto | Qué reportar | Qué hacer si falla |
| --- | --- | --- | --- | --- | --- |
| 2.1 · C1 Fuente | Inicio del panel | Mira el origen de los datos | Dice «**Leído de Google Sheets**», nunca «Datos sintéticos» | `C1 fuente: OK / FALLO` | Reporta FALLO; no sigas con 2.2–2.3 |
| 2.2 · C1 Pestañas | Inicio → *Diagnóstico de datos* (desplegable al final) | Ábrelo | «**12/12 pestañas válidas**» | `C1 pestañas: OK / FALLO` y el número de válidas (p. ej. 11/12) | [Runbook operativo §6](runbook-operativo.md), «Lectura de Sheets 503» (por el código que muestre) |
| 2.3 · C1 Totales | El panel y, en otra pestaña, la hoja de cálculo | Compara 3 totales: proyectos, tareas abiertas y tareas del proyecto principal | Los 3 coinciden con la hoja | `C1 totales: OK / FALLO` (**sin cifras**) | Reporta qué total no coincide, sin el valor. La caché es de 60 s: recarga una vez antes de dar FALLO |
| 2.4 · C4 Páginas | Menú del panel | Abre Inicio, Proyectos (y un proyecto), Tareas (prueba un filtro), Actividad y Capacidad | Las 5 cargan con datos y sin pantalla de error | `C4: n/5 OK` | Anota qué página falla; ninguna captura |
| 2.5 · C5 Planificación | `/planificacion` | Revisa una propuesta y, si existe, un escenario simulado | Hay un aviso de que es una simulación y no se escribe nada | `C5: OK / FALLO` | Reporta FALLO; no reintentes acciones |
| 2.6 · C6 Centro de control | `/control` | Abre una alerta y su revisión simulada | Hechos, inferencias e hipótesis separados, y el aviso «**Simulación — no se guardaron cambios**» | `C6: OK / FALLO` | Reporta FALLO |
| 2.7 · C7 Operaciones | Menú del panel, `/operaciones` y `/tareas/nueva` | Busca «Operaciones» en el menú y abre esas dos rutas | **No** hay enlace «Operaciones»; las páginas dicen que la escritura está deshabilitada | `C7: OK / FALLO` | Si se pudiera escribir: incidente. [Runbook operativo §6](runbook-operativo.md), «Bloqueo de acceso». Reporta FALLO |

## Bloque 3. Permisos de datos (≈ 10 min, en la hoja de cálculo)

| Control | Dónde entrar | Acción | Resultado correcto | Qué reportar | Qué hacer si falla |
| --- | --- | --- | --- | --- | --- |
| 3.1 · D2 Compartir | Hoja → botón *Compartir* | Mira el *Acceso general* y la cuenta runtime `project-os-dashboard-run@PROJECT_ID.iam.gserviceaccount.com` (con `PROJECT_ID` = `project-os-511102`) | Acceso general **Restringido**; esa cuenta solo como **Lector** | `D2: OK / FALLO`. Además: `otra cuenta de servicio con permiso de Editor: sí / no` (sin su nombre) | No cambies permisos ahora: reporta FALLO. La otra cuenta de servicio, si existe, es la del colector V1.1 (riesgo X-8 del acta) |
| 3.2 · D1 Historial | Hoja → *Archivo* → *Historial de versiones* → *Ver historial de versiones* | Revisa los cambios desde el 2026-10-11 | Ningún cambio atribuido a la cuenta `project-os-dashboard-run` | `D1: OK / FALLO`. Además: `cambios de otra cuenta de servicio: sí / no` | Si la cuenta runtime aparece como autora: incidente. Cierra el acceso ([runbook operativo §6](runbook-operativo.md)) y reporta FALLO |

## Bloque 4. Costos y recursos (≈ 10 min, en la consola)

| Control | Dónde entrar | Acción | Resultado correcto | Qué reportar | Qué hacer si falla |
| --- | --- | --- | --- | --- | --- |
| 4.1 · F1 Presupuesto | *Facturación* → *Presupuestos y alertas* | Busca el presupuesto que cubre `project-os-511102` | Existe, de **USD 5**, con sus umbrales de alerta. Recuerda: **avisa, no corta el gasto** | `F1: OK / FALLO` (nunca el ID de la cuenta) | Reporta FALLO; crearlo es una decisión aparte |
| 4.2 · F2 Gasto | *Facturación* → *Informes*, filtrado por el proyecto, desde el 2026-10-11, agrupado por servicio | Mira el gasto por servicio y si hay algún servicio inesperado | Total coherente con la estimación (≈ USD 0–1 al mes con 1–2 personas) y sin servicios inesperados | `F2: OK / FALLO` y el rango del total: `< 1 · 1–5 · > 5 USD` | Si supera lo esperado: [runbook operativo §6](runbook-operativo.md), «Costo inesperado» |
| 4.3 · A7 Instancias | *Monitoring* → *Metrics Explorer* → *Cloud Run Revision* → *Instance count*, servicio `project-os-dashboard`, agregación **max**, 30 días | Lee el máximo | **1** o menos | `A7 máximo: n` (un número) | Si es > 1: reporta el número. A7 pasa a FALLO; no cambies el escalado sin autorización |

## Bloque 5. Logs y recuperación (≈ 15 min)

| Control | Dónde entrar | Acción | Resultado correcto | Qué reportar | Qué hacer si falla |
| --- | --- | --- | --- | --- | --- |
| 5.1 · E1 Exclusión y `code=` | Cloud Shell, en un clon actualizado del repositorio: rama del PR #24, o `main` tras su fusión | `bash web/deploy/infra/remediacion-v1-6.sh diagnostico`. Es **solo lectura**: no pide frases ni cambia nada | Sin «Diagnóstico INCOMPLETO». Exclusión: `estado: CORRECTA`. Patrón `code=`: **1**, la entrada del 2026-10-11. Aunque hiciste login en 1.2, no debe haber más | `E1 exclusión: CORRECTA / otro estado` y `code=: n` | `LECTURA_FALLIDA`: repite una vez y, si sigue, NO_VERIFICADO. Exclusión distinta de `CORRECTA`, o `code=` mayor que 1: FALLO. No corrijas nada sin autorización ([remediación §3](remediacion-2026-10-11.md)) |
| 5.2 · E2 Líneas de la app | La sección `== E2` de la misma salida | Busca líneas con `[project-os]` y revisa los 403 | Ninguna línea `[project-os]`, o solo categorías conocidas (nunca «categoría no reconocida»). Los 401 solo en las 7 APIs. Ningún 403 posterior al 2026-10-11 | `E2: OK / FALLO` y el conteo por categoría (p. ej. `Configuración inválida: 0`) | Una «categoría no reconocida» o un 403 nuevo: [runbook operativo §5.3](runbook-operativo.md), sin copiar líneas |
| 5.3 · A6 Versión destruida | La sección `== A6` de la misma salida | Mira `estados=[…]` de `project-os-google-client-secret` | `1:DESTROYED` (o `1:DISABLED-programada`) y una sola versión `ENABLED` por secreto | `A6 versión 1: DESTROYED / programada / otro` | Si sigue `DISABLED` sin programar: se puede destruir con su autorización ([remediación §2](remediacion-2026-10-11.md), paso 5) |
| 5.4 · E1 Ventana histórica | Cloud Shell, **a partir del 2026-11-11** | Repite el diagnóstico de 5.1 | Patrón `code=`: **0**, y la exclusión sigue `CORRECTA` | `E1 (2026-11-11 o después): OK / FALLO` | Si sigue > 0: la exclusión no funciona. FALLO |
| 5.5 · G3 Procedimientos | Repositorio: [runbook operativo](runbook-operativo.md) §6–§7 y [runbook histórico](../despliegue-privado-v1-3.md) §6–§7 | Lee los incidentes, el cierre de acceso, la recuperación y el desmantelamiento | Sabes qué hacer en cada caso, sin ejecutar nada | `G3: OK / NO_VERIFICADO` | Pide la aclaración en el PR o en el issue |

## Cómo entregar el resultado

Pega en el PR #24, o en el issue #22, solo este bloque rellenado. Sin capturas.

```
Fecha: AAAA-MM-DD
Bloque 1: A2 ___ · login ___ · C2 ___
Bloque 2: C1 fuente ___ · C1 pestañas ___ (__/12) · C1 totales ___ · C4 __/5 · C5 ___ · C6 ___ · C7 ___
Bloque 3: D2 ___ (otra cuenta de servicio con Editor: sí/no) · D1 ___ (cambios de otra cuenta de servicio: sí/no)
Bloque 4: F1 ___ · F2 ___ (rango: <1 / 1–5 / >5 USD) · A7 máximo = __
Bloque 5: E1 exclusión ___ · code= __ · E2 ___ (categorías: …) · A6 versión 1 ___ · G3 ___
Bloque 5.4 (desde 2026-11-11): E1 ___
```

Con esto, la matriz se actualiza por control: OK → VERIFICADO si cumple su condición de cierre, FALLO → se investiga, y
NO_VERIFICADO → sigue pendiente. Después, el [acta de cierre](acta-cierre-v1-6.md) recoge tus decisiones.

## Decisiones que solo tú puedes tomar (en el acta, cada una aparte)

1. **C3 (403 real):** aceptar la excepción, o autorizar la prueba. Exige retirar un correo y redesplegar.
2. **G1 (cierre de acceso):** aceptar la excepción, o autorizar un ensayo en una ventana acordada.
3. **X-2 (dependencias de desarrollo):** aceptar la deuda documentada, o pedir otro plan.
4. **X-8 (clave del colector en la CI):** mantenerla, restringir el paso de dry-run o migrarla a OIDC.
5. **Merge del PR #24 y aceptación de la V1.6:** solo tras la revisión de ChatGPT y con esta hoja completa.
