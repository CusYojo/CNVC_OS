import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app


class CandidateCursorTests(unittest.TestCase):
    def setUp(self):
        self.rows = [
            {
                "source": "investment",
                "source_id": "new-low-score",
                "collected_at": "2026-07-29T01:00:00+00:00",
                "attention_score": 62,
            },
            {
                "source": "wechat_api",
                "source_id": "old-high-score",
                "collected_at": "2026-07-01T01:00:00+00:00",
                "attention_score": 98,
            },
            {
                "source": "investment",
                "source_id": "middle",
                "collected_at": "2026-07-20T01:00:00+00:00",
                "attention_score": 70,
            },
        ]

    def test_collected_sort_does_not_starve_new_low_score_candidate(self):
        ordered = sorted(self.rows, key=app.candidate_cursor_key, reverse=True)
        self.assertEqual(ordered[0]["source_id"], "new-low-score")

    def test_cursor_round_trip_splits_pages_without_overlap(self):
        ordered = sorted(self.rows, key=app.candidate_cursor_key, reverse=True)
        cursor = app.encode_candidate_cursor(app.candidate_cursor_key(ordered[0]))
        decoded = app.decode_candidate_cursor(cursor)
        next_page = [row for row in ordered if app.candidate_cursor_key(row) < decoded]
        self.assertEqual([row["source_id"] for row in next_page], ["middle", "old-high-score"])

    def test_invalid_cursor_is_rejected(self):
        with self.assertRaises(ValueError):
            app.decode_candidate_cursor("not-a-valid-cursor")


class SourceConfigurationTests(unittest.TestCase):
    def test_known_broken_sources_are_disabled(self):
        configured = {source["key"]: source for source in app.SOURCE_DEFAULTS}
        for key in ("pedaily_quicknews", "lieyunwang_feed", "producthunt_devtools"):
            self.assertFalse(configured[key]["enabled"])
            self.assertTrue(configured[key]["note"])


if __name__ == "__main__":
    unittest.main()
