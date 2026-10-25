import 'server-only'

import { NextResponse } from 'next/server'
import { finanzasAgenteWrite } from './agente-handler'
import { finanzasAgenteRateLimiter, finanzasAgenteService } from './agente-runtime'
import type { FinanzasAgenteResultado, FinanzasAgenteService } from './agente-service'

const HEADERS = { 'Cache-Control': 'private, no-store, max-age=0' }

/** Ruta del agente de finanzas: token propio, sin sesión, servicio ligado a FINANZAS (ORD-POS-092). */
export async function handleFinanzasAgente(
  request: Request,
  run: (service: FinanzasAgenteService, body: unknown) => Promise<FinanzasAgenteResultado>,
) {
  const { status, body } = await finanzasAgenteWrite(request, {
    env: process.env,
    limiter: finanzasAgenteRateLimiter(),
    service: () => finanzasAgenteService(),
  }, run)
  return NextResponse.json(body, { status, headers: HEADERS })
}
