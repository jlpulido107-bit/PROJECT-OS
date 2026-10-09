/**
 * Saneamiento de texto para escritura en Sheets (§3.4 del contrato).
 * - NFC, sin caracteres de control (salvo \n en textos multilínea), espacios extremos recortados.
 * - Neutraliza inyección de fórmulas (Sheets/CSV): texto que empieza por = + - @ recibe un apóstrofo inicial,
 *   igual que `safe_text` de src/sync_sheets.py (V1.1). Además se escribe con valueInputOption=RAW.
 */
const FORMULA_START = /^[=+\-@]/

export function cleanText(value: string, multiline: boolean): string {
  let text = value.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, ' ')
  // Elimina controles C0/C1 y separadores de línea Unicode; conserva \n solo en multilínea.
  text = text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, '')
  text = multiline ? text.replace(/\n{3,}/g, '\n\n') : text.replace(/\n+/g, ' ')
  return text.trim()
}

export function neutralizeFormula(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text
}

/** Texto libre listo para escribir: limpio y sin riesgo de fórmula. */
export function safeCellText(value: string, multiline = false): string {
  return neutralizeFormula(cleanText(value, multiline))
}
