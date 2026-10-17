---
paths:
  - "web/**"
---

# Reglas de web/

Se suman a [`AGENTS.md`](../../AGENTS.md); no las repiten.

- Lectura de Google Sheets: cuenta de servicio con alcance `spreadsheets.readonly`, solo `GET` y solo en el servidor (`web/src/lib/sheets-client.ts`).
- Escritura: solo por la API de operaciones con la cuenta de escritura dedicada (`web/src/lib/operations`, `write-credentials.ts`; ver [`docs/escritura-v1-8.md`](../../docs/escritura-v1-8.md)). No crear otras vías de escritura.
- Excepción interina (DEC-POS-006): solo la sesión PM escribe en la hoja con el conector, solo con la skill
  `pm-escribir-hoja` (ver [`AGENTS.md`](../../AGENTS.md)). Implementación y auditoría no escriben en Sheets ni usan el
  conector. Caduca al desplegar O5b.
- Antes de escribir código de Next.js, lee la guía correspondiente en `web/node_modules/next/dist/docs/`.
- Si cambias `web/`, corre en `web/`: `npm test`, `npm run lint`, `npm run typecheck` y `npm run check:client-secrets`.
- Usa `npm ci`; para cambiar dependencias, npm 11 (ver [`web/README.md`](../../web/README.md)).
