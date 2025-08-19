import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";
import cheerio from "cheerio";

const SITE_URL = process.env.SITE_URL || "https://www.seumestrefinanceiro.com.br";
const PUBLICATION_NAME = process.env.PUBLICATION_NAME || "Seu Mestre Financeiro";
const LANGUAGE = process.env.LANGUAGE || "pt";
const SOURCE_FEED_URL = process.env.SOURCE_FEED_URL || "";
const SOURCE_HTML_URL = process.env.SOURCE_HTML_URL || "";
const ARTICLE_SELECTOR = process.env.ARTICLE_SELECTOR || "article a[href]";
const DATE_SELECTOR = process.env.DATE_SELECTOR || "article time[datetime]";
const MAX_ITEMS = 1000;

const outRss = path.resolve("rss.xml");
const outNews = path.resolve("sitemap-news.xml");

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

function normDate(d) {
  const dt = new Date(d);
  if (isNaN(dt)) return null;
  return dt;
}
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function fromFeed(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Falha ao baixar feed: ${res.status}`);
  const text = await res.text();
  const xml = parser.parse(text);

  // RSS 2.0
  if (xml?.rss?.channel?.item) {
    return xml.rss.channel.item.map(it => ({
      title: it.title,
      url: it.link,
      date: normDate(it.pubDate || it["dc:date"] || it["dc:created"])
    }));
  }
  // Atom
  if (xml?.feed?.entry) {
    const entries = Array.isArray(xml.feed.entry) ? xml.feed.entry : [xml.feed.entry];
    return entries.map(e => {
      let link = e.link;
      if (Array.isArray(link)) {
        const alt = link.find(l => (l.rel ?? "alternate") === "alternate" && l.href);
        link = alt?.href || link[0]?.href;
      } else {
        link = link?.href || link;
      }
      return {
        title: e.title,
        url: link,
        date: normDate(e.published || e.updated)
      };
    });
  }
  return [];
}

async function fromHtml(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Falha ao baixar HTML: ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const items = [];
  const seen = new Set();
  $(ARTICLE_SELECTOR).each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;
    let abs = href.startsWith("http") ? href : new URL(href, url).toString();
    if (seen.has(abs)) return;
    seen.add(abs);

    // tenta achar título próximo
    const title = $(a).attr("title") || $(a).text().trim() || abs;

    // tenta data via seletor configurável
    let dateText = $(a).closest("article").find(DATE_SELECTOR).attr("datetime")
      || $(a).closest("article").find(DATE_SELECTOR).text();
    const date = normDate(dateText);

    items.push({ title, url: abs, date });
  });
  return items;
}

function buildRSS(items) {
  const now = new Date().toUTCString();
  const channel =
`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${esc(PUBLICATION_NAME)}</title>
  <link>${esc(SITE_URL)}</link>
  <description>${esc(PUBLICATION_NAME)}</description>
  <language>${esc(LANGUAGE)}</language>
  <lastBuildDate>${now}</lastBuildDate>
${items.map(it => `
  <item>
    <title>${esc(it.title)}</title>
    <link>${esc(it.url)}</link>
    <guid>${esc(it.url)}</guid>
    ${it.date ? `<pubDate>${new Date(it.date).toUTCString()}</pubDate>` : ""}
  </item>`).join("")}
</channel>
</rss>`;
  return channel;
}

function buildNewsSitemap(items) {
  const cutoff = Date.now() - 48 * 3600 * 1000; // 48h
  const fresh = items.filter(i => i.date && i.date.getTime() >= cutoff);
  const body =
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${fresh.map(it => `
  <url>
    <loc>${esc(it.url)}</loc>
    <news:news>
      <news:publication>
        <news:name>${esc(PUBLICATION_NAME)}</news:name>
        <news:language>${esc(LANGUAGE)}</news:language>
      </news:publication>
      <news:publication_date>${new Date(it.date).toISOString()}</news:publication_date>
      <news:title>${esc(it.title)}</news:title>
    </news:news>
  </url>`).join("")}
</urlset>`;
  return body;
}

(async () => {
  let items = [];
  if (SOURCE_FEED_URL) items = await fromFeed(SOURCE_FEED_URL);
  else if (SOURCE_HTML_URL) items = await fromHtml(SOURCE_HTML_URL);

  // ordena por data desc, limita
  items = items
    .map(i => ({ ...i, date: i.date || new Date() }))
    .sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0))
    .slice(0, MAX_ITEMS);

  await fs.writeFile(outRss, buildRSS(items), "utf-8");
  await fs.writeFile(outNews, buildNewsSitemap(items), "utf-8");

  console.log(`Gerados: ${outRss}, ${outNews}. Itens: ${items.length}`);
})();
