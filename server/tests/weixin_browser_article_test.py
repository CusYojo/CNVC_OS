import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('weixin_browser', Path(__file__).parents[1] / 'scripts/weixin-browser-article.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ArticleTests(unittest.TestCase):
    def test_clean_body(self):
        result = module.extract('''<h1 id="activity-name">测试标题</h1><div id="js_name">来源</div>
        <div id="js_content"><p>真实文章正文，需要保留足够长的文本供后续线索清洗和评分。</p>
        <script>融资千万不应进入评分</script><img data-src="https://mmbiz.qpic.cn/a.jpg">
        <a href="javascript:alert(1)">链接</a></div>''', 'https://mp.weixin.qq.com/s/a')
        self.assertNotIn('融资千万', result['text'])
        self.assertNotIn('javascript:', result['markdown'])
        self.assertIn('https://mmbiz.qpic.cn/a.jpg', result['markdown'])

    def test_verification_is_not_article(self):
        with self.assertRaises(ValueError):
            module.extract('<title>环境异常</title><p>请完成验证</p>', 'https://mp.weixin.qq.com/s/a')

    def test_url_boundary(self):
        for url in ['http://mp.weixin.qq.com/s/a', 'https://127.0.0.1/s/a', 'https://mp.weixin.qq.com.evil.test/s/a', 'https://user@mp.weixin.qq.com/s/a']:
            self.assertFalse(module.valid_url(url))


if __name__ == '__main__':
    unittest.main()
