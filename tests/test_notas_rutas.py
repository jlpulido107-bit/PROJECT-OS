"""scripts/notas-rutas.py con un NOTAS de prueba (origen local en un directorio temporal): nunca toca la red."""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "notas-rutas.py"
INDICE = """# POS
## Ideas
- [Idea](ideas/idea.md) — idea · alta: algo.
## Referencia
- [Bitácora](referencia/bitacora.md) — foto 2026-10-20: tema.
## Hallazgos abiertos
- [Fallo](hallazgos/fallo.md) — abierto · alta: algo falla.
"""
BASE = {
    "_contexto/propietario.md": "Propietario\n",
    "POS/contexto.md": "Contexto\n",
    "POS/indice.md": INDICE,
    "POS/referencia/bitacora.md": "Bitácora\n",
    "POS/ideas/idea.md": "Idea\n",
    "privado/secreto.md": "No leer\n",
    "00-entrada/captura.md": "Captura\n",
}
ENTORNO = {**os.environ, "GIT_AUTHOR_NAME": "Prueba", "GIT_AUTHOR_EMAIL": "prueba@example.invalid",
           "GIT_COMMITTER_NAME": "Prueba", "GIT_COMMITTER_EMAIL": "prueba@example.invalid"}


class TestNotasRutas(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        origen, self.notas = self.tmp / "origen.git", self.tmp / "notas"
        self.git(self.tmp, "init", "-q", "--bare", "-b", "main", str(origen))
        self.git(self.tmp, "clone", "-q", str(origen), str(self.notas))
        self.git(self.notas, "checkout", "-q", "-b", "main")
        for ruta, texto in BASE.items():
            self.escribir(ruta, texto)
        self.commit("base")
        self.git(self.notas, "push", "-q", "origin", "main")

    def git(self, cwd, *args):
        subprocess.run(["git", *args], cwd=cwd, env=ENTORNO, check=True, capture_output=True)

    def escribir(self, ruta, texto):
        archivo = self.notas / ruta
        archivo.parent.mkdir(parents=True, exist_ok=True)
        archivo.write_text(texto, encoding="utf-8")

    def commit(self, mensaje):
        self.git(self.notas, "add", "-A")
        self.git(self.notas, "commit", "-q", "--allow-empty", "-m", mensaje)

    def correr(self):
        return subprocess.run([sys.executable, str(SCRIPT), str(self.notas)], capture_output=True, text=True)

    def assertPermitido(self):
        salida = self.correr()
        self.assertEqual(salida.returncode, 0, salida.stdout + salida.stderr)
        return salida

    def assertRechazado(self, *rutas):
        salida = self.correr()
        self.assertEqual(salida.returncode, 1, salida.stdout + salida.stderr)
        for ruta in rutas:
            self.assertIn(f"- {ruta}:", salida.stdout)
        return salida

    def test_sin_cambios_sale_con_cero(self):
        self.assertIn("OK: 0", self.assertPermitido().stdout)

    def test_zonas_permitidas(self):
        self.escribir("_contexto/glosario.md", "Glosario\n")
        self.escribir("_contexto/propietario.md", "Propietario v2\n")
        self.escribir("POS/contexto.md", "Contexto v2\n")
        self.escribir("SIG/contexto.md", "Contexto SIG\n")
        self.escribir("POS/referencia/bitacora.md", "Bitácora v2\n")
        self.escribir("ECO/referencia/tema/nueva.md", "Nueva\n")
        self.commit("zonas")
        self.assertIn("OK: 6", self.assertPermitido().stdout)

    def test_revisa_todos_los_commits_desde_origin_main(self):
        self.escribir("POS/contexto.md", "Contexto v2\n")
        self.commit("uno")
        self.escribir("POS/ideas/otra.md", "Otra\n")
        self.commit("dos")
        self.assertRechazado("POS/ideas/otra.md")

    def test_indice_solo_dentro_de_referencia(self):
        self.escribir("POS/indice.md", INDICE.replace(
            "## Hallazgos", "- [Nueva](referencia/nueva.md) — foto 2026-10-24: otro tema.\n## Hallazgos"))
        self.commit("indice")
        self.assertPermitido()

    def test_indice_nuevo_se_rechaza(self):
        # Crear el índice agrega el encabezado «## Referencia», que queda fuera de la sección: lo crea el propietario.
        self.escribir("DEV/indice.md", "## Referencia\n- [B](referencia/b.md) — foto 2026-10-24: tema.\n")
        self.commit("indice nuevo")
        self.assertRechazado("DEV/indice.md")

    def test_indice_fuera_de_referencia_se_rechaza(self):
        for cambio in (("algo.", "otra cosa."), ("## Referencia", "## Ref"), ("# POS\n", "# POS\nLínea nueva\n"),
                       ("- [Bitácora]", "## Ideas extra\n- [Bitácora]")):
            with self.subTest(cambio=cambio):
                self.escribir("POS/indice.md", INDICE.replace(*cambio))
                self.commit("indice")
                salida = self.assertRechazado("POS/indice.md")
                self.assertIn("fuera de «## Referencia»", salida.stdout)
                self.git(self.notas, "reset", "-q", "--hard", "origin/main")

    def test_borrados_se_rechazan_aunque_esten_en_zona(self):
        for ruta in ("POS/referencia/bitacora.md", "_contexto/propietario.md", "POS/ideas/idea.md"):
            (self.notas / ruta).unlink()
        self.commit("borrar")
        salida = self.assertRechazado("POS/referencia/bitacora.md", "_contexto/propietario.md", "POS/ideas/idea.md")
        self.assertIn("borrado", salida.stdout)

    def test_renombre_cuenta_como_borrado(self):
        self.git(self.notas, "mv", "POS/referencia/bitacora.md", "POS/referencia/renombrada.md")
        self.commit("renombrar")
        self.assertRechazado("POS/referencia/bitacora.md")

    def test_privado_y_carpetas_del_propietario_se_rechazan_con_lista(self):
        rechazadas = ["privado/secreto.md", "privado/nuevo.md", "00-entrada/otra.md", "POS/ideas/idea.md",
                      "SIG/decisiones/d.md", "ECO/hallazgos/h.md", "DEV/revisiones/r.md"]
        for ruta in rechazadas:
            self.escribir(ruta, "Cambio\n")
        self.escribir("POS/contexto.md", "Contexto v2\n")
        self.commit("prohibido")
        salida = self.assertRechazado(*rechazadas)
        self.assertNotIn("POS/contexto.md", salida.stdout)
        self.assertIn("privado/", salida.stdout)
        self.assertIn("carpeta del propietario", salida.stdout)
        self.assertIn(f"Rutas rechazadas ({len(rechazadas)})", salida.stdout)

    def test_fuera_de_las_zonas_se_rechaza(self):
        rechazadas = ["README.md", "POS/otra.md", "POS/sub/contexto.md", "POS/sub/indice.md",
                      "_plantillas/Idea.md", "_plantillas/referencia/x.md", "_contexto"]
        for ruta in rechazadas[:-1]:
            self.escribir(ruta, "Cambio\n")
        (self.notas / "_contexto").rename(self.tmp / "contexto-movido")
        self.escribir("_contexto", "Archivo, no carpeta\n")
        self.commit("fuera")
        self.assertRechazado(*rechazadas)

    def test_sin_origin_main_sale_con_uno(self):
        self.git(self.notas, "remote", "remove", "origin")
        salida = self.correr()
        self.assertEqual(salida.returncode, 1)
        self.assertIn("No se pudo comprobar", salida.stderr)

    def test_docs_notas_lo_pide_antes_de_cada_push(self):
        texto = (ROOT / "docs" / "notas.md").read_text(encoding="utf-8")
        self.assertIn("scripts/notas-rutas.py", texto)
        self.assertIn("antes de cada push directo", texto)


if __name__ == "__main__":
    unittest.main()
