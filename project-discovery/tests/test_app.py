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
    def test_non_academic_arxiv_candidate_reaches_fallback_without_error(self):
        item = {
            "source": "arxiv",
            "title": "FaceMoE: Mixture of Experts for Low-Resolution Face Recognition",
        }
        self.assertEqual(
            app.infer_project_name(item, item["title"]),
            "未命名项目",
        )

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
            "小马智行已经组建运营团队",
            "用于消费机器人项目",
            "人创业团队",
            "4人创业团队",
            "柔性触觉感知企业",
            "东方纹样文化创意品牌",
            "根据投中嘉川CVSource数据",
            "我要招一个电子",
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

    def test_extracts_quoted_investment_target(self):
        item = {
            "title": "36氪获悉｜赤子城科技投资：4人创业团队「MobAI」，推出AI互动叙事应用",
            "project_name": "人创业团队",
            "summary": "36氪获悉， AI 创业公司「MobAI」已完成数百万元天使轮融资。",
        }
        self.assertEqual(app.infer_project_name(item, item["summary"]), "MobAI")

    def test_strips_financing_auxiliary_from_subject(self):
        item = {
            "title": "月之暗面Kimi已完成F轮融资，估值达百亿美元",
            "project_name": "月之暗面Kimi已",
        }
        self.assertEqual(app.infer_project_name(item, ""), "月之暗面Kimi")

    def test_prefers_explicit_legal_company_in_ipo_article(self):
        item = {
            "title": "秋声 | 31岁学霸冲港股IPO，消费机器人赛道再升温",
            "project_name": "用于消费机器人项目",
            "article_text": (
                "本末动力（北京）科技股份有限公司通过港交所聆讯，"
                "公司专注于消费级机器人核心部件。"
            ),
        }
        self.assertEqual(
            app.infer_project_name(item, item["article_text"]),
            "本末动力（北京）科技股份有限公司",
        )

    def test_extracts_named_brands_from_real_radar_articles(self):
        cases = (
            (
                {
                    "title": "OceanBase回应融资报道：全力投入AI数据创新，与资本市场保持开放沟通",
                    "summary": "OceanBase正在与投资者洽谈A轮融资，目标融资规模约20亿至30亿元。",
                },
                "OceanBase",
            ),
            (
                {
                    "title": "在大模型的下一阶段议题上，我们找到了一家做持续学习的中国Neo Lab",
                    "summary": "2025年10月，Mind Lab成立，团队约30余人。",
                },
                "Mind Lab",
            ),
            (
                {
                    "title": "硬氪首发 | 率先跑通盈利，智谷天厨获招商局创投领投近亿元融资",
                },
                "智谷天厨",
            ),
            (
                {
                    "title": "36氪首发｜家居音频品牌「MORROR ART」完成亿元级B+轮融资",
                },
                "MORROR ART",
            ),
            (
                {
                    "title": "清华博士团队创业，这家公司要给飞机做氢能「心脏」｜36氪首发",
                    "summary": "36氪获悉，航空新能源动力系统解决方案供应商「易氢动力」已完成数千万元天使+轮融资。",
                },
                "易氢动力",
            ),
            (
                {
                    "title": "从月之暗面出走，他用AI技术帮人找对象，徐新投资 | 涌现新项目",
                    "summary": "2025年8月，他离职创办“良配科技”，核心产品“良配”。",
                },
                "良配科技",
            ),
        )
        for item, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(app.infer_project_name(item, item.get("summary", "")), expected)

    def test_prefers_named_title_project_over_venue_company(self):
        item = {
            "title": "科氪 | 定义AI睡眠健康新赛道 东莞数字人体与智慧睡眠创新联合体落地慕思",
            "summary": (
                "东莞市数字人体与智慧睡眠创新联合体揭牌暨工作推进会"
                "在慕思健康睡眠股份有限公司总部举行。"
            ),
        }
        self.assertEqual(
            app.infer_project_name(item, item["summary"]),
            "东莞数字人体与智慧睡眠创新联合体",
        )


class BusinessRegionTests(unittest.TestCase):
    def test_normalizes_city_address_to_province(self):
        self.assertEqual(app.normalize_business_region("深圳市南山区科技园"), "广东")
        self.assertEqual(app.normalize_business_region("南京市江北新区研创园"), "江苏")

    def test_extracts_explicit_headquarters_location(self):
        result = app.infer_business_region(
            {"project_name": "某工业软件项目"},
            "某工业软件项目公司总部位于深圳市南山区，主要从事工业软件研发。",
        )
        self.assertEqual(result["region"], "广东")
        self.assertEqual(result["region_source"], "来源原文明确地点")

    def test_uses_academic_institution_but_not_casual_city_mentions(self):
        academic = app.infer_business_region(
            {
                "project_name": "清华大学机器人实验室",
                "source_group": "高校公众号",
                "source_name": "清华大学",
            },
            "",
            lab="清华大学机器人实验室",
        )
        self.assertEqual(academic["region"], "北京")

        casual = app.infer_business_region(
            {"project_name": "某智能项目"},
            "团队受邀前往上海参加会议，并与北京投资机构交流。",
        )
        self.assertEqual(casual["region"], "待确认")

    def test_prefers_subject_prefix_over_collaborator_location(self):
        result = app.infer_business_region(
            {
                "project_name": "武汉中科牛津波谱技术有限公司",
                "source_group": "高校公众号",
                "source_name": "西安交通大学",
            },
            "",
            lab="西安交通大学科研团队",
        )
        self.assertEqual(result["region"], "湖北")


if __name__ == "__main__":
    unittest.main()
