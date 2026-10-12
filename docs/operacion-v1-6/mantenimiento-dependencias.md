# PROJECT-OS V1.6 — Mantenimiento de dependencias y cobertura de CI

> **Fecha:** 2026-10-11. Datos tomados de `npm audit` y `npm view` contra el registro público de npm, desde `web/`
> en el commit de este PR. **No** se ejecutó `npm audit fix` ni se cambió ninguna dependencia.

## 0. Estado y decisión (Misión 014, 2026-10-11)

Se repitió la consulta en el registro público de npm, con el lockfile del PR #24. **No** se ejecutó `npm audit fix` ni
se cambió ninguna dependencia.

| Comprobación | Resultado |
| --- | --- |
| `npm run audit:prod` (`--omit=dev`, falla con high) | **0 vulnerabilidades** |
| `npm audit` (todas) | **5 altas, 0 críticas**: `braces`, `micromatch`, `fast-glob`, `@next/eslint-plugin-next` y `eslint-config-next`, por el mismo aviso [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) |
| `npm ls --omit=dev braces` | Vacío: no es una dependencia de producción |
| Versiones publicadas | `braces` 3.0.3 (dentro del rango afectado), `micromatch` 4.0.8, `fast-glob` 3.3.3. `@next/eslint-plugin-next` y `eslint-config-next` 16.4.0, que siguen fijando `fast-glob@3.3.1` |
| Corrección que propone npm | `eslint-config-next@14.2.35`: una **versión mayor anterior**, incompatible con Next 16 y ESLint 9. **No** se aplica |

**Conclusión:** no existe una actualización pequeña y segura. El riesgo persiste y se presenta como decisión.

### Decisión D-DEP para el propietario

| Aspecto | Detalle |
| --- | --- |
| Impacto | Denegación de servicio (agotamiento de pila) **de ESLint**, solo si procesa patrones de archivo muy anidados y maliciosos |
| Exposición | Solo la máquina de desarrollo y la CI, al ejecutar `npm run lint`. No entra en la imagen (`.dockerignore` y salida `standalone`) ni en Cloud Run. Explotarlo exige modificar la configuración del propio repositorio, y quien puede hacerlo ya ejecuta código en la CI |
| Compensaciones | `audit:prod` en CI falla con cualquier alta de producción; `audit:critical` falla con cualquier crítica; revisión mensual (runbook §2); las 5 altas siguen visibles, no se ocultan |
| Opción recomendada | **Aceptar** la deuda (excepción X-2) hasta que exista una versión corregida, y actualizar entonces en un PR separado (§1, «Ruta de actualización segura») |
| Alternativas | (a) Retirar `eslint-config-next` y perder las reglas de Next: cambio grande y fuera de alcance. (b) `overrides` hacia una versión que no existe: no aplicable. (c) Ejecutar el lint en un entorno aislado: no reduce un riesgo que ya es solo de desarrollo |
| Quién decide | El propietario, en el [acta de cierre](acta-cierre-v1-6.md) |

## 1. Las 5 alertas altas

| Paquete | Versión instalada | Cadena | Aviso |
| --- | --- | --- | --- |
| `braces` | 3.0.3 | `eslint-config-next@16.3.8` → `@next/eslint-plugin-next@16.3.8` → `fast-glob@3.3.1` → `micromatch@4.0.8` → `braces@3.0.3` | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm): agotamiento de pila con patrones muy anidados (CWE-674, CVSS 7,5, solo disponibilidad), rango `<=3.0.3` |
| `micromatch`, `fast-glob`, `@next/eslint-plugin-next`, `eslint-config-next` | — | Heredan el aviso de `braces` | Mismo aviso |

**Hechos:**

- `npm audit --omit=dev --audit-level=high` → **0 vulnerabilidades** (`audit:prod`, también en CI).
- `npm ls --omit=dev braces` → vacío: `braces` **no** es una dependencia de producción.
- `npm audit --audit-level=critical` → código 0: no hay críticos (`audit:critical`, también en CI).
- **No existe versión corregida:** la última publicada de `braces` es la **3.0.3**, que el aviso incluye. Tampoco
  ayuda subir de versión:
  - `eslint-config-next@16.4.0` (la última) depende de `@next/eslint-plugin-next@16.4.0`;
  - este sigue fijando `fast-glob@3.3.1` → `micromatch@^4.0.8` → `braces@^3.0.3`.
- La única "corrección" que propone npm es `eslint-config-next@14.2.35`, una **versión mayor anterior**, incompatible
  con Next 16 y con la configuración plana de ESLint 9. Es lo que haría `npm audit fix --force`, y **no** debe
  aplicarse.

**Explotabilidad:**

- `braces` solo se ejecuta cuando ESLint expande patrones de archivos de la configuración del propio repositorio, en
  la máquina del desarrollador o en CI.
- No procesa entradas de usuarios ni se ejecuta en Cloud Run.
- La imagen solo copia `.next/standalone` y `.next/static` a la etapa final (`web/Dockerfile`). ESLint no entra en
  la salida trazada de Next, aunque esto último es una **inferencia** a partir del Dockerfile, no una inspección de
  la imagen.

**Clasificación: deuda de desarrollo, no bloqueante. Sin explotabilidad en producción.**

**Ruta de actualización segura:**

1. **Hoy:** nada. Mantener `audit:prod` (falla con high) y `audit:critical` en CI. Las 5 altas siguen visibles en
   cada `npm audit` y en este documento; **no se ocultan** con `--audit-level`.
2. **Cuando exista** una versión de `braces` posterior a 3.0.3, o una de `@next/eslint-plugin-next` que no use
   `fast-glob@3.3.1`, en un PR separado:
   - `npx npm@11 install -D eslint-config-next@<versión>` (npm 11; ver la nota de `web/README.md`);
   - después `npm run lint`, `npm test` y `npm run build`, y CI completa.
3. **Alternativa, no recomendada ahora:** `overrides` en `package.json` para forzar un `micromatch` o `braces` que no
   existe. No hay versión a la que apuntar.
4. **Revisión:** mensual, en la rutina del runbook operativo (§2), o cuando GitHub publique una actualización del
   aviso.

## 2. Cobertura de CI (`.github/workflows/web-validation.yml`)

| Comprobación | En CI | Ejecutada localmente en este PR (2026-10-11) | Límites |
| --- | --- | --- | --- |
| `npm run audit:prod` | ✅ job `web` | ✅ 0 vulnerabilidades | Usa el registro público de npm en el momento de ejecutarse |
| `npm run audit:critical` | ✅ | ✅ código 0 (5 altas, 0 críticas) | Las altas no hacen fallar el paso, por diseño |
| `npm run lint` | ✅ | ✅ | — |
| `npm run typecheck` | ✅ | ✅ (`tsc --noEmit`) | — |
| `npm test` (Vitest) | ✅ | ✅ (ver el comentario final del PR) | Datos sintéticos |
| `npm run build` | ✅ | ✅ con los valores falsos de CI | No es la imagen de Cloud Build |
| `npm run test:e2e` (auth) | ✅ | ✅ 63/63 | Servidor local, sin Google |
| `npm run test:e2e:integration` | ✅ | ✅ 63/63 | Ídem |
| `npm run test:e2e:planning` / `:ops` / `:control` | ✅ | ✅ 32/32 · 56/56 · 35/35 | Ídem |
| `npm run check:client-secrets` | ✅ con `--min-values=4` desde este PR | ✅ 22 archivos, 4 valores | Valores falsos; nunca los de producción (auditoría §5) |
| Docker build + smoke | ✅ job `docker` | No (sin Docker en esta sesión) | Imagen local en el runner, sin publicar |
| `npm run smoke:remote` | ❌ (no debe ir en CI: contacta producción) | No | Lo ejecuta el propietario tras cada despliegue |
| Preflight offline (`preflight-aceptacion.mjs`) | Indirecto: `operacion-v1-6.test.ts` lo ejecuta en `npm test` | ✅ 14/14 OK | En CI, P14 puede quedar NO_VERIFICADO (clon superficial) |

- **No se crearon workflows.** El único cambio en CI es `--min-values=4` en el paso de secretos.
- El workflow `web-validation.yml` solo se dispara con cambios en `web/**`. Un PR que solo toque `docs/` no ejecuta
  los jobs `web` y `docker`: los documentos de despliegue y operación se validan dentro de `npm test`
  (`deploy-docs.test.ts`, `operacion-v1-6.test.ts`). Si un PR solo de documentación debiera validarse en CI, habría
  que añadir `docs/**` al filtro; queda como decisión (backlog V1.7, Q4).

## 3. Determinismo de las pruebas nuevas

- Solo datos **sintéticos**: fixtures copiados a directorios temporales, canarios inventados y correos de
  `example.com` o de dominios `.test`.
- **Sin red:** los scripts probados no importan `child_process` (salvo `git` local en el preflight) ni `fetch`; una
  prueba lo comprueba sobre el código fuente.
- Los temporales se crean con `mkdtemp` y se borran en `afterAll`. No se escribe nada dentro del repositorio.
- `PATH` mínimo (`/usr/bin:/bin`) y entorno vacío en cada `spawnSync`: no heredan credenciales de la sesión.
