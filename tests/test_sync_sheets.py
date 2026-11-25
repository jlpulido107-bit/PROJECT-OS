import contextlib
import datetime as dt
import io
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import sync_sheets as sync


def make_report():
    return {"source": "github", "report_date": "2026-10-07", "errors": [],
            "projects": [{"repo": "test/repo", "commits": [
                {"id": "abc123", "message": "Create API", "url": "https://github.com/test/repo/commit/abc123",
                 "date": "2026-10-07T22:30:00Z"}],
                "pull_requests": [{"id": "4", "title": "=Bad formula", "url": "https://github.com/test/repo/pull/4",
                                   "updated_at": "2026-10-08T01:00:00Z"}],
                "issues": [], "limitations": []}]}


class MemorySheets:
    def __init__(self):
        self.tabs = {"EVIDENCIAS": [sync.EVIDENCE_HEADER[:]],
                     "SYNC_RUNS": [sync.RUNS_HEADER[:]]}
        self.writes = []

    def values(self, name):
        return [r[:] for r in self.tabs[name]]

    def append(self, name, rows):
        self.writes.append((name, rows))
        self.tabs[name].extend(rows)


class TestSheetSync(unittest.TestCase):
    def test_idempotent_for_same_or_different_run(self):
        report = make_report()
        rows = sync.build_evidence(report, {"test/repo": "TST"})
        self.assertEqual(len(rows), 2)
        client = MemorySheets()
        first = sync.synchronize(report, rows, client, "1001")
        self.assertEqual(first["inserted"], 2)
        self.assertEqual(len(client.tabs["EVIDENCIAS"]), 3)
        again = sync.synchronize(report, rows, client, "1001")
        self.assertTrue(again["already_processed"])
        other = sync.synchronize(report, rows, client, "1002")
        self.assertEqual(other["inserted"], 0)
        self.assertEqual(len(client.tabs["EVIDENCIAS"]), 3)
        self.assertEqual(len(client.tabs["SYNC_RUNS"]), 3)

    def test_unlinked_and_no_task_status_changes(self):
        rows = sync.build_evidence(make_report(), {"test/repo": "TST"})
        self.assertTrue(all(row[1] == "" for row in rows))
        self.assertTrue(all(row[8] == "CONFIRMADO" for row in rows))
        self.assertTrue(all(len(row) == 10 for row in rows))

    def test_manual_url_duplicate_skipped(self):
        rows = sync.build_evidence(make_report(), {"test/repo": "TST"})
        previous = [sync.EVIDENCE_HEADER, ["EVI-MANUAL", "", "TST", "PR",
                    "GitHub", rows[1][5], "4", "2026-10-07", "CONFIRMADO", "Manual"]]
        self.assertEqual(sync.select_new_rows(rows, previous), [rows[0]])

    def test_report_errors_fail_closed(self):
        report = make_report()
        report["errors"] = ["SIG: permission denied"]
        with self.assertRaises(ValueError):
            sync.build_evidence(report, {"test/repo": "TST"})

    def test_unknown_repo_fails(self):
        with self.assertRaises(ValueError):
            sync.build_evidence(make_report(), {"other/repo": "OTHER"})

    def test_schema_mismatch_prevents_all_writes(self):
        rows = sync.build_evidence(make_report(), {"test/repo": "TST"})
        client = MemorySheets()
        client.tabs["SYNC_RUNS"][0][1] = "WRONG"
        with self.assertRaises(ValueError):
            sync.synchronize(make_report(), rows, client, "1001")
        self.assertEqual(client.writes, [])

    def test_partial_report_marks_run_partial(self):
        report = make_report()
        report["projects"][0]["limitations"] = ["pagination cap"]
        client = MemorySheets()
        r = sync.synchronize(report, [], client, "1001")
        self.assertEqual(r["status"], "PARCIAL")
        self.assertEqual(client.tabs["SYNC_RUNS"][1][4], "PARCIAL")

    def test_dry_run_only_reads(self):
        client = MemorySheets()
        report = make_report()
        rows = sync.build_evidence(report, {"test/repo": "TST"})
        r = sync.synchronize(report, rows, client, "1001", dry_run=True)
        self.assertEqual(r["would_insert"], 2)
        self.assertEqual(client.writes, [])

    def test_formula_sanitization(self):
        self.assertEqual(sync.safe_text("=SUM(A1:A4)"), "'=SUM(A1:A4)")
        self.assertTrue(sync.build_evidence(make_report(), {"test/repo": "TST"})[1][9].startswith("Actividad observada:"))

    def test_invalid_url(self):
        report = make_report()
        report["projects"][0]["commits"][0]["url"] = "https://example.com/evil"
        with self.assertRaises(ValueError):
            sync.build_evidence(report, {"test/repo": "TST"})


if __name__ == "__main__":
    unittest.main()


class ArchivoManualDocumentado(unittest.TestCase):
    """ORD-POS-154 (DIS-09): el archivo manual de EVIDENCIAS y SYNC_RUNS está documentado y cuadra con el código."""

    def test_documenta_archivo_manual(self):
        doc = (Path(__file__).resolve().parents[1] / "docs" / "sheets-sync-setup.md").read_text(encoding="utf-8")
        start = doc.index("## Archivar EVIDENCIAS y SYNC_RUNS")
        end = doc.find("\n## ", start + 1)
        seccion = doc[start:] if end == -1 else doc[start:end]
        self.assertIn(f"hasta la fila {sync.MAX_ROWS}", seccion)
        self.assertIn("`MAX_ROWS`", seccion)
        for paso in ("**Pausa.**", "**Respaldo.**", "**Copiar.**", "**Borrar.**", "**Comprobar.**"):
            self.assertIn(paso, seccion)
        self.assertIn("ningún agente lo hace", seccion)
        self.assertIn("se inserta de nuevo", seccion)


COLECTOR = "project-os-colector@project-os-511102.iam.gserviceaccount.com"
DESPLIEGUE = "project-os-despliegue@project-os-511102.iam.gserviceaccount.com"
# Clave inventada para la prueba: no es ni se parece a una real.
CLAVE = json.dumps({"type": "service_account", "client_email": "anterior@ejemplo.iam.gserviceaccount.com",
                    "private_key": "NO-ES-UNA-CLAVE"})
ADC = {"SHEETS_CREDENTIALS": "adc", "SHEETS_EXPECTED_SERVICE_ACCOUNT": COLECTOR}


class CredencialesFalsas:
    def __init__(self, log, email=None, scopes=None):
        self.log, self.scopes, self.token = log, scopes, None
        if email is not None:
            self.service_account_email = email

    def with_scopes(self, scopes):
        self.log.append(("with_scopes", list(scopes)))
        return CredencialesFalsas(self.log, getattr(self, "service_account_email", None), list(scopes))

    def refresh(self, request):
        self.log.append(("refresh", self.scopes))
        self.token = "token-falso"


@contextlib.contextmanager
def google_falso(email_adc=None):
    """google-auth falso (la CI de los PR no lo instala): anota cómo pide SheetsClient las credenciales."""
    log = []
    nombres = ["google", "google.auth", "google.auth.transport", "google.auth.transport.requests",
               "google.oauth2", "google.oauth2.service_account"]
    m = {n: types.ModuleType(n) for n in nombres}
    for n in nombres[1:]:
        setattr(m[n.rpartition(".")[0]], n.rpartition(".")[2], m[n])

    def default(*args, **kwargs):
        log.append(("default", args, kwargs))
        return CredencialesFalsas(log, email_adc), None

    def from_service_account_info(info, scopes=None):
        log.append(("clave", info["client_email"], list(scopes)))
        return CredencialesFalsas(log, info["client_email"], list(scopes))

    m["google.auth"].default = default
    m["google.auth.transport.requests"].Request = lambda: "transporte"
    m["google.oauth2.service_account"].Credentials = types.SimpleNamespace(
        from_service_account_info=from_service_account_info)
    with mock.patch.dict(sys.modules, m):
        yield log


class CredencialesDelColector(unittest.TestCase):
    """ORD-POS-174: clave JSON (la ruta actual) o ADC con cuenta esperada; elección explícita, sin caída silenciosa."""

    def test_ruta_actual_solo_con_la_clave(self):
        self.assertEqual(sync.credential_config({sync.KEY_ENV: CLAVE}), ("service-account-key", CLAVE))
        # Una cuenta esperada sin SHEETS_CREDENTIALS=adc no cambia de ruta.
        self.assertEqual(sync.credential_config({sync.KEY_ENV: CLAVE, "SHEETS_EXPECTED_SERVICE_ACCOUNT": COLECTOR})[0],
                         "service-account-key")

    def test_sin_clave_no_cae_a_adc_por_omision(self):
        for env in ({}, {sync.KEY_ENV: "  "}, {"SHEETS_EXPECTED_SERVICE_ACCOUNT": COLECTOR},
                    {"GOOGLE_APPLICATION_CREDENTIALS": "/tmp/gha-creds.json"}):
            with self.assertRaises(ValueError) as error:
                sync.credential_config(env)
            self.assertEqual(str(error.exception), "Missing PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON GitHub secret")

    def test_adc_explicito_con_cuenta_de_servicio_esperada(self):
        env = {"SHEETS_CREDENTIALS": " ADC ", "SHEETS_EXPECTED_SERVICE_ACCOUNT": " " + COLECTOR.upper() + " "}
        self.assertEqual(sync.credential_config(env), ("adc", COLECTOR))

    def test_configuraciones_rechazadas_sin_filtrar_credenciales(self):
        malas = [
            {**ADC, sync.KEY_ENV: CLAVE},  # las dos a la vez: ni ADC ni clave por descarte
            {"SHEETS_CREDENTIALS": "adc"},  # ADC sin cuenta esperada
            {**ADC, "SHEETS_EXPECTED_SERVICE_ACCOUNT": "persona@gmail.com"},  # nunca una cuenta de persona
            {**ADC, "SHEETS_EXPECTED_SERVICE_ACCOUNT": COLECTOR + ".ejemplo.test"},
            {"SHEETS_CREDENTIALS": "service-account-file", sync.KEY_ENV: CLAVE},  # modo desconocido
        ]
        for env in malas:
            with self.assertRaises(ValueError) as error:
                sync.credential_config(env)
            mensaje = str(error.exception)
            self.assertNotIn("@", mensaje)
            self.assertNotIn("NO-ES-UNA-CLAVE", mensaje)

    def test_la_clave_sigue_funcionando_y_no_toca_adc(self):
        with google_falso() as log:
            cliente = sync.SheetsClient("hoja", *sync.credential_config({sync.KEY_ENV: CLAVE}))
        self.assertEqual(log, [("clave", "anterior@ejemplo.iam.gserviceaccount.com", sync.SHEETS_SCOPE),
                               ("refresh", sync.SHEETS_SCOPE)])
        self.assertEqual(cliente.credentials.token, "token-falso")

    def test_adc_comprueba_la_identidad_antes_de_pedir_el_token(self):
        with google_falso(COLECTOR) as log:
            cliente = sync.SheetsClient("hoja", *sync.credential_config(ADC))
        # default() sin alcances no pide tokens; el alcance de Sheets se pone después de comprobar la cuenta.
        self.assertEqual(log, [("default", (), {}), ("with_scopes", sync.SHEETS_SCOPE), ("refresh", sync.SHEETS_SCOPE)])
        self.assertEqual(cliente.credentials.token, "token-falso")

    def test_adc_con_otra_identidad_no_pide_token(self):
        # La cuenta del despliegue, una cuenta de persona (sin service_account_email) y la de Compute («default»).
        for email in (DESPLIEGUE, None, "default"):
            with google_falso(email) as log:
                with self.assertRaises(ValueError) as error:
                    sync.SheetsClient("hoja", "adc", COLECTOR)
            self.assertEqual([paso[0] for paso in log], ["default"])
            self.assertNotIn("@", str(error.exception))

    def test_main_elige_la_ruta_y_falla_cerrado(self):
        creados = []

        def cliente_falso(hoja, modo, valor):
            creados.append((hoja, modo, valor))
            return MemorySheets()

        with tempfile.TemporaryDirectory() as carpeta:
            informe = Path(carpeta) / "2026-10-07.json"
            informe.write_text(json.dumps({"source": "github", "report_date": "2026-10-07", "errors": [],
                                           "projects": []}), encoding="utf-8")
            argv = ["sync_sheets.py", "--report", str(informe)]
            for env in ({sync.KEY_ENV: CLAVE}, ADC):
                with mock.patch.dict(os.environ, {**env, "GITHUB_RUN_ID": "1001"}, clear=True), \
                        mock.patch.object(sys, "argv", argv), mock.patch.object(sync, "SheetsClient", cliente_falso), \
                        contextlib.redirect_stdout(io.StringIO()):
                    sync.main()
            for env in ({}, {**ADC, sync.KEY_ENV: CLAVE}):
                with mock.patch.dict(os.environ, {**env, "GITHUB_RUN_ID": "1001"}, clear=True), \
                        mock.patch.object(sys, "argv", argv), mock.patch.object(sync, "SheetsClient", cliente_falso):
                    with self.assertRaises(SystemExit) as salida:
                        sync.main()
                self.assertIsInstance(salida.exception.code, str)
        hoja = json.loads((Path(__file__).resolve().parents[1] / "config" / "projects.json").read_text())["spreadsheet_id"]
        self.assertEqual(creados, [(hoja, "service-account-key", CLAVE), (hoja, "adc", COLECTOR)])

    def test_adc_real_con_el_archivo_de_wif_de_github_actions(self):
        """Con google-auth instalado (requirements-sync.txt): el archivo external_account que deja
        google-github-actions/auth, con transporte falso. Sin red."""
        try:
            import google.auth.transport
            import google.auth.transport.requests as transporte
        except ImportError:
            self.skipTest("google-auth no está instalado (pip install -r requirements-sync.txt)")
        llamadas = []

        class Respuesta(google.auth.transport.Response):
            def __init__(self, cuerpo):
                self._data = json.dumps(cuerpo).encode("utf-8")

            status = property(lambda self: 200)
            headers = property(lambda self: {})
            data = property(lambda self: self._data)

        class Transporte:
            def __call__(self, url, method="GET", body=None, headers=None, timeout=None, **kwargs):
                llamadas.append((url, body.decode("utf-8") if isinstance(body, bytes) else body))
                if url.endswith(":generateAccessToken"):
                    caduca = dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=1)
                    return Respuesta({"accessToken": "token-de-la-cuenta", "expireTime": caduca.strftime("%Y-%m-%dT%H:%M:%SZ")})
                if url.endswith("/v1/token"):
                    return Respuesta({"access_token": "federado", "token_type": "Bearer", "expires_in": 3600,
                                      "issued_token_type": "urn:ietf:params:oauth:token-type:access_token"})
                return Respuesta({"value": "jwt-de-github"})

        suplantar = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" + COLECTOR + ":generateAccessToken"
        with tempfile.TemporaryDirectory() as carpeta:
            archivo = Path(carpeta) / "gha-creds.json"
            archivo.write_text(json.dumps({
                "type": "external_account",
                "audience": "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/"
                            "github-colector/providers/github-actions",
                "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
                "token_url": "https://sts.googleapis.com/v1/token",
                "service_account_impersonation_url": suplantar,
                "credential_source": {"url": "https://oidc.invalid/token", "headers": {"Authorization": "Bearer falso"},
                                      "format": {"type": "json", "subject_token_field_name": "value"}},
            }), encoding="utf-8")
            with mock.patch.dict(os.environ, {"GOOGLE_APPLICATION_CREDENTIALS": str(archivo)}, clear=True), \
                    mock.patch.object(transporte, "Request", Transporte):
                with self.assertRaises(ValueError):
                    sync.SheetsClient("hoja", "adc", DESPLIEGUE)
                self.assertEqual(llamadas, [])  # otra identidad: ni una petición
                cliente = sync.SheetsClient("hoja", "adc", COLECTOR)
        self.assertEqual(cliente.credentials.token, "token-de-la-cuenta")
        pedidos = [json.loads(cuerpo) for url, cuerpo in llamadas if url == suplantar]
        self.assertEqual([pedido["scope"] for pedido in pedidos], [sync.SHEETS_SCOPE])
