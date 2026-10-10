import type { NextConfig } from 'next'

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  // Los navegadores solo aplican HSTS sobre HTTPS (Cloud Run); en http://localhost se ignora.
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
]

const nextConfig: NextConfig = {
  // La imagen Docker compila con NEXT_OUTPUT=standalone (servidor autocontenido mínimo);
  // el flujo local (`npm run build && npm start`) no cambia.
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined,
  poweredByHeader: false,
  // En desarrollo Next registra cada petición con su query string; las de /api/auth/* incluyen el
  // código OAuth de un solo uso (?code=…). No se registran para no dejar credenciales en logs.
  logging: { incomingRequests: { ignore: [/\/api\/auth\//] } },
  reactStrictMode: true,
  // Las credenciales de Google solo existen en el servidor; nunca se exponen con NEXT_PUBLIC_.
  serverExternalPackages: ['google-auth-library'],
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      {
        // Datos privados: ningún proxy ni navegador debe guardar copias compartidas.
        source: '/((?!_next/static|_next/image|favicon.ico).*)',
        headers: [{ key: 'Cache-Control', value: 'private, no-store, max-age=0' }],
      },
    ]
  },
}

export default nextConfig
