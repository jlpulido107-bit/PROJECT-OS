#!/usr/bin/env python3
"""Revisión de salud del repositorio NOTAS, solo lectura (ORD-POS-081).

Uso: python scripts/notas-salud.py <ruta-del-checkout-de-NOTAS> [--estricto]

Reporta en markdown enlaces rotos, notas fuera de su indice.md, frontmatter incompleto según la plantilla de su tipo
(_plantillas/) y secciones vacías. No escribe nada. Nunca lista, lee ni busca en privado/: la carpeta se descarta por
su nombre antes de abrirla y los enlaces que apuntan a ella no se verifican. Tampoco lee el contenido de 00-entrada/
(docs/notas.md: los agentes no la leen sin que el propietario lo pida); sus nombres sí cuentan como destinos de enlaces.
Con --estricto sale con 1 si hay hallazgos; 2 si la ruta no sirve.
"""
import argparse
import os
import posixpath
import re
import sys
from urllib.parse import unquote, urlsplit

PRIVADO = "privado"
ENTRADA = "00-entrada"
PLANTILLAS = "_plantillas"
IGNORADAS = {".git", ".obsidian", ".trash"}
# Subcarpetas por tipo de cada proyecto (docs/notas.md); las revisiones no entran al índice.
SUBCARPETAS = ("ideas", "decisiones", "hallazgos", "revisiones", "referencia")
FUERA_DEL_INDICE = {"revisiones"}
# Lo descartado o resuelto sale del índice; la nota se queda con su estado.
ESTADOS_SIN_INDICE = {"descartada", "descartado", "resuelto"}

FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
CODIGO = re.compile(r"(`+).*?\1")
ENLACE = re.compile(r'\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\s*\)')
WIKI = re.compile(r"\[\[([^\]\n]+)\]\]")
TITULO = re.compile(r"^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
CLAVE = re.compile(r"^([A-Za-z_][\w-]*):(.*)$")


def es_privado(relativa):
    """Si algún tramo de la ruta es privado/, con cualquier combinación de mayúsculas (Privado/, PRIVADO/…)."""
    return any(tramo.casefold() == PRIVADO for tramo in relativa.split("/"))


def recorrer(raiz):
    """Archivos y carpetas de la bóveda (rutas relativas con /), sin entrar nunca en privado/ ni seguir enlaces."""
    archivos, carpetas = [], set()
    pendientes = [""]
    while pendientes:
        relativa = pendientes.pop()
        with os.scandir(os.path.join(raiz, relativa) if relativa else raiz) as entradas:
            for entrada in sorted(entradas, key=lambda e: e.name):
                hija = posixpath.join(relativa, entrada.name) if relativa else entrada.name
                # Se descarta por nombre, antes de cualquier llamada sobre la carpeta.
                if es_privado(hija) or entrada.name in IGNORADAS:
                    continue
                if entrada.is_symlink():
                    continue
                if entrada.is_dir(follow_symlinks=False):
                    carpetas.add(hija)
                    pendientes.append(hija)
                elif entrada.is_file(follow_symlinks=False):
                    archivos.append(hija)
    return sorted(archivos), carpetas


def leer(raiz, relativa):
    if es_privado(relativa):
        raise ValueError(f"privado/ nunca se lee: {relativa}")
    with open(os.path.join(raiz, relativa), encoding="utf-8") as archivo:
        return archivo.read()


def frontmatter(texto):
    """{clave: valor} del bloque --- inicial, sin comentarios #; None si no hay bloque."""
    lineas = texto.splitlines()
    if not lineas or lineas[0].strip() != "---":
        return None
    campos = {}
    for linea in lineas[1:]:
        if linea.strip() == "---":
            return campos
        coincide = CLAVE.match(linea)
        if coincide:
            campos[coincide[1]] = re.split(r"(?:^|\s)#", coincide[2], maxsplit=1)[0].strip()
    return None


def cuerpo(texto):
    """Líneas del documento tras el frontmatter, con su número, y si cada una está dentro de un bloque de código."""
    lineas = texto.splitlines()
    inicio = 0
    if lineas and lineas[0].strip() == "---":
        for numero, linea in enumerate(lineas[1:], 1):
            if linea.strip() == "---":
                inicio = numero + 1
                break
    fence = None
    for numero in range(inicio, len(lineas)):
        linea = lineas[numero]
        marca = FENCE.match(linea)
        if fence is not None:
            if marca and marca[1][0] == fence[0] and len(marca[1]) >= len(fence):
                fence = None
            yield numero + 1, linea, True
            continue
        if marca:
            fence = marca[1]
            yield numero + 1, linea, True
            continue
        yield numero + 1, linea, False


def enlaces(texto):
    """(línea, tipo, destino) de enlaces markdown y wikilinks fuera de código."""
    for numero, linea, en_codigo in cuerpo(texto):
        if en_codigo:
            continue
        limpia = CODIGO.sub("", linea)
        for coincide in ENLACE.finditer(limpia):
            yield numero, "md", coincide[1] or coincide[2]
        for coincide in WIKI.finditer(limpia):
            yield numero, "wiki", coincide[1]


def destino_md(nota, destino):
    """Ruta relativa a la bóveda del destino, o None si no es un archivo local (URL, ancla, ruta absoluta)."""
    url = urlsplit(destino)
    if url.scheme or url.netloc or not url.path or url.path.startswith("/"):
        return None
    return posixpath.normpath(posixpath.join(posixpath.dirname(nota), unquote(url.path)))


def existe_wiki(destino, archivos):
    objetivo = destino.split("|", 1)[0].split("#", 1)[0].strip()
    if not objetivo:
        return True, objetivo
    candidatos = {objetivo, objetivo + ".md"}
    if "/" in objetivo:
        return bool(candidatos & set(archivos)), objetivo
    nombres = {posixpath.basename(a) for a in archivos}
    return bool(candidatos & nombres), objetivo


def enlaces_rotos(raiz, archivos, carpetas, textos):
    hallazgos = []
    conjunto = set(archivos)
    for nota, texto in textos.items():
        for numero, tipo, destino in enlaces(texto):
            if tipo == "wiki":
                ok, objetivo = existe_wiki(destino, archivos)
                if es_privado(objetivo) or ok:
                    continue
            else:
                relativa = destino_md(nota, destino)
                if relativa is None or es_privado(relativa):
                    continue
                if relativa.startswith("../") or relativa == "..":
                    hallazgos.append(f"`{nota}:{numero}` → `{destino}` (fuera de la bóveda)")
                    continue
                if relativa in conjunto or relativa in carpetas:
                    continue
            hallazgos.append(f"`{nota}:{numero}` → `{destino}`")
    return hallazgos


def notas_fuera_del_indice(archivos, textos, metadatos):
    hallazgos = []
    proyectos = sorted({a.split("/", 1)[0] for a in archivos if a.count("/") == 1 and a.endswith("/indice.md")})
    for proyecto in proyectos:
        indice = f"{proyecto}/indice.md"
        enlazadas = set()
        for _, tipo, destino in enlaces(textos.get(indice, "")):
            if tipo == "md":
                relativa = destino_md(indice, destino)
                if relativa:
                    enlazadas.add(relativa)
            else:
                objetivo = destino.split("|", 1)[0].split("#", 1)[0].strip()
                enlazadas.update({f"{proyecto}/{objetivo}", f"{proyecto}/{objetivo}.md", objetivo, objetivo + ".md"})
        for nota in archivos:
            partes = nota.split("/")
            if len(partes) < 3 or partes[0] != proyecto or partes[1] not in SUBCARPETAS:
                continue
            if partes[1] in FUERA_DEL_INDICE or not nota.endswith(".md"):
                continue
            if (metadatos.get(nota) or {}).get("estado") in ESTADOS_SIN_INDICE:
                continue
            nombre = posixpath.basename(nota)
            if nota in enlazadas or nombre in enlazadas or nombre[:-3] in enlazadas:
                continue
            hallazgos.append(f"`{nota}` no está en `{indice}`")
    return hallazgos


def plantillas(archivos, textos):
    """{tipo: (archivo, {clave: valor de ejemplo})} leídas de _plantillas/."""
    resultado = {}
    for archivo in archivos:
        if not archivo.startswith(PLANTILLAS + "/") or not archivo.endswith(".md"):
            continue
        campos = frontmatter(textos[archivo]) or {}
        if campos.get("tipo"):
            resultado[campos["tipo"]] = (archivo, campos)
    return resultado


def frontmatter_incompleto(archivos, metadatos, por_tipo):
    hallazgos = []
    for nota in archivos:
        if not nota.endswith(".md") or nota.startswith(PLANTILLAS + "/") or nota not in metadatos:
            continue
        partes = nota.split("/")
        en_subcarpeta = len(partes) >= 3 and partes[1] in SUBCARPETAS
        campos = metadatos[nota]
        if campos is None:
            if en_subcarpeta:
                hallazgos.append(f"`{nota}`: sin frontmatter")
            continue
        tipo = campos.get("tipo")
        if not tipo:
            if en_subcarpeta:
                hallazgos.append(f"`{nota}`: falta `tipo`")
            continue
        if tipo not in por_tipo:
            hallazgos.append(f"`{nota}`: tipo `{tipo}` sin plantilla en `{PLANTILLAS}/`")
            continue
        plantilla, esperados = por_tipo[tipo]
        faltan = [c for c in esperados if c not in campos]
        # Un campo que la plantilla trae vacío (tarea:, proyecto: de Captura) puede seguir vacío.
        vacios = [c for c in esperados if c in campos and not campos[c] and esperados[c]]
        detalle = [f"falta `{c}`" for c in faltan] + [f"`{c}` vacío" for c in vacios]
        if detalle:
            hallazgos.append(f"`{nota}` ({tipo}, según `{plantilla}`): " + ", ".join(detalle))
    return hallazgos


def es_vacia(linea):
    limpia = linea.strip()
    return not limpia or limpia in {"-", "*", "+", "- [ ]", "<!-- -->"}


def secciones_vacias(nota, texto):
    """Títulos sin contenido hasta el siguiente título de su nivel o superior (o el final)."""
    hallazgos = []
    abierto = None  # (nivel, línea, título, tiene_contenido)
    for numero, linea, en_codigo in cuerpo(texto):
        coincide = None if en_codigo else TITULO.match(linea)
        if coincide:
            nivel = len(coincide[1])
            if abierto and not abierto[3]:
                if nivel <= abierto[0]:
                    hallazgos.append(f"`{nota}:{abierto[1]}` «{'#' * abierto[0]} {abierto[2]}»")
            abierto = (nivel, numero, coincide[2], False)
        elif abierto and not abierto[3] and not es_vacia(linea):
            abierto = abierto[:3] + (True,)
    if abierto and not abierto[3]:
        hallazgos.append(f"`{nota}:{abierto[1]}` «{'#' * abierto[0]} {abierto[2]}»")
    return hallazgos


def revisar(raiz):
    archivos, carpetas = recorrer(raiz)
    legibles = [a for a in archivos if a.endswith(".md") and not a.startswith(ENTRADA + "/")]
    textos = {a: leer(raiz, a) for a in legibles}
    metadatos = {a: frontmatter(t) for a, t in textos.items()}
    por_tipo = plantillas(archivos, textos)
    notas = [a for a in legibles if not a.startswith(PLANTILLAS + "/")
             and posixpath.basename(a) not in {"indice.md", "README.md"}]
    secciones = []
    for nota in notas:
        secciones += secciones_vacias(nota, textos[nota])
    return {
        "revisadas": len(legibles),
        "plantillas": sorted(por_tipo),
        "grupos": [
            ("Enlaces rotos", enlaces_rotos(raiz, archivos, carpetas, textos)),
            ("Notas fuera de su indice.md", notas_fuera_del_indice(archivos, textos, metadatos)),
            ("Frontmatter incompleto", frontmatter_incompleto(archivos, metadatos, por_tipo)
             if por_tipo else [f"no hay plantillas con `tipo` en `{PLANTILLAS}/`: no se valida el frontmatter"]),
            ("Secciones vacías", secciones),
        ],
    }


def informe(resultado):
    total = sum(len(h) for _, h in resultado["grupos"])
    lineas = [
        "# Salud de NOTAS",
        "",
        f"Archivos markdown revisados: {resultado['revisadas']}. Plantillas: "
        + (", ".join(f"`{t}`" for t in resultado["plantillas"]) or "ninguna") + ".",
        f"Sin abrir: `{PRIVADO}/` (nunca) y el contenido de `{ENTRADA}/`. Solo lectura.",
    ]
    for titulo, hallazgos in resultado["grupos"]:
        lineas += ["", f"## {titulo} ({len(hallazgos)})", ""]
        lineas += [f"- {h}" for h in hallazgos] or ["Ninguno."]
    lineas += ["", f"Total: {total} hallazgo{'s' if total != 1 else ''}."]
    return "\n".join(lineas) + "\n", total


def main(argv=None):
    parser = argparse.ArgumentParser(description="Revisión de salud de NOTAS, solo lectura; nunca abre privado/.")
    parser.add_argument("ruta", help="ruta de un checkout del repositorio NOTAS")
    parser.add_argument("--estricto", action="store_true", help="sale con 1 si hay hallazgos")
    args = parser.parse_args(argv)
    if not os.path.isdir(args.ruta):
        print(f"No es una carpeta: {args.ruta}", file=sys.stderr)
        return 2
    texto, total = informe(revisar(args.ruta))
    sys.stdout.write(texto)
    return 1 if args.estricto and total else 0


if __name__ == "__main__":
    sys.exit(main())
