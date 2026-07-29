import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveRadarSubjectName,
  isBetterLeadSubjectName,
  isNonInvestableRadarContent,
  isSpecificLeadSubjectName,
} from '../src/services/leadSubjectName.js'

test('rejects article fragments and editorial labels as lead subjects', () => {
  for (const value of [
    '作为完全开放',
    '受试者参与本研究会经历筛选期（需在14天内',
    '文章来源',
    '论文合作者为暨南大学经济与社会研究院',
    'national Economics',
    'key observation made in 2021 by the paper',
    '全新突破',
    '硬氪前线',
    '融资',
    '会赚钱',
    '保险科技',
    '前瞻理论研究与创新平台',
  ]) {
    assert.equal(isSpecificLeadSubjectName(value), false, value)
  }
})

test('extracts the financed company after a news-column prefix', () => {
  assert.equal(deriveRadarSubjectName({
    title: '硬氪前线 | 东昇聚变获数亿元融资，国内唯一布局“氘-氦3”路线核聚变企业',
    projectName: '硬氪前线',
  }), '东昇聚变')
})

test('prefers a concrete named project over a shorter institution name', () => {
  assert.equal(deriveRadarSubjectName({
    title: '助力上海（长三角）国际科创中心建设！复旦大学光电研究院产业技术中试基地在普陀揭牌',
    projectName: '复旦大学光电研究院',
    lab: '复旦大学光电研究院',
  }), '复旦大学光电研究院产业技术中试基地')
  assert.equal(
    isBetterLeadSubjectName('复旦大学光电研究院', '复旦大学光电研究院产业技术中试基地'),
    true,
  )
})

test('keeps the primary research group when an article lists collaborators', () => {
  assert.equal(deriveRadarSubjectName({
    title: '清华大学与中国电信携手，实现6G算网融合关键技术突破',
    projectName: '信息国家研究中心',
    lab: '清华大学信息国家研究中心智慧天网交叉创新群体与中国电信研究院',
  }), '清华大学信息国家研究中心智慧天网交叉创新群体')
})

test('prefers the financed company over article columns, investors, and descriptive phrases', () => {
  const cases = [
    {
      expected: '智谷天厨',
      title: '“智谷天厨”获招商局创投领投近亿元融资',
      companyNames: ['融资'],
      articleText: '近日，智能烹饪机器人企业“智谷天厨”官宣完成新一轮近亿元战略融资。',
    },
    {
      expected: 'Kando AI',
      title: 'Kando AI完成数千万元种子轮融资，要做“决策领域的Cursor”｜涌现新项目',
      companyNames: ['涌现新项目'],
      articleText: 'Kando AI已完成数千万元种子轮融资。',
    },
    {
      expected: '正行创新',
      title: '近亿美元融资！清华校友姚颂三度创业，入局物理智能',
      companyNames: ['入局物理智能'],
      articleText: '姚颂的新公司叫 Striding AI，中文名“正行创新”。',
    },
    {
      expected: '汇光创新',
      title: '清华00后团队获得峰瑞、破壳机器人投资，要做超薄视触觉传感器',
      companyNames: ['破壳机器人'],
      articleText: '近日，机器人触觉传感器与触觉数据方案提供商汇光创新连续完成数千万元种子轮及天使轮融资。',
    },
    {
      expected: '思昇科技',
      title: '清华系脑机接口公司种子轮融资数千万',
      companyNames: ['超声脑机接口公司思昇科技'],
      articleText: '硬氪获悉，超声脑机接口公司思昇科技近日完成数千万元种子轮融资。',
    },
    {
      expected: '光象科技',
      title: '清华车辆学院师兄弟创业具身智能',
      companyNames: ['清华车辆学院师兄弟创业具身智能'],
      articleText: '硬氪获悉，具身智能公司「光象科技」宣布完成累计数亿元天使轮融资。',
    },
    {
      expected: '面壁智能',
      title: '估值超200亿！清华系端侧大模型独角兽面壁智能半年融资超50亿',
      companyNames: ['清华系端侧大模型独角兽面壁智能'],
      articleText: '7月15日，端侧大模型独角兽面壁智能宣布完成新一轮融资。',
    },
    {
      expected: '米能科技',
      title: '自研SNN类脑芯片、做医疗设备的“上游大脑”，「米能科技」获数千万元融资',
      companyNames: ['上游大脑'],
    },
    {
      expected: '航墨科技',
      title: '硬氪首发 | 北航机器人所团队创业，首创智能变刚度关节，完成近亿元天使轮融资',
      companyNames: [],
      articleText: '推出的智能膝关节外骨骼已获700万元众筹。',
    },
    {
      expected: '厘清智能',
      title: '独家｜清华系初创完成数亿元种子轮融资：我们不想被贴上「世界模型」的标签',
      companyNames: [],
    },
    {
      expected: '硅羽科技',
      title: '前大疆科学家创业，半年内连获四轮数亿融资，耀途资本、锦秋基金等押注',
      companyNames: [],
    },
  ]
  for (const input of cases) {
    assert.equal(deriveRadarSubjectName(input), input.expected, input.title)
  }
})

test('filters non-investable academic and participant recruitment content', () => {
  assert.equal(isNonInvestableRadarContent({
    values: ['受试者招募 | 北京清华长庚医院正在开展临床试验'],
  }), true)
  assert.equal(isNonInvestableRadarContent({
    values: ['研究成果发表于 Nature Communications'],
  }), true)
  assert.equal(isNonInvestableRadarContent({
    values: ['复旦大学光电研究院产业技术中试基地落地签约'],
  }), false)
  assert.equal(isNonInvestableRadarContent({
    values: ['2026未来能源“创变者”加速计划启动全国招募'],
  }), true)
  assert.equal(isNonInvestableRadarContent({
    values: ['2026年，为什么资本更青睐“会赚钱”的AI应用？'],
  }), true)
})
