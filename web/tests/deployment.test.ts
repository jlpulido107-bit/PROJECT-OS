import { describe, expect, it } from 'vitest'
import { authProblems, deploymentProblems } from '@/lib/deployment'

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv
const SECRET = 'x'.repeat(44)
const SA = 'project-os-dashboard-run@proyecto.iam.gserviceaccount.com'
const AUTH = {
  NEXTAUTH_SECRET: SECRET,
  GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'secreto',
  AUTH_ALLOWED_EMAILS: 'revisor@example.com',
}
const CLOUD_RUN = {
  ...AUTH,
  K_SERVICE: 'project-os-dashboard',
  NODE_ENV: 'production',
  NEXTAUTH_URL: 'https://project-os-dashboard-000000000000.us-central1.run.app',
  SHEETS_SPREADSHEET_ID: '16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic',
  SHEETS_CREDENTIALS: 'adc',
  SHEETS_EXPECTED_SERVICE_ACCOUNT: SA,
}

describe('comprobaciones de despliegue', () => {
  it('configuración de Cloud Run correcta → sin problemas', () => {
    expect(deploymentProblems(env(CLOUD_RUN))).toEqual([])
  })

  it('local con http://localhost y datos sintéticos → sin problemas', () => {
    expect(deploymentProblems(env({ ...AUTH, NODE_ENV: 'production', NEXTAUTH_URL: 'http://127.0.0.1:3000', DASHBOARD_DATA_SOURCE: 'fixtures' }))).toEqual([])
  })

  it('detecta secretos y allowlist ausentes o débiles', () => {
    expect(authProblems(env({ NEXTAUTH_URL: 'http://localhost:3000' }))).toEqual(['nextauth-secret', 'oauth-client', 'allowed-emails'])
    expect(authProblems(env({ ...AUTH, NEXTAUTH_SECRET: 'corto', NEXTAUTH_URL: 'http://localhost:3000' }))).toEqual(['nextauth-secret'])
    expect(authProblems(env({ ...AUTH, AUTH_ALLOWED_EMAILS: 'no-es-correo', NEXTAUTH_URL: 'http://localhost:3000' }))).toEqual([
      'allowed-emails',
    ])
  })

  it('exige NEXTAUTH_URL HTTPS en Cloud Run y en producción fuera de localhost', () => {
    expect(authProblems(env({ ...CLOUD_RUN, NEXTAUTH_URL: 'http://project-os-dashboard.run.app' }))).toEqual(['nextauth-url-https'])
    expect(authProblems(env({ ...CLOUD_RUN, NEXTAUTH_URL: 'http://localhost:8080' }))).toEqual(['nextauth-url-https'])
    expect(authProblems(env({ ...AUTH, NODE_ENV: 'production', NEXTAUTH_URL: 'http://panel.example.com' }))).toEqual(['nextauth-url-https'])
    expect(authProblems(env({ ...AUTH, NEXTAUTH_URL: 'no es url' }))).toEqual(['nextauth-url'])
    expect(authProblems(env(AUTH))).toEqual(['nextauth-url'])
  })

  it('configuraciones de datos inseguras en Cloud Run → data-config', () => {
    expect(deploymentProblems(env({ ...CLOUD_RUN, DASHBOARD_DATA_SOURCE: 'fixtures' }))).toEqual(['data-config'])
    expect(deploymentProblems(env({ ...CLOUD_RUN, SHEETS_EXPECTED_SERVICE_ACCOUNT: '' }))).toEqual(['data-config'])
    expect(deploymentProblems(env({ ...CLOUD_RUN, SHEETS_CREDENTIALS: 'service-account-key', PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_FILE: '/k.json' }))).toEqual([
      'data-config',
    ])
    expect(deploymentProblems(env({ ...CLOUD_RUN, SHEETS_SPREADSHEET_ID: '' }))).toEqual(['data-config'])
  })
})
