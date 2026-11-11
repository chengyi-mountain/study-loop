/**
 * 学习闭环 · 目录抓取服务（Cloudflare Worker 版）
 * 一次部署，手机和电脑都能自动抓目录；零依赖，单文件。
 *
 * 部署三步（全程网页操作）：
 *   1. 打开 https://dash.cloudflare.com → Workers & Pages → Create → Worker
 *   2. 把本文件内容全选粘贴进去，Deploy
 *   3. 复制给你生成的地址（形如 https://outline-fetcher.xxx.workers.dev），
 *      填到网页「导入弹框 → 抓取服务」里
 *
 * 接口：
 *   GET /health
 *   GET /outline?book=书名[&format=text]
 *   GET /search?book=书名
 *
 * 数据来源：微信读书公开的书籍页（页面 HTML 内嵌了 chapterInfos 目录），无需登录。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const CACHE = new Map();                 // 同一 isolate 内的内存缓存
const CACHE_TTL = 30 * 60 * 1000;        // 30 分钟

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '86400'
};

function json(body, code) {
  return new Response(JSON.stringify(body), {
    status: code || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS)
  });
}

async function jget(url, ref) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': ref || 'https://weread.qq.com/' } });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) { j = null; }
  return { status: r.status, text: text, json: j };
}

/** 从 HTML 里抠出 "chapterInfos":[...]（括号配对） */
function sliceChapterInfos(html) {
  const at = html.indexOf('"chapterInfos":');
  if (at < 0) return null;
  const start = html.indexOf('[', at);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

const NOISE = /^(版权信息|版权页|封面|书名页|扉页|目录|插图|插页|图片|彩插|关于作者|内容简介|作者简介|译者简介)/;

function normTitle(x) {
  return String(x || '').replace(/[\s（(【\[].*?[）)】\]]/g, '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').toLowerCase();
}

/** 从“太乙金华宗旨-白话版”这类标题里取出分部名 */
function partName(title, bookTitle) {
  const m = String(title).match(/[-—·:：]\s*(白话版|原文|英文版|中文版|上册|下册|修订版|全集|节选|第[一二三四五六七八九十]+版)$/);
  if (m) return m[1];
  return '';
}

/** 清洗目录：去噪声、去“书名当第一章”、同一卷名跨分部时加前缀 */
function cleanChapters(list, bookTitle) {
  const bookNorm = normTitle(bookTitle);
  const picked = [];
  let parent = '';

  (list || []).forEach(function (c) {
    const title = String(c.title || '').trim();
    if (!title) return;
    if (NOISE.test(title)) return;
    const nt = normTitle(title);
    const lv = c.level || 1;

    if (lv === 1 && (nt === bookNorm || nt === normTitle(bookTitle.replace(/[-—·（(].*$/, '')))) {
      parent = partName(title, bookTitle);
      if (parent) picked.push({ title: parent, level: 1, parent: '' });
      return;
    }
    if (lv === 1) parent = '';
    picked.push({ title: title, level: lv, parent: parent });
  });

  const count = {};
  picked.forEach(function (p) { const k = normTitle(p.title); count[k] = (count[k] || 0) + 1; });
  const seen = {};
  const out = [];
  picked.forEach(function (p) {
    const k = normTitle(p.title);
    let t = p.title;
    if (count[k] > 1 && p.parent) t = p.parent + ' · ' + p.title;
    if (seen[t]) return;
    seen[t] = 1;
    out.push({ title: t, level: p.level });
  });
  return out;
}

/** 抓一本具体的书：页面里抠 chapterInfos → 清洗；拿不到返回 null */
async function parseBook(b) {
  const page = await jget(b.readerLink);
  const infos = sliceChapterInfos(page.text);
  if (!infos || !infos.length) return null;
  const chs = cleanChapters(infos, b.title);
  if (chs.length < 2) return null;
  return chs;
}

function bookMeta(b) {
  return {
    title: b.title, author: b.author || '', publisher: b.publisher || '',
    intro: String(b.intro || '').slice(0, 220), bookId: b.bookId, readerLink: b.readerLink
  };
}

async function outlineByName(name) {
  const kw = String(name || '').trim();
  if (!kw) return { ok: false, reason: '书名是空的' };
  if (kw.length > 40) return { ok: false, reason: '书名太长' };

  const cached = CACHE.get(kw);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.value;

  const s = await jget('https://weread.qq.com/web/search/global?keyword=' + encodeURIComponent(kw) + '&maxIdx=0&fragmentSize=120&count=8');
  const books = (((s.json || {}).books) || [])
    .map(function (x) { return x.bookInfo || {}; })
    .filter(function (b) { return b.bookId && b.readerLink; });
  if (!books.length) {
    const miss = { ok: false, reason: '微信读书里没搜到这本书', candidates: [] };
    CACHE.set(kw, { at: Date.now(), value: miss });
    return miss;
  }

  const q = normTitle(kw);
  const ranked = books.map(function (b) {
    const t = normTitle(b.title);
    let score = 10;
    if (t === q) score = 100;
    else if (t.indexOf(q) === 0) score = 80;
    else if (t.indexOf(q) > -1) score = 60;
    else if (q.indexOf(t) > -1) score = 40;
    return { b: b, score: score };
  }).sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return ((b.b.newRatingCount || 0) + (b.b.readingCount || 0)) - ((a.b.newRatingCount || 0) + (a.b.readingCount || 0));
  });

  const candidates = books.map(function (b) { return b.title; });
  // 相关性门槛：书名里没有关键词的（score 10）不算命中
  const usable = ranked.filter(function (x) { return x.score >= 40; });
  let firstBook = null;
  let value = null;

  if (!usable.length) {
    value = { ok: false, reason: '没搜到书名相近的书', book: null, candidates: candidates };
  } else {
    for (let i = 0; i < Math.min(3, usable.length); i++) {
      const b = usable[i].b;
      if (!firstBook) firstBook = b;
      const chs = await parseBook(b);
      if (chs) {
        value = {
          ok: true, source: 'weread', book: bookMeta(b), candidates: candidates,
          chapters: chs.map(function (c, idx) { return { n: idx + 1, title: c.title, level: c.level }; })
        };
        break;
      }
    }
  }

  if (!value) {
    value = {
      ok: false,
      reason: '搜到的前几本都没有公开目录（付费/受限/还没上架目录）',
      book: firstBook ? bookMeta(firstBook) : null,
      candidates: candidates
    };
  }
  CACHE.set(kw, { at: Date.now(), value: value });
  return value;
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const u = new URL(request.url);
    const book = (u.searchParams.get('book') || u.searchParams.get('q') || '').trim();

    try {
      if (u.pathname === '/health') return json({ ok: true, service: 'outline-fetcher', mode: 'worker' });

      if (u.pathname === '/search') {
        if (!book) return json({ ok: false, reason: '需要 ?book=书名' }, 400);
        const r = await outlineByName(book);
        return json({ ok: true, book: book, candidates: r.candidates || [], matched: (r.book || {}).title || '' });
      }

      if (u.pathname === '/outline' || u.pathname === '/') {
        if (!book) return json({ ok: false, reason: '需要 ?book=书名' }, 400);
        const t0 = Date.now();
        const r = await outlineByName(book);
        r.ms = Date.now() - t0;
        if (u.searchParams.get('format') === 'text' && r.ok) {
          const txt = r.chapters.map(function (c) { return c.title; }).join('\n');
          return new Response(txt, { headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, CORS) });
        }
        return json(r);
      }

      return json({ ok: false, reason: '未知接口，可用：/health /outline?book= /search?book=' }, 404);
    } catch (e) {
      return json({ ok: false, reason: '抓取出错：' + (e && e.message) }, 500);
    }
  }
};
