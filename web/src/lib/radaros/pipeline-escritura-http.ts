import 'server-only'

import { getServerSession } from 'next-auth'
import { NextResponse } from 'next/server'
import { authOptions } from '../auth'
import { ecoPipelineWrite } from './pipeline-escritura-handler'
import { ecoPipelineRateLimiter, ecoPipelineWriteService } from './pipeline-escritura-runtime'
import type { EcoContext, EcoPipelineWriteService, EcoResultado } from './pipeline-escritura-service'

const HEADERS = { 'Cache-Control': 'private, no-store, max-age=0' }

/** Ruta de escritura del pipeline: guard propio sin agente, servicio ligado a RADAROS (ORD-POS-102). */
export async function handleEcoWrite(
  request: Request,
  operacion: string,
  run: (service: EcoPipelineWriteService, body: unknown, ctx: EcoContext) => Promise<EcoResultado>,
  creado = 201,
) {
  const { status, body } = await ecoPipelineWrite(request, {
    sessionEmail: async () => (await getServerSession(authOptions))?.user?.email ?? null,
    env: process.env,
    limiter: ecoPipelineRateLimiter(),
    service: () => ecoPipelineWriteService(),
  }, operacion, run, creado)
  return NextResponse.json(body, { status, headers: HEADERS })
}
