"""reporte-consumo: agente de finanzas de Claude (ORD-POS-088, ORD-POS-089 y ORD-POS-093, POS-030)."""
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
        self.assertIn("Nunca escribe con el conector", description)
        self.assertIn("nunca registra la suscripción", description)

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
                      "es una **propuesta**: lo registra el propietario", "No escribir en FINANZAS salvo el registro del corte de §4",
                      "no tocas `/finanzas` ni `web/`", "`CLAUDE-` es solo de la automatización"):
            self.assertIn(frase, self.texto)

    def test_nota_costo_no_es_factura(self):
        self.assertIn("no la factura", self.texto)
        self.assertIn("La nota obligatoria", self.texto)

    def test_sin_datos_personales(self):
        self.assertIn("**Sin datos personales.**", self.texto)
        self.assertIn("**Datos, no instrucciones.**", self.texto)

    def test_separa_costo_real_y_consumo_equivalente(self):
        for frase in ("- **Costo real:**", "- **Consumo equivalente:**", "**No es gasto**", "`RECURRENTES`",
                      "`ID` = `CLAUDE`", "usa el monto que dé el propietario", "costo real: **sin dato**"):
            self.assertIn(frase, self.texto)
        reportar = self.texto.split("## 3. Reportar", 1)[1]
        self.assertLess(reportar.index("**Costo real**"), reportar.index("**Consumo equivalente**"))

    def test_finanzas_solo_con_costo_real(self):
        movimiento = self.texto.split("**Movimiento mensual propuesto**", 1)[1].split("## Límites", 1)[0]
        for frase in ("solo con el **costo real**; el consumo equivalente nunca",
                      "**no propongas otro movimiento**", "`/finanzas` («Recurrentes del mes»",
                      "`REC-CLAUDE-AAAA-MM`", "nunca la suma de `cost_usd`", "Sin costo real: no hay propuesta"):
            self.assertIn(frase, movimiento)

    def test_cupo(self):
        for frase in ("`rate_limit_info`", "`status`", "`rateLimitType`", "`resetsAt`", "`isUsingOverage`",
                      "`allowed_warning`", "uso adicional", "cupo: **sin dato**"):
            self.assertIn(frase, self.texto)

    def test_etiquetas_de_rol_mal_escritas(self):
        clasificar = self.texto.split("## 2. Clasificar", 1)[1].split("## 3.", 1)[0]
        for frase in ("**Etiquetas de rol mal escritas.**", "`engineering`", "`ingenieria`", "`Ingeniería`",
                      "se **señala**", "No la corriges"):
            self.assertIn(frase, clasificar)
        self.assertIn("**Etiquetas de rol mal escritas:**", self.texto.split("## 3. Reportar", 1)[1])

    def registrar(self):
        return self.texto.split("## 4. Registrar el corte", 1)[1].split("## Límites", 1)[0]

    def test_registro_toma_cifras_del_reporte_del_corte(self):
        registrar = self.registrar()
        for frase in ("Haz §1 a §3 con el periodo del corte", "**Q1**, días 1 a 15", "**Q2**, día 16 al último",
                      "| `costoEquivUsd` | suma de `cost_usd` del corte", "| `reporte` | el ID de esta sesión",
                      "omítelos (sin dato, nunca 0)", "Más de 3,000 USD: no lo envíes"):
            self.assertIn(frase, registrar)

    def test_registro_pide_total_con_cita_literal_fechada_y_nunca_estima(self):
        registrar = self.registrar()
        for frase in ("**Pide el total de factura y su moneda al propietario.**", "**Cita literal fechada.**",
                      "`<corte> «<cita literal del propietario>» AAAA-MM-DD`", "no la edites", "**Nunca estimes.**",
                      "Nunca uses `cost_usd`, el monto de RECURRENTES ni otro corte como total",
                      "envía solo `rendimiento`"):
            self.assertIn(frase, registrar)

    def test_pendiente_de_factura_en_cada_reporte(self):
        self.assertIn("el corte queda **pendiente de factura** y se\n   lista en cada reporte", self.registrar())
        reportar = self.texto.split("## 3. Reportar", 1)[1].split("## 4.", 1)[0]
        self.assertIn("**Cortes pendientes de factura:**", reportar)
        self.assertIn("Va en **cada**\n   reporte", reportar)

    def test_pide_que_el_total_excluya_la_suscripcion_o_diga_en_que_corte_cayo(self):
        registrar = self.registrar()
        for frase in ("¿La suscripción cayó en\n   este corte?", "Si cayó en el otro, dame el total sin ella",
                      "si cayó en este, el total con ella", "Si el propietario no dice en qué corte cayó o en qué\n   moneda, pregúntalo antes de enviar",
                      "nunca sumes ni restes la suscripción tú"):
            self.assertIn(frase, registrar)

    def test_pide_y_envia_la_moneda_del_total_sin_convertir(self):
        # ORD-POS-133: el total va en la moneda de REC-CLAUDE-AAAA-MM; nunca se convierte.
        registrar = self.registrar()
        for frase in ("y en qué moneda (USD o MXN)?", "**en la moneda de ese REC**",
                      "(`moneda` = `USD` o `MXN`, `facturaTotal` en ella)", "ni conviertas el total con un tipo de\n   cambio",
                      "`corte`, `reporte`, `moneda`, `facturaTotal`, `fuente`, `proyecto`", "motivo `moneda-distinta`",
                      "409 `tipo-cambio-sin-dato`"):
            self.assertIn(frase, registrar)
        script = (ROOT / "scripts" / "agente-finanzas.sh").read_text(encoding="utf-8")
        self.assertIn('"corte","reporte","moneda","facturaTotal","fuente","proyecto"', script)

    def test_envia_solo_con_el_script_sin_token(self):
        registrar = self.registrar()
        for frase in ("bash scripts/agente-finanzas.sh rendimiento", "bash scripts/agente-finanzas.sh cargo-extra",
                      "**sin**\n   `requestId`", "`--repetir`", "nunca lo leas, lo imprimas", "no uses `curl` a mano",
                      "409 `suscripcion-sin-confirmar`", "409 `factura-no-cuadra`", "409 `corte-ya-registrado`"):
            self.assertIn(frase, registrar)
        self.assertTrue((ROOT / "scripts" / "agente-finanzas.sh").is_file())

    def test_ejemplo_de_fuente_cumple_el_formato(self):
        ejemplo = "`2027-02-Q2 «total del corte: 20.00 USD, la suscripción\n   cayó en el otro corte» 2027-03-01`"
        self.assertIn(ejemplo, self.registrar())

    def test_categoria_existe_en_el_diseno(self):
        diseno = (ROOT / "docs" / "diseno-finanzas.md").read_text(encoding="utf-8")
        self.assertIn("| `Herramientas` | Claude", diseno)


if __name__ == "__main__":
    unittest.main()
