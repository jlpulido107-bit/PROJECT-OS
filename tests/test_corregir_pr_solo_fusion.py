"""corregir-pr: ronda de solo fusión para un PR CONFORME en conflicto con su base (ORD-POS-053)."""
import unittest
from pathlib import Path

SKILLS = Path(__file__).resolve().parents[1] / ".claude" / "skills"


class TestCorregirPrSoloFusion(unittest.TestCase):
    def test_corregir_pr(self):
        texto = (SKILLS / "corregir-pr" / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("**C. Solo fusión.** Dictamen marcado del revisor que cumple B.1 a B.4 con `veredicto` `CONFORME`", texto)
        self.assertIn("si **no** está en conflicto con su base", texto)
        seccion = texto.split("## Solo fusión (caso C)", 1)[1].split("## Resultado", 1)[0]
        for frase in ("merge --no-ff origin/<base>", "**conservando ambos comportamientos**", "No atiendes hallazgos",
                      "Cuenta como **ronda** (máximo 2)", "revisión **DELTA**"):
            self.assertIn(frase, seccion)
        # Los casos A y B no cambian.
        self.assertIn("- **A. Comentario del propietario sin marca.**", texto)
        self.assertIn("5. Su `veredicto` es `CAMBIOS`", texto)

    def test_revisar_orden_pide_delta(self):
        texto = (SKILLS / "revisar-orden" / "SKILL.md").read_text(encoding="utf-8")
        modos = texto.split("## Modos", 1)[1].split("## Marca del dictamen", 1)[0]
        self.assertIn("**ronda de solo fusión**", modos)


if __name__ == "__main__":
    unittest.main()
