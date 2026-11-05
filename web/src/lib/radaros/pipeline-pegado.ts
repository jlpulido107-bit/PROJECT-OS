import { CASILLA_ENTREGA_CEDIS, nombreClave, pareceContacto, reglaEntregaCedis, validarCampo, type CampoForm } from './pipeline-formularios'

/**
 * «Pegar tabla de Gemini» (ORD-POS-146, criterio 3; docs/diseno-eco-pipeline.md §15.3). Convierte la tabla B del Gem 3
 * (NOTAS, POS/referencia/gemini-gems.md, «Módulo 3 · Compras», tarea B) en un borrador de alta de cotización por fila.
 * Pura y sin red: no guarda nada. Cada borrador se corrige en pantalla y se guarda solo cuando el propietario lo confirma,
 * fila por fila, por la ruta de alta que ya existe (que repite todas las validaciones). Las columnas y las filas que no
 * se reconocen quedan marcadas y nunca se envían.
 */

/** Columnas de la tabla B, en el orden del Gem 3 (el de PIPE_COTIZACIONES de RADAROS). */
export const COLUMNAS_TABLA_B = [
  'COTIZACION_ID', 'PRD / EC', 'PROVEEDOR (empresa)', 'ESTADO', 'FECHA_RECIBIDA', 'PRECIO_UNIT', 'MONEDA', 'MOQ',
  'PLAZO_PRODUCCION_DIAS', 'INCOTERM', 'PAIS_ORIGEN', 'CERTIFICADO_ORIGEN', 'UNIDADES_POR_SET', 'FLETE_INTERNACIONAL',
  'IGI_PCT', 'COSTO_ATERRIZADO_MXN', 'MUESTRA_COSTO', 'MUESTRA_MONEDA', 'NOTAS',
] as const

/** Encabezado normalizado → destino. `__id`, `__producto` y `__proveedor` se resuelven contra la hoja. */
const DESTINO: Record<string, string> = {
  COTIZACION_ID: '__id',
  'PRD / EC': '__producto', 'PRD/EC': '__producto',
  'PROVEEDOR (EMPRESA)': '__proveedor', PROVEEDOR: '__proveedor',
  ESTADO: 'estado', FECHA_RECIBIDA: 'fechaRecibida', PRECIO_UNIT: 'precioUnit', MONEDA: 'moneda', MOQ: 'moq',
  PLAZO_PRODUCCION_DIAS: 'plazoProduccionDias', INCOTERM: 'incoterm', PAIS_ORIGEN: 'paisOrigen',
  CERTIFICADO_ORIGEN: 'certificadoOrigen', UNIDADES_POR_SET: 'unidadesPorSet', FLETE_INTERNACIONAL: 'fleteInternacional',
  IGI_PCT: 'igiPct', COSTO_ATERRIZADO_MXN: 'costoAterrizadoMxn', MUESTRA_COSTO: 'muestraCosto', MUESTRA_MONEDA: 'muestraMoneda',
  NOTAS: 'notas',
  // ORD-POS-147 (criterios 1 y 2): columnas opcionales que la tabla B puede traer; sin ellas, el borrador las pide.
  PRECIO_POR: 'precioPor', 'PRECIO POR': 'precioPor', 'EL PRECIO ES POR': 'precioPor',
  CANTIDAD_COTIZADA: 'cantidadCotizada', FLETE_CEDIS: 'fleteCedis',
  INCLUYE_ENTREGA_CEDIS: CASILLA_ENTREGA_CEDIS, 'INCLUYE ENTREGA EN CEDIS': CASILLA_ENTREGA_CEDIS,
  'INCLUYE ENTREGA EN CEDIS AMAZON': CASILLA_ENTREGA_CEDIS,
}

/** ORD-POS-147: «pieza», «pcs», «set», «juego»… → PIEZA o SET; otro texto queda tal cual y la revisión lo marca. */
function precioPor(v: string): string {
  const s = sinAcentos(v).toUpperCase().replace(/^POR\s+/, '').trim()
  if (/^(PIEZAS?|PZAS?|PCS?|PIECES?|UNIDAD(ES)?|UNITS?)$/.test(s)) return 'PIEZA'
  if (/^(SETS?|JUEGOS?|KITS?)$/.test(s)) return 'SET'
  return s
}

/** ORD-POS-147: la casilla en el pegado; «SI», «sí», «yes», «x» o «true» la marcan. */
const marcaSi = (v: string) => (/^(SI|YES|X|TRUE)$/.test(sinAcentos(v).toUpperCase()) ? 'SI' : '')

export interface ContextoPegado {
  /** `CAMPOS['eco.cotizacion.crear']`: los mismos del formulario de alta. */
  campos: readonly CampoForm[]
  productos: ReadonlyArray<{ id: string; ideaId: string | null; etapa: string | null }>
  proveedores: ReadonlyArray<{ id: string; nombre: string }>
  cotizaciones: ReadonlyArray<{ id: string; productoId: string | null; proveedorId: string | null; incoterm: string | null; precioUnit: string | null; moneda: string | null }>
  /** ORD-POS-147 (criterio 2): FLETE_CEDIS_REF de PIPE_PARAMETROS; null si no hay. */
  fleteCedisRef?: number | null
}

export interface ColumnaPegada {
  texto: string
  /** Clave del formulario (o `__id`, `__producto`, `__proveedor`); null = no reconocida, no se guarda. */
  destino: string | null
}

export interface Borrador {
  /** Línea del texto pegado (desde 1). */
  linea: number
  crudo: string
  /** false = fila no reconocida (celdas de más o de menos, encabezado repetido): nunca se guarda. */
  reconocida: boolean
  motivo: string | null
  /** COTIZACION_ID que traía Gemini; el ID real lo pone el servidor. */
  idGemini: string | null
  /** Clave del formulario → valor propuesto. */
  valores: Record<string, string>
  /** Clave → motivo; con alguno, la fila no se puede confirmar hasta corregirlo. */
  errores: Record<string, string>
  /** Lo que se interpretó (vacíos por confirmar, parcial, SUPUESTO). */
  notas: string[]
  /** Motivo si ya existe en la hoja o se repite en el pegado; una duplicada nunca se guarda. */
  duplicada: string | null
}

export interface ResultadoPegado {
  error: string | null
  columnas: ColumnaPegada[]
  borradores: Borrador[]
}

const sinAcentos = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '')
const normalEncabezado = (s: string) => sinAcentos(limpiar(s)).toUpperCase().replace(/\s+/g, ' ')

/** Quita el formato de Markdown que Gemini suele poner en las celdas. */
function limpiar(s: string): string {
  return s.replace(/\*\*|__|`/g, '').trim()
}

const SEPARADOR = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/
const VACIO = /^(?:—|–|-|n\/?a|nv|\[nv\]|sin dato|por (?:confirmar|verificar)\b.*)$/i
const ETIQUETA = /\s*[([]\s*(DATO|SUPUESTO|NV)\s*[)\]]\s*$|\s+(DATO|SUPUESTO)$/i

/** Celdas de una fila: Markdown (`| a | b |`) o separada por tabuladores (copiada de una hoja). */
function celdas(linea: string): string[] {
  if (linea.includes('\t')) return linea.split('\t').map((c) => c.trim())
  let l = linea.trim()
  if (l.startsWith('|')) l = l.slice(1)
  if (l.endsWith('|')) l = l.slice(0, -1)
  return l.split('|').map((c) => c.trim())
}

/** Número tal como lo escribiría el propietario: sin $, sin moneda, sin % y sin separador de miles. */
function numero(s: string): string {
  let v = s.replace(/^(?:US\$|\$|MXN|USD|CNY)\s*/i, '').replace(/\s*(?:MXN|USD|CNY|%)$/i, '').trim()
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(v)) v = v.replace(/,/g, '')
  if (/^\d{1,3}( \d{3})+(\.\d+)?$/.test(v)) v = v.replace(/ /g, '')
  return v
}

const firma = (v: Record<string, string>) => {
  if (!v.productoId || !v.proveedorId) return null
  const precio = Number(v.precioUnit)
  return [v.productoId, v.proveedorId, (v.incoterm ?? '').toUpperCase(), Number.isFinite(precio) && v.precioUnit ? String(precio) : '', (v.moneda ?? '').toUpperCase()].join('|')
}

/**
 * Revisión de un borrador (al generarlo y otra vez al confirmarlo, con lo que el propietario corrigió): reglas de cada
 * campo, requisitos de `RECIBIDA`, datos de contacto y duplicados contra la hoja y contra las filas anteriores.
 */
export function revisarBorrador(
  valores: Record<string, string>, ctx: ContextoPegado, opciones: { idGemini?: string | null; previas?: ReadonlyMap<string, string> } = {},
): { errores: Record<string, string>; duplicada: string | null } {
  const errores: Record<string, string> = {}
  for (const c of ctx.campos) {
    const e = validarCampo(c, valores[c.clave] ?? '')
    if (e) errores[c.clave] = e
  }
  const prd = valores.productoId ?? ''
  if (prd && !errores.productoId) {
    const p = ctx.productos.find((x) => x.id === prd)
    if (!p) errores.productoId = `${prd} no está en PIPE_PRODUCTOS.`
    else if ((p.etapa ?? '').toUpperCase() === 'DESCARTADO') errores.productoId = `${prd} está descartado.`
  }
  const prv = valores.proveedorId ?? ''
  if (prv && !errores.proveedorId && !ctx.proveedores.some((x) => x.id === prv)) errores.proveedorId = `${prv} no está en PIPE_PROVEEDORES.`
  if ((valores.estado ?? '') === 'RECIBIDA') {
    const faltan = ['precioUnit', 'moneda', 'moq', 'plazoProduccionDias', 'incoterm'].filter((k) => !(valores[k] ?? '').trim())
    if (faltan.length && !errores.estado) errores.estado = `RECIBIDA exige ${faltan.join(', ')}.`
  }
  if (!errores.notas && pareceContacto(valores.notas ?? '')) errores.notas = 'Sin correos ni teléfonos de personas.'
  // ORD-POS-147 (criterio 2): la misma regla de DDP que el formulario de alta.
  for (const [k, m] of Object.entries(reglaEntregaCedis(valores, ctx.fleteCedisRef ?? null).errores)) if (!errores[k]) errores[k] = m

  let duplicada: string | null = null
  const id = opciones.idGemini ?? null
  if (id && ctx.cotizaciones.some((c) => c.id === id)) duplicada = `${id} ya existe en PIPE_COTIZACIONES.`
  const f = firma(valores)
  if (!duplicada && f) {
    const igual = ctx.cotizaciones.find((c) => firma({
      productoId: c.productoId ?? '', proveedorId: c.proveedorId ?? '', incoterm: c.incoterm ?? '', precioUnit: c.precioUnit ?? '', moneda: c.moneda ?? '',
    }) === f)
    if (igual) duplicada = `Igual a ${igual.id} de la hoja (producto, proveedor, incoterm, precio y moneda).`
    else if (opciones.previas?.has(f)) duplicada = `Igual a ${opciones.previas.get(f)} (producto, proveedor, incoterm, precio y moneda).`
  }
  return { errores, duplicada }
}

/** Una fila se puede confirmar si se reconoció, no es duplicada y no tiene errores. */
export function confirmable(b: Pick<Borrador, 'reconocida' | 'errores' | 'duplicada'>): boolean {
  return b.reconocida && b.duplicada === null && Object.keys(b.errores).length === 0
}

/** Firma de un borrador ya guardado, para que no se guarde dos veces en la misma sesión. */
export function firmaDe(valores: Record<string, string>): string | null {
  return firma(valores)
}

/** Interpreta la tabla pegada y arma un borrador por fila. Nada se guarda aquí. */
export function parsearTablaGemini(texto: string, ctx: ContextoPegado): ResultadoPegado {
  const lineas = texto.replace(/\r\n?/g, '\n').split('\n').map((l, i) => ({ l, n: i + 1 })).filter(({ l }) => l.trim() !== '')
  const tabla = lineas.filter(({ l }) => l.includes('|') || l.includes('\t'))
  const inicio = tabla.findIndex(({ l }) => celdas(l).some((c) => DESTINO[normalEncabezado(c)]))
  if (inicio < 0) {
    return { error: `No se encontró la tabla B: la primera fila debe traer los encabezados del Gem 3 (${COLUMNAS_TABLA_B.slice(0, 4).join(', ')}…).`, columnas: [], borradores: [] }
  }
  const encabezado = celdas(tabla[inicio]!.l)
  const columnas: ColumnaPegada[] = encabezado.map((t) => ({ texto: limpiar(t), destino: DESTINO[normalEncabezado(t)] ?? null }))
  const usadas = new Set<string>()
  for (const c of columnas) {
    if (c.destino && usadas.has(c.destino)) c.destino = null // repetida: la segunda no se usa
    else if (c.destino) usadas.add(c.destino)
  }
  if (!usadas.has('__producto') || !usadas.has('__proveedor')) {
    return { error: 'La tabla no trae las columnas «PRD / EC» y «PROVEEDOR (empresa)»: sin ellas no se sabe de qué producto y proveedor es cada fila.', columnas, borradores: [] }
  }
  const campos = new Map(ctx.campos.map((c) => [c.clave, c]))
  const previas = new Map<string, string>()
  const borradores: Borrador[] = []

  for (const { l, n } of tabla.slice(inicio + 1)) {
    if (SEPARADOR.test(l.trim())) continue
    const fila = celdas(l)
    const base: Borrador = { linea: n, crudo: l.slice(0, 400), reconocida: false, motivo: null, idGemini: null, valores: {}, errores: {}, notas: [], duplicada: null }
    if (fila.length !== encabezado.length) {
      borradores.push({ ...base, motivo: `Tiene ${fila.length} celdas y el encabezado ${encabezado.length}.` })
      continue
    }
    if (fila.every((c, i) => normalEncabezado(c) === normalEncabezado(encabezado[i]!))) {
      borradores.push({ ...base, motivo: 'Encabezado repetido.' })
      continue
    }
    const valores: Record<string, string> = {}
    const errores: Record<string, string> = {}
    const notas: string[] = []
    let idGemini: string | null = null
    let parcial = false
    fila.forEach((raw, i) => {
      const destino = columnas[i]!.destino
      if (!destino) return
      const nombre = columnas[i]!.texto
      let v = limpiar(raw)
      const etiqueta = ETIQUETA.exec(v)
      if (etiqueta) {
        v = v.slice(0, etiqueta.index).trim()
        if (/SUPUESTO/i.test(etiqueta[0])) notas.push(`${nombre}: Gemini lo marcó SUPUESTO.`)
      }
      if (VACIO.test(v)) {
        if (v) notas.push(`${nombre}: «${v.slice(0, 40)}» → vacío.`)
        v = ''
      }
      if (destino === '__id') {
        idGemini = /^COT-\d{4,}$/.test(v) ? v : null
        return
      }
      if (destino === '__producto') {
        const prd = /PRD-\d{4,}/.exec(v.toUpperCase())?.[0]
        if (prd) valores.productoId = prd
        else {
          const idea = /\b[A-Z]{2,4}-\d{3,4}\b/.exec(v.toUpperCase())?.[0]
          const abiertos = ctx.productos.filter((p) => idea && p.ideaId === idea && (p.etapa ?? '').toUpperCase() !== 'DESCARTADO')
          if (abiertos.length === 1) {
            valores.productoId = abiertos[0]!.id
            notas.push(`${nombre}: ${idea} → ${abiertos[0]!.id} por IDEA_ID.`)
          } else {
            valores.productoId = ''
            errores.productoId = v ? `«${v.slice(0, 40)}» no lleva a un solo producto de PIPE_PRODUCTOS; escribe su PRD-NNNN.` : 'Vacío; escribe el PRD-NNNN.'
          }
        }
        return
      }
      if (destino === '__proveedor') {
        const prv = /PRV-\d{4,}/.exec(v.toUpperCase())?.[0]
        const porNombre = ctx.proveedores.filter((p) => nombreClave(p.nombre) !== '' && nombreClave(p.nombre) === nombreClave(v))
        if (prv) valores.proveedorId = prv
        else if (porNombre.length === 1) valores.proveedorId = porNombre[0]!.id
        else {
          valores.proveedorId = ''
          errores.proveedorId = v
            ? `«${v.slice(0, 60)}» no está en PIPE_PROVEEDORES: dalo de alta en «Nuevo proveedor» o escribe su PRV-NNNN.`
            : 'Vacío; escribe el PRV-NNNN.'
        }
        if (pareceContacto(v)) errores.proveedorId = 'Sin correos ni teléfonos de personas.'
        return
      }
      if (destino === 'precioPor') {
        valores.precioPor = v ? precioPor(v) : ''
        return
      }
      if (destino === CASILLA_ENTREGA_CEDIS) {
        valores[CASILLA_ENTREGA_CEDIS] = marcaSi(v)
        return
      }
      if (destino === 'estado') {
        const e = sinAcentos(v).toUpperCase().replace(/\s+/g, ' ')
        if (e === 'RECIBIDA (PARCIAL)' || e === 'PARCIAL') {
          parcial = true
          valores.estado = 'RECIBIDA'
          notas.push(`${nombre}: «${v}» → RECIBIDA con «parcial» en NOTAS.`)
        } else if (e === 'DESCARTADA') {
          valores.estado = 'RECHAZADA'
          notas.push(`${nombre}: DESCARTADA → RECHAZADA.`)
        } else valores.estado = e
        return
      }
      const campo = campos.get(destino)
      const k = campo?.tipo.k
      if (k === 'numero' || k === 'entero' || k === 'pct') v = numero(v)
      else if (k === 'lista' || k === 'pais') v = sinAcentos(v).toUpperCase()
      valores[destino] = v
    })
    if (parcial && !/\bparcial\b/i.test(valores.notas ?? '')) valores.notas = valores.notas ? `parcial. ${valores.notas}` : 'parcial'
    const revision = revisarBorrador(valores, ctx, { idGemini, previas })
    const f = firma(valores)
    if (f && !previas.has(f)) previas.set(f, `la fila de la línea ${n} del pegado`)
    borradores.push({ ...base, reconocida: true, idGemini, valores, errores: { ...revision.errores, ...errores }, notas, duplicada: revision.duplicada })
  }
  return { error: borradores.length ? null : 'La tabla no trae filas de datos.', columnas, borradores }
}
