# Guía de operación — PROJECT-OS

Una página para saber quién hace qué, en qué entorno y cómo fluye una orden de punta a punta. No cambia reglas ni
decisiones: resume las vigentes y enlaza su fuente. Fecha: 2026-10-23. Si algo aquí contradice la fuente, manda la fuente.

## Roles y modelos

| Rol | Quién | Modelo | Fuente |
| --- | --- | --- | --- |
| Propietario | Aprueba órdenes; fusiona, despliega y cierra | — | [`AGENTS.md`](../AGENTS.md), DEC-POS-002 |
| PM | Planea, redacta borradores y delega; único escritor de la hoja, por la API | Claude | DEC-POS-005, DEC-POS-007; [`pm-escribir-api`](../.claude/skills/pm-escribir-api/SKILL.md) |
| Implementador | Ejecuta la orden aprobada: rama → PR con la CI en verde | Opus | Orden ORD-POS-047; [estado actual](estado-actual.md) |
| Primer revisor | Revisa a ciegas (orden, diff y contrato, sin la descripción del PR) | Sonnet | DEC-POS-008; [delegación](delegacion-codex.md#política-de-revisión-por-riesgo-dec-pos-003) |
| Segundo revisor | Solo en MEDIO sensible, a ciegas y sin el dictamen del primero | Fable 5.1; desde el 2026-11-03, si el propietario lo activa, Sonnet supervisando a Gemini (nunca Opus) | DEC-POS-008, DEC-POS-019, DEC-POS-022; [delegación](delegacion-codex.md#medio-sensible-y-segundo-gemini-supervisado); [`supervisar-gemini`](../.claude/skills/supervisar-gemini/SKILL.md) |
| Corrector | Corrige en el mismo PR, máximo 2 rondas por orden | Opus | DEC-POS-003, DEC-POS-008; [`corregir-pr`](../.claude/skills/corregir-pr/SKILL.md) |
| Tiempos | **Condicionado a la aprobación de DEC-POS-024** (PENDIENTE). Lunes: propone `HORAS_ESTIMADAS`, `FECHA_PLAN` e `HITO_ID`, cierres probables con evidencia y vencidas por reprogramar, en un paquete PAQ al PM (solo esos tres campos, escritos por el PM con el «sí PAQ» verificado; nunca cierra ni cancela); diario: plan del día de `/planificacion`; viernes: lo planeado contra `TIEMPOS`. Nunca escribe en Sheets ni cambia `ESTADO` o `BLOQUEO`; `CAPACIDAD_SEMANAL` e hitos son del propietario; sin rutina programada | Claude | DEC-POS-024 (PENDIENTE); ORD-POS-107; [`planear-tiempo`](../.claude/skills/planear-tiempo/SKILL.md) |
| Agente de finanzas | Por corte (días 15 y fin de mes): rendimiento de `reporte-consumo` y, con el total de factura que da el propietario, el cargo extra o el cierre «sin cargo», solo por `POST /api/finanzas/agente/…` con su token. Nunca estima, edita, borra ni registra la suscripción; inerte hasta que el propietario lo active ([/finanzas v3 §8.2](diseno-finanzas-v3.md#82-activación-solo-el-propietario-tras-aprobar-dec-pos-018-fusionar-y-desplegar-f-3)) | Claude | DEC-POS-018 (PENDIENTE); ORD-POS-092; [diseño v3](diseno-finanzas-v3.md) |

Cada función corre en una sesión separada; el revisor nunca es la sesión que implementó y usa otro modelo (DEC-POS-002,
[`AGENTS.md`](../AGENTS.md)). Sin auditor externo: ChatGPT ya no participa (DEC-POS-008).

## Entornos

| Entorno | Qué corre ahí | Qué nunca corre ahí | Fuente |
| --- | --- | --- | --- |
| POS · Ingeniería | Implementar, revisar y corregir (las 4 rutinas) | Escritura en la hoja: no tiene el secreto de red de la API ni usa el conector de Sheets | Orden ORD-POS-047; [`AGENTS.md`](../AGENTS.md) |
| POS · PM | Solo el escritor PM, por la API: altas con [`scripts/pm-alta.sh`](../scripts/pm-alta.sh), edición de campos permitidos de tareas y, con el «sí» citado y fechado del propietario, aprobar y enviar órdenes BAJO o MEDIO con [`scripts/pm-transicion.sh`](../scripts/pm-transicion.sh); marcar REVISADA solo con dictamen CONFORME de PRIMERO o DELTA y, en MEDIO sensible, también SEGUNDO de otro modelo en el mismo head (DEC-POS-019; gemini-supervisado según DEC-POS-022, solo si el propietario encendió `SEGUNDO_GEMINI_SUPERVISADO`); registrar el PR detectado (ENVIADA → PR_ABIERTO) solo si el propietario encendió `PM_PUEDE_REGISTRAR_PR` (ORD-POS-063) | Implementar, revisar o corregir; cancelar o cerrar órdenes; cualquier transición de una orden ALTO; cambiar `ESTADO` o `BLOQUEO` de tareas | DEC-POS-005, DEC-POS-011 (ORD-POS-055, 057 y 059); [`AGENTS.md`](../AGENTS.md); [`pm-escribir-api`](../.claude/skills/pm-escribir-api/SKILL.md) |
| POS · Ideas | Conversar las ideas con el propietario y entregar paquetes `PAQ-AAAA-MM-DD-NN` al PM, cada uno terminado en «Responde sí PAQ-… para autorizar las altas»; abrir PRs en NOTAS **solo cuando el propietario lo pide** ([`revisar-ideas`](../.claude/skills/revisar-ideas/SKILL.md)) | Leer `privado/` de NOTAS; push a `main` de NOTAS, salvo la escritura directa limitada en `_contexto/`, `*/contexto.md`, `*/referencia/` y la sección `## Referencia` de los `indice.md` ([notas](notas.md#escritura-directa-limitada-pos--ideas)); escribir en la hoja; tomar un «sí PAQ» por algo más que altas: nunca aprueba, envía, cancela ni cierra | Orden ORD-POS-056 y ORD-POS-060 (DEC-POS-013); [notas](notas.md) |
| Cloud Shell del propietario | Despliegue, rutinas, tokens y secretos | Nada que lance Claude: Claude solo da el script | [`deploy.sh`](../web/deploy/cloudrun/deploy.sh) (cabecera) |

El token de la API lo añade el proxy del entorno POS · PM; nadie lo lee, imprime ni pide
([`pm-escribir-api`](../.claude/skills/pm-escribir-api/SKILL.md#token)).

Regla de permiso en POS · PM (la añade el propietario; ORD-POS-062): además de `Bash(bash scripts/pm-alta.sh:*)`, para
que el escritor apruebe, envíe y marque REVISADA sin un `curl` a mano, permite `Bash(bash scripts/pm-transicion.sh:*)`.
El script solo hace `PATCH` a `/api/operaciones/ordenes/<ORD-PRY-NNN>` con `APROBAR`, `ENVIAR` o `REVISAR`
([`scripts/pm-transicion.sh`](../scripts/pm-transicion.sh)).

## Las 4 rutinas y su disparo

Todas son rutinas de Claude Code con disparador de API y **sin horario**; las dispara el dashboard con datos validados,
nunca texto libre. Fuente: [rutina de Claude](rutina-claude.md).

| Rutina | Se dispara | Hace | Skill |
| --- | --- | --- | --- |
| Ejecutar orden | Al pulsar **Aprobar y crear el issue** en `/ordenes` (una sola vez) | Valida el issue y abre el PR | [`ejecutar-orden`](../.claude/skills/ejecutar-orden/SKILL.md) |
| Revisar (Sonnet) | Botón **Lanzar revisión** (primera revisión o delta tras corrección) | Dictamen a ciegas | [`revisar-orden`](../.claude/skills/revisar-orden/SKILL.md) |
| Segundo revisor (Fable 5.1) | Botón **Lanzar segundo revisor** (solo MEDIO sensible) | Dictamen a ciegas, sin el del primero | [`revisar-orden`](../.claude/skills/revisar-orden/SKILL.md) |
| Corregir PR | Botón **Pedir corrección** (dictamen `CAMBIOS`, ronda menor que 2) | Commit nuevo en la misma rama del PR | [`corregir-pr`](../.claude/skills/corregir-pr/SKILL.md) |

**Supervisor de Gemini (ORD-POS-099).** Del 2026-10-27 al 2026-11-02 no es rutina: el propietario abre el PR sombra,
comenta `/gemini review` y lanza una sesión de POS · Ingeniería (Sonnet) con los datos del `SEGUNDO` y «supervisa Gemini,
modo medición»; publica en el PR sombra y no cuenta. Desde el 2026-11-03, solo si el propietario lo activa, **Lanzar
segundo revisor** apunta a la rutina nueva `PROJECT-OS · supervisar Gemini` (modo operación) y la de Fable queda
configurada para volver ([prueba Gemini §3 y §8](prueba-gemini.md#8-transición-y-retiro-de-fable-2026-11-03)). Comentar
`/gemini review` es del propietario; pasarlo al PM exige una decisión que amplíe DEC-POS-005 y DEC-POS-011.

En `/ordenes` aparece un solo botón según el dictamen del PR; nunca con riesgo ALTO ni si el head cambió desde que cargó
la página. Los botones de revisión y corrección solo aparecen cuando el propietario crea esas rutinas y sus secretos
(ORD-POS-037, [rutina de Claude](rutina-claude.md#botones-revisar-y-corregir-en-ordenes-ord-pos-037)). Plan B si la
llamada falla: **Ejecutar con Claude** o **Copiar para Claude** ([delegación](delegacion-codex.md#ciclo)).

## Flujo de una orden por riesgo

Común a todas: el PM redacta el borrador → el propietario lo aprueba en `/ordenes` (`ENVIADA` + issue `[ORD-…]`) →
la rutina de ejecución abre el PR → **Registrar el PR detectado** (`PR_ABIERTO`) → revisión según el riesgo → el
propietario decide. Fuente: [delegación](delegacion-codex.md#ciclo) y la
[política por riesgo](delegacion-codex.md#política-de-revisión-por-riesgo-dec-pos-003) (DEC-POS-003, DEC-POS-008).

| Riesgo | Revisión | Botones en `/ordenes` tras el PR |
| --- | --- | --- |
| BAJO | Un revisor Claude a ciegas, con modelo distinto al que implementó | **Lanzar revisión** → si `CAMBIOS`, **Pedir corrección** → **Lanzar revisión** (delta); hasta 2 rondas |
| BAJO solo docs | Sin revisor automático | Ninguno: decide el propietario con el PR |
| MEDIO | Sonnet completo; re-revisión del delta tras cada corrección; si es sensible (`SENSIBLE` vacía o `SI`), Fable 5.1 o un SEGUNDO gemini-supervisado antes de fusionar (DEC-POS-019, DEC-POS-022) | **Lanzar revisión** → **Pedir corrección** ↔ **Lanzar revisión** (delta), máx. 2 rondas → si es sensible, **Lanzar segundo revisor**; luego escala al propietario |
| ALTO | No se delega tal cual: se descompone en una orden MEDIO de código inerte por defecto (sigue la fila MEDIO) más la activación del propietario; si no se puede, en vivo con el propietario y registrado en DECISIONES ([carril ALTO](delegacion-codex.md#política-de-revisión-por-riesgo-dec-pos-003), DEC-POS-014) | Ninguno para la fila ALTO |

Ningún dictamen autoriza fusión, despliegue ni cierre, y un PR fusionado no cierra la tarea por sí solo
([delegación](delegacion-codex.md#ciclo)).

## Despliegue

Lo corre solo el propietario, en Cloud Shell, con
[`web/deploy/cloudrun/deploy.sh --desde-activa`](../web/deploy/cloudrun/deploy.sh): toma las variables de la revisión
activa, deja prevalecer lo exportado (p. ej. `IMAGE` con el digest nuevo), compara solo los nombres de variables, pide
que escriba «desplegar» y aplica. `--dry-run` muestra la comparación sin aplicar. Conserva las variables de las rutinas
([rutina de Claude](rutina-claude.md#botones-revisar-y-corregir-en-ordenes-ord-pos-037);
[despliegue privado](despliegue-privado-v1-3.md)). Claude da el script; nunca lo ejecuta
([delegación](delegacion-codex.md#ciclo)).

### Cuándo se despliega (DEC-POS-017, APROBADA)

**DEC-POS-017 está APROBADA y vigente** (aprobada por el propietario el 2026-10-23; fuente: orden ORD-POS-073, issue #178). Texto de la decisión (paquete
PAQ-2026-10-23-03), tal como lo dio el PM en el [issue #174](https://github.com/jlpulido107-bit/PROJECT-OS/issues/174):

1. El propietario despliega en menos de 24 horas cuando: (a) se fusiona una orden que desbloquea una capacidad (permisos
   del PM, vistas nuevas); o (b) se acumulan 5 o más órdenes fusionadas sin desplegar; o (c) pasan 7 días sin desplegar
   (red de seguridad).
2. Tras cada fusión, el PM prepara la nota de despliegue: qué entra, qué probar y cómo revertir.
3. Desplegar sigue siendo solo del propietario.

Justificación: hay órdenes fusionadas que llevan días sin desplegar, entre ellas capacidades como ORD-POS-063
(REGISTRAR_PR del PM) y /eco (ORD-POS-067); desplegar en lotes chicos y con nota reduce el riesgo y la espera.
Responsable: propietario.

### Nota de despliegue

La redacta el PM tras cada fusión (DEC-POS-017, punto 2) y la deja como comentario en el PR fusionado o en el issue de
la orden; no escribe en la hoja ni despliega. Formato:

```text
Nota de despliegue · AAAA-MM-DD
Revisión activa (antes): project-os-dashboard-NNNNN-xxx (fuente: <issue o PR donde consta>)
Disparador (DEC-POS-017): (a) capacidad <cuál> | (b) N órdenes sin desplegar | (c) 7 días sin desplegar
Órdenes incluidas: ORD-POS-NNN (PR #N, fusionado AAAA-MM-DD), …
Riesgos: por orden, qué cambia para el usuario o el PM; variables o banderas nuevas que debe exportar el propietario
  (solo el nombre, nunca el valor); qué queda inerte hasta que el propietario lo active.
Pruebas de humo tras deploy.sh --desde-activa:
  1. desde web/: npm run smoke:remote -- --url "$SERVICE_URL"  (esperado: /api/health 200, privadas 307 o 401)
  2. con sesión: la página o acción de cada orden incluida, una por una
  3. Cloud Run → Registros: sin tokens, correos ni datos
Cómo revertir a la revisión anterior (sin reconstruir):
  gcloud run revisions list --service "$SERVICE_NAME" --region "$REGION"
  gcloud run services update-traffic "$SERVICE_NAME" --region "$REGION" --to-revisions=<REVISION_ANTERIOR>=100
```

Las pruebas de humo y la reversión son las del [runbook de despliegue](despliegue-privado-v1-3.md) (§6 «Rollback»);
las corre solo el propietario.

Dónde consta la revisión desplegada: la fuente con autoridad es la revisión activa del servicio de Cloud Run, que solo
consulta el propietario (`deploy.sh --desde-activa` parte de ella). En el repositorio queda la que el propietario registra
en el issue o PR del despliegue (p. ej. 00022 en el [issue #134](https://github.com/jlpulido107-bit/PROJECT-OS/issues/134)),
copiada a [estado actual](estado-actual.md) con [`cerrar-orden`](../.claude/skills/cerrar-orden/SKILL.md).

## Qué hace solo el propietario

Fuente: [`AGENTS.md`](../AGENTS.md), DEC-POS-002, DEC-POS-005, DEC-POS-008, DEC-POS-011, DEC-POS-013 y DEC-POS-014.

- Cancelar y cerrar órdenes; aprobar o enviar órdenes de riesgo ALTO; decidir las decisiones; cambiar `ESTADO` o
  `BLOQUEO` de tareas en la hoja.
- Dar el «sí» literal a cada escritura del PM (vale dado al PM y reenviado al escritor, DEC-POS-008). Con ese «sí»,
  citado con la orden y su fecha, el PM aprueba y envía órdenes BAJO o MEDIO, y marca REVISADA solo con dictamen
  CONFORME de PRIMERO o DELTA y, en MEDIO sensible, también SEGUNDO de otro modelo en el mismo head (DEC-POS-019; gemini-supervisado según DEC-POS-022) (DEC-POS-011, ORD-POS-057).
- O dar el «sí PAQ-AAAA-MM-DD-NN» en POS · Ideas (DEC-POS-013, enmienda de DEC-POS-008): autoriza solo las altas de
  ese paquete, después de que el PM lo verifica en la fuente; aprobar, enviar, cancelar y cerrar no cambian
  ([`pm-escribir-api`](../.claude/skills/pm-escribir-api/SKILL.md#altas-con-sí-paq-dec-pos-013)).
- Fusionar PRs, desplegar y cerrar tareas e issues.
- Aplicar la activación del carril ALTO (DEC-POS-014): correr el script que enciende el mecanismo inerte (desplegar,
  encender la bandera en producción, crear o montar secretos). Ningún agente la aplica. Ejemplo: `PM_PUEDE_REGISTRAR_PR`
  (ORD-POS-063), que deja al PM registrar el PR detectado, la enciende solo el propietario con `deploy.sh`, después de
  registrar la decisión que amplía DEC-POS-011 ([`escritura-v1-8.md` §6](escritura-v1-8.md)).
- Crear las rutinas, sus tokens y los secretos; cambiar `.github/workflows`, permisos, IAM o configuración de GCP.
- Habilitar cualquier ejecución con horario (`schedule`), tras aprobar una prueba real.
