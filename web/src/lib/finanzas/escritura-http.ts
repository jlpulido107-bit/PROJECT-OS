import 'server-only'

import { getServerSession } from 'next-auth'
import { NextResponse } from 'next/server'
import { authOptions } from '../auth'
import { finanzasWrite } from './escritura-handler'
import { finanzasRateLimiter, finanzasWriteService } from './escritura-runtime'
import type { FinanzasContext, FinanzasResultado, FinanzasWriteService } from './escritura-service'

const HEADERS = { 'Cache-Control': 'private, no-store, max-age=0' }

/** Ruta de escritura de finanzas: guard propio sin agente, servicio ligado a FINANZAS (ORD-POS-077). */
export async function handleFinanzasWrite(
  request: Request,
  run: (service: FinanzasWriteService, body: unknown, ctx: FinanzasContext) => Promise<FinanzasResultado>,
) {
  const { status, body } = await finanzasWrite(request, {
    sessionEmail: async () => (await getServerSession(authOptions))?.user?.email ?? null,
    env: process.env,
    limiter: finanzasRateLimiter(),
    service: () => finanzasWriteService(),
  }, run)
  return NextResponse.json(body, { status, headers: HEADERS })
}
