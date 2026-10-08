"""Unit tests for GitHub activity capture without network access."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import collect_activity as ca


class TestGitHubActivity(unittest.TestCase):
    def test_only_events_within_merida_day_and_issues_exclude_prs(self):
        start, end = ca.local_day_bounds("2026-10-08")
        self.assertEqual((start, end), ("2026-10-08T06:00:00Z", "2026-10-09T06:00:00Z"))
        commits = [
            {"sha": "in", "commit": {"committer": {"date": start}, "message": "Relevant\nbody"}, "html_url": "https://github.com/test/repo/commit/in"},
            {"sha": "out", "commit": {"committer": {"date": end}, "message": "Next day"}, "html_url": "https://github.com/test/repo/commit/out"},
        ]
        prs = [
            {"number": 11, "title": "Current", "state": "open", "updated_at": start, "html_url": "https://github.com/test/repo/pull/11"},
            {"number": 12, "title": "Next day", "state": "closed", "updated_at": end, "html_url": "https://github.com/test/repo/pull/12"},
        ]
        issues = [
            {"number": 7, "title": "Issue", "state": "open", "updated_at": start, "html_url": "https://github.com/test/repo/issues/7"},
            {"number": 11, "title": "PR masquerading as issue", "state": "open", "updated_at": start, "html_url": "https://github.com/test/repo/pull/11", "pull_request": {}},
        ]
        def mock_get(path, token):
            if "/commits?" in path:
                return commits
            if "/pulls?" in path:
                return prs
            if "/issues?" in path:
                return issues
            raise AssertionError(path)
        with patch.object(ca, "get_json", side_effect=mock_get) as call:
            actual = ca.repo_events("test/repo", start, end, "masked-token")
        self.assertEqual([x["id"] for x in actual["commits"]], ["in"])
        self.assertEqual([x["id"] for x in actual["pull_requests"]], ["11"])
        self.assertEqual([x["id"] for x in actual["issues"]], ["7"])
        self.assertEqual(call.call_count, 3)

    def test_repo_empty(self):
        def mock_get(path, token):
            return []
        with patch.object(ca, "get_json", side_effect=mock_get):
            result = ca.repo_events("test/repo", "2026-10-08T06:00:00Z", "2026-10-09T06:00:00Z", "unused")
        self.assertEqual(result["commits"], [])
        self.assertEqual(result["pull_requests"], [])
        self.assertEqual(result["issues"], [])
        self.assertFalse(result["limitations"])

    def test_api_errors_propagate_for_caller_to_record(self):
        with patch.object(ca, "get_json", side_effect=PermissionError("forbidden")):
            with self.assertRaises(PermissionError):
                ca.repo_events("test/private", "2026-10-08T06:00:00Z", "2026-10-09T06:00:00Z", "unused")


if __name__ == "__main__":
    unittest.main()
