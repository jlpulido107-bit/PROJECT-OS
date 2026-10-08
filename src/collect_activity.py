"""Read-only GitHub evidence collector for PROJECT-OS.

GitHub activity is not evidence that a business task is complete.
No modifications are made to source repositories.
"""
import datetime as dt
import json
import os
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
TZ = ZoneInfo("America/Merida")
MAX_PAGES = 5


def local_day_bounds(day):
    date = dt.date.fromisoformat(day)
    start_local = dt.datetime.combine(date, dt.time.min, TZ)
    end_local = start_local + dt.timedelta(days=1)
    return (
        start_local.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        end_local.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )


def get_json(path, token):
    req = Request("https://api.github.com" + path, headers={
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + token,
        "User-Agent": "PROJECT-OS/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    with urlopen(req, timeout=30) as resp:
        return json.load(resp)


def repo_events(repo, start, end, token):
    """Collect events from each branch, deduplicating SHAs.

    This is deliberately read-only. Per-repo branch and pagination limits are
    stated in the resulting report rather than silently implying full coverage.
    """
    safe_repo = "/".join(quote(p, safe="") for p in repo.split("/"))
    limitations = []

    def in_window(stamp):
        return bool(stamp) and start <= stamp < end

    branches = []
    for page in range(1, MAX_PAGES + 1):
        batch = get_json(f"/repos/{safe_repo}/branches?per_page=100&page={page}", token)
        if not isinstance(batch, list):
            raise ValueError("Unexpected GitHub branches response")
        branches.extend(item["name"] for item in batch)
        if len(batch) < 100:
            break
    else:
        limitations.append(f"branch enumeration capped at {MAX_PAGES * 100} branches")

    max_branches = 40
    if len(branches) > max_branches:
        limitations.append(f"commit scan capped at {max_branches} of {len(branches)} branches")
        branches = branches[:max_branches]
    if not branches:
        limitations.append("No GitHub branches found; no commit history scanned")

    # A commit reachable from multiple branches counts as only one event.
    unique = {}
    for branch in branches:
        ref = quote(branch, safe="")
        params = f"sha={ref}&since={quote(start, safe='')}&until={quote(end, safe='')}"
        for page in range(1, MAX_PAGES + 1):
            batch = get_json(
                f"/repos/{safe_repo}/commits?{params}&per_page=100&page={page}", token
            )
            if not isinstance(batch, list):
                raise ValueError("Unexpected GitHub commits response")
            for item in batch:
                date = item.get("commit", {}).get("committer", {}).get("date") or ""
                if not in_window(date):
                    continue
                sha = item["sha"]
                if sha not in unique:
                    unique[sha] = {
                        "id": sha,
                        "message": item["commit"]["message"].splitlines()[0],
                        "url": item["html_url"],
                        "date": date,
                        "branches": [],
                    }
                unique[sha]["branches"].append(branch)
            if len(batch) < 100:
                break
        else:
            limitations.append(f"commits on {branch}: capped at {MAX_PAGES * 100}")

    found = {}
    for kind, endpoint in {
        "pull_requests": f"/repos/{safe_repo}/pulls?state=all&sort=updated&direction=desc",
        "issues": f"/repos/{safe_repo}/issues?state=all&sort=updated&direction=desc",
    }.items():
        collected = []
        for page in range(1, MAX_PAGES + 1):
            batch = get_json(f"{endpoint}&per_page=100&page={page}", token)
            if not isinstance(batch, list):
                raise ValueError(f"Unexpected GitHub {kind} response")
            collected.extend(batch)
            if len(batch) < 100:
                break
        else:
            limitations.append(f"{kind}: capped at {MAX_PAGES * 100} events")
        found[kind] = collected

    pulls = [{
        "id": str(x["number"]), "title": x["title"], "state": x["state"],
        "url": x["html_url"], "updated_at": x["updated_at"],
    } for x in found["pull_requests"] if in_window(x.get("updated_at"))]
    issues = [{
        "id": str(x["number"]), "title": x["title"], "state": x["state"],
        "url": x["html_url"], "updated_at": x["updated_at"],
    } for x in found["issues"]
        if "pull_request" not in x and in_window(x.get("updated_at"))]
    commits = sorted(unique.values(), key=lambda item: (item["date"], item["id"]))
    return {
        "repo": repo, "branches": branches, "commits": commits,
        "pull_requests": pulls, "issues": issues, "limitations": limitations,
    }


def safe_markdown(value):
    return str(value).replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]").replace("\n", " ").strip()


def render(day, results, errors):
    lines = [f"# Informe PROJECT-OS — {day}", "",
             "> Evidencia técnica de GitHub. No representa el avance completo del negocio.", ""]
    if not results:
        lines += ["No hay repositorios con resultados verificados para esta fecha.", ""]
    for item in results:
        lines += [f"## {safe_markdown(item['repo'])}", "",
                  f"- Ramas examinadas: {len(item.get('branches', []))}",
                  f"- Commits detectados: {len(item['commits'])}",
                  f"- PRs modificados: {len(item['pull_requests'])}",
                  f"- Issues modificados: {len(item['issues'])}", ""]
        for heading, key in [("Commits", "commits"), ("Pull requests", "pull_requests"), ("Issues", "issues")]:
            lines.append(f"### {heading}")
            for event in item[key]:
                title = safe_markdown(event.get("message") or event.get("title") or "Ver evento")
                lines.append(f"- [{title}]({event['url']})")
            if not item[key]:
                lines.append("- Sin eventos detectados en esta categoría")
            lines.append("")
        if item.get("limitations"):
            lines += ["**Cobertura limitada:** " + "; ".join(item["limitations"]), ""]
    if errors:
        lines += ["## Errores / cobertura parcial", ""] + [f"- {safe_markdown(s)}" for s in errors] + [""]
    lines += ["## Propuesta de seguimiento", "",
              "- Revisar los entregables y criterios de aceptación en el tablero maestro.",
              "- Actualizar manualmente el trabajo no técnico y las decisiones.",
              "- Proponer prioridades de mañana con capacidad y dependencias.",
              "- No cerrar tareas automáticamente por commits o PRs.", ""]
    return "\n".join(lines)


def main():
    day = os.getenv("REPORT_DATE") or dt.datetime.now(TZ).date().isoformat()
    start, end = local_day_bounds(day)
    token = os.getenv("GH_READ_TOKEN")
    if not token:
        raise SystemExit("Missing GH_READ_TOKEN; use a read-only, least-privilege token")
    config = json.loads((ROOT / "config" / "projects.json").read_text(encoding="utf-8"))
    results, errors = [], []
    allowed_ids = {
        item.strip() for item in os.getenv("REPORT_PROJECT_IDS", "").split(",")
        if item.strip()
    }
    for project in config["projects"]:
        if allowed_ids and project["id"] not in allowed_ids:
            continue
        if not project.get("enabled") or not project.get("github_repo"):
            continue
        try:
            results.append(repo_events(project["github_repo"], start, end, token))
        except Exception as exc:
            # Log HTTP status, never response body, paths or credentials.
            status = f" HTTP {exc.code}" if isinstance(exc, HTTPError) else ""
            errors.append(
                f"{project['id']}: error de lectura ({type(exc).__name__}{status}); "
                "revisar permisos/API"
            )
    report_dir = ROOT / "reports" / day[:7]
    report_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "report_date": day, "timezone": "America/Merida",
        "start_utc": start, "end_utc_exclusive": end,
        "source": "github", "projects": results, "errors": errors,
    }
    (report_dir / f"{day}.json").write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (report_dir / f"{day}.md").write_text(render(day, results, errors), encoding="utf-8")
    print(f"Generated {day}: {len(results)} repositories, {len(errors)} errors")
    if errors and not results:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
