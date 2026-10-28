"""planear-tiempo: rol Tiempos, propone y no escribe (ORD-POS-107, condicional a DEC-POS-024)."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / ".claude" / "skills"
SKILL = SKILLS / "planear-tiempo" / "SKILL.md"


def seccion(texto, inicio, fin="\n## "):
    return texto.split(inicio, 1)[1].split(fin, 1)[0]


class TestSkillPlanearTiempo(unittest.TestCase):
    def setUp(self):
        self.texto = SKILL.read_text(encoding="utf-8")

    def test_frontmatter_y_decision(self):
        self.assertTrue(self.texto.startswith("---\nname: planear-tiempo\ndescription: "))
        self.assertIn("**Condicional a DEC-POS-024**", self.texto)

    def test_modo_lunes(self):
        lunes = seccion(self.texto, "## Modo LUNES")
        for frase in ("**Pregunta las horas**", "`HORAS_ESTIMADAS`", "`FECHA_PLAN`", "`HITO_ID`",
                      "**Cierres probables.**", "`CERRADA`", "PR `[ORD-` está fusionado", "sin hito vigente",
                      "filas viejas de\n   `DEPENDENCIAS`", "**Arma el paquete**"):
            self.assertIn(frase, lunes)

    def test_paquete_solo_tres_campos(self):
        paquete = seccion(self.texto, "### Paquete de Tiempos")
        self.assertIn("`PAQ-AAAA-MM-DD-NN`", paquete)
        self.assertIn("**desde `51`**", paquete)
        self.assertIn("solo ediciones `tarea.editar` de `horasEstimadas`, `fechaPlan` e `hitoId`", paquete)
        self.assertIn("pm-escribir-api/SKILL.md", paquete)

    def test_modo_diario_y_viernes(self):
        diario = seccion(self.texto, "## Modo DIARIO")
        self.assertIn("`/planificacion`", diario)
        self.assertIn("**5 puntos o menos**", diario)
        self.assertIn("minutos", diario)
        self.assertIn("No escribe nada", diario)
        viernes = seccion(self.texto, "## Modo VIERNES")
        self.assertIn("`MINUTOS_REALES` de `TIEMPOS`", viernes)
        self.assertIn("**Pasa a la semana siguiente.**", viernes)

    def test_formato_del_propietario(self):
        formato = seccion(self.texto, "## Formato de respuesta")
        for frase in ("Primero la acción", "pasos numerados", "minutos", "5 puntos o menos", "«Siguiente: …»"):
            self.assertIn(frase, formato)

    def test_no_escribe_ni_programa_y_reutiliza_desviaciones(self):
        for frase in ("No escribir en la hoja", "nunca uses el conector para\n  escribir",
                      "No cerrar, cancelar ni cambiar `ESTADO` o `BLOQUEO`", "No crees rutinas, activadores ni `schedule`",
                      "No fusionar ni desplegar", "../revisar-desviaciones/SKILL.md", "no repitas sus cálculos"):
            self.assertIn(frase, self.texto)
        self.assertNotIn("api/operaciones", self.texto)

    def test_pm_escribir_api_condicional(self):
        pm = (SKILLS / "pm-escribir-api" / "SKILL.md").read_text(encoding="utf-8")
        tiempos = pm.split("### Ediciones de tiempo con sí PAQ (condicional a DEC-POS-024)", 1)[1]
        self.assertIn("Solo si DEC-POS-024 consta APROBADA", tiempos)
        self.assertIn("`horasEstimadas`, `fechaPlan` e `hitoId`", tiempos)
        self.assertIn("`rol:tiempos`", tiempos)
        self.assertIn("nunca vale para altas fuera del paquete", tiempos)

    def test_rol_en_agents_y_operacion(self):
        for ruta in ("AGENTS.md", "docs/operacion.md"):
            texto = (ROOT / ruta).read_text(encoding="utf-8")
            self.assertIn("DEC-POS-024", texto, ruta)
            self.assertIn("rol:tiempos", texto, ruta)

    def test_no_se_copia_a_sigsah_ni_radaros(self):
        for repo in ("sigsah", "radaros"):
            self.assertFalse((ROOT / "docs" / "delegacion-codex" / repo / ".claude" / "skills" / "planear-tiempo").exists())


if __name__ == "__main__":
    unittest.main()
