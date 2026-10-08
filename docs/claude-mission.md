# Misión siguiente para Claude Code — PROJECT-OS

**Objetivo:** revisar la V1 inicial, implementar la integración segura y un dashboard web sencillo sin cambiar los sistemas fuente.

**Inputs:** estructura y scripts de este repositorio; Google Sheets maestro enlazado en README.

**Entregables:**
1. Auditoría técnica del colector, fechas, paginación, errores e idempotencia.
2. Diccionario de datos validado contra las 16 pestañas.
3. Backend autenticado para leer/editar registros mediante Sheets API.
4. Interfaz de proyectos, tareas, presupuesto semanal y plan diario.
5. Pruebas, README de despliegue y mecanismos de recuperación.

**Restricciones:** no almacenar secretos en frontend; no exponer la hoja pública; no editar datos sin permisos y auditoría; no crear una segunda base de tareas; no modificar otros repositorios; no habilitar la ejecución automática sin aprobación.

**Aceptación:** operaciones de lectura y escritura verificadas, cambios con auditoría, cero duplicados tras sincronizar dos veces, y dashboard utilizable en móvil y escritorio.
