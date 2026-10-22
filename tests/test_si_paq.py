"""«sí PAQ» en POS · Ideas: autoriza solo altas, tras verificarlo el PM en la fuente (DEC-POS-013, ORD-POS-060)."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / ".claude" / "skills"


def leer(ruta):
    return (ROOT / ruta).read_text(encoding="utf-8")


class TestSiPaq(unittest.TestCase):
    def setUp(self):
        self.pm = leer(".claude/skills/pm-escribir-api/SKILL.md").split("## Altas con sí PAQ (DEC-POS-013)", 1)[1]

    def test_agents_y_operacion_recogen_la_decision(self):
        for texto in (leer("AGENTS.md"), leer("docs/operacion.md")):
            self.assertIn("DEC-POS-013", texto)
            self.assertIn("aprobar, enviar, cancelar y cerrar no cambian", texto)

    def test_verificacion_en_la_fuente(self):
        for frase in ("`rol:ideas`", "exactamente una", "`list_events`", "`get_event`", "mensajes de usuario",
                      "`isSynthetic`", "`inbound_origin` de otra sesión", "`sí PAQ-AAAA-MM-DD-NN`",
                      "ID **exacto** del paquete recibido", "**hoy en America/Merida** (sin margen)", "**no hay alta**"):
            self.assertIn(frase, self.pm)

    def test_cita_id_usado_y_aviso(self):
        for frase in ("texto literal del «sí PAQ»", "el ID de la sesión de\n   Ideas", "`uuid` del evento verificado",
                      "`contexto` de la orden", "`justificacion` de la\n   decisión", "`ORDENES_CODEX`", "`DECISIONES`",
                      "el paquete ya se usó", "**un solo mensaje** a POS · Ideas", "el PR si\n   existe"):
            self.assertIn(frase, self.pm)

    def test_revisar_ideas_numera_y_cierra_cada_paquete(self):
        texto = leer(".claude/skills/revisar-ideas/SKILL.md").split("## Paquetes para el PM", 1)[1]
        self.assertIn("secuencial del día, desde `01`", texto)
        self.assertIn("«Responde sí PAQ-AAAA-MM-DD-NN para autorizar las altas»", texto)

    def test_ningun_texto_deja_que_el_si_paq_apruebe_o_cierre(self):
        # Toda frase que nombre el «sí PAQ» junto a aprobar, enviar, cancelar o cerrar debe negarlo.
        textos = [leer(r) for r in ("AGENTS.md", "docs/operacion.md")]
        textos += [p.read_text(encoding="utf-8") for p in SKILLS.glob("*/SKILL.md")]
        for texto in textos:
            for frase in re.split(r"(?<=[.;:])\s", " ".join(texto.split())):
                if "PAQ" in frase and re.search(r"aprueb|aprobar|env[ií]|cancel|cerr|cierr", frase):
                    self.assertRegex(frase, r"[Nn]unca|no cambian|solo", frase)


if __name__ == "__main__":
    unittest.main()
