#!/usr/bin/env python3
"""Comprueba, antes de un push directo de POS · Ideas a NOTAS, que los cambios caen solo en las zonas permitidas.

Uso: python scripts/notas-rutas.py [CHECKOUT_DE_NOTAS] [--base origin/main]

Revisa cada commit de origin/main..HEAD contra cada uno de sus padres (sin renombres: un renombre cuenta como
borrado más alta), no solo el árbol neto. Permitido: _contexto/, <PRY>/contexto.md, <PRY>/referencia/ y
<PRY>/indice.md con cambios solo dentro de «## Referencia», donde <PRY> es un código de proyecto de tres mayúsculas
(POS, SIG, ECO, DEV). Rechaza borrados, privado/ y las carpetas del propietario sin distinguir mayúsculas, y todo lo
que no sea un archivo normal (enlaces simbólicos, submódulos). Sale con 0 si todo está permitido y con 1 si no (o si
no puede comprobarlo). Solo lee.
Zonas: docs/notas.md, «Escritura directa limitada (POS · Ideas)».
"""
import argparse
import re
import subprocess
import sys

CARPETAS_PROPIETARIO = ("ideas", "decisiones", "hallazgos", "revisiones")
SECCION_PERMITIDA = "## Referencia"
MODOS_ARCHIVO = ("100644", "100755")
MODOS_NOMBRE = {"120000": "enlace simbólico", "160000": "submódulo"}
PROYECTO = re.compile(r"[A-Z]{3}")


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
    # Solo códigos de proyecto exactos: «Privado», «00-Entrada» o «pos» no cuentan como proyecto.
    return PROYECTO.fullmatch(carpeta) is not None


def motivo_rechazo(repo, padre, commit, estado, modo, ruta):
    """None si la ruta está permitida; si no, el motivo."""
    partes = ruta.split("/")
    # Sin distinguir mayúsculas: en el Obsidian del propietario Privado/ es privado/.
    plegadas = [parte.casefold() for parte in partes]
    if estado == "D":
        return "borrado"
    if plegadas[0] == "privado":
        return "privado/"
    if plegadas[0] == "00-entrada" or (len(partes) > 2 and plegadas[1] in CARPETAS_PROPIETARIO):
        return "carpeta del propietario"
    if modo not in MODOS_ARCHIVO:
        return MODOS_NOMBRE.get(modo, f"modo {modo} no permitido")
    if partes[0] == "_contexto" and len(partes) > 1:
        return None
    if len(partes) == 2 and es_proyecto(partes[0]) and partes[1] == "contexto.md":
        return None
    if len(partes) > 2 and es_proyecto(partes[0]) and partes[1] == "referencia":
        return None
    if len(partes) == 2 and es_proyecto(partes[0]) and partes[1] == "indice.md":
        antes = fuera_de_referencia(contenido(repo, padre, ruta))
        despues = fuera_de_referencia(contenido(repo, commit, ruta))
        return None if antes == despues else "indice.md cambia fuera de «## Referencia»"
    return "fuera de las zonas permitidas"


def cambios(repo, base):
    """[(padre, commit, estado, modo, ruta)] de cada commit de base..HEAD contra cada uno de sus padres."""
    comun = git(repo, "merge-base", base, "HEAD").decode().strip()
    lista = []
    for linea in git(repo, "rev-list", "--reverse", "--parents", "HEAD", f"^{comun}").decode().splitlines():
        commit, *padres = linea.split()
        for padre in padres:
            # --raw da «:modo_antes modo_despues sha sha estado» y luego la ruta.
            campos = git(repo, "diff", "--raw", "--no-renames", "-z", padre, commit).decode("utf-8").split("\0")
            campos = [c for c in campos if c]
            for i in range(0, len(campos), 2):
                meta = campos[i].split()
                lista.append((padre, commit, meta[4][0], meta[1], campos[i + 1]))
    return lista


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("repo", nargs="?", default=".", help="checkout de NOTAS (por defecto, el directorio actual)")
    parser.add_argument("--base", default="origin/main")
    args = parser.parse_args(argv)
    try:
        lista = cambios(args.repo, args.base)
        # Sin repetir: una ruta que varios commits rechazan por lo mismo sale una vez.
        rechazos = list(dict.fromkeys((ruta, motivo) for padre, commit, estado, modo, ruta in lista
                                      if (motivo := motivo_rechazo(args.repo, padre, commit, estado, modo, ruta))))
        rutas = {ruta for *_, ruta in lista}
    except (RuntimeError, UnicodeDecodeError) as error:
        print(f"No se pudo comprobar: {error}", file=sys.stderr)
        return 1
    if rechazos:
        print(f"Rutas rechazadas ({len(rechazos)}); no hagas push:")
        for ruta, motivo in rechazos:
            print(f"- {ruta}: {motivo}")
        return 1
    print(f"OK: {len(rutas)} ruta(s) en zonas permitidas.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
