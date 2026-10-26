# Prueba Gemini contra Fable — protocolo

Orden ORD-POS-098 (tarea POS-030, paquete PAQ-2026-10-25-03). Fecha: 2026-10-26. Riesgo MEDIO: fija la instalación y los
permisos de una app de terceros sobre los repositorios ([carril ALTO, DEC-POS-014](delegacion-codex.md#política-de-revisión-por-riesgo-dec-pos-003)).

**Pregunta.** ¿Puede Gemini Code Assist (app de GitHub) reemplazar al segundo revisor de MEDIO, hoy Fable 5.1
(DEC-POS-008, [operación](operacion.md#roles-y-modelos))? Este documento solo mide; no cambia DEC-POS-008, rutinas, skills
ni workflows. Reemplazar al revisor exige una decisión nueva del propietario (§6).

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

Entran los PRs de órdenes **MEDIO** de los 3 repositorios que reciben dictamen `SEGUNDO` de Fable dentro de la ventana
(§5). Gemini revisa **el mismo head** que Fable, pero en un **PR sombra**: así ningún revisor Claude lo ve, ni antes ni
después de su dictamen.

1. El flujo normal corre sin cambios: primer revisor, correcciones, delta y `SEGUNDO` de Fable
   ([política](delegacion-codex.md#política-de-revisión-por-riesgo-dec-pos-003)).
2. Cuando Fable publica su dictamen `SEGUNDO` sobre el head `H`, el propietario crea la rama `prueba-gemini/pr-<N>-<H7>`
   apuntando a `H` (`<N>` el número del PR de la orden, `<H7>` los 7 primeros caracteres de `H`) y abre con ella un PR
   sombra contra la misma base:
   - título `[PRUEBA-GEMINI] PR #<N> @ <H7>`, **sin** `[ORD-` ni el ID de la orden (lo detectarían /ordenes y las
     rutinas como PR de la orden);
   - descripción vacía y sin `Closes` (el PR de la orden tampoco da su descripción al revisor);
   - comenta `/gemini review` y espera la revisión.
3. El propietario copia los hallazgos de Gemini a la tabla de §4, cierra el PR sombra **sin fusionar** y borra la rama.
4. Si Fable vuelve a dictaminar en un head nuevo del mismo PR, se repite con ese head y se añade otra fila.

Por qué así: el PR sombra nunca es el `PR` que recibe una sesión revisora, así que su comentario no entra a ningún
dictamen; Gemini ve lo mismo que Fable (diff y código del head, sin la descripción); y nadie comenta en el PR de la orden.

## 4. Tabla por PR (la llena el propietario)

Cada hallazgo lleva un ID corto por revisor (G1, G2… de Gemini; F1, F2… de Fable). Dos hallazgos **coinciden** si señalan
el mismo defecto (misma causa, aunque cambie la línea). Un hallazgo es **real** solo si lo confirma un commit de
corrección (se cita) o el propietario (se cita el comentario o la fecha); **falso positivo** si el propietario lo
descarta; **pendiente** mientras no hay ni lo uno ni lo otro. Costo de Fable: consumo equivalente a precio de API de su
sesión `SEGUNDO`, del [`reporte-consumo`](../.claude/skills/reporte-consumo/SKILL.md); costo de Gemini: lo que cobre la
app (**hipótesis:** 0 USD en la versión gratuita; el propietario lo confirma en §2.4).

| # | PR @ head | Riesgo | Hallazgos de Gemini (sev.) | Hallazgos de Fable (sev.) | Coinciden | Reales (fuente) | Falsos positivos | Reales que faltaron a Gemini | Reales que faltaron a Fable | Costo Gemini | Costo Fable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | [#192](https://github.com/jlpulido107-bit/PROJECT-OS/pull/192) (antecedente, fuera de la muestra) | MEDIO | G1 = F1 (ALTA); G2 ≈ F2 a medias | F1 `agentes-data.ts:50`; F2; F3 `github.ts:322-336` | F1, F2 a medias | Pendiente: **hipótesis**, la corrección vivió en ORD-POS-080 ([#194](https://github.com/jlpulido107-bit/PROJECT-OS/pull/194)) | Gemini 0 | F3 | — | Manual, sin dato | 6.96 USD |
| 1 | | | | | | | | | | | |

Por fila, también se anota si Gemini y Fable coinciden en el veredicto (CONFORME o CAMBIOS) y si un hallazgo que
bloqueaba según Fable le faltó a Gemini: esa falta es la que más pesa en §6.

## 5. Ventana y cierre

- Inicio: el día que se completa §2.4. Cierre: **2026-11-09** (2 semanas desde esta orden), aunque la instalación se
  retrase; solo el propietario mueve la fecha y lo anota aquí.
- Al cerrar: desinstalar (§2.5), salvo que la decisión de §6 diga otra cosa, y llenar la plantilla de §6.
- Muestra mínima para decidir: **hipótesis** de 5 filas (sin contar la 0); con menos, el resultado es «insuficiente».

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
  Fable encontró: <f> de <r> (<f/r> %); bloqueantes reales encontrados: <fb> de <rb>.
  Reales que solo vio Gemini: <lista>. Reales que solo vio Fable: <lista>.
Falsos positivos: Gemini <fpg>; Fable <fpf>.
Veredicto coincidente (CONFORME/CAMBIOS): <c> de <n>.
Costo: Gemini <total> USD (<por PR>); Fable <total> USD (<por PR>).
Incidentes: <comentarios automáticos, permisos, fallas; o «ninguno»>.
Opción propuesta (la decide el propietario):
  A. Reemplazar a Fable por Gemini como segundo revisor de MEDIO (requiere una decisión que enmiende DEC-POS-008).
  B. Mantener a Fable y dejar Gemini como señal informativa con PR sombra (requiere decisión; nunca cuenta como dictamen).
  C. Mantener a Fable y desinstalar Gemini.
  D. Resultado insuficiente: ampliar la ventana hasta <fecha>.
Motivo: <una o dos líneas>.
```

Guía para leerlo (no decide): A solo tiene sentido si a Gemini no le faltó ningún bloqueante real que Fable sí vio y sus
falsos positivos no crecen; si no, el ahorro de costo no compensa un defecto que llega a fusión.

## 7. Reglas durante la prueba

- **El comentario de Gemini nunca es un dictamen.** No lleva la marca `<!-- project-os:dictamen-revisor -->` ni el JSON
  que valida `validarReporte` ([`revisar-orden`](../.claude/skills/revisar-orden/SKILL.md)), así que no cuenta para
  REVISADA (DEC-POS-011 exige CONFORME de `PRIMERO` o `DELTA` y, en MEDIO, de `SEGUNDO`), ni para fusionar, ni para el
  límite de rondas.
- **El corrector no lo usa fuera del flujo normal.** [`corregir-pr`](../.claude/skills/corregir-pr/SKILL.md) solo
  acepta un comentario del propietario o un dictamen marcado del revisor; un comentario de Gemini se rechaza. Si el
  propietario quiere corregir algo que vio Gemini, lo escribe él mismo como comentario en el issue o el PR de la orden y
  lanza la corrección como cualquier otra; desde ahí el hallazgo es del propietario y la fila lo anota.
- Ninguna sesión de Claude abre, lee ni comenta los PRs sombra, ni escribe `/gemini`.
- Gemini no entra a NOTAS ni a otros repositorios, y nunca recibe la descripción del PR de la orden.
- Si Gemini comenta en un PR de orden (por ejemplo, por un `config.yaml` mal aplicado), ese PR sale de la muestra, el
  propietario lo anota en §6 como incidente y aplica §2.5 si se repite.
