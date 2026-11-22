# Instrucciones para agentes — PROJECT-OS

## Roles
- Propietario: aprueba las órdenes y decide fusión, despliegue y cierre.
- Claude Code (DEC-POS-002, 2026-10-16; sustituye el reparto de DEC-POS-001): planea (borradores que no aprueban nada),
  implementa, revisa y corrige, cada función en una sesión separada. El revisor nunca es la sesión que implementó, usa
  otro modelo y revisa a ciegas: solo la orden, el diff y el contrato, sin la descripción del PR.
- Sin auditor externo (DEC-POS-008, 2026-10-17): el propietario canceló a ChatGPT. No se exige un agente Codex
  separado; «Codex» sobrevive solo en nombres históricos (`ORDENES_CODEX`, `docs/delegacion-codex.md`).

Ciclo: implementación y autocontrol de Claude → revisión ciega de otra sesión de Claude según el riesgo (en MEDIO, con
segundo revisor) → decisión del propietario. Las correcciones vuelven a Claude, en el mismo PR, con máximo 2 rondas.
Política por riesgo: [`docs/delegacion-codex.md`](docs/delegacion-codex.md#política-de-revisión-por-riesgo-dec-pos-003) (vigente con DEC-POS-008).
Guía de operación (roles, modelos, entornos, rutinas y flujo por riesgo en una página): [`docs/operacion.md`](docs/operacion.md).
Notas de ideas en Obsidian (repositorio NOTAS, qué leen los agentes y qué no): [`docs/notas.md`](docs/notas.md).
Un dictamen favorable no autoriza fusión, despliegue ni cierre.

## Reglas
- No escribir directamente en main; trabajar con ramas y PR.
- No fusionar ni ejecutar despliegues sin autorización.
- No modificar código de repositorios fuente desde aquí.
- Google Sheets es la fuente operativa; jamás inventar progreso. Las sesiones de implementación y de revisión no
  escriben en Sheets reales ni usan el conector de Google Sheets.
- Excepción de lectura para SIG (DEC-SIG-003, punto 1): las sesiones de SIG pueden leer con el conector, solo lectura,
  los libros de prueba y SUSULA_ENSAYO, y SUSULA V3 solo para diagnóstico. Nadie escribe en ellos con el conector.
- Escritura del PM (DEC-POS-005): solo la sesión PM (Claude) escribe, únicamente por la API de operaciones del dashboard
  (tareas, decisiones PENDIENTE y órdenes BORRADOR), con la skill `pm-escribir-api` y tras el «sí» explícito del
  propietario; nunca cancela ni cierra nada ni cambia ESTADO o BLOQUEO de tareas. DEC-POS-011 (2026-10-21): con el «sí»
  citado y su fecha puede aprobar y enviar órdenes (nunca de riesgo ALTO) y marcar REVISADA con un dictamen válido del
  head actual; CERRADA y CANCELADA siguen siendo del propietario. Nadie escribe en Sheets con el conector. Un solo escritor.
  DEC-ECO-007 amplía 005 y 011 al libro de RADAROS solo para `idea.alta` con «sí PAQ» verificado: filas nuevas de PRODUCTS (A a P) y SCORING (A a L), nunca filas existentes, fórmulas de SCORING (M en adelante) ni otras pestañas, y apagada sin `ECO_IDEAS_ALTA=true`, que pone solo el propietario.
  DEC-ECO-017 (APROBADA, 2026-11-18; ORD-POS-160) añade a `idea.alta`, con la misma bandera y el mismo «sí PAQ», una fila nueva en AMZ_IDEA_ASIN y otra en AMZ_NICHO ([escritura §9.1](docs/escritura-v1-8.md)).
  REVISADA exige CONFORME según DEC-POS-011: de PRIMERO o DELTA y, en MEDIO sensible, también SEGUNDO de otro modelo en el
  mismo head. MEDIO no sensible (columna SENSIBLE = NO) basta con PRIMERO o DELTA; vacía = sensible (DEC-POS-019). Un
  SEGUNDO gemini-supervisado (DEC-POS-022) mide «otro modelo» con el de los hallazgos (Gemini) y lo firma una sesión de
  Claude de modelo distinto del implementador; un modelo no reconocido nunca cuenta. Esa vía está apagada: solo cuenta con
  `SEGUNDO_GEMINI_SUPERVISADO=on`, que pone únicamente el propietario con `deploy.sh`; ningún agente la enciende.
  REGISTRAR_PR del PM (ORD-POS-063) está apagado: solo con `PM_PUEDE_REGISTRAR_PR=true`, que enciende únicamente el
  propietario con `deploy.sh` tras registrar la decisión que amplía DEC-POS-011, registra el PR que /ordenes detecta.
  Ningún agente enciende esa bandera.
  DEC-POS-023 (APROBADA en DECISIONES, 2026-10-29; ORD-POS-106): el propietario puede marcar una tarea COMPLETADA desde el dashboard
  con su sesión de Google, nunca con el token del PM; CANCELADA y reabrir siguen fuera del dashboard. Está apagado: solo
  con `TAREAS_CIERRE_PROPIETARIO=true` y su correo en `TAREAS_CIERRE_PROPIETARIO_EMAIL`, que pone únicamente el
  propietario con `deploy.sh` ([escritura §7](docs/escritura-v1-8.md)). Ningún agente la enciende ni cierra tareas.
  DEC-POS-013 (enmienda de DEC-POS-008): el «sí PAQ-AAAA-MM-DD-NN» que el propietario da en la sesión POS · Ideas
  autoriza solo las altas de ese paquete, y solo después de que el PM lo verifica en la fuente (`pm-escribir-api`,
  sección «Altas con sí PAQ»); aprobar, enviar, cancelar y cerrar no cambian: un «sí PAQ» nunca vale para ellos.
  DEC-POS-039 (APROBADA en DECISIONES, 2026-11-21; ORD-POS-165), amplía DEC-POS-011: el PM da de alta el modelo real
  (`configured_model` y `last_served_model` de `get_session`) de las sesiones que el dashboard lanzó para una orden, con
  la operación auditada `orden.modelo_sesion`; nunca edita ni borra esos registros. La supervisión usa ese registro y no
  el campo `modelo` del dictamen ni una constante; si falta o no cuadra, sigue «Falta segundo revisor». Está apagado:
  solo con `SUPERVISION_MODELO_SESION=true`, que pone únicamente el propietario con `deploy.sh`
  ([escritura §14](docs/escritura-v1-8.md)). Ningún agente la enciende.
- Rol Tiempos (Claude, skill `planear-tiempo`), **DEC-POS-024 APROBADA** (2026-10-28): lee la hoja
  (solo lectura) y la vista /planificacion y propone; nunca escribe en Sheets ni cambia ESTADO o BLOQUEO. Sus ediciones
  (HORAS_ESTIMADAS, FECHA_PLAN, HITO_ID) y altas de tareas van en un paquete sin ID a POS · Ideas, que le pone el PAQ;
  el PM solo las escribe con el «sí PAQ» verificado del propietario; nunca cierra ni cancela. CAPACIDAD_SEMANAL e
  HITOS los registra el propietario. Sin rutina programada hasta una prueba real aprobada.
  DEC-POS-025 (APROBADA en DECISIONES, 2026-10-29; ORD-POS-112), enmienda de DEC-POS-024: Tiempos lee
  `GET /api/planificacion` con su propio token (solo GET, distinto del del PM y del de finanzas) y el PM da de alta filas
  de TIEMPOS (`tiempo.crear`) solo con el «sí PAQ» verificado; nunca las edita ni las borra. Está apagado: solo con
  `TIEMPOS_AGENTE=true`, que pone únicamente el propietario con `deploy.sh` ([escritura §8](docs/escritura-v1-8.md)).
  Ningún agente la enciende.
- Rol Director de Marketing (Claude, skill `director-marketing`), **DEC-POS-037 APROBADA** (2026-11-19; ORD-POS-164):
  marca, identidad visual, diseño, contenido, posicionamiento y estrategia en redes, en su sesión «POS · Marketing»
  (etiqueta `rol:marketing`), donde el propietario le habla directo. Lo que se vuelva tarea, decisión u orden lo pasa
  sin ID a POS · Ideas, que arma el paquete con «sí PAQ». Nunca: escribe en hojas ni en repositorios de código; publica
  en redes ni en Amazon; gasta dinero ni firma con proveedores; usa marcas, logos o nombres de terceros como propios;
  afirma que una marca está registrada sin verificarlo. Lo que cueste dinero o salga al público lo aprueba el
  propietario. El contenido de alcohol respeta las reglas de TikTok y YouTube y la regulación mexicana, verificadas
  antes de publicar. La información de clientes externos vive en su propio espacio: no entra a este repositorio, no
  se mezcla con otros proyectos, no lleva datos personales y no se comparte fuera. Gemini o Antigravity solo generan
  bocetos, investigación y borradores con prompts del Director: no publican, no escriben en hojas ni repos ni reciben
  datos personales o confidenciales; lo generado es boceto, no arte final.
- Revisión sin «sí» por ronda, **DEC-POS-033 APROBADA** (enmienda de DEC-POS-011): lanzar PRIMERO, DELTA, SEGUNDO y
  corrector de una orden BAJO o MEDIO en PR_ABIERTO queda autorizado de forma permanente; el PM no pide «sí», siempre
  sobre el head actual y con máximo 2 rondas de corrección. El «sí» para aprobar y enviar también vale si el
  propietario lo da en POS · Ideas con el ID de la orden y la fecha, y el PM lo verifica en la fuente. No cambia:
  cancelar, cerrar, ALTO, fusionar, desplegar y banderas son solo del propietario.
- Despliegue, **DEC-POS-036 APROBADA**, corregida por **DEC-POS-040** (puntos 1 y 2): la imagen del dashboard se
  despliega con el botón, el workflow `desplegar-dashboard` de GitHub Actions; `deploy.sh` en Cloud Shell queda para
  banderas, secretos, IAM y plan B. El workflow corre solo desde `main`, en el environment `produccion` que aprueba el
  propietario, con WIF y sin llaves, y solo cambia la imagen y `DEPLOY_COMMIT_SHA`. La cuenta es
  `project-os-despliegue` y la variable `DESPLIEGUE_BOTON`. Ningún agente aprueba ni dispara el workflow, cambia
  banderas, variables, secretos, IAM o GCP, ni modifica `.github/workflows` ([guía](docs/despliegue-boton.md);
  [operación](docs/operacion.md#despliegue)).
- La Mac, **DEC-POS-034** y **DEC-POS-040** (puntos 3 a 5), APROBADAS: Antigravity y Claude Code local corren solo en
  el usuario macOS «taller», con clones de solo lectura, sin `gh` con escritura, sin `clasp` y sin la cuenta de Google
  del propietario; no escriben en hojas, NOTAS ni repositorios. `gcloud` no tiene sesión en la Mac y nunca usa la
  cuenta del propietario; `clasp` solo lo usa el propietario, por sesión. Remote Control, solo a pedido y en una
  carpeta sin credenciales. `main` está protegida desde el 2026-11-21: PR obligatorio y sin force-push en PROJECT-OS,
  SIGSAH y RADAROS; sin force-push ni borrado en NOTAS ([candados](docs/mac/candados.md);
  [operación](docs/operacion.md#entornos)).
- Lectura de encargos de Marketing, **DEC-POS-038 APROBADA** (ORD-POS-170): el Director de Marketing lee sus encargos
  con `GET /api/marketing/encargos`, solo lectura y con token propio. Está apagada: solo con
  `DIRECTOR_MKT_LECTURA=true`, que pone únicamente el propietario con `deploy.sh`
  ([escritura §15](docs/escritura-v1-8.md)). Ningún agente la enciende ni crea el token. Sin ella, sigue la puerta
  directa de DEC-POS-037.
- Modelo real de las sesiones, **DEC-POS-039 APROBADA**, en implementación (ORD-POS-165,
  [PR #367](https://github.com/jlpulido107-bit/PROJECT-OS/pull/367)): el PM registrará el modelo real de las sesiones
  de implementación y de revisión con una operación auditada de solo alta, apagada con una bandera. Hasta que se
  fusione y el propietario la encienda, no existe.
- No registrar secretos, tokens, datos clínicos ni datos personales.
- Los cambios de esquema requieren migración explícita, no cambios silenciosos.
- Reglas de estados, auditoría, concurrencia, IDs estables e idempotencia son obligatorias.
- Validar tests y diff antes de pedir revisión.
- No habilitar `schedule` hasta que el usuario apruebe una prueba real.
- El colector solo lee; no cierra tareas ni toma decisiones de negocio.

## Implementación y supervisión
- Quien implementa (Claude) crea la rama y el PR y publica los resultados en el issue y el PR. Su autocontrol (pruebas
  propias, revisión de su diff) no sustituye la revisión independiente.
- Quien revisa (otra sesión de Claude, con otro modelo) no es quien implementó: entrega su dictamen al propietario. En
  MEDIO sensible, el SEGUNDO puede ser gemini-supervisado: Gemini aporta los hallazgos y una sesión de Claude de modelo
  distinto del implementador confirma o descarta cada uno con evidencia y firma (DEC-POS-022).
  Detalle del dictamen en
  [`docs/delegacion-codex.md`](docs/delegacion-codex.md#supervisión-independiente).
- Claude se ejecuta una sola vez al aprobar la orden en el dashboard; no se pide un lanzamiento manual duplicado.

## Órdenes (desde 2026-10-14: el propietario decide, Claude ejecuta)
- Protocolo completo: [`docs/delegacion-codex.md`](docs/delegacion-codex.md). Rutina: `/ejecutar-orden`.
- Solo se ejecutan órdenes aprobadas en el dashboard (estado `ENVIADA`, con issue `[ORD-PRJ-NNN]`).
- Una orden = un PR pequeño con `[ORD-PRJ-NNN]` en el título y `Closes #N`; rama propia, nunca `main`. No fusionar ni desplegar.
- No cambiar `.github/workflows`, secretos, permisos ni configuración de GCP.
- Ejecutar `python -m unittest discover -s tests` y, si se toca `web/`, `npm test` en `web/`; pegar la salida en el PR.
- Si la tarea es ambigua o se sale del alcance: parar y explicarlo al propietario.
- Estados y reglas de las órdenes: [migración](docs/migracion-ordenes-codex.md); planeación por proyecto: [mano derecha](docs/mano-derecha.md).
