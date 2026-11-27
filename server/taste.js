/*
 * 「猜你想看」：书架默认的排序依据。
 *
 * 两个信号，都是读者自己的行为，不需要联网也不需要模型：
 *
 * 1. 书名里反复出现的词。八百本书里有两百本叫《红楼梦》某回，那这个词就是
 *    这一柜子里最热的一类，含它的书排在前面。词表复用 series.detect：它已经
 *    挡掉了「全集」「上册」这类噪声，也解决了「西游」被「西游记」覆盖的问题。
 * 2. 搜过的词。同一个词被搜得越多，说明越惦记——直接命中书名/作者的加满分，
 *    只是同属一类的加四成分。日志只存词与次数，不存时间线，也不上传。
 *
 * 同一个词在 30 秒内被连续搜过（输入法一个字一个字上屏：红 → 红楼 → 红楼梦），
 * 后一个会把前一个并进来，不会把「红」和「红楼梦」记成两次不同的搜索。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const series = require('./series');

// 日志只留最常用的两百个词，剩下的自然淘汰。
const MAX_TERMS = 200;
const MIN_TERM = 2;
const MAX_TERM = 30;
const COUNT_CAP = 999;
// 前缀合并窗口：这么短时间内出现的词视为同一个词还没打完。
const MERGE_WINDOW = 30 * 1000;
// 一次搜索给 4 分；搜 1 次 4 分、3 次 8 分、15 次 16 分，边际递减。
const SEARCH_UNIT = 4;
// 只是「同属一类」的书拿四成，避免搜一个词就把整组顶到最前。
const RELATED_SHARE = 0.4;
// 参与算分的词组上限。detect 本身按热度排序，取前 400 已覆盖长尾。
const MAX_VOCAB = 400;
// 排序时最多看多少个搜索词。
const MAX_BOOST_TERMS = 30;

/* ---------- stored log ---------- */

function emptyState() {
  return { terms: {}, rev: 0 };
}

function cleanTerm(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TERM);
}

function cleanState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object' || !raw.terms || typeof raw.terms !== 'object') return state;
  Object.keys(raw.terms).forEach(key => {
    const item = raw.terms[key];
    if (!item || typeof item !== 'object') return;
    const q = cleanTerm(item.q || key);
    if (q.length < MIN_TERM) return;
    const count = Math.max(1, Math.min(COUNT_CAP, Math.round(Number(item.count) || 0)));
    state.terms[q.toLowerCase()] = {
      q: q,
      count: count,
      lastAt: typeof item.lastAt === 'string' ? item.lastAt : ''
    };
  });
  state.rev = 1;
  return state;
}

async function load(cfg) {
  try {
    return cleanState(JSON.parse(await fsp.readFile(path.join(cfg.dataDir, 'searches.json'), 'utf8')));
  } catch (e) {
    return emptyState();
  }
}

let writeChain = Promise.resolve();
function save(cfg, state) {
  const file = path.join(cfg.dataDir, 'searches.json');
  const tmp = file + '.tmp';
  const payload = JSON.stringify({ terms: state.terms }, null, 2);
  writeChain = writeChain
    .then(() => fsp.writeFile(tmp, payload, 'utf8'))
    .then(() => fsp.rename(tmp, file))
    .catch(() => {});
  return writeChain;
}

/* ---------- recording ---------- */

// 词表按次数留前 MAX_TERMS 个，次数相同留更近的。
function prune(state) {
  const keys = Object.keys(state.terms);
  if (keys.length <= MAX_TERMS) return;
  keys
    .sort((a, b) => (state.terms[b].count - state.terms[a].count) ||
      String(state.terms[b].lastAt).localeCompare(String(state.terms[a].lastAt)))
    .slice(MAX_TERMS)
    .forEach(k => { delete state.terms[k]; });
}

/**
 * 记一次搜索。返回记下的那条，词太短或为空时返回 null。
 * @param {{terms:Object,rev:number}} state
 * @param {string} rawQ
 * @param {number} [now]
 */
function record(state, rawQ, now) {
  const at = Number.isFinite(now) ? now : Date.now();
  const q = cleanTerm(rawQ);
  if (q.length < MIN_TERM) return null;
  const key = q.toLowerCase();

  // 还没打完的前缀并进来，别把「红楼」和「红楼梦」记成两次。
  let carried = 0;
  Object.keys(state.terms).forEach(k => {
    if (k === key) return;
    const other = state.terms[k];
    const last = other.lastAt ? Date.parse(other.lastAt) : 0;
    const fresh = Number.isFinite(last) && at - last < MERGE_WINDOW;
    if (fresh && (key.startsWith(k) || k.startsWith(key))) {
      carried += other.count;
      delete state.terms[k];
    }
  });

  const base = state.terms[key] ? state.terms[key].count : 0;
  state.terms[key] = {
    q: q,
    count: Math.min(COUNT_CAP, base + carried + 1),
    lastAt: new Date(at).toISOString()
  };
  prune(state);
  state.rev = (state.rev || 0) + 1;
  return state.terms[key];
}

function clear(state) {
  const had = Object.keys(state.terms).length;
  state.terms = {};
  state.rev = (state.rev || 0) + 1;
  return had;
}

// 给设置页看的：按次数排序的词表。
function list(state) {
  const st = state || emptyState();
  return Object.keys(st.terms)
    .map(k => st.terms[k])
    .sort((a, b) => (b.count - a.count) || String(b.lastAt).localeCompare(String(a.lastAt)))
    .map(t => ({ q: t.q, count: t.count, lastAt: t.lastAt }));
}

function total(state) {
  return list(state).reduce((sum, t) => sum + t.count, 0);
}

/* ---------- ranking ---------- */

// 一个词组值多少分：log2(册数) × 词长系数。用对数是为了让「搜索」和「词组」
// 两个信号在同一量级上——线性算的话，两百本的大组动辄几百分，搜一百次也追不上。
// 现在 6 本的组约 2.6 分、200 本的组约 7.6 分，而搜一次给 4 分：单独的搜索能盖过
// 小分组，要盖过大热门得搜上几次，正合「搜得越多越惦记」。
function weightOf(group) {
  const hits = Number(group.count) || group.bookIds.length || 0;
  if (hits < 2) return 0;
  return Math.log2(hits) * Math.min(String(group.keyword).length, 6) / 3;
}

function boostOf(count) {
  return SEARCH_UNIT * Math.log2(1 + (Number(count) || 0));
}

// 关键词与搜索词彼此包含就算相关：搜「西游」也能带出「西游记」那一套。
function related(keyword, term) {
  const k = String(keyword);
  const t = String(term);
  if (k === t) return true;
  if (t.length < 2 || k.length < 2) return false;
  return k.includes(t) || t.includes(k);
}

let cache = { key: '', map: new Map(), vocab: [] };

/**
 * 每本书的分与理由。同一份索引 + 同一份日志只算一次。
 * @param {Array<object>} books
 * @param {{terms:Object,rev:number}} state
 * @param {{stamp?:string}} [opts]
 * @returns {Map<string,{score:number,why:string}>}
 */
function rank(books, state, opts) {
  const st = state || emptyState();
  const stamp = (opts && opts.stamp) || '';
  const key = stamp + '|' + (Array.isArray(books) ? books.length : 0) + '|' + (st.rev || 0);
  if (cache.key === key) return cache.map;

  const map = new Map();
  const vocab = series.detect(books || [], { maxGroups: MAX_VOCAB });
  vocab.forEach(group => {
    const weight = weightOf(group);
    if (!weight) return;
    group.bookIds.forEach(id => {
      const cur = map.get(id) || { score: 0, why: '' };
      cur.score += weight;
      if (weight > (cur.base || 0)) {
        cur.base = weight;
        cur.why = '「' + group.keyword + '」' + group.count + ' 本';
      }
      map.set(id, cur);
    });
  });

  const terms = list(st).slice(0, MAX_BOOST_TERMS);
  if (terms.length) {
    const texts = (books || []).map(book => ({
      id: book.id,
      text: [book.title, book.author, book.path].map(v => String(v || '')).join(' ').toLowerCase()
    }));
    terms.forEach(term => {
      const needle = String(term.q).toLowerCase();
      const boost = boostOf(term.count);
      const why = '你搜过 ' + term.count + ' 次「' + term.q + '」';
      texts.forEach(item => {
        if (!needle || !item.text.includes(needle)) return;
        const cur = map.get(item.id) || { score: 0, why: '' };
        cur.score += boost;
        cur.why = why;
        cur.base = Infinity;
        map.set(item.id, cur);
      });
      // 相关的书：同属一个词组的那几本，拿四成分。
      vocab.forEach(group => {
        if (!related(group.keyword, term.q)) return;
        const share = boost * RELATED_SHARE;
        group.bookIds.forEach(id => {
          const cur = map.get(id) || { score: 0, why: '' };
          // 已经直接命中的别再叠一层，理由也保留更具体的那个。
          if (cur.why === why) return;
          cur.score += share;
          if (cur.base !== Infinity && share > (cur.base || 0)) {
            cur.base = share;
            cur.why = why + ' · 同类';
          }
          map.set(id, cur);
        });
      });
    });
  }

  cache = { key: key, map: map, vocab: vocab };
  return map;
}

// 设置页展示用：现在最热的几个书名词。
function topKeywords(books, limit) {
  const n = Number(limit) > 0 ? Number(limit) : 5;
  return series.detect(books || [], { maxGroups: MAX_VOCAB })
    .slice(0, n)
    .map(g => ({ keyword: g.keyword, count: g.count }));
}

module.exports = {
  MAX_TERMS,
  MIN_TERM,
  emptyState,
  load,
  save,
  record,
  clear,
  list,
  total,
  rank,
  topKeywords
};
