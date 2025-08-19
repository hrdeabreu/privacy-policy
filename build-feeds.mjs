// build-feeds.mjs — gera rss.xml e sitemap-news.xml a partir do sitemap do www
import fs from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';

const SOURCE_SITEMAP = process.env.SOURCE_SITEMAP || 'https://www.seumestrefinanceiro.com.br/sitemap.xml';
const SITE_URL = 'https://www.seumestrefinanceiro.com.br';
const PUBLICATION_NAME = process.env.PUBLICATION_NAME || 'Seu Mestre Financeiro';
const PUB_LANG = process.env.PUB_LANG || 'pt';
const TWO_DAYS = 48 * 3600 * 1000;

const esc = s => String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

async function get(url){const r=await fetch(url);if(!r.ok)throw new Error(url+': '+r.status);return r.text();}
async function fetchUrls(){
  const xml = await get(SOURCE_SITEMAP);
  const p = new XMLParser({ignoreAttributes:false});
  const data = p.parse(xml);
  const list = (data.urlset?.url||[]).map(u=>({
    loc: typeof u.loc==='string'?u.loc:u.loc?.['#text'],
    lastmod: u.lastmod?new Date(u.lastmod):null
  })).filter(x=>x.loc);
  return list.map(x=>x.loc);
}
async function fetchMeta(url){
  try{
    const html = await get(url);
    const title = /<meta property="og:title" content="([^"]+)"/i.exec(html)?.[1]
               || /<title>([^<]+)<\/title>/i.exec(html)?.[1]
               || url;
    const published = /<meta[^>]+(article:published_time|datePublished)[^>]+content="([^"]+)"/i.exec(html)?.[2]
                   || /<time[^>]+datetime="([^"]+)"/i.exec(html)?.[1];
    return {url, title, date: published?new Date(published):null};
  }catch{return {url, title:url, date:null};}
}
function rss(items){
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${esc(PUBLICATION_NAME)}</title>
<link>${esc(SITE_URL)}</link>
<description>${esc(PUBLICATION_NAME)}</description>
<language>${esc(PUB_LANG)}</language>
<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items.map(i=>`<item><title>${esc(i.title)}</title><link>${esc(i.url)}</link><guid>${esc(i.url)}</guid>${i.date?`<pubDate>${new Date(i.date).toUTCString()}</pubDate>`:''}</item>`).join('\n')}
</channel></rss>`;
}
function news(items){
  const cutoff = Date.now()-TWO_DAYS;
  const fresh = items.filter(i=>i.date && i.date.getTime()>=cutoff);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${fresh.map(i=>`<url><loc>${esc(i.url)}</loc><news:news>
<news:publication><news:name>${esc(PUBLICATION_NAME)}</news:name><news:language>${esc(PUB_LANG)}</news:language></news:publication>
<news:publication_date>${new Date(i.date).toISOString()}</news:publication_date>
<news:title>${esc(i.title)}</news:title>
</news:news></url>`).join('\n')}
</urlset>`;
}
(async()=>{
  const urls = await fetchUrls();
  const metas = [];
  for(const u of urls) metas.push(await fetchMeta(u));
  metas.sort((a,b)=>(b.date?.getTime()||0)-(a.date?.getTime()||0));
  const last50 = metas.slice(0,50);
  await fs.writeFile('rss.xml', rss(last50), 'utf8');
  await fs.writeFile('sitemap-news.xml', news(metas), 'utf8');
  console.log(`OK rss=${last50.length} news(<=48h)=${metas.filter(m=>m.date && (Date.now()-m.date.getTime())<=TWO_DAYS).length}`);
})();
