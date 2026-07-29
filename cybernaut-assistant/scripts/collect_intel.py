#!/usr/bin/env python3
"""情报采集 bridge：服务器直连中文搜索引擎抓公司公开信息，只返回真实抓取结果（标题+摘要+URL）。
绝不编造：抓不到就返回空。下游项目模型只允许基于这些真实片段提炼。
用法: python3 collect_intel.py "公司名" '["待核验事项1","待核验事项2"]'
输出: stdout JSON {company, queries:[{q, results:[{title, snippet, url}]}], fetched_at}
"""
import concurrent.futures
import sys, json, re, time, urllib.parse, urllib.request, html as htmllib

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

def clean_html(text, limit):
    cleaned = htmllib.unescape(re.sub(r'<[^>]+>', ' ', text or ""))
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    cleaned = re.split(r'推荐您搜索|大家还在搜', cleaned, maxsplit=1)[0].strip()
    return cleaned[:limit]

def bing(query, top=4):
    q = urllib.parse.quote(query)
    url = f"https://cn.bing.com/search?q={q}&setlang=zh-CN"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"})
    try:
        raw = urllib.request.urlopen(req, timeout=15).read().decode("utf-8", "ignore")
    except Exception as e:
        return {"q": query, "error": str(e), "results": []}
    # 每个结果块 <li class="b_algo"> ... <h2><a href="URL">TITLE</a> ... <p ...>SNIPPET</p>
    blocks = re.split(r'<li class="b_algo"', raw)[1:]
    out = []
    for b in blocks[:top]:
        m_url = re.search(r'<h2[^>]*>\s*<a[^>]*href="([^"]+)"', b)
        m_title = re.search(r'<h2[^>]*>\s*<a[^>]*>(.*?)</a>', b, re.S)
        m_snip = re.search(r'class="b_lineclamp\d*"[^>]*>(.*?)</p>', b, re.S)
        title = clean_html(m_title.group(1), 240) if m_title else ""
        url_ = m_url.group(1) if m_url else ""
        snip = clean_html(m_snip.group(1), 800) if m_snip else ""
        if title and url_:
            out.append({"title": title, "snippet": snip, "url": url_})
    return {"q": query, "results": out}

def sogou(query, top=4):
    q = urllib.parse.quote(query)
    url = f"https://www.sogou.com/web?query={q}"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"})
    try:
        raw = urllib.request.urlopen(req, timeout=15).read().decode("utf-8", "ignore")
    except Exception as e:
        return {"q": query, "error": str(e), "results": []}
    pattern = re.compile(
        r'<h3[^>]*>.*?<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>\s*</h3>'
        r'\s*<div[^>]*id="cacheresult_summary_[^"]+"[^>]*>(.*?)</div>',
        re.S,
    )
    out = []
    exact_match = re.search(r'"([^"]+)"', query)
    exact_company = exact_match.group(1).replace(" ", "") if exact_match else ""
    for href, title_html, snippet_html in pattern.findall(raw):
        title = clean_html(title_html, 240)
        snippet = clean_html(snippet_html, 800)
        compact = f"{title}{snippet}".replace(" ", "")
        if exact_company and exact_company not in compact:
            continue
        result_url = urllib.parse.urljoin("https://www.sogou.com", htmllib.unescape(href))
        if title and result_url:
            out.append({"title": title, "snippet": snippet, "url": result_url})
        if len(out) >= top:
            break
    return {"q": query, "results": out}

def search(query):
    # 优先保留可直接核验的目标页 URL；只有主搜索无结果时才使用中文
    # 搜索引擎兜底，避免大量重定向链接降低来源可追溯性。
    result = bing(query)
    return result if result.get("results") else sogou(query)

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "missing company name"}, ensure_ascii=False)); return
    company = sys.argv[1].strip()
    try:
        topics = json.loads(sys.argv[2]) if len(sys.argv) > 2 else []
        topics = [str(item).strip()[:180] for item in topics if str(item).strip()][:8]
    except Exception:
        topics = []
    exact_company = f'"{company}"'
    core_facets = [
        f"{exact_company} 公司 简介 主营业务",
        f"{exact_company} 注册资本 法定代表人 成立时间 工商",
        f"{exact_company} 融资 轮次 投资方 估值",
        f"{exact_company} 核心团队 产品 客户 合作 最新动态",
    ]
    general_rule_terms = re.compile(
        r"行业政策|产业政策|市场趋势|投资限制|返投|关联交易|投资方向|投资配置|"
        r"SPV|集中度|许可|备案|处罚|诉讼|失信|制裁|监管"
    )
    # 公司、团队、产品等查询限定当前主体；基金规则和监管口径按主题查询，
    # 否则强制附加公司全称会把本应命中的政策页面全部过滤掉。
    topic_facets = [
        topic if general_rule_terms.search(topic) else f"{exact_company} {topic}"
        for topic in topics
    ]
    facets = core_facets + topic_facets
    # 受限并发避免“核心检索 + 多个待核验主题”逐条累计到数分钟。
    # 4 路并发兼顾延迟和搜索站点负载；map 保留原始主题顺序。
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, len(facets))) as executor:
        queries = list(executor.map(search, facets))
    total = sum(len(q.get("results", [])) for q in queries)
    print(json.dumps({
        "company": company,
        "queries": queries,
        "result_count": total,
        "fetched_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
