"""scripts/mac-verificar.sh con una Mac simulada: PATH solo trae `id` y `stat` falsos; nunca corre comandos del sistema."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "mac-verificar.sh"
PLANTILLA = ROOT / "docs" / "mac" / "managed-settings.plantilla.json"
BASH = shutil.which("bash")
ID_FALSO = f"""#!{BASH}
echo "id $*" >> "$DIR_FALSO/llamadas"
if [ "$1" = "-un" ]; then echo dueno; exit 0; fi
if [ "$1" = "-Gn" ] && [ "$2" = "taller" ] && [ -n "$GRUPOS_FALSOS" ]; then echo "$GRUPOS_FALSOS"; exit 0; fi
exit 1
"""
STAT_FALSO = f"""#!{BASH}
echo "stat $*" >> "$DIR_FALSO/llamadas"
[ "$1" = "-f" ] || exit 1
case "$2" in
  %Lp) echo "$MODO_FALSO" ;;
  "%u %Lp") if [ -d "$3" ]; then echo "$CARPETA_FALSA"; else echo "$ARCHIVO_FALSO"; fi ;;
  *) exit 1 ;;
esac
"""
PUNTOS = ["1.", "2a.", "2b.", "2c.", "3.", "4.", "5."]


class TestMacVerificar(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        for nombre, texto in (("id", ID_FALSO), ("stat", STAT_FALSO)):
            (self.bin / nombre).write_text(texto)
            (self.bin / nombre).chmod(0o755)
        self.raiz = self.tmp / "raiz"
        self.dueno = self.raiz / "Users" / "dueno"
        self.taller = self.raiz / "Users" / "taller"
        self.instalado = self.raiz / "Library" / "Application Support" / "ClaudeCode" / "managed-settings.json"
        for carpeta in (self.dueno, self.taller, self.instalado.parent):
            carpeta.mkdir(parents=True)
        shutil.copyfile(PLANTILLA, self.instalado)

    def ejecutar(self, *args, modo="700", grupos="staff everyone", sudo_user=None, archivo="0 644", carpeta="0 755"):
        # PATH solo con los falsos: cualquier otro comando externo fallaría en vez de tocar el sistema.
        entorno = {"PATH": str(self.bin), "DIR_FALSO": str(self.tmp), "MODO_FALSO": modo, "GRUPOS_FALSOS": grupos,
                   "ARCHIVO_FALSO": archivo, "CARPETA_FALSA": carpeta,
                   "MAC_VERIFICAR_RAIZ": str(self.raiz)}
        if sudo_user:
            entorno["SUDO_USER"] = sudo_user
        return subprocess.run([BASH, str(SCRIPT), *args], env=entorno, capture_output=True, text=True, timeout=30)

    def lineas(self, r):
        return {l.split()[1]: l for l in r.stdout.splitlines() if l.startswith(("OK ", "FALLA "))}

    def falla_solo(self, punto, texto, **kw):
        r = self.ejecutar(**kw)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        lineas = self.lineas(r)
        self.assertEqual([p for p in PUNTOS if lineas[p].startswith("FALLA")], [punto], r.stdout)
        self.assertIn(texto, lineas[punto])

    def escribir(self, ruta, texto="x"):
        ruta.parent.mkdir(parents=True, exist_ok=True)
        ruta.write_text(texto)

    def foto(self):
        return sorted((str(p.relative_to(self.raiz)), p.lstat().st_mode, p.lstat().st_mtime_ns,
                       p.read_bytes() if p.is_file() else b"") for p in self.raiz.rglob("*"))

    def test_todo_ok(self):
        r = self.ejecutar()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(r.stderr, "")
        lineas = self.lineas(r)
        self.assertEqual(list(lineas), PUNTOS)
        self.assertTrue(all(l.startswith("OK ") for l in lineas.values()), r.stdout)
        self.assertIn("todo OK", r.stdout)

    def test_help_y_uso(self):
        r = self.ejecutar("--help")
        self.assertEqual(r.returncode, 0)
        self.assertIn("--propietario", r.stdout)
        for args in (["--otra"], ["--taller"], ["--propietario", "../x"], ["--propietario", "taller"], ["sobra"]):
            with self.subTest(args=args):
                r = self.ejecutar(*args)
                self.assertEqual(r.returncode, 2)
                self.assertEqual(r.stdout, "")

    # Solo lectura: ni la Mac simulada ni la plantilla cambian, con todo OK y con todo en FALLA.
    def test_no_cambia_nada(self):
        plantilla = PLANTILLA.read_bytes()
        antes = self.foto()
        self.ejecutar()
        self.assertEqual(self.foto(), antes)
        self.escribir(self.dueno / ".clasprc.json")
        self.escribir(self.taller / ".config/gh/hosts.yml", "github.com:\n")
        self.escribir(self.taller / ".config/gcloud/application_default_credentials.json")
        self.escribir(self.instalado, "{}")
        antes = self.foto()
        r = self.ejecutar(modo="755", grupos="staff admin")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(self.foto(), antes)
        self.assertEqual(PLANTILLA.read_bytes(), plantilla)
        self.assertEqual(sorted(p.name for p in self.tmp.iterdir()), ["bin", "llamadas", "raiz"])

    def test_solo_llama_a_id_y_stat(self):
        self.ejecutar()
        llamadas = (self.tmp / "llamadas").read_text().splitlines()
        self.assertEqual(llamadas, ["id -un", f"stat -f %Lp {self.dueno}", "id -Gn taller",
                                    f"stat -f %u %Lp {self.instalado}", f"stat -f %u %Lp {self.instalado.parent}"])

    def test_script_sin_comandos_que_cambian(self):
        codigo = "\n".join(l.split(" # ")[0] for l in SCRIPT.read_text().splitlines() if not l.lstrip().startswith("#"))
        for palabra in ("sudo ", "rm ", "mv ", "cp ", "chmod", "chown", "mkdir", "touch", "tee", "install ", "gcloud auth",
                        "gh auth", "clasp log", "curl", "defaults ", "dscl", "sed -i", "eval", ">>"):
            with self.subTest(palabra=palabra):
                self.assertNotIn(palabra, codigo)
        # Las únicas redirecciones de salida son a stderr o a /dev/null.
        self.assertNotRegex(codigo, r"\s\d?>\s*(?!&2|/dev/null)\S")

    # Punto 1.
    def test_permisos_de_la_carpeta(self):
        for modo in ("755", "750", "711", "701", "1700"):
            with self.subTest(modo=modo):
                self.falla_solo("1.", f"permisos {modo}", modo=modo)
        self.falla_solo("1.", "no se pudieron leer", modo="")
        self.falla_solo("1.", "no se pudieron leer", modo="drwx------")

    def test_carpeta_del_propietario_no_existe(self):
        r = self.ejecutar("--propietario", "otro")
        self.assertEqual(r.returncode, 1)
        self.assertIn("FALLA 1.", r.stdout)
        self.assertIn("FALLA 3.", r.stdout)

    def test_propietario_por_sudo_user(self):
        r = self.ejecutar(sudo_user="dueno")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertNotIn("id -un", (self.tmp / "llamadas").read_text())

    # H4: la variable de pruebas nunca pasa en silencio.
    def test_aviso_de_carpeta_simulada(self):
        r = self.ejecutar()
        self.assertIn(f"AVISO MAC_VERIFICAR_RAIZ está definida: se revisa la carpeta simulada {self.raiz}", r.stdout)
        self.assertIn("Resultado: todo OK en la carpeta simulada: NO vale como verificación de esta Mac", r.stdout)
        r = self.ejecutar(modo="755")
        self.assertIn("1 FALLA(s) en la carpeta simulada", r.stdout)
        self.assertEqual(SCRIPT.read_text().count('[ -n "$raiz" ]'), 1)

    # H1: una carpeta que existe pero no se deja listar nunca es «sin sesión».
    def test_carpetas_de_sesion_ilegibles(self):
        casos = {".config": ["2b.", "2c."], ".config/gcloud": ["2c."], ".config/gcloud/configurations": ["2c."],
                 ".config/gcloud/legacy_credentials": ["2c."], ".config/gh": ["2b."]}
        for ruta, esperadas in casos.items():
            with self.subTest(ruta=ruta):
                if not ruta.endswith("legacy_credentials"):
                    self.escribir(self.taller / ".config/gcloud/configurations/config_default", "[core]\naccount = alguien\n")
                if ruta.endswith("legacy_credentials"):
                    self.escribir(self.taller / ruta / "cuenta/adc.json")
                self.escribir(self.taller / ".config/gh/hosts.yml", "github.com:\n")
                cerrada = self.taller / ruta
                cerrada.chmod(0o000)
                try:
                    if os.access(cerrada, os.R_OK):
                        self.skipTest("root lee cualquier carpeta")
                    lineas = self.lineas(self.ejecutar())
                    for punto in esperadas:
                        self.assertTrue(lineas[punto].startswith("FALLA"), lineas[punto])
                    self.assertIn("no se puede leer", lineas[esperadas[0]])
                finally:
                    cerrada.chmod(0o755)
                    shutil.rmtree(self.taller / ".config")

    def test_configurations_ilegible_del_propietario(self):
        cerrada = self.dueno / ".config/gcloud/configurations"
        self.escribir(cerrada / "config_default", "[core]\naccount = alguien\n")
        cerrada.chmod(0o000)
        self.addCleanup(cerrada.chmod, 0o755)
        if os.access(cerrada, os.R_OK):
            self.skipTest("root lee cualquier carpeta")
        self.falla_solo("3.", "no se puede leer configurations")

    # Punto 2.
    def test_taller_administrador_o_inexistente(self):
        self.falla_solo("2a.", "administrador", grupos="staff admin everyone")
        self.falla_solo("2a.", "no existe", grupos="")
        r = self.ejecutar(grupos="staff _lpadmin administradores")
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_taller_con_sesion_de_gh(self):
        hosts = self.taller / ".config/gh/hosts.yml"
        self.escribir(hosts, "github.com:\n    user: alguien\n")
        self.falla_solo("2b.", "hosts.yml")
        self.escribir(hosts, "\n# vacío tras gh auth logout\n")
        self.assertEqual(self.ejecutar().returncode, 0)

    def test_taller_con_sesion_de_gcloud(self):
        base = self.taller / ".config/gcloud"
        casos = {"application_default_credentials.json": "application_default_credentials",
                 "legacy_credentials/cuenta/adc.json": "legacy_credentials",
                 "configurations/config_default": "cuenta activa en config_default"}
        for ruta, texto in casos.items():
            with self.subTest(ruta=ruta):
                self.escribir(base / ruta, "[core]\naccount = alguien\n")
                self.falla_solo("2c.", texto)
                shutil.rmtree(base)

    def test_taller_ilegible(self):
        self.taller.chmod(0o000)
        self.addCleanup(self.taller.chmod, 0o755)
        if os.access(self.taller, os.R_OK):
            self.skipTest("root lee cualquier carpeta")
        r = self.ejecutar()
        self.assertEqual(r.returncode, 1)
        lineas = self.lineas(r)
        self.assertEqual([p for p in PUNTOS if lineas[p].startswith("FALLA")], ["2b.", "2c.", "4."])
        self.assertIn("sudo", lineas["2b."])

    # Punto 3.
    def test_gcloud_del_propietario(self):
        base = self.dueno / ".config/gcloud"
        self.escribir(base / "configurations/config_default", "[core]\nproject = p\n")
        self.escribir(base / "active_config", "default")
        (base / "legacy_credentials").mkdir()
        self.assertEqual(self.ejecutar().returncode, 0)
        self.escribir(base / "configurations/config_otra", "[core]\n  account=alguien\n")
        self.falla_solo("3.", "cuenta activa en config_otra")
        (base / "configurations/config_otra").unlink()
        self.escribir(base / "legacy_credentials/.oculta/adc.json")
        self.falla_solo("3.", "legacy_credentials")

    # Punto 4.
    def test_clasp_con_sesion(self):
        for casa in (self.dueno, self.taller):
            with self.subTest(casa=casa.name):
                self.escribir(casa / ".clasprc.json", "{}")
                self.falla_solo("4.", f"{casa.name}/.clasprc.json")
                (casa / ".clasprc.json").unlink()
        (self.dueno / ".clasprc.json").symlink_to(self.tmp / "no-existe")
        self.falla_solo("4.", ".clasprc.json")

    # Punto 5.
    def test_managed_settings(self):
        original = PLANTILLA.read_text()
        for texto in (original + "\n", original.rstrip("\n"), original.replace("true", "false", 1), ""):
            with self.subTest(texto=len(texto)):
                self.instalado.write_text(texto)
                self.falla_solo("5.", "distinto de la plantilla")
        self.instalado.unlink()
        self.falla_solo("5.", "no está instalado")
        r = self.ejecutar("--plantilla", str(self.tmp / "no-existe.json"))
        self.assertIn("FALLA 5. managed-settings: no se puede leer la plantilla", r.stdout)

    # H2: idéntico no basta si alguien que no es root puede cambiarlo.
    def test_managed_settings_no_protegido(self):
        casos = [({"archivo": "501 644"}, "su dueño no es root"), ({"archivo": "0 666"}, "permisos 666"),
                 ({"archivo": "0 664"}, "permisos 664"), ({"archivo": "0 646"}, "permisos 646"),
                 ({"archivo": "0 1666"}, "permisos 1666"), ({"archivo": ""}, "no se pudieron leer"),
                 ({"archivo": "root 644"}, "no se pudieron leer"), ({"carpeta": "501 755"}, "su carpeta: su dueño no es root"),
                 ({"carpeta": "0 777"}, "su carpeta: permisos 777"), ({"carpeta": "0 775"}, "su carpeta: permisos 775")]
        for kw, texto in casos:
            with self.subTest(kw=kw):
                self.falla_solo("5.", texto, **kw)
        for kw in ({"archivo": "0 444"}, {"archivo": "0 600"}, {"archivo": "0 755"}, {"carpeta": "0 1755"}, {"carpeta": "0 700"}):
            with self.subTest(kw=kw):
                self.assertEqual(self.ejecutar(**kw).returncode, 0)

    def test_managed_settings_por_enlace(self):
        real = self.tmp / "otro" / "managed-settings.json"
        self.escribir(real, PLANTILLA.read_text())
        self.instalado.unlink()
        self.instalado.symlink_to(real)
        self.falla_solo("5.", "no protegido: es un enlace simbólico")
        self.instalado.unlink()
        self.instalado.parent.rmdir()
        self.instalado.parent.symlink_to(real.parent)
        self.falla_solo("5.", "su carpeta: es un enlace simbólico")

    def test_plantilla_alterna(self):
        otra = self.tmp / "otra.json"
        otra.write_text("{}\n")
        self.instalado.write_text("{}\n")
        self.falla_solo("5.", "distinto")
        self.assertEqual(self.ejecutar("--plantilla", str(otra)).returncode, 0)


class TestPlantilla(unittest.TestCase):
    def setUp(self):
        self.texto = PLANTILLA.read_text()
        self.datos = json.loads(self.texto)
        self.deny = self.datos["permissions"]["deny"]

    def test_fuera_de_claude(self):
        self.assertNotIn(".claude", PLANTILLA.relative_to(ROOT).parts)
        self.assertEqual(list(ROOT.glob(".claude/**/managed-settings*")), [])

    def test_deny(self):
        for regla in ("Bash(gh pr merge *)", "Bash(git push * main)", "Bash(git push *:main)", "Bash(clasp *)",
                      "Bash(gcloud *)", "Read(~/.clasprc.json)", "Read(~/.config/gcloud/**)", "Read(//**/privado/**)"):
            with self.subTest(regla=regla):
                self.assertIn(regla, self.deny)
        self.assertEqual(len(self.deny), len(set(self.deny)))

    def test_sin_bypass_ni_permisos_abiertos(self):
        permisos = self.datos["permissions"]
        self.assertEqual(permisos["disableBypassPermissionsMode"], "disable")
        self.assertEqual(set(permisos), {"disableBypassPermissionsMode", "deny"})
        self.assertNotIn("bypassPermissions", self.texto)
        self.assertNotIn("dangerously", self.texto)

    def test_sandbox_activado(self):
        sandbox = self.datos["sandbox"]
        self.assertIs(sandbox["enabled"], True)
        self.assertIs(sandbox["failIfUnavailable"], True)
        self.assertIs(sandbox["allowUnsandboxedCommands"], False)
        self.assertEqual(set(sandbox), {"enabled", "failIfUnavailable", "allowUnsandboxedCommands", "filesystem"})
        self.assertEqual(set(sandbox["filesystem"]), {"denyRead"})
        self.assertEqual(sandbox["filesystem"]["denyRead"], ["~/.clasprc.json", "~/.config/gcloud"])

    def test_solo_claves_conocidas(self):
        self.assertEqual(set(self.datos), {"permissions", "sandbox"})

    def test_guia_cita_las_fuentes(self):
        guia = (ROOT / "docs" / "mac" / "candados.md").read_text()
        for texto in ("DEC-POS-034", "DEC-POS-040", "mac-verificar.sh", "managed-settings.plantilla.json",
                      "/Library/Application Support/ClaudeCode/managed-settings.json"):
            self.assertIn(texto, guia)


if __name__ == "__main__":
    unittest.main()
