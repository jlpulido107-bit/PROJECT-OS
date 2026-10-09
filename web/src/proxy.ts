import type { NextRequest } from 'next/server'
import { decide, respond } from './lib/authz'

/**
 * Primera barrera: ninguna página ni API privada se procesa sin sesión válida y correo permitido.
 * Cada página y API vuelve a verificar la sesión en el servidor (defensa en profundidad).
 */
export async function proxy(request: NextRequest) {
  return respond(await decide(request), request)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
