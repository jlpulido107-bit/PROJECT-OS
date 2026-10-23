import 'server-only'

import { requireUser, type SessionUser } from './auth'
import { getDataset, type LoadResult } from './data'
import { getFinanzas, type FinanzasResult } from './finanzas/data'
import { getEco, type EcoResult } from './radaros/data'

/** Verifica la sesión ANTES de leer datos (defensa en profundidad además del proxy). */
export async function privateData(path: string): Promise<{ user: SessionUser; result: LoadResult }> {
  const user = await requireUser(path)
  const result = await getDataset()
  return { user, result }
}

/** /eco (ORD-POS-067): misma verificación de sesión antes de leer; solo lee RADAROS, nunca la hoja de PROJECT-OS. */
export async function privateEco(path: string): Promise<{ user: SessionUser; result: EcoResult }> {
  const user = await requireUser(path)
  const result = await getEco()
  return { user, result }
}

/** /finanzas (ORD-POS-074): misma verificación de sesión antes de leer; solo lee FINANZAS, nunca otra hoja. */
export async function privateFinanzas(path: string): Promise<{ user: SessionUser; result: FinanzasResult }> {
  const user = await requireUser(path)
  const result = await getFinanzas()
  return { user, result }
}
