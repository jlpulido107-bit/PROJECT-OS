import datetime as dt
import sys
import unittest
from pathlib import Path

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
