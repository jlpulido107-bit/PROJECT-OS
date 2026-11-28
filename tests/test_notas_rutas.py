"""scripts/notas-rutas.py con un NOTAS de prueba (origen local en un directorio temporal): nunca toca la red."""
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "notas-rutas.py"
spec = importlib.util.spec_from_file_location("notas_rutas", SCRIPT)
notas_rutas = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notas_rutas)
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
    "POS/referencia/antigravity/encargos.md": "Skill\n",
    "POS/ideas/idea.md": "Idea\n",
    "privado/secreto.md": "No leer\n",
    "00-entrada/captura.md": "Captura\n",
}
SKILLS = "skills de Antigravity (solo por PR del propietario)"
FUERA = "fuera de las zonas permitidas"
# ORD-POS-179, una fila por ruta: el motivo con el que se rechaza, o None si sigue permitida.
RUTAS_ANTIGRAVITY = {
    # La carpeta de las skills: lo que ya existe, lo nuevo, a cualquier profundidad y en cualquier proyecto.
    "POS/referencia/antigravity/encargos.md": SKILLS,
    "POS/referencia/antigravity/nueva-skill.md": SKILLS,
    "POS/referencia/antigravity/Entrega-Antigravity.md": SKILLS,
    "POS/referencia/antigravity/cotizaciones/SKILL.md": SKILLS,
    "SIG/referencia/antigravity/skill.md": SKILLS,
    "ECO/referencia/antigravity/skill.md": SKILLS,
    "DEV/referencia/antigravity/skill.md": SKILLS,
    "ALI/referencia/antigravity/skill.md": SKILLS,
    # La misma carpeta en la Mac, que no distingue mayúsculas (y en HFS+ tampoco el carácter invisible U+200D).
    "POS/referencia/Antigravity/skill.md": SKILLS,
    "POS/referencia/ANTIGRAVITY/skill.md": SKILLS,
    "POS/Referencia/antigravity/skill.md": SKILLS,
    "pos/referencia/antigravity/skill.md": SKILLS,
    "POS/referencia/antigravity\u200d/skill.md": SKILLS,
    # Nombres que solo se le parecen: se rechazan de más, a propósito.
    "POS/referencia/anti-gravity/skill.md": SKILLS,
    "POS/referencia/antigravity /skill.md": SKILLS,
    "POS/referencia/antigravity./skill.md": SKILLS,
    "POS/referencia/\uff21ntigravity/skill.md": SKILLS,
    # Siguen permitidas: las bitácoras, también la que habla de Antigravity, y el resto de las zonas.
    "POS/referencia/bitacora.md": None,
    "POS/referencia/antigravity.md": None,
    "POS/referencia/antigravity-2026-11-27.md": None,
    "POS/referencia/tema/antigravity/nota.md": None,
    "_contexto/glosario.md": None,
    "POS/contexto.md": None,
    # Siguen fuera, como antes: la cola de encargos, su archivo y las plantillas.
    "POS/encargos/ENC-001.md": FUERA,
    "POS/archivo/encargos/ENC-001.md": FUERA,
    "_plantillas/Entrega-Antigravity.md": FUERA,
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

    def git(self, cwd, *args, entrada=None):
        return subprocess.run(["git", *args], cwd=cwd, env=ENTORNO, check=True, capture_output=True, input=entrada)

    def escribir(self, ruta, texto):
        archivo = self.notas / ruta
        archivo.parent.mkdir(parents=True, exist_ok=True)
        archivo.write_text(texto, encoding="utf-8")

    def commit(self, mensaje):
        self.git(self.notas, "add", "-A")
        self.git(self.notas, "commit", "-q", "--allow-empty", "-m", mensaje)

    def commit_rutas(self, rutas):
        """Un commit que agrega o cambia las rutas sin escribirlas en disco: no depende de si el sistema de archivos
        distingue mayúsculas."""
        blob = self.git(self.notas, "hash-object", "-w", "--stdin", entrada=b"Cambio\n").stdout.decode().strip()
        entradas = "".join(f"100644 {blob}\t{ruta}\n" for ruta in rutas)
        self.git(self.notas, "update-index", "--add", "--index-info", entrada=entradas.encode("utf-8"))
        self.git(self.notas, "commit", "-q", "-m", "rutas")

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

    def test_mayusculas_y_carpetas_que_no_son_de_proyecto_se_rechazan(self):
        # H1 de REV-ORD-POS-082-1: en un sistema de archivos sin mayúsculas, Privado/ es privado/.
        rechazadas = {"Privado/contexto.md": "privado/", "PRIVADO/referencia/x.md": "privado/",
                      "00-Entrada/referencia/x.md": "carpeta del propietario",
                      "POS/Ideas/x.md": "carpeta del propietario", "pos/referencia/x.md": "fuera de las zonas",
                      "Notas/contexto.md": "fuera de las zonas", "POSX/indice.md": "fuera de las zonas"}
        for ruta in rechazadas:
            self.escribir(ruta, "Cambio\n")
        self.commit("mayusculas")
        salida = self.assertRechazado(*rechazadas)
        for ruta, motivo in rechazadas.items():
            self.assertIn(f"- {ruta}: {motivo}", salida.stdout)

    def test_enlaces_simbolicos_se_rechazan_aunque_esten_en_zona(self):
        # H2 de REV-ORD-POS-082-1: la ruta está en zona, pero el enlace apunta a privado/.
        for ruta, destino in (("POS/referencia/enl.md", "../../privado/secreto.md"),
                              ("_contexto/enl.md", "../privado/secreto.md")):
            (self.notas / ruta).symlink_to(destino)
        self.commit("enlaces")
        salida = self.assertRechazado("POS/referencia/enl.md", "_contexto/enl.md")
        self.assertIn("enlace simbólico", salida.stdout)

    def test_revisa_cada_commit_y_no_solo_el_arbol_neto(self):
        # H3 de REV-ORD-POS-082-1: el árbol neto no cambia, pero el push lleva estos commits.
        self.escribir("privado/n.md", "Nuevo\n")
        self.commit("agrega privado")
        (self.notas / "privado" / "n.md").unlink()
        (self.notas / "POS" / "referencia" / "bitacora.md").unlink()
        self.commit("borra")
        self.escribir("POS/referencia/bitacora.md", "Bitácora\n")
        self.commit("restaura")
        salida = self.assertRechazado("privado/n.md", "POS/referencia/bitacora.md")
        self.assertIn("- privado/n.md: privado/", salida.stdout)
        self.assertIn("- POS/referencia/bitacora.md: borrado", salida.stdout)

    def test_sin_origin_main_sale_con_uno(self):
        self.git(self.notas, "remote", "remove", "origin")
        salida = self.correr()
        self.assertEqual(salida.returncode, 1)
        self.assertIn("No se pudo comprobar", salida.stderr)

    def test_antigravity_ruta_por_ruta(self):
        # Alta («A») y cambio («M») de cada ruta de la tabla.
        for ruta, motivo in RUTAS_ANTIGRAVITY.items():
            for estado in "AM":
                with self.subTest(ruta=ruta, estado=estado):
                    self.assertEqual(notas_rutas.motivo_rechazo(None, None, None, estado, "100644", ruta), motivo)
        # Un archivo con el nombre de la carpeta no puede convivir con ella en un commit: solo se prueba aquí.
        self.assertEqual(notas_rutas.motivo_rechazo(None, None, None, "A", "100644", "POS/referencia/antigravity"),
                         SKILLS)

    def test_skills_de_antigravity_se_rechazan_en_el_push(self):
        # Las mismas rutas por el camino real: un commit con todas, y el script lista cada rechazada con su motivo.
        rechazadas = {ruta: motivo for ruta, motivo in RUTAS_ANTIGRAVITY.items() if motivo}
        self.commit_rutas(RUTAS_ANTIGRAVITY)
        salida = self.assertRechazado(*rechazadas)
        for ruta, motivo in rechazadas.items():
            self.assertIn(f"- {ruta}: {motivo}\n", salida.stdout)
        self.assertIn(f"Rutas rechazadas ({len(rechazadas)})", salida.stdout)
        for ruta, motivo in RUTAS_ANTIGRAVITY.items():
            if motivo is None:
                self.assertNotIn(f"- {ruta}:", salida.stdout)

    def test_bitacoras_siguen_permitidas_junto_a_las_skills(self):
        permitidas = [ruta for ruta, motivo in RUTAS_ANTIGRAVITY.items() if motivo is None]
        self.commit_rutas(permitidas)
        self.assertIn(f"OK: {len(permitidas)} ruta(s)", self.assertPermitido().stdout)

    def test_mover_o_borrar_una_skill_tambien_se_rechaza(self):
        self.git(self.notas, "mv", "POS/referencia/bitacora.md", "POS/referencia/antigravity/bitacora.md")
        (self.notas / "POS" / "referencia" / "antigravity" / "encargos.md").unlink()
        self.commit("mover y borrar")
        salida = self.assertRechazado()
        self.assertIn(f"- POS/referencia/antigravity/bitacora.md: {SKILLS}\n", salida.stdout)
        self.assertIn("- POS/referencia/antigravity/encargos.md: borrado\n", salida.stdout)
        self.assertIn("- POS/referencia/bitacora.md: borrado\n", salida.stdout)

    def test_docs_notas_lo_pide_antes_de_cada_push(self):
        texto = (ROOT / "docs" / "notas.md").read_text(encoding="utf-8")
        self.assertIn("scripts/notas-rutas.py", texto)
        self.assertIn("antes de cada push directo", texto)

    def test_docs_notas_skills_de_antigravity_y_guia_del_propietario(self):
        texto = (ROOT / "docs" / "notas.md").read_text(encoding="utf-8")
        directa = texto.split("## Escritura directa limitada (POS · Ideas)", 1)[1].split("\n## ", 1)[0]
        self.assertIn("- `<PRY>/referencia/` (las bitácoras), salvo `<PRY>/referencia/antigravity/`;", directa)
        self.assertIn("- Tocar `<PRY>/referencia/antigravity/`:", directa)
        # El motivo que cita el documento es el que imprime el script.
        self.assertEqual(notas_rutas.MOTIVO_SKILLS, SKILLS)
        self.assertIn(f"«{SKILLS}»", " ".join(directa.split()))
        skills = texto.split("\n## Skills de Antigravity\n", 1)[1].split("\n## ", 1)[0]
        self.assertIn("solo cambian por un PR del propietario (ORD-POS-179)", " ".join(skills.split()))
        guia = skills.split("### Mover la plantilla y archivar la cola (propietario)", 1)[1]
        for frase in ("con un PR tuyo en NOTAS", "Fusiónalo tú", "gh pr create",
                      "git mv _plantillas/Entrega-Antigravity.md POS/referencia/antigravity/",
                      "git mv POS/encargos POS/archivo/encargos"):
            self.assertIn(frase, guia)


if __name__ == "__main__":
    unittest.main()
