import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'workspace/.agents/skills/generate-investment-compliance-note/scripts/compliance_processor.py'
spec = importlib.util.spec_from_file_location('compliance_processor', SCRIPT)
processor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(processor)


class ComplianceRulesTest(unittest.TestCase):
    def authorized_content(self):
        content = self.content(7)
        content['delivery_readiness'] = {
            'status': 'proceed_with_available_materials', 'as_of_date': '2026-09-07',
            'blocking_issues': [], 'missing_decisive_inputs': ['基金协议'],
            'supplement_request': {'requested': True, 'outcome': 'declined', 'requested_items': ['基金协议']},
            'continuation_authorization': {'authorized': True, 'basis': 'explicit_user_instruction', 'instruction': '合成测试：继续生成'},
        }
        return content

    def content(self, count):
        return {'sections': [
            {'heading': heading, 'blocks': [
                {'type': 'numbered', 'text': '合成核查内容。', 'status': 'pending'}
                for _ in range(count)
            ] if heading == '投资情形分析' else []}
            for heading in processor.REQUIRED_SECTIONS
        ], 'closing': {'company': '合成机构', 'date': '2026年9月7日'}}

    def test_requires_exactly_seven_checks(self):
        for count in (6, 8):
            with self.subTest(count=count):
                errors = processor.validate_content(self.content(count))
                self.assertTrue(any('requires exactly 7 numbered checks' in error for error in errors))

    def test_seven_checks_do_not_bypass_evidence_and_authorization(self):
        errors = processor.validate_content(self.content(7))
        self.assertFalse(any('requires exactly 7 numbered checks' in error for error in errors))
        self.assertIn('public_verification binding is required', errors)
        self.assertTrue(any('delivery_readiness is required' in error for error in errors))

    def test_qualifications_are_review_warnings_not_automatic_rejection(self):
        blocks = [{'text': '已有试用订单，但仍需核验回款情况。'}]
        result = processor.reason_qualification_findings(blocks)
        self.assertEqual(result['errors'], [])
        self.assertEqual(len(result['warnings']), 1)
        self.assertEqual(blocks[0]['text'], '已有试用订单，但仍需核验回款情况。')

    def test_explicit_authorization_allows_gaps_but_not_conflicts(self):
        content = self.content(7)
        content['delivery_readiness'] = {
            'status': 'proceed_with_available_materials', 'as_of_date': '2026-09-07',
            'blocking_issues': [], 'missing_decisive_inputs': ['基金协议'],
            'supplement_request': {'requested': True, 'outcome': 'declined', 'requested_items': ['基金协议']},
            'continuation_authorization': {'authorized': True, 'basis': 'explicit_user_instruction', 'instruction': '合成测试：继续生成'},
        }
        result = processor.delivery_readiness_findings(content)
        self.assertEqual(result['status'], 'pass')
        self.assertTrue(result['warnings'])
        content['delivery_readiness']['continuation_authorization']['authorized'] = False
        self.assertEqual(processor.delivery_readiness_findings(content)['status'], 'fail')
        content['delivery_readiness']['continuation_authorization']['authorized'] = True
        content['delivery_readiness']['blocking_issues'] = ['合成测试：已知禁止性条款冲突']
        self.assertEqual(processor.delivery_readiness_findings(content)['status'], 'fail')

    def test_ready_label_cannot_hide_decisive_gaps(self):
        content = self.content(7)
        content['delivery_readiness'] = {'status': 'ready', 'missing_decisive_inputs': ['交易金额']}
        result = processor.delivery_readiness_findings(content)
        self.assertTrue(any('missing decisive inputs prevent unqualified delivery' in error for error in result['errors']))

    def test_authorized_pending_prose_preserves_limits(self):
        content = self.authorized_content()
        blocks = content['sections'][-1]['blocks']
        for block, (role, _) in zip(blocks, processor.ANALYSIS_ROLE_RULES):
            block['text'] = f'{role}尚待确认，应核对基金协议及相关交易文件。'
        blocks.append({'type': 'conclusion', 'status': 'pending', 'text': '在基金协议及交易条款核验通过的前提下，本项目原则上符合投资要求，相关事项尚待确认。'})
        result = processor.decision_semantic_findings(content)
        self.assertEqual(result['invalid_items'], [])
        self.assertEqual(result['invalid_process_items'], [])
        self.assertTrue(result['conclusion_pass'])
        blocks[0]['text'] = '投资限制事项已确认符合全部要求。'
        self.assertTrue(processor.decision_semantic_findings(content)['invalid_items'])
        content['delivery_readiness']['continuation_authorization']['authorized'] = False
        self.assertFalse(processor.decision_semantic_findings(content)['conclusion_pass'])

    def test_authorization_cannot_override_calculated_limit_breach(self):
        content = self.authorized_content()
        content['delivery_readiness']['concentration'] = {'calculation': {
            'denominator': 100, 'limit_ratio': 0.1,
            'existing_aggregated_exposure': 5, 'proposed_amount': 10,
            'post_investment_ratio': 0.15, 'headroom': -5,
        }}
        self.assertEqual(processor.delivery_readiness_findings(content)['status'], 'fail')

    def test_completeness_uses_same_authorized_pending_rule_as_semantic_gate(self):
        content = self.authorized_content()
        for block, (role, _) in zip(content['sections'][-1]['blocks'], processor.ANALYSIS_ROLE_RULES):
            block['text'] = f'{role}尚待确认，应核对基金协议及相关交易文件。'
        result = processor.content_completeness_findings(content)
        self.assertEqual(result['metrics']['analysis_process_language_hits'], [])
        content['delivery_readiness']['continuation_authorization']['authorized'] = False
        self.assertTrue(processor.content_completeness_findings(content)['metrics']['analysis_process_language_hits'])
        content['delivery_readiness']['continuation_authorization']['authorized'] = True
        content['delivery_readiness']['blocking_issues'] = ['合成测试：已知禁止性冲突']
        self.assertTrue(processor.content_completeness_findings(content)['metrics']['analysis_process_language_hits'])


if __name__ == '__main__':
    unittest.main()
