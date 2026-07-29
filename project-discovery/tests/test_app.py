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


class ProjectSubjectNameTests(unittest.TestCase):
    def test_rejects_article_fragments(self):
        for value in (
            "作为完全开放",
            "受试者参与本研究会经历筛选期（需在14天内",
            "文章来源",
            "论文合作者为暨南大学经济与社会研究院",
            "national Economics",
            "key observation made in 2021 by the paper",
            "全新突破",
            "硬氪前线",
        ):
            with self.subTest(value=value):
                self.assertFalse(app.is_specific_project_subject_name(value))

    def test_extracts_financed_company_after_column_prefix(self):
        item = {
            "title": "硬氪前线 | 东昇聚变获数亿元融资，国内唯一布局“氘-氦3”路线核聚变企业",
            "project_name": "硬氪前线",
        }
        self.assertEqual(app.infer_project_name(item, item["title"]), "东昇聚变")

    def test_prefers_concrete_project_over_short_institution(self):
        item = {
            "title": "助力上海（长三角）国际科创中心建设！复旦大学光电研究院产业技术中试基地在普陀揭牌",
            "project_name": "复旦大学光电研究院",
        }
        self.assertEqual(
            app.infer_project_name(item, item["title"]),
            "复旦大学光电研究院产业技术中试基地",
        )

    def test_prefers_financed_company_over_columns_and_descriptive_phrases(self):
        cases = (
            (
                {
                    "title": "Kando AI完成数千万元种子轮融资，要做“决策领域的Cursor”｜涌现新项目",
                    "project_name": "涌现新项目",
                    "summary": "Kando AI已完成数千万元种子轮融资。",
                },
                "Kando AI",
            ),
            (
                {
                    "title": "清华00后团队获得峰瑞、破壳机器人投资，要做超薄视触觉传感器",
                    "project_name": "破壳机器人",
                    "summary": "近日，机器人触觉传感器与触觉数据方案提供商汇光创新连续完成数千万元种子轮及天使轮融资。",
                },
                "汇光创新",
            ),
            (
                {
                    "title": "自研SNN类脑芯片、做医疗设备的“上游大脑”，「米能科技」获数千万元融资",
                    "project_name": "上游大脑",
                },
                "米能科技",
            ),
            (
                {
                    "title": "硬氪首发 | 北航机器人所团队创业，首创智能变刚度关节，完成近亿元天使轮融资",
                    "project_name": "智能膝关节外骨骼项目",
                },
                "航墨科技",
            ),
            (
                {
                    "title": "独家｜清华系初创完成数亿元种子轮融资：我们不想被贴上「世界模型」的标签",
                    "project_name": "清华系初创项目",
                },
                "厘清智能",
            ),
            (
                {
                    "title": "前大疆科学家创业，半年内连获四轮数亿融资，耀途资本、锦秋基金等押注",
                    "project_name": "前大疆科学家空中智能体项目",
                },
                "硅羽科技",
            ),
        )
        for item, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(app.infer_project_name(item, item.get("summary", "")), expected)


if __name__ == "__main__":
    unittest.main()
