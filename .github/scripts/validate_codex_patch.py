#!/usr/bin/env python3
"""Fail-closed validation for an untrusted Codex-generated git patch."""
import re
import subprocess
import sys
from pathlib import Path

ALLOWED_PREFIXES = ("web/src/", "web/tests/", "src/", "tests/", "docs/")
MAX_BYTES = 160_000
MAX_FILES = 12


def validate(path: Path) -> list[str]:
    if not path.is_file():
        raise ValueError("Missing Codex patch")
    data = path.read_bytes()
    if not data or len(data) > MAX_BYTES:
        raise ValueError("Patch empty or larger than 160 KB")
    text = data.decode("utf-8")
    if "GIT binary patch" in text or "literal " in text:
        raise ValueError("Binary patches are not permitted")
    if re.search(r"(?m)^(?:old|new|deleted) (?:file )?mode ", text):
        # New regular source files are allowed; symlinks and mode changes are not.
        modes = re.findall(r"(?m)^new file mode (\d+)$", text)
        if any(m != "100644" for m in modes):
            raise ValueError("Non-regular new file")
        if re.search(r"(?m)^(?:old mode|new mode|deleted file mode) ", text):
            raise ValueError("File deletion or mode changes forbidden")
    headers = [s for s in text.splitlines() if s.startswith("diff --git ")]
    if not 1 <= len(headers) <= MAX_FILES:
        raise ValueError("Unexpected number of changed files")
    seen = set()
    for header in headers:
        match = re.fullmatch(r"diff --git a/([A-Za-z0-9_./-]+) b/([A-Za-z0-9_./-]+)", header)
        if not match or match.group(1) != match.group(2):
            raise ValueError("Renamed, quoted, or invalid file path")
        filename = match.group(1)
        parts = filename.split("/")
        if ("." in parts or ".." in parts or
                not filename.startswith(ALLOWED_PREFIXES) or
                filename in seen or
                any(part.startswith(".") for part in parts) or
                any(part.lower() in ("secrets", "credentials", "deploy") for part in parts) or
                filename.endswith((".lock", ".env", ".sh", ".yml", ".yaml"))):
            raise ValueError(f"Forbidden path: {filename}")
        seen.add(filename)
    check = subprocess.run(
        ["git", "apply", "--check", "--binary", "--whitespace=error", str(path)],
        capture_output=True, text=True, check=False,
    )
    if check.returncode:
        raise ValueError("git apply --check failed: " + check.stderr[:600])
    return sorted(seen)


if __name__ == "__main__":
    try:
        files = validate(Path(sys.argv[1]))
        print("Validated patch paths:", ", ".join(files))
    except (IndexError, UnicodeDecodeError, ValueError) as exc:
        print(f"Codex patch rejected: {exc}", file=sys.stderr)
        raise SystemExit(1)
