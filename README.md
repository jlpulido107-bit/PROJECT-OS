# PROJECT-OS — Centro de Dirección

**Estado:** V1 en revisión. No se han activado sincronizaciones ni informes programados.

## Objetivo
Dirigir proyectos técnicos y no técnicos mediante metas, hitos, capacidad semanal flexible, evidencia y decisiones verificables.

## Tablero operativo
[PROJECT-OS V1 — Google Sheets](https://docs.google.com/spreadsheets/d/16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic/edit)

## Fuentes de verdad
- **Google Sheets:** proyectos, hitos, tareas, planes, tiempos y decisiones.
- **Repositorios GitHub:** código, PRs, issues y commits de cada proyecto.
- **Este repositorio:** código de coordinación, configuraciones, evidencias derivadas e informes diarios.
- **ChatGPT:** análisis, propuestas de metas y revisión.
- **Claude Code:** implementación técnica a partir de misiones aprobadas.
- **Usuario:** prioridad, aprobación y decisión final.

## Alcance de esta entrega
- Configuración de proyectos iniciales.
- Colector de evidencias técnicas de GitHub (solo lectura).
- Informe Markdown/JSON de actividad, sin confundir commits con metas cumplidas.
- GitHub Action **solo manual** hasta aprobar la automatización.
- Pruebas unitarias, documentación y misión de desarrollo para Claude Code.

## Aún pendiente
- Integración segura para escribir evidencias en Google Sheets.
- Dashboard web autenticado y sincronizado.
- Captura de avances no técnicos mediante dashboard.
- Conciliación de commits/PRs con IDs de tareas.
- Planificación inteligente con revisión y aprobación humana.
- Activar la ejecución diaria después de una prueba real.

## Ejecución local
```bash
python -m unittest discover -s tests -v
export GH_READ_TOKEN="TOKEN_DE_LECTURA"
python src/collect_activity.py
```

También puede indicarse `REPORT_DATE=YYYY-MM-DD` para reconstruir un informe de un día. No publicar tokens.

## Despliegue
1. Revisar y aprobar este pull request. No fusionar antes de revisar los permisos.
2. Crear secret `PROJECT_OS_GH_READ_TOKEN` de alcance mínimo, solo lectura sobre repositorios fuente.
3. Ejecutar una prueba manual de Actions.
4. Verificar informes y cobertura; después decidir si se activa un calendario diario.

## Seguridad
No copiar datos de pacientes, clientes, credenciales, tokens ni información financiera privada. Nunca cerrar tareas por el solo hecho de tener un commit y nunca desplegar en los repositorios fuente desde PROJECT-OS.
