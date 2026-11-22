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

  describe('ORD-POS-171: lo que administra Google y el maxScale de servicio', () => {
    const MAX = 'metadata.annotations.run.googleapis.com/maxScale'
    const PZS = 'metadata.labels.run.googleapis.com/satisfiesPzs'
    const anot = (max: string) => ({ annotations: { 'autoscaling.knative.dev/minScale': '0', 'autoscaling.knative.dev/maxScale': max } })
    const nuevo = (meta: Record<string, unknown> = {}) => {
      const n = base() as ReturnType<typeof base> & { metadata?: unknown; spec: { template: { metadata?: unknown } } }
      n.spec.template.metadata = anot('1')
      n.metadata = { labels: { app: 'project-os' }, annotations: { 'run.googleapis.com/ingress': 'all' }, ...meta }
      return n
    }
    const real = (anotaciones: Record<string, unknown>, etiquetas: Record<string, unknown>, maxRevision = '1') => {
      const a = activa() as ReturnType<typeof activa> & { metadata?: unknown; spec: { template: { metadata?: unknown } } }
      a.spec.template.metadata = anot(maxRevision)
      a.metadata = { labels: { app: 'project-os', ...etiquetas }, annotations: { 'run.googleapis.com/ingress': 'all', ...anotaciones } }
      return a
    }

    it('reproduce la ejecución 45065790263: satisfiesPzs y un maxScale de servicio igual al de revisión no son diferencias', () => {
      expect(diferencias(nuevo(), real({ 'run.googleapis.com/maxScale': '1' }, { 'run.googleapis.com/satisfiesPzs': 'true' }))).toEqual([])
      expect(diferencias(nuevo(), real({ 'run.googleapis.com/maxScale': 1 }, { 'run.googleapis.com/satisfiesPzs': 'false' }))).toEqual([])
    })

    it('un maxScale distinto de verdad sigue deteniendo: de servicio, de revisión o sin tope de revisión en el YAML', () => {
      for (const valor of ['3', '2', '0', '', '01', ' 1', true, null, { v: '1' }]) {
        expect(diferencias(nuevo(), real({ 'run.googleapis.com/maxScale': valor }, {})), JSON.stringify(valor)).toEqual([valor !== null && typeof valor === 'object' ? `${MAX}.v` : MAX])
      }
      const REV = 'spec.template.metadata.annotations.autoscaling.knative.dev/maxScale'
      // La revisión activa con tope 3: detiene, coincida o no el de servicio con el del YAML.
      expect(diferencias(nuevo(), real({}, {}, '3'))).toEqual([REV])
      expect(diferencias(nuevo(), real({ 'run.googleapis.com/maxScale': '1' }, {}, '3'))).toEqual([REV])
      expect(diferencias(nuevo(), real({ 'run.googleapis.com/maxScale': '3' }, {}, '3'))).toEqual([MAX, REV])
      // Un YAML sin tope de revisión no tiene con qué igualar el de servicio.
      const sinTope = nuevo()
      ;(sinTope.spec.template.metadata as { annotations: Record<string, string> }).annotations = { 'autoscaling.knative.dev/minScale': '0' }
      expect(diferencias(sinTope, real({ 'run.googleapis.com/maxScale': '1' }, {}))).toEqual([MAX, REV])
      // Si el YAML trae el tope de servicio, se compara como cualquier campo.
      const conTope = nuevo({ annotations: { 'run.googleapis.com/ingress': 'all', 'run.googleapis.com/maxScale': '1' } })
      expect(diferencias(conTope, real({ 'run.googleapis.com/maxScale': '1' }, {}))).toEqual([])
      expect(diferencias(conTope, real({ 'run.googleapis.com/maxScale': '3' }, {}))).toEqual([MAX])
      expect(diferencias(conTope, real({}, {}))).toEqual([MAX])
    })

    it('la lista es cerrada: otras etiquetas o anotaciones de Google, o las mismas en otro nivel, siguen deteniendo', () => {
      expect(diferencias(nuevo(), real({ 'run.googleapis.com/minScale': '1', 'run.googleapis.com/launch-stage': 'BETA' }, { 'run.googleapis.com/satisfiesPzi': 'true', otra: 'x' })))
        .toEqual(['metadata.annotations.run.googleapis.com/launch-stage', 'metadata.annotations.run.googleapis.com/minScale', 'metadata.labels.otra', 'metadata.labels.run.googleapis.com/satisfiesPzi'])
      const a = real({}, {})
      a.spec.template.metadata = { ...anot('1'), labels: { 'run.googleapis.com/satisfiesPzs': 'true' } }
      ;(a.spec.template.metadata as { annotations: Record<string, string> }).annotations['run.googleapis.com/maxScale'] = '1'
      expect(diferencias(nuevo(), a)).toEqual(['spec.template.metadata.annotations.run.googleapis.com/maxScale', 'spec.template.metadata.labels.run.googleapis.com/satisfiesPzs'])
      // Un YAML que quisiera fijar satisfiesPzs con otro valor no pasa por ser «del sistema».
      expect(diferencias(nuevo({ labels: { app: 'project-os', 'run.googleapis.com/satisfiesPzs': 'true' } }), real({}, { 'run.googleapis.com/satisfiesPzs': 'false' }))).toEqual([PZS])
    })
  })
})
