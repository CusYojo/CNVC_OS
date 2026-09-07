export type RadarPublicSourceType =
  | 'rss'
  | 'arxiv_rss'
  | 'openalex_api'
  | 'html_list'
  | '36kr_financing_flash'
  | 'wanfang_search'
  | 'manual'

export interface RadarPublicSourceConfig extends Record<string, unknown> {
  key: string
  url: string
  name: string
  type: RadarPublicSourceType
  group: string
  enabled: boolean
  frequency: string
  note?: string
  keyword?: string
  max_pages?: number
  max_entries_per_run?: number
}

// Fresh installations bootstrap this catalog into radar_source_registry. Once
// imported, MySQL is authoritative and operator-owned enable flags are kept.
export const DEFAULT_RADAR_PUBLIC_SOURCES: RadarPublicSourceConfig[] = [
  { key: 'pku_tech', url: 'https://kjkfb.pku.edu.cn/cgxx/jscg/index.htm', name: '北京大学科技开发部 技术成果', type: 'html_list', group: '高校成果', enabled: true, frequency: '每周' },
  { key: 'zju_ttri', url: 'https://ttri.zju.edu.cn/cgzs/list.htm', name: '浙江大学工业技术转化研究院 成果展示', type: 'html_list', group: '高校成果', enabled: true, frequency: '每周' },
  { key: 'producthunt', url: 'https://www.producthunt.com/feed', name: 'Product Hunt 今日新品', type: 'rss', group: '海外项目', enabled: true, frequency: '每天' },
  {
    key: '36kr_pitchhub_financing_flash', url: 'https://pitchhub.36kr.com/financing-flash',
    name: '36氪 PitchHub 融资快报', type: '36kr_financing_flash', group: '创投新闻', enabled: true,
    frequency: '每天', max_pages: 8, max_entries_per_run: 100,
    note: '公开 HTML 页面，默认只保留页面标记为昨天的融资信息。',
  },
  { key: 'producthunt_devtools', url: 'https://www.producthunt.com/categories/developer-tools/feed', name: 'Product Hunt Developer Tools', type: 'rss', group: '海外项目', enabled: false, frequency: '每天', note: 'Product Hunt 已移除分类 RSS，保留官方主 Feed。' },
  { key: 'lieyunwang_feed', url: 'https://www.lieyunwang.com/feed', name: '猎云网 RSS', type: 'rss', group: '创投新闻', enabled: false, frequency: '每小时', note: '源站 TLS 不稳定，默认停用。' },
  { key: '36kr_feed', url: 'https://36kr.com/feed', name: '36氪 RSS', type: 'rss', group: '创投新闻', enabled: true, frequency: '每小时' },
  { key: 'itjuzi_reference', url: 'https://www.itjuzi.com/company?page=1', name: 'IT 桔子公司库', type: 'manual', group: '创投新闻', enabled: false, frequency: '低频', note: '反爬中等，仅作人工参考。' },
  { key: 'google_patents_ai_cn', url: 'https://patents.google.com/patent/rss?q=%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD&after=20260701&language=ZH', name: 'Google Patents 人工智能', type: 'rss', group: '专利', enabled: true, frequency: '每天' },
  { key: 'casip', url: 'http://www.casip.ac.cn/kjcg/index.html', name: '中国科学院知识产权与产业化网', type: 'html_list', group: '高校成果', enabled: true, frequency: '每周' },
  { key: 'hust_ttc', url: 'http://ttc.hust.edu.cn/kjcg/kjcg.htm', name: '华中科技大学科技成果转化服务中心', type: 'html_list', group: '高校成果', enabled: true, frequency: '每周' },
  { key: 'arxiv_cs_ai', url: 'https://rss.arxiv.org/rss/cs.AI', name: 'arXiv cs.AI', type: 'arxiv_rss', group: '论文', enabled: true, frequency: '工作日' },
  {
    key: 'openalex_ai', url: 'https://api.openalex.org/works', name: 'OpenAlex AI 论文',
    type: 'openalex_api', group: '论文', enabled: true, frequency: '每天',
    keyword: '("artificial intelligence" OR "machine learning" OR robotics OR semiconductor OR biotechnology)',
    max_entries_per_run: 50,
    note: 'arXiv 在部分网络环境不可达时的论文主数据源；OPENALEX_API_KEY 可选，配置后使用更高额度。',
  },
  { key: 'pedaily_quicknews', url: 'https://feeds.pedaily.cn/n/quicknews', name: '投资界 快讯', type: 'rss', group: '创投新闻', enabled: false, frequency: '每小时', note: '源站 TLS 不稳定，默认停用。' },
  { key: 'wanfang_ai', url: 'https://s.wanfangdata.com.cn/paper?q={keyword}', name: '万方论文搜索 人工智能', type: 'wanfang_search', group: '论文', enabled: false, keyword: '人工智能', frequency: '每天', note: '公开页主要返回前端外壳，默认不自动抓取。' },
  { key: 'google_patents_ml', url: 'https://patents.google.com/patent/rss?q=machine+learning&after=20260701&language=ZH', name: 'Google Patents machine learning', type: 'rss', group: '专利', enabled: true, frequency: '每天' },
  { key: 'sogou_weixin_reference', url: 'https://weixin.sogou.com/weixin?type=2&query=%E5%A4%A9%E4%BD%BF%E8%BD%AE%E8%9E%8D%E8%B5%84&page=1', name: '搜狗微信搜索', type: 'manual', group: '微信生态', enabled: false, frequency: '低频', note: '验证码和反爬明显，仅作人工参考。' },
  { key: 'arxiv_eess_sp', url: 'https://rss.arxiv.org/rss/eess.SP', name: 'arXiv eess.SP', type: 'arxiv_rss', group: '论文', enabled: true, frequency: '工作日' },
  { key: 'sjtu_aitri', url: 'https://aitri.sjtu.edu.cn/achievement/list.htm', name: '上海交通大学先进产业技术研究院 科技成果', type: 'html_list', group: '高校成果', enabled: true, frequency: '每周' },
  { key: 'tsinghua_otl', url: 'https://otl.tsinghua.edu.cn/achievements/list.htm', name: '清华大学技术转移研究院 成果库', type: 'html_list', group: '高校成果', enabled: true, frequency: '每周' },
  { key: 'cnki_reference', url: 'https://kns.cnki.net/kns8s/AdvSearch?classid=YSTT4HG0', name: '中国知网公开摘要页', type: 'manual', group: '论文', enabled: false, frequency: '参考', note: '反爬严格，仅作人工参考。' },
]
