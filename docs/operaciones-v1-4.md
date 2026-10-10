# PROJECT-OS V1.4 — Operaciones: guía de uso y runbook de activación

> Estado de este PR: la escritura funciona **solo en modo simulado** (`mock`), en memoria y con datos sintéticos.
> **No escribe en Google Sheets**, no configura credenciales de escritura y no despliega nada. El contrato técnico
> está en [`v1-4-write-contract.md`](v1-4-write-contract.md).

## 1. Qué se puede hacer

| Operación | Pantalla | API | Resultado |
| --- | --- | --- | --- |
| Crear tarea | `/tareas/nueva` (o "Nueva tarea" en `/tareas` y en cada proyecto) | `POST /api/operaciones/tareas` | `{PROY}-NNN`, estado `PENDIENTE`, versión 1 |
| Editar tarea | "Editar" en la tarjeta de la tarea → `/tareas/{id}/editar` | `PATCH /api/operaciones/tareas/{id}` | Versión +1 |
| Registrar tiempo | "Registrar tiempo" en la tarjeta o `/tiempos/nuevo` | `POST /api/operaciones/tiempos` | `SES-AAAAMMDD-xxxxxxxx` |
| Registrar decisión | "Registrar decisión" en el proyecto o `/decisiones/nueva` | `POST /api/operaciones/decisiones` | `DEC-{PROY}-NNN`, estado `PENDIENTE` |
| Revisar auditoría y conciliación | `/operaciones` (solo escritores) | — | Operaciones auditadas e intenciones sin efecto |

**No se puede**, por diseño:

- completar ni cancelar tareas: requiere aprobación humana fuera del panel;
- editar tareas cerradas;
- aprobar decisiones;
- borrar registros;
- cambiar IDs, `VERSION`, `ACTUALIZADO_EN` ni el proyecto de una tarea.

### Uso desde el celular

Todas las pantallas funcionan a 390 px de ancho, sin desplazamiento horizontal. Los formularios:

- muestran el error junto a cada campo, con `aria-invalid` y descripción accesible;
- desactivan el botón mientras guardan;
- al terminar, enlazan al registro creado.

Si aparece **"conflicto de versión"**, alguien cambió la tarea mientras la editabas: pulsa **"Recargar la versión
actual"** y vuelve a aplicar tu cambio.

Si aparece **"escritura fallida"** o **"sin conexión"**, pulsa de nuevo **Guardar** sin modificar nada: se reutiliza
la misma solicitud y **no se duplica**.

## 2. Roles

- **Lector** (`AUTH_ALLOWED_EMAILS`): ve todo y no ve botones de escritura. Si llama a las APIs, recibe 403.
- **Escritor**: debe estar en `AUTH_ALLOWED_EMAILS` **y** en `AUTH_WRITER_EMAILS`. Solo escribe si
  `PROJECT_OS_WRITE_MODE` está activo.
- Por defecto (`PROJECT_OS_WRITE_MODE=disabled`, `AUTH_WRITER_EMAILS` vacío) **nadie escribe**.

## 3. Probar en local (modo simulado)

En `web/.env.local`, que nunca se sube al repositorio:

```bash
DASHBOARD_DATA_SOURCE=fixtures
PROJECT_OS_WRITE_MODE=mock
AUTH_ALLOWED_EMAILS=tu-correo@example.com
AUTH_WRITER_EMAILS=tu-correo@example.com
```

Después ejecuta `cd web && npm run dev`. Verás el aviso **"Modo simulado"** en cada formulario y "escritura simulada"
bajo el nombre del panel. Lo que registres vive en la memoria del servidor y **se pierde al reiniciar**.

El modo `mock` se rechaza automáticamente, quedando la escritura deshabilitada, si:

- `DASHBOARD_DATA_SOURCE` no es `fixtures`, porque nunca se mezclan datos simulados con los reales;
- el proceso corre en Cloud Run (`K_SERVICE` definido).

Pruebas automáticas, sin red ni Google Sheets:

```bash
cd web
npm test                # unitarias, de contrato (mock vs adaptador Sheets simulado) y de seguridad
npm run build
npm run test:e2e:ops    # HTTP E2E: permisos, CSRF, límites, idempotencia, conflictos, auditoría
```

## 4. Runbook de activación en Sheets (NO ejecutado; requiere aprobación)

En V1.4, `PROJECT_OS_WRITE_MODE=sheets` está **bloqueado en el código**: la escritura queda deshabilitada aunque se
configure. Activarlo requiere un PR posterior aprobado. Para ese PR se propone este orden; ningún paso se ha
ejecutado.

### 4.1 Prerrequisitos (decisión del usuario)

1. Elegir la opción de credencial (ver "Decisiones pendientes" del PR):
   - **(a) recomendada:** suplantación de una cuenta de servicio de escritura;
   - (b) un servicio de escritura separado.
2. Confirmar los estados permitidos de `TAREAS` (`EN_PROGRESO` y `BLOQUEADO` no existen hoy en los datos reales) y
   la prioridad `BAJA`.
3. Confirmar el formato ISO con hora de `ACTUALIZADO_EN` y el uso de `ORIGEN` en `AUDITORIA` para el `requestId`.
4. Hacer una copia de seguridad de la hoja: Archivo → Hacer una copia, o el historial de versiones con un nombre
   como "antes de V1.4".

### 4.2 Credencial (opción a)

1. Crear una cuenta de servicio **dedicada** solo a escritura, distinta de la del lector y de la de V1.1.
2. Compartir **solo el spreadsheet maestro** con esa cuenta como **Editor**. No darle roles en el proyecto GCP ni
   acceso a Drive.
3. Conceder a la cuenta de runtime de Cloud Run `roles/iam.serviceAccountTokenCreator` **solo sobre** la cuenta de
   escritura.
4. Usar el token con alcance `https://www.googleapis.com/auth/spreadsheets`, nunca `drive`.
5. Ninguna clave JSON en el repositorio, en CI ni en logs.

### 4.3 Código (PR futuro)

1. Conectar `SheetsTableStore` (`web/src/lib/operations/sheets-table-store.ts`) en `runtime.ts` con un proveedor de
   tokens de la credencial de escritura.
2. Quitar el bloqueo de `sheets` en `config.ts`.
3. Mantener `maxScale: 1`, que convierte al panel en escritor único (ver contrato, §6).
4. Actualizar las pruebas de seguridad que hoy exigen que el adaptador no se importe.

### 4.4 Prueba real controlada

1. Desplegar con `PROJECT_OS_WRITE_MODE=sheets` y **un solo** correo en `AUTH_WRITER_EMAILS`.
2. Crear **una** tarea de prueba en un proyecto acordado y comprobar en la hoja:
   - la fila en `TAREAS`, versión 1;
   - las filas en `AUDITORIA`, una por campo, con `ORIGEN` `dashboard-v1.4;modo=sheets;…`.
3. Editar esa tarea, cambiando la prioridad, y comprobar que `VERSION` pasa a 2 y que la auditoría queda con los
   valores antes y después.
4. Registrar 1 tiempo y 1 decisión de prueba.
5. Abrir `/operaciones`: la conciliación debe decir **"Sin pendientes"**.
6. Revisar los logs de Cloud Run: solo códigos y `requestId`, sin correos ni contenido.

### 4.5 Reversión

1. Poner `PROJECT_OS_WRITE_MODE=disabled` (o vaciar `AUTH_WRITER_EMAILS`) y desplegar una revisión nueva: las
   escrituras se detienen al instante y la lectura sigue funcionando.
2. Quitar el acceso Editor de la cuenta de escritura en la hoja.
3. Corregir los datos de prueba **a mano** usando `AUDITORIA` como guía: el panel no borra registros. Las filas de
   auditoría no se borran.

## 5. Aceptación manual (pendiente, en modo simulado)

- [ ] Con un lector: no aparecen "Nueva tarea", "Editar", "Registrar tiempo" ni "Operaciones".
- [ ] Con un escritor en `mock`: crear una tarea, editarla a Bloqueado (pide motivo), registrar tiempo y decisión.
- [ ] El panel muestra los cambios marcados como simulados y `/operaciones` dice "Sin pendientes".
- [ ] Abrir la edición de la misma tarea en dos pestañas y guardar en ambas: la segunda recibe un conflicto de versión.
- [ ] Reiniciar el servidor: los datos simulados desaparecen.
- [ ] Sin variables V1.4 (valores por defecto): no hay ninguna escritura posible.
