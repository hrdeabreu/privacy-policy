// build-feeds.mjs
// Gera rss.xml (RSS 2.0) e sitemap-news.xml (Google News) a partir do sitemap do site WWW.
// Projetado para rodar em GitHub Actions com Node 20+ (fetch nativo).
//
// Normas e melhores práticas seguidas:
// - RSS 2.0: pubDate em RFC-822; ttl; guid; atom:link rel="self". [RSS Advisory Board / W3C]
// - News Sitemap: ≤48h, 1000 URLs, campos obrigatórios. [Google Search Central]
//
// Segurança/robustez:
// - Concurrency control para scraping
// - Timeout por requisição
// - Sanitização/escape XML
// - Filtros para só incluir /post/ no feed
//
// Observações de UX (heurística):
// - Descrição curta e limpa (meta description/OG, ou 1º parágrafo como fallback), com limite suave
// - Título sempre textual, nunca URL

import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { XMLParser } from 'fast-xml-parser';
import { load as loadHTML } from 'cheerio';

/* =========
 * Config
 * =========
 * Ajuste via variáveis de ambiente se necessário (feeds.yml)
 */
const SOURCE_SITEMAP = process.env.SOURCE_SITEMAP || 'https://www.seumestrefinanceiro.com.br/sitemap.xml';
const SITE_LINK      = process.env.SITE_LINK      || 'https://www.seumestrefinanceiro.com.br';
const PUBLICATION    = process.env.PUBLICATION    || 'Seu Mestre Financeiro';
const PUB_LANG       = process.env.PUB_LANG       || 'pt';           // ISO-639 (ex.: pt)
const FEED_SELF_URL  = process.env.FEED_SELF_URL  || 'https://git.seumestrefinanceiro.com.br/rss.xml';

const MAX_RSS_ITEMS  = Number(process.env.MAX_RSS_ITEMS  || 50);
const NEWS_WINDOW_MS = Number(process.env.NEWS_WINDOW_MS || 48 * 3600 * 1000); // 48h (Google News)
const FETCH_TIMEOUT  = Number(process.env.FETCH_TIMEOUT  || 15000);            // 15s por URL
const MAX_CONCURRENCY= Number(process.env.MAX_CONCURRENCY|| 8);                // scraping paralelo

/* =========
 * Utils
 * ========= */
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&apos;');

function truncateWords(str, max = 200) {
  if (!str) return '';
  const clean = str.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  // evita cortar palavra no meio
  const cut = clean.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut.slice(0, max)).trim() + '…';
}

function isPostUrl(u) {
  // Ajuste aqui se o padrão de URLs de posts mudar
  return /^https:\/\/www\.seumestrefinanceiro\.com\.br\/post\//.test(u);
}

async function getText(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ac.signal });
    if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

/* ==========================
 * 1) Carrega sitemap do WWW
 * ========================== */
async function fetchSitemapPostUrls() {
  const xml = await getText(SOURCE_SITEMAP);
  const parser = new XMLParser({ ignoreAttributes: false });
  const data = parser.parse(xml);
  const raw = data?.urlset?.url || [];
  const urls = (Array.isArray(raw) ? raw : [raw])
    .map(u => (typeof u?.loc === 'string' ? u.loc : u?.loc?.['#text']))
    .filter(Boolean)
    .filter(isPostUrl);

  // URLs absolutas apenas; RSS e News exigem URLs absolutas. (boa prática)
  // https://kevincox.ca/2022/05/06/rss-feed-best-practices/
  return Array.from(new Set(urls));
}

/* ======================================
 * 2) Raspagem de título/descrição/data
 * ====================================== */
async function scrapeArticle(url) {
  try {
    const html = await getText(url);
    const $ = loadHTML(html);

    // Título: og:title -> h1 -> <title>
    const ogTitle = $('meta[property="og:title"]').attr('content');
    const h1      = $('h1').first().text().trim();
    const titleTag= $('title').first().text().trim();
    const title   = (ogTitle || h1 || titleTag || url).trim();

    // Descrição: meta description -> og:description -> 1º parágrafo como fallback
    const metaDesc= $('meta[name="description"]').attr('content');
    const ogDesc  = $('meta[property="og:description"]').attr('content');
    let desc      = (metaDesc || ogDesc || '').trim();
    if (!desc) {
      const p = $('article p, main p, .post p, p').first().text().trim();
      desc = truncateWords(p, 220);
    } else {
      desc = truncateWords(desc, 220);
    }

    // Data de publicação: meta article:published_time -> JSON-LD datePublished -> <time datetime>
    let published =
      $('meta[property="article:published_time"]').attr('content') ||
      $('meta[name="article:published_time"]').attr('content') ||
      null;

    if (!published) {
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const json = $(el).contents().text();
          const obj  = JSON.parse(json);
          const arr  = Array.isArray(obj) ? obj : [obj];
          for (const it of arr) {
            if (it?.datePublished) { published = it.datePublished; break; }
          }
        } catch {/* ignora blocos inválidos */}
      });
    }
    if (!published) {
      const t = $('time[datetime]').attr('datetime');
      if (t) published = t;
    }

    const pubDate = published ? new Date(published) : null;
    return { url, title, desc, date: pubDate };
  } catch (e) {
    // Falhou a raspagem? Ainda devolve algo para RSS (sem data/desc) – News só entra com data válida
    return { url, title: url, desc: '', date: null };
  }
}

/* ====================================
 * 3) Builders: RSS 2.0 e News Sitemap
 * ==================================== */

// RSS 2.0 — pubDate em RFC-822; ttl; atom:link rel="self"
// Especificação/boas práticas: rssboard.org / W3C Feed Validator
// https://www.rssboard.org/rss-specification
// https://www.rssboard.org/rss-profile
// https://validator.w3.org/feed/docs/warning/MissingAtomSelfLink.html
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
  <language>${esc(PUB_LANG)}</language>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
  <ttl>60</ttl>
  <atom:link href="${esc(feedSelfUrl)}" rel="self" type="application/rss+xml"/>
${bodyItems}
</channel>
</rss>`;
}

// News Sitemap — ≤48h, até 1000 URLs, campos obrigatórios
// https://developers.google.com/search/docs/crawling-indexing/sitemaps/news-sitemap
function buildNewsSitemap(publicationName, lang, articles, windowMs) {
  const cutoff = Date.now() - windowMs;
  const fresh = articles
    .filter(a => a.date && a.date.getTime() >= cutoff) // só ≤48h e com data válida
    .sort((a, b) => b.date - a.date)
    .slice(0, 1000);

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
      <news:title>${esc(truncateWords(a.title, 160))}</news:title>
    </news:news>
  </url>`).join('\n');

  return `${header}
${urlsetOpen}
${body}
</urlset>`;
}

/* ==========================
 * 4) Execução com paralelismo
 * ========================== */
async function run() {
  const urls = await fetchSitemapPostUrls();

  // batching simples p/ limitar concorrência
  const metas = [];
  for (let i = 0; i < urls.length; i += MAX_CONCURRENCY) {
    const slice = urls.slice(i, i + MAX_CONCURRENCY);
    const batch = await Promise.all(slice.map(scrapeArticle));

    // Respeito leve entre lotes para evitar bursts no host
    await sleep(150);
    metas.push(...batch);
  }

  // Ordena por data desc; aplica fallback de data (apenas para ordenar RSS)
  const ordered = metas.map(m => ({ ...m, date: m.date || new Date(0) }))
                       .sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));

  // RSS = até N itens mais recentes (inclui itens sem data, mas com título/link/desc)
  const rssItems = ordered
    .filter(i => !!i.title && !!i.url)
    .slice(0, MAX_RSS_ITEMS);

  const rssXml = buildRSS(PUBLICATION, SITE_LINK, rssItems, FEED_SELF_URL);
  await fs.writeFile(path.resolve('rss.xml'), rssXml, 'utf8');

  // News = só itens com data real e ≤48h
  const newsXml = buildNewsSitemap(PUBLICATION, PUB_LANG, metas, NEWS_WINDOW_MS);
  await fs.writeFile(path.resolve('sitemap-news.xml'), newsXml, 'utf8');

  const newsCount = metas.filter(a => a.date && (Date.now() - a.date.getTime()) <= NEWS_WINDOW_MS).length;

  console.log(`rss.xml: ${rssItems.length} itens | sitemap-news.xml: ${newsCount} artigos (<= ${Math.round(NEWS_WINDOW_MS/3600000)}h)`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
