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
    safe_repo = "/".join(quote(p, safe="") for p in repo.split("/"))
    endpoints = {
        "commits": f"/repos/{safe_repo}/commits?since={quote(start)}&until={quote(end)}",
        "pull_requests": f"/repos/{safe_repo}/pulls?state=all&sort=updated&direction=desc",
        "issues": f"/repos/{safe_repo}/issues?state=all&sort=updated&direction=desc",
    }
    found, limitations = {}, []
    for kind, endpoint in endpoints.items():
        collected = []
        for page in range(1, MAX_PAGES + 1):
            sep = "&" if "?" in endpoint else "?"
            batch = get_json(f"{endpoint}{sep}per_page=100&page={page}", token)
            if not isinstance(batch, list):
                raise ValueError("Unexpected GitHub API result type")
            collected.extend(batch)
            if len(batch) < 100:
                break
        else:
            limitations.append(f"{kind}: paginación limitada a {MAX_PAGES * 100} eventos")
        found[kind] = collected

    def in_window(stamp):
        return start <= stamp < end

    commits = []
    for item in found["commits"]:
        date = item.get("commit", {}).get("committer", {}).get("date") or ""
        if in_window(date):
            commits.append({
                "id": item["sha"], "message": item["commit"]["message"].splitlines()[0],
                "url": item["html_url"],
            })
    prs = [{
        "id": str(x["number"]), "title": x["title"], "state": x["state"],
        "url": x["html_url"],
    } for x in found["pull_requests"] if in_window(x.get("updated_at") or "")]
    issues = [{
        "id": str(x["number"]), "title": x["title"], "state": x["state"],
        "url": x["html_url"],
    } for x in found["issues"]
        if "pull_request" not in x and in_window(x.get("updated_at") or "")]
    return {
        "repo": repo, "commits": commits, "pull_requests": prs,
        "issues": issues, "limitations": limitations,
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
    for project in config["projects"]:
        if not project.get("enabled") or not project.get("github_repo"):
            continue
        try:
            results.append(repo_events(project["github_repo"], start, end, token))
        except Exception as exc:
            # Never put response bodies or token strings in reports.
            errors.append(f"{project['id']}: error de lectura ({type(exc).__name__}); revisar permisos/API")
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
