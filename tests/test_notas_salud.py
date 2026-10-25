"""scripts/notas-salud.py sobre la bóveda de ejemplo: solo lectura y nunca abre privado/ (ORD-POS-081)."""
import builtins
import contextlib
import importlib.util
import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "notas-salud.py"
BOVEDA = ROOT / "tests" / "fixtures" / "notas-ejemplo"
PLANTILLA = ROOT / "docs" / "plantilla-notas"

spec = importlib.util.spec_from_file_location("notas_salud", SCRIPT)
notas_salud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notas_salud)


def foto(raiz):
    """Contenido y fecha de cada archivo, para comprobar que nada cambió."""
    return {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in sorted(Path(raiz).rglob("*")) if p.is_file()}


def ejecutar(*args):
    return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, check=False)


class TestNotasSalud(unittest.TestCase):
    def test_reporta_los_cuatro_tipos_de_hallazgo(self):
        salida = ejecutar(str(BOVEDA))
        self.assertEqual(salida.returncode, 0, salida.stderr)
        texto = salida.stdout
        self.assertTrue(texto.startswith("# Salud de NOTAS\n"))
        esperados = {
            "## Enlaces rotos (3)": [
                "- `POS/ideas/idea-sin-indice.md:16` → `../hallazgos/fantasma.md`",
                "- `POS/ideas/idea-sin-indice.md:16` → `Nota fantasma`",
                "- `POS/indice.md:5` → `ideas/no-existe.md`",
            ],
            "## Notas fuera de su indice.md (2)": [
                "- `POS/ideas/idea-sin-indice.md` no está en `POS/indice.md`",
                "- `SIG/decisiones/sin-frontmatter.md` no está en `SIG/indice.md`",
            ],
            "## Frontmatter incompleto (3)": [
                "- `POS/hallazgos/hallazgo-sin-prioridad.md` (hallazgo, según `_plantillas/Hallazgo.md`): "
                "falta `prioridad`, `estado` vacío",
                "- `POS/ideas/idea-sin-indice.md` (idea, según `_plantillas/Idea.md`): falta `urgencia`",
                "- `SIG/decisiones/sin-frontmatter.md`: sin frontmatter",
            ],
            "## Secciones vacías (2)": [
                "- `POS/ideas/idea-sin-indice.md:13` «## Problema»",
                "- `POS/revisiones/2026-10-20.md:12` «## Se trabó (y por qué)»",
            ],
        }
        for titulo, lineas in esperados.items():
            self.assertIn(titulo, texto)
            seccion = texto.split(titulo, 1)[1].split("\n## ", 1)[0]
            self.assertEqual([l for l in seccion.splitlines() if l.startswith("- ")], lineas, titulo)
        self.assertTrue(texto.endswith("Total: 10 hallazgos.\n"))

    def test_no_reporta_lo_que_es_valido(self):
        texto = ejecutar(str(BOVEDA)).stdout
        # Descartada fuera del índice, revisiones, wikilink existente, enlaces dentro de código y tarea: vacío.
        for ausente in ("idea-descartada", "revisiones/2026-10-20.md` no está",
                        "Esto es código", "`tarea` vacío", "ejemplo-idea", "00-entrada", "secreto"):
            self.assertNotIn(ausente, texto.split("Solo lectura.", 1)[1])

    def test_estricto_sale_distinto_de_0_con_hallazgos(self):
        self.assertEqual(ejecutar(str(BOVEDA), "--estricto").returncode, 1)
        # La plantilla de NOTAS de este repositorio está sana: --estricto sale con 0.
        limpia = ejecutar(str(PLANTILLA), "--estricto")
        self.assertEqual(limpia.returncode, 0, limpia.stdout)
        self.assertIn("Total: 0 hallazgos.", limpia.stdout)

    def test_ruta_invalida(self):
        salida = ejecutar(str(BOVEDA / "no-existe"))
        self.assertEqual(salida.returncode, 2)
        self.assertIn("No es una carpeta", salida.stderr)

    def test_nota_no_utf8_es_hallazgo_y_sigue(self):
        with tempfile.TemporaryDirectory() as tmp:
            boveda = Path(tmp) / "notas"
            shutil.copytree(BOVEDA, boveda)
            (boveda / "latin1.md").write_bytes("# Idea\n\nCampaña\n".encode("latin-1"))
            salida = ejecutar(str(boveda), "--estricto")
        self.assertEqual(salida.returncode, 1, salida.stderr)
        self.assertNotIn("Traceback", salida.stderr)
        texto = salida.stdout
        seccion = texto.split("## Notas que no son UTF-8 (1)", 1)[1].split("\n## ", 1)[0]
        self.assertIn("- `latin1.md`: no es UTF-8", seccion)
        # El resto de la bóveda se sigue revisando.
        self.assertIn("## Enlaces rotos (3)", texto)
        self.assertTrue(texto.endswith("Total: 11 hallazgos.\n"))

    def test_no_escribe_nada(self):
        antes = foto(BOVEDA)
        aperturas = []
        abrir = builtins.open

        def espiar(ruta, modo="r", *args, **kwargs):
            aperturas.append((str(ruta), modo))
            return abrir(ruta, modo, *args, **kwargs)

        with mock.patch("builtins.open", espiar), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(notas_salud.main([str(BOVEDA)]), 0)
        self.assertTrue(aperturas)
        self.assertEqual({modo for _, modo in aperturas}, {"r"})
        self.assertEqual(foto(BOVEDA), antes)

    def test_nunca_lista_lee_ni_busca_en_privado(self):
        self.assertTrue((BOVEDA / "privado" / "secreto.md").is_file())
        tocadas = []
        scandir, abrir = os.scandir, builtins.open

        def espiar_scandir(ruta="."):
            tocadas.append(str(ruta))
            return scandir(ruta)

        def espiar_open(ruta, *args, **kwargs):
            tocadas.append(str(ruta))
            return abrir(ruta, *args, **kwargs)

        sondas = {nombre: mock.patch(f"os.{nombre}", side_effect=AssertionError(f"os.{nombre} no se usa"))
                  for nombre in ("listdir", "walk")}
        with mock.patch("os.scandir", espiar_scandir), mock.patch("builtins.open", espiar_open), \
                contextlib.ExitStack() as pila, contextlib.redirect_stdout(io.StringIO()) as salida:
            for sonda in sondas.values():
                pila.enter_context(sonda)
            notas_salud.main([str(BOVEDA)])
        self.assertTrue(any(r.endswith("_plantillas") for r in tocadas))
        privado = os.path.join(str(BOVEDA), "privado")
        self.assertEqual([r for r in tocadas if r == privado or r.startswith(privado + os.sep)], [])
        # Ni sus hallazgos (enlace roto, sección vacía, frontmatter) ni su nombre aparecen en el informe.
        self.assertNotIn("secreto", salida.getvalue())
        self.assertNotIn("Nunca debe leerse", salida.getvalue())

    def test_privado_con_cualquier_mayuscula(self):
        # En una copia temporal: privado/ y Privado/ no pueden convivir en un sistema de archivos sin mayúsculas.
        with tempfile.TemporaryDirectory() as tmp:
            raiz = os.path.join(tmp, "notas")
            shutil.copytree(BOVEDA, raiz, ignore=shutil.ignore_patterns("privado"))
            for carpeta in ("Privado", "PRIVADO", os.path.join("POS", "Privado")):
                os.makedirs(os.path.join(raiz, carpeta))
                with open(os.path.join(raiz, carpeta, "oculta.md"), "w", encoding="utf-8") as nota:
                    nota.write("# Oculta\n\n## Vacia\n\n[roto](no-existe.md)\n")
            tocadas = []
            scandir, abrir = os.scandir, builtins.open

            def espiar_scandir(ruta="."):
                tocadas.append(str(ruta))
                return scandir(ruta)

            def espiar_open(ruta, *args, **kwargs):
                tocadas.append(str(ruta))
                return abrir(ruta, *args, **kwargs)

            with mock.patch("os.scandir", espiar_scandir), mock.patch("builtins.open", espiar_open), \
                    contextlib.redirect_stdout(io.StringIO()) as salida:
                notas_salud.main([raiz])
        self.assertTrue(any(r.endswith("_plantillas") for r in tocadas))
        relativas = [os.path.relpath(r, raiz) for r in tocadas]
        self.assertEqual([r for r in relativas if "privado" in r.casefold().split(os.sep)], [])
        self.assertNotIn("oculta", salida.getvalue().casefold())

    def test_leer_rechaza_privado(self):
        for ruta in ("privado", "privado/secreto.md", "Privado/n.md", "PRIVADO", "POS/Privado/n.md"):
            with self.assertRaises(ValueError):
                notas_salud.leer(str(BOVEDA), ruta)


if __name__ == "__main__":
    unittest.main()
