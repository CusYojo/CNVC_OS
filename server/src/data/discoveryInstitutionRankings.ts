/**
 * Ordered names transcribed from 投中榜's 2025 VC and PE Top 100 tables.
 * These are publisher rankings, not an assessment of any particular investment.
 * Keep source names verbatim; do not infer unlisted aliases or institution identity.
 */
const VC_SOURCE_URL = 'https://www.chinaventure.com.cn/rank/210/3182.html'
const PE_SOURCE_URL = 'https://www.chinaventure.com.cn/rank/210/3183.html'

const VC_NAMES = [
  'IDG资本', '深创投集团', '君联资本', '启明创投', '经纬创投', '东方富海', '毅达资本', '纪源资本', '达晨财智', '五源资本',
  '光合创投', '同创伟业', '联想创投', '普华资本', '松禾资本', '弘晖基金', 'Monolith砺思资本', '源码资本', '浦东创投', '高榕创投',
  '丰年资本', '华业天成资本', '礼来亚洲基金', '北极光创投', '浦东科创/海望资本', '美团龙珠', '国投创合', '苏创投', '钟鼎资本', '国中资本',
  '黑蚁资本', '祥峰投资', '顺为资本', '华盖资本', '西高投', '朗玛峰创投', '粤科金融集团', '厚雪资本', '成都科创投集团', '蔚来资本',
  '天堂硅谷', '锡创投', '国科投资', '浦耀信晔', '德同资本', '金雨茂物', '华映资本', '华睿投资', '天图投资', '创东方投资',
  '国科嘉和', '长江创投', 'XVC', '金沙江创投', '临港科创投', '云九资本', '元禾厚望', '汉康资本', '联创资本', '愉悦资本',
  '博远资本', '和利资本', '国投创业', '清控银杏', '复星锐正资本', '中鑫资本', '中关村资本', '容亿投资', 'LongRiver江远投资', '元璟资本',
  '倚锋资本', '众行资本', '浙商创投', '道禾长期投资', '上海国投科创/上海科创集团', '磐霖资本', '博将资本', '天创资本', '盛宇投资', '芯联资本',
  '济峰资本', '启承资本', '正海资本', '长石资本', '唐兴资本', '朝希资本', '国际国方', '东方嘉富', '投控东海', '和玉资本MSA CAPITAL',
  '聚合资本', '清松资本', '杏泽资本', '远翼投资', '金鼎资本', '博源资本', '软银中国资本', '海愿资本', '力合创投', '天鹰资本',
] as const

const PE_NAMES = [
  '红杉中国', '中金资本', '高瓴投资', '国新基金', 'CPE源峰', '国投创新', '中芯聚源', '基石资本', '中信金石', '海松资本',
  '金浦投资', '前海方舟', '招银国际资本', '复星创富', '鼎晖投资', 'PAG', '平安资本', '博裕投资', '凯辉基金', '德弘资本',
  '招商资本', '大钲资本', '珠海科技产业集团', '国寿股权', '尚颀资本', '恒旭资本', '国盛资本', '国投创益', '正心谷资本', '云晖资本',
  '元禾璞华', '海通开元', '广发信德', '春华资本', '华泰紫金投资', '力鼎资本', '成都产投集团', '联新资本', '嘉御资本', '诚通基金',
  '高特佳投资', '北汽产投', '建银国际', '华控基金', '新鼎资本', '中信建投资本', '中信资本', '沄柏资本', '加华资本', '盛世投资',
  '广州产投资本', '华平投资', '建投基金', '淡马锡', '金镒资本', '建信（北京）投资', '黄浦江资本', '云锋基金', '阳光融汇资本', '君桐资本',
  '上海国投孚腾资本', '越秀产业基金', '农银资本管理有限公司', '涌铧投资', '一村资本', 'KKR', '善达投资', '中银资本', '合肥建投资本', '方正和生',
  '策源资本', '博华资本', '粤财创投', '中关村科学城公司', '弘毅投资', '上实资本', '兴证资本', '十月资本', '九智资本', '广州基金',
  '摩根士丹利', '富浙基金', '优山投资', '临芯投资', '德福资本', '上海国投先导', '未来资产资本', '北京泰康投资', '人保资本股权', '中兵顺景',
  '普罗资本', '海尔资本', '深投控资本', '华润资本', 'CMC资本', '广东恒健控股', 'L Catterton路威凯腾', '穗开投资', '交子资本', '国金鼎兴',
] as const

export type DiscoveryInstitutionRanking = Readonly<{
  name: string
  rank: number
  category: 'VC' | 'PE'
  year: 2025
  sourceUrl: string
  score: 90 | 80 | 70
}>

function rankScore(rank: number): 90 | 80 | 70 {
  return rank <= 30 ? 90 : rank <= 50 ? 80 : 70
}

function rows(names: readonly string[], category: 'VC' | 'PE', sourceUrl: string): DiscoveryInstitutionRanking[] {
  return names.map((name, index) => Object.freeze({
    name, rank: index + 1, category, year: 2025 as const, sourceUrl, score: rankScore(index + 1),
  }))
}

export const DISCOVERY_INSTITUTION_RANKINGS: readonly DiscoveryInstitutionRanking[] = Object.freeze([
  ...rows(VC_NAMES, 'VC', VC_SOURCE_URL),
  ...rows(PE_NAMES, 'PE', PE_SOURCE_URL),
])

export function normalizeDiscoveryInstitutionName(name: string): string {
  return name.replace(/[\s\u3000]+/gu, '').replace(/[／]/gu, '/')
    .replace(/[（]/gu, '(').replace(/[）]/gu, ')')
}

const byName = new Map(DISCOVERY_INSTITUTION_RANKINGS.map((entry) => [normalizeDiscoveryInstitutionName(entry.name), entry]))

/** Only exact normalized publisher names match. No substring or fuzzy entity resolution. */
export function lookupDiscoveryInstitutionRanking(name: string): Omit<DiscoveryInstitutionRanking, 'name'> | null {
  const entry = byName.get(normalizeDiscoveryInstitutionName(name))
  if (!entry) return null
  const { rank, category, year, sourceUrl, score } = entry
  return { rank, category, year, sourceUrl, score }
}
