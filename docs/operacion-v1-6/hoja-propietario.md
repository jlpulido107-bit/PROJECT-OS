# PROJECT-OS V1.6 — Hoja única para el propietario

> Solo las acciones que **requieren tu identidad**; todo lo demás ya está hecho o probado en el PR. Tiempo total
> ≈ 75 min, repartible en varios días. **Nunca compartas** correos, tokens, IDs de facturación, valores de la hoja ni
> líneas de log: solo ✅/❌, conteos y la tabla que imprime `evidencia.mjs`.

| Paso | Qué haces | Dónde | Tiempo | Qué compartes (sin secretos) | Cierra |
| --- | --- | --- | --- | --- | --- |
| 1 | `node web/scripts/ops/plan-inspeccion.mjs --plantilla-evidencia > ~/evidencia.json`; ejecuta cada comando que muestra `node web/scripts/ops/plan-inspeccion.mjs` y copia **solo** el dato pedido en `observado`; pon la fecha; luego `node web/scripts/ops/evidencia.mjs ~/evidencia.json` | Cloud Shell, en un clon de `main` | 25 min | La **tabla** de resultados (OK/FALLO/NO_VERIFICADO). El JSON queda fuera del repositorio | A1, A2, A4–A9, E1, F3, G2 |
| 2 | Entra con tu cuenta. Comprueba "Leído de Google Sheets", **12/12 pestañas** y que los totales coinciden con la hoja. Recorre Proyectos, Tareas, Actividad, Capacidad, `/planificacion` (aviso de simulación) y `/control` (aviso "no se guardaron cambios"). Confirma que no ves Operaciones | Navegador | 15 min | ✅/❌ por punto. **Sin cifras ni capturas** | C1, C4–C7 |
| 3 | En una ventana privada, intenta entrar con una cuenta de Google que **no** esté en la lista | Navegador | 5 min | ✅ si vuelve a `/login` con acceso denegado y no ves datos | C2 |
| 4 | En la hoja: *Archivo → Historial de versiones* (ningún cambio de la cuenta de servicio) y *Compartir* (cuenta de servicio solo como **Lector**; acceso general **Restringido**) | Google Sheets | 5 min | ✅/❌ y ✅/❌ | D1, D2 |
| 5 | Logs Explorer con el filtro del runbook operativo §5.1, `severity>=WARNING AND textPayload:"[project-os]"`, últimos 7 días: mira **solo** los códigos | Consola | 10 min | Conteo por código (p. ej. `data-config: 0`) | E2 |
| 6 | *Facturación → Presupuestos* (existe el de USD 5 con sus umbrales) e *Informes* por servicio. A las 24–48 h del despliegue y luego cada mes | Consola | 10 min | ✅ presupuesto; gasto **aproximado por servicio** (sin ID de cuenta) | F1, F2 |
| 7 | Lee el runbook histórico §6–§7 (cerrar acceso, desmantelar) y el runbook operativo §6–§7 (incidentes, recuperación) | Repositorio | 5 min | ✅ "entendido" | G3 |

## Decisiones que solo tú puedes tomar (cada una, autorización aparte)

1. **C9 / A9.** Si el paso 1 da `FALLO` en A9: ¿autorizas etiquetar el digest en uso como `produccion` (runbook §5.7)?
   *Recomendado* antes del próximo build.
2. **D-1.** Si el paso 1 muestra un `maxScale` de servicio ≠ 1: ¿alineamos el servicio a 1? *Recomendado*, tras ver
   la métrica de instancias.
3. **Merge de este PR**, tras la revisión de ChatGPT.
4. **Ensayo de cierre de acceso (G1):** solo si quieres probarlo, en una ventana acordada.

## Cómo pedir la revisión de ChatGPT

Comparte el enlace del PR #23 con ChatGPT y pide que lo revise con el conector de GitHub. Es el único paso manual
para iniciar esa revisión: no hay una integración automática.
