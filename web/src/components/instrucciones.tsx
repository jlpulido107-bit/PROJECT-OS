/**
 * Instrucciones de una tarea (ORD-POS-105): texto plano multilínea pintado como párrafos y listas. Todo va como texto
 * de React (escapado); nunca HTML crudo ni dangerouslySetInnerHTML.
 */

type Bloque =
  | { tipo: 'p'; lineas: string[] }
  | { tipo: 'ol'; inicio: number; items: string[] }
  | { tipo: 'ul'; items: string[] }

const NUMERADA = /^\s*(\d{1,3})[.)]\s+(.*)$/
const VINETA = /^\s*[-*•]\s+(.*)$/

/** Separa el texto en bloques. El apóstrofo que neutraliza una fórmula al escribir (sanitize.ts) no se muestra. */
export function bloquesInstrucciones(texto: string): Bloque[] {
  const bloques: Bloque[] = []
  for (const linea of texto.replace(/^'(?=[=+\-@])/, '').split('\n')) {
    const ultimo = bloques.at(-1)
    const numerada = NUMERADA.exec(linea)
    const vineta = VINETA.exec(linea)
    if (numerada) {
      if (ultimo?.tipo === 'ol') ultimo.items.push(numerada[2]!)
      else bloques.push({ tipo: 'ol', inicio: Number(numerada[1]), items: [numerada[2]!] })
    } else if (vineta) {
      if (ultimo?.tipo === 'ul') ultimo.items.push(vineta[1]!)
      else bloques.push({ tipo: 'ul', items: [vineta[1]!] })
    } else if (linea.trim() === '') {
      bloques.push({ tipo: 'p', lineas: [] })
    } else if (ultimo?.tipo === 'p') {
      ultimo.lineas.push(linea)
    } else {
      bloques.push({ tipo: 'p', lineas: [linea] })
    }
  }
  return bloques.filter((b) => b.tipo !== 'p' || b.lineas.length > 0)
}

export function Instrucciones({ texto }: { texto: string }) {
  return (
    <div className="instrucciones">
      {bloquesInstrucciones(texto).map((b, i) => {
        if (b.tipo === 'ol') return <ol key={i} start={b.inicio}>{b.items.map((t, j) => <li key={j}>{t}</li>)}</ol>
        if (b.tipo === 'ul') return <ul key={i}>{b.items.map((t, j) => <li key={j}>{t}</li>)}</ul>
        return <p key={i}>{b.lineas.flatMap((t, j) => (j === 0 ? [t] : [<br key={j} />, t]))}</p>
      })}
    </div>
  )
}
