"""Sheets sync dry-run against an IN-MEMORY sheet, for PR CI (no Google credentials, no network).

Reads the report that collect_activity.py just generated, validates it with read_report() and runs synchronize()
in dry-run mode against MemorySheets, the same fake sheet used by test_sync_sheets.py. It never builds a
SheetsClient: PR CI must not receive Google credentials nor read the real sheet (PR #24, review R3-1).
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))
import sync_sheets as sync  # noqa: E402
from test_sync_sheets import MemorySheets  # noqa: E402


def main(argv):
    if os.getenv("PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON"):
        raise SystemExit("PR CI must not receive Google credentials; refusing to run")
    reports_dir = Path(argv[1]) if len(argv) > 1 else ROOT / "reports"
    reports = sorted(reports_dir.glob("*/*.json"))
    if len(reports) != 1:
        raise SystemExit(f"Expected exactly one report from the smoke test; found {len(reports)}")
    config = json.loads((ROOT / "config/projects.json").read_text(encoding="utf-8"))
    report, proposed = sync.read_report(reports[0], config)
    sheet = MemorySheets()
    result = sync.synchronize(report, proposed, sheet, os.getenv("GITHUB_RUN_ID") or "1", dry_run=True)
    if sheet.writes:
        raise SystemExit("Dry-run wrote to the in-memory sheet")
    print("Sheets sync dry-run (in-memory sheet):", json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv)
