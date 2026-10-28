"""planear-tiempo: rol Tiempos, solo lectura, con DEC-POS-024 aprobada (ORD-POS-107 y ORD-POS-111)."""
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
        viernes = self.texto.split("## Modo VIERNES", 1)[1].split("## Paquete para POS · Ideas", 1)[0]
        self.assertIn("`TIEMPOS`", viernes)
        self.assertIn("**Pasa a la semana siguiente:**", viernes)

    def test_formato_del_propietario(self):
        formato = self.texto.split("## Formato del propietario", 1)[1].split("## Modo LUNES", 1)[0]
        for frase in ("**máximo 5 secciones**", "**Acción primero:**", "**Pasos numerados**", "**minutos**",
                      "**Listas de 5 o menos**", "`Siguiente: <la próxima acción concreta>`"):
            self.assertIn(frase, formato)
        secciones = [l for l in formato.splitlines() if l[:3] in {f"{n}. " for n in range(1, 10)}]
        self.assertLessEqual(len(secciones), 5)

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
            self.assertIn("dec-pos-024 aprobada", texto.replace("**", "").lower(), ruta)
            self.assertNotIn("dec-pos-024 (pendiente)", texto.lower(), ruta)
            self.assertIn("planear-tiempo", texto, ruta)

    def test_dec_pos_024_aprobada_en_la_skill(self):
        self.assertIn("**DEC-POS-024 APROBADA**", self.texto)
        self.assertNotIn("PENDIENTE): mientras", self.texto)

    def test_paquete_sin_id_y_si_solo_en_ideas(self):
        paq = self.texto.split("## Paquete para POS · Ideas", 1)[1].split("## Límites", 1)[0]
        for frase in ("**Va sin ID.**", "`rol:ideas`", "**No pidas**", "solo vale dado en POS · Ideas"):
            self.assertIn(frase, paq)
        ideas = (SKILLS / "revisar-ideas" / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("Un paquete del rol Tiempos", ideas)

    def test_lunes_sin_trabajo_abierto(self):
        lunes = " ".join(self.texto.split("## Modo LUNES", 1)[1].split("## Modo MEDIA SEMANA", 1)[0].split())
        for frase in ("**Sin trabajo abierto:**", "ninguna tarea abierta", "hitos aún `PENDIENTE`",
                      "**altas de tareas**", "nunca ediciones de `ESTADO`"):
            self.assertIn(frase, lunes)

    def test_media_semana(self):
        media = self.texto.split("## Modo MEDIA SEMANA", 1)[1].split("## Modo DIARIO", 1)[0]
        for frase in ("Como LUNES", "semana ISO", "capacidad proporcional", "× días que quedan ÷ 7"):
            self.assertIn(frase, media)

    def test_diario_minutos_reales_condicionados_a_dec_pos_025(self):
        diario = self.texto.split("## Modo DIARIO", 1)[1].split("## Modo VIERNES", 1)[0]
        for frase in ("**Pregunta los minutos reales de ayer**", "DEC-POS-025 consta `APROBADA`",
                      "filas de `TIEMPOS`", "solo anótalos en la respuesta"):
            self.assertIn(frase, diario)

    def test_carga_de_la_skill_documentada(self):
        self.assertIn("## Si no encuentras esta skill", self.texto)
        self.assertIn("git show origin/main:.claude/skills/planear-tiempo/SKILL.md", self.texto)

    def test_pm_escribir_api_rastro_del_paq_en_ediciones(self):
        pm = (SKILLS / "pm-escribir-api" / "SKILL.md").read_text(encoding="utf-8")
        paq = " ".join(pm.split("## Altas con sí PAQ (DEC-POS-013)", 1)[1].split())
        self.assertIn("tus avisos anteriores a POS · Ideas", paq)
        self.assertIn("ese mensaje es el rastro del ID del paquete", paq)


if __name__ == "__main__":
    unittest.main()
