"""planear-tiempo: rol Tiempos, solo lectura y condicional a DEC-POS-024 (ORD-POS-107)."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / ".claude" / "skills"
SKILL = SKILLS / "planear-tiempo" / "SKILL.md"


class TestSkillPlanearTiempo(unittest.TestCase):
    def setUp(self):
        self.texto = SKILL.read_text(encoding="utf-8")

    def test_frontmatter(self):
        self.assertTrue(self.texto.startswith("---\nname: planear-tiempo\ndescription: "))

    def test_tres_modos(self):
        lunes = self.texto.split("## Modo LUNES", 1)[1].split("## Modo DIARIO", 1)[0]
        for frase in ("**Pregunta las horas**", "`HORAS_ESTIMADAS`", "`FECHA_PLAN`", "`HITO_ID`",
                      "**Cierres probables**", "`CERRADA`", "fusionado", "**Vencidas por reprogramar:**",
                      "sin hito vigente", "`DEPENDENCIAS`", "**Arma el paquete**"):
            self.assertIn(frase, lunes)
        diario = self.texto.split("## Modo DIARIO", 1)[1].split("## Modo VIERNES", 1)[0]
        self.assertIn("`/planificacion`", diario)
        self.assertIn("**máximo 5 puntos**", diario)
        self.assertIn("minutos", diario)
        self.assertIn("Sin escribir", diario)
        viernes = self.texto.split("## Modo VIERNES", 1)[1].split("## Límites", 1)[0]
        self.assertIn("`TIEMPOS`", viernes)
        self.assertIn("**Pasa a la semana siguiente:**", viernes)

    def test_formato_del_propietario(self):
        formato = self.texto.split("## Formato del propietario", 1)[1].split("## Modo LUNES", 1)[0]
        for frase in ("**Acción primero:**", "**Pasos numerados**", "**minutos**", "**Listas de 5 o menos**",
                      "`Siguiente: <la próxima acción concreta>`"):
            self.assertIn(frase, formato)

    def test_no_escribe_ni_cierra_ni_programa(self):
        for frase in ("Nunca escribas en Sheets", "No escribir en la hoja ni en GitHub",
                      "Nunca cerrar, cancelar ni cambiar `ESTADO` o `BLOQUEO`", "No programar rutinas",
                      "no programes rutinas", "No fusionar ni desplegar"):
            self.assertIn(frase, self.texto)

    def test_reutiliza_revisar_desviaciones(self):
        self.assertIn("../revisar-desviaciones/SKILL.md", self.texto)
        self.assertNotIn("órdenes atoradas más de 3 días", self.texto.lower())

    def test_pm_escribir_api_condiciona_las_ediciones_a_dec_pos_024(self):
        pm = (SKILLS / "pm-escribir-api" / "SKILL.md").read_text(encoding="utf-8")
        paq = pm.split("## Altas con sí PAQ (DEC-POS-013)", 1)[1]
        self.assertIn("**Ediciones del rol Tiempos (condicional a DEC-POS-024).**", paq)
        self.assertIn("solo de `horasEstimadas`, `fechaPlan` e `hitoId`", paq)

    def test_rol_en_agents_y_operacion(self):
        for ruta in ("AGENTS.md", "docs/operacion.md"):
            texto = (ROOT / ruta).read_text(encoding="utf-8")
            self.assertIn("condicionado a la aprobación de dec-pos-024", texto.replace("**", "").lower(), ruta)
            self.assertIn("planear-tiempo", texto, ruta)


if __name__ == "__main__":
    unittest.main()
