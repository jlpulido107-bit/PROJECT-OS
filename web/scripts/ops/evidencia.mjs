#!/usr/bin/env node
/**
 * Valida y evalúa un archivo de EVIDENCIA SANEADA de la V1.6 (docs/operacion-v1-6/evidencia.md).
 *
 *   node scripts/ops/evidencia.mjs <archivo.json> [--json] [--parcial]
 *
 * - Offline: solo lee el archivo indicado. No invoca gcloud ni la red.
 * - Primero RECHAZA (código 4) la evidencia con correos de personas, tokens, claves, IDs de facturación, valores de
 *   variables, URLs con parámetros, cookies o contenido de logs. Nunca imprime el valor encontrado: solo la ruta JSON
 *   (sin claves arbitrarias) y el tipo.
 * - Después evalúa cada control con reglas explícitas: OK / FALLO / NO_VERIFICADO. Un campo vacío, un error de
 *   permisos o un control sin regla es NO_VERIFICADO, nunca OK. Los motivos nunca repiten texto libre de la evidencia.
 * - Falla cerrado (Misión 014): un ejemplo sintético o una fecha anterior al despliegue nunca dan OK; otra revisión u
 *   otro digest exigen revalidar (ningún OK); y sin TODOS los controles de lectura del plan (CONTROLES_LECTURA) el
 *   resultado nunca es «todo OK», salvo con --parcial (evaluar un subconjunto a propósito).
 * - Código de salida: 0 todo OK · 1 algún FALLO · 3 sin fallos pero con NO_VERIFICADO · 4 evidencia rechazada ·
 *   2 uso incorrecto o archivo ilegible.
 */
import { readFileSync } from 'node:fs'
import { codigoDeSalida, CONTROLES_LECTURA, linea, PRODUCCION as P } from './produccion-v1-6.mjs'

// ---- Saneamiento: lo que nunca debe aparecer en una evidencia ----
const CLAVES_DE_LOG = new Set(['textPayload', 'jsonPayload', 'protoPayload', 'httpRequest', 'insertId', 'logName', 'receiveTimestamp', 'trace'])
/** Claves cuyo nombre ya indica un secreto: su presencia rechaza la evidencia aunque el valor parezca inocuo. */
const CLAVE_DE_SECRETO = /^(password|passwd|secret|client_secret|token|access_token|refresh_token|id_token|api_key|apikey|private_key|cookie|set-cookie|authorization)$/i
const CUENTA_DEL_PROYECTO = new RegExp(`^[a-z][a-z0-9-]*@${P.proyecto}\\.iam\\.gserviceaccount\\.com$`)
const DETECTORES = [
  ['clave privada', /-----BEGIN [A-Z ]*PRIVATE KEY-----|"private_key"/],
  ['token OAuth', /ya29\.[0-9A-Za-z_-]{10,}/],
  ['cabecera Bearer', /\bBearer\s+[A-Za-z0-9._-]{8,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['clave de API de Google', /AIza[0-9A-Za-z_-]{20,}/],
  ['secreto de cliente OAuth', /GOCSPX-/],
  ['ID de cuenta de facturación', /\b[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}\b/],
  ['valor de variable de entorno', /\b[A-Z][A-Z0-9_]{2,}=\S/],
  ['contenido de log', /"(textPayload|jsonPayload|protoPayload|httpRequest|insertId)"/],
  // Misión 014 (D.2): valores sensibles en URL, credenciales de OAuth y GitHub, cookies, la hoja y direcciones IP.
  ['URL con parámetros (pueden llevar códigos o tokens)', /https?:\/\/[^\s"'<>]*\?[^\s"'<>]*=/i],
  ['parámetro sensible de URL', /[?&#;](code|state|token|access_token|id_token|refresh_token|client_secret|api_key|key|password|sig|signature|session_state)=[^\s&"']+/i],
  ['código de autorización OAuth', /\b4\/0[0-9A-Za-z_-]{20,}/],
  ['refresh token de Google', /\b1\/\/0[0-9A-Za-z_-]{20,}/],
  ['ID de cliente OAuth', /\b\d{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/],
  ['token de GitHub', /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['cookie de sesión', /next-auth\.(session-token|csrf-token)|__(Secure|Host)-next-auth/i],
  ['enlace a la hoja de cálculo', /docs\.google\.com\/spreadsheets\/d\//i],
  ['dirección IP', /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/],
]
/** Segmento de ruta JSON imprimible: una clave arbitraria (p. ej. un correo usado como clave) nunca se muestra. */
const segmento = (k) => (/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k) ? k : '<clave>')
const CORREO = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

function correoPermitido(c) {
  const sinPrefijo = c.replace(/^(serviceAccount|user|group):/, '')
  // Cuentas de servicio (del proyecto o gestionadas por Google): no son datos personales.
  return CUENTA_DEL_PROYECTO.test(sinPrefijo) || /@([a-z0-9-]+\.)*gserviceaccount\.com$/.test(sinPrefijo)
    || /@example\.(com|org)$/i.test(sinPrefijo)
}

/** Recorre todas las cadenas (y claves) del JSON; devuelve [ruta, tipo] por hallazgo, sin el valor. */
export function hallazgosSensibles(dato, ruta = '$') {
  const out = []
  const revisar = (texto, donde) => {
    for (const [tipo, re] of DETECTORES) if (re.test(texto)) out.push([donde, tipo])
    for (const c of texto.match(CORREO) ?? []) if (!correoPermitido(c)) out.push([donde, 'correo de persona'])
  }
  if (typeof dato === 'string') revisar(dato, ruta)
  else if (Array.isArray(dato)) dato.forEach((v, i) => out.push(...hallazgosSensibles(v, `${ruta}[${i}]`)))
  else if (dato && typeof dato === 'object') {
    for (const [k, v] of Object.entries(dato)) {
      revisar(k, `${ruta}.<clave>`)
      if (CLAVES_DE_LOG.has(k)) out.push([`${ruta}.${k}`, 'contenido de log'])
      if (CLAVE_DE_SECRETO.test(k)) out.push([`${ruta}.${segmento(k)}`, 'campo con nombre de secreto'])
      out.push(...hallazgosSensibles(v, `${ruta}.${segmento(k)}`))
    }
  }
  return out
}

// ---- Evaluación por control ----
// Cada entrada de evidencia se evalúa por separado. Después, cada CONTROL se agrega con la PEOR evidencia
// (FALLO > NO_VERIFICADO > OK) y debe cumplir su COBERTURA mínima: un control compuesto nunca queda en OK por una
// sola parte (revisión R1 de ChatGPT, PR #23).
const vacio = (v) => v === undefined || v === null || v === ''
const lista = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,;\s]+/)).map((x) => String(x).trim()).filter(Boolean)
const r = (id, estado, motivo) => ({ id, estado, motivo })
/**
 * Conteo estricto: entero finito ≥ 0, como número o como texto de solo dígitos. Cualquier otra cosa (NaN,
 * 'LECTURA_FALLIDA', negativos, decimales, Infinity, '') devuelve null y el control queda NO_VERIFICADO (revisión R2).
 */
export function conteo(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null
  if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) {
    const n = Number(v.trim())
    return Number.isSafeInteger(n) ? n : null
  }
  return null
}
const ilegible = (campo) => ['NO_VERIFICADO', `${campo}: valor ausente o ilegible (se exige un entero ≥ 0; la lectura pudo fallar)`]
const RANGO = { OK: 0, NO_VERIFICADO: 1, FALLO: 2 }
const peor = (estados) => estados.reduce((a, b) => (RANGO[b] > RANGO[a] ? b : a), 'OK')
const URL_CALLBACK = `${P.url}/api/auth/callback/google`
/** Patrones de E1 y alcance mínimo para que un conteo 0 cuente: búsqueda en todos los campos y 30 días (retención). */
export const PATRONES_E1 = Object.freeze(['correo', 'token', 'bearer', 'codigo_oauth'])
export const VENTANA_E1_DIAS = 30

/** Evalúa una lista de [estado, motivo] parciales y devuelve el peor, con sus motivos. */
function combinar(partes) {
  const estado = peor(partes.map((p) => p[0]))
  return [estado, partes.filter((p) => p[0] === estado).map((p) => p[1]).join('; ')]
}

/** ID numérico de una versión de Secret Manager: «1» o «projects/…/secrets/<secreto>/versions/1». */
export function versionId(texto, secreto) {
  const t = String(texto ?? '').trim()
  if (/^[1-9]\d*$/.test(t)) return { id: t, otroSecreto: false }
  const m = /^projects\/[^/]+\/secrets\/([^/]+)\/versions\/([1-9]\d*)$/.exec(t)
  if (!m) return { id: null, otroSecreto: false }
  return m[1] === secreto ? { id: m[2] ?? null, otroSecreto: false } : { id: null, otroSecreto: true }
}

/**
 * Transcripción EXACTA de las salidas de los comandos A6 del plan a los campos de evidencia de un secreto: la regla que
 * sigue el propietario al copiar, y la que usan las pruebas de extremo a extremo. Nunca recibe valores de secretos.
 *   iam: salida de `secrets get-iam-policy … --format='value(bindings.role,bindings.members)'`
 *   versiones: salida de `secrets versions list … --format='value(name.basename(),state)'` (o con la ruta completa)
 *   referencias: salida de la extracción de versiones fijadas («VARIABLE secreto versión» por línea)
 */
export function observadoA6(secreto, { iam, versiones, referencias }) {
  const lineas = (t) => (t == null ? null : String(t).split('\n').map((x) => x.trim()).filter(Boolean))
  const ref = (lineas(referencias) ?? []).map((x) => x.split(/\s+/)).filter((c) => c[1] === secreto)
  return {
    secreto,
    miembros: lineas(iam),
    versiones: lineas(versiones),
    // Sin referencia, o con dos referencias distintas al mismo secreto, la versión fijada queda sin dato.
    version_fijada: new Set(ref.map((c) => c[2])).size === 1 ? (ref[0]?.[2] ?? '') : '',
  }
}

const REGLAS = {
  A1: (o) => (vacio(o.imagen) ? ['NO_VERIFICADO', 'falta la imagen observada']
    : o.imagen === `${P.imagenBase}@${P.digest}` ? ['OK', 'la revisión sirve el digest desplegado']
      : ['FALLO', 'la imagen observada no es el digest desplegado']),
  // A2 es compuesto: URL publicada por Cloud Run + NEXTAUTH_URL de la revisión + callback registrado en el cliente OAuth.
  A2: (o) => combinar([
    o.urls == null || lista(o.urls).length === 0 ? ['NO_VERIFICADO', 'faltan las URLs publicadas']
      : lista(o.urls).includes(P.url) ? ['OK', 'Cloud Run publica la URL estable'] : ['FALLO', 'la URL estable no está entre las publicadas'],
    vacio(o.nextauth_url) ? ['NO_VERIFICADO', 'falta NEXTAUTH_URL de la revisión']
      : o.nextauth_url === P.url ? ['OK', 'NEXTAUTH_URL = URL estable'] : ['FALLO', 'NEXTAUTH_URL distinta de la URL estable'],
    vacio(o.callback_oauth) ? ['NO_VERIFICADO', 'falta el callback registrado en el cliente OAuth']
      : o.callback_oauth === URL_CALLBACK ? ['OK', 'callback OAuth = URL estable'] : ['FALLO', 'callback OAuth distinto de la URL estable'],
  ]),
  A4: (o) => {
    const v = lista(o.variables)
    // Una revisión real siempre tiene variables: una lista vacía es un campo sin rellenar, no un OK.
    if (v.length === 0) return ['NO_VERIFICADO', 'faltan los nombres de variables']
    const escritura = P.variablesEscritura.filter((x) => v.includes(x))
    return escritura.length ? ['FALLO', `variables de escritura presentes: ${escritura.join(', ')}`] : ['OK', 'sin variables de escritura']
  },
  A5: (o) => {
    if (vacio(o.cuenta) || !Array.isArray(o.roles_proyecto)) return ['NO_VERIFICADO', 'faltan la cuenta o los roles (lista; [] = ninguno, comprobado)']
    if (o.cuenta !== P.cuentaRuntime) return ['FALLO', 'el servicio no corre con la cuenta runtime']
    return lista(o.roles_proyecto).length ? ['FALLO', 'la cuenta runtime tiene roles de proyecto'] : ['OK', 'cuenta runtime sin roles de proyecto']
  },
  // A6, por secreto: IAM (una sola fila) + versiones (exactamente una ENABLED) + versión fijada en la revisión (numérica y ENABLED).
  A6: (o) => {
    if (!P.secretos.includes(o.secreto)) return ['NO_VERIFICADO', 'secreto no reconocido']
    const s = o.secreto
    const esperado = `roles/secretmanager.secretAccessor serviceAccount:${P.cuentaRuntime}`
    const filas = o.miembros == null ? [] : (Array.isArray(o.miembros) ? o.miembros : [o.miembros]).map((x) => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean)
    const iam = filas.length === 0 ? ['NO_VERIFICADO', `${s}: faltan los miembros`]
      : filas.length === 1 && filas[0] === esperado ? ['OK', `${s}: solo la cuenta runtime lo lee`]
        : ['FALLO', `${s}: acceso distinto de una sola fila para la cuenta runtime`]
    let versiones
    let habilitadas = []
    if (o.versiones == null) versiones = ['NO_VERIFICADO', `${s}: faltan las versiones`]
    else {
      const filasV = (Array.isArray(o.versiones) ? o.versiones : [o.versiones]).map((x) => String(x).trim()).filter(Boolean)
      // Cada fila: «ID ESTADO». El ID puede venir como número o como ruta completa de Secret Manager
      // (projects/…/secrets/<secreto>/versions/<n>); en ese caso, la ruta debe ser de ESTE secreto.
      const leidas = filasV.map((x) => ({ ...versionId(x.split(/\s+/)[0] ?? '', s), estado: x.split(/\s+/)[1] ?? '' }))
      habilitadas = leidas.filter((v) => v.estado === 'ENABLED' && v.id).map((v) => v.id)
      versiones = filasV.length === 0 ? ['NO_VERIFICADO', `${s}: lista de versiones vacía`]
        : leidas.some((v) => v.otroSecreto) ? ['NO_VERIFICADO', `${s}: hay versiones de OTRO secreto en la lectura (evidencia inconsistente)`]
          : leidas.some((v) => !v.id || !['ENABLED', 'DISABLED', 'DESTROYED'].includes(v.estado)) ? ['NO_VERIFICADO', `${s}: filas de versiones ilegibles (se espera «ID ESTADO»)`]
            : habilitadas.length === 0 ? ['FALLO', `${s}: ninguna versión ENABLED (la revisión no podría leerlo)`]
              : habilitadas.length > 1 ? ['FALLO', `${s}: más de una versión ENABLED (facturación y rotación)`]
                : ['OK', `${s}: una sola versión ENABLED`]
    }
    const fijada = String(o.version_fijada ?? '').trim()
    const referencia = fijada === '' ? ['NO_VERIFICADO', `${s}: falta la versión fijada en la revisión`]
      : !/^[1-9]\d*$/.test(fijada) ? ['FALLO', `${s}: la revisión no usa una versión numérica fijada`]
        : versiones[0] === 'NO_VERIFICADO' ? ['NO_VERIFICADO', `${s}: no se puede contrastar la versión fijada`]
          : habilitadas.includes(fijada) ? ['OK', `${s}: la versión fijada está ENABLED`]
            : ['FALLO', `${s}: la versión fijada no es la ENABLED`]
    return combinar([iam, versiones, referencia])
  },
  // A7: la configuración es obligatoria; la métrica observada solo puede EMPEORAR el resultado, nunca aprobarlo sola.
  A7: (o) => {
    const partes = []
    const hayConfig = ['revision_minScale', 'revision_maxScale', 'cpu_throttling', 'servicio_maxScale'].some((k) => k in o)
    if (hayConfig) {
      if ([o.revision_minScale, o.revision_maxScale, o.cpu_throttling].some(vacio)) partes.push(['NO_VERIFICADO', 'faltan anotaciones de revisión'])
      else if (String(o.revision_minScale) !== '0' || String(o.revision_maxScale) !== '1' || String(o.cpu_throttling) !== 'true') {
        partes.push(['FALLO', 'la revisión no tiene minScale 0, maxScale 1 y cpu-throttling true'])
      } else partes.push(['OK', 'revisión: minScale 0, maxScale 1, CPU por solicitud'])
      const sv = String(o.servicio_maxScale ?? '').trim().toLowerCase()
      if (sv === '') partes.push(['NO_VERIFICADO', 'falta el maxScale de servicio (anotar "ninguno" si no existe)'])
      else if (sv === 'ninguno' || sv === '1') partes.push(['OK', 'maxScale de servicio coherente (1 o ninguno)'])
      else partes.push(['NO_VERIFICADO', `maxScale de servicio ${/^\d{1,4}$/.test(sv) ? sv : '(valor no reconocido)'} frente a revisión 1: tope efectivo ambiguo (D-1); nunca se da por bueno`])
    }
    if ('instancias_max_30d' in o) {
      const n = conteo(o.instancias_max_30d)
      if (n === null) partes.push(ilegible('instancias_max_30d'))
      else if (n > 1) partes.push(['FALLO', `se observaron ${n} instancias: el tope efectivo no es 1 (D-1)`])
      else partes.push(['OK', 'métrica: nunca más de 1 instancia en 30 días (no prueba el máximo configurado)'])
    }
    if (partes.length === 0) return ['NO_VERIFICADO', 'sin datos de escalado']
    return combinar(partes)
  },
  // A8 es compuesto: cuenta del build + la línea "Identidad de compilación verificada" en su log.
  A8: (o) => combinar([
    vacio(o.cuenta_build) ? ['NO_VERIFICADO', 'falta la cuenta del build']
      : o.cuenta_build === `projects/${P.proyecto}/serviceAccounts/${P.cuentaBuild}` || o.cuenta_build === P.cuentaBuild
        ? ['OK', 'el build usó la cuenta dedicada'] : ['FALLO', 'el build no usó la cuenta dedicada'],
    conteo(o.lineas_identidad_verificada) === null ? ilegible('lineas_identidad_verificada')
      : conteo(o.lineas_identidad_verificada) >= 1 ? ['OK', 'el paso verificar-identidad se ejecutó']
        : ['FALLO', 'el log del build no contiene "Identidad de compilación verificada"'],
  ]),
  A9: (o) => {
    if (vacio(o.digest_produccion)) return ['NO_VERIFICADO', 'falta el digest de la etiqueta produccion']
    if (/NOT_FOUND|no existe/i.test(o.digest_produccion)) return ['FALLO', 'la etiqueta produccion no existe: la imagen desplegada no tiene protección explícita']
    return o.digest_produccion === P.digest ? ['OK', 'produccion apunta al digest desplegado']
      : ['FALLO', 'produccion apunta a otro digest']
  },
  // F3: configuración (--check) y efecto real (conteos) se evalúan juntos; el efecto solo es observable con ≥ 5 imágenes.
  F3: (o) => {
    const partes = []
    if ('check' in o) {
      partes.push(vacio(o.check) ? ['NO_VERIFICADO', 'falta el resultado de --check']
        : o.check === 'PERMITIDO' ? ['OK', 'política de limpieza activa'] : ['FALLO', `--check: ${o.check === 'BLOQUEADO' ? 'BLOQUEADO' : 'resultado inesperado'}`])
    }
    if ('imagenes' in o || 'mayores_30_dias_no_protegidas' in o) {
      const total = conteo(o.imagenes)
      const sinProteger = conteo(o.mayores_30_dias_no_protegidas)
      partes.push(total === null ? ilegible('imagenes') : sinProteger === null ? ilegible('mayores_30_dias_no_protegidas')
        : sinProteger > total ? ['NO_VERIFICADO', 'conteos incoherentes: más imágenes no protegidas que imágenes']
          : sinProteger > 0 ? ['FALLO', 'hay imágenes no protegidas de más de 30 días: la limpieza no actúa como se espera']
            : total < 5 ? ['NO_VERIFICADO', 'menos de 5 imágenes: el efecto de la limpieza aún no es observable']
              : ['OK', 'no quedan imágenes no protegidas de más de 30 días'])
    }
    return partes.length ? combinar(partes) : ['NO_VERIFICADO', 'sin datos de limpieza']
  },
  // E1: un conteo solo vale si cubre TODOS los campos del registro y la ventana completa de retención.
  E1: (o) => {
    if (!PATRONES_E1.includes(o.patron)) return ['NO_VERIFICADO', `patrón no reconocido (se esperan: ${PATRONES_E1.join(', ')})`]
    const n = conteo(o.coincidencias)
    if (n === null) return ilegible(`coincidencias de «${o.patron ?? '?'}»`)
    if (n > 0) return ['FALLO', `${n} coincidencias de ${o.patron}: seguir el runbook operativo §5 sin copiar líneas`]
    const dias = conteo(o.ventana_dias)
    if (o.alcance !== 'todos-los-campos' || dias === null || dias < VENTANA_E1_DIAS) {
      return ['NO_VERIFICADO', `0 coincidencias de ${o.patron}, pero con alcance parcial o ilegible (se exigen todos los campos y ${VENTANA_E1_DIAS} días)`]
    }
    return ['OK', `0 coincidencias de ${o.patron} en todos los campos, ${dias} días`]
  },
  // G2: encontrar varias revisiones no prueba un rollback. OK solo con precondiciones reales Y un ensayo autorizado.
  G2: (o) => {
    if (o.revisiones == null || lista(o.revisiones).length === 0) return ['NO_VERIFICADO', 'faltan las revisiones']
    if (lista(o.revisiones).filter((x) => x.startsWith(`${P.servicio}-`)).length < 2) return ['NO_VERIFICADO', 'una sola revisión: rollback NO_APLICA']
    const imagen = String(o.imagen_anterior_digest ?? '').trim()
    if (imagen === '') return ['NO_VERIFICADO', 'falta comprobar que la imagen de la revisión anterior sigue en el repositorio']
    if (/NOT_FOUND|no existe/i.test(imagen)) return ['FALLO', 'la imagen de la revisión anterior ya no existe: el rollback no es viable']
    const ensayo = String(o.ensayo_rollback ?? '').toUpperCase()
    if (ensayo === 'FALLO') return ['FALLO', 'el ensayo autorizado de rollback falló']
    if (ensayo !== 'OK') return ['NO_VERIFICADO', 'precondiciones presentes, pero el rollback no se ha ensayado (requiere autorización)']
    return ['OK', 'rollback ensayado con autorización y con la imagen anterior disponible']
  },
  // C2 (R3-2, R4-1): un rechazo de Google antes del callback no prueba la lista de la app. Solo cuenta una cuenta
  // ELEGIBLE para el login de Google, fuera de la lista, rechazada POR LA APP. Sin correos: solo estos campos.
  C2: (o) => {
    const v = String(o.resultado ?? '').toUpperCase()
    if (v === 'FALLO') return ['FALLO', 'una cuenta no autorizada vio datos: incidente']
    if (v !== 'OK') return ['NO_VERIFICADO', 'falta el resultado (OK o FALLO) de la comprobación humana']
    if (o.oauth_elegible !== true) return ['NO_VERIFICADO', 'sin una cuenta elegible para el login de Google (oauth_elegible: true) no se prueba la lista de la app']
    const capa = String(o.capa_rechazo ?? '').toLowerCase()
    if (capa === 'google') return ['NO_VERIFICADO', 'rechazo de Google antes del callback: no prueba la lista de la app']
    if (capa !== 'app') return ['NO_VERIFICADO', 'falta la capa que rechazó (capa_rechazo: "app"); un aviso de error sin capa no basta']
    return ['OK', 'cuenta elegible fuera de la lista rechazada por la app, sin datos']
  },
}
/** Controles que solo puede comprobar una persona: el propietario anota OK o FALLO, sin datos. C2 tiene regla propia. */
const MANUALES = new Set(['C1', 'C3', 'C4', 'C5', 'C6', 'C7', 'D1', 'D2', 'E2', 'F1', 'F2', 'G1', 'G3'])

/** Cobertura mínima por control compuesto: si falta una parte, el control agregado es NO_VERIFICADO. */
const COBERTURA = {
  A6: (entradas) => {
    const vistos = new Set(entradas.map((c) => c?.observado?.secreto))
    const faltan = P.secretos.filter((s) => !vistos.has(s))
    return faltan.length ? `faltan secretos: ${faltan.join(', ')}` : null
  },
  A7: (entradas) => (entradas.some((c) => ['revision_maxScale', 'servicio_maxScale'].some((k) => k in (c?.observado ?? {})))
    ? null : 'falta la configuración de escalado (la métrica sola no basta)'),
  // F3: --check prueba la configuración; sin el conteo de imágenes no se ha visto el efecto real (matriz: PARCIAL).
  F3: (entradas) => (entradas.some((c) => 'imagenes' in (c?.observado ?? {}))
    ? null : 'falta el efecto real (conteo de imágenes); --check solo prueba la configuración'),
  E1: (entradas) => {
    const vistos = new Set(entradas.map((c) => c?.observado?.patron))
    const faltan = PATRONES_E1.filter((x) => !vistos.has(x))
    return faltan.length ? `faltan patrones: ${faltan.join(', ')}` : null
  },
}

/** Identificador imprimible: solo los del checklist (A1–H); cualquier otro texto se muestra como «??». */
const idSeguro = (v) => (/^[A-H]\d{0,2}$/.test(String(v ?? '')) ? String(v) : '??')

function evaluarEntrada(id, o) {
  if (typeof o.error === 'string' && o.error) {
    return r(id, 'NO_VERIFICADO', /PERMISSION_DENIED|403|denegad/i.test(o.error) ? 'permiso denegado al leer' : 'la lectura falló')
  }
  if (REGLAS[id]) {
    const [estado, motivo] = REGLAS[id](o)
    return r(id, estado, motivo)
  }
  if (MANUALES.has(id)) {
    const v = String(o.resultado ?? '').toUpperCase()
    return r(id, v === 'OK' ? 'OK' : v === 'FALLO' ? 'FALLO' : 'NO_VERIFICADO',
      v === 'OK' || v === 'FALLO' ? `comprobación humana: ${v}` : 'falta el resultado (OK o FALLO) de la comprobación humana')
  }
  return r(id, 'NO_VERIFICADO', 'control sin regla de evaluación')
}

/**
 * Límite de lo que puede aprobar una evidencia (Misión 014): un ejemplo sintético o una fecha anterior al despliegue no
 * aprueban nada (todo NO_VERIFICADO); otra revisión u otro digest exigen revalidar la línea base (ningún OK, los FALLO
 * se mantienen). Devuelve null si no hay límite.
 */
function limite(evidencia, controles) {
  if (evidencia.ejemplo_sintetico !== undefined && evidencia.ejemplo_sintetico !== false) return { todo: true, motivo: 'ejemplo sintético: nunca cuenta como evidencia de producción' }
  const hoy = new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(evidencia.fecha)) || String(evidencia.fecha) > hoy) return { todo: true, motivo: 'fecha ilegible o futura: no describe una lectura real' }
  if (String(evidencia.fecha) < P.fechaDespliegue) return { todo: true, motivo: `fecha anterior al despliegue (${P.fechaDespliegue}): no describe esta versión` }
  if (evidencia.revision !== P.revision) return { todo: false, motivo: 'revisión distinta de la línea base o sin declarar: requiere nueva validación' }
  if (controles.some((c) => c.id === 'A1' && c.estado === 'FALLO')) return { todo: false, motivo: 'la revisión sirve otro digest o una etiqueta: la línea base cambió; requiere nueva validación' }
  return null
}

export function evaluar(evidencia, { parcial = false } = {}) {
  const errores = []
  if (evidencia?.version !== 1) errores.push('version debe ser 1')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(evidencia?.fecha ?? ''))) errores.push('fecha debe ser AAAA-MM-DD')
  if (!Array.isArray(evidencia?.controles) || evidencia.controles.length === 0) errores.push('controles debe ser una lista no vacía')
  const sinCobertura = { faltan: [...CONTROLES_LECTURA], completa: false }
  if (errores.length) return { errores, resultados: [], controles: [], cobertura: sinCobertura, limite: null }

  if (evidencia.commit_desplegado !== P.commit) {
    const ver = [r('VER', 'FALLO', 'la evidencia corresponde a otro commit desplegado: no se evalúa contra esta versión')]
    return { errores, resultados: ver, controles: ver, cobertura: sinCobertura, limite: 'otro commit desplegado' }
  }
  // Las partes de un mismo control (y del mismo secreto o patrón) se FUSIONAN antes de evaluar: así A2, A7 y A8 pueden
  // llegar en varias lecturas. Dos lecturas que den valores distintos para el mismo campo son contradictorias.
  const grupos = new Map()
  for (const c of evidencia.controles) {
    const id = idSeguro(c?.id)
    const o = c?.observado ?? {}
    const clave = `${id}|${o.secreto ?? ''}|${o.patron ?? ''}`
    const g = grupos.get(clave) ?? { id, observado: {}, conflicto: null }
    for (const [k, v] of Object.entries(o)) {
      if (vacio(v)) { if (!(k in g.observado)) g.observado[k] = v; continue }
      if (!vacio(g.observado[k]) && JSON.stringify(g.observado[k]) !== JSON.stringify(v)) g.conflicto = k
      else g.observado[k] = v
    }
    grupos.set(clave, g)
  }
  const resultados = [...grupos.values()].map((g) => (g.conflicto
    ? r(g.id, 'NO_VERIFICADO', `lecturas contradictorias del campo ${segmento(g.conflicto)}`)
    : evaluarEntrada(g.id, g.observado)))
  const controles = []
  for (const id of [...new Set(resultados.map((x) => x.id))]) {
    const propios = resultados.filter((x) => x.id === id)
    const entradas = evidencia.controles.filter((c) => idSeguro(c?.id) === id)
    const falta = COBERTURA[id]?.(entradas) ?? null
    const estados = propios.map((x) => x.estado).concat(falta ? ['NO_VERIFICADO'] : [])
    const estado = peor(estados)
    const motivo = falta && estado !== 'FALLO' ? `cobertura incompleta: ${falta}`
      : propios.length === 1 ? propios[0].motivo : `${propios.length} lecturas; peor: ${propios.find((x) => x.estado === estado)?.motivo ?? estado}`
    controles.push(r(id, estado, motivo))
  }
  // Límite de la evidencia: se aplica a los controles agregados (el código de salida sale de ellos).
  const lim = limite(evidencia, controles)
  const finales = lim
    ? [r('VER', 'NO_VERIFICADO', lim.motivo),
      ...controles.map((c) => (c.estado === 'OK' || (lim.todo && c.estado === 'FALLO') ? r(c.id, 'NO_VERIFICADO', `${lim.motivo} (la regla daba ${c.estado})`) : c))]
    : controles
  // Cobertura del plan: sin todos los controles de lectura, nunca «todo OK» (salvo --parcial).
  const faltan = CONTROLES_LECTURA.filter((id) => !controles.some((c) => c.id === id))
  if (!parcial && faltan.length) finales.push(r('COB', 'NO_VERIFICADO', `cobertura incompleta del plan: faltan ${faltan.join(', ')} (para evaluar un subconjunto a propósito, --parcial)`))
  return { errores, resultados, controles: finales, cobertura: { faltan, completa: faltan.length === 0 }, limite: lim?.motivo ?? null }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const archivo = args.find((a) => !a.startsWith('--'))
  if (!archivo || args.some((a) => a.startsWith('--') && !['--json', '--parcial'].includes(a))) {
    console.error('Uso: node scripts/ops/evidencia.mjs <archivo.json> [--json] [--parcial]')
    process.exit(2)
  }
  let evidencia
  try {
    evidencia = JSON.parse(readFileSync(archivo, 'utf8'))
  } catch {
    console.error('No se pudo leer el archivo como JSON.')
    process.exit(2)
  }
  const sensibles = hallazgosSensibles(evidencia)
  if (sensibles.length) {
    console.error('EVIDENCIA RECHAZADA: contiene datos que no deben registrarse (no se muestran los valores):')
    for (const [ruta, tipo] of sensibles) console.error(` - ${ruta}: ${tipo}`)
    process.exit(4)
  }
  const { errores, resultados, controles, cobertura, limite: lim } = evaluar(evidencia, { parcial: args.includes('--parcial') })
  if (errores.length) {
    console.error(`EVIDENCIA RECHAZADA: formato no válido (${errores.join('; ')})`)
    process.exit(4)
  }
  // El código de salida y el resumen se calculan sobre los CONTROLES agregados (peor evidencia + cobertura).
  const codigo = codigoDeSalida(controles)
  if (args.includes('--json')) console.log(JSON.stringify({ version: 2, controles, lecturas: resultados, cobertura, limite: lim, codigo }, null, 2))
  else {
    console.log(`PROJECT-OS V1.6 — evaluación de evidencia (${evidencia.fecha}, commit ${/^[0-9a-f]{7,40}$/.test(String(evidencia.commit_desplegado)) ? String(evidencia.commit_desplegado).slice(0, 7) : '??'})`)
    if (evidencia.ejemplo_sintetico !== undefined && evidencia.ejemplo_sintetico !== false) console.log('EJEMPLO SINTÉTICO: los valores son inventados; esto NO es evidencia de producción.')
    if (lim) console.log(`LÍMITE: ${lim}. Ningún control queda en OK.`)
    console.log(lim ? 'Lecturas (lo que diría la regla; NO cuentan por el límite anterior):' : 'Lecturas:')
    for (const x of resultados) console.log('  ' + linea(x))
    console.log('Controles (peor evidencia y cobertura mínima):')
    for (const x of controles) console.log('  ' + linea(x))
    const n = (e) => controles.filter((x) => x.estado === e).length
    console.log(`\nControles: OK ${n('OK')} · FALLO ${n('FALLO')} · NO_VERIFICADO ${n('NO_VERIFICADO')} (no cuenta como OK)`)
    console.log(`Cobertura del plan: ${cobertura.completa ? 'completa' : `faltan ${cobertura.faltan.join(', ')}`}. La aceptación la decide la matriz, no este código de salida.`)
  }
  process.exit(codigo)
}
