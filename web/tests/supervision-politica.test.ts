import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DictamenFila } from '@/components/operations/orden-filas'
import { extraerCriterios } from '@/lib/supervision/criterios'
import { MARCA_DICTAMEN, evaluarDictamen } from '@/lib/supervision/dictamen'
import { politicaDeRepo, repoSinCi } from '@/lib/supervision/politica'

/** Repositorios sin CI (ORD-POS-051): CONFORME con CI_AUSENTE y pruebas propias solo en SIGSAH y RADAROS. */
const HEAD = 'a'.repeat(40)
const CRITERIOS = '1. Uno'
const crit = extraerCriterios(CRITERIOS)
if (!crit.ok) throw new Error('criterios de prueba inválidos')

const reporte = (repo: string, extra: Record<string, unknown> = {}) => ({
  versionContrato: '1', versionPolitica: 'DEC-POS-008', ordenId: 'ORD-ECO-001', tareaId: 'ECO-001', proyectoId: 'ECO',
  repo, issue: 6, pr: 7, headSha: HEAD, baseSha: 'b'.repeat(40), hashCriterios: crit.hashCriterios,
  revisionId: 'REV-ORD-ECO-001-1', ejecucionId: 'EJE-1', intento: 1, ronda: 0,
  autorizacion: { otorgadaPor: 'propietario', orden: 'ORD-ECO-001', desde: '2026-10-20' },
  limiteConsumo: { presupuesto: '1 USD', tiempoMaximo: '30 min' },
  criterios: [{ id: '1', resultado: 'CUMPLE', evidencia: 'ok' }],
  evidencia: { propias: [{ comando: 'python -m unittest', sha: HEAD, codigoSalida: 0 }], ci: { estado: 'CI_AUSENTE' }, autor: [] },
  hallazgos: [], veredicto: 'CONFORME', ...extra,
})
const evaluar = (r: unknown, repo: string, riesgo = 'BAJO') => evaluarDictamen(
  { headSha: HEAD, comentarios: [{ id: 1, body: `${MARCA_DICTAMEN}\n\n\`\`\`json\n${JSON.stringify(r)}\n\`\`\`` }] },
  { id: 'ORD-ECO-001', riesgo, criterios: CRITERIOS }, { repo, numero: 7 })

describe('política de CI por repositorio', () => {
  it('solo SIGSAH y RADAROS, sin distinguir mayúsculas; PROJECT-OS y el resto requieren CI', () => {
    expect(['jlpulido107-bit/SIGSAH', 'JLPULIDO107-BIT/radaros', 'jlpulido107-bit/sigsah'].map(repoSinCi)).toEqual([true, true, true])
    expect(['jlpulido107-bit/PROJECT-OS', 'otro/SIGSAH', 'jlpulido107-bit/SIGSAH2', ''].map(repoSinCi)).toEqual([false, false, false, false])
    expect(politicaDeRepo('jlpulido107-bit/Radaros', ['1'])).toEqual({ ciRequerida: false, criteriosEsperados: ['1'] })
    expect(politicaDeRepo('jlpulido107-bit/project-os', ['1']).ciRequerida).toBe(true)
  })

  it.each(['jlpulido107-bit/RADAROS', 'jlpulido107-bit/radaros'])('repo sin CI (%s) con pruebas propias en verde: CONFORME', (repo) => {
    expect(evaluar(reporte(repo), repo)).toMatchObject({ siguiente: 'Listo para tu decisión', estado: { tipo: 'vigente', dictamen: { veredicto: 'CONFORME', sinCi: true } } })
    expect(evaluar(reporte(repo), repo, 'MEDIO').siguiente).toBe('Falta segundo revisor')
  })

  it.each([
    ['sin pruebas propias', { propias: [], ci: { estado: 'CI_AUSENTE' }, autor: [] }],
    ['prueba propia con salida 1', { propias: [{ comando: 'x', sha: HEAD, codigoSalida: 1 }], ci: { estado: 'CI_AUSENTE' }, autor: [] }],
    ['prueba propia de otro head', { propias: [{ comando: 'x', sha: 'c'.repeat(40), codigoSalida: 0 }], ci: { estado: 'CI_AUSENTE' }, autor: [] }],
    ['CI EXITO declarada en repo sin CI', { propias: [{ comando: 'x', sha: HEAD, codigoSalida: 0 }], ci: { estado: 'EXITO', sha: HEAD }, autor: [] }],
  ])('repo sin CI, %s: CONFORME no válido; sigue en INCONCLUSO', (_, evidencia) => {
    const repo = 'jlpulido107-bit/SIGSAH'
    expect(evaluar(reporte(repo, { evidencia }), repo).estado.tipo).toBe('invalido')
    const inconcluso = reporte(repo, { evidencia, criterios: [{ id: '1', resultado: 'NO_VERIFICADO', evidencia: 'sin pruebas' }], veredicto: 'INCONCLUSO' })
    expect(evaluar(inconcluso, repo)).toMatchObject({ siguiente: 'Revisar entradas del dictamen', estado: { dictamen: { veredicto: 'INCONCLUSO' } } })
  })

  it('PROJECT-OS con CI_AUSENTE sigue sin poder ser CONFORME, aunque el dictamen lo pida', () => {
    const repo = 'jlpulido107-bit/PROJECT-OS'
    expect(evaluar(reporte(repo), repo).estado.tipo).toBe('invalido')
    expect(evaluar(reporte(repo), 'JLPULIDO107-BIT/project-os').estado.tipo).toBe('invalido')
  })

  it('/ordenes muestra «sin CI · pruebas del revisor» solo en esas órdenes', () => {
    const fila = (repo: string, r: unknown) => renderToStaticMarkup(createElement(DictamenFila, { prUrl: `https://github.com/${repo}/pull/7`, ev: evaluar(r, repo) }))
    expect(fila('jlpulido107-bit/RADAROS', reporte('jlpulido107-bit/RADAROS'))).toContain('CONFORME · ronda 0 · 0 bloquean, 0 no · sin CI · pruebas del revisor')
    const pos = reporte('jlpulido107-bit/PROJECT-OS', { evidencia: { propias: [{ comando: 'x', sha: HEAD, codigoSalida: 0 }], ci: { estado: 'EXITO', sha: HEAD }, autor: [] } })
    expect(fila('jlpulido107-bit/PROJECT-OS', pos)).not.toContain('sin CI')
  })
})
