import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/** deploy/ci/imagen.sh y humo.sh (ORD-POS-162) con docker, gcloud y el humo remoto simulados en PATH: nada sale a la red. */
const CI = path.join(__dirname, '..', 'deploy', 'ci')
const WEB = path.join(__dirname, '..')
const SHA = '0123456789abcdef0123456789abcdef01234567'
const RUTA = 'northamerica-south1-docker.pkg.dev/project-os-511102/project-os/dashboard'
const DIGEST = `sha256:${'d'.repeat(64)}`
const IMAGE = `${RUTA}@${DIGEST}`

let dir: string
let log: string
const falso = (nombre: string, cuerpo: string) => {
  writeFileSync(path.join(dir, nombre), `#!/usr/bin/env bash\n${cuerpo}\n`)
  chmodSync(path.join(dir, nombre), 0o755)
}
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'deploy-ci-'))
  log = path.join(dir, 'llamadas.log')
  writeFileSync(log, '')
  // docker: registra la llamada; el push imprime lo que diga DOCKER_PUSH_SALIDA y sale con DOCKER_PUSH_CODIGO.
  falso('docker', `echo "docker $*" >> "$LLAMADAS"
case "$1" in
  build) echo "construyendo (falso)"; exit "\${DOCKER_BUILD_CODIGO:-0}" ;;
  push) printf '%s\\n' "$DOCKER_PUSH_SALIDA"; exit "\${DOCKER_PUSH_CODIGO:-0}" ;;
esac`)
  // gcloud: describe devuelve el siguiente archivo de GCLOUD_SERVICIOS (uno por llamada; repite el último).
  falso('gcloud', `echo "gcloud $*" >> "$LLAMADAS"
case "$*" in
  *"services describe"*)
    n=$(grep -c "services describe" "$LLAMADAS")
    archivo=$(echo "$GCLOUD_SERVICIOS" | cut -d: -f"$n")
    [ -n "$archivo" ] || archivo=$(echo "$GCLOUD_SERVICIOS" | awk -F: '{print $NF}')
    cat "$archivo" ;;
  *"update-traffic"*) echo "SALIDA-DE-GCLOUD-QUE-NO-SE-MUESTRA"; exit "\${GCLOUD_TRAFICO_CODIGO:-0}" ;;
esac`)
  // node: el humo remoto no sale a la red; lo demás es el node real.
  falso('node', `case "$1" in *smoke-remote.mjs) echo "node $*" >> "$LLAMADAS"; echo "humo (falso)"; exit "\${HUMO_CODIGO:-0}" ;; esac
exec "${process.execPath}" "$@"`)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [path.join(CI, script), ...args], {
    cwd: dir, encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}`, LLAMADAS: log, ...env } as unknown as NodeJS.ProcessEnv,
  })
  return { code: r.status, stdout: r.stdout, out: `${r.stdout}${r.stderr}`, calls: readFileSync(log, 'utf8') }
}

describe('imagen.sh', () => {
  const push = (salida: string) => ({ DEPLOY_COMMIT_SHA: SHA, DOCKER_PUSH_SALIDA: salida })
  const BUENA = `The push refers to repository [${RUTA}]\n5f70bf18a086: Pushed\n${SHA}: digest: ${DIGEST} size: 1994`

  it('construir: docker build de web/ para linux/amd64 con la etiqueta del commit; no publica ni imprime nada por stdout', () => {
    const r = run('imagen.sh', ['construir'], { DEPLOY_COMMIT_SHA: SHA })
    expect(r.code).toBe(0)
    expect(r.calls).toBe(`docker build --platform linux/amd64 -t ${RUTA}:${SHA} ${WEB}\n`)
    expect(r.stdout).toBe('')
  })

  it('construir: si docker build falla, falla', () => {
    expect(run('imagen.sh', ['construir'], { DEPLOY_COMMIT_SHA: SHA, DOCKER_BUILD_CODIGO: '1' }).code).toBe(1)
  })

  it('publicar: empuja la etiqueta del commit e imprime por stdout solo la imagen por digest', () => {
    const r = run('imagen.sh', ['publicar'], push(BUENA))
    expect(r.code).toBe(0)
    expect(r.calls).toBe(`docker push ${RUTA}:${SHA}\n`)
    expect(r.stdout).toBe(`${IMAGE}\n`)
  })

  it('publicar: digest ausente, corto, en mayúsculas o repetido con valores distintos: se detiene sin imprimir imagen', () => {
    const malas = ['sin digest', `${SHA}: digest: sha256:${'d'.repeat(63)} size: 1`, `${SHA}: digest: sha256:${'D'.repeat(64)} size: 1`,
      `${SHA}: digest: sha256:${'d'.repeat(65)} size: 1`, `a: digest: ${DIGEST} size: 1\nb: digest: sha256:${'e'.repeat(64)} size: 1`]
    for (const salida of malas) {
      const r = run('imagen.sh', ['publicar'], push(salida))
      expect(r.code).toBe(1)
      expect(r.out).toContain('DETENTE: el push no devolvió un único digest sha256 bien formado')
      expect(r.stdout).toBe('')
    }
  })

  it('publicar: si docker push falla, se detiene sin imprimir imagen aunque la salida traiga un digest', () => {
    const r = run('imagen.sh', ['publicar'], { ...push(BUENA), DOCKER_PUSH_CODIGO: '1' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('DETENTE: docker push falló')
    expect(r.stdout).toBe('')
  })

  it('sin DEPLOY_COMMIT_SHA completo, o con una ruta inválida: se detiene sin llamar a docker', () => {
    const malos: Array<Record<string, string>> = [{}, { DEPLOY_COMMIT_SHA: 'abc' }, { DEPLOY_COMMIT_SHA: SHA, PROJECT_ID: 'Proyecto Raro' }, { DEPLOY_COMMIT_SHA: SHA, REGION: 'x y' }]
    for (const env of malos) {
      for (const paso of ['construir', 'publicar']) {
        const r = run('imagen.sh', [paso], env)
        expect(r.code).toBe(1)
        expect(r.out).toContain('DETENTE')
        expect(r.calls).toBe('')
      }
    }
  })

  it('sin subcomando o con uno desconocido: error de uso sin llamar a docker', () => {
    for (const args of [[], ['desplegar'], ['publicar', 'extra']]) {
      const r = run('imagen.sh', args, { DEPLOY_COMMIT_SHA: SHA })
      expect(r.code).toBe(2)
      expect(r.calls).toBe('')
    }
  })
})

describe('humo.sh', () => {
  const VALOR = 'VALOR-QUE-NO-SE-IMPRIME'
  const ANTERIOR = 'project-os-dashboard-00046-ppl'
  const NUEVA = 'project-os-dashboard-00047-abc'
  type Trafico = { revisionName?: string; percent?: number; latestRevision?: boolean }
  const servicio = (nombre: string, o: { traffic?: Trafico[]; creada?: string; lista?: string; image?: string; url?: string } = {}) => {
    const file = path.join(dir, `${nombre}.json`)
    writeFileSync(file, JSON.stringify({
      spec: { template: { spec: { containers: [{ image: o.image ?? IMAGE, env: [{ name: 'NEXTAUTH_URL', value: VALOR }] }] } } },
      status: { url: o.url ?? 'https://dash.example.com', latestCreatedRevisionName: o.creada ?? NUEVA, latestReadyRevisionName: o.lista ?? NUEVA,
        traffic: o.traffic ?? [{ revisionName: NUEVA, percent: 100 }] },
    }))
    return file
  }
  const verificar = (servicios: string[], env: Record<string, string> = {}) =>
    run('humo.sh', ['verificar'], { IMAGE, REVISION_ANTERIOR: ANTERIOR, GCLOUD_SERVICIOS: servicios.join(':'), ...env })
  const gcloud = (calls: string) => calls.split('\n').filter((c) => c.startsWith('gcloud '))

  it('anotar: imprime por stdout solo la revisión con el 100 % (también si es «latestRevision»), sin valores', () => {
    const r = run('humo.sh', ['anotar'], { GCLOUD_SERVICIOS: servicio('s', { traffic: [{ revisionName: ANTERIOR, percent: 100 }] }) })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`${ANTERIOR}\n`)
    expect(r.out).not.toContain(VALOR)
    expect(r.calls).toMatch(/^gcloud run services describe project-os-dashboard --project project-os-511102 --region northamerica-south1 --format=json\n$/)
    const ultima = run('humo.sh', ['anotar'], { GCLOUD_SERVICIOS: servicio('u', { traffic: [{ latestRevision: true, percent: 100 }], lista: ANTERIOR }) })
    expect(ultima.stdout).toBe(`${ANTERIOR}\n`)
  })

  it('anotar: tráfico repartido, sin tráfico o JSON inválido: se detiene sin imprimir revisión', () => {
    const repartido = servicio('r', { traffic: [{ revisionName: ANTERIOR, percent: 50 }, { revisionName: NUEVA, percent: 50 }] })
    const cruda = path.join(dir, 'cruda.json')
    writeFileSync(cruda, 'no es json')
    for (const archivo of [repartido, servicio('v', { traffic: [] }), cruda]) {
      const r = run('humo.sh', ['anotar'], { GCLOUD_SERVICIOS: archivo })
      expect(r.code).toBe(1)
      expect(r.out).toContain('DETENTE')
      expect(r.stdout).toBe('')
    }
  })

  it('verificar: revisión nueva lista, con la imagen y el 100 %, y humo correcto: verde sin tocar el tráfico', () => {
    const r = verificar([servicio('ok')])
    expect(r.code).toBe(0)
    expect(r.out).toContain(`OK: humo remoto correcto en ${NUEVA}.`)
    expect(r.calls).toContain('smoke-remote.mjs --url https://dash.example.com')
    expect(r.calls).not.toContain('update-traffic')
    expect(r.out).not.toContain(VALOR)
    expect(r.out).not.toContain(DIGEST)
  })

  it('verificar: si el humo falla, devuelve el 100 % a la revisión anterior, lo comprueba y queda en rojo', () => {
    const revertido = servicio('rev', { traffic: [{ revisionName: ANTERIOR, percent: 100 }] })
    const r = verificar([servicio('ok'), revertido], { HUMO_CODIGO: '1' })
    expect(r.code).toBe(1)
    expect(gcloud(r.calls)[1]).toBe(`gcloud run services update-traffic project-os-dashboard --project project-os-511102 --region northamerica-south1 --to-revisions ${ANTERIOR}=100`)
    expect(gcloud(r.calls)).toHaveLength(3)
    expect(r.out).toContain(`Tráfico revertido: ${ANTERIOR} recibe el 100 %`)
    expect(r.out).not.toContain(VALOR)
    expect(r.out).not.toContain('SALIDA-DE-GCLOUD-QUE-NO-SE-MUESTRA')
  })

  it('verificar: si la reversión falla o no queda aplicada, lo dice y queda en rojo', () => {
    const falla = verificar([servicio('ok')], { HUMO_CODIGO: '1', GCLOUD_TRAFICO_CODIGO: '1' })
    expect(falla.code).toBe(1)
    expect(falla.out).toContain('DETENTE: la reversión de tráfico falló')
    const sinEfecto = verificar([servicio('ok')], { HUMO_CODIGO: '1' })
    expect(sinEfecto.code).toBe(1)
    expect(sinEfecto.out).toContain(`DETENTE: tras revertir, ${ANTERIOR} no recibe el 100 % del tráfico`)
  })

  it('verificar: revisión no lista, sin revisión nueva, otra imagen, tráfico en otra o URL rara: rojo sin humo y sin tocar el tráfico', () => {
    const casos: Array<[string, string]> = [
      [servicio('a', { lista: ANTERIOR }), 'la última revisión creada no está lista'],
      [servicio('b', { creada: ANTERIOR, lista: ANTERIOR, traffic: [{ revisionName: ANTERIOR, percent: 100 }] }), 'no hay revisión nueva'],
      [servicio('c', { image: `${RUTA}@sha256:${'e'.repeat(64)}` }), 'la revisión no usa la imagen desplegada'],
      [servicio('d', { traffic: [{ revisionName: ANTERIOR, percent: 100 }] }), 'la revisión nueva no recibe el 100 % del tráfico'],
      [servicio('e', { url: 'http://dash.example.com' }), 'el servicio no informa una URL https válida'],
    ]
    for (const [archivo, motivo] of casos) {
      const r = verificar([archivo])
      expect(r.code).toBe(1)
      expect(r.out).toContain(`FALLA: ${motivo}`)
      expect(r.calls).not.toContain('smoke-remote')
      expect(r.calls).not.toContain('update-traffic')
      expect(r.out).not.toContain(VALOR)
    }
  })

  it('verificar: sin REVISION_ANTERIOR o sin IMAGE por digest: se detiene sin llamar a gcloud', () => {
    const malos: Array<Record<string, string>> = [{ REVISION_ANTERIOR: '' }, { REVISION_ANTERIOR: 'Mala Revisión' }, { IMAGE: `${RUTA}:latest` }, { IMAGE: '' }]
    for (const env of malos) {
      const r = verificar([servicio('ok')], env)
      expect(r.code).toBe(1)
      expect(r.out).toContain('DETENTE')
      expect(r.calls).toBe('')
    }
  })

  it('sin subcomando o con uno desconocido: error de uso sin llamar a gcloud', () => {
    for (const args of [[], ['revertir'], ['anotar', 'extra']]) {
      const r = run('humo.sh', args)
      expect(r.code).toBe(2)
      expect(r.calls).toBe('')
    }
  })
})
