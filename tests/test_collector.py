import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from collect_activity import render, local_day_bounds, safe_markdown


class TestCollector(unittest.TestCase):
    def test_report_empty(self):
        result = render("2026-10-08", [{
            "repo": "owner/demo", "commits": [], "pull_requests": [], "issues": [],
            "limitations": [],
        }], [])
        self.assertIn("Sin eventos detectados", result)
        self.assertIn("No representa el avance completo", result)

    def test_errors_visible(self):
        result = render("2026-10-08", [], ["SIG: error"])
        self.assertIn("Errores / cobertura parcial", result)
        self.assertIn("SIG: error", result)

    def test_merida_day_bounds(self):
        start, end = local_day_bounds("2026-10-08")
        self.assertEqual(start, "2026-10-08T06:00:00Z")
        self.assertEqual(end, "2026-10-09T06:00:00Z")

    def test_safe_markdown(self):
        self.assertEqual(safe_markdown("a[b]"), "a\\[b\\]")


if __name__ == "__main__":
    unittest.main()
