import pathlib
p = pathlib.Path('server/src/routes/meta.ts')
s = p.read_text(encoding='utf-8')

old = """        // 【批次3·需求G】论文(arxiv)元数据:作者/分类/pdf/摘要,供后续 AI 中文解读+作者背景+技术落地分析复用。
        // 仅 arxiv 线索有值;其他渠道为空对象。摘要(abstract)取雷达 summary(英文原文)。
        paperMeta: isArxiv ? {
          title: prof.paper_title || it.title || '',
          authors: it.authors || prof.paper_authors || '',
          firstAuthor: it.first_author || prof.paper_first_author || '',
          secondAuthor: it.second_author || prof.paper_second_author || '',
          categories: it.categories || prof.paper_categories || '',
          venue: it.journal_ref || prof.paper_venue || '',
          comment: it.comment || prof.paper_comment || '',
          pdfUrl: it.pdf_url || prof.paper_pdf_url || '',
          abstract: (it.summary || '').toString().slice(0, 4000),
          publishedAt: it.published_at || '',
        } : {},"""

new = """        // 【批次3·需求G】论文(arxiv)元数据:作者/分类/pdf/摘要,供后续 AI 中文解读+作者背景+技术落地分析复用。
        // 仅 arxiv 线索有值;其他渠道为空对象。摘要(abstract)取雷达 summary(英文原文)。
        paperMeta: isArxiv ? {
          title: it.title || prof.paper_title || name,
          authors: Array.isArray(it.authors) ? it.authors : String(it.authors || prof.paper_authors || '').split(/[,;，；]/).map((x: string) => x.trim()).filter(Boolean),
          firstAuthor: it.first_author || prof.paper_first_author || (Array.isArray(it.authors) ? it.authors[0] : ''),
          secondAuthor: it.second_author || prof.paper_second_author || (Array.isArray(it.authors) ? it.authors[1] : ''),
          categories: Array.isArray(it.categories) ? it.categories : String(it.categories || prof.paper_categories || '').split(/[,，;；]/).map((x: string) => x.trim()).filter(Boolean),
          venue: it.journal_ref || prof.paper_venue || '',
          comment: it.comment || prof.paper_comment || '',
          pdfUrl: it.pdf_url || prof.paper_pdf_url || '',
          abstract: (it.summary || '').toString().slice(0, 4000),
          publishedAt: it.published_at || '',
        } : {},"""

assert old in s, "paperMeta 段没匹配上"
s = s.replace(old, new, 1)

# 论文默认用英文名(title) + 作者 / 分类 / 摘要同步给 list 视图字段
old2 = """        industry: (prof.industry || '待核验').toString().slice(0, 64),
        source: `项目发现雷达 · ${it.source_name || it.source || '公开渠道'}`,"""
new2 = """        industry: (isArxiv
          ? (Array.isArray(it.categories) ? it.categories.slice(0, 3).join(', ') : String(it.categories || prof.industry || '待核验').toString().slice(0, 64))
          : (prof.industry || '待核验').toString().slice(0, 64)),
        source: isArxiv
          ? `项目发现雷达 · arxiv`
          : `项目发现雷达 · ${it.source_name || it.source || '公开渠道'}`,"""
assert old2 in s, "industry/source 行没匹配上"
s = s.replace(old2, new2, 1)

p.write_text(s, encoding='utf-8')
print("paperMeta 字段取原值 OK")
