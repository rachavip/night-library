/*
 * Series groups worked out from the shelf itself.
 *
 * Nobody wants to hand-file 800 books, so the shelf looks for the phrases that
 * keep coming back in titles: five or more books sharing 「西游记」 is a series,
 * whether they are called 西游记, 西游记（上下册）or 西游记 第03回.
 *
 * Two things are stored by hand and never recomputed: a new display name for a
 * keyword, and a keyword the reader does not want to see. Everything else is
 * derived from the index, so adding a folder can grow a group by itself.
 *
 * Deliberately no dictionary and no dependency: candidates are every 2-14
 * character run inside a title, and a short run is dropped when a longer one
 * already covers nearly all of the same books (西游 is redundant next to
 * 西游记). A small stop list catches the words that are frequent but mean
 * nothing as a group name (全集, 中国, 上册 …).
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// 5 books is the point where a phrase stops looking like a coincidence.
const MIN_HITS = 5;
// A 2-character phrase needs more evidence than a long one: 史记 x6 is real,
// 中国 x6 is usually noise.
const MIN_HITS_SHORT = 6;
const MIN_LEN = 2;
const MAX_LEN = 14;
// Don't flood the rail: the 30 busiest groups are plenty.
const MAX_GROUPS = 30;
// A longer phrase that covers this share of a shorter phrase's books makes the
// shorter one redundant. 0.7 keeps 「西游记」(12) alive next to 「西游记续集」(5).
const COVER_RATIO = 0.7;
const MAX_NAME = 40;

const STOP = new Set([
  // 装帧、版次、册数
  '全集', '文集', '选集', '合集', '套装', '全本', '足本', '节选', '全册', '全套',
  '上册', '下册', '中册', '上卷', '下卷', '中卷', '卷一', '卷二', '卷三',
  '新版', '旧版', '初版', '再版', '修订', '增订', '精装', '平装', '简装',
  '典藏', '珍藏', '精品', '插图', '彩图', '图文', '大字', '双色', '全彩',
  '第一', '第二', '第三', '第四', '第五', '第六',
  // 泛词：作为一组没有意义
  '大全', '百科', '全书', '指南', '入门', '基础', '进阶', '实战', '案例',
  '习题', '答案', '详解', '导读', '注释', '白话', '今译', '译注', '对照',
  '点评', '校注', '笺注', '讲义', '教程', '教材', '课本', '读本', '手册',
  '中国', '世界', '外国', '古典', '现代', '当代', '名著', '经典', '文学',
  '小说', '散文', '诗歌', '诗集', '随笔', '杂文', '传记', '日记', '书信',
  '历史', '哲学', '心理', '经济', '管理', '法律', '医学', '数学', '物理',
  '化学', '英语', '语文', '政治', '社会', '文化', '艺术', '音乐', '美术',
  '旅游', '美食', '菜谱', '健康', '养生', '教育', '儿童', '少年', '青春',
  '系列', '丛书', '读本', '我们', '你们', '他们', '什么', '怎样', '如何',
  '一个', '关于', '其实', '就是', '可以', '以及', '或者', '因为', '所以',
  '作者', '主编', '编著', '译者', '校注', '选编', '整理', '著者',
  '典藏版', '珍藏版', '修订版', '增订版', '插图版', '彩图版', '图文版',
  '全译本', '精装版', '平装版', '大字版', '完整版', '最新版', '全新版',
  // 体裁、形式、丛书名：成组也只能聚出一堆不相干的书，组名该是具体作品
  '简史', '通史', '全史', '演义', '史话', '图鉴', '图解', '故事', '读物',
  '文选', '诗选', '词选', '名篇', '精选', '集萃', '文丛', '文库', '丛刊',
  // 文件名里常见的格式词，不是书名
  'epub', 'mobi', 'azw3', 'pdf', 'txt', 'scan', 'ocr', 'ebook', 'book',
  'unknown', 'untitled', 'document'
]);

// STOP 里的词本身被挡掉了，可它的子串会顶上来：挡了「典藏版」，128 本书里的
// 「藏版」反而成了候选。凡是某个停用词的一部分，同样不算组名。
const STOP_PARTS = new Set();
STOP.forEach(word => {
  if (!/[\u4e00-\u9fff]/.test(word)) return;
  for (let i = 0; i < word.length; i++) {
    for (let j = i + 2; j <= word.length; j++) STOP_PARTS.add(word.slice(i, j));
  }
});

/* ---------- stored preferences ---------- */

function emptyState() {
  // `muted` is a group the reader deliberately folded away - it deserves a
  // "恢复" button. `merged` is a keyword silenced as a side effect of folding
  // a same-named auto group into a hand-built one; that was a decision, not a
  // mistake, so it must not show up as something to undo.
  return { renamed: {}, muted: [], merged: [], order: [] };
}

function cleanState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object') return state;
  if (raw.renamed && typeof raw.renamed === 'object') {
    Object.keys(raw.renamed).forEach(key => {
      const name = String(raw.renamed[key] == null ? '' : raw.renamed[key])
        .replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
      if (name && key) state.renamed[String(key)] = name;
    });
  }
  const hadMerged = Object.prototype.hasOwnProperty.call(raw, 'merged');
  if (Array.isArray(raw.muted)) {
    state.muted = Array.from(new Set(raw.muted.map(v => String(v || '')).filter(Boolean)));
  }
  if (Array.isArray(raw.merged)) {
    state.merged = Array.from(new Set(raw.merged.map(v => String(v || '')).filter(Boolean)));
  }
  if (Array.isArray(raw.order)) {
    // Shelf ids survive renames; a stale id is harmless but keeping thousands
    // of them would only bloat the file.
    state.order = Array.from(new Set(raw.order.map(v => String(v || '')).filter(Boolean))).slice(0, 1000);
  }
  if (!hadMerged && state.muted.length) {
    // 旧版只有 muted 一个数组，手动收起和同名合并混在一起，没法逐条分辨。
    // 这些条目绝大多数来自合并，一次性按合并静默处理：左栏不再冒出「恢复」，
    // 自动组若真想收起，读者再点一次 × 即可，之后会正常出现在恢复入口里。
    state.merged = state.muted;
    state.muted = [];
  }
  return state;
}

async function load(cfg) {
  try {
    return cleanState(JSON.parse(await fsp.readFile(path.join(cfg.dataDir, 'series.json'), 'utf8')));
  } catch (e) {
    return emptyState();
  }
}

let writeChain = Promise.resolve();
function save(cfg, state) {
  const file = path.join(cfg.dataDir, 'series.json');
  const tmp = file + '.tmp';
  const payload = JSON.stringify(cleanState(state), null, 2);
  writeChain = writeChain
    .then(() => fsp.writeFile(tmp, payload, 'utf8'))
    .then(() => fsp.rename(tmp, file))
    .catch(() => {});
  return writeChain;
}

function rename(state, keyword, rawName) {
  const key = String(keyword || '');
  if (!key) return null;
  const name = String(rawName == null ? '' : rawName)
    .replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  if (!name) {
    delete state.renamed[key];
    return null;
  }
  state.renamed[key] = name;
  return name;
}

function mute(state, keyword, on, bucket) {
  const key = String(keyword || '');
  if (!key) return false;
  const list = bucket === 'merged' ? 'merged' : 'muted';
  const set = new Set(state[list]);
  if (on === false) set.delete(key);
  else set.add(key);
  state[list] = Array.from(set);
  return on !== false;
}

/* ---------- title normalisation ---------- */

// 版次、册数、编号对分组没有帮助，先摘掉，剩下的才是「这本是哪一套」。
// 圆括号与方括号里通常是版次说明，整段丢掉；书名号只是标点，里面的字要留。
function norm(raw) {
  return String(raw || '')
    .replace(/[（(【\[][^）)】\]]{0,60}[）)】\]]/g, ' ')
    .replace(/[《》〈〉「」『』]/g, ' ')
    .replace(/第[0-9一二三四五六七八九十百千零〇]{1,4}[卷册部篇章集辑回]/g, ' ')
    .replace(/[.．]\s*\d{1,3}$/g, ' ')
    .toLowerCase()
    .replace(/[^0-9a-z\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

// Every phrase a title could contribute a group name from.
function candidatesOf(text) {
  const out = new Set();
  (text.match(/[\u4e00-\u9fff]+/g) || []).forEach(run => {
    const max = Math.min(MAX_LEN, run.length);
    for (let len = MIN_LEN; len <= max; len++) {
      for (let i = 0; i + len <= run.length; i++) out.add(run.slice(i, i + len));
    }
  });
  // Latin titles are matched as whole words: "harry potter" is one candidate.
  (text.match(/[a-z0-9][a-z0-9'&:]{3,}/g) || []).forEach(w => {
    if (!/^\d+$/.test(w)) out.add(w);
  });
  return out;
}

/* ---------- detection ---------- */

/**
 * @param {Array<{id:string,title?:string}>} books
 * @param {{maxGroups?:number}} [opts] 侧栏只要最热的几十组；「猜你想看」算分
 *   时想要更长的长尾，就传一个更大的上限。
 * @returns {Array<{keyword:string, count:number, bookIds:string[]}>}
 */
function detect(books, opts) {
  const list = Array.isArray(books) ? books : [];
  const maxGroups = opts && Number(opts.maxGroups) > 0 ? Number(opts.maxGroups) : MAX_GROUPS;
  // 先只存「出现在多少本书里」的计数，不存 id：一本 40 字的书名能派生出
  // 三百多个候选，把每个候选的 id 都留一份会白白吃掉几十兆内存。
  const counts = new Map();
  const texts = list.map(book => norm(book.title));
  texts.forEach(text => {
    if (!text) return;
    candidatesOf(text).forEach(key => counts.set(key, (counts.get(key) || 0) + 1));
  });

  let cands = [];
  counts.forEach((count, key) => {
    if (STOP.has(key) || STOP_PARTS.has(key)) return;
    // 一个词出现在每一本书里，说明它区分不了任何东西（整柜书的公共前缀、
    // 文件夹名之类）。只有书少的时候才放过：5 本《西游记》各版本正好就是
    // 一个该有的组。
    if (list.length >= 20 && count >= list.length) return;
    const need = key.length <= 2 ? MIN_HITS_SHORT : MIN_HITS;
    if (count < need) return;
    cands.push({ key, count });
  });

  // Longest first: a long phrase gets its chance before it can be swallowed.
  cands.sort((a, b) => b.key.length - a.key.length || b.count - a.count);

  const kept = [];
  cands.forEach(cand => {
    // 被一个更长、且几乎覆盖同一批书的词组包含 —— 那这个词组太泛，不留。
    const redundant = kept.some(k =>
      k.key.length > cand.key.length &&
      k.key.includes(cand.key) &&
      k.count >= cand.count * COVER_RATIO
    );
    if (!redundant) kept.push(cand);
  });

  kept.sort((a, b) => b.count - a.count || b.key.length - a.key.length || a.key.localeCompare(b.key));

  // 只给最终留下来的这些组回填书名 id，几十个组做一次全表扫描就够了。
  const hitsOf = key => {
    const latin = /^[a-z0-9]/.test(key);
    const picked = [];
    texts.forEach((text, i) => {
      if (!text) return;
      const hit = latin ? (' ' + text + ' ').includes(' ' + key + ' ') : text.includes(key);
      if (hit) picked.push(list[i].id);
    });
    return picked;
  };

  return kept.slice(0, maxGroups).map(c => ({
    keyword: c.key,
    count: c.count,
    bookIds: hitsOf(c.key)
  }));
}

/**
 * Turn the detection into shelf-shaped objects the rest of the server already
 * understands. Ids are prefixed so a keyword can never collide with a
 * hand-built shelf id.
 */
function build(books, state, opts) {
  const st = state || emptyState();
  // Both kinds of silence keep the auto group from being generated again;
  // only `muted` is surfaced to the reader as something to restore.
  const muted = new Set([].concat(st.muted || [], st.merged || []));
  const min = opts && Number(opts.min) > 0 ? Number(opts.min) : 0;
  return detect(books)
    .filter(g => g.bookIds.length && !muted.has(g.keyword) && (!min || g.bookIds.length >= min))
    .map(g => ({
      id: 'auto:' + g.keyword,
      keyword: g.keyword,
      name: (st.renamed || {})[g.keyword] || g.keyword,
      bookIds: g.bookIds,
      count: g.bookIds.length,
      auto: true
    }));
}

module.exports = {
  MIN_HITS,
  MAX_GROUPS,
  emptyState,
  load,
  save,
  rename,
  mute,
  norm,
  detect,
  build
};
