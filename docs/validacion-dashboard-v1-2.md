# Validación manual — Dashboard V1.2 (OAuth real + Sheets real)

**Estado:** pendiente de ejecución por el usuario. Requisito de la revisión del PR #4 antes de solicitar merge.
**Regla:** no copiar en este documento, en Git ni en chats ningún secreto, token, JSON de credenciales ni correo
personal. Registrar solo resultados (✅/❌), conteos y fechas.

## 1. Preparación (una sola vez, fuera del repositorio)

1. **Cuenta de servicio dedicada de solo lectura** (recomendado): créala en Google Cloud, habilita Google Sheets API
   y comparte la hoja con su correo como **Lector**. No reutilices la clave JSON de V1.1 ni la reenvíes por chat.
2. Guarda la clave en tu equipo fuera del repo (por ejemplo `~/.config/project-os/dashboard-sa.json`, permisos `600`).
3. Crea el cliente OAuth (*Aplicación web*) con la redirección `http://localhost:3000/api/auth/callback/google`
   y agrega tu correo como usuario de prueba en la pantalla de consentimiento.
4. En `web/.env.local` (ignorado por Git): `DASHBOARD_DATA_SOURCE=sheets`, `SHEETS_SPREADSHEET_ID`,
   `PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_FILE`, `NEXTAUTH_URL=http://localhost:3000`, `NEXTAUTH_SECRET`,
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AUTH_ALLOWED_EMAILS` (solo tu correo).
5. Comprueba que nada de eso quedó en Git: `git status --short` no debe listar `.env.local` ni archivos `.json` de claves.

## 2. Antes de abrir el panel: línea base de "sin escrituras"

Anota el número de filas con datos de cada pestaña y la hora de la última edición en
*Archivo → Historial de versiones* de la hoja.

| Pestaña | Filas antes | Filas después |
| --- | --- | --- |
| PROYECTOS | | |
| TAREAS | | |
| EVIDENCIAS | | |
| SYNC_RUNS | | |
| AUDITORIA | | |

## 3. Pruebas

```bash
cd web && npm ci && npm run build && npm start   # http://localhost:3000
```

| # | Prueba | Esperado | Resultado |
| --- | --- | --- | --- |
| 1 | Abrir `/` sin sesión | Redirige a `/login` sin mostrar datos | |
| 2 | Iniciar sesión con el correo **permitido** | Entra al Inicio ejecutivo | |
| 3 | Cerrar sesión e iniciar con **otra** cuenta de Google | Mensaje "Esta cuenta no está autorizada"; no ve datos | |
| 4 | Abrir `/api/resumen` en una ventana privada sin sesión | `401 {"error":"No autenticado"}` | |
| 5 | Franja superior | Dice "Leído de Google Sheets" (no "Datos sintéticos") | |
| 6 | Diagnóstico de datos (al final del Inicio) | 12/12 pestañas válidas | |
| 7 | Proyectos registrados | 4 (SIG, ECO, DEV, POS) | |
| 8 | Tareas abiertas | Igual a la hoja (2 al 2026-10-09) | |
| 9 | Bloqueos | Igual a la hoja (0 al 2026-10-09) | |
| 10 | Tiempo real registrado | "Sin registros" mientras `TIEMPOS` esté vacía | |
| 11 | Última sincronización | Coincide con la fila más reciente de `SYNC_RUNS` (ID, estado, registros) | |
| 12 | Actividad | Número total = filas de `EVIDENCIAS`; los commits GitHub aparecen como "Evento observado" | |
| 13 | Tareas → filtro *Solo bloqueadas* y por proyecto | Resultados coherentes con la hoja | |
| 14 | Móvil (teléfono o modo responsive del navegador) | Navegación usable, sin desplazamiento horizontal | |
| 15 | "Actualizar datos" | Cambia la hora de lectura; no modifica la hoja | |

## 4. Después: confirmar ausencia de escrituras

1. Repite el conteo de filas de la sección 2: deben ser idénticos.
2. *Historial de versiones*: no debe haber ediciones nuevas, en particular ninguna de la cuenta de servicio.
3. Opcional: en Google Cloud → *Registros*, las llamadas de la cuenta de servicio a Sheets API son solo lecturas
   (`spreadsheets.get`, `spreadsheets.values.batchGet`).

## 5. Registro de evidencia (sin secretos)

- Fecha y hora (Mérida):
- Commit probado (`git rev-parse --short HEAD`):
- Resultado: __/15 pruebas correctas
- Observaciones / discrepancias:

Capturas, si se agregan, solo con datos no sensibles; recortar correos personales.
