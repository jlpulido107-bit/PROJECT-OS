/**
 * Envío de órdenes aprobadas a Codex vía GitHub (V1.8 F4, docs/plan-v1-8-automatizacion.md).
 *
 * - Solo los 3 repositorios del propietario (lista fija en código: nunca se toma el repositorio de la hoja).
 * - Idempotente: antes de crear, busca un issue cuyo título empiece por `[ORDEN_ID]`; si existe, lo reutiliza. La
 *   mención a `@codex` tampoco se repite si ya está.
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
const CODEX_MENTION = '@codex'

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
  /** true si se publicó la mención a Codex ahora; false si ya estaba. */
  mencionado: boolean
}

export interface PrDeOrden {
  url: string
  number: number
  estado: 'abierto' | 'fusionado' | 'cerrado'
}

export class GitHubError extends Error {
  constructor(readonly status: number | 'red' | 'repo-no-permitido') {
    super(`github ${status}`)
  }
}

export function repoDe(proyectoId: string): string {
  const repo = REPOSITORIOS[proyectoId]
  if (!repo) throw new GitHubError('repo-no-permitido')
  return repo
}

/** `https://github.com/OWNER/REPO/issues|pull/N` de uno de los repositorios permitidos. */
export function urlGitHubPermitida(url: string, tipo: 'issues' | 'pull'): boolean {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/(issues|pull)\/(\d{1,7})$/.exec(url)
  return Boolean(m && m[2] === tipo && Object.values(REPOSITORIOS).some((r) => r.toLowerCase() === m[1]!.toLowerCase()))
}

export function cuerpoIssue(o: OrdenParaEnviar): string {
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

export function comentarioCodex(o: OrdenParaEnviar): string {
  return `${CODEX_MENTION} resuelve este issue. Sigue \`AGENTS.md\` y abre un PR con \`[${o.ordenId}]\` en el título y \`Closes\` este issue. Pega en el PR la salida de las pruebas. No fusiones ni despliegues.`
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
    return (await response.json()) as T
  }

  interface IssueApi { number: number; title: string; html_url: string; pull_request?: unknown; state: string; merged_at?: string | null }

  async function buscarIssue(repo: string, ordenId: string): Promise<IssueApi | null> {
    const prefix = `[${ordenId}]`
    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = await call<IssueApi[]>('GET', `/repos/${repo}/issues?state=all&per_page=100&page=${page}`)
      const hit = items.find((i) => !i.pull_request && i.title.startsWith(prefix))
      if (hit) return hit
      if (items.length < 100) return null
    }
    return null
  }

  return {
    /** Crea (o reutiliza) el issue de la orden y menciona a Codex una sola vez. */
    async enviar(o: OrdenParaEnviar): Promise<ResultadoEnvio> {
      const repo = repoDe(o.proyectoId)
      let issue = await buscarIssue(repo, o.ordenId)
      const creado = !issue
      if (!issue) {
        issue = await call<IssueApi>('POST', `/repos/${repo}/issues`, {
          title: `[${o.ordenId}][${o.tareaId}] ${o.titulo}`,
          body: cuerpoIssue(o),
        })
      }
      const comentarios = creado
        ? []
        : await call<Array<{ body?: string }>>('GET', `/repos/${repo}/issues/${issue.number}/comments?per_page=100`)
      const yaMencionado = comentarios.some((c) => (c.body ?? '').includes(CODEX_MENTION))
      if (!yaMencionado) await call('POST', `/repos/${repo}/issues/${issue.number}/comments`, { body: comentarioCodex(o) })
      return { issueUrl: issue.html_url, issueNumber: issue.number, creado, mencionado: !yaMencionado }
    },

    /** PR cuyo título empieza por `[ORDEN_ID]` (el más reciente), o null. Solo lectura. */
    async prDeOrden(proyectoId: string, ordenId: string): Promise<PrDeOrden | null> {
      const repo = repoDe(proyectoId)
      const prs = await call<Array<{ number: number; title: string; html_url: string; state: string; merged_at: string | null }>>(
        'GET', `/repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=50`,
      )
      const pr = prs.find((p) => p.title.startsWith(`[${ordenId}]`))
      if (!pr) return null
      return { url: pr.html_url, number: pr.number, estado: pr.merged_at ? 'fusionado' : pr.state === 'open' ? 'abierto' : 'cerrado' }
    },
  }
}

export type GitHubClient = ReturnType<typeof createGitHubClient>
