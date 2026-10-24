#!/usr/bin/env python3
"""Comprueba, antes de un push directo de POS · Ideas a NOTAS, que los cambios caen solo en las zonas permitidas.

Uso: python scripts/notas-rutas.py [CHECKOUT_DE_NOTAS] [--base origin/main]

Revisa los archivos que cambian los commits de origin/main..HEAD (diferencia contra la base común, sin renombres:
un renombre cuenta como borrado más alta). Permitido: _contexto/, <PRY>/contexto.md, <PRY>/referencia/ y
<PRY>/indice.md con cambios solo dentro de «## Referencia». Rechaza borrados, privado/ y las carpetas del
propietario. Sale con 0 si todo está permitido y con 1 si no (o si no puede comprobarlo). Solo lee.
Zonas: docs/notas.md, «Escritura directa limitada (POS · Ideas)».
"""
import argparse
import subprocess
import sys

CARPETAS_PROPIETARIO = ("ideas", "decisiones", "hallazgos", "revisiones")
SECCION_PERMITIDA = "## Referencia"


def git(repo, *args):
    salida = subprocess.run(["git", "-C", repo, *args], capture_output=True)
    if salida.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {salida.stderr.decode('utf-8', 'replace').strip()}")
    return salida.stdout


def contenido(repo, rev, ruta):
    """Texto de la ruta en rev, o '' si no existía."""
    try:
        return git(repo, "show", f"{rev}:{ruta}").decode("utf-8")
    except RuntimeError:
        return ""


def fuera_de_referencia(texto):
    """Líneas fuera de la sección «## Referencia» (el propio encabezado cuenta como fuera)."""
    fuera, dentro = [], False
    for linea in texto.splitlines():
        if linea.startswith("## "):
            dentro = linea.strip() == SECCION_PERMITIDA
            fuera.append(linea)
        elif not dentro:
            fuera.append(linea)
    return fuera


def es_proyecto(carpeta):
    return carpeta not in ("privado", "00-entrada") and not carpeta.startswith(("_", "."))


def motivo_rechazo(repo, base, estado, ruta):
    """None si la ruta está permitida; si no, el motivo."""
    partes = ruta.split("/")
    if estado == "D":
        return "borrado"
    if partes[0] == "privado":
        return "privado/"
    if partes[0] == "00-entrada" or (len(partes) > 2 and partes[1] in CARPETAS_PROPIETARIO):
        return "carpeta del propietario"
    if partes[0] == "_contexto" and len(partes) > 1:
        return None
    if len(partes) == 2 and es_proyecto(partes[0]) and partes[1] == "contexto.md":
        return None
    if len(partes) > 2 and es_proyecto(partes[0]) and partes[1] == "referencia":
        return None
    if len(partes) == 2 and es_proyecto(partes[0]) and partes[1] == "indice.md":
        antes = fuera_de_referencia(contenido(repo, base, ruta))
        despues = fuera_de_referencia(contenido(repo, "HEAD", ruta))
        return None if antes == despues else "indice.md cambia fuera de «## Referencia»"
    return "fuera de las zonas permitidas"


def cambios(repo, base):
    """[(estado, ruta)] de los commits de base..HEAD, contra la base común."""
    comun = git(repo, "merge-base", base, "HEAD").decode().strip()
    campos = git(repo, "diff", "--name-status", "--no-renames", "-z", comun, "HEAD").decode("utf-8").split("\0")
    campos = [c for c in campos if c]
    return comun, [(campos[i][0], campos[i + 1]) for i in range(0, len(campos), 2)]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("repo", nargs="?", default=".", help="checkout de NOTAS (por defecto, el directorio actual)")
    parser.add_argument("--base", default="origin/main")
    args = parser.parse_args(argv)
    try:
        comun, lista = cambios(args.repo, args.base)
        rechazos = [(ruta, motivo) for estado, ruta in lista
                    if (motivo := motivo_rechazo(args.repo, comun, estado, ruta))]
    except (RuntimeError, UnicodeDecodeError) as error:
        print(f"No se pudo comprobar: {error}", file=sys.stderr)
        return 1
    if rechazos:
        print(f"Rutas rechazadas ({len(rechazos)}); no hagas push:")
        for ruta, motivo in rechazos:
            print(f"- {ruta}: {motivo}")
        return 1
    print(f"OK: {len(lista)} ruta(s) en zonas permitidas.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
