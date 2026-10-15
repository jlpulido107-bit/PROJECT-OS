"""Las skills de la mano derecha son idénticas en las copias para SIGSAH y RADAROS (docs/delegacion-codex/)."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ORIGINAL = ROOT / ".claude" / "skills"
COPIAS = [ROOT / "docs" / "delegacion-codex" / repo / ".claude" / "skills" for repo in ("sigsah", "radaros")]
SKILLS = ("planear-proyecto", "ejecutar-orden")


def archivos(base):
    return {p.relative_to(base).as_posix(): p.read_bytes() for p in sorted(base.rglob("*")) if p.is_file()}


class TestSkillsSync(unittest.TestCase):
    def test_skills_existen_con_frontmatter(self):
        for skill in SKILLS:
            texto = (ORIGINAL / skill / "SKILL.md").read_text(encoding="utf-8")
            self.assertTrue(texto.startswith(f"---\nname: {skill}\ndescription: "), skill)

    def test_copias_identicas(self):
        # Solo las skills propias se sincronizan; las de terceros (THIRD_PARTY.md) viven solo en PROJECT-OS.
        original = {k: v for k, v in archivos(ORIGINAL).items() if k.split("/")[0] in SKILLS}
        self.assertEqual(sorted(original), [f"{s}/SKILL.md" for s in sorted(SKILLS)])
        for copia in COPIAS:
            self.assertEqual(archivos(copia), original, copia)

    def test_skills_de_terceros_documentadas_y_con_reglas(self):
        terceros = sorted(p.name for p in ORIGINAL.iterdir() if p.is_dir() and p.name not in SKILLS)
        registro = (ORIGINAL / "THIRD_PARTY.md").read_text(encoding="utf-8")
        for skill in terceros:
            self.assertIn(f"`{skill}`", registro, skill)
            texto = (ORIGINAL / skill / "SKILL.md").read_text(encoding="utf-8")
            self.assertIn("Reglas de PROJECT-OS", texto, skill)

    def test_skills_no_escriben_en_la_hoja_ni_fusionan(self):
        for skill in SKILLS:
            texto = (ORIGINAL / skill / "SKILL.md").read_text(encoding="utf-8")
            self.assertIn("No escribir en la hoja", texto, skill)
            self.assertIn("desplegar", texto, skill)


if __name__ == "__main__":
    unittest.main()
