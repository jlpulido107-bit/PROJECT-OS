# Diseño de Planificación v2 — Hoy, Flujo y Semana, y el bloque «Esperando por ti»

Orden ORD-POS-118 (tarea POS-039), riesgo BAJO (solo documento), paquete PAQ-2026-10-30-06. Fecha: 2026-10-31. No cambia
código, no escribe en ninguna hoja ni despliega. Parte de la vista /planificacion actual (✅
`web/src/app/(private)/planificacion/page.tsx`, motor `web/src/lib/planning/engine.ts`), de Inicio (✅
`web/src/lib/inicio.ts`) y de /ordenes (✅ `web/src/app/(private)/ordenes/page.tsx`). Complementa, sin sustituirlo, el
tablero de [Inicio v2](diseno-inicio-v2.md).

Marcas: ✅ verificado en el código de `main` (commit `deed949`) · 📄 según un diseño o un documento fusionado · ❓ por
confirmar al construir. Lo que solo dice la orden (no verificado en el código ni en la hoja) va como **hipótesis**.

| Criterio de la orden | Sección |
| --- | --- |
| 1. Tres capas: Hoy, Flujo y Semana | §3, §4 y §5 |
| 2. Bloque «Esperando por ti» de Inicio | §6 |
| 3. Regla de lenguaje: nombre junto al ID | §2 |
| 4. Fuente de datos por elemento, qué falta y bocetos | Tablas «Fuente» de §3 a §6 y §7 |
| 5. Fases para órdenes futuras con riesgo y si es sensible | §8 |
| 6. Sin código | Este PR solo añade este archivo |

## 1. Qué es y qué no es

- Hoy /planificacion muestra el motor de la v1.5 en tablas con IDs (✅ `PlanningView`: tareas, días, proyectos,
  conflictos y escenario). Sirve para simular, no para «qué hago ahora». La v2 pone **tres capas arriba**, en lenguaje
  llano, y deja la vista actual debajo, plegada, bajo «Detalle del plan» (sin quitarle nada).
- **Solo lectura**, salvo el botón «Marcar completada» que **ya existe** (✅ `CompleteTaskForm`, ORD-POS-106,
  DEC-POS-023): la v2 lo reutiliza tal cual, con la misma ruta (`POST /api/operaciones/tareas/{id}/completar`) y el
  mismo guard del servidor. Ninguna escritura nueva.
- Funciones puras nuevas en `web/src/lib/planificacion-v2.ts` (❓ nombre) sobre lo que la página ya lee
  (`privateData('/planificacion')`, `planWeek`) y lo que /ordenes ya lee de GitHub. Nada se recalcula si ya existe.
- Mismos tres estados que [Inicio v2 §2.1](diseno-inicio-v2.md#21-tres-estados-por-tarjeta-y-por-gráfica): `ok`,
  `sin-datos` (con motivo, **nunca un 0**) y `apagada` (falta una variable o una fuente, y quién la enciende).
- Sin dependencias nuevas: barras en CSS como el resto del dashboard, siempre con su tabla accesible.

## 2. Regla de lenguaje (criterio 3)

**Nunca un código suelto.** Todo ID que se muestre va acompañado de su nombre, y el nombre va primero:

| Entidad | Se muestra así | Nombre de la fuente (✅ `web/src/lib/types.ts`) | Sin nombre |
| --- | --- | --- | --- |
| Tarea | «Probar el corte de fin de mes · POS-041» | `Tarea.titulo` | «(tarea sin título) · POS-041» |
| Proyecto | «PROJECT-OS» | `Proyecto.nombre` de PROYECTOS | El ID solo si la fila no tiene nombre, con «(sin nombre)» |
| Orden | «Diseño de Planificación amigable · ORD-POS-118» | `Orden.titulo` | «(orden sin título) · ORD-…» |
| Hito | «Dashboard usable a diario · POS-H2» | `Hito.nombre` | «(hito sin nombre) · …» |
| Decisión | «Agente de finanzas por cortes · DEC-POS-018» | `Decision.asunto` | «(decisión sin asunto) · DEC-…» |
| PR | «PR #271 de Diseño de Planificación…» | Título de la orden del PR | «PR #N» con el enlace |
| Estado | «Esperando tu aprobación» en vez de `BORRADOR` | Texto de `SIGUIENTE_PASO` (✅ `ordenes.ts`) o de §4 | El código entre paréntesis |
| Bandera | «Cierre de tareas por el propietario» en vez de `TAREAS_CIERRE_PROPIETARIO` | Texto fijo de §6.4 | — |

- El ID va en letra monoespaciada y más pequeña, como enlace a su ficha: sirve para buscarlo, no para leerlo.
- Minutos y horas en palabras cortas: «45 min», «2 h 30 min»; fechas con día de la semana: «vie 31 oct».
- Un helper único `etiqueta(entidad)` (❓) con su prueba: ningún componente nuevo escribe un ID sin pasar por él.

## 3. Capa Hoy (criterio 1)

Qué hacer hoy, en tarjetas, una por tarea, en el orden del plan del día.

```text
┌ Hoy · vie 31 oct ─────────────────────────────── 3 tareas · 2 h 15 min de 4 h ┐
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ Probar el corte de fin de mes                         POS-041 · 60 min   │ │
│ │ PROJECT-OS · vence hoy                                                   │ │
│ │ ▸ Instrucciones (4 pasos)                                                │ │
│ │                                                  [ Marcar completada ]   │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ Revisar menús de noviembre                            SIG-012 · 45 min   │ │
│ │ SIGSAH · ya llevas 20 min                                                │ │
│ │ (sin instrucciones)                                                      │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│ También vencen hoy, fuera del plan: Renovar el token de lectura · POS-040    │
└──────────────────────────────────────────────────────────────────────────────┘
```

| Elemento | Fuente existente (solo lectura) | Qué falta |
| --- | --- | --- |
| Tareas del día y su orden | `PlanResult.dias[hoy].items` (✅ `tareaId`, `minutos`, `orden`) de `planWeek` con el escenario por omisión; si el día tiene `planRegistrado`, son los PLAN_ITEMS registrados (✅ el motor los respeta) | Nada |
| Nombre | `Tarea.titulo` | Nada |
| Proyecto | `Tarea.proyectoId` → `Proyecto.nombre` | Nada |
| Minutos | `items[].minutos`; «ya llevas» = `TaskPlan.registradoMin` (TIEMPOS) | Nada |
| Vence hoy | `TaskPlan.fechaLimite` = hoy | Nada |
| Instrucciones | `Tarea.instrucciones` (✅ ORD-POS-105, columna opcional), con el componente `Instrucciones` (✅ `components/instrucciones.tsx`) plegado | Nada; sin la columna, «(sin instrucciones)» |
| Botón de cierre | `CompleteTaskForm` (✅ `components/operations/forms.tsx`), hoy solo en `/tareas/[id]/editar`; se muestra si `puedeCerrarTareas(email)` (✅ `operations/config.ts`) | Pasarle `version` (numérica, convertida desde `Tarea.version` como lo hace `/tareas/[id]/editar`) y `criterioTerminado`. Sin la bandera o con otra sesión, el botón no aparece y la tarjeta dice «el cierre lo hace el propietario» |
| Vencen hoy fuera del plan | Tareas abiertas con `fechaLimite` = hoy que no están en `items` (misma regla que `misPendientes`, ✅ `inicio.ts`) | Nada |

Estados: `sin-datos` si TAREAS o PLAN_ITEMS no son válidas (✅ `TabWarnings`), o si el día no es laborable («hoy no hay
capacidad registrada»); un día laborable sin tareas propuestas dice «nada planeado para hoy», no un 0.

**Hipótesis:** según la orden, `TAREAS_CIERRE_PROPIETARIO` está encendida desde la revisión 00045 y producción va en la
00046; este diseño no lo verificó y no depende de ello.

## 4. Capa Flujo (criterio 1)

En qué paso va cada orden abierta y a quién espera. Una línea por orden, con los nueve pasos de la orden:

```text
Diseño de Planificación amigable · ORD-POS-118   BAJO · solo docs
 Borrador ─ Enviada ─ PR ─ PRIMERO ─ SEGUNDO ─ Revisada ─ Fusionada ─ Desplegada ─ Activada
    ●─────────●───────◉      ·          ·          ○          ○           ○           ·
                      └ espera: a ti (decidir) · PR #272 abierto hace 1 día

/eco: comisión de Amazon · ORD-ECO-020                MEDIO · sensible
 Borrador ─ Enviada ─ PR ─ PRIMERO ─ SEGUNDO ─ Revisada ─ Fusionada ─ Desplegada ─ Activada
    ●─────────●───────●──────●─────────◉         ○          ○           ○           ○
                                       └ espera: segundo revisor (Fable o Gemini supervisado)

● hecho   ◉ paso actual   ○ pendiente   · no aplica
```

### 4.1 Los pasos, su fuente y a quién esperan

| Paso | Hecho cuando | Fuente existente | Espera a | Qué falta |
| --- | --- | --- | --- | --- |
| Borrador | La orden existe | `ORDENES_CODEX.ESTADO` (✅ `ESTADOS_ORDEN`) | Propietario (aprobar) | Nada |
| Enviada | `ESTADO` ∈ ENVIADA y posteriores, con `issueUrl` | `ORDENES_CODEX` (APROBADA sin issue = «reintentar el envío», ✅ `SIGUIENTE_PASO`) | Claude (implementa) | Nada |
| PR | `prUrl` registrado o PR detectado | `Orden.prUrl`; PR detectado de `prsDeOrdenes` (✅ `operations/github.ts`, caché de /agentes) | Revisor (PRIMERO) | Nada |
| PRIMERO | Dictamen PRIMERO o DELTA CONFORME en el head actual | `dictamenDeOrden` / `evaluarDictamen` (✅ `operations/dictamenes.ts`, la caché de /ordenes) | Si CAMBIOS: corrector (Claude); si falta: revisor | Nada; cuesta llamadas a GitHub (§7) |
| SEGUNDO | SEGUNDO CONFORME de otro modelo en el mismo head | Igual que PRIMERO; `ordenSensible` (✅ `supervision/politica.ts`) decide si aplica | Segundo revisor | Nada |
| Revisada | `ESTADO` = REVISADA | `ORDENES_CODEX` | Propietario (fusionar) | Nada |
| Fusionada | El PR tiene `merged_at` | `PrFusion.fusionMs` (✅) | Propietario (desplegar) | Nada |
| Desplegada | El commit de la fusión está en la revisión activa | **No existe**: el servidor no conoce su propio commit (✅ `/api/health` solo da `ok`; `K_SERVICE` es lo único de Cloud Run que se lee) | Propietario (desplegar, DEC-POS-017) | Fuente nueva (§8, F5) |
| Activada | La bandera que la orden deja inerte está encendida | El estado de cada bandera sí se lee (✅ §6.4); **no existe** qué bandera pide cada orden | Propietario (`deploy.sh`) | Registro orden → bandera (§8, F5) |

Reglas:

- **No aplica** (`·`): PRIMERO y SEGUNDO en BAJO de solo docs (DEC-POS-008); SEGUNDO en BAJO y en MEDIO no sensible
  (DEC-POS-019, `SENSIBLE` = NO); Activada si la orden no deja nada inerte. Nunca se pinta «hecho» lo que no aplica.
- El **paso actual** es el primero no hecho que aplica; «espera a» sale de la tabla y, para PRIMERO y SEGUNDO, del texto
  `EvaluacionDictamen.siguiente` (✅), que ya dice «Lanzar revisión», «Listo para tu decisión», etc.
- Una orden CERRADA o CANCELADA sale del Flujo (queda en /ordenes). Una fusionada sin cerrar sigue hasta «Desplegada».
- Nunca se infiere un paso: sin GitHub, PR, PRIMERO, SEGUNDO y Fusionada quedan `sin-datos` («no se pudo leer
  GitHub»), no «pendientes». Desplegada y Activada nacen `apagada` («falta la fuente; la añade la fase F5»).
- Encabezado de la capa: «Esperan por ti: 2 · por Claude: 3 · por revisor: 1».

## 5. Capa Semana (criterio 1)

Horas planeadas contra disponibles por día, e hitos con días restantes.

```text
Semana 44 · lun 27 oct – dom 2 nov            Disponibles 20 h (reserva 15 %) · planeadas 17 h
 lun 27  ███████████████░░░░░  3 h de 4 h  · real 2 h 40 min
 mar 28  ████████████████████  4 h de 4 h  · real 4 h 10 min
 mié 29  ██████████░░░░░░░░░░  2 h de 4 h  · real 1 h 30 min
 jue 30  ████████████████░░░░  3 h 15 min de 4 h
 vie 31  ███████████░░░░░░░░░  2 h 15 min de 4 h      ← hoy
 sáb 1   (no laborable)
 dom 2   (no laborable)

Hitos
 Dashboard usable a diario · POS-H2      vence en 14 días (vie 14 nov)   avance 6 de 9 tareas
 Planificación del rol Tiempos · POS-H1  vencido hace 0 días (hoy)       avance 4 de 4 · sin cerrar
```

| Elemento | Fuente existente (solo lectura) | Qué falta |
| --- | --- | --- |
| Días de la semana | `PlanResult.dias` (✅ `fecha`, `laborable`, `esPasado`) | Nada |
| Disponibles por día | `DayPlan.capacidadMin` (de CAPACIDAD_SEMANAL, ✅ `PlanResult.capacidad`) | Nada |
| Planeadas por día | `planExistenteMin + propuestoMin` (✅) | Nada |
| Real por día | `DayPlan.realMin` (TIEMPOS) en los días pasados | Nada |
| Totales de la semana | `capacidad.horasDisponibles`, `reservaPct`, `netaMin`, `usadoMin`, `propuestoMin` (✅) | Nada |
| Origen de la capacidad | `capacidad.origen` (`dato`, `supuesto`, `faltante`, `ambigua`) | Nada; con `supuesto` la capa lo dice en letra visible, con `faltante` es `sin-datos` |
| Hitos y días restantes | `HITOS.FECHA_OBJETIVO` y `ESTADO`; días con `marcaDe` / `DIAS_PROXIMO` (✅ `inicio.ts`) y riesgo con `RiesgoHito` (✅ `estado.ts`) | Nada |
| Avance del hito | Tareas COMPLETADO / tareas del hito sin CANCELADO (📄 `revisar-desviaciones` §2.1) | Nada; sin tareas, «avance no medible» |

La barra no tiene color de «bien» o «mal»: un día lleno no es un fallo. Pasarse de la capacidad sí se marca, con texto
(«15 min por encima»), no solo con color.

## 6. Bloque «Esperando por ti» de Inicio (criterio 2)

Arriba de Inicio, antes del tablero de Inicio v2: lo que solo el propietario puede destrabar. Cada línea dice qué hacer
y enlaza adonde se hace.

```text
┌ Esperando por ti ───────────────────────────────────────────────────── 6 ┐
│ Listos para fusionar (CONFORME)                                           │
│   Diseño de Planificación amigable · ORD-POS-118   PR #272  → fusionar    │
│ Fusionado sin desplegar                                     (fuente apagada)│
│ Decisiones por tomar                                                      │
│   Texto pendiente de SIGSAH · DEC-SIG-002                    → decidir     │
│ Banderas sin encender                                                     │
│   Agente de Tiempos (lectura de /api/planificacion)      apagada → deploy.sh│
│ Vencen hoy                                                                │
│   Renovar el token de lectura · POS-040                      → ver tarea   │
└───────────────────────────────────────────────────────────────────────────┘
```

| Grupo | Qué entra | Fuente existente (solo lectura) | Qué falta |
| --- | --- | --- | --- |
| 6.1 Listos para fusionar | Órdenes en `REVISADA` del filtro | `misPendientes(...).revisadas` (✅ `inicio.ts`). REVISADA ya exige CONFORME según DEC-POS-011, así que no hace falta leer dictámenes: **cero llamadas** nuevas a GitHub | Nada. Un PR_ABIERTO con CONFORME aún sin marcar REVISADA no entra: se ve en /ordenes (§9, pregunta 1) |
| 6.2 Fusionado sin desplegar | PRs `[ORD-` fusionados después del despliegue activo | Fusiones: `PrFusion.fusionMs` de las listas que Inicio ya lee (✅ `githubDeAgentes`). Despliegue activo: **no existe** en el servidor (§4.1) | La fuente de F5. Hasta entonces el grupo es `apagada` con ese motivo; nunca se infiere de la fecha de fusión sola |
| 6.3 Decisiones PENDIENTE | `DECISIONES.ESTADO` = PENDIENTE del filtro | `misPendientes(...).decisiones` (✅) | Nada |
| 6.4 Banderas sin encender | Banderas que una decisión APROBADA dejó para el propietario y siguen apagadas | Estado de cada una en el servidor, solo sí/no: `pmPuedeRegistrarPr`, `segundoGeminiSupervisado`, `tareasCierrePropietario` (✅ `operations/config.ts`), `tiemposAgenteHabilitado` (✅ `tiempos-agente.ts`), `FINANZAS_AGENTE_MODE` (✅ `finanzas/agente-config.ts`), `ECO_PIPELINE_WRITE_MODE` (✅ `radaros/pipeline-escritura-config.ts`) | Cuáles **deben** estar encendidas: hoy no está escrito en ningún dato (F5). La v1 del grupo lista solo las de una tarea abierta de activación (p. ej. POS-037, **hipótesis**: la tarea se lee de TAREAS, no se adivina) |
| 6.5 Vencen hoy | Tareas abiertas del propietario con `fechaLimite` = hoy, y las vencidas | `misPendientes(...).tareas` con `dias` ≤ 0 (✅, `esDelPropietario`) | Nada |

Reglas del bloque:

- Solo para la sesión del propietario (escritor); otro lector ve «Esperando por ti» vacío con el motivo, no los datos.
- Las banderas se muestran por su **nombre en palabras** (§2) y solo como «encendida» o «apagada»: nunca el valor, el
  correo de `TAREAS_CIERRE_PROPIETARIO_EMAIL` ni el hash de un token.
- El contador del encabezado suma solo grupos `ok`; un grupo `sin-datos` o `apagada` no cuenta como 0.
- Respeta `?proyecto=` como el resto de Inicio (✅ `parseFiltroInicio`).
- Reemplaza la parte «Mis pendientes» que ya cubre (revisadas, decisiones, tareas); los recurrentes de FINANZAS y los PRs
  sin registrar (✅ `prSinRegistrar`) siguen en «Mis pendientes».

## 7. Llamadas a GitHub y costo de carga (criterio 4)

| Capa | Llamadas nuevas por carga | Por qué |
| --- | --- | --- |
| Hoy y Semana | Cero | Solo la hoja que /planificacion ya lee |
| Esperando por ti | Cero | Reusa las listas de PRs de Inicio (✅ caché `DASHBOARD_CACHE_SECONDS`) y REVISADA de la hoja |
| Flujo | Las de /ordenes para los dictámenes de las órdenes abiertas con PR | Reusa `dictamenDeOrden` y su caché (✅ la misma de /ordenes y /agentes), con el tope `LLAMADAS_AGENTES` y `LIMITE_GLOBAL_MS` de /agentes; lo que no cupo queda `sin-datos` y se lee en la carga siguiente |

Regla de construcción: una prueba cuenta las llamadas del doble de GitHub con caché fría (no pasan del tope) y con caché
caliente (cero).

## 8. Fases propuestas para órdenes futuras (criterio 5)

Para registrar como BORRADOR; no se crean desde esta orden.

| Fase | Contenido | Riesgo | Sensible | Por qué |
| --- | --- | --- | --- | --- |
| F1 | Regla de lenguaje (`etiqueta`, §2) y capa **Hoy** (§3), reusando `CompleteTaskForm` | BAJO | NO | Solo lectura de la hoja; el único botón ya existe y su guard del servidor no cambia. Prueba: sin `puedeCerrarTareas` no se pinta el botón |
| F2 | Capa **Semana** (§5) | BAJO | NO | Solo lectura de lo que `planWeek` ya calcula |
| F3 | Bloque **Esperando por ti** (§6) con 6.1, 6.3 y 6.5; 6.2 y 6.4 en `apagada` con su motivo | BAJO | NO | Solo lectura, cero llamadas nuevas, sin variables |
| F4 | Capa **Flujo** (§4) de Borrador a Fusionada; Desplegada y Activada en `apagada` | MEDIO | NO | Suma lecturas de GitHub a /planificacion: hay que probar el tope de llamadas y la caché compartida (§7). Sin escritura |
| F5 | Fuentes de **Desplegada** y **Activada**: el commit de la revisión activa y el registro orden → bandera; enciende 6.2 y 6.4 | MEDIO | SÍ | Toca la configuración de despliegue o el esquema de la hoja (§9, pregunta 2) y muestra estado de banderas: requiere SEGUNDO (DEC-POS-019). Si toca `deploy.sh` o la configuración de Cloud Run, esa parte es de activación del propietario (carril ALTO, DEC-POS-014) |

Orden sugerido: F1 → F2 → F3 en cualquier orden entre ellas; F4 después de F1 (usa `etiqueta`); F5 al final y solo con la
pregunta 2 resuelta. Cada fase con `npm test`, `npm run lint` y `npm run typecheck` en `web/`, y
`python -m unittest discover -s tests`.

## 9. Preguntas abiertas para el propietario

1. **6.1 con PR_ABIERTO.** ¿Basta con REVISADA (cero llamadas) o se quiere también el PR_ABIERTO con CONFORME aún sin
   marcar? Lo segundo lee dictámenes desde Inicio y lo vuelve MEDIO por el costo de llamadas.
2. **Fuente de «Desplegada».** Dos caminos: (a) `deploy.sh` pasa el commit al contenedor como variable y el servidor lo
   lee (cambio de despliegue, solo del propietario); (b) una pestaña nueva `DESPLIEGUES` (revisión, commit, fecha) que
   registra el PM tras cada despliegue, con migración explícita y una operación nueva en la API (amplía DEC-POS-005). La
   (a) no depende de nadie después de desplegar; la (b) deja historia. **Recomendación:** (a).
3. **Registro orden → bandera.** ¿Columna nueva `BANDERA` al final de ORDENES_CODEX (migración explícita) o lista fija
   en el código junto a cada `*Habilitado`? La columna permite órdenes futuras sin tocar código.

## 10. Datos que nunca van al repositorio

Los bocetos usan nombres, IDs y horas de ejemplo; no son datos de la hoja. Sin correos, tokens ni IDs de libros. Las
pruebas de F1 a F5 usan datos sintéticos.
