# PROJECT-OS V1.7 — Registro de despliegue de la página «Estado»

**Fecha del registro:** 2026-10-13  
**Estado:** desplegado por el propietario; smoke sin sesión 27/27; login real correcto.  
**Ámbito:** evidencias del despliegue manual autorizado de [PR #26](https://github.com/jlpulido107-bit/PROJECT-OS/pull/26)
(POS-007). Mismo procedimiento que el [runbook](despliegue-privado-v1-3.md) §5.5–5.7. No cambia infraestructura, secretos
ni permisos.

## 1. Identidad de la versión desplegada

| Elemento | Valor |
| --- | --- |
| Commit de la aplicación | `77a79705017139c99ac977c96602b0b0b5c19b1a` (`main`, CI `web`, `docker` y `validate` en verde) |
| Servicio y región | `project-os-dashboard` · `northamerica-south1` |
| Revisión nueva (100 % del tráfico) | `project-os-dashboard-00002-58z`, 2026-10-13 03:47 UTC |
| Revisión anterior (disponible) | `project-os-dashboard-00001-gsk` (V1.6, commit `7f44216`) |
| Imagen nueva | `…/project-os/dashboard:77a7970` · `sha256:cde104f0cec42810d6175fd521686a9b43dff1416cf259fa1bf8068d3a2745fe` |
| Imagen anterior | `sha256:f6e46596ef36522134096d97431f32036bb71298033f9694023137497d3d5c07` |
| Configuración | Igual que V1.6: mismo cliente OAuth, versiones de secretos fijadas 1 / 2 / 1, `maxScale` 1, `minScale` 0 |

## 2. Comprobaciones

| Comprobación | Resultado | Fuente |
| --- | --- | --- |
| `smoke:remote` sin sesión | **27/27**: health 200, 14 páginas privadas → `/login` (incluye `/estado`), 7 APIs 401, cabeceras | Salida pegada por el propietario |
| Revisiones | `00002-58z` activa; `00001-gsk` inactiva | `gcloud run revisions list` |
| Login real y página «Estado» | El propietario entra y ve la página con datos de la hoja | Propietario |
| Etiquetas `produccion` → `cde104f0…` y `produccion-anterior` → `f6e46596…` | Comandos ejecutados por el propietario; **lectura de verificación pendiente** | — |

## 3. Incidencia durante el despliegue (sin impacto)

1. En el primer intento no se envió el build: el paso que genera la configuración imprime el comando
   `gcloud builds submit`, pero no lo ejecuta. Sin imagen nueva, `render.mjs` rechazó el `IMAGE` vacío y el servicio
   **no cambió**. El smoke 27/27 de ese intento venía de la revisión V1.6. Un smoke sin sesión no prueba qué versión
   está desplegada: hay que mirar la lista de revisiones.
2. En ese intento, `produccion-anterior` quedó apuntando a la imagen de `produccion` (la misma V1.6). Se corrigió al
   etiquetar las imágenes tras el despliegue correcto.
3. Revisar el YAML con `less` y pegar comandos dentro del visor o del editor alteró el archivo temporal sin guardarlo.
   Se regeneró el archivo con `render.mjs` y se aplicó sin abrir ningún visor.

**Lección para el próximo despliegue:** ejecutar `gcloud builds submit` de forma explícita, comprobar que `IMAGE`
termina en `@sha256:…` antes de `render.mjs`, y validar la imagen del YAML con `grep` en lugar de un visor interactivo.

## 4. Pendiente

- Leer las etiquetas de Artifact Registry y confirmar el punto 4 de §2.
- Rollback de tráfico a `00001-gsk`: ya es posible, pero no está ensayado (G2).
