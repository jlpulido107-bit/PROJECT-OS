import 'server-only'

import { getServerSession } from 'next-auth'
import { NextResponse } from 'next/server'
import { authOptions } from '../auth'
import { evaluateWriteRequest } from './guard'
import { OperationError } from './errors'
import { bumpWriteGeneration, writeRateLimiter } from './runtime'
import type { OperationContext, OperationResult } from './service'

const HEADERS = { 'Cache-Control': 'private, no-store, max-age=0' }

function requestIdOf(body: unknown): string | undefined {
  const id = body && typeof body === 'object' ? (body as Record<string, unknown>).requestId : undefined
  return typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id) ? id : undefined
}

export function errorResponse(error: OperationError, requestId?: string) {
  if (error.status >= 500 || error.code.startsWith('conflicto') || error.code === 'verificacion-fallida') {
    // Solo código y requestId: nunca correos, payloads ni valores.
    console.warn(`[project-os] operación rechazada: ${error.code}${requestId ? ` req=${requestId}` : ''}`)
  }
  return NextResponse.json(
    {
      ok: false,
      error: { codigo: error.code, mensaje: error.message, ...(error.fields ? { campos: error.fields } : {}), ...(error.detail ? { detalle: error.detail } : {}) },
      ...(requestId ? { requestId } : {}),
    },
    { status: error.status, headers: HEADERS },
  )
}

/**
 * Ejecuta una operación de escritura con todas las verificaciones del servidor.
 * `run` recibe el cuerpo JSON y el contexto del actor; solo se llama si la petición está autorizada.
 */
export async function handleWrite(
  request: Request,
  run: (body: unknown, ctx: OperationContext) => Promise<OperationResult>,
  successStatus: number,
) {
  let requestId: string | undefined
  try {
    const session = await getServerSession(authOptions)
    const { actor, body } = await evaluateWriteRequest(request, {
      email: session?.user?.email ?? null,
      env: process.env,
      limiter: writeRateLimiter(),
    })
    requestId = requestIdOf(body)
    const result = await run(body, { actor })
    bumpWriteGeneration()
    return NextResponse.json(
      { ok: true, ...result, modo: 'mock', requestId },
      { status: result.repetida ? 200 : successStatus, headers: HEADERS },
    )
  } catch (error) {
    if (error instanceof OperationError) return errorResponse(error, requestId)
    console.error('[project-os] error inesperado en operación:', error instanceof Error ? error.name : 'desconocido')
    return NextResponse.json(
      { ok: false, error: { codigo: 'error-interno', mensaje: 'No se pudo completar la operación.' } },
      { status: 500, headers: HEADERS },
    )
  }
}
