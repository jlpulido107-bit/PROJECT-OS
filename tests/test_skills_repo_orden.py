"""revisar-orden y corregir-pr trabajan en el checkout del repositorio de la orden (ORD-POS-043)."""
import unittest
from pathlib import Path

SKILLS = Path(__file__).resolve().parents[1] / ".claude" / "skills"


class TestSkillsRepoOrden(unittest.TestCase):
    def leer(self, skill):
        return (SKILLS / skill / "SKILL.md").read_text(encoding="utf-8")

    def test_ambas_ubican_y_validan_el_checkout(self):
        for skill in ("revisar-orden", "corregir-pr"):
            texto = self.leer(skill)
            self.assertIn("## Checkout de la orden", texto, skill)
            self.assertIn("`REPO_DIR`", texto, skill)
            self.assertIn("AGENTS.md", texto, skill)
            self.assertIn("Para órdenes POS, `REPO_DIR` es el checkout de PROJECT-OS", texto, skill)

    def test_revisar_orden_valida_el_remote_y_termina_si_falta(self):
        texto = self.leer("revisar-orden")
        self.assertIn("remote get-url origin` termine en `/<REPOSITORIO>`", texto)
        self.assertIn("termina sin dictaminar ni comentar", texto)

    def test_corregir_pr_empuja_solo_a_la_rama_del_pr(self):
        texto = self.leer("corregir-pr")
        self.assertIn("git -C REPO_DIR push origin <rama>", texto)
        self.assertIn("nunca a otro\n   remote, otra rama ni otro repositorio", texto)


if __name__ == "__main__":
    unittest.main()
