import argparse
import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


PROCESSOR = Path(__file__).resolve().parents[1] / "scripts" / "compliance_processor.py"
SPEC = importlib.util.spec_from_file_location("compliance_processor_fidelity", PROCESSOR)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def ready_delivery():
    return {
        "status": "ready",
        "as_of_date": "2026-08-18",
        "blocking_issues": [],
        "missing_decisive_inputs": [],
        "supplement_request": {
            "requested": False,
            "outcome": "not_needed",
            "requested_items": [],
        },
        "continuation_authorization": {
            "authorized": False,
            "basis": "not_required",
        },
        "fund_agreement": {
            "status": "verified",
            "source_ids": ["FUND-AGREEMENT"],
            "applicable_clauses": {
                "investment_scope": "人工智能与智能制造",
                "investment_restrictions": "仅限股权投资且不含禁止事项",
                "return_investment": "按实缴规模及约定倍数计算",
                "concentration": "单项目不超过基金规模20%",
                "configuration": "允许基金直接股权投资"
            }
        },
        "transaction_terms": {
            "status": "verified",
            "source_ids": ["TERM-SHEET"],
            "terms": {
                "investment_amount": 1000,
                "currency": "人民币万元",
                "transaction_form": "增资",
                "pre_money_valuation": 9000,
                "post_money_valuation": 10000,
                "post_investment_ownership": 0.10,
                "fully_diluted_basis": "交割后完全摊薄"
            }
        },
        "return_investment": {
            "status": "calculated",
            "source_ids": ["FUND-LEDGER", "TERM-SHEET"],
            "calculation": {
                "as_of_date": "2026-08-18",
                "denominator": 50000,
                "multiplier": 1.0,
                "completed_amount": 30000,
                "proposed_eligible_credit": 0,
                "post_investment_headroom": 19000
            }
        },
        "concentration": {
            "status": "calculated",
            "source_ids": ["FUND-AGREEMENT", "FUND-LEDGER", "TERM-SHEET"],
            "calculation": {
                "as_of_date": "2026-08-18",
                "denominator": 50000,
                "limit_ratio": 0.20,
                "existing_aggregated_exposure": 0,
                "proposed_amount": 1000,
                "post_investment_ratio": 0.02,
                "headroom": 9000
            }
        },
        "related_party": {
            "status": "verified",
            "source_ids": ["RELATED-PARTY-CHECKLIST"],
            "perimeter": ["基金", "管理人", "出资人", "目标公司", "股东", "管理层", "共同投资人"]
        }
    }


def fixture_content():
    checks = [
        "符合基金投资限制要求：本项目采用股权增资方式取得目标公司股权，不属于基金协议禁止的借贷、担保、房地产开发或二级市场证券投资，交易类型与基金可投方式一致。",
        "不会导致基金返投要求难以完成：投资完成后按基金实缴规模、已认定返投金额及可投资余额复核，仍保留覆盖剩余返投义务的资金空间，测算口径和基准日已经明确。",
        "不涉及关联交易：现有股权结构、管理人员名单和关联关系核查材料未显示目标公司或交易对方与基金、管理人构成关联关系，审阅范围覆盖本次交易主要参与方。",
        "符合基金投资方向要求：项目主营人工智能训练数据、机器人控制与仿真工具，产品用于自动驾驶和具身智能研发，属于基金协议约定的新一代信息技术方向。",
        "符合基金投资配置要求：项目按基金直接股权投资方案实施，投资工具、持股层级及投后权益纳入直投配置统计，未设置改变风险性质的复杂嵌套载体。",
        "符合基金投资集中度要求：本次拟投金额与同一目标主体既有投资合并计算后，占基金最新实缴规模的比例未超过协议约定的单项目投资上限。",
        "未发现其他明显违法违规情形：现有主体资格、经营范围、诉讼执行、行政处罚及业务合规材料未显示足以禁止本次投资的重大违法事项，公开核验与内部材料未见实质冲突。",
    ]
    checks = [text + "本项判断已列明审阅范围、计算口径、资料基准日及投资完成后的影响，相关依据均可回溯至测试证据。" for text in checks]
    sourced = {"source_ids": ["TEST"], "status": "verified"}
    team = [
        {"person_name": "李明", "role_title": "公司创始人兼总经理", "text": "公司创始人兼总经理李明，清华大学计算机科学硕士，曾任自动驾驶企业算法负责人，长期从事感知算法、训练数据闭环和研发团队管理，主导多项人工智能项目从原型开发、工程验证到客户交付，历任岗位涉及算法团队搭建、研发计划制定、数据质量管理及客户验收协调，现主要负责公司战略、研发组织、核心算法与重大客户项目管理。"},
        {"person_name": "周岚", "role_title": "公司技术总监", "text": "公司技术总监周岚，浙江大学控制科学博士，曾在机器人平台企业任职并从事数字孪生、运动控制与仿真系统研发，参与工业机器人训练平台的架构设计、软件开发、现场测试和产品化交付，工程经历还包括控制系统联调、仿真环境部署、测试指标设计及现场问题处理，现主要负责公司机器人算法、仿真软件及工程验证工作。"},
        {"person_name": "王琪", "role_title": "公司产品负责人", "text": "公司产品负责人王琪，北京航空航天大学本科，曾在智能汽车公司从事产品规划和项目管理，参与车路协同、自动标注及数据平台项目，工作范围覆盖客户需求分析、产品定义、交付验收和商业化流程，过往项目还涉及产品文档编制、跨部门排期、上线验收和版本复盘，现主要负责公司产品规划、版本管理和客户项目协同。"},
        {"person_name": "赵宁", "role_title": "公司监事兼运营总监", "text": "公司监事兼运营总监赵宁，上海交通大学工商管理硕士，曾任科技企业运营负责人并主导融资、预算、供应链和大客户项目管理，参与人工智能项目的商务落地、组织建设和成果验收，经营管理经历还包括预算执行、合同管理、供应商协调、融资材料准备和内部流程建设，现主要负责公司日常运营、财务预算、供应链管理及商务交付协调。"},
    ]
    reasons = [
        "训练数据工具切入自动驾驶与具身智能的长尾场景需求。公司围绕自动驾驶和具身智能训练中的长尾场景、多模态及物理一致性数据需求，布局数据生成、交互采集和仿真训练工具，产品定位与模型开发效率提升相衔接。",
        "数据合成、触觉采集与仿真训练形成模型开发闭环。数据合成平台支持多模态输入、场景泛化和视角迁移，触觉交互设备补充真实采集能力，在研仿真平台承接策略训练，三条产品线覆盖数据获取、扩增与训练环节。",
        "团队兼具人工智能算法、机器人控制与产品交付能力。成员经历覆盖人工智能算法、自动驾驶项目、机器人控制、产品规划和商业运营，并具有从技术研发、工程验证到客户交付的实践，可支撑多学科产品协同开发。",
        "核心数据产品已形成合同、交付与收入验证。公司围绕核心数据产品签署并履行客户合同，形成可回溯的交付与收入记录，说明产品已从概念进入工程应用，并为平台迭代积累场景数据及客户反馈。",
        "股权增资结构与早期科技项目投资策略相衔接。历史融资、公司治理及本轮增资框架已有材料支撑，本次通过增资取得目标公司股权，资金投向研发、团队和市场拓展，与基金早期科技投资策略匹配。",
    ]
    reasons = [text + "现有业务、团队及交易资料能够形成相互印证的事实链，并可在投资决策材料中逐项回溯。" for text in reasons]
    return {
        "title": "关于测试项目投资合规性的说明",
        "target_company": {"legal_name": "测试科技有限公司", "source_ids": ["TEST"]},
        "delivery_readiness": ready_delivery(),
        "sections": [
            {
                "heading": "公司情况介绍",
                "blocks": [
                    {"type": "subheading", "text": "公司简介"},
                    {"type": "paragraph", "text": "测试科技有限公司成立于2024年，注册地位于浙江省，主要从事人工智能软件、训练数据处理、机器人控制系统及行业解决方案的研发与销售。公司围绕自动驾驶与具身智能模型训练建立产品体系，业务包括数据合成软件服务、触觉交互设备和机器人仿真训练平台，客户对象覆盖智能汽车、机器人及工业软件企业。公司采取核心技术自主研发与客户场景共同验证的研发方式，已建立研发、产品、市场和运营职能。", **sourced},
                    {"type": "subheading", "text": "核心团队"},
                    *[{"type": "paragraph", **member, **sourced} for member in team],
                    {"type": "subheading", "text": "产品及技术"},
                    {"type": "paragraph", "text": "数据合成产品面向自动驾驶和具身智能训练场景，支持图像、视频、点云及文本等多模态输入，提供场景泛化、视角迁移和多视角一致性生成。技术流程覆盖场景重建、生成模型约束、质量评测与交付管理，可补充真实采集中低频、危险或高成本场景的数据样本，并通过客户项目完成工程验证。交付流程还包括种子数据接收、任务配置、结果筛选、质量复核和客户验收，形成从输入到反馈的完整闭环。", **sourced},
                    {"type": "paragraph", "text": "触觉交互设备包括力反馈手套和遥操作组件，结合姿态测量、骨骼映射、触觉反馈及多源同步技术采集机器人操作数据；仿真训练平台仍处研发阶段，拟集成数字孪生、物理仿真和策略训练能力，为工业、家庭及医疗场景提供虚拟训练环境。两条产品线与数据合成平台形成真实采集、数据扩增到模型训练的递进关系，并分别对应真实操作采样、难例扩充和策略验证等模型开发环节，研发状态、目标场景及技术来源均在证据中分别记录。", **sourced},
                ],
            },
            {
                "heading": "投资理由",
                "blocks": [{"type": "numbered", "label": str(i), "text": text, **sourced} for i, text in enumerate(reasons, 1)],
            },
            {
                "heading": "投资计划",
                "blocks": [
                    {
                        "type": "paragraph",
                        "text": "本项目拟以股权增资方式参与目标公司本轮融资，拟投金额、投前估值、投后估值及新增注册资本以批准方案为基础，并将新股认购与可能涉及的老股受让分别列示和核算。交易完成后，基金直接持有目标公司股权，投后比例按完全摊薄口径测算，同时纳入员工期权池及本轮其他投资人的影响。",
                        **sourced,
                    },
                    {
                        "type": "paragraph",
                        "text": "投资款拟根据交割条件完成情况分期支付，首期在治理文件、工商变更及核心陈述保证满足后支付，后续款项与产品研发、团队到岗和客户交付等可核验里程碑衔接。治理安排覆盖董事会席位、重大事项知情与同意权、定期财务及经营信息报送、后续融资和股权转让保护，并明确违约与退出机制。",
                        **sourced,
                    },
                    {
                        "type": "paragraph",
                        "text": "资金用途原则上投向核心产品研发、算力与设备投入、关键人才引进、客户项目交付和日常运营，不用于基金协议或交易文件禁止的用途；交割前后由投资团队根据资金使用计划、预算执行和重大合同进展开展持续跟踪。",
                        **sourced,
                    },
                    {
                        "type": "paragraph",
                        "text": "最终投资主体、交易结构、持股比例及投资人权利，以基金合伙协议、投委会决议和正式交易文件为准。",
                        **sourced,
                    },
                ],
            },
            {
                "heading": "投资情形分析",
                "blocks": [
                    *[
                        {
                            "type": "numbered",
                            "label": str(index),
                            "text": text,
                            **sourced,
                        }
                        for index, text in enumerate(checks, start=1)
                    ],
                    {
                        "type": "conclusion",
                        "text": "综上，在完成必要尽调核验和投资决策程序的前提下，本项目原则上符合基金合规性要求。",
                        **sourced,
                    },
                ],
            },
        ],
        "public_verification": {
            "mode": "offline_user_requested",
            "record": "public_verification.json",
            "as_of_date": "2026-08-18",
            "sha256": "0" * 64,
            "validation_status": "pass",
            "coverage_status": "offline",
            "decision_impact": "not_verified",
        },
        "closing": {"company": "测试管理人", "date": "2026年8月18日"},
        "open_issues": ["完成必要核验。"],
    }


class TemplateFidelityTests(unittest.TestCase):
    def test_authoritative_sample_layout_and_fonts(self):
        self.assertEqual(
            MODULE.sha256(MODULE.DEFAULT_TEMPLATE),
            "5b51cda592736fc3b2bfc69bcc75875f5588496d47f7a6b6691b21daae8b115e",
        )
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            content_path = root / "content.json"
            public_path = root / "public_verification.json"
            docx_path = root / "result.docx"
            qa_path = root / "qa.json"
            public_record = {
                "schema_version": "1.0",
                "project": {
                    "name": "测试公司",
                    "unified_social_credit_code": "91330483MA00000000",
                },
                "as_of_date": "2026-08-18",
                "scope": {
                    "mode": "offline_user_requested",
                    "query_terms": ["测试公司"],
                    "excluded_sensitive_topics": ["投资金额", "基金协议"],
                    "sensitive_terms_excluded": True,
                    "coverage_status": "offline",
                },
                "entities": [
                    {
                        "entity_id": "target",
                        "name": "测试公司",
                        "role": "primary_target",
                        "entity_type": "company",
                        "identifiers": {
                            "unified_social_credit_code": "91330483MA00000000"
                        },
                        "identity_status": "matched",
                        "match_basis": ["fixture name", "fixture USCC"],
                    }
                ],
                "checks": [],
                "limitations": ["Template fixture deliberately runs offline."],
                "conflicts": [],
                "summary": {
                    "validation_status": "pass",
                    "coverage_status": "offline",
                    "unresolved_material_conflicts": 0,
                    "decision_impact": "not_verified",
                },
            }
            public_path.write_text(
                json.dumps(public_record, ensure_ascii=False), encoding="utf-8"
            )
            content = fixture_content()
            content["public_verification"]["sha256"] = MODULE.sha256(public_path)
            content_path.write_text(
                json.dumps(content, ensure_ascii=False), encoding="utf-8"
            )
            self.assertEqual(
                MODULE.build_command(
                    argparse.Namespace(
                        content=str(content_path),
                        output=str(docx_path),
                        template=str(MODULE.DEFAULT_TEMPLATE),
                    )
                ),
                0,
            )
            self.assertEqual(
                MODULE.verify_command(
                    argparse.Namespace(
                        content=str(content_path),
                        docx=str(docx_path),
                        out=str(qa_path),
                        template=str(MODULE.DEFAULT_TEMPLATE),
                    )
                ),
                0,
            )
            self.assertTrue(json.loads(qa_path.read_text(encoding="utf-8"))["pass"])

            with zipfile.ZipFile(docx_path) as archive:
                xml = ET.fromstring(archive.read("word/document.xml"))
                names = set(archive.namelist())
                self.assertNotIn("docProps/app.xml", names)
                self.assertNotIn("docProps/custom.xml", names)
                core = ET.fromstring(archive.read("docProps/core.xml"))
                core_values = {child.tag: child.text for child in list(core)}
                self.assertEqual(
                    core_values[MODULE.DC + "title"], content["title"]
                )
                self.assertEqual(
                    core_values[MODULE.DC + "subject"], content["title"]
                )
                self.assertEqual(
                    core_values[MODULE.DC + "creator"], content["closing"]["company"]
                )
                self.assertEqual(
                    core_values[MODULE.CP + "lastModifiedBy"],
                    content["closing"]["company"],
                )
                self.assertEqual(
                    core_values[MODULE.DCTERMS + "created"],
                    "2026-08-18T00:00:00Z",
                )
                self.assertEqual(
                    core_values[MODULE.DCTERMS + "modified"],
                    "2026-08-18T00:00:00Z",
                )
            section = xml.find(".//w:sectPr", MODULE.NS)
            margins = section.find("w:pgMar", MODULE.NS)
            self.assertEqual(
                {key: margins.get(MODULE.W + key) for key in ("top", "bottom", "left", "right")},
                {"top": "1440", "bottom": "1440", "left": "1800", "right": "1800"},
            )

            visible = [MODULE.paragraph_text(p) for p in xml.findall(".//w:body/w:p", MODULE.NS)]
            self.assertEqual(
                [visible[index + 1] for index, text in enumerate(visible[:-1]) if not text],
                ["投资情形分析", "测试管理人"],
            )
            self.assertIn("2026年   8   月   18   日", visible)

            runs = MODULE.direct_run_properties(docx_path)
            self.assertTrue(all(row["half_points"] == (28 if row["paragraph"] == 0 else 24) for row in runs))
            self.assertTrue(
                all(
                    row["ascii_font"]
                    == row["hansi_font"]
                    == row["east_asia_font"]
                    == ("黑体" if row["paragraph"] == 0 else "宋体")
                    for row in runs
                )
            )
            self.assertTrue(next(row for row in runs if row["text"] == "公司简介")["bold"])
            self.assertTrue(next(row for row in runs if row["text"] == "1、训练数据工具切入自动驾驶与具身智能的长尾场景需求。")["bold"])
            self.assertFalse(next(row for row in runs if row["text"].startswith("公司围绕自动驾驶和具身智能训练中的长尾场景"))["bold"])

    def test_stale_template_metadata_is_rejected(self):
        errors, metrics = MODULE.metadata_contract_findings(
            MODULE.DEFAULT_TEMPLATE, fixture_content()
        )
        self.assertTrue(errors)
        self.assertEqual(metrics["status"], "fail")
        self.assertTrue(
            any("forbidden template metadata parts" in error for error in errors),
            errors,
        )

    def test_verify_missing_docx_writes_structured_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            content_path = root / "content.json"
            qa_path = root / "qa.json"
            content_path.write_text(
                json.dumps(fixture_content(), ensure_ascii=False), encoding="utf-8"
            )
            result = MODULE.verify_command(
                argparse.Namespace(
                    content=str(content_path),
                    docx=str(root / "missing.docx"),
                    out=str(qa_path),
                    template=str(MODULE.DEFAULT_TEMPLATE),
                )
            )
            self.assertEqual(result, 2)
            qa = json.loads(qa_path.read_text(encoding="utf-8"))
            self.assertFalse(qa["pass"])
            self.assertEqual(qa["visual_qa"], "not_run_missing_docx")
            self.assertTrue(any("DOCX not found" in error for error in qa["errors"]), qa)


if __name__ == "__main__":
    unittest.main()
