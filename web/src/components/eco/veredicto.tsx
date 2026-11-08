import { Badge } from '@/components/ui'
import { POR_CONFIRMAR, veredicto, type FilaComparada } from '@/lib/radaros/pipeline-tabulador'

/**
 * Veredicto de una cotización contra el costo máximo (ORD-POS-145), compartido por la ficha de Compras y el ranking de
 * /eco (ORD-POS-151): «Cumple / No cumple por X» o «Por confirmar» con su motivo en el título. Solo muestra `diferenciaMxn` del tabulador; no calcula nada.
 */
export function Veredicto({ f, motivo }: { f: FilaComparada; motivo?: string }) {
  if (f.diferenciaMxn === null) return <Badge tone="warn" title={motivo}>{POR_CONFIRMAR}</Badge>
  return <Badge tone={f.diferenciaMxn <= 0 ? 'ok' : 'danger'}>{veredicto(f.diferenciaMxn)}</Badge>
}
