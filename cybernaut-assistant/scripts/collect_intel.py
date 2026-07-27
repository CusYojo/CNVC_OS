#!/usr/bin/env python3
"""情报采集 bridge：服务器直连必应抓公司公开信息，只返回真实抓取结果（标题+摘要+URL）。
绝不编造：抓不到就返回空。flue agent 负责把这些真实片段结构化，不许它自己造数据。
用法: python3 collect_intel.py "公司名"
输出: stdout JSON {company, queries:[{q, results:[{title, snippet, url}]}], fetched_at}
"""
import sys, json, re, time, urllib.parse, urllib.request, html as htmllib

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

def bing(query, top=8):
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
        def clean(t):
            return htmllib.unescape(re.sub(r'<[^>]+>', '', t)).strip() if t else ""
        title = clean(m_title.group(1)) if m_title else ""
        url_ = m_url.group(1) if m_url else ""
        snip = clean(m_snip.group(1)) if m_snip else ""
        if title and url_:
            out.append({"title": title, "snippet": snip, "url": url_})
    return {"q": query, "results": out}

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "missing company name"}, ensure_ascii=False)); return
    company = sys.argv[1].strip()
    facets = [
        f"{company} 公司 简介 主营业务",
        f"{company} 注册资本 法定代表人 成立时间 工商",
        f"{company} 融资 轮次 投资方 估值",
        f"{company} 最新 动态 新闻 2025 2026",
    ]
    queries = []
    for f in facets:
        queries.append(bing(f))
        time.sleep(0.8)  # 温和抓取，避免被限流
    total = sum(len(q.get("results", [])) for q in queries)
    print(json.dumps({
        "company": company,
        "queries": queries,
        "result_count": total,
        "fetched_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
