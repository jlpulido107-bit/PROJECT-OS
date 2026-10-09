'use server'

import { revalidatePath } from 'next/cache'
import { currentUser } from '@/lib/auth'
import { invalidateDataset } from '@/lib/data'

/** Refresco explícito: invalida la caché corta y vuelve a leer Sheets. Requiere sesión autorizada. */
export async function refreshData(): Promise<void> {
  const user = await currentUser()
  if (!user) return
  invalidateDataset()
  revalidatePath('/', 'layout')
}
