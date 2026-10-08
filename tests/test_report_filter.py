"""Tests for selecting which projects can be reported."""
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import collect_activity as ca


class TestFilter(unittest.TestCase):
    def test_filter_selects_only_named_project(self):
        original_root = ca.ROOT
        with tempfile.TemporaryDirectory() as td:
            path = Path(td)
            (path / "config").mkdir()
            (path / "config" / "projects.json").write_text(
                json.dumps({"projects": [
                    {"id": "SIG", "enabled": True, "github_repo": "u/SIG"},
                    {"id": "POS", "enabled": True, "github_repo": "u/POS"},
                ]}), encoding="utf-8"
            )
            ca.ROOT = path
            try:
                with patch.dict(os.environ, {
                    "GH_READ_TOKEN": "test", "REPORT_DATE": "2026-10-08",
                    "REPORT_PROJECT_IDS": "POS",
                }), patch.object(ca, "repo_events", return_value={
                    "repo": "u/POS", "branches": ["main"], "commits": [],
                    "pull_requests": [], "issues": [], "limitations": [],
                }) as mocked:
                    ca.main()
                mocked.assert_called_once()
                self.assertEqual(mocked.call_args.args[0], "u/POS")
                payload = json.loads((path / "reports" / "2026-10" / "2026-10-08.json").read_text())
                self.assertEqual(len(payload["projects"]), 1)
                self.assertEqual(payload["errors"], [])
            finally:
                ca.ROOT = original_root


if __name__ == "__main__":
    unittest.main()
