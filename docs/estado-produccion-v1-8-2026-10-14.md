# PROJECT-OS V1.8 — Registro de despliegue (escritura real, envío de órdenes y «Copiar para Codex»)

**Fecha del registro:** 2026-10-14  
**Estado:** desplegado por el propietario; smoke sin sesión en OK; login real y escritura probados con ORD-POS-002.  
**Ámbito:** evidencias de los despliegues manuales autorizados de V1.8:
- F1–F4 ([PR #30](https://github.com/jlpulido107-bit/PROJECT-OS/pull/30)–[#33](https://github.com/jlpulido107-bit/PROJECT-OS/pull/33)), revisión `00004`;
- F4b ([PR #36](https://github.com/jlpulido107-bit/PROJECT-OS/pull/36)), revisión `00005`.

Procedimiento: [runbook](despliegue-privado-v1-3.md) §5.5–5.7 y [escritura-v1-8.md](escritura-v1-8.md).

## 1. Identidad de la versión desplegada

| Elemento | Valor |
| --- | --- |
| Commit de la aplicación | `c06790ee6e1e41ec261d55184639b570b4935b69` (`main`, PR #36) |
| Servicio y región | `project-os-dashboard` · `northamerica-south1` |
| Revisión nueva (100 % del tráfico) | `project-os-dashboard-00005-f6w`, 2026-10-14 |
| Revisión anterior (disponible) | `project-os-dashboard-00004-l5g` (F1–F4, commit `729f7de`) |
| Imagen nueva | `…/project-os/dashboard:c06790e` · `sha256:60d3feb798dc1802fd990e7a256713758d45a5e519cc440bd1c40e3706d89dd5` |
| Imagen anterior | `sha256:d0c765c8f9b8c6b1b0ad1a028c14af3d6f6fbbb41da415d22eae3fcb18a04a9d` |
| Configuración | Versiones de secretos fijadas: sesión 1, OAuth 2, acceso 1, escritores 2, token de GitHub 1. `PROJECT_OS_WRITE_MODE=sheets` con la cuenta de escritura dedicada. `maxScale` 1, `minScale` 0 |

## 2. Comprobaciones

| Comprobación | Resultado | Fuente |
| --- | --- | --- |
| `smoke:remote` sin sesión (`00004`) | 31/31 | Salida pegada por el propietario |
| `smoke:remote` sin sesión (`00005`) | Todas en OK | Propietario |
| Revisiones | `00005-f6w` activa; `00004-l5g` disponible | `gcloud run revisions list` |
| Etiquetas | `produccion` y `c06790e` → `60d3feb7…`; `produccion-anterior` → `d0c765c8…`; `77a7970` → `cde104f0…` | `gcloud artifacts docker images list` (propietario) |
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

- Primer PR real de Codex para ORD-POS-002, revisado contra los criterios.
- Rollback de tráfico a `00004-l5g`: posible, sin ensayar (G2).
