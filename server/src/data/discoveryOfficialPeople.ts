import type { DiscoveryPerson } from '../contracts/discoveryPeopleContract.js'

// Publisher snapshots, not claims that the people are fundraising or seeking a job.
// Review source pages before changing names or affiliations.
const casAwardUrl = 'https://www.cas.cn/zt/hyzt/cas2025gzh/qnj/202501/t20250115_5045064.shtml'
const caeElectionUrl = 'https://www.cae.cn/cae/html/main/col2296/2025-11/21/20251121085141231546269_1.html'

const casAwardees: Array<[string, string, string]> = [
  ['王志俊', '物理研究所', '基础研究'], ['石发展', '中国科学技术大学', '基础研究'],
  ['成里京', '大气物理研究所', '基础研究'], ['乔燕', '化学研究所', '基础研究'],
  ['刘真', '脑科学与智能技术卓越创新中心', '基础研究'], ['李昺', '金属研究所', '基础研究'],
  ['吴东东', '昆明动物研究所', '基础研究'], ['林莽', '广州地球化学研究所', '基础研究'],
  ['周武', '中国科学院大学', '基础研究'], ['郑维喆', '数学与系统科学研究院', '基础研究'],
  ['王屹', '广州能源研究所', '工程技术'], ['王磊', '电工研究所', '工程技术'],
  ['田大鹏', '长春光学精密机械与物理研究所', '工程技术'], ['朱阳历', '工程热物理研究所', '工程技术'],
  ['乔旦', '兰州化学物理研究所', '工程技术'], ['刘雨蒙', '软件研究所', '工程技术'],
  ['孙涛', '沈阳应用生态研究所', '工程技术'], ['罗庆', '微电子研究所', '工程技术'],
  ['高帅和', '国家授时中心', '工程技术'], ['黄鹤飞', '上海应用物理研究所', '工程技术'],
]

const caeExperts: Array<[string, string, string]> = [
  ['陈勇', '中国商用飞机有限责任公司', '机械与运载工程'],
  ['廉玉波', '比亚迪股份有限公司', '机械与运载工程'],
  ['邓中亮', '北京邮电大学', '信息与电子工程'],
  ['樊仲维', '中国科学院大学', '信息与电子工程'],
  ['王晓云', '中国移动通信集团有限公司', '信息与电子工程'],
  ['吴枫', '中国科学技术大学', '信息与电子工程'],
  ['张文军', '上海交通大学', '信息与电子工程'],
]

export const OFFICIAL_DISCOVERY_PEOPLE: DiscoveryPerson[] = [
  ...casAwardees.map(([name, organization, field]) => ({
    identityKey: `cas-young-2024:${name}:${organization}`, name, organization, field,
    kind: 'ranking' as const, identityStatus: 'source_confirmed' as const,
    sourceLabel: '中国科学院 2024 年度青年科学家奖',
    evidence: [{ title: '2024 年度中国科学院青年科学家奖获奖者名单', url: casAwardUrl, publishedAt: '2025-01-15', publisher: '中国科学院' }],
  })),
  ...caeExperts.map(([name, organization, field]) => ({
    identityKey: `cae-2025:${name}:${organization}`, name, organization, field,
    kind: 'expert' as const, identityStatus: 'source_confirmed' as const,
    sourceLabel: '中国工程院 2025 年院士增选',
    evidence: [{ title: '2025 年中国工程院院士增选名单', url: caeElectionUrl, publishedAt: '2025-11-21', publisher: '中国工程院' }],
  })),
]
