#!/usr/bin/env node
/* 学习闭环 · 目录抓取助手（本地版）
 * 零依赖，Node 18+：node local.js
 * 起一个本地小服务，页面里的「查章节」就能直接联网拿到整本目录。
 *
 * ⚠️ 使用边界（用之前请先认同，详见同目录 README.md）
 *   · 仅限个人学习自用；不要用于商业产品、对外提供接口、批量采集
 *   · 只读公开页面上的目录标题，不下载正文，不绕过付费墙/会员限制
 *   · 请遵守目标站点的服务条款与 robots 协议；权利人提出异议请立即停止使用
 *   · 按"现状"提供，MIT 许可、无任何担保（见仓库根目录 LICENSE）
 *
 * 接口：
 *   GET /health                         探活
 *   GET /outline?book=书名               返回 JSON { ok, book, chapters:[{n,title,level}] }
 *   GET /outline?book=书名&format=text   返回纯文本目录（一行一章，可直接粘到导入框）
 *   GET /search?book=书名                只返回候选书名列表
 */
'use strict';

const http = require('http');
const PORT = Number(process.env.PORT) || 8765;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/* ---------------- 抓取核心（微信读书公开数据，无需登录） ---------------- */

async function jget(url, ref) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': ref || 'https://weread.qq.com/' } });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch (e) { j = null; }
  return { status: r.status, text: t, json: j };
}

/** 从页面 HTML 里抠出 "chapterInfos":[...]（括号配对，不要求整页是合法 JSON） */
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

/** 从“太乙金华宗旨-白话版”这类标题里取出分部名（白话版 / 原文 / 上册 …） */
function partName(title, bookTitle) {
  const m = String(title).match(/[-—·:：]\s*(白话版|原文|英文版|中文版|上册|下册|修订版|全集|节选|第[一二三四五六七八九十]+版)$/);
  if (m) return m[1];
  if (normTitle(title) === normTitle(bookTitle)) return '';
  return '';
}

/**
 * 清洗目录：去噪声、去“书名当成第一章”、按分部保留重复的卷名。
 * 同一标题出现在多个分部时，用分部前缀区分（白话版 · 卷一 天心 / 原文 · 卷一 天心）。
 */
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

    // 一级标题正好等于书名 → 它是分部的“壳”，把分部名当父级记下来
    if (lv === 1 && (nt === bookNorm || nt === normTitle(bookTitle.replace(/[-—·（(].*$/, '')))) {
      parent = partName(title, bookTitle);
      if (parent) picked.push({ title: parent, level: 1, parent: '' });
      return;
    }
    if (lv === 1) parent = '';
    picked.push({ title: title, level: lv, parent: parent });
  });

  // 同标题在多分部重复 → 加前缀区分；否则原样
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

/** 按书名抓全书目录：候选前三本依次试，谁有公开目录用谁 */
async function outlineByName(name) {
  const kw = String(name || '').trim();
  if (!kw) return { ok: false, reason: '书名是空的' };
  if (kw.length > 40) return { ok: false, reason: '书名太长' };

  const s = await jget('https://weread.qq.com/web/search/global?keyword=' + encodeURIComponent(kw) + '&maxIdx=0&fragmentSize=120&count=8');
  const books = (((s.json || {}).books) || [])
    .map(function (x) { return x.bookInfo || {}; })
    .filter(function (b) { return b.bookId && b.readerLink; });
  if (!books.length) return { ok: false, reason: '微信读书里没搜到这本书', candidates: [] };

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
  // 相关性门槛：书名里连关键词都没有的（score 10）不算命中，免得把不相干的书当成本书
  const usable = ranked.filter(function (x) { return x.score >= 40; });
  if (!usable.length) {
    return { ok: false, reason: '没搜到书名相近的书', book: null, candidates: candidates };
  }

  let firstBook = null;

  for (let i = 0; i < Math.min(3, usable.length); i++) {
    const b = usable[i].b;
    if (!firstBook) firstBook = b;
    const chs = await parseBook(b);
    if (chs) {
      return {
        ok: true, source: 'weread', book: bookMeta(b), candidates: candidates,
        chapters: chs.map(function (c, idx) { return { n: idx + 1, title: c.title, level: c.level }; })
      };
    }
  }

  return {
    ok: false,
    reason: '搜到的前几本都没有公开目录（付费/受限/还没上架目录）',
    book: firstBook ? bookMeta(firstBook) : null,
    candidates: candidates
  };
}

/* ---------------- 本地 HTTP 服务 ---------------- */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '86400'
};

function send(res, code, body, type) {
  res.writeHead(code, Object.assign({
    'Content-Type': (type || 'application/json') + '; charset=utf-8',
    'Cache-Control': 'no-store'
  }, CORS));
  res.end(body);
}

const server = http.createServer(async function (req, res) {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  const u = new URL(req.url, 'http://127.0.0.1:' + PORT);
  const book = (u.searchParams.get('book') || u.searchParams.get('q') || '').trim();

  try {
    if (u.pathname === '/health') {
      return send(res, 200, JSON.stringify({ ok: true, service: 'outline-fetcher', mode: 'local', port: PORT }));
    }

    if (u.pathname === '/search') {
      if (!book) return send(res, 400, JSON.stringify({ ok: false, reason: '需要 ?book=书名' }));
      const r = await outlineByName(book);
      return send(res, 200, JSON.stringify({ ok: true, book: book, candidates: r.candidates || [], matched: (r.book || {}).title || '' }));
    }

    if (u.pathname === '/outline' || u.pathname === '/') {
      if (!book) return send(res, 400, JSON.stringify({ ok: false, reason: '需要 ?book=书名' }));
      const t0 = Date.now();
      const r = await outlineByName(book);
      r.ms = Date.now() - t0;
      console.log('[抓取] ' + book + ' → ' + (r.ok ? r.chapters.length + ' 章' : '失败：' + r.reason) + ' (' + r.ms + 'ms)');
      if (u.searchParams.get('format') === 'text' && r.ok) {
        const txt = r.chapters.map(function (c) { return c.title; }).join('\n');
        return send(res, 200, txt, 'text/plain');
      }
      return send(res, 200, JSON.stringify(r));
    }

    send(res, 404, JSON.stringify({ ok: false, reason: '未知接口，可用：/health /outline?book= /search?book=' }));
  } catch (e) {
    console.error('[错误]', e && e.message);
    send(res, 500, JSON.stringify({ ok: false, reason: '抓取出错：' + (e && e.message) }));
  }
});

server.listen(PORT, '127.0.0.1', function () {
  console.log('');
  console.log('  学习闭环 · 目录抓取助手  已启动');
  console.log('  地址： http://127.0.0.1:' + PORT);
  console.log('  自测： http://127.0.0.1:' + PORT + '/outline?book=' + encodeURIComponent('认知天性'));
  console.log('  纯文本目录： 末尾加 &format=text');
  console.log('');
  console.log('  把上面这个地址填到网页「导入弹框 → 抓取服务」里，之后输入书名就能自动出目录。');
  console.log('  这个窗口别关；关掉网页就退回复制粘贴。');
  console.log('');
});

module.exports = { outlineByName, sliceChapterInfos, cleanChapters };
