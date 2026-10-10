# Auditoría de integración V1.3–V1.6 (Misión 009)

> **Estado:** #6, #8, #10 y #12 ya están fusionados en `main` (último merge `8dd3674`). El PR #15
> (`feature/consolidation-ci-v1-6`) solo añade la CI unificada, las pruebas cruzadas y este informe.
>
> **Histórico:** la rama temporal `integration/v1-3-to-v1-6` (PR draft #14) sirvió para validar la combinación antes
> de los merges. **No se fusiona**; se cierra una vez confirmada la cobertura de #15.
>
> **Sin efectos externos:** no toca Google Sheets ni Cloud Run, no habilita escritura real y no crea recursos ni
> automatizaciones. **Ninguna fusión** se hace sin autorización explícita del usuario.

Las secciones 1 a 4 conservan el análisis original de la rama de integración como referencia. La sección 5 recoge
la validación posterior a los merges.

## 1. SHAs

| Rama | SHA al iniciar la misión | SHA auditado (tras correcciones) |
| --- | --- | --- |
| `main` | `af05534797242d5a35db39fc3587f656ccea34e2` | sin cambios |
| #6 `feature/private-hosting-v1-3` | `71577e40817d513e0cb49d0ba8f70478b8f3c0d1` | `8e0051a8bd194e138b253ff63b2d1028ffb39dea` |
| #8 `feature/operations-v1-4` | `22bb252bc34fe2c8f90e8bcad9dfe55854055524` | `05e10443645163991481bc10950e73c6f4aeea3c` |
| #10 `feature/planning-v1-5` | `cc1fa35a8f6ffd30d0ab453cdf6106abe2e98c8a` | `2dc5b6270bec1ea6539f6f9bc1534c439dbe0d60` |
| #12 `feature/governance-v1-6` | `545ad810c3af2d698c188752ec087c4e4e458d7c` | `957002a85e1dc7e44994b221bec0c43f8b9fcc2b` |

La rama de integración fusiona, en orden, #6 → #8 → #10 → #12, y después vuelve a fusionar #6 para incorporar su
último arreglo. Añade dos commits propios de integración: la CI unificada, las pruebas del árbol combinado y el
E2E cruzado.

## 2. Hallazgos de las revisiones y correcciones

Cada corrección tiene una prueba que **fallaba antes y pasa después**, y está en su PR de origen.

| PR | Hallazgo de la revisión | Corrección | Prueba |
| --- | --- | --- | --- |
| #6 | Mantener `PROJECT_OS_WRITE_MODE` ausente o `disabled` en producción | La plantilla de Cloud Run se verifica sin modo de escritura ni `AUTH_WRITER_EMAILS` (`8a92e6b`). La sonda `/api/health` devuelve 503 (`write-mode`) en Cloud Run si hay un modo de escritura o una lista de escritores (`8e0051a`) | `deploy-template.test.ts` (verificada con una mutación) y `deployment.test.ts` |
| #6 | Puertas externas: runbook real, OAuth, IAM, presupuesto, smoke remoto | **No se ejecuta** (requiere autorización). Queda como puerta | — |
| #8 P1 | `writeGuarded` no es un CAS atómico | Documentado sin prometer ausencia de actualizaciones perdidas. Prueba de **dos escritores independientes**: el conflicto grueso da 409; la carrera fina **es posible** y la conciliación la detecta como `actualizacion-perdida` (`05e1044`) | `operations-audit-integrity.test.ts` |
| #8 P2 | `parseAudit` y los reintentos no verifican la integridad de la auditoría | `AUDIT_ID …-NN-TT`. Se detectan auditorías **parciales** (faltan filas o campos) y **contradictorias** (operación, hash, entidad, registro o lote distintos, índices repetidos, campos con valores distintos). Un reintento sobre ellas da `409 auditoria-inconsistente`; una entidad alterada sin operación auditada da `409 estado-divergente`. **Los reintentos legítimos tras ediciones auditadas siguen siendo `repetida`** | ídem (8 casos; 7 fallaban antes) |
| #10 P2 | La segunda pasada ampliaba una tarea por encima de 180 min con alternativas pendientes | El hueco se reparte **por turnos de 30 min** en orden global. Lunes de 10 h con dos tareas de 6 h: 300/300 (antes 360/240) (`2dc5b62`) | `planning-engine.test.ts` |
| #10 P2 | El saldo semanal no distinguía el hueco realmente colocable | `capacidad.colocableMin` (huecos diarios restantes, acotados por el saldo). Invariante nueva: propuesto ≤ colocable ≤ libre. Interfaz: "Saldo semanal" y "Colocable" | `planning-engine.test.ts` y `planning-properties.test.ts` |
| #12 | El E2E de control solo corría en `pull_request` | `control-validation.yml` también en `push` a `main` (`957002a`). En #15 el paso vive en el job `web` de `web-validation.yml` y `control-validation.yml` **se elimina** para no ejecutarlo dos veces | CI |

## 3. Puntos de contacto del árbol combinado

Ninguno produjo conflicto de texto. Se revisó la semántica:

| Archivo | Resultado |
| --- | --- |
| `nav-links.tsx` | Inicio, **Control**, Proyectos, Tareas, Actividad, Capacidad y plan, **Planificación** para todo lector autorizado. **Operaciones** solo con `showOperations`, es decir, escritor y modo `mock` |
| `security.test.ts` | Suma las protecciones de #6 (credenciales, `lib/credentials` y `lib/deployment` solo servidor, `/api/health` sin datos), #8 (adaptador de escritura no importado, guarda en las 4 rutas, `sheets` bloqueado) y #10/#12. Además, `integration-security.test.ts` exige **exactamente 13 páginas** con `privateData` y autorización del servidor en **todas** las APIs |
| `data.ts` | Proveedor de tokens de V1.3 (`credentials.ts`, `spreadsheets.readonly`, clave local o ADC) **más** la invalidación de caché del mock de V1.4 (`writeGeneration`). Sin JWT por omisión ni escritura real (verificado por prueba) |
| `web-validation.yml` | `pull_request` y **`push` a `main`**. Unitarias más E2E de autenticación, operaciones, planificación, **control** e **integración**, más el job **docker** de #6. `control-validation.yml` se elimina (lo hace #15) |
| `package.json` | Todos los scripts: `test:e2e`, `test:e2e:ops`, `test:e2e:planning`, `test:e2e:control`, `test:e2e:integration`, `docker:smoke`, `smoke:remote` |

## 4. Resultados en la rama de integración (#14, histórico)

Entorno: Node 22.22.0, npm 10.9.4, Next 16.3.8. Ejecución local desde `npm ci` limpio, sin credenciales y sin
contacto con Google.

| Comprobación | Resultado |
| --- | --- |
| `npm ci` | OK |
| `npm run audit:prod` | 0 vulnerabilidades |
| `npm run audit:critical` | Sin críticas |
| `npm run lint` | OK |
| `npm run typecheck` | OK |
| Vitest | **340/340** (22 archivos) |
| `npm run build` | OK |
| `test:e2e` (auth, V1.2–V1.3) | 63/63 |
| `test:e2e:ops` (V1.4) | 56/56 |
| `test:e2e:planning` (V1.5) | 32/32 |
| `test:e2e:control` (V1.6) | 35/35 |
| `test:e2e:integration` (nuevo) | **63/63** |
| `check:client-secrets` | OK |
| Python V1.1 | 18/18 |
| Navegador (Playwright, escritor y lectora, 390 px y 1280 px, 12 páginas) | Sin desbordes ni errores JS |
| `docker:smoke` | No ejecutable localmente (no hay daemon de Docker). **Verde en la CI del PR #14** (job `docker`, commit `4b2f89a`), igual que `web` (las 5 suites E2E) y `validate` |

### 4.1 E2E de integración: qué cubre (`scripts/e2e-integration.mjs`)

Usa 5 servidores `next start`, todos con datos sintéticos y nunca con Google.

1. **Sesión bloqueada y permitida** en 10 rutas privadas.
2. **Navegación por rol:**
   - la lectora ve Planificación y Control, pero no Operaciones;
   - el escritor en `mock` ve las tres.
3. **Errores:** 401 sin sesión, 403 para la lectora, 422 por validación, 409 por versión desactualizada.
4. **Una escritura simulada se refleja en todo:**
   - `/api/resumen` y `/tareas` muestran la tarea nueva;
   - `/api/control` levanta la alerta `tarea-vencida`, sin título;
   - `/api/planificacion` pone la tarea vencida en el rango 1;
   - al bloquearla, aparece `tarea-bloqueada` en el control y queda **excluida** del plan, sin bloques.
5. **Planificación y control no escriben:** POST, PUT, PATCH y DELETE devuelven 405 incluso con sesión de escritor
   y CSRF, y los datos no cambian.
6. **Sin correos** en `/api/resumen`, `/api/control` ni `/api/planificacion`.
7. **Valores por defecto:** escritura en 403 y sin enlace a Operaciones aunque haya escritores en la lista.
8. **`sheets`:** bloqueado (403).
9. **Cloud Run simulado con `mock` pedido:** la escritura da 403 y `/api/health` da 503 sin detalles.
10. **Fallo del lector** (fuente Sheets sin configurar): las tres APIs devuelven 503 sin datos y las páginas
    muestran el error sin datos parciales.
11. **Registros:** los logs de los 5 servidores no contienen correos.

## 5. Validación posterior a los merges

Los resultados se atribuyen a cada árbol por separado. Entorno local: Node 22.22.0, npm 10.9.4, `npm ci` limpio,
sin credenciales y sin contacto con Google.

### 5.1 Sobre `main` en `8dd3674` (tras fusionar #12)

Ejecución local en un worktree limpio de `main`, sin los archivos de #15.

| Comprobación | Resultado |
| --- | --- |
| `npm ci`, `audit:prod`, `audit:critical`, `lint`, `typecheck`, `build` | OK (0 vulnerabilidades de producción, sin críticas) |
| Vitest | 335/335 (sin `integration-security.test.ts`, que añade #15) |
| `test:e2e` / `test:e2e:ops` / `test:e2e:planning` / `test:e2e:control` | 63/63 · 56/56 · 32/32 · 35/35 |
| `check:client-secrets` | OK |
| Python V1.1 | 18/18 |
| `scripts/e2e-integration.mjs` copiado sobre el build de `main` | 63/63 (el árbol fusionado equivale al validado en #14) |

### 5.2 Sobre #15 (`feature/consolidation-ci-v1-6`)

Diferencia con `main`: CI unificada, `test:e2e:integration`, `integration-security.test.ts`, este informe y la
**eliminación** de `control-validation.yml`. Ninguna lógica de negocio cambia.

| Comprobación | Resultado |
| --- | --- |
| CI en `bdd09a0` (antes de esta revisión) | `validate`, `web`, `docker` y `control-e2e` en verde. El E2E de control corría **dos veces** (job `web` y `control-e2e`) |
| Local, árbol con la revisión aplicada: `npm ci`, `audit:prod`, `audit:critical`, `lint`, `typecheck`, `build` | OK |
| Vitest | 340/340 (22 archivos) |
| `test:e2e` / `ops` / `planning` / `control` / `integration` | 63/63 · 56/56 · 32/32 · 35/35 · 63/63 |
| `check:client-secrets` | OK |
| Python V1.1 | 18/18 |
| CI del nuevo HEAD | Ver los checks del PR: `validate`, `web` (incluye el E2E de control) y `docker`. `control-e2e` ya no existe |

### 5.3 Reproducir

```bash
git checkout feature/consolidation-ci-v1-6   # o main, una vez fusionado #15
cd web && npm ci && npm run lint && npm run typecheck && npm test && npm run build
for s in test:e2e test:e2e:ops test:e2e:planning test:e2e:control test:e2e:integration; do npm run $s; done
npm run check:client-secrets && npm run audit:prod && npm run audit:critical
cd .. && python3 -m unittest discover -s tests
```

## 6. Decisiones

**Resueltas:**

- **Estrategia de merge:** se aplicó la opción recomendada, #6 → #8 → #10 → #12 en orden y con autorización por
  merge (`82a7fa7`, `74dbb10`, `ba53469`, `8dd3674`). El trabajo exclusivo de integración llega en #15, no en #14.

**Pendientes para el usuario:**

1. **CI en `push` a `main`:** la añade #15. Fusionarlo implica aceptarla (consume minutos de Actions; no despliega
   nada). Se propone `squash merge`.
2. **Cerrar #14** sin fusionar, una vez fusionado #15.
3. **Planificador → control:** las señales V1.5 se pueden pasar al centro de control con una línea, y queda
   preparado. **No** se conectó, para no mezclar alcances.
4. **Utilidades duplicadas:** el grafo de ciclos y el hash FNV están en V1.5 y V1.6. Conviene consolidarlos en un PR
   aparte.

## 7. Riesgos restantes

- **Sin CAS en Sheets.** Una escritura real futura puede perder actualizaciones entre instancias. Hoy se detecta en
  la conciliación, pero **no se previene**. Mitigación antes de habilitar escritura real: un escritor único con
  exclusividad verificable o un backend transaccional (decisión pendiente en #8).
- **Docker smoke:** verde en la CI de #14 y de #15. No se repitió localmente porque no hay daemon de Docker.
- **ADC real, OAuth real, IAM y presupuesto** sin probar contra GCP: son puertas de despliegue que requieren
  autorización **separada** (runbook de V1.3, §5).
- **Heurísticas del control V1.6** (umbrales y evidencia): pueden generar ruido. Están documentadas como
  decisiones pendientes.
