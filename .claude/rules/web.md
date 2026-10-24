---
paths:
  - "web/**"
---

# Reglas de web/

Se suman a [`AGENTS.md`](../../AGENTS.md); no las repiten.

- Lectura de Google Sheets: cuenta de servicio con alcance `spreadsheets.readonly`, solo `GET` y solo en el servidor (`web/src/lib/sheets-client.ts`).
- Escritura: solo por la API de operaciones con la cuenta de escritura dedicada (`web/src/lib/operations`, `write-credentials.ts`; ver [`docs/escritura-v1-8.md`](../../docs/escritura-v1-8.md)), y la única excepción
  aprobada: la escritura de finanzas (ORD-POS-077), solo en el libro FINANZAS, con su cuenta exclusiva y su guard sin agente
  (`web/src/lib/finanzas/escritura-*.ts`; ver [`docs/diseno-finanzas-v2.md`](../../docs/diseno-finanzas-v2.md)). No crear otras vías de escritura.
- Escritura del PM (DEC-POS-005): solo la sesión PM escribe, por la API de operaciones y con la skill `pm-escribir-api`
  (ver [`AGENTS.md`](../../AGENTS.md)). Nadie escribe en la hoja con el conector; implementación y revisión tampoco.
- Antes de escribir código de Next.js, lee la guía correspondiente en `web/node_modules/next/dist/docs/`.
- Si cambias `web/`, corre en `web/`: `npm test`, `npm run lint`, `npm run typecheck` y `npm run check:client-secrets`.
- Usa `npm ci`; para cambiar dependencias, npm 11 (ver [`web/README.md`](../../web/README.md)).
