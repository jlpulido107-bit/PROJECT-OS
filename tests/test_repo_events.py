"""Unit tests for GitHub activity capture without network access."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import collect_activity as ca


def commit(sha, when, text):
    return {
        "sha": sha,
        "commit": {"committer": {"date": when}, "message": text},
        "html_url": "https://github.com/test/repo/commit/" + sha,
    }


class TestGitHubActivity(unittest.TestCase):
    def test_collects_every_branch_and_deduplicates(self):
        start, end = ca.local_day_bounds("2026-10-08")
        self.assertEqual((start, end), ("2026-10-08T06:00:00Z", "2026-10-09T06:00:00Z"))
        prs = [
            {"number": 11, "title": "Current", "state": "open", "updated_at": start, "html_url": "https://github.com/test/repo/pull/11"},
            {"number": 12, "title": "Next day", "state": "closed", "updated_at": end, "html_url": "https://github.com/test/repo/pull/12"},
        ]
        issues = [
            {"number": 7, "title": "Issue", "state": "open", "updated_at": start, "html_url": "https://github.com/test/repo/issues/7"},
            {"number": 11, "title": "PR masquerading as issue", "state": "open", "updated_at": start, "html_url": "https://github.com/test/repo/pull/11", "pull_request": {}},
        ]

        def mock_get(path, token):
            if "/branches?" in path:
                return [{"name": "main"}, {"name": "feature/thing"}]
            if "/commits?" in path and "sha=main" in path:
                return [commit("shared", start, "Shared\nbody"), commit("out", end, "Tomorrow")]
            if "/commits?" in path and "sha=feature%2Fthing" in path:
                return [commit("shared", start, "Shared\nbody"),
                        commit("feature", "2026-10-08T12:00:00Z", "Branch work")]
            if "/pulls?" in path:
                return prs
            if "/issues?" in path:
                return issues
            raise AssertionError(path)

        with patch.object(ca, "get_json", side_effect=mock_get) as calls:
            actual = ca.repo_events("test/repo", start, end, "masked-token")
        self.assertEqual(set(x["id"] for x in actual["commits"]), {"shared", "feature"})
        shared = next(item for item in actual["commits"] if item["id"] == "shared")
        self.assertEqual(shared["branches"], ["main", "feature/thing"])
        self.assertEqual([x["id"] for x in actual["pull_requests"]], ["11"])
        self.assertEqual([x["id"] for x in actual["issues"]], ["7"])
        self.assertEqual(actual["branches"], ["main", "feature/thing"])
        self.assertEqual(calls.call_count, 5)

    def test_no_branches_records_coverage_gap(self):
        with patch.object(ca, "get_json", return_value=[]):
            result = ca.repo_events("test/repo", "2026-10-08T06:00:00Z", "2026-10-09T06:00:00Z", "unused")
        self.assertEqual(result["commits"], [])
        self.assertEqual(result["pull_requests"], [])
        self.assertTrue(any("No GitHub branches" in x for x in result["limitations"]))

    def test_api_errors_propagate_for_caller_to_record(self):
        with patch.object(ca, "get_json", side_effect=PermissionError("forbidden")):
            with self.assertRaises(PermissionError):
                ca.repo_events("test/private", "2026-10-08T06:00:00Z", "2026-10-09T06:00:00Z", "unused")


if __name__ == "__main__":
    unittest.main()
