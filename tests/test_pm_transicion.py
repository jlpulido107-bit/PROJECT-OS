"""scripts/pm-transicion.sh con un curl simulado en PATH: nunca toca la red."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "pm-transicion.sh"
URL = "https://project-os-dashboard-235975889400.northamerica-south1.run.app/api/operaciones/ordenes/ORD-POS-099"
CURL_FALSO = """#!/usr/bin/env bash
printf '%s\\n' "$@" > "$DIR_FALSO/args"
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && salida=$2; shift; done
echo '{"estado":"ENVIADA"}' > "$salida"; printf '%s' "${CODIGO_FALSO:-200}"
"""
APROBAR = {"accion": "APROBAR", "expectedEstado": "BORRADOR", "autorizacion": "ORD-POS-099 «sí, apruébala» 2026-10-22"}
REVISAR = {"accion": "REVISAR", "expectedEstado": "PR_ABIERTO"}


class TestPmTransicion(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "curl").write_text(CURL_FALSO)
        (self.tmp / "curl").chmod(0o755)
        self.archivo = self.tmp / "orden.json"
        self.escribir(APROBAR)

    def escribir(self, datos):
        self.archivo.write_text(json.dumps(datos, ensure_ascii=False))

    def ejecutar(self, orden="ORD-POS-099", *extra, codigo="200"):
        entorno = {**os.environ, "PATH": f"{self.tmp}:{os.environ['PATH']}", "DIR_FALSO": str(self.tmp), "CODIGO_FALSO": codigo}
        return subprocess.run(["bash", str(SCRIPT), orden, str(self.archivo), *extra], env=entorno, capture_output=True, text=True, timeout=30)

    def enviado(self):
        return json.loads((self.tmp / "orden.enviado.json").read_text())

    def rechaza(self, mensaje, orden="ORD-POS-099"):
        r = self.ejecutar(orden)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(mensaje, r.stderr)
        self.assertFalse((self.tmp / "args").exists())
        self.assertFalse((self.tmp / "orden.enviado.json").exists())

    def test_help(self):
        r = subprocess.run(["bash", str(SCRIPT), "--help"], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0)
        self.assertIn("APROBAR", r.stdout)

    # Criterio 2: acciones, ruta, formato del ID y url.
    def test_acciones_no_permitidas(self):
        for accion in ["CANCELAR", "CERRAR", "CERRAR_FUSIONADO", "registrar_pr", "EJECUTAR", "APRO", "aprobar", None]:
            with self.subTest(accion=accion):
                self.escribir({"accion": accion, "expectedEstado": "PR_ABIERTO"})
                self.rechaza("Acción no permitida")

    def test_id_u_otra_ruta(self):
        for orden in ["ORD-POS-99", "ORD-POS-0999", "ord-pos-099", "POS-001", "tareas/POS-001",
                      "ORD-POS-099/../../tareas/POS-001", "ORD-POS-099?x=1", ""]:
            with self.subTest(orden=orden):
                self.rechaza("ID de orden no válido", orden)

    def test_url_en_el_cuerpo(self):
        self.escribir({"accion": "ENVIAR", "expectedEstado": "APROBADA", "autorizacion": APROBAR["autorizacion"],
                       "url": "https://github.com/jlpulido107-bit/PROJECT-OS/issues/1"})
        self.rechaza("no debe traer url")

    def test_campos_no_permitidos(self):
        self.escribir({**REVISAR, "motivo": "x"})
        self.rechaza("Campos no permitidos: motivo")

    def test_request_id_presente_sin_repetir(self):
        self.escribir({**REVISAR, "requestId": "a"})
        self.rechaza("no debe traer requestId")

    def test_json_no_valido(self):
        self.archivo.write_text("{no")
        self.rechaza("no es JSON válido")

    # Criterio 3: autorizacion en APROBAR y ENVIAR, nunca en REVISAR.
    def test_aprobar_y_enviar_sin_autorizacion(self):
        for accion in ["APROBAR", "ENVIAR"]:
            with self.subTest(accion=accion):
                self.escribir({"accion": accion, "expectedEstado": "BORRADOR"})
                self.rechaza("exige autorizacion")

    def test_autorizacion_con_formato_malo(self):
        for texto in ["«sí» 2026-10-22", "ORD-POS-099 sí 2026-10-22", "ORD-POS-099 «sí» 22/10/2026",
                      "ORD-POS-099 «sí»", "ORD-POS-099 «» 2026-10-22", "ORD-POS-099 «sí» 2026-10-22 extra"]:
            with self.subTest(texto=texto):
                self.escribir({**APROBAR, "autorizacion": texto})
                self.rechaza("autorizacion no válida")

    def test_autorizacion_de_otra_orden(self):
        self.escribir({**APROBAR, "autorizacion": "ORD-POS-098 «sí» 2026-10-22"})
        self.rechaza("no coincide con el de la ruta")

    def test_revisar_con_autorizacion(self):
        self.escribir({**REVISAR, "autorizacion": APROBAR["autorizacion"]})
        self.rechaza("REVISAR no lleva autorizacion")

    # Criterios 1 y 4: PATCH fijo, sin Authorization, requestId guardado y resultados inciertos.
    def test_patch_url_fija_y_sin_authorization(self):
        r = self.ejecutar()
        self.assertEqual(r.returncode, 0, r.stderr)
        args = (self.tmp / "args").read_text().split("\n")
        self.assertEqual([a for a in args if a.startswith("http")], [URL])
        self.assertIn("PATCH", args)
        self.assertIn("--max-time", args)
        self.assertNotIn("authorization", " ".join(args).lower())
        self.assertIn("HTTP 200", r.stdout)
        self.assertIn(f"requestId={self.enviado()['requestId']}", r.stdout)
        self.assertIn('{"estado":"ENVIADA"}', r.stdout)

    # ORD-POS-063: REGISTRAR_PR sin autorizacion ni url; el servidor lo rechaza mientras la bandera esté apagada.
    def test_registrar_pr_sin_autorizacion_ni_url_pasa(self):
        self.escribir({"accion": "REGISTRAR_PR", "expectedEstado": "ENVIADA"})
        self.assertEqual(self.ejecutar().returncode, 0)
        self.assertEqual(self.enviado()["accion"], "REGISTRAR_PR")

    def test_registrar_pr_con_autorizacion_o_url(self):
        self.escribir({"accion": "REGISTRAR_PR", "expectedEstado": "ENVIADA", "autorizacion": APROBAR["autorizacion"]})
        self.rechaza("REGISTRAR_PR no lleva autorizacion")
        self.escribir({"accion": "REGISTRAR_PR", "expectedEstado": "ENVIADA",
                       "url": "https://github.com/jlpulido107-bit/PROJECT-OS/pull/1"})
        self.rechaza("no debe traer url")

    def test_revisar_sin_autorizacion_pasa(self):
        self.escribir(REVISAR)
        self.assertEqual(self.ejecutar().returncode, 0)
        self.assertEqual(self.enviado()["accion"], "REVISAR")

    def test_repetir_reusa_el_mismo_cuerpo(self):
        self.assertEqual(self.ejecutar().returncode, 0)
        primero = self.enviado()
        self.assertEqual(len(primero["requestId"]), 36)
        self.assertNotEqual(self.ejecutar().returncode, 0)  # sin --repetir no sobrescribe el cuerpo enviado
        self.assertEqual(self.ejecutar("ORD-POS-099", "--repetir").returncode, 0)
        self.assertEqual(self.enviado(), primero)

    def test_repetir_sin_enviado(self):
        r = self.ejecutar("ORD-POS-099", "--repetir")
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse((self.tmp / "args").exists())

    def test_inciertos_conservan_el_cuerpo(self):
        for codigo in ["409", "503"]:
            with self.subTest(codigo=codigo):
                r = self.ejecutar(codigo=codigo)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn("incierto", r.stderr)
                primero = self.enviado()
                self.assertFalse((self.tmp / "orden.rechazado.json").exists())
                self.assertEqual(self.ejecutar("ORD-POS-099", "--repetir").returncode, 0)
                self.assertEqual(self.enviado()["requestId"], primero["requestId"])
                (self.tmp / "orden.enviado.json").unlink()

    def test_fallo_de_transporte(self):
        (self.tmp / "curl").write_text("#!/usr/bin/env bash\nexit 28\n")
        r = self.ejecutar()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("Fallo de transporte: el resultado es incierto", r.stderr)
        self.assertTrue((self.tmp / "orden.enviado.json").exists())

    def test_3xx_es_redireccion_inesperada(self):
        r = self.ejecutar(codigo="302")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("redirección inesperada", r.stderr)

    def test_4xx_renombra_a_rechazado(self):
        r = self.ejecutar(codigo="422")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("orden.rechazado.json", r.stderr)
        self.assertFalse((self.tmp / "orden.enviado.json").exists())
        self.assertEqual(self.ejecutar().returncode, 0)  # reenvío del JSON corregido, sin --repetir


if __name__ == "__main__":
    unittest.main()
