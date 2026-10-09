import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cacheSeconds, ConfigError, dataSource, serviceAccount, spreadsheetId } from '@/lib/config'

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv
// Clave falsa; la cabecera PEM se arma por partes para no disparar escáneres de secretos.
const PEM = 'PRIVATE ' + 'KEY'
const FAKE_KEY = `-----BEGIN ${PEM}-----\nFAKEFAKEFAKE\n-----END ${PEM}-----\n`

describe('configuración del servidor', () => {
  it('fuente de datos por defecto: sheets', () => {
    expect(dataSource(env({}))).toBe('sheets')
    expect(dataSource(env({ DASHBOARD_DATA_SOURCE: 'Fixtures' }))).toBe('fixtures')
    expect(() => dataSource(env({ DASHBOARD_DATA_SOURCE: 'csv' }))).toThrow(ConfigError)
  })

  it('los datos sintéticos se prohíben en Cloud Run (K_SERVICE)', () => {
    expect(() => dataSource(env({ DASHBOARD_DATA_SOURCE: 'fixtures', K_SERVICE: 'project-os-dashboard' }))).toThrow(/Cloud Run/)
    expect(dataSource(env({ K_SERVICE: 'project-os-dashboard' }))).toBe('sheets')
  })

  it('caché acotada a 0–300 s', () => {
    expect(cacheSeconds(env({}))).toBe(60)
    expect(cacheSeconds(env({ DASHBOARD_CACHE_SECONDS: '0' }))).toBe(0)
    expect(cacheSeconds(env({ DASHBOARD_CACHE_SECONDS: '9999' }))).toBe(300)
    expect(() => cacheSeconds(env({ DASHBOARD_CACHE_SECONDS: '-1' }))).toThrow(ConfigError)
  })

  it('valida el ID de la hoja', () => {
    expect(() => spreadsheetId(env({}))).toThrow(ConfigError)
    expect(() => spreadsheetId(env({ SHEETS_SPREADSHEET_ID: 'abc/../x' }))).toThrow(ConfigError)
    expect(spreadsheetId(env({ SHEETS_SPREADSHEET_ID: ' 16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic ' }))).toBe(
      '16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic',
    )
  })

  it('el ID de .env.example coincide con config/projects.json', () => {
    const example = readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8')
    const fromExample = /^SHEETS_SPREADSHEET_ID=(.+)$/m.exec(example)?.[1]
    const config = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'config', 'projects.json'), 'utf8'))
    expect(fromExample).toBe(config.spreadsheet_id)
  })

  it('acepta solo credenciales de cuenta de servicio y nunca repite su contenido en errores', () => {
    const json = JSON.stringify({ type: 'service_account', client_email: 'lector@proyecto.iam.gserviceaccount.com', private_key: FAKE_KEY })
    expect(serviceAccount(env({ PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON: json }))).toEqual({
      clientEmail: 'lector@proyecto.iam.gserviceaccount.com',
      privateKey: FAKE_KEY,
    })
    const cases = [
      env({}),
      env({ PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON: '{no-json FAKEFAKEFAKE' }),
      env({ PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: 'authorized_user', refresh_token: 'FAKEFAKEFAKE' }) }),
      env({ PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_FILE: '/ruta/inexistente/FAKEFAKEFAKE.json' }),
    ]
    for (const c of cases) {
      let message = ''
      try {
        serviceAccount(c)
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError)
        message = (error as Error).message
      }
      expect(message).not.toBe('')
      expect(message).not.toContain('FAKEFAKEFAKE')
    }
  })
})
