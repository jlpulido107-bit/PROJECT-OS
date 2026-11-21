import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { diferencias, leerYaml } from '../deploy/cloudrun/comparar.mjs'
import { render } from '../deploy/cloudrun/render.mjs'

/** comparar.mjs (ORD-POS-162): el lector de YAML de `deploy.sh --solo-imagen` y la comparación con la revisión activa. */
describe('leerYaml', () => {
  it('lee mapas, listas de mapas y escalares planos o entre comillas, siempre como texto', () => {
    const yaml = ['# comentario', 'a: uno', 'b:', '  c: \'2\'', '  # otro', '  d: "x y"', 'lista:', '  - name: N1', '    value: https://h.example.com',
      '  - name: N2', '    valueFrom:', '      secretKeyRef:', '        key: \'7\'', '    # __MARCADOR__', 'otro: 8080', ''].join('\n')
    expect(leerYaml(yaml)).toEqual({ a: 'uno', b: { c: '2', d: 'x y' },
      lista: [{ name: 'N1', value: 'https://h.example.com' }, { name: 'N2', valueFrom: { secretKeyRef: { key: '7' } } }], otro: '8080' })
  })

  it('lee el render completo de la plantilla, con escritura, sin perder variables', () => {
    const template = readFileSync(path.join(__dirname, '..', 'deploy', 'cloudrun', 'service.template.yaml'), 'utf8')
    const yaml = render(template, {
      SERVICE_NAME: 'project-os-dashboard', PROJECT_ID: 'project-os-511102', REGION: 'northamerica-south1',
      IMAGE: `us-docker.pkg.dev/proj-os-1/repo/dash@sha256:${'a'.repeat(64)}`, RUNTIME_SA: 'runtime@project-os-511102.iam.gserviceaccount.com',
      SERVICE_URL: 'https://dash.example.com', OAUTH_CLIENT_ID: '123-abc.apps.googleusercontent.com', SECRET_VERSION_NEXTAUTH: '1',
      SECRET_VERSION_OAUTH: '1', SECRET_VERSION_ALLOWLIST: '1', WRITE_MODE: 'sheets', WRITE_SERVICE_ACCOUNT: 'writer@project-os-511102.iam.gserviceaccount.com',
      SECRET_VERSION_WRITERS: '1', SECRET_VERSION_PM_AGENT: '7', DEPLOY_COMMIT_SHA: 'c'.repeat(40),
    })
    const servicio = leerYaml(yaml) as { spec: { template: { spec: { timeoutSeconds: string; containers: Array<{ env: Array<{ name: string }>; startupProbe: unknown }> } }; traffic: unknown } }
    const nombres = [...yaml.matchAll(/^ *- name: ([A-Z][A-Z0-9_]*)$/gm)].map((m) => m[1])
    expect(servicio.spec.template.spec.containers[0]!.env.map((e) => e.name)).toEqual(nombres)
    expect(nombres).toContain('DEPLOY_COMMIT_SHA')
    expect(servicio.spec.template.spec.timeoutSeconds).toBe('60')
    expect(servicio.spec.template.spec.containers[0]!.startupProbe).toEqual({ httpGet: { path: '/api/health', port: '8080' }, periodSeconds: '3', timeoutSeconds: '2', failureThreshold: '10' })
    expect(servicio.spec.traffic).toEqual([{ latestRevision: 'true', percent: '100' }])
  })

  it('falla cerrado ante sintaxis que no entiende, sin citar el contenido', () => {
    const malos = ['a: [1, 2]', 'a: {b: 1}', 'a: |\n  texto', 'a: &ancla x', 'a: uno # comentario', 'a: dos palabras', 'a: 1\na: 2', 'a:\n\tb: 1',
      '- suelto', 'a:\nb: 1', 'a: 1\n   b: 2', 'a: \'it\'\'s\'', 'a: "con \\" escape"', '---\na: 1', '']
    for (const malo of malos) expect(() => leerYaml(malo), malo).toThrow(/^(línea \d+: [^:]*|YAML vacío)$/)
  })
})

describe('diferencias', () => {
  const C = 'spec.template.spec.containers[0]'
  const base = () => ({ spec: { template: { spec: { timeoutSeconds: '60', containers: [{ image: 'nueva', env: [
    { name: 'A', value: 'x' }, { name: 'DEPLOY_COMMIT_SHA', value: 'nuevo' }, { name: 'S', valueFrom: { secretKeyRef: { name: 's', key: '1' } } }] }] } } } })
  const activa = () => ({ spec: { template: { spec: { timeoutSeconds: 60, containers: [{ image: 'vieja', env: [
    { name: 'A', value: 'x' }, { name: 'DEPLOY_COMMIT_SHA', value: 'viejo' }, { name: 'S', valueFrom: { secretKeyRef: { name: 's', key: '1' } } }] }] } } } })

  it('solo la imagen y DEPLOY_COMMIT_SHA distintas (o DEPLOY_COMMIT_SHA nueva): sin diferencias; números y texto se comparan por su texto', () => {
    expect(diferencias(base(), activa())).toEqual([])
    const sinCommit = activa()
    sinCommit.spec.template.spec.containers[0]!.env.splice(1, 1)
    expect(diferencias(base(), sinCommit)).toEqual([])
  })

  it('nombra la variable o el campo, nunca el valor', () => {
    const a = activa()
    a.spec.template.spec.containers[0]!.env[0]!.value = 'VALOR'
    a.spec.template.spec.containers[0]!.env[2]!.valueFrom!.secretKeyRef.key = '2'
    a.spec.template.spec.timeoutSeconds = 61
    expect(diferencias(base(), a)).toEqual(['A', 'S', 'spec.template.spec.timeoutSeconds'])
  })

  it('cuenta lo que falta en la activa, lo que sobra en ella y los tipos que no coinciden', () => {
    const a = activa() as ReturnType<typeof activa> & { spec: { template: { spec: Record<string, unknown> } } }
    a.spec.template.spec.containers[0]!.env.push({ name: 'SOBRA', value: 'v' })
    a.spec.template.spec.volumes = [{ name: 'datos', secret: { secretName: 'x' } }]
    const n = base() as ReturnType<typeof base> & { spec: { template: { spec: Record<string, unknown> } } }
    n.spec.template.spec.nuevoCampo = 'v'
    expect(diferencias(n, a)).toEqual(['SOBRA', 'spec.template.spec.nuevoCampo', 'spec.template.spec.volumes[datos].name', 'spec.template.spec.volumes[datos].secret.secretName'])
    expect(diferencias(base(), { spec: { template: { spec: { timeoutSeconds: { raro: 1 }, containers: 'no es lista' } } } })).toEqual([`${C.replace('[0]', '')}`, 'spec.template.spec.timeoutSeconds'])
    expect(diferencias(base(), null)).toEqual([''])
  })

  it('ignora solo lo que Cloud Run agrega por su cuenta', () => {
    const a = { ...activa(), status: { url: 'u' }, metadata: { uid: 'u', generation: 3, annotations: { 'serving.knative.dev/lastModifier': 'x', 'run.googleapis.com/otra': 'y' }, labels: { 'cloud.googleapis.com/location': 'r' } } }
    expect(diferencias(base(), a)).toEqual(['metadata.annotations.run.googleapis.com/otra'])
  })
})
