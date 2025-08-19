// build-feeds.mjs
// Gera rss.xml (RSS 2.0) e sitemap-news.xml (Google News) a partir do sitemap do WWW.
// Projetado p/ rodar em GitHub Actions (Node 20+, fetch nativo).

import fs from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import cheerio from 'cheerio';

/* =========================
 * Configuração (via ENV)
 * ========================= */
const SOURCE_SITEMAP = process.env.SOURCE_SITEMAP || 'https://www.seumestrefinanceiro.com.br/sitemap.xml';
const SITE_LINK = process.env.SITE_LINK || 'https://www.seumestrefinanceiro.com.br';
const PUBLICATION_NAME = process.env.PUBLICATION_NAME || 'Seu Mestre Financeiro';
const PUB_LANG_ISO639 = process.env.PUB_LANG || 'pt'; // ISO-639 (ex.: 'pt')
const FEED_SELF_URL = process.env.FEED_SELF_URL || 'https://git.seumestrefinanceiro.com.br/rss.xml'; // rel="self" do feed
const MAX_RSS_ITEMS = Number(process.env.MAX_RSS_ITEMS || 50); // tamanho do feed
const NEWS_WINDOW_MS = Number(process.env.NEWS_WINDOW_MS || (48 * 60 * 60 * 1000)); // 48h

/* ================
 * Utilidades
 * ================ */
const esc = (s) =>
  String(s ?? '').replace(/&/g,'&amp;')
                 .replace(/</g,'&lt;')
                 .replace(/>/g,'&gt;')
                 .replace(/"/g,'&quot;')
                 .replace(/'/g,'&apos;');

const isPostUrl = (u) => /^https:\/\/www\.seumestrefinanceiro\.com\.br\/post\//.test(u);

async function getText(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return await r.text();
}

/* =========================
 * 1) Ler sitemap do WWW
 * ========================= */
async function fetchSitemapUrls() {
  const xml = await getText(SOURCE_SITEMAP);
  const parser = new XMLParser({ ignoreAttributes: false });
  const data = parser.parse(xml);

  // Suporte tanto a <urlset><url>...</url> quanto a arrays
  const raw = data?.urlset?.url || [];
  const urls = (Array.isArray(raw) ? raw : [raw])
    .map(u => (typeof u?.loc === 'string' ? u.loc : u?.loc?.['#text']))
    .filter(Boolean);

  // Apenas posts
  return urls.filter(isPostUrl);
}

/* =========================
 * 2) Raspagem de cada post
 * ========================= */
async function fetchArticleMeta(url) {
  try {
    const html = await getText(url);
    const $ = cheerio.load(html);

    // Título
    const ogTitle = $('meta[property="og:title"]').attr('content');
    const titleTag = $('title').first().text().trim();
    const h1 = $('h1').first().text().trim();
    const title = (ogTitle || h1 || titleTag || url).trim();

    // Descrição (melhor esforço)
    const ogDesc = $('meta[property="og:description"]').attr('content');
    const metaDesc = $('meta[name="description"]').attr('content');
    const description = (ogDesc || metaDesc || '').trim();

    // Data de publicação (prioriza metadados semânticos)
    let published =
      $('meta[property="article:published_time"]').attr('content') ||
      $('meta[name="article:published_time"]').attr('content') ||
      $('time[datetime]').attr('datetime') ||
      null;

    // JSON-LD (Article/NewsArticle)
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = $(el).contents().text();
        const obj = JSON.parse(json);
        const arr = Array.isArray(obj) ? obj : [obj];
        for (const it of arr) {
          if (it?.datePublished) {
            published = it.datePublished;
            break;
          }
        }
      } catch {/* ignora blocos inválidos */}
    });

    const pubDate = published ? new Date(published) : null;
    return { url, title, desc: description, date: pubDate };
  } catch {
    return { url, title: url, desc: '', date: null };
  }
}

/* =========================
 * 3) Builders de XML
 * ========================= */

// RSS 2.0 — boas práticas: item com title/link/guid/description/pubDate;
// channel com atom:self e ttl. (Especificação RSS 2.0) :contentReference[oaicite:1]{index=1}
function buildRSS(channelTitle, channelLink, items, feedSelfUrl) {
  const header = `<?xml version="1.0" encoding="UTF-8"?>`;
  const atomNS = `xmlns:atom="http://www.w3.org/2005/Atom"`;

  const bodyItems = items.map(it => `
  <item>
    <title>${esc(it.title)}</title>
    <link>${esc(it.url)}</link>
    <guid isPermaLink="true">${esc(it.url)}</guid>
    ${it.date ? `<pubDate>${new Date(it.date).toUTCString()}</pubDate>` : ''}
    ${it.desc ? `<description>${esc(it.desc)}</description>` : ''}
  </item>`).join('\n');

  return `${header}
<rss version="2.0" ${atomNS}>
<channel>
  <title>${esc(channelTitle)}</title>
  <link>${esc(channelLink)}</link>
  <description>${esc(channelTitle)}</description>
  <language>${esc(PUB_LANG_ISO639)}</language>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
  <ttl>60</ttl>
  <atom:link href="${esc(feedSelfUrl)}" rel="self" type="application/rss+xml"/>
${bodyItems}
</channel>
</rss>`;
}

// News Sitemap — apenas artigos das últimas 48h; campos exigidos pela doc. :contentReference[oaicite:2]{index=2}
function buildNewsSitemap(publicationName, lang, articles, windowMs) {
  const cutoff = Date.now() - windowMs;
  const fresh = articles
    .filter(a => a.date && a.date.getTime() >= cutoff)
    .sort((a, b) => b.date - a.date)
    .slice(0, 1000); // limite News

  const header = `<?xml version="1.0" encoding="UTF-8"?>`;
  const urlsetOpen =
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
    `        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">`;

  const body = fresh.map(a => `
  <url>
    <loc>${esc(a.url)}</loc>
    <news:news>
      <news:publication>
        <news:name>${esc(publicationName)}</news:name>
        <news:language>${esc(lang)}</news:language>
      </news:publication>
      <news:publication_date>${new Date(a.date).toISOString()}</news:publication_date>
      <news:title>${esc(a.title)}</news:title>
    </news:news>
  </url>`).join('\n');

  return `${header}
${urlsetOpen}
${body}
</urlset>`;
}

/* =========================
 * 4) Execução
 * ========================= */
async function run() {
  const urls = await fetchSitemapUrls();

  // Raspagem paralela (limite leve para evitar burst)
  const chunks = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    chunks.push(urls.slice(i, i + CONCURRENCY));
  }

  const metas = [];
  for (const group of chunks) {
    const part = await Promise.all(group.map(u => fetchArticleMeta(u)));
    metas.push(...part);
  }

  // Ordena por data desc; define fallback para itens sem data
  const withDates = metas.map(m => ({ ...m, date: m.date || new Date() }))
                         .sort((a, b) => b.date - a.date);

  // RSS: pega os N mais recentes
  const rssItems = withDates.slice(0, MAX_RSS_ITEMS);

  const rssXml = buildRSS(PUBLICATION_NAME, SITE_LINK, rssItems, FEED_SELF_URL);
  await fs.writeFile(path.resolve('rss.xml'), rssXml, 'utf8');

  const newsXml = buildNewsSitemap(PUBLICATION_NAME, PUB_LANG_ISO639, withDates, NEWS_WINDOW_MS);
  await fs.writeFile(path.resolve('sitemap-news.xml'), newsXml, 'utf8');

  const newsCount = withDates.filter(a => a.date && (Date.now() - a.date.getTime()) <= NEWS_WINDOW_MS).length;
  console.log(`rss.xml: ${rssItems.length} itens | sitemap-news.xml: ${newsCount} artigos (<= ${Math.round(NEWS_WINDOW_MS/3600000)}h)`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
