---
paths:
  - "web/**"
---

# Reglas de web/

Se suman a [`AGENTS.md`](../../AGENTS.md); no las repiten.

- El dashboard solo lee Google Sheets: alcance `spreadsheets.readonly`, solo `GET` y solo en el servidor.
- Antes de escribir código de Next.js, lee la guía correspondiente en `web/node_modules/next/dist/docs/`.
- Si cambias `web/`, corre en `web/`: `npm test`, `npm run lint`, `npm run typecheck` y `npm run check:client-secrets`.
- Usa `npm ci`; para cambiar dependencias, npm 11 (ver [`web/README.md`](../../web/README.md)).
