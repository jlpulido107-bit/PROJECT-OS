"""scripts/pm-alta.sh con un curl simulado en PATH: nunca toca la red."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "pm-alta.sh"
URL = "https://project-os-dashboard-235975889400.northamerica-south1.run.app/api/operaciones/tareas"
CURL_FALSO = """#!/usr/bin/env bash
printf '%s\\n' "$@" > "$DIR_FALSO/args"
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && salida=$2; shift; done
echo '{"id":"POS-099"}' > "$salida"; printf '%s' "${CODIGO_FALSO:-201}"
"""
TAREA = {"proyectoId": "POS", "titulo": "Tarea de prueba", "tipo": "OPERATIVA", "prioridad": "P2", "criterioTerminado": "Listo"}


class TestPmAlta(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "curl").write_text(CURL_FALSO)
        (self.tmp / "curl").chmod(0o755)
        self.archivo = self.tmp / "tarea.json"
        self.escribir(TAREA)

    def escribir(self, datos):
        self.archivo.write_text(json.dumps(datos))

    def ejecutar(self, tipo="tareas", *extra, codigo="201"):
        entorno = {**os.environ, "PATH": f"{self.tmp}:{os.environ['PATH']}", "DIR_FALSO": str(self.tmp), "CODIGO_FALSO": codigo}
        return subprocess.run(["bash", str(SCRIPT), tipo, str(self.archivo), *extra], env=entorno, capture_output=True, text=True, timeout=30)

    def enviado(self):
        return json.loads((self.tmp / "tarea.enviado.json").read_text())

    def test_tipo_invalido(self):
        r = self.ejecutar("hitos")
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse((self.tmp / "args").exists())

    def test_limite_excedido(self):
        self.escribir({**TAREA, "titulo": "x" * 161})
        r = self.ejecutar()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("titulo excede 160", r.stderr)
        self.assertFalse((self.tmp / "args").exists())

    def test_request_id_presente_sin_repetir(self):
        self.escribir({**TAREA, "requestId": "a"})
        r = self.ejecutar()
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse((self.tmp / "args").exists())

    def test_repetir_reusa_el_mismo_cuerpo(self):
        self.assertEqual(self.ejecutar().returncode, 0)
        primero = self.enviado()
        self.assertEqual(len(primero["requestId"]), 36)
        self.assertNotEqual(self.ejecutar().returncode, 0)  # sin --repetir no sobrescribe el cuerpo enviado
        self.assertEqual(self.ejecutar("tareas", "--repetir").returncode, 0)
        self.assertEqual(self.enviado(), primero)

    def test_url_fija_y_sin_authorization(self):
        self.assertEqual(self.ejecutar().returncode, 0)
        args = (self.tmp / "args").read_text().split("\n")
        self.assertEqual([a for a in args if a.startswith("http")], [URL])
        self.assertNotIn("authorization", " ".join(args).lower())

    def test_http_de_error_sale_distinto_de_0(self):
        r = self.ejecutar(codigo="400")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("HTTP 400", r.stdout)


if __name__ == "__main__":
    unittest.main()
