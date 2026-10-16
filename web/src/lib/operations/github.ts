/**
 * Issue de las órdenes aprobadas en GitHub (V1.8 F4, docs/plan-v1-8-automatizacion.md). Desde 2026-10-14 las ejecuta
 * Claude en la sesión del repositorio (skill `/ejecutar-orden`); el propietario decide con Codex/ChatGPT.
 *
 * - Solo los 3 repositorios del propietario (lista fija en código: nunca se toma el repositorio de la hoja).
 * - Idempotente: antes de crear, busca un issue cuyo título empiece por `[ORDEN_ID]`; si existe, lo reutiliza.
 * - No menciona a `@codex`. El propietario lanza la ejecución con el texto de `textoParaEjecutar` (botón «Copiar para
 *   Claude» del dashboard).
 * - Token de GitHub de grano fino (Issues: lectura/escritura; Pull requests: lectura) solo para esos repositorios, leído de
 *   GITHUB_DISPATCH_TOKEN (Secret Manager). Errores sin cuerpo: solo el estado HTTP.
 * - Nunca fusiona, nunca toca código ni ramas.
 */

export const REPOSITORIOS: Readonly<Record<string, string>> = Object.freeze({
  POS: 'jlpulido107-bit/PROJECT-OS',
  SIG: 'jlpulido107-bit/SIGSAH',
  ECO: 'jlpulido107-bit/RADAROS',
})

const API = 'https://api.github.com'
const TIMEOUT_MS = 15_000
const MAX_PAGES = 5
/** Cuenta con la que el conector de Codex comenta y puede abrir PRs. */
const CODEX_BOT = 'chatgpt-codex-connector[bot]'
/** Primera línea del comentario con el que el dashboard deja constancia de que lanzó a Claude (F5a). */
export const MARCA_CLAUDE = 'Claude · ejecución lanzada desde el dashboard'
const SESION_CLAUDE = /https:\/\/claude\.ai\/code\/[A-Za-z0-9_/-]{1,200}/

export interface OrdenParaEnviar {
  ordenId: string
  proyectoId: string
  tareaId: string
  titulo: string
  objetivo: string
  contexto: string
  criterios: string
  fueraDeAlcance: string
  comoProbar: string
  riesgo: string
}

export interface ResultadoEnvio {
  issueUrl: string
  issueNumber: number
  /** true si el issue se creó ahora; false si ya existía. */
  creado: boolean
}

export interface PrDeOrden {
  url: string
  number: number
  estado: 'abierto' | 'fusionado' | 'cerrado'
  /** SHA completo (40 hex) del último commit de la rama del PR. */
  headSha: string
  /** SHA completo (40 hex) de la base del PR. */
  baseSha: string
}

const SHA_COMPLETO = /^[0-9a-f]{40}$/

export class GitHubError extends Error {
  constructor(readonly status: number | 'red' | 'repo-no-permitido' | 'respuesta-invalida') {
    super(`github ${status}`)
  }
}

export function repoDe(proyectoId: string): string {
  const repo = REPOSITORIOS[proyectoId]
  if (!repo) throw new GitHubError('repo-no-permitido')
  return repo
}

/** Repositorio (OWNER/REPO) de una URL `https://github.com/OWNER/REPO/issues|pull/N` permitida, o null. */
export function repoDeUrl(url: string, tipo: 'issues' | 'pull'): string | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/(issues|pull)\/(\d{1,7})$/.exec(url)
  if (!m || m[2] !== tipo) return null
  return Object.values(REPOSITORIOS).find((r) => r.toLowerCase() === m[1]!.toLowerCase()) ?? null
}

/** `https://github.com/OWNER/REPO/issues|pull/N` de uno de los repositorios permitidos. */
export function urlGitHubPermitida(url: string, tipo: 'issues' | 'pull'): boolean {
  return repoDeUrl(url, tipo) !== null
}

/**
 * Texto de la orden seguro para GitHub: sin comentarios HTML (ocultos al propietario pero no a Codex) y sin menciones
 * (`@usuario`, `@codex` dentro del texto no avisan a nadie ni lanzan tareas extra).
 */
export function textoSeguro(text: string): string {
  return text.replace(/<!--[\s\S]*?(-->|$)/g, '').replace(/@(?=[A-Za-z0-9])/g, '@\u200b')
}

export function cuerpoIssue(orden: OrdenParaEnviar): string {
  const o = Object.fromEntries(Object.entries(orden).map(([k, v]) => [k, textoSeguro(v)])) as unknown as OrdenParaEnviar
  return [
    '### ID de la tarea',
    `${o.tareaId} (orden ${o.ordenId}, aprobada por el propietario desde el dashboard de PROJECT-OS)`,
    '',
    '### Objetivo',
    o.objetivo,
    '',
    '### Contexto y archivos',
    o.contexto || 'Ver `AGENTS.md` del repositorio.',
    '',
    '### Criterios de aceptación',
    o.criterios,
    '',
    '### Fuera de alcance',
    o.fueraDeAlcance,
    '',
    '### Cómo probar',
    o.comoProbar,
    '',
    '### Riesgo',
    o.riesgo === 'MEDIO' ? 'Medio (con supervisión)' : 'Bajo',
    '',
    '---',
    `PR con \`[${o.ordenId}]\` en el título y \`Closes #N\` (este issue). No fusionar ni desplegar.`,
  ].join('\n')
}

/**
 * Texto que el propietario pega en la sesión de Claude del repositorio para que ejecute la orden. Es el mismo contenido
 * del issue, más las instrucciones de entrega: rama propia, PR con `[ORDEN_ID]` en el título y `Closes` el issue.
 */
export function textoParaEjecutar(o: OrdenParaEnviar, issueUrl: string): string {
  const repo = repoDe(o.proyectoId)
  const n = /\/issues\/(\d+)$/.exec(issueUrl)?.[1]
  return [
    `Ejecuta la orden ${o.ordenId} (aprobada en el dashboard) con /ejecutar-orden. Repositorio: ${repo} (rama base: main). Issue: ${issueUrl}.`,
    'Sigue AGENTS.md. Trabaja en una rama propia; nunca en main.',
    `Abre un PR con \`[${o.ordenId}]\` al inicio del título y \`Closes #${n ?? '?'}\` en la descripción.`,
    'Pega en el PR la salida de las pruebas. No fusiones ni despliegues.',
    '',
    `# [${o.ordenId}][${o.tareaId}] ${textoSeguro(o.titulo)}`,
    '',
    cuerpoIssue(o),
  ].join('\n')
}

/** Texto para ejecutar una orden ENVIADA con issue de su repositorio; null si no aplica. */
export function textoParaEjecutarDeOrden(o: {
  id: string; proyectoId: string | null; tareaId: string | null; titulo: string | null; objetivo: string | null
  contexto: string | null; criterios: string | null; fueraDeAlcance: string | null; comoProbar: string | null
  riesgo: string | null; estado: string | null; issueUrl: string | null
}): string | null {
  if (o.estado !== 'ENVIADA' || !o.issueUrl || !o.proyectoId || !REPOSITORIOS[o.proyectoId]) return null
  if (repoDeUrl(o.issueUrl, 'issues') !== REPOSITORIOS[o.proyectoId]) return null
  return textoParaEjecutar({
    ordenId: o.id, proyectoId: o.proyectoId, tareaId: o.tareaId ?? '', titulo: o.titulo ?? '', objetivo: o.objetivo ?? '',
    contexto: o.contexto ?? '', criterios: o.criterios ?? '', fueraDeAlcance: o.fueraDeAlcance ?? '',
    comoProbar: o.comoProbar ?? '', riesgo: o.riesgo ?? 'BAJO',
  }, o.issueUrl)
}

/** Repositorio y número de un issue que debe ser del repositorio del proyecto. */
function issueDeProyecto(proyectoId: string, issueUrl: string): { repo: string; number: number } {
  const repo = repoDe(proyectoId)
  const n = /\/issues\/(\d{1,7})$/.exec(issueUrl)?.[1]
  if (repoDeUrl(issueUrl, 'issues') !== repo || !n) throw new GitHubError('repo-no-permitido')
  return { repo, number: Number(n) }
}

export function createGitHubClient(token: string, fetchImpl: typeof fetch = fetch) {
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await fetchImpl(API + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'project-os-dashboard',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      })
    } catch {
      throw new GitHubError('red')
    }
    // Nunca se lee ni se propaga el cuerpo de un error.
    if (!response.ok) throw new GitHubError(response.status)
    try {
      return (await response.json()) as T
    } catch {
      throw new GitHubError('respuesta-invalida')
    }
  }

  interface User { login?: string }
  interface IssueApi { number: number; title: string; html_url: string; pull_request?: unknown; state: string; user?: User }

  // Solo cuenta lo que creó la cuenta del token: un issue o comentario ajeno con el mismo prefijo no puede
  // «capturar» una orden ni suprimir la mención (los repositorios podrían recibir issues de terceros).
  let me: string | null = null
  async function cuentaPropia(): Promise<string> {
    me ??= (await call<User>('GET', '/user')).login?.toLowerCase() ?? ''
    if (!me) throw new GitHubError('respuesta-invalida')
    return me
  }
  const esPropio = (u: User | undefined, login: string) => (u?.login ?? '').toLowerCase() === login

  async function buscarIssue(repo: string, ordenId: string): Promise<IssueApi | null> {
    const prefix = `[${ordenId}]`
    const login = await cuentaPropia()
    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = await call<IssueApi[]>('GET', `/repos/${repo}/issues?state=all&creator=${encodeURIComponent(login)}&per_page=100&page=${page}`)
      const hit = items.find((i) => !i.pull_request && i.title.startsWith(prefix) && esPropio(i.user, login))
      if (hit) return hit
      if (items.length < 100) return null
    }
    return null
  }

  return {
    /** Crea (o reutiliza) el issue de la orden. No menciona a nadie. */
    async enviar(o: OrdenParaEnviar): Promise<ResultadoEnvio> {
      const repo = repoDe(o.proyectoId)
      const existente = await buscarIssue(repo, o.ordenId)
      const issue = existente ?? await call<IssueApi>('POST', `/repos/${repo}/issues`, {
        title: `[${o.ordenId}][${o.tareaId}] ${textoSeguro(o.titulo)}`,
        body: cuerpoIssue(o),
      })
      return { issueUrl: issue.html_url, issueNumber: issue.number, creado: !existente }
    },

    /** Sesión de Claude ya lanzada para el issue de la orden (comentario propio con MARCA_CLAUDE), o null. */
    async lanzamientoPrevio(proyectoId: string, issueUrl: string): Promise<string | null> {
      const { repo, number } = issueDeProyecto(proyectoId, issueUrl)
      const login = await cuentaPropia()
      const comentarios = await call<Array<{ body?: string; user?: User }>>('GET', `/repos/${repo}/issues/${number}/comments?per_page=100`)
      const propio = comentarios.filter((c) => esPropio(c.user, login) && (c.body ?? '').startsWith(MARCA_CLAUDE)).pop()
      return propio ? (SESION_CLAUDE.exec(propio.body ?? '')?.[0] ?? null) : null
    },

    /** Deja constancia en el issue de la sesión de Claude lanzada (sin menciones). */
    async registrarLanzamiento(proyectoId: string, issueUrl: string, sessionUrl: string): Promise<void> {
      const { repo, number } = issueDeProyecto(proyectoId, issueUrl)
      if (!SESION_CLAUDE.test(sessionUrl)) throw new GitHubError('respuesta-invalida')
      await call('POST', `/repos/${repo}/issues/${number}/comments`, {
        body: `${MARCA_CLAUDE}\n\nSesión: ${sessionUrl}\n\nClaude abrirá un PR con el ID de la orden en el título y \`Closes\` este issue. No fusiona ni despliega.`,
      })
    },

    /** PR cuyo título empieza por `[ORDEN_ID]` (el más reciente), o null. Solo lectura. */
    async prDeOrden(proyectoId: string, ordenId: string): Promise<PrDeOrden | null> {
      const repo = repoDe(proyectoId)
      const login = await cuentaPropia()
      const prs = await call<Array<{
        number: number; title: string; html_url: string; state: string; merged_at: string | null; user?: User
        head?: { sha?: unknown; repo?: { full_name?: string } | null }; base?: { sha?: unknown }
      }>>('GET', `/repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=50`)
      // Solo PRs de la cuenta del propietario o del conector de Codex, desde el mismo repositorio (nunca de un fork).
      const pr = prs.find((p) =>
        p.title.startsWith(`[${ordenId}]`) &&
        (esPropio(p.user, login) || (p.user?.login ?? '').toLowerCase() === CODEX_BOT) &&
        (p.head?.repo?.full_name ?? '').toLowerCase() === repo.toLowerCase())
      if (!pr) return null
      // Un PR identificado sin SHA válidos es una respuesta inválida, no «sin PR»: nunca se fabrican valores.
      const { sha: headSha } = pr.head ?? {}
      const { sha: baseSha } = pr.base ?? {}
      if (typeof headSha !== 'string' || typeof baseSha !== 'string' || !SHA_COMPLETO.test(headSha) || !SHA_COMPLETO.test(baseSha)) {
        throw new GitHubError('respuesta-invalida')
      }
      return { url: pr.html_url, number: pr.number, estado: pr.merged_at ? 'fusionado' : pr.state === 'open' ? 'abierto' : 'cerrado', headSha, baseSha }
    },
  }
}

export type GitHubClient = ReturnType<typeof createGitHubClient>
