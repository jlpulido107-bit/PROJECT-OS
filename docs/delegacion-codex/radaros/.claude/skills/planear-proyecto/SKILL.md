---
name: planear-proyecto
description: Revisión de estado y planeación del proyecto de este repositorio con el propietario. Usar al abrir la sesión del proyecto, en la revisión semanal, o cuando el propietario pida «cómo vamos», «planeemos», «qué sigue» o la opinión de un rol (ingeniero, analista, mercadólogo, financiero). Lee la hoja (solo lectura) y GitHub; propone filas para TAREAS y ORDENES_CODEX que pega el propietario.
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

1. **La hoja.** Usa el conector de Google Drive con `read_file_content` y el ID
   `16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic`. Nunca escribas en la hoja: si una herramienta lo permite, no la uses.
   Toma solo las filas de tu `PROYECTO_ID` en:
   - PROYECTOS, HITOS, TAREAS, DEPENDENCIAS y DECISIONES;
   - ASIGNACIONES y TIEMPOS de la semana en curso (CAPACIDAD_SEMANAL cuya `FECHA_INICIO` ≤ hoy ≤ inicio + 6, hora
     Mérida);
   - ORDENES_CODEX, si existe.
2. **La memoria del proyecto.** Lee `docs/brief-proyecto.md` si existe. Si no existe, propón crearlo (paso 5).
3. **GitHub.** Revisa los PRs e issues abiertos y los commits de los últimos 7 días del repositorio.

Si una fuente falla, dilo y sigue con las demás. Nunca rellenes con suposiciones.

## 3. Parte por roles

Responde en este orden, con frases cortas. Omite el rol que no tenga nada que aportar. Marca cada afirmación como
**dato** (con su fuente: pestaña, PR o commit), **cálculo** o **hipótesis**.

1. **Mano derecha.**
   - Estado en 3 líneas.
   - Las 3 prioridades de la semana, ligadas a una meta (HITO_ID).
   - Las decisiones que necesitas del propietario, formuladas como preguntas cerradas.
2. **Ingeniero.** PRs e issues que requieren acción, riesgos técnicos, deuda, y qué tarea conviene delegar a Codex.
3. **Analista.**
   - Horas reales contra asignadas en la semana.
   - Para cada meta: tareas abiertas, horas estimadas pendientes y si caben antes de la fecha.
   - Huecos en los datos: tareas sin estimación, sin meta, o tiempos sin tarea.
4. **Mercadólogo.** Solo si la pregunta o el proyecto lo pide, por ejemplo en ECO. Cita una fuente o marca la hipótesis,
   y propón el experimento más barato para validarla.
5. **Financiero.** Solo con números de la hoja o supuestos explícitos. Da escenarios, no promesas. Aclara que no es
   asesoría certificada.

## 4. Proponer el plan (el propietario decide)

- **Tareas nuevas.** Dalas como filas TSV listas para pegar en TAREAS, con las 16 columnas en su orden. Usa IDs nuevos
  sin reutilizar ninguno, enlázalas a una meta y ponles `HORAS_ESTIMADAS`. La suma de horas de la semana no debe pasar de
  la asignación del proyecto.
- **Trabajo delegable.** Dalo como filas TSV para ORDENES_CODEX, con `ESTADO` = `BORRADOR`; formato en
  https://github.com/jlpulido107-bit/PROJECT-OS/blob/main/docs/migracion-ordenes-codex.md. Solo riesgo `BAJO` o `MEDIO`.
- **Decisiones tomadas en la conversación.** Dalas como filas para DECISIONES.
- **Estados.** Nunca cambies uno. Si algo parece hecho, dilo y deja que el propietario lo marque.

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
