const { db } = require("./server-dist/db/client.js");
const { leads } = require("./server-dist/db/schema.js");
const { eq, sql } = require("drizzle-orm");
async function main() {
  const radar = await (await fetch("http://101.126.93.130:8121/api/candidates?limit=200&source=arxiv")).json();
  const items = radar.items || [];
  const rows = await db.select({ id: leads.id, name: leads.name }).from(leads).where(
    sql`(${leads.radarProfile}->>channel = 论文 AND ${leads.radarProfile}->>sourceName = arxiv)`
  );
  let updated = 0;
  for (const row of rows) {
    const it = items.find((x) => x.title === row.name);
    if (!it) continue;
    const pm = {
      title: it.title || "",
      authors: Array.isArray(it.authors) ? it.authors : [],
      firstAuthor: it.first_author || (Array.isArray(it.authors) ? it.authors[0] : ""),
      secondAuthor: it.second_author || (Array.isArray(it.authors) ? it.authors[1] : ""),
      categories: Array.isArray(it.categories) ? it.categories : String(it.categories || "").split(/[,，;；]/).map((x) => x.trim()).filter(Boolean),
      venue: it.journal_ref || "",
      comment: it.comment || "",
      pdfUrl: it.pdf_url || "",
      abstract: (it.summary || "").toString().slice(0, 4000),
      publishedAt: it.published_at || "",
    };
    await db.update(leads).set({ radarProfile: sql`jsonb_set(COALESCE(${leads.radarProfile},{}::jsonb), {paperMeta}, ${JSON.stringify(pm)}::jsonb)` }).where(eq(leads.id, row.id));
    updated++;
  }
  console.log("updated", updated);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
