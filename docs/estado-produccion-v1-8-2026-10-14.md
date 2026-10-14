# PROJECT-OS V1.8 — Registro de despliegue (escritura real, envío de órdenes y «Copiar para Codex»)

**Fecha del registro:** 2026-10-14  
**Estado:** desplegado por el propietario; smoke sin sesión en OK; login real y escritura probados con ORD-POS-002.  
**Ámbito:** evidencias de los despliegues manuales autorizados de V1.8:
- F1–F4 ([PR #30](https://github.com/jlpulido107-bit/PROJECT-OS/pull/30)–[#33](https://github.com/jlpulido107-bit/PROJECT-OS/pull/33)), revisión `00004`;
- F4b ([PR #36](https://github.com/jlpulido107-bit/PROJECT-OS/pull/36)), revisión `00005`;
- F4c y F5a ([PR #37](https://github.com/jlpulido107-bit/PROJECT-OS/pull/37), [#40](https://github.com/jlpulido107-bit/PROJECT-OS/pull/40) y [#41](https://github.com/jlpulido107-bit/PROJECT-OS/pull/41)), revisión `00006`: Claude ejecuta las órdenes y el dashboard lo llama al aprobar ([rutina](rutina-claude.md)).

Procedimiento: [runbook](despliegue-privado-v1-3.md) §5.5–5.7 y [escritura-v1-8.md](escritura-v1-8.md).

## 1. Identidad de la versión desplegada

| Elemento | Valor |
| --- | --- |
| Commit de la aplicación | `cb7a2648d2e297f04318230c2d5d46a12b49c25a` (`main`, PR #41) |
| Servicio y región | `project-os-dashboard` · `northamerica-south1` |
| Revisión nueva (100 % del tráfico) | `project-os-dashboard-00006-gl5`, 2026-10-14 18:41 UTC |
| Revisión anterior (disponible) | `project-os-dashboard-00005-f6w` (F4b, commit `c06790e`, imagen `60d3feb7…`) |
| Imagen nueva | `…/project-os/dashboard:cb7a264` · `sha256:7ef79fc0625ed819c2020df15b1fdeec126cd2f85a70c432565011ea6c698256` |
| Imagen anterior | `sha256:60d3feb798dc1802fd990e7a256713758d45a5e519cc440bd1c40e3706d89dd5` |
| Configuración | Versiones de secretos fijadas: sesión 1, OAuth 2, acceso 1, escritores 2, token de GitHub 1, token de la rutina de Claude 1. `CLAUDE_ROUTINE_ID` de la rutina «PROJECT-OS · ejecutar orden». `PROJECT_OS_WRITE_MODE=sheets` con la cuenta de escritura dedicada. `maxScale` 1, `minScale` 0 |

## 2. Comprobaciones

| Comprobación | Resultado | Fuente |
| --- | --- | --- |
| `smoke:remote` sin sesión (`00004`) | 31/31 | Salida pegada por el propietario |
| `smoke:remote` sin sesión (`00005`) | Todas en OK | Propietario |
| `smoke:remote` sin sesión (`00006`) | 32/32, incluye `/api/operaciones/ordenes/…/ejecutar` → 401 | Salida pegada por el propietario |
| Revisiones | `00006-gl5` activa; `00005-f6w` y `00004-l5g` disponibles | `gcloud run revisions list` |
| Etiquetas | `produccion` → `7ef79fc0…`; `produccion-anterior` → `60d3feb7…` | `gcloud artifacts docker tags add` (salida del propietario) |
| Escritura real | El propietario creó y aprobó ORD-POS-002 desde el dashboard: issue #34 creado, orden en `ENVIADA` | Dashboard, hoja y GitHub |

## 3. Incidencias (sin impacto en el servicio)

1. **Revisión `00003-9b5` no arrancó** (V1.8, primer intento): la sonda de arranque falló con el código `write-mode`
   porque el correo del secreto de escritores no coincidía con el de acceso. Siguió sirviendo `00002-58z`. Se corrigió
   con la versión 2 del secreto `project-os-writer-emails` y se destruyó la versión 1.
2. **`@codex` en issues no inicia tareas:** el conector responde «create an environment» aunque el entorno exista y
   las tareas directas funcionen. F4b quita la mención; la orden se lanza con «Copiar para Codex».
3. **Render con código 1 en `00005`:** se ejecutó fuera de `web/`. No se aplicó nada. Repetido desde `web/`, salió bien.

**Lección:** ejecutar el render siempre con `cd ~/PROJECT-OS/web` en el mismo bloque, y desplegar solo si
`WRITE_MODE` e `IMAGE` dan `1`.

## 4. Pendiente

- Prueba real de la rutina: aprobar una orden pequeña y comprobar sesión, comentario en el issue y PR `[ORD-…]`.
- Quitar los conectores que la rutina no usa (Drive, BigQuery, Docs, visualize).
- Rollback de tráfico a `00005-f6w`: posible, sin ensayar (G2).
