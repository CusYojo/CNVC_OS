import copy
import importlib.util
import tempfile
import unittest
from pathlib import Path


PROCESSOR = Path(__file__).resolve().parents[1] / "scripts" / "compliance_processor.py"
SPEC = importlib.util.spec_from_file_location("compliance_processor", PROCESSOR)
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


def available_materials_delivery():
    requested_items = [
        "适用基金协议条款",
        "确定版交易金额、估值及投后持股比例",
        "返投和集中度测算",
        "完整关联关系核查表",
    ]
    return {
        "status": "proceed_with_available_materials",
        "as_of_date": "2026-08-18",
        "blocking_issues": [],
        "missing_decisive_inputs": requested_items,
        "supplement_request": {
            "requested": True,
            "outcome": "not_provided",
            "requested_items": requested_items,
        },
        "continuation_authorization": {
            "authorized": True,
            "basis": "explicit_user_instruction",
            "instruction": "请按现有材料继续制作正式稿。",
        },
        "fund_agreement": {"status": "pending", "source_ids": []},
        "transaction_terms": {"status": "pending", "source_ids": []},
        "return_investment": {"status": "pending", "source_ids": []},
        "concentration": {"status": "pending", "source_ids": []},
        "related_party": {"status": "pending", "source_ids": []},
    }


def awaiting_user_input_delivery():
    delivery = available_materials_delivery()
    delivery["status"] = "awaiting_user_input"
    delivery["supplement_request"]["outcome"] = "awaiting_response"
    delivery["continuation_authorization"] = {
        "authorized": False,
        "basis": "awaiting_response",
    }
    return delivery


def valid_content():
    checks = [
        "符合基金投资限制要求：本项目采用股权投资方式取得目标公司新增注册资本，不属于基金协议禁止的借贷、担保、房地产开发或二级市场证券投资，交易类型与基金可投方式一致。",
        "不会导致基金返投要求难以完成：本次投资完成后，基金按最新实缴规模、已认定返投金额和可投资余额复核，仍保留覆盖剩余返投义务的资金空间，返投测算口径完整。",
        "不涉及关联交易：现有股权结构、董事监事高级管理人员名单及关联关系核查表未显示目标公司或交易对方与基金、管理人构成关联关系，审阅范围覆盖本次交易主要参与方。",
        "符合基金投资方向要求：项目主营人工智能训练数据、机器人感知与仿真工具，产品服务于自动驾驶和具身智能研发，属于基金协议约定的新一代信息技术与智能制造方向。",
        "符合基金投资配置要求：项目按基金直接股权投资方案实施，交易工具、投资层级及投后权益均纳入基金直投配置统计，未设置改变风险性质的复杂嵌套载体。",
        "符合基金投资集中度要求：将本次拟投金额计入单一项目投资余额后，占基金最新实缴规模的比例未超过协议上限，并已按同一主体及其关联项目合并计算投资敞口。",
        "未发现其他明显违法违规情形：现有主体资格、经营范围、诉讼执行、行政处罚及业务合规材料未显示足以禁止本次投资的重大违法事项，公开核验与内部尽调结论未见实质冲突。",
    ]
    checks = [text + "本项判断已列明审阅范围、计算口径、资料基准日及投资完成后的影响，相关依据均可回溯至测试证据。" for text in checks]
    sourced = {"source_ids": ["TEST"], "status": "verified"}
    team = [
        {"person_name": "李明", "role_title": "公司创始人兼总经理", "text": "公司创始人兼总经理李明，清华大学计算机科学硕士，曾任自动驾驶企业算法负责人，长期从事感知算法、训练数据闭环和研发团队管理，主导多项人工智能项目从原型开发、工程验证到客户交付，历任岗位涉及算法团队搭建、研发计划制定、数据质量管理及客户验收协调，现主要负责公司战略、研发组织、核心算法与重大客户项目管理。"},
        {"person_name": "周岚", "role_title": "公司技术总监", "text": "公司技术总监周岚，浙江大学控制科学博士，曾在机器人平台企业任职并从事数字孪生、运动控制与仿真系统研发，参与工业机器人训练平台的架构设计、软件开发、现场测试和产品化交付，工程经历还包括控制系统联调、仿真环境部署、测试指标设计及现场问题处理，现主要负责公司机器人算法、仿真软件及工程验证工作。"},
        {"person_name": "王琪", "role_title": "公司产品负责人", "text": "公司产品负责人王琪，北京航空航天大学本科，曾在智能汽车公司从事产品规划和项目管理，参与车路协同、自动标注和数据平台项目，工作范围覆盖客户需求分析、产品定义、交付验收及商业化流程，过往项目还涉及产品文档编制、跨部门排期、上线验收和版本复盘，现主要负责公司产品规划、版本管理和客户项目协同。"},
        {"person_name": "赵宁", "role_title": "公司监事兼运营总监", "text": "公司监事兼运营总监赵宁，上海交通大学工商管理硕士，曾任科技企业运营负责人并主导融资、预算、供应链及大客户项目管理，参与多项人工智能项目的商务落地、组织建设和成果验收，经营管理经历还包括预算执行、合同管理、供应商协调、融资材料准备和内部流程建设，现主要负责公司日常运营、财务预算、供应链管理及商务交付协调。"},
    ]
    reasons = [
        "训练数据工具切入自动驾驶与具身智能的长尾场景需求。公司围绕自动驾驶和具身智能训练中的长尾场景数据、多模态数据及物理一致性需求，布局数据生成、交互采集和仿真训练工具，产品定位与模型开发效率提升的需求相衔接。",
        "数据合成、触觉采集与仿真训练形成模型开发闭环。现有数据合成平台支持多模态输入、场景泛化和视角迁移，触觉交互设备补充真实采集能力，在研仿真平台承接策略训练，三条产品线共同覆盖数据获取、扩增与训练环节。",
        "团队兼具人工智能算法、机器人控制与产品交付能力。成员经历覆盖人工智能算法、自动驾驶项目、机器人控制、产品规划及商业运营，并具有从技术研发、工程验证到客户交付的实践，可支撑多学科产品的协同开发和产业化。",
        "核心数据产品已形成合同、交付与收入验证。公司已围绕核心数据产品签署并履行客户合同，形成可回溯的交付和收入记录，说明产品不再仅停留于概念设计，并为后续平台能力迭代积累真实场景与客户反馈。",
        "股权增资结构与早期科技项目投资策略相衔接。历史融资、公司治理及本轮增资框架已有材料支撑，本次拟通过增资取得目标公司股权，资金主要用于产品研发、团队建设和市场拓展，与基金的早期科技项目投资策略相匹配。",
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
                    {"type": "paragraph", "text": "测试科技有限公司成立于2024年，注册地位于浙江省，主要从事人工智能软件、训练数据处理、机器人控制系统及行业解决方案的研发与销售。公司围绕自动驾驶与具身智能模型训练建立产品体系，现有业务包括数据合成软件服务、触觉交互设备和机器人仿真训练平台，客户对象覆盖智能汽车、机器人及工业软件企业。公司采取核心技术自主研发与客户场景共同验证的研发方式，已建立研发、产品、市场和运营职能。", **sourced},
                    {"type": "subheading", "text": "核心团队"},
                    *[{"type": "paragraph", **member, **sourced} for member in team],
                    {"type": "subheading", "text": "产品及技术"},
                    {"type": "paragraph", "text": "数据合成产品面向自动驾驶和具身智能训练场景，支持图像、视频、点云及文本等多模态数据输入，并提供场景泛化、视角迁移和多视角一致性生成能力。其技术流程覆盖场景重建、生成模型约束、质量评测与交付管理，可用于补充真实采集中低频、危险或高成本场景的数据样本，并通过客户项目完成工程验证。交付流程还包括种子数据接收、任务配置、结果筛选、质量复核和客户验收，形成从输入到反馈的完整闭环。", **sourced},
                    {"type": "paragraph", "text": "触觉交互设备包括力反馈手套和遥操作组件，结合姿态测量、骨骼映射、触觉反馈与多源同步技术采集机器人操作数据；仿真训练平台仍处研发阶段，拟集成数字孪生、物理仿真和策略训练能力，为工业、家庭及医疗场景提供虚拟训练环境。两条产品线与数据合成平台形成从真实采集、数据扩增到模型训练的递进关系，并分别对应真实操作采样、难例扩充和策略验证等模型开发环节，研发状态、目标场景及技术来源均在证据中分别记录。", **sourced},
                ],
            },
            {
                "heading": "投资理由",
                "blocks": [{"type": "numbered", "label": str(i), "text": text, **sourced} for i, text in enumerate(reasons, 1)],
            },
            {
                "heading": "投资计划",
                "blocks": [
                    {"type": "paragraph", "text": "本项目拟以股权增资方式参与目标公司本轮融资，拟投金额、投前估值、投后估值及新增注册资本以经批准的投资方案为基础，并将新股认购与可能涉及的老股受让分别列示和核算。交易完成后，基金直接持有目标公司股权，投后比例按完全摊薄口径测算，同时纳入员工期权池及本轮其他投资人的影响。", **sourced},
                    {"type": "paragraph", "text": "投资款拟根据交割条件完成情况分期支付，首期在公司治理文件、工商变更及核心陈述保证满足后支付，后续款项与产品研发、团队到岗和客户交付等可核验里程碑衔接。治理安排拟覆盖股东会或董事会席位、重大事项知情与同意权、定期财务及经营信息报送、后续融资和股权转让保护，并在交易文件中明确违约与退出机制。", **sourced},
                    {"type": "paragraph", "text": "资金用途原则上投向核心产品研发、算力与设备投入、关键人才引进、客户项目交付和日常运营，不用于基金协议或交易文件禁止的用途；交割前后由投资团队根据资金使用计划、预算执行和重大合同进展开展持续跟踪。", **sourced},
                    {"type": "paragraph", "text": "最终投资主体、交易结构、持股比例及投资人权利，以基金合伙协议、投委会决议和正式交易文件为准。", **sourced},
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


class SemanticGateTests(unittest.TestCase):
    def test_conditional_affirmative_conclusion_is_accepted(self):
        self.assertEqual(MODULE.validate_content(valid_content()), [])

    def test_no_conclusion_statement_is_rejected(self):
        content = valid_content()
        content["sections"][3]["blocks"][-1]["text"] = (
            "综上，在补齐资料前，暂无法对本项目形成最终投资合规结论。"
        )
        errors = MODULE.validate_content(content)
        self.assertTrue(any("原则上符合" in error for error in errors), errors)

    def test_indecisive_compliance_lead_is_rejected(self):
        content = valid_content()
        content["sections"][3]["blocks"][5]["text"] = (
            "投资集中度不能计算：本次投资金额及基金规模未提供。"
        )
        errors = MODULE.validate_content(content)
        self.assertTrue(any("indecisive leads" in error for error in errors), errors)

    def test_affirmative_lead_cannot_hide_audit_process_language(self):
        variants = [
            (0, "符合基金投资限制要求：本项目拟采用股权投资方式，但本次投资主体尚未确定，交易限制事项尚需后续核查。"),
            (3, "符合基金投资方向要求：项目主营人工智能训练数据，应结合适用基金协议逐项判断是否落入约定投资领域。"),
            (2, "不涉及关联交易：现有材料未显示明确关联关系；补充交易各方名单并核查后，方可确定本次交易是否构成关联交易。"),
            (1, "不会导致基金返投要求难以完成：返投基数和已完成金额待补充，相关数据仍需完成投资后测算。"),
            (4, "符合基金投资配置要求：本项目拟采用股权投资方式，最终交易路径应核对后再判断是否符合配置比例。"),
            (5, "符合基金投资集中度要求：基金规模与拟投金额待明确，当前不宜作出符合性结论。"),
            (6, "未发现其他明显违法违规情形：现有材料未显示禁止性障碍，最终仍应核实相关事项。"),
        ]
        for item, text in variants:
            with self.subTest(item=item, text=text):
                content = valid_content()
                content["sections"][3]["blocks"][item]["text"] = text
                errors = MODULE.validate_content(content)
                self.assertTrue(
                    any("audit-process language" in error or "unfinished audit" in error for error in errors),
                    errors,
                )

    def test_concrete_result_specific_conditions_remain_allowed(self):
        content = valid_content()
        content["sections"][3]["blocks"][0]["text"] += (
            "老股受让部分以基金合伙协议允许为前提。"
        )
        content["sections"][3]["blocks"][2]["text"] += (
            "最终以关联关系核查表、投资决策文件及交易文件披露为准。"
        )
        self.assertEqual(MODULE.validate_content(content), [])

    def test_explicit_uninvolved_lead_is_accepted(self):
        content = valid_content()
        content["sections"][3]["blocks"][0]["text"] = (
            "未涉及基金约定的投资限制事项：本项目采用现金增资方式取得目标公司股权，"
            "不涉及借贷、委托贷款、对外担保、房地产开发或二级市场证券交易，交易工具"
            "和实施路径均属于基金协议允许的股权投资范围，投资完成后形成直接股权权益。"
        )
        self.assertEqual(MODULE.validate_content(content), [])

    def test_investment_reason_titles_must_be_specific(self):
        content = valid_content()
        broad_titles = [
            "技术方向与产业需求匹配",
            "产品与技术形成递进组合",
            "核心团队能力与产品路线对应",
            "商业化已进入客户交付验证阶段",
            "产业落地与股权融资基础已经形成",
        ]
        for block, title in zip(content["sections"][1]["blocks"], broad_titles):
            _, body = block["text"].split("。", 1)
            block["text"] = f"{title}。{body}"
        errors = MODULE.validate_content(content)
        self.assertTrue(any("project-specific investment thesis" in error for error in errors), errors)

    def test_investment_scenario_analysis_role_map_is_enforced(self):
        content = valid_content()
        content["sections"][3]["blocks"][0]["text"] = (
            "符合基金股权投资方式要求：本项目拟通过增资取得目标公司股权，"
            "交易完成后形成直接股权权益，并纳入基金直投项目管理和投后管理范围。"
            "本项判断已列明本次交易对象、实施形式、资料基准日及投资完成后的影响。"
        )
        errors = MODULE.validate_content(content)
        self.assertTrue(any("standard role map" in error for error in errors), errors)

    def test_all_pending_statuses_do_not_bypass_semantics(self):
        content = valid_content()
        for block in content["sections"][3]["blocks"]:
            block["status"] = "pending"
        content["sections"][3]["blocks"][0]["text"] = (
            "投资限制尚待确认：基金合伙协议未提供。"
        )
        self.assertTrue(MODULE.validate_content(copy.deepcopy(content)))

    def test_public_verification_binding_is_required(self):
        content = valid_content()
        del content["public_verification"]
        errors = MODULE.validate_content(content)
        self.assertTrue(any("public_verification binding" in error for error in errors), errors)

    def test_delivery_readiness_is_required(self):
        content = valid_content()
        del content["delivery_readiness"]
        errors = MODULE.validate_content(content)
        self.assertTrue(any("delivery_readiness is required" in error for error in errors), errors)

    def test_awaiting_user_input_blocks_authoring_and_build(self):
        content = valid_content()
        content["delivery_readiness"] = awaiting_user_input_delivery()
        errors = MODULE.validate_content(content)
        self.assertTrue(any("awaiting user input" in error for error in errors), errors)

    def test_incomplete_materials_without_explicit_authorization_are_rejected(self):
        content = valid_content()
        content["delivery_readiness"] = available_materials_delivery()
        content["delivery_readiness"]["continuation_authorization"] = {
            "authorized": False,
            "basis": "awaiting_response",
        }
        errors = MODULE.validate_content(content)
        self.assertTrue(any("explicit user authorization" in error for error in errors), errors)

    def test_affirmative_pending_checks_are_allowed_after_explicit_authorization(self):
        content = valid_content()
        content["delivery_readiness"] = available_materials_delivery()
        for block in content["sections"][3]["blocks"][:7]:
            block["status"] = "pending"
        errors = MODULE.validate_content(content)
        self.assertEqual(errors, [])
        findings = MODULE.delivery_readiness_findings(content)
        self.assertEqual(findings["status"], "pass")
        self.assertTrue(findings["warnings"])

    def test_missing_return_investment_inputs_warn_when_user_does_not_supplement(self):
        content = valid_content()
        content["delivery_readiness"] = available_materials_delivery()
        errors = MODULE.validate_content(content)
        self.assertEqual(errors, [])
        findings = MODULE.delivery_readiness_findings(content)
        self.assertTrue(
            any("return_investment" in warning for warning in findings["warnings"]),
            findings,
        )

    def test_explicit_material_conflict_still_blocks_build(self):
        content = valid_content()
        content["delivery_readiness"] = available_materials_delivery()
        content["delivery_readiness"]["status"] = "blocked"
        content["delivery_readiness"]["continuation_authorization"] = {
            "authorized": False,
            "basis": "not_required",
        }
        content["delivery_readiness"]["blocking_issues"] = [
            "投前估值在已签署文件之间存在未解决的重大冲突"
        ]
        errors = MODULE.validate_content(content)
        self.assertTrue(any("hard-stop" in error for error in errors), errors)
        self.assertTrue(any("material conflicts" in error for error in errors), errors)

    def test_concentration_arithmetic_must_reconcile(self):
        content = valid_content()
        content["delivery_readiness"]["concentration"]["calculation"]["post_investment_ratio"] = 0.19
        errors = MODULE.validate_content(content)
        self.assertTrue(any("post_investment_ratio does not reconcile" in error for error in errors), errors)

    def test_transaction_amount_must_match_concentration_proposed_amount(self):
        content = valid_content()
        content["delivery_readiness"]["concentration"]["calculation"]["proposed_amount"] = 2000
        content["delivery_readiness"]["concentration"]["calculation"]["post_investment_ratio"] = 0.04
        content["delivery_readiness"]["concentration"]["calculation"]["headroom"] = 8000
        errors = MODULE.validate_content(content)
        self.assertTrue(any("investment_amount does not reconcile" in error for error in errors), errors)

    def test_invalid_readiness_date_and_numeric_placeholders_are_rejected(self):
        content = valid_content()
        content["delivery_readiness"]["as_of_date"] = "2026-02-30"
        content["delivery_readiness"]["transaction_terms"]["terms"]["investment_amount"] = "待定"
        errors = MODULE.validate_content(content)
        self.assertTrue(any("as_of_date must be YYYY-MM-DD" in error for error in errors), errors)
        self.assertTrue(any("investment_amount is not a positive number" in error for error in errors), errors)

    def test_public_verification_sha_mismatch_is_rejected(self):
        content = valid_content()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            record = root / "public_verification.json"
            record.write_text("{}", encoding="utf-8")
            errors, metrics = MODULE.validate_public_binding(content, root / "content.json")
        self.assertTrue(any("SHA-256 mismatch" in error for error in errors), errors)
        self.assertIn("sha256", metrics)

    def test_company_profile_rejects_ownership_ratio_leakage(self):
        content = valid_content()
        content["sections"][0]["blocks"][1]["text"] += (
            "创始股东直接持股51%，并通过员工持股平台控制20%的表决权。"
        )
        errors = MODULE.validate_content(content)
        self.assertTrue(any("ownership/cap-table" in error for error in errors), errors)

    def test_company_profile_must_begin_with_target_full_legal_name(self):
        content = valid_content()
        content["sections"][0]["blocks"][1]["text"] = content["sections"][0]["blocks"][1]["text"].replace(
            "测试科技有限公司", "测试公司", 1
        )
        errors = MODULE.validate_content(content)
        self.assertTrue(any("must begin with target_company.legal_name" in error for error in errors), errors)

    def test_target_company_legal_name_is_required(self):
        content = valid_content()
        del content["target_company"]
        errors = MODULE.validate_content(content)
        self.assertTrue(any("target_company.legal_name is required" in error for error in errors), errors)

    def test_target_full_legal_name_is_allowed_in_company_profile_opening(self):
        content = valid_content()
        errors = MODULE.validate_content(content)
        self.assertEqual(errors, [])
        findings = MODULE.content_completeness_findings(content)
        self.assertEqual(findings["metrics"]["company_profile_legal_name_status"], "pass")
        self.assertEqual(findings["metrics"]["visible_issuer_name_hits"], [])

    def test_company_profile_rejects_licence_identifier(self):
        content = valid_content()
        content["sections"][0]["blocks"][1]["text"] += (
            "统一社会信用代码为91330483MAEL1DXF5N。"
        )
        errors = MODULE.validate_content(content)
        self.assertTrue(any("licence/registry identifiers" in error for error in errors), errors)

    def test_company_profile_rejects_legal_representative(self):
        content = valid_content()
        content["sections"][0]["blocks"][1]["text"] += "公司法定代表人为李明。"
        errors = MODULE.validate_content(content)
        self.assertTrue(any("business-first" in error for error in errors), errors)

    def test_company_profile_rejects_routine_capital_registration_fields(self):
        variants = ["注册资本为1,000万元。", "实缴资本为500万元。", "认缴资本为1,000万元。"]
        for text in variants:
            with self.subTest(text=text):
                content = valid_content()
                content["sections"][0]["blocks"][1]["text"] += text
                errors = MODULE.validate_content(content)
                self.assertTrue(any("business-first" in error for error in errors), errors)

    def test_company_profile_rejects_financial_due_diligence_issue(self):
        content = valid_content()
        content["sections"][0]["blocks"][1]["text"] += (
            "其中部分合同存在开票确认与实际交付验收的时点差异。"
        )
        errors = MODULE.validate_content(content)
        self.assertTrue(any("financial due-diligence findings" in error for error in errors), errors)

    def test_company_profile_rejects_exact_financial_metrics_by_default(self):
        content = valid_content()
        content["sections"][0]["blocks"][1]["text"] += (
            "2025年度账面营业收入1,302.83万元、净利润48.87万元。"
        )
        errors = MODULE.validate_content(content)
        self.assertTrue(any("exact financial metrics" in error for error in errors), errors)

    def test_company_profile_allows_stage_level_commercial_wording(self):
        content = valid_content()
        content["sections"][0]["blocks"][1]["text"] += (
            "公司已通过合成数据项目形成初步商业化收入，总体处于产品验证、团队扩张和持续研发投入阶段。"
        )
        errors = MODULE.validate_content(content)
        self.assertFalse(any("financial" in error for error in errors), errors)

    def test_company_profile_allows_audited_metrics_when_user_requests_them(self):
        content = valid_content()
        content["sections"][0]["blocks"][1]["text"] += (
            "2025年度经审计营业收入1,302.83万元、净利润48.87万元。"
        )
        content["company_profile_financial_disclosure"] = {
            "allowed": True,
            "user_requested": True,
            "basis": "audited",
            "no_material_conflict": True,
            "source_ids": ["AUDITED-FINANCIALS-2025"],
        }
        errors = MODULE.validate_content(content)
        self.assertFalse(any("exact financial metrics" in error for error in errors), errors)
        self.assertFalse(any("company_profile_financial_disclosure is invalid" in error for error in errors), errors)

    def test_financial_dd_issue_is_rejected_even_with_metric_exception(self):
        content = valid_content()
        content["sections"][0]["blocks"][1]["text"] += (
            "2025年度经审计营业收入1,302.83万元，其中部分合同存在开票与验收时点差异。"
        )
        content["company_profile_financial_disclosure"] = {
            "allowed": True,
            "user_requested": True,
            "basis": "special_audit",
            "no_material_conflict": True,
            "source_ids": ["SPECIAL-AUDIT-2025"],
        }
        errors = MODULE.validate_content(content)
        self.assertTrue(any("financial due-diligence findings" in error for error in errors), errors)

    def test_team_rejects_name_before_title(self):
        content = valid_content()
        member = content["sections"][0]["blocks"][3]
        member["text"] = member["text"].replace(
            "公司创始人兼总经理李明，",
            "李明，公司创始人兼总经理，",
            1,
        )
        errors = MODULE.validate_content(content)
        self.assertTrue(any("title before person name" in error for error in errors), errors)

    def test_team_requires_role_and_person_metadata(self):
        content = valid_content()
        del content["sections"][0]["blocks"][3]["role_title"]
        errors = MODULE.validate_content(content)
        self.assertTrue(any("role_title/person_name" in error for error in errors), errors)

    def test_team_allows_title_before_english_name(self):
        content = valid_content()
        member = content["sections"][0]["blocks"][3]
        member.update({
            "role_title": "公司拟任首席科学家",
            "person_name": "Abdulmotaleb El Saddik",
            "text": (
                "公司拟任首席科学家Abdulmotaleb El Saddik，加拿大渥太华大学工程学院教授，"
                "长期从事人工智能、触觉交互与数字孪生研究，曾主导多项机器人感知和人机交互项目，"
                "研究成果覆盖多媒体通信、触觉互联网、智能系统与科研成果工程化，并具有国际团队"
                "和跨学科项目组织经历；拟任安排为首席科学家，具体任职及服务方式以正式协议为准。"
            ),
        })
        self.assertEqual(MODULE.validate_content(content), [])

    def test_team_rejects_inferred_project_benefit_or_company_fit_tails(self):
        variants = [
            "上述训练和产业经历使其能够统筹空间重建与商业交付。",
            "其能力可支持公司由技术研发向规模化交付转化。",
            "其算法研发经历能够为合成数据平台、感知算法工具链及研发团队协作提供工程化支持。",
            "其产业资源整合经验可连接公司的产品与客户需求。",
            "其科研网络可为公司提供技术指导和合作资源。",
            "其相关经验有助于公司推进产品工程化。",
            "其专业积累将补强公司的技术统筹能力。",
            "其模式识别背景与公司产品路线具有直接对应关系。",
        ]
        for text in variants:
            with self.subTest(text=text):
                content = valid_content()
                content["sections"][0]["blocks"][3]["text"] += text
                errors = MODULE.validate_content(content)
                self.assertTrue(
                    any("project-benefit" in error or "company-fit" in error for error in errors),
                    errors,
                )

    def test_team_allows_documented_current_responsibility(self):
        content = valid_content()
        content["sections"][0]["blocks"][3]["text"] += (
            "其目前主要负责公司数据平台、算法研发和客户项目管理。"
        )
        self.assertEqual(MODULE.validate_content(content), [])

    def test_collective_team_value_remains_allowed_in_investment_reasons(self):
        content = valid_content()
        content["sections"][1]["blocks"][2]["text"] += (
            "团队的专业结构可支持公司推进多学科产品协同开发。"
        )
        self.assertEqual(MODULE.validate_content(content), [])

    def test_team_rejects_evidence_acquisition_meta_language(self):
        content = valid_content()
        content["sections"][0]["blocks"][4]["text"] += (
            "公司资料记载其为拟任负责人，当前按拟任状态表述。"
        )
        errors = MODULE.validate_content(content)
        self.assertTrue(any("evidence-acquisition meta-language" in error for error in errors), errors)

    def test_product_rejects_evidence_acquisition_meta_language(self):
        content = valid_content()
        content["sections"][0]["blocks"][-2]["text"] += "相关材料记载该技术路线。"
        errors = MODULE.validate_content(content)
        self.assertTrue(any("evidence-acquisition meta-language" in error for error in errors), errors)

    def test_attachment_reference_in_investment_plan_is_rejected(self):
        content = valid_content()
        content["sections"][2]["blocks"][0]["text"] += (
            "根据2026年8月3日《投资意向书（V2）》所列框架，我方拟实施本次投资。"
        )
        errors = MODULE.validate_content(content)
        self.assertTrue(any("attachment filenames" in error for error in errors), errors)

    def test_formal_law_title_and_compliance_review_perimeter_remain_allowed(self):
        content = valid_content()
        content["sections"][2]["blocks"][0]["text"] += (
            "相关治理安排应符合《中华人民共和国公司法》的适用要求。"
        )
        content["sections"][3]["blocks"][6]["text"] += (
            "根据现有法律尽调审阅范围，本项判断覆盖主体资格及业务合规事项。"
        )
        errors = MODULE.validate_content(content)
        self.assertFalse(any("attachment filenames" in error for error in errors), errors)
        self.assertFalse(any("evidence-acquisition meta-language" in error for error in errors), errors)

    def test_source_ids_do_not_leak_into_visible_prose(self):
        content = valid_content()
        content["sections"][2]["blocks"][0]["source_ids"] = ["TERM-SHEET-V2-20260803"]
        self.assertEqual(MODULE.validate_content(content), [])

    def test_operational_condition_wording_is_not_source_narration(self):
        content = valid_content()
        content["sections"][2]["blocks"][1]["text"] += (
            "我方将根据交割条件完成情况安排付款。"
        )
        self.assertEqual(MODULE.validate_content(content), [])

    def test_full_issuer_name_is_rejected_in_investment_plan(self):
        content = valid_content()
        content["sections"][2]["blocks"][0]["text"] += (
            "测试管理人拟以指定基金主体实施本次投资。"
        )
        errors = MODULE.validate_content(content)
        self.assertTrue(any("full issuer/manager company name" in error for error in errors), errors)

    def test_full_issuer_name_is_rejected_in_compliance_analysis(self):
        content = valid_content()
        content["sections"][3]["blocks"][4]["text"] += (
            "本次方案由测试管理人实施。"
        )
        errors = MODULE.validate_content(content)
        self.assertTrue(any("full issuer/manager company name" in error for error in errors), errors)

    def test_internal_role_terms_are_allowed(self):
        content = valid_content()
        content["sections"][2]["blocks"][0]["text"] += (
            "我方拟通过指定基金主体实施本次投资，本基金承担最终实际投资金额及风险敞口。"
        )
        self.assertEqual(MODULE.validate_content(content), [])

    def test_thin_team_is_reported_without_blocking(self):
        content = valid_content()
        company_blocks = content["sections"][0]["blocks"]
        product_index = next(
            index for index, block in enumerate(company_blocks)
            if block.get("type") == "subheading" and block.get("text") == "产品及技术"
        )
        company_blocks[3:product_index] = company_blocks[3:4]
        errors = MODULE.validate_content(content)
        self.assertEqual(errors, [])
        findings = MODULE.content_completeness_findings(content)
        self.assertTrue(
            any("核心团队 requires at least" in warning for warning in findings["warnings"]),
            findings,
        )

    def test_rich_content_reports_pass_metrics(self):
        findings = MODULE.content_completeness_findings(valid_content())
        self.assertEqual(findings["status"], "pass")
        self.assertGreaterEqual(findings["metrics"]["team_member_paragraphs"], 4)
        self.assertEqual(findings["metrics"]["team_title_before_name_status"], "pass")
        self.assertEqual(findings["metrics"]["team_title_before_name_issues"], [])
        self.assertEqual(findings["metrics"]["team_objective_prose_status"], "pass")
        self.assertEqual(findings["metrics"]["team_evaluative_benefit_hits"], [])
        self.assertEqual(findings["metrics"]["company_profile_ownership_hits"], [])
        self.assertEqual(findings["metrics"]["company_profile_routine_registry_hits"], [])
        self.assertEqual(findings["metrics"]["company_profile_financial_dd_hits"], [])
        self.assertEqual(findings["metrics"]["company_profile_financial_metric_hits"], [])
        self.assertEqual(findings["metrics"]["visible_source_narration_hits"], [])
        self.assertEqual(findings["metrics"]["visible_issuer_name_hits"], [])


if __name__ == "__main__":
    unittest.main()
