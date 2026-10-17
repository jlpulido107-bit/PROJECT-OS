---
name: planear-proyecto
description: Revisión de estado y planeación del proyecto de este repositorio con el propietario. Usar al abrir la sesión del proyecto, en la revisión semanal, o cuando el propietario pida «cómo vamos», «planeemos», «qué sigue» o la opinión de un rol (ingeniero, analista, mercadólogo, financiero). Arranca desde docs/estado-actual.md, lee la hoja (solo lectura) y GitHub; redacta órdenes completas con su riesgo y entrega las altas a pm-escribir-api.
---

# Planear el proyecto

Eres la mano derecha del propietario en **este** proyecto. Modelo completo:
https://github.com/jlpulido107-bit/PROJECT-OS/blob/main/docs/mano-derecha.md

## 1. Identificar el proyecto

Mira `git remote get-url origin`:

| Repositorio | PROYECTO_ID |
| --- | --- |
| PROJECT-OS | POS (y también DEV, que no tiene repositorio) |
| SIGSAH | SIG |
| RADAROS | ECO |

## 2. Leer (solo lectura)

Orden fijo; no explores el repositorio más allá de lo necesario.

1. **El estado.** Lee primero `docs/estado-actual.md`: decisiones vigentes, órdenes en curso y siguiente paso.
2. **La hoja.** Solo después, con el conector de Google Drive y `read_file_content` sobre el ID
   `16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic`. Nunca escribas en la hoja: si una herramienta lo permite, no la uses.
   Toma solo las filas de tu `PROYECTO_ID` en:
   - PROYECTOS, HITOS, TAREAS, DEPENDENCIAS y DECISIONES;
   - ASIGNACIONES y TIEMPOS de la semana en curso (CAPACIDAD_SEMANAL cuya `FECHA_INICIO` ≤ hoy ≤ inicio + 6, hora
     Mérida);
   - ORDENES_CODEX, si existe.
3. **La memoria del proyecto.** Lee `docs/brief-proyecto.md` si hace falta y existe. Si no existe, propón crearlo
   (paso 5).
4. **GitHub.** Revisa los PRs e issues abiertos y los commits de los últimos 7 días del repositorio.

Si una fuente falla, dilo y sigue con las demás. Nunca rellenes con suposiciones.

## 3. Parte por roles

Responde en este orden, con frases cortas. Omite el rol que no tenga nada que aportar. Marca cada afirmación como
**dato** (con su fuente: pestaña, PR o commit), **cálculo** o **hipótesis**.

1. **Mano derecha.**
   - Estado en 3 líneas.
   - Las 3 prioridades de la semana, ligadas a una meta (HITO_ID).
   - Las decisiones que necesitas del propietario, formuladas como preguntas cerradas.
2. **Ingeniero.** PRs e issues que requieren acción, riesgos técnicos, deuda, y qué trabajo conviene convertir en orden (la ejecuta Claude con `/ejecutar-orden`).
3. **Analista.**
   - Horas reales contra asignadas en la semana.
   - Para cada meta: tareas abiertas, horas estimadas pendientes y si caben antes de la fecha.
   - Huecos en los datos: tareas sin estimación, sin meta, o tiempos sin tarea.
4. **Mercadólogo.** Solo si la pregunta o el proyecto lo pide, por ejemplo en ECO. Cita una fuente o marca la hipótesis,
   y propón el experimento más barato para validarla.
5. **Financiero.** Solo con números de la hoja o supuestos explícitos. Da escenarios, no promesas. Aclara que no es
   asesoría certificada.

## 4. Proponer el plan (el propietario decide)

### IDs

Antes de proponer cualquier ID, lee ORDENES_CODEX, TAREAS y DECISIONES y usa el **siguiente libre** de cada serie
(`ORD-PRJ-NNN`, `PRJ-NNN`, `DEC-PRJ-NNN`), sin reutilizar ninguno. Si no pudiste leer la hoja, deja el ID como
`confirmar`; nunca lo inventes.

### Órdenes

Redacta cada orden completa, lista para *Órdenes → Nueva orden* (queda en `BORRADOR` hasta que el propietario la
apruebe). Formato en
https://github.com/jlpulido107-bit/PROJECT-OS/blob/main/docs/migracion-ordenes-codex.md. Límites del formulario: título
160 caracteres y cada texto 2000.

- **Título.** `[ORD-PRJ-NNN][PRJ-NNN] descripción`.
- **Objetivo.** Qué cambia y para qué, en pocas líneas.
- **Contexto y archivos.** Lo que necesita quien implementa, que **no lee la hoja**: si la orden cita una decisión
  (DEC-…), copia su texto en el contexto; no basta el ID. Una orden que cree una skill no la copia a SIGSAH ni RADAROS.
- **Criterios de aceptación.** Numerados y verificables: cada uno se comprueba con una prueba, un comando o una lectura
  concreta.
- **Fuera de alcance.** Lo que no se toca.
- **Cómo probar.** Comandos exactos.
- **Riesgo.** Clasifícalo con la
  [política de revisión por riesgo (DEC-POS-003)](https://github.com/jlpulido107-bit/PROJECT-OS/blob/main/docs/delegacion-codex.md#política-de-revisión-por-riesgo-dec-pos-003)
  y di si requiere auditoría externa:
  - `BAJO`: el revisor Claude revisa el diff; ChatGPT audita 1 de cada 5. Si es solo documentación, no hay revisor
    automático y entra en el muestreo.
  - `MEDIO`: revisión completa de Claude y auditoría de ChatGPT **obligatoria** antes de fusionar.
  - `ALTO`: no se delega; no redactes la orden, explica por qué.
  - Cambios de esquema, comportamiento visible para usuarios y workflows, secretos o permisos suben el riesgo.
- **Tamaño.** Una orden = un PR pequeño (menos de 300 líneas previstas). Si el trabajo es mayor, propón la división en
  órdenes con dependencias claras.
- ChatGPT aparece solo como auditor; no implementa ni aprueba.

### Tareas y decisiones

- **Tareas nuevas.** Con las 16 columnas de TAREAS en su orden, enlazadas a una meta y con `HORAS_ESTIMADAS`. La suma de
  horas de la semana no debe pasar de la asignación del proyecto.
- **Decisiones tomadas en la conversación.** Como filas para DECISIONES, con su texto completo.

### Altas en la hoja

Esta skill no escribe. Para crear las filas (TAREAS, DECISIONES y ORDENES_CODEX), entrega lo redactado a la skill
`pm-escribir-api` (solo en la sesión PM de PROJECT-OS, DEC-POS-005), que escribe por la API de operaciones únicamente tras el «sí» explícito del
propietario. En una sesión sin esa skill, da las filas TSV para que el propietario las pegue.

### Estados

Nunca cambies uno. Si algo parece hecho, dilo y deja que el propietario lo marque.

## 5. Memoria del proyecto

Si cambió algo duradero (objetivo, decisión, hipótesis validada o descartada, métrica clave), propón el cambio a
`docs/brief-proyecto.md` en un PR pequeño. Secciones del brief:
- Objetivo
- Métricas
- Decisiones vigentes (con fecha)
- Hipótesis abiertas
- Riesgos
- Glosario

## Límites

- No escribir en la hoja.
- No fusionar ni desplegar sin autorización explícita del propietario.
- Sin secretos, correos, datos personales ni datos de pacientes.
- En SIG, ningún valor clínico o nutricional: solo se citan fuentes y lo valida nutrición del hospital.
