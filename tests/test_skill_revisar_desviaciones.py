"""revisar-desviaciones: subagente de tiempos del PM, solo lectura (ORD-POS-087)."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / ".claude" / "skills"
SKILL = SKILLS / "revisar-desviaciones" / "SKILL.md"


class TestSkillRevisarDesviaciones(unittest.TestCase):
    def setUp(self):
        self.texto = SKILL.read_text(encoding="utf-8")

    def test_frontmatter(self):
        self.assertTrue(self.texto.startswith("---\nname: revisar-desviaciones\ndescription: "))

    def test_lee_hitos_ordenes_tareas_y_github_solo_lectura(self):
        leer = self.texto.split("## 1. Leer", 1)[1].split("## 2.", 1)[0]
        for pestana in ("`HITOS`", "`TAREAS`", "`ORDENES_CODEX`"):
            self.assertIn(pestana, leer)
        self.assertIn("**solo lectura**", leer)
        self.assertIn("**GitHub**", leer)

    def test_criterios_de_tiempo(self):
        calcular = self.texto.split("## 2. Calcular", 1)[1].split("## 3.", 1)[0]
        self.assertIn("`FECHA_OBJETIVO` es ≤ hoy + 7", calcular)
        self.assertIn("**vencido** si es < hoy", calcular)
        self.assertIn("Avance = tareas `COMPLETADO`", calcular)
        self.assertIn("(más de 3 días", calcular)
        for estado in ("`ENVIADA`", "`PR_ABIERTO`", "**CAMBIOS**"):
            self.assertIn(estado, calcular)
        self.assertIn("**PRs sin revisión.**", calcular)
        self.assertIn("**Fusionado sin desplegar.**", calcular)
        self.assertIn("última revisión registrada", calcular)

    def test_no_escribe_en_ningun_lado(self):
        self.assertIn("No escribir en la hoja ni en GitHub", self.texto)
        self.assertIn("no cambiar estados", self.texto)
        self.assertIn("No fusionar ni desplegar", self.texto)
        self.assertIn("no crees rutinas con `schedule`", self.texto)

    def test_planear_proyecto_la_llama_en_la_revision_semanal(self):
        planear = (SKILLS / "planear-proyecto" / "SKILL.md").read_text(encoding="utf-8")
        linea = next(l for l in planear.splitlines() if "**Desviaciones (revisión semanal).**" in l)
        self.assertIn("revisión semanal", linea)
        self.assertIn("revisar-desviaciones/SKILL.md", planear)

    def test_no_se_copia_a_sigsah_ni_radaros(self):
        for repo in ("sigsah", "radaros"):
            copia = ROOT / "docs" / "delegacion-codex" / repo / ".claude" / "skills" / "revisar-desviaciones"
            self.assertFalse(copia.exists(), repo)


if __name__ == "__main__":
    unittest.main()
