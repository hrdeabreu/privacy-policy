// build-feeds.mjs
// Gera rss.xml (RSS 2.0 + Media RSS), sitemap-news.xml (Google News, ≤48h)
// e opcionalmente image-sitemap.xml (Image Sitemaps).
//
// Normas / referências essenciais:
// - RSS 2.0 (image width<=144 default=88; height<=400 default=31; pubDate RFC-822; ttl; atom:link rel="self"):
//   https://www.rssboard.org/rss-specification  |  https://cyber.harvard.edu/rss/rss.html
// - Media RSS (imagens por item, xmlns:media):
//   https://www.rssboard.org/media-rss
// - Google News Sitemap (≤48h; publication, publication_date ISO-8601; title):
//   https://developers.google.com/search/docs/crawling-indexing/sitemaps/news-sitemap
// - Image Sitemaps (image:image / image:loc; antigas tags de imagem deprecadas):
//   https://developers.google.com/search/docs/crawling-indexing/sitemaps/image-sitemaps
// - Sitemaps: URLs absolutas, UTF-8, entity-escaped:
//   https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap
//   https://www.sitemaps.org/protocol.html
//
// Requisitos: Node 20+ (fetch nativo), pacotes: cheerio, fast-xml-parser.

import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { load as loadHTML } from 'cheerio';

/* =========
 * Config
 * =========
 * Ajuste via variáveis de ambiente no workflow (feeds.yml).
 */
const SOURCE_SITEMAP   = process.env.SOURCE_SITEMAP   || 'https://www.seumestrefinanceiro.com.br/sitemap.xml';
const SITE_LINK        = process.env.SITE_LINK        || 'https://www.seumestrefinanceiro.com.br';
const PUBLICATION      = process.env.PUBLICATION      || 'Seu Mestre Financeiro';
const PUB_LANG         = process.env.PUB_LANG         || 'pt'; // ISO-639
const FEED_SELF_URL    = process.env.FEED_SELF_URL    || 'https://git.seumestrefinanceiro.com.br/rss.xml';

// Logo do canal no RSS (elemento <image>):
// Especificação RSS 2.0: width default=88 (máx. 144), height default=31 (máx. 400).
const CHANNEL_LOGO_URL = process.env.CHANNEL_LOGO_URL || 'http://git.seumestrefinanceiro.com.br/SeuMestreFinanceiro-LogoRSS.png'; // se vazio, não inclui <image>
const CHANNEL_IMAGE_WIDTH  = 88;  // default da norma
const CHANNEL_IMAGE_HEIGHT = 31;  // default da norma

// Limites e desempenho:
const MAX_RSS_ITEMS    = Number(process.env.MAX_RSS_ITEMS  || 50);
const NEWS_WINDOW_MS   = Number(process.env.NEWS_WINDOW_MS || 48 * 3600 * 1000); // 48h
const FETCH_TIMEOUT    = Number(process.env.FETCH_TIMEOUT  || 15000);            // 15s por URL
const MAX_CONCURRENCY  = Number(process.env.MAX_CONCURRENCY|| 8);

// Image Sitemap opcional:
const ENABLE_IMAGE_SITEMAP = String(process.env.ENABLE_IMAGE_SITEMAP || 'true').toLowerCase() === 'true';
const MAX_IMAGES_PER_URL   = Number(process.env.MAX_IMAGES_PER_URL || 5); // por página no image-sitemap

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
  const cut = clean.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut.slice(0, max)).trim() + '…';
}

function isPostUrl(u) {
  // Ajuste se o padrão de posts mudar
  return /^https:\/\/www\.seumestrefinanceiro\.com\.br\/post\//.test(u);
}

function toAbsUrl(possiblyRelative, base) {
  try {
    return new URL(possiblyRelative, base).toString();
  } catch {
    return null;
  }
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

  // URLs absolutas apenas
  return Array.from(new Set(urls));
}

/* ======================================
 * 2) Raspagem de título/descrição/data/img
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

    // Imagem principal: og:image -> twitter:image -> link[rel=image_src] -> primeira <img> do artigo
    let img =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      $('link[rel="image_src"]').attr('href') ||
      null;

    if (!img) {
      const imgEl = $('article img, main img, .post img, img').first().attr('src');
      if (imgEl) img = imgEl;
    }

    const imageAbs = img ? toAbsUrl(img, url) : null;

    // Colete demais imagens (para image-sitemap opcional)
    const allImg = new Set();
    if (imageAbs) allImg.add(imageAbs);
    $('article img, main img, .post img, img').each((_, el) => {
      const s = $(el).attr('src');
      const abs = s ? toAbsUrl(s, url) : null;
      if (abs) allImg.add(abs);
    });
    const images = Array.from(allImg).slice(0, MAX_IMAGES_PER_URL);

    return { url, title, desc, date: pubDate, image: imageAbs, images };
  } catch {
    return { url, title: url, desc: '', date: null, image: null, images: [] };
  }
}

/* ====================================
 * 3) Builders: RSS 2.0 / News / Image
 * ==================================== */

// RSS 2.0 com Media RSS (xmlns:media). Inclui <image> opcional do canal.
// - width default=88 (máx. 144), height default=31 (máx. 400) por norma.
// - atom:link rel="self" evita warnings em validadores.
function buildRSS(channelTitle, channelLink, items, feedSelfUrl, channelLogoUrl) {
  const header = `<?xml version="1.0" encoding="UTF-8"?>`;
  const ns = [
    `xmlns:atom="http://www.w3.org/2005/Atom"`,
    `xmlns:media="http://search.yahoo.com/mrss/"`
  ].join(' ');

  const channelImage = channelLogoUrl ? `
  <image>
    <url>${esc(channelLogoUrl)}</url>
    <title>${esc(channelTitle)}</title>
    <link>${esc(channelLink)}</link>
    <width>${CHANNEL_IMAGE_WIDTH}</width>
    <height>${CHANNEL_IMAGE_HEIGHT}</height>
  </image>` : '';

  const bodyItems = items.map(it => `
  <item>
    <title>${esc(it.title)}</title>
    <link>${esc(it.url)}</link>
    <guid isPermaLink="true">${esc(it.url)}</guid>
    ${it.date ? `<pubDate>${new Date(it.date).toUTCString()}</pubDate>` : ''}
    ${it.desc ? `<description>${esc(it.desc)}</description>` : ''}
    ${it.image ? `<media:content url="${esc(it.image)}" medium="image" />` : ''}
  </item>`).join('\n');

  return `${header}
<rss version="2.0" ${ns}>
<channel>
  <title>${esc(channelTitle)}</title>
  <link>${esc(channelLink)}</link>
  <description>${esc(channelTitle)}</description>
  ${channelImage}
  <language>${esc(PUB_LANG)}</language>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
  <ttl>60</ttl>
  <atom:link href="${esc(feedSelfUrl)}" rel="self" type="application/rss+xml"/>
${bodyItems}
</channel>
</rss>`;
}

// Google News Sitemap — somente artigos ≤48h; elementos obrigatórios.
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

// Image Sitemap opcional — inclui apenas image:loc (tags antigas de imagem deprecadas).
function buildImageSitemap(pages) {
  const header = `<?xml version="1.0" encoding="UTF-8"?>`;
  const urlsetOpen =
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
    `        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">`;

  const body = pages.map(p => {
    const imgs = (p.images || []).map(src => `
    <image:image>
      <image:loc>${esc(src)}</image:loc>
    </image:image>`).join('');
    if (!imgs) return '';
    return `
  <url>
    <loc>${esc(p.url)}</loc>${imgs}
  </url>`;
  }).filter(Boolean).join('\n');

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

  // scraping com lotes para limitar concorrência
  const metas = [];
  for (let i = 0; i < urls.length; i += MAX_CONCURRENCY) {
    const slice = urls.slice(i, i + MAX_CONCURRENCY);
    const batch = await Promise.all(slice.map(scrapeArticle));
    metas.push(...batch);
    // respiro leve entre lotes (evita burst no host)
    await sleep(150);
  }

  // Ordena por data desc; para RSS pode aceitar itens sem data (ficam no fim)
  const ordered = metas
    .map(m => ({ ...m, sortDate: m.date ? m.date.getTime() : 0 }))
    .sort((a, b) => b.sortDate - a.sortDate);

  // RSS = até N itens mais recentes (com título/link/desc). Itens sem data são permitidos.
  const rssItems = ordered.slice(0, MAX_RSS_ITEMS);

  const rssXml = buildRSS(PUBLICATION, SITE_LINK, rssItems, FEED_SELF_URL, CHANNEL_LOGO_URL);
  await fs.writeFile(path.resolve('rss.xml'), rssXml, 'utf8');

  // News = só itens com data real e ≤48h
  const newsXml = buildNewsSitemap(PUBLICATION, PUB_LANG, metas, NEWS_WINDOW_MS);
  await fs.writeFile(path.resolve('sitemap-news.xml'), newsXml, 'utf8');

  // (Opcional) Image Sitemap — agrega imagens coletadas por página (máx. configurável).
  if (ENABLE_IMAGE_SITEMAP) {
    const pagesWithImgs = metas
      .map(m => ({ url: m.url, images: m.images }))
      .filter(p => p.images && p.images.length > 0);
    const imgXml = buildImageSitemap(pagesWithImgs);
    await fs.writeFile(path.resolve('image-sitemap.xml'), imgXml, 'utf8');
  }

  const newsCount = metas.filter(a => a.date && (Date.now() - a.date.getTime()) <= NEWS_WINDOW_MS).length;
  const pagesWithImg = metas.filter(m => m.images && m.images.length).length;
  console.log(`rss.xml: ${rssItems.length} itens | sitemap-news.xml: ${newsCount} artigos (<= ${Math.round(NEWS_WINDOW_MS/3600000)}h) | image-sitemap páginas com img: ${pagesWithImg}`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
