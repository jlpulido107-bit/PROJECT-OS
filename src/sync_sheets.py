"""One-way, opt-in synchronization from verified GitHub report JSON to Sheets.

This module NEVER changes task state. It only appends EVIDENCIAS and SYNC_RUNS.
Credentials must be a service-account secret; no browser credentials are used.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import re
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
ZONE = ZoneInfo("America/Merida")
SHEETS_SCOPE = ["https://www.googleapis.com/auth/spreadsheets"]
EVIDENCE_HEADER = ["EVIDENCIA_ID", "TAREA_ID", "PROYECTO_ID", "TIPO", "FUENTE",
                   "REFERENCIA_URL", "REFERENCIA_EXTERNA_ID", "FECHA",
                   "VERIFICACION", "DESCRIPCION"]
RUNS_HEADER = ["RUN_ID", "FUENTE", "INICIO", "FIN", "ESTADO",
               "REGISTROS_PROCESADOS", "ERROR_RESUMEN"]
EVENT_TYPES = [("commits", "COMMIT"), ("pull_requests", "PR"), ("issues", "ISSUE")]
MAX_ROWS = 5000


def event_key(repo, kind, item_id):
    """Stable identifier for the underlying GitHub object, independent of report date."""
    return f"github:{repo}:{kind}:{item_id}"


def record_id(key):
    return "EVI-GH-" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:24].upper()


def safe_text(value, length=240):
    """Plain text for Sheets; avoid accidental formula execution."""
    value = re.sub(r"[\x00-\x1f]+", " ", str(value or "")).strip()[:length]
    return "'" + value if value.startswith(("=", "+", "-", "@")) else value


def valid_github_url(url, repo):
    parts = urlparse(str(url or ""))
    return (parts.scheme == "https" and parts.hostname == "github.com"
            and parts.username is None and parts.password is None
            and parts.path.startswith("/" + repo + "/"))


def build_evidence(report, project_ids):
    """Return complete rows, no writes; fail on partial collection."""
    if report.get("source") != "github" or report.get("errors"):
        raise ValueError("Report missing GitHub source or contains collection errors")
    day = dt.date.fromisoformat(report["report_date"])
    rows = []
    keys = set()
    for source in report.get("projects", []):
        repo = source["repo"]
        if repo not in project_ids:
            raise ValueError("Unconfigured repository: " + repo)
        project_id = project_ids[repo]
        for collection, kind in EVENT_TYPES:
            for event in source.get(collection, []):
                ident = str(event["id"])
                key = event_key(repo, kind, ident)
                if key in keys:
                    continue
                keys.add(key)
                url = event["url"]
                if not valid_github_url(url, repo):
                    raise ValueError("Unexpected evidence URL for " + repo)
                date_stamp = event.get("date") or event.get("updated_at")
                event_date = (dt.datetime.fromisoformat(date_stamp.replace("Z", "+00:00"))
                              .astimezone(ZONE).date().isoformat() if date_stamp
                              else day.isoformat())
                title = safe_text(event.get("message") or event.get("title") or kind)
                # Project mapping is clear; task mapping is deliberately blank.
                # CONFIRMADO means metadata exists, NOT that any task is complete.
                rows.append([
                    record_id(key), "", project_id, kind, "GitHub", url,
                    key, event_date, "CONFIRMADO",
                    safe_text("Actividad observada: " + title + " | Sin validación de cierre", 480),
                ])
    return rows


def read_report(path, config):
    report = json.loads(Path(path).read_text(encoding="utf-8"))
    project_ids = {
        entry["github_repo"]: entry["id"]
        for entry in config["projects"] if entry.get("enabled") and entry.get("github_repo")
    }
    if not project_ids:
        raise ValueError("No enabled repositories")
    return report, build_evidence(report, project_ids)


def check_headers(rows, expected, title):
    if not rows or rows[0][:len(expected)] != expected:
        raise ValueError("Invalid schema in tab " + title)


def select_new_rows(rows, existing):
    """Deduplicate by stable key, stable row ID and existing URL (manual evidence)."""
    check_headers(existing, EVIDENCE_HEADER, "EVIDENCIAS")
    found_ids, found_keys, found_urls = set(), set(), set()
    for row in existing[1:]:
        if len(row) > 0 and row[0]:
            found_ids.add(str(row[0]))
        if len(row) > 6 and row[6]:
            found_keys.add(str(row[6]))
        if len(row) > 5 and row[5]:
            found_urls.add(str(row[5]))
    return [row for row in rows
            if row[0] not in found_ids
            and row[6] not in found_keys
            and row[5] not in found_urls]


def run_id(report, github_run_id):
    return f"GH-SYNC-{github_run_id}-{report['report_date']}"


class SheetsClient:
    def __init__(self, spreadsheet_id, credentials_json):
        try:
            from google.oauth2 import service_account
            from google.auth.transport.requests import Request as GoogleAuthRequest
        except ImportError as error:
            raise RuntimeError("Install google-auth[requests] dependency") from error
        info = json.loads(credentials_json)
        if info.get("type") != "service_account":
            raise ValueError("Expected a Google service-account JSON")
        self.credentials = service_account.Credentials.from_service_account_info(
            info, scopes=SHEETS_SCOPE)
        self.credentials.refresh(GoogleAuthRequest())
        self.spreadsheet_id = spreadsheet_id

    def request(self, method, path, body=None):
        url = ("https://sheets.googleapis.com/v4/spreadsheets/" +
               quote(self.spreadsheet_id, safe="") + path)
        headers = {"Authorization": "Bearer " + self.credentials.token}
        payload = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            payload = json.dumps(body).encode("utf-8")
        req = Request(url, headers=headers, data=payload, method=method)
        try:
            with urlopen(req, timeout=35) as response:
                return json.load(response)
        except HTTPError as error:
            # Never log response body; may contain implementation details.
            raise RuntimeError("Google Sheets request failed (HTTP %s)" % error.code) from None

    def values(self, title):
        range_a1 = quote(f"'{title}'!A1:J{MAX_ROWS}", safe="")
        return self.request("GET", f"/values/{range_a1}?valueRenderOption=FORMATTED_VALUE").get("values", [])

    def append(self, title, rows):
        if not rows:
            return
        range_a1 = quote(f"'{title}'!A:J", safe="")
        params = urlencode({"valueInputOption": "RAW", "insertDataOption": "INSERT_ROWS"})
        self.request("POST", f"/values/{range_a1}:append?{params}",
                     {"majorDimension": "ROWS", "values": rows})


def synchronize(report, proposed, client, gh_run, dry_run=False, now=None):
    """Idempotent under serialized writer executions; no in-place cell changes."""
    if not gh_run or not gh_run.isdecimal():
        raise ValueError("Missing numeric GITHUB_RUN_ID")
    evidence = client.values("EVIDENCIAS")
    runs = client.values("SYNC_RUNS")
    check_headers(runs, RUNS_HEADER, "SYNC_RUNS")
    if len(evidence) >= MAX_ROWS or len(runs) >= MAX_ROWS:
        raise ValueError("Sheet exceeds configured scan limit; aborting to avoid duplicates")
    new = select_new_rows(proposed, evidence)
    identifier = run_id(report, gh_run)
    prior_ids = {str(row[0]) for row in runs[1:] if row}
    if identifier in prior_ids:
        # Already fully recorded from a previous attempt.
        return {"already_processed": True, "planned": len(proposed), "inserted": 0}
    if dry_run:
        return {"already_processed": False, "planned": len(proposed),
                "would_insert": len(new)}
    started = now or dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    # The report and existing tab schema were validated before any write.
    client.append("EVIDENCIAS", new)
    finished = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    partial = [f"{source['repo']}: {', '.join(source.get('limitations') or [])}"
               for source in report.get("projects", []) if source.get("limitations")]
    status = "PARCIAL" if partial else "EXITOSA"
    client.append("SYNC_RUNS", [[identifier, "GitHub Actions", started, finished,
                                  status, len(new), safe_text("; ".join(partial), 480)]])
    return {"already_processed": False, "planned": len(proposed),
            "inserted": len(new), "status": status}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    config = json.loads((ROOT / "config/projects.json").read_text(encoding="utf-8"))
    report, proposed = read_report(args.report, config)
    spreadsheet_id = config.get("spreadsheet_id")
    if not spreadsheet_id:
        raise SystemExit("Missing spreadsheet ID in project config")
    credentials = os.getenv("PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON")
    if not credentials:
        raise SystemExit("Missing PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON GitHub secret")
    client = SheetsClient(spreadsheet_id, credentials)
    result = synchronize(report, proposed, client, os.getenv("GITHUB_RUN_ID"),
                         dry_run=args.dry_run)
    print("Sheets sync result:", json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
