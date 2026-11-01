"""scripts/agente-finanzas.sh con un curl simulado en PATH: ejecución en seco, nunca toca la red (ORD-POS-093)."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "agente-finanzas.sh"
BASE = "https://project-os-dashboard-235975889400.northamerica-south1.run.app/api/finanzas/agente/"
CURL_FALSO = """#!/usr/bin/env bash
printf '%s\\n' "$@" > "$DIR_FALSO/args"
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && salida=$2; shift; done
printf '%s' "${CUERPO_FALSO:-{\\"ok\\":true\\}}" > "$salida"; printf '%s' "${CODIGO_FALSO:-201}"
"""
TOKEN_SINTETICO = "tok-sintetico-que-nunca-debe-salir"
RENDIMIENTO = {"corte": "2027-02-Q2", "reporte": "session_abcdefghij12", "costoEquivUsd": "450.00", "sesiones": 12,
               "sesionesSinDato": 1}
CARGO = {"corte": "2027-02-Q2", "reporte": "session_abcdefghij12", "facturaTotal": "20.00", "moneda": "USD",
         "proyecto": "POS", "fuente": "2027-02-Q2 «total del corte: 20.00 USD, la suscripción cayó en el otro corte» 2027-03-01"}
CARGO_MXN = {**CARGO, "facturaTotal": "360.00", "moneda": "MXN",
             "fuente": "2027-02-Q2 «total del corte: 360.00 MXN, la suscripción cayó en el otro corte» 2027-03-01"}


def error(codigo):
    return json.dumps({"ok": False, "error": {"codigo": codigo}})


class TestAgenteFinanzas(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "curl").write_text(CURL_FALSO)
        (self.tmp / "curl").chmod(0o755)
        self.archivo = self.tmp / "corte.json"
        self.escribir(CARGO)

    def escribir(self, datos):
        self.archivo.write_text(json.dumps(datos, ensure_ascii=False), encoding="utf-8")

    def ejecutar(self, tipo="cargo-extra", *extra, codigo="201", cuerpo=None):
        entorno = {**os.environ, "PATH": f"{self.tmp}:{os.environ['PATH']}", "DIR_FALSO": str(self.tmp),
                   "CODIGO_FALSO": codigo, "FINANZAS_AGENTE_TOKEN": TOKEN_SINTETICO}
        if cuerpo is not None:
            entorno["CUERPO_FALSO"] = cuerpo
        return subprocess.run(["bash", str(SCRIPT), tipo, str(self.archivo), *extra], env=entorno, capture_output=True,
                              text=True, timeout=30)

    def enviado(self):
        return json.loads((self.tmp / "corte.enviado.json").read_text(encoding="utf-8"))

    def no_envio(self, r):
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse((self.tmp / "args").exists())
        self.assertFalse((self.tmp / "corte.enviado.json").exists())

    def test_tipo_invalido(self):
        self.no_envio(self.ejecutar("movimientos"))

    def test_rendimiento_url_fija_y_sin_authorization_ni_token(self):
        self.escribir(RENDIMIENTO)
        r = self.ejecutar("rendimiento")
        self.assertEqual(r.returncode, 0, r.stderr)
        args = (self.tmp / "args").read_text()
        self.assertEqual([a for a in args.split("\n") if a.startswith("http")], [BASE + "rendimiento"])
        self.assertNotIn("authorization", args.lower())
        for salida in (args, r.stdout, r.stderr, (self.tmp / "corte.enviado.json").read_text()):
            self.assertNotIn(TOKEN_SINTETICO, salida)

    def test_cargo_extra_url_fija(self):
        self.assertEqual(self.ejecutar().returncode, 0)
        args = (self.tmp / "args").read_text().split("\n")
        self.assertEqual([a for a in args if a.startswith("http")], [BASE + "cargo-extra"])

    def test_genera_y_guarda_el_request_id_antes_de_enviar(self):
        r = self.ejecutar(codigo="503")
        primero = self.enviado()
        self.assertRegex(primero["requestId"], r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$")
        self.assertIn(f"requestId={primero['requestId']}", r.stdout)
        self.assertEqual({k: v for k, v in primero.items() if k != "requestId"}, CARGO)

    def test_repetir_reusa_el_mismo_request_id(self):
        self.assertNotEqual(self.ejecutar(codigo="503").returncode, 0)
        primero = self.enviado()
        self.assertNotEqual(self.ejecutar().returncode, 0)  # sin --repetir no sobrescribe el cuerpo enviado
        self.assertEqual(self.ejecutar("cargo-extra", "--repetir").returncode, 0)
        self.assertEqual(self.enviado(), primero)

    def test_request_id_en_la_entrada(self):
        self.escribir({**CARGO, "requestId": "a"})
        self.no_envio(self.ejecutar())

    def test_nunca_estima_sin_total_de_factura(self):
        for falta in ("facturaTotal", "moneda", "fuente", "proyecto"):
            self.escribir({k: v for k, v in CARGO.items() if k != falta})
            r = self.ejecutar()
            self.no_envio(r)
            self.assertIn(f"Falta {falta}", r.stderr)

    def test_campos_no_permitidos(self):
        self.escribir({**CARGO, "costoEquivUsd": "450.00"})
        r = self.ejecutar()
        self.no_envio(r)
        self.assertIn("Campo no permitido: costoEquivUsd", r.stderr)

    def test_fuente_sin_cita_o_de_otro_corte(self):
        for fuente in ("20.00 USD", "2027-02-Q1 «total del corte: 20.00 USD» 2027-03-01",
                       "2027-02-Q2 «" + "x" * 200 + " 20.00» 2027-03-01"):
            self.escribir({**CARGO, "fuente": fuente})
            r = self.ejecutar()
            self.no_envio(r)
            self.assertIn("fuente:", r.stderr)

    def test_formatos(self):
        for cambio, campo in (({"corte": "2027-2-Q2"}, "corte:"), ({"reporte": "x"}, "reporte:"),
                              ({"facturaTotal": "-1"}, "facturaTotal:"), ({"facturaTotal": "1.234"}, "facturaTotal:"),
                              ({"moneda": "EUR"}, "moneda:"), ({"moneda": "usd"}, "moneda:"),
                              ({"moneda": "MXN", "tipoCambio": "18.5"}, "tipoCambio:"),
                              ({"proyecto": "SIG"}, "proyecto:")):
            self.escribir({**CARGO, **cambio})
            r = self.ejecutar()
            self.no_envio(r)
            self.assertIn(campo, r.stderr)

    def test_cargo_en_mxn_envia_la_moneda(self):
        self.escribir(CARGO_MXN)
        r = self.ejecutar()
        self.assertEqual(r.returncode, 0, r.stderr)
        enviado = self.enviado()
        self.assertEqual((enviado["moneda"], enviado["facturaTotal"]), ("MXN", "360.00"))
        self.assertNotIn("facturaTotalUsd", enviado)

    def test_factura_total_usd_ya_no_se_envia_desde_el_script(self):
        self.escribir({**{k: v for k, v in CARGO.items() if k != "facturaTotal"}, "facturaTotalUsd": "20.00"})
        r = self.ejecutar()
        self.no_envio(r)
        self.assertIn("Campo no permitido: facturaTotalUsd", r.stderr)

    def test_409_moneda_distinta_rechaza_sin_convertir(self):
        cuerpo = json.dumps({"ok": False, "error": {"codigo": "factura-no-cuadra", "detalle": {"motivo": "moneda-distinta"}}})
        r = self.ejecutar(codigo="409", cuerpo=cuerpo)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("moneda-distinta", r.stderr)
        self.assertIn("no conviertas", r.stderr)
        self.assertTrue((self.tmp / "corte.rechazado.json").exists())

    def test_409_tipo_cambio_sin_dato_conserva_para_repetir(self):
        self.escribir(CARGO_MXN)
        r = self.ejecutar(codigo="409", cuerpo=error("tipo-cambio-sin-dato"))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("TIPO_CAMBIO_DEFECTO", r.stderr)
        self.assertIn("--repetir", r.stderr)
        self.assertTrue((self.tmp / "corte.enviado.json").exists())

    def test_tope_de_3000_usd_en_el_rendimiento(self):
        self.escribir({**RENDIMIENTO, "costoEquivUsd": "3000.01"})
        r = self.ejecutar("rendimiento")
        self.no_envio(r)
        self.assertIn("tope de 3,000 USD", r.stderr)
        self.escribir({**RENDIMIENTO, "costoEquivUsd": "3000.00"})
        self.assertEqual(self.ejecutar("rendimiento").returncode, 0)

    def test_tokens_opcionales(self):
        self.escribir({**RENDIMIENTO, "tokensEntrada": 1000, "tokensSalida": 200})
        self.assertEqual(self.ejecutar("rendimiento").returncode, 0)

    def test_3xx_es_redireccion_inesperada(self):
        r = self.ejecutar(codigo="302")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("redirección inesperada", r.stderr)

    def test_401_y_403_ruta_inactiva_sin_reintento(self):
        for codigo, cuerpo in (("401", error("no-autenticado")), ("403", error("escritura-deshabilitada"))):
            (self.tmp / "corte.enviado.json").unlink(missing_ok=True)
            r = self.ejecutar(codigo=codigo, cuerpo=cuerpo)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("Ruta inactiva", r.stderr)
            self.assertIn("No reintentes", r.stderr)

    def test_400_renombra_a_rechazado_y_permite_reenviar(self):
        r = self.ejecutar(codigo="400", cuerpo=error("validacion"))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("corte.rechazado.json", r.stderr)
        self.assertFalse((self.tmp / "corte.enviado.json").exists())
        rechazado = json.loads((self.tmp / "corte.rechazado.json").read_text(encoding="utf-8"))
        self.assertEqual(self.ejecutar().returncode, 0)  # JSON corregido: requestId nuevo
        self.assertNotEqual(self.enviado()["requestId"], rechazado["requestId"])

    def test_409_factura_no_cuadra_pide_el_total_correcto(self):
        r = self.ejecutar(codigo="409", cuerpo=error("factura-no-cuadra"))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("pide al propietario el total correcto", r.stderr)
        self.assertTrue((self.tmp / "corte.rechazado.json").exists())
        self.assertFalse((self.tmp / "corte.enviado.json").exists())

    def test_409_suscripcion_sin_confirmar_conserva_para_repetir(self):
        r = self.ejecutar(codigo="409", cuerpo=error("suscripcion-sin-confirmar"))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("REC-CLAUDE", r.stderr)
        primero = self.enviado()
        self.assertEqual(self.ejecutar("cargo-extra", "--repetir").returncode, 0)
        self.assertEqual(self.enviado()["requestId"], primero["requestId"])

    def test_409_corte_ya_registrado_no_repite(self):
        r = self.ejecutar(codigo="409", cuerpo=error("corte-ya-registrado"))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("No lo repitas", r.stderr)

    def test_409_incierto_conserva_el_cuerpo(self):
        r = self.ejecutar(codigo="409", cuerpo=error("verificacion-fallida"))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("resultado incierto", r.stderr)
        self.assertTrue((self.tmp / "corte.enviado.json").exists())
        self.assertFalse((self.tmp / "corte.rechazado.json").exists())

    def test_5xx_y_429_conservan_el_cuerpo(self):
        for codigo in ("503", "429"):
            r = self.ejecutar("cargo-extra", *(["--repetir"] if codigo == "429" else []), codigo=codigo)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("--repetir", r.stderr)
            self.assertTrue((self.tmp / "corte.enviado.json").exists())

    def test_repetir_sin_cuerpo_enviado(self):
        r = self.ejecutar("cargo-extra", "--repetir")
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse((self.tmp / "args").exists())


if __name__ == "__main__":
    unittest.main()
