"""El hook de inicio no hace nada fuera de la nube (CLAUDE_CODE_REMOTE distinto de true)."""
import json
import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / ".claude" / "hooks" / "instalar-dependencias.sh"
SETTINGS = ROOT / ".claude" / "settings.json"
NODE_MODULES = ROOT / "web" / "node_modules"


class TestHookDependencias(unittest.TestCase):
    def ejecutar(self, remoto):
        entorno = {k: v for k, v in os.environ.items() if k != "CLAUDE_CODE_REMOTE"}
        entorno["CLAUDE_CODE_REMOTE"] = remoto
        return subprocess.run(["bash", str(SCRIPT)], env=entorno, capture_output=True, text=True, timeout=30)

    def test_fuera_de_la_nube_sale_0_sin_efectos(self):
        antes = NODE_MODULES.exists()
        for remoto in ("", "false"):
            r = self.ejecutar(remoto)
            self.assertEqual(r.returncode, 0, remoto)
            self.assertEqual(r.stdout + r.stderr, "", remoto)
        self.assertEqual(NODE_MODULES.exists(), antes)

    def test_settings_solo_tiene_el_hook_session_start(self):
        ajustes = json.loads(SETTINGS.read_text(encoding="utf-8"))
        self.assertEqual(list(ajustes), ["hooks"])
        self.assertEqual(list(ajustes["hooks"]), ["SessionStart"])
        comandos = [h["command"] for g in ajustes["hooks"]["SessionStart"] for h in g["hooks"]]
        self.assertEqual(len(comandos), 1)
        self.assertIn(".claude/hooks/instalar-dependencias.sh", comandos[0])


if __name__ == "__main__":
    unittest.main()
