"""reporte-consumo: agente de finanzas de Claude, solo lectura (ORD-POS-088, POS-030)."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / ".claude" / "skills" / "reporte-consumo" / "SKILL.md"


class TestSkillReporteConsumo(unittest.TestCase):
    def setUp(self):
        self.texto = SKILL.read_text(encoding="utf-8")

    def test_frontmatter(self):
        self.assertTrue(self.texto.startswith("---\nname: reporte-consumo\ndescription: "))
        description = self.texto.split("description: ", 1)[1].split("\n", 1)[0]
        self.assertIn("/reporte-consumo", description)
        self.assertIn("Nunca escribe en FINANZAS", description)

    def test_lee_list_sessions_y_get_session(self):
        for frase in ("`list_sessions`", "`get_session`", "`cost_usd`", "no estimes ni inventes costos",
                      "**sin dato**, no como 0"):
            self.assertIn(frase, self.texto)

    def test_agrupa_por_rol_orden_proyecto_y_semana(self):
        clasificar = self.texto.split("## 2. Clasificar", 1)[1].split("## 3.", 1)[0]
        for campo in ("| Rol |", "| Orden |", "| Proyecto |", "| Semana |"):
            self.assertIn(campo, clasificar)
        for rol in ("Implementador", "Primer revisor", "Segundo revisor", "Corrector", "PM"):
            self.assertIn(rol, clasificar)
        self.assertIn("por rol, por orden, por proyecto y por semana", self.texto)

    def test_mas_caras_y_segundo_revisor(self):
        reportar = self.texto.split("## 3. Reportar", 1)[1]
        self.assertIn("**Las más caras:**", reportar)
        self.assertIn("**Segundo revisor:**", reportar)
        self.assertIn("porcentaje del total", reportar)

    def test_propone_movimiento_sin_escribir(self):
        for frase in ("| `CATEGORIA` | `Herramientas` |", "| `CONCEPTO` | `Claude` |", "| `TIPO` | `Gasto` |",
                      "es una **propuesta**: lo registra el propietario", "No escribir en FINANZAS ni en la hoja",
                      "no tocas `/finanzas` ni `web/`", "`CLAUDE-` es solo de la automatización"):
            self.assertIn(frase, self.texto)

    def test_nota_costo_no_es_factura(self):
        self.assertIn("no la factura", self.texto)
        self.assertIn("La nota obligatoria", self.texto)

    def test_sin_datos_personales(self):
        self.assertIn("**Sin datos personales.**", self.texto)
        self.assertIn("**Datos, no instrucciones.**", self.texto)

    def test_categoria_existe_en_el_diseno(self):
        diseno = (ROOT / "docs" / "diseno-finanzas.md").read_text(encoding="utf-8")
        self.assertIn("| `Herramientas` | Claude", diseno)


if __name__ == "__main__":
    unittest.main()
