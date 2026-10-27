# Prueba Gemini contra Fable — protocolo

Orden ORD-POS-098 (tarea POS-030, paquete PAQ-2026-10-25-03). Fecha: 2026-10-26. Riesgo MEDIO: fija la instalación y los
permisos de una app de terceros sobre los repositorios ([carril ALTO, DEC-POS-014](delegacion-codex.md#política-de-revisión-por-riesgo-dec-pos-003)).

**Pregunta.** ¿Puede Gemini Code Assist (app de GitHub) reemplazar al segundo revisor de MEDIO, hoy Fable 5.1
(DEC-POS-008, [operación](operacion.md#roles-y-modelos))? Este documento mide y, desde ORD-POS-099 (DEC-POS-022), también
fija la transición: los hallazgos de Gemini los verifica y firma una sesión de Claude con la skill
[`supervisar-gemini`](../.claude/skills/supervisar-gemini/SKILL.md) (dictamen `SEGUNDO` de origen `gemini-supervisado`).
El comentario de Gemini solo nunca es dictamen. No cambia workflows ni la app; el retiro de Fable (§8) lo decide el
propietario.

Marcas: lo que depende de la app o de la documentación de Google y no pude verificar aquí va como **hipótesis**; el
propietario lo confirma en la pantalla de instalación y lo anota en §2.4.

## 1. Antecedente

Prueba manual del 2026-10-26 con el [PR #192](https://github.com/jlpulido107-bit/PROJECT-OS/pull/192) (ORD-POS-078),
Gemini solo con el diff:

- Veredicto CAMBIOS. Encontró el H1 de Fable (`agentes-data.ts:50`, unas 170 a 200 llamadas a GitHub) y lo calificó ALTA.
- H2 a medias; no vio H3 (corte silencioso a 500 PRs, `github.ts:322-336`); sin falsos positivos.
- Fable costó 6.96 USD en ese PR.

No cuenta en la muestra de §4: se hizo a mano, fuera de la app y sin las condiciones de §3. Va como fila 0 de la tabla.

## 2. Instalación, permisos y desinstalación (solo el propietario)

Ningún agente instala, configura ni desinstala la app, ni escribe comandos `/gemini` en GitHub.

### 2.1 Antes de instalar: apagar la revisión automática

Si Gemini comenta al abrirse un PR de orden, el primer revisor y el delta leen su comentario (leen los comentarios del
PR, [`revisar-orden`](../.claude/skills/revisar-orden/SKILL.md) paso 4) y se rompe la revisión a ciegas. Por eso, **antes**
de instalar, el propietario fusiona en `main` de cada repositorio (PROJECT-OS, SIGSAH y RADAROS) un archivo
`.gemini/config.yaml` que apaga todo lo automático al abrir un PR:

```yaml
# Prueba Gemini (docs/prueba-gemini.md de PROJECT-OS): Gemini solo responde a /gemini review del propietario.
have_fun: false
code_review:
  disable: false
  comment_severity_threshold: LOW
  max_review_comments: -1
  pull_request_opened:
    help: false
    summary: false
    code_review: false
```

**Hipótesis:** los nombres de las claves son los de la documentación de Gemini Code Assist en GitHub; si la versión
instalada usa otros, el propietario los ajusta para el mismo efecto (nada al abrir el PR) y lo anota en §2.4. Comprobación:
abrir un PR de prueba sin `[ORD-` en el título; si Gemini comenta sin que nadie lo pida, desinstalar (§2.5) y avisar.

### 2.2 Instalar

1. En GitHub, abrir la app **Gemini Code Assist** de Google en el Marketplace e iniciar la instalación en la cuenta
   `jlpulido107-bit`.
2. En «Repository access» elegir **Only select repositories** y marcar solo `PROJECT-OS`, `SIGSAH` y `RADAROS`. Nunca
   «All repositories»: NOTAS y cualquier otro repositorio quedan fuera.
3. Revisar los permisos que pide la app (§2.3) **antes** de aceptar. Si pide algo de la lista «nunca», cancelar.
4. Completar el alta en la página de Google (cuenta de Google del propietario y términos). Leer qué hace Google con el
   código revisado; si los términos permiten usarlo para entrenar y el propietario no lo acepta, cancelar.
5. Anotar en §2.4 la fecha, los permisos que mostró GitHub y la versión de los términos.

### 2.3 Permisos mínimos

Una app de GitHub pide un juego fijo de permisos: el propietario solo elige los repositorios. La prueba necesita:

| Necesita | Para qué |
| --- | --- |
| Metadatos: lectura | Obligatorio en toda app |
| Contenido (código): lectura | Leer el diff y el código del PR |
| Pull requests: lectura y escritura | Leer el PR sombra y publicar su revisión |
| Issues: lectura y escritura | Comentarios del PR (GitHub los trata como issues) y responder a `/gemini review` |

**Hipótesis:** la app puede pedir además checks o estados de commit; se aceptan solo en lectura o para publicar su
propio check, y se anotan. **Nunca** se instala si pide: administración, workflows, secretos, variables, entornos,
Actions en escritura, despliegues, páginas, miembros u organización, webhooks, o acceso a todos los repositorios.

### 2.4 Registro de la instalación (lo llena el propietario)

| Campo | Valor |
| --- | --- |
| Fecha de instalación | |
| Repositorios | PROJECT-OS, SIGSAH, RADAROS |
| Permisos mostrados por GitHub | |
| `.gemini/config.yaml` fusionado en los 3 (PR de cada uno) | |
| Comprobación de §2.1 (sin comentario automático) | |
| Términos de datos leídos (fecha) | |

### 2.5 Desinstalar

Al cerrar la prueba (§5), salvo que la decisión de §6 diga lo contrario, o en cuanto algo falle:

1. GitHub → Settings → Applications → **Installed GitHub Apps** → Gemini Code Assist → Configure → **Uninstall**.
2. GitHub → Settings → Applications → **Authorized GitHub Apps**: revocar Gemini Code Assist si aparece.
3. En la cuenta de Google, quitar el acceso de GitHub a Gemini Code Assist si quedó vinculado.
4. Borrar las ramas `prueba-gemini/*` que queden y retirar `.gemini/config.yaml` de los 3 repositorios con un PR en cada uno.
5. Comprobar en «Installed GitHub Apps» que ya no aparece y anotar la fecha en §5.

## 3. Cómo corre la prueba en cada PR (a ciegas)

Entran los PRs de órdenes **MEDIO sensibles** de los 3 repositorios que piden `SEGUNDO` dentro de la ventana (§5).
Gemini revisa **el mismo head** que Fable, pero en un **PR sombra**: así ningún revisor del flujo normal (primero, delta,
Fable, corrector) lo ve, ni antes ni después de su dictamen. Solo lo lee el supervisor de
[`supervisar-gemini`](../.claude/skills/supervisar-gemini/SKILL.md), que es a su vez un `SEGUNDO` a ciegas.

1. El flujo normal corre sin cambios: primer revisor, correcciones, delta y `SEGUNDO` de Fable
   ([política](delegacion-codex.md#política-de-revisión-por-riesgo-dec-pos-003)).
2. Cuando /ordenes muestra «Falta segundo revisor» sobre el head `H` (ya hay `CONFORME` de `PRIMERO` o `DELTA`; no hace
   falta esperar a Fable), el propietario crea la rama `prueba-gemini/pr-<N>-<H7>`
   apuntando a `H` (`<N>` el número del PR de la orden, `<H7>` los 7 primeros caracteres de `H`) y abre con ella un PR
   sombra contra la misma base:
   - título `[PRUEBA-GEMINI] PR #<N> @ <H7>`, **sin** `[ORD-` ni el ID de la orden (lo detectarían /ordenes y las
     rutinas como PR de la orden);
   - descripción vacía y sin `Closes` (el PR de la orden tampoco da su descripción al revisor);
   - comenta `/gemini review` y espera la revisión.
3. Con la revisión de Gemini publicada, el propietario lanza **en paralelo** al supervisor y a Fable sobre el mismo `H`:
   - Fable, con **Lanzar segundo revisor** en /ordenes, como siempre;
   - el supervisor, en una sesión de POS · Ingeniería con un modelo que no sea Opus (Sonnet), pegando los datos de
     entrada del `SEGUNDO` (`ORDEN_ID`, `REPOSITORIO`, `PR`, `HEAD_ESPERADO`, `ROL` `SEGUNDO`, `REVISION_ID` y
     `EJECUCION_ID` con un `n` distinto del de Fable, `INTENTO`, `RONDA`, `LIMITE_CONSUMO`, `AUTORIZACION`) y «supervisa
     Gemini, modo medición». El supervisor publica su dictamen en el **PR sombra**, nunca en el de la orden.
4. El propietario copia a la tabla de §4 los hallazgos de Gemini, la línea «Medición:» del supervisor y los de Fable;
   después cierra el PR sombra **sin fusionar** y borra la rama.
5. Si Fable vuelve a dictaminar en un head nuevo del mismo PR, se repite con ese head y se añade otra fila.

**Quién comenta `/gemini review`.** Hoy, y durante toda la ventana, solo el propietario: crea la rama y el PR sombra y
comenta. Pasarlo al PM exige una decisión nueva que amplíe DEC-POS-005 y DEC-POS-011 (el PM hoy solo escribe por la API
del dashboard): que el PM pueda crear la rama `prueba-gemini/*`, abrir y cerrar el PR sombra y comentar `/gemini review`,
y nada más en GitHub. Sin esa decisión, ningún agente lo hace (§7).

Por qué así: el PR sombra nunca es el `PR` que recibe una sesión revisora, así que su comentario no entra a ningún
dictamen; Gemini ve lo mismo que Fable (diff y código del head, sin la descripción); y nadie comenta en el PR de la orden.

## 4. Tabla por PR (la llena el propietario)

Cada hallazgo lleva un ID corto por revisor (G1, G2… de Gemini; F1, F2… de Fable). Dos hallazgos **coinciden** si señalan
el mismo defecto (misma causa, aunque cambie la línea). Un hallazgo es **real** solo si lo confirma un commit de
corrección (se cita) o el propietario (se cita el comentario o la fecha); **falso positivo** si el propietario lo
descarta; **pendiente** mientras no hay ni lo uno ni lo otro. Costo de Fable: consumo equivalente a precio de API de su
sesión `SEGUNDO`, del [`reporte-consumo`](../.claude/skills/reporte-consumo/SKILL.md); costo de Gemini: lo que cobre la
app (**hipótesis:** 0 USD en la versión gratuita; el propietario lo confirma en §2.4).

Las columnas del supervisor salen de la línea «Medición:» de su dictamen en el PR sombra
([`supervisar-gemini`](../.claude/skills/supervisar-gemini/SKILL.md#medición-va-en-el-texto-del-comentario-fuera-del-json));
su costo, de `reporte-consumo` (rol «Segundo revisor gemini-supervisado»).

| # | PR @ head | Riesgo | Hallazgos de Gemini (sev.) | Confirmados por el supervisor | Bloqueantes que agregó el supervisor | Hallazgos de Fable (sev.) | Coinciden | Reales (fuente) | Falsos positivos | Reales que faltaron a Gemini + supervisor | Reales que faltaron a Fable | Costo Gemini | Costo supervisor | Costo Fable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | [#192](https://github.com/jlpulido107-bit/PROJECT-OS/pull/192) (antecedente, fuera de la muestra) | MEDIO | G1 = F1 (ALTA); G2 ≈ F2 a medias | — (sin supervisor) | — | F1 `agentes-data.ts:50`; F2; F3 `github.ts:322-336` | F1, F2 a medias | Pendiente: **hipótesis**, la corrección vivió en ORD-POS-080 ([#194](https://github.com/jlpulido107-bit/PROJECT-OS/pull/194)) | Gemini 0 | F3 | — | Manual, sin dato | — | 6.96 USD |
| 1 | | | | | | | | | | | | | | |

Por fila, también se anota si el supervisor y Fable coinciden en el veredicto (CONFORME o CAMBIOS) y si un hallazgo
real que bloqueaba según Fable les faltó a Gemini y al supervisor juntos: esa falta es la que más pesa en §6 y §8. Si
Gemini no dejó ningún hallazgo, no hay dictamen gemini-supervisado (el contrato exige al menos uno): la fila lo anota.

## 5. Ventana y cierre

- Ventana de **1 semana** (ORD-POS-099): del **2026-10-27** al **2026-11-02**, con la app ya instalada y §2.1
  comprobado el 2026-10-26. Sustituye el cierre del 2026-11-09 de ORD-POS-098; solo el propietario mueve la fecha y lo
  anota aquí.
- Al cerrar: llenar la plantilla de §6 y aplicar §8. Se desinstala (§2.5) solo si el propietario elige C.
- Muestra mínima para decidir: **hipótesis** de 5 filas (sin contar la 0); con menos, el resultado es «insuficiente» y
  Fable sigue (opción D).

| Campo | Valor |
| --- | --- |
| Fecha de cierre real | |
| Desinstalada (fecha) | |

## 6. Plantilla del resultado (para decidir)

```text
RESULTADO PRUEBA GEMINI CONTRA FABLE — ORD-POS-098
Ventana: <inicio> a <cierre>. PRs en la muestra: <n> (filas <a>-<b> de §4).
Hallazgos reales en total: <r>.
  Gemini encontró: <g> de <r> (<g/r> %); bloqueantes reales encontrados: <gb> de <rb>.
  Gemini + supervisor: <s> de <r>; bloqueantes reales: <sb> de <rb>; confirmados <c>, descartados <d>, agregados <a>.
  Fable encontró: <f> de <r> (<f/r> %); bloqueantes reales encontrados: <fb> de <rb>.
  Reales que solo vio Gemini: <lista>. Reales que solo vio Fable: <lista>.
Falsos positivos: Gemini <fpg>; Fable <fpf>.
Veredicto coincidente (CONFORME/CAMBIOS): <c> de <n>.
Costo: Gemini <total> USD (<por PR>); supervisor <total> USD (<por PR>); Fable <total> USD (<por PR>).
Incidentes: <comentarios automáticos, permisos, fallas; o «ninguno»>.
Opción propuesta (la decide el propietario):
  A. Retirar a Fable el 2026-11-03: el SEGUNDO de MEDIO sensible pasa a gemini-supervisado (DEC-POS-022; §8).
  B. Mantener a Fable y dejar Gemini como señal informativa con PR sombra (requiere decisión; nunca cuenta como dictamen).
  C. Mantener a Fable y desinstalar Gemini.
  D. Resultado insuficiente: ampliar la ventana hasta <fecha>.
Motivo: <una o dos líneas>.
```

Guía para leerlo (no decide): A solo tiene sentido si a Gemini y al supervisor juntos no les faltó ningún bloqueante real
que Fable sí vio y los falsos positivos no crecen; si no, el ahorro de costo no compensa un defecto que llega a fusión.

## 7. Reglas durante la prueba

- **El comentario de Gemini nunca es un dictamen.** No lleva la marca `<!-- project-os:dictamen-revisor -->` ni el JSON
  que valida `validarReporte` ([`revisar-orden`](../.claude/skills/revisar-orden/SKILL.md)), así que no cuenta para
  REVISADA (DEC-POS-011 exige CONFORME de `PRIMERO` o `DELTA` y, en MEDIO sensible, de `SEGUNDO`), ni para fusionar, ni
  para el límite de rondas. Lo que cuenta, solo con la bandera encendida (§8), es el dictamen del supervisor.
- **El corrector no lo usa fuera del flujo normal.** [`corregir-pr`](../.claude/skills/corregir-pr/SKILL.md) solo
  acepta un comentario del propietario o un dictamen marcado del revisor; un comentario de Gemini se rechaza. Si el
  propietario quiere corregir algo que vio Gemini, lo escribe él mismo como comentario en el issue o el PR de la orden y
  lanza la corrección como cualquier otra; desde ahí el hallazgo es del propietario y la fila lo anota.
- Ninguna sesión de Claude abre, cierra ni comenta los PRs sombra, ni escribe `/gemini`. Única excepción: el
  supervisor de [`supervisar-gemini`](../.claude/skills/supervisar-gemini/SKILL.md) lee solo lo que publicó la app de
  Gemini en el PR sombra de su head y, en modo medición, publica ahí su dictamen. Primer revisor, delta, Fable y
  corrector nunca lo leen.
- Gemini no entra a NOTAS ni a otros repositorios, y nunca recibe la descripción del PR de la orden.
- Si Gemini comenta en un PR de orden (por ejemplo, por un `config.yaml` mal aplicado), ese PR sale de la muestra, el
  propietario lo anota en §6 como incidente y aplica §2.5 si se repite.

## 8. Transición y retiro de Fable (2026-11-03)

Recomendación del PM; **la decisión es del propietario**.

**Condiciones, todas a la vez.** Fable se retira como `SEGUNDO` de MEDIO sensible el **2026-11-03** solo si:
1. el propietario encendió `SEGUNDO_GEMINI_SUPERVISADO=on` con `deploy.sh` ([escritura §6](escritura-v1-8.md)); ningún
   agente la enciende ni lo pide;
2. la tabla de §4 de la ventana no muestra **ningún bloqueante real que Gemini y el supervisor no vieron** (y Fable sí);
3. la muestra no es «insuficiente» (§5) y el propietario eligió A en §6.

Si falta cualquiera, Fable sigue como hoy y nada cambia. **Hipótesis:** DEC-POS-021 y DEC-POS-022, aprobadas por el
propietario, cubren el cambio de DEC-POS-008 que pedía la opción A; si no, el propietario registra la enmienda en
DECISIONES antes de retirar a Fable.

**Activación (solo el propietario).**
1. Crear en claude.ai/code → Routines la rutina `PROJECT-OS · supervisar Gemini` (disparador de API, sin horario,
   modelo Sonnet, nunca Opus) con estas instrucciones: «sigue `.claude/skills/supervisar-gemini/SKILL.md` en modo
   operación».
2. Apuntar el botón **Lanzar segundo revisor** a esa rutina: exportar `CLAUDE_ROUTINE_SEGUNDO_ID` y
   `SECRET_VERSION_CLAUDE_ROUTINE_SEGUNDO` con los de la rutina nueva y desplegar con `deploy.sh --desde-activa`
   ([rutina de Claude](rutina-claude.md#botones-revisar-y-corregir-en-ordenes-ord-pos-037)), junto con la bandera.
3. La rutina de Fable **no se borra**: queda configurada, sin botón, para volver.
4. Desde ahí, por cada MEDIO sensible: el propietario abre el PR sombra y comenta `/gemini review` (§3, paso 2) **antes**
   de pulsar **Lanzar segundo revisor**; sin PR sombra con revisión de Gemini, el supervisor termina sin dictamen.

**Plan para volver a Fable.** Se vuelve si: un bloqueante real que el supervisor no vio llega a fusión o lo descubre
otra revisión; Gemini no revisa un PR sombra en 24 h o deja de responder a `/gemini review`; Gemini comenta en un PR de
orden; o el propietario lo decide. Pasos (solo el propietario):
1. `deploy.sh --desde-activa --quitar SEGUNDO_GEMINI_SUPERVISADO`, con `CLAUDE_ROUTINE_SEGUNDO_ID` y
   `SECRET_VERSION_CLAUDE_ROUTINE_SEGUNDO` de nuevo los de la rutina de Fable.
2. Con la bandera apagada, /ordenes deja de contar los `SEGUNDO` gemini-supervisado: los PRs que dependían de uno vuelven a
   «Falta segundo revisor» y se lanzan con Fable.
3. Anotar en §4 la fila que lo motivó y, si aplica, desinstalar (§2.5).
