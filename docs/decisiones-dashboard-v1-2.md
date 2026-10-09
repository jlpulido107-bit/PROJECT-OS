# PROJECT-OS V1.2 — Dashboard web: decisiones técnicas

**Estado:** implementado para revisión en PR (Misión 004, issue #3). **No desplegado**: solo modo local/privado.
No modifica `src/collect_activity.py`, `src/sync_sheets.py`, workflows ni el contenido de la hoja.

## Auditoría inicial

- Encabezados de las pestañas confirmados el 2026-10-09 leyendo la hoja (solo lectura) con el conector de
  Google Drive: coinciden exactamente con el diccionario de la issue. También se leyeron `ASIGNACIONES`
  (`ASIGNACION_ID,SEMANA_ID,PROYECTO_ID,HORAS_OBJETIVO,PRIORIDAD,ACTUALIZADO_EN`) y `REGISTROS`.
- Totales esperados según la propia hoja (pestaña `DASHBOARD`) y verificados contra la lógica del panel con
  esos valores: **4 proyectos, 2 tareas abiertas, 0 bloqueos, 0 dependencias pendientes**, `TIEMPOS` sin filas,
  último `SYNC_RUNS` = `GH-SYNC-37879044030-2026-10-07` (EXITOSA, 0 registros).
  - Diferencia intencional: la hoja muestra "HORAS REGISTRADAS 0"; el panel muestra **"Sin registros"** porque
    `TIEMPOS` no tiene filas (un 0 sería engañoso).
- La lectura **vía Sheets API con la cuenta de servicio** queda pendiente de configuración (ver abajo).

## Decisiones

| Tema | Decisión | Motivo |
| --- | --- | --- |
| Framework | Next.js 16 (App Router) + TypeScript estricto, en `web/` autocontenido | Lo pide la issue; render en servidor permite que las credenciales nunca salgan del servidor. |
| Acceso a Sheets | `values:batchGet` (1 petición) + metadatos de pestañas (1 petición), `FORMATTED_VALUE` | Mínimas llamadas y cuota; pestañas ausentes no rompen toda la lectura. |
| Credencial | Cuenta de servicio vía `google-auth-library` (JWT), alcance `spreadsheets.readonly` | Aunque la cuenta de V1.1 sea Editor, el token emitido no puede escribir. |
| Escrituras | Ninguna. Cliente solo `GET`; pruebas estáticas impiden `:append`, `:batchUpdate`, etc. | V1.2 inicial es de solo lectura. |
| Autenticación | NextAuth v4 (estable, `latest` en npm) + Google OAuth; lista de correos permitidos | Solución conocida; v5 sigue en beta. Sin formularios de contraseña propios. |
| Autorización | Doble: `proxy.ts` (antes middleware) + verificación en cada página/API | Defensa en profundidad si el proxy se omitiera o mal configurara. |
| Sesión | JWT cifrado (JWE) en cookie httpOnly, 8 h máx.; lista revalidada en cada petición | Sin base de datos de sesiones (no hay segunda base de datos). |
| Caché | Memoria del proceso, 60 s (0–300), lecturas concurrentes compartidas; errores 10 s | Cuota de API; los datos se etiquetan con hora de lectura. Refresco explícito limitado a 1/10 s. |
| Esquema | Validación por nombre exacto; pestaña inválida ⇒ "no disponible" (null), nunca 0 | Evita totales falsos si alguien renombra columnas. |
| Fechas | Fecha civil sin conversión; instantes en `America/Merida`; formatos ambiguos inválidos | Evita desplazar días por UTC y confundir día/mes. |
| Volumen | Hasta 5 000 filas/pestaña (igual que V1.1) con aviso de truncamiento; paginación 25/30 en UI | Volumen actual muy inferior; evita lecturas sin límite. |
| Evidencias | Clasificación: evento observado / vinculada sin validar / tarea validada / vínculo roto | Un commit no equivale a tarea completada. |
| Estilos | CSS propio (sin Tailwind ni librerías de UI) | Menos dependencias; modo oscuro y móvil cubiertos. |
| Pruebas | Vitest 4.1.11 | Corrige GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr (tinypool) y GHSA-82fw-gwwq-j7x9 (@vitest/mocker) presentes en 3.2.7. El lockfile se generó con npm 11 porque npm 10 falla al resolver sus peers opcionales; `npm ci` con npm 10 lo instala sin problema. |

## Seguridad

- Ninguna variable `NEXT_PUBLIC_`; módulos con credenciales importan `server-only`.
- `npm run check:client-secrets` busca en `.next/static` claves PEM, JSON de cuenta de servicio, tokens `ya29.`,
  correos y los valores de las variables secretas del entorno.
- Mensajes de error de la API sin cuerpo de respuesta, tokens ni URLs con credenciales.
- Cabeceras: `Cache-Control: private, no-store`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `X-Robots-Tag: noindex`, sin `X-Powered-By`; `robots.txt` bloquea todo.
- Enlaces externos solo `http/https` sin credenciales (`javascript:` se descarta) y con `rel="noopener noreferrer"`.
- Los fixtures son sintéticos; no se versiona ninguna copia de la hoja real.

## Configuración pendiente (requiere al usuario)

1. Cliente OAuth de Google (Aplicación web) y `AUTH_ALLOWED_EMAILS` con el correo autorizado.
2. Compartir la hoja como **Lector** con la cuenta de servicio del dashboard y guardar la clave fuera del repo.
3. Ejecutar localmente con `DASHBOARD_DATA_SOURCE=sheets` siguiendo
   [`validacion-dashboard-v1-2.md`](validacion-dashboard-v1-2.md) (OAuth real, Sheets real, sin escrituras).
4. Decidir hosting antes de cualquier despliegue (requiere aprobación): por ejemplo un servicio con gestor de
   secretos e identidad de carga de trabajo para evitar claves JSON de larga duración.
5. CI de `web/`: workflow aislado `.github/workflows/web-validation.yml` (autorizado por el usuario en la revisión
   del PR #4). Ejecuta `npm ci`, lint, typecheck, Vitest, build, E2E HTTP de autorización y escaneo de secretos de
   cliente, con permisos `contents: read`, sin secretos y sin despliegue. Los workflows de V1.1 no cambian.

## Auditoría de dependencias (2026-10-09)

`npm audit --omit=dev`: **0 vulnerabilidades** en dependencias de producción (`next`, `react`, `react-dom`,
`next-auth`, `google-auth-library`, `server-only` y sus transitivas).

| Paquete | Versión | Severidad | ¿Producción? | Introducido por | Advisory | Resolución |
| --- | --- | --- | --- | --- | --- | --- |
| tinypool | 1.1.1 | crítica | No (pruebas) | vitest@3.2.7 | GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr | **Corregida**: vitest 4.1.11 ya no usa tinypool. |
| @vitest/mocker | 3.2.7 | moderada | No (pruebas) | vitest@3.2.7 | GHSA-82fw-gwwq-j7x9 | **Corregida**: @vitest/mocker 4.1.11. |
| braces (+ micromatch, fast-glob, @next/eslint-plugin-next, eslint-config-next: 5 entradas "high") | 3.0.3 | alta | No (lint) | eslint-config-next@16.3.8 → @next/eslint-plugin-next → fast-glob@3.3.1 | GHSA-vfj7-8cjw-p6xm | **Aceptada con mitigación** (abajo). |

Sobre `braces` (GHSA-vfj7-8cjw-p6xm, denegación de servicio por patrones glob muy anidados):
- No hay versión corregida (`braces` 3.0.3 es la última) y todas las versiones de Next 16 fijan `fast-glob@3.3.1`.
  `npm audit fix --force` "propone" bajar a `eslint-config-next@14`, incompatible con Next 16.
- Exposición: solo se ejecuta al correr ESLint en equipos de desarrollo y CI, con patrones definidos en el propio
  repositorio. No forma parte del servidor ni del cliente (`npm ls --omit=dev braces` vacío; no aparece en `.next/`).
  Un atacante necesitaría controlar la configuración de lint del repo, lo que ya implica acceso de escritura.
- Controles: el CI falla con cualquier vulnerabilidad high/critical **de producción** (`npm run audit:prod`) y con
  cualquier **critical**, incluidas las de desarrollo (`npm run audit:critical`).
- Plan: actualizar `eslint-config-next` cuando `@next/eslint-plugin-next` deje `fast-glob@3.3.1` o exista un parche
  de `braces`. Alternativa si se quiere `npm audit` totalmente limpio ya: quitar `eslint-config-next` y configurar
  `typescript-eslint`, `eslint-plugin-react-hooks` y `eslint-plugin-jsx-a11y` directamente (se pierden las reglas
  específicas de Next.js).

## Riesgos y límites conocidos

- Sin CSP estricta con nonces (Next requiere scripts inline); mitigado por render en servidor y escape de React.
- La caché vive en la memoria de un proceso; en un hosting con varias instancias cada una lee por separado.
- Con `loading.tsx` las respuestas se transmiten en streaming: un proyecto inexistente renderiza "No encontrado"
  con HTTP 200 (comportamiento de Next.js).
- `COMPLETADO` se muestra tal como está registrado; el panel no valida criterios de aceptación.
