"""Offline guardrail tests for the untrusted Codex patch validator."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


VALIDATOR = Path(__file__).resolve().parents[1] / ".github/scripts/validate_codex_patch.py"


class CodexPatchValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.email", "tests@example.test")
        self.git("config", "user.name", "Tests")
        for name in ("web/tests/example.test.ts", ".github/workflows/blocked.yml"):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("original\n")
        self.git("add", "-A")
        self.git("commit", "-qm", "base")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.root,
                              capture_output=True, check=True).stdout

    def patch_for(self, filename, content):
        (self.root / filename).write_text(content)
        patch = self.git("diff", "--binary", "HEAD")
        self.git("reset", "--hard", "HEAD")
        patch_file = self.root / "change.patch"
        patch_file.write_bytes(patch)
        return patch_file

    def validate(self, patch):
        return subprocess.run([sys.executable, str(VALIDATOR), str(patch)],
                              cwd=self.root, text=True, capture_output=True)

    def test_allows_small_source_test_change(self):
        patch = self.patch_for("web/tests/example.test.ts", "changed\n")
        self.assertEqual(self.validate(patch).returncode, 0)

    def test_rejects_workflow_edit(self):
        patch = self.patch_for(".github/workflows/blocked.yml", "unsafe\n")
        self.assertNotEqual(self.validate(patch).returncode, 0)

    def test_rejects_empty_patch(self):
        patch = self.root / "empty.patch"
        patch.write_text("")
        self.assertNotEqual(self.validate(patch).returncode, 0)


if __name__ == "__main__":
    unittest.main()
