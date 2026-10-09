import 'server-only'

import { requireUser, type SessionUser } from './auth'
import { getDataset, type LoadResult } from './data'

/** Verifica la sesión ANTES de leer datos (defensa en profundidad además del proxy). */
export async function privateData(path: string): Promise<{ user: SessionUser; result: LoadResult }> {
  const user = await requireUser(path)
  const result = await getDataset()
  return { user, result }
}
