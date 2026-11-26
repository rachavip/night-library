/*
 * Highlights, notes and bookmarks, keyed by book id.
 *
 * A highlight is stored as an EPUB CFI range, which is the only anchor that
 * survives re-pagination, font size changes and window resizes. TXT books have
 * no CFI, so they store the page index they were selected on.
 *
 * Shape on disk:
 *   { books: { [bookId]: { highlights: [...], bookmarks: [...] } } }
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const MAX_HIGHLIGHTS = 500;
const MAX_BOOKMARKS = 200;
const LIMITS = { text: 4000, note: 8000, cfi: 600, chapter: 200, label: 200 };

function emptyState() {
  return { books: {} };
}

function cut(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000e-\u001f]/g, '').trim().slice(0, max);
}

function cleanItem(raw, kind) {
  if (!raw || typeof raw !== 'object') return null;
  const cfi = cut(raw.cfi, LIMITS.cfi);
  const text = cut(raw.text, LIMITS.text);
  const page = Number.isFinite(Number(raw.page)) ? Math.max(0, Math.round(Number(raw.page))) : null;
  // Something to jump back to is the whole point of the record.
  if (!cfi && page === null) return null;
  if (kind === 'highlight' && !text && !cut(raw.note, LIMITS.note)) return null;
  const item = {
    id: String(raw.id || ''),
    cfi,
    page,
    text,
    note: cut(raw.note, LIMITS.note),
    chapter: cut(raw.chapter, LIMITS.chapter),
    percent: Math.max(0, Math.min(1, Number(raw.percent) || 0)),
    createdAt: raw.createdAt || new Date().toISOString()
  };
  if (kind === 'bookmark') item.label = cut(raw.label, LIMITS.label) || item.chapter;
  if (raw.color) item.color = cut(raw.color, 20);
  return item;
}

function cleanState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object' || !raw.books || typeof raw.books !== 'object') return state;
  Object.keys(raw.books).forEach(bookId => {
    const rec = raw.books[bookId];
    if (!rec || typeof rec !== 'object') return;
    const highlights = (Array.isArray(rec.highlights) ? rec.highlights : [])
      .map(h => cleanItem(h, 'highlight')).filter(Boolean).slice(-MAX_HIGHLIGHTS);
    const bookmarks = (Array.isArray(rec.bookmarks) ? rec.bookmarks : [])
      .map(b => cleanItem(b, 'bookmark')).filter(Boolean).slice(-MAX_BOOKMARKS);
    if (!highlights.length && !bookmarks.length) return;
    state.books[bookId] = { highlights, bookmarks };
  });
  return state;
}

async function load(cfg) {
  try {
    return cleanState(JSON.parse(await fsp.readFile(path.join(cfg.dataDir, 'notes.json'), 'utf8')));
  } catch (e) {
    return emptyState();
  }
}

let writeChain = Promise.resolve();
function save(cfg, state) {
  const file = path.join(cfg.dataDir, 'notes.json');
  const tmp = file + '.tmp';
  const payload = JSON.stringify(cleanState(state), null, 2);
  writeChain = writeChain
    .then(() => fsp.writeFile(tmp, payload, 'utf8'))
    .then(() => fsp.rename(tmp, file))
    .catch(() => {});
  return writeChain;
}

function forBook(state, bookId) {
  const rec = state.books[bookId] || {};
  return {
    highlights: Array.isArray(rec.highlights) ? rec.highlights : [],
    bookmarks: Array.isArray(rec.bookmarks) ? rec.bookmarks : []
  };
}

function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function add(state, bookId, kind, data) {
  const key = kind === 'bookmark' ? 'bookmarks' : 'highlights';
  const max = key === 'bookmarks' ? MAX_BOOKMARKS : MAX_HIGHLIGHTS;
  const item = cleanItem(data, kind === 'bookmark' ? 'bookmark' : 'highlight');
  if (!item) {
    const err = new Error(kind === 'bookmark' ? '书签缺少位置' : '没有选中文字');
    err.code = 'BAD_INPUT';
    throw err;
  }
  const rec = state.books[bookId] || (state.books[bookId] = { highlights: [], bookmarks: [] });
  if (!Array.isArray(rec[key])) rec[key] = [];
  // Selecting the same passage twice should not double the list: same anchor
  // means same highlight, so keep the newer note but the original position.
  // PDF / TXT have no CFI, so a bookmark is identified by its page instead.
  const same = rec[key].find(x => {
    if (x.cfi && item.cfi) return x.cfi === item.cfi;
    if (!x.cfi && !item.cfi && typeof x.page === 'number' && typeof item.page === 'number') {
      return x.page === item.page;
    }
    return false;
  });
  if (same) {
    if (item.note) same.note = item.note;
    if (item.text && !same.text) same.text = item.text;
    return same;
  }
  item.id = newId(kind === 'bookmark' ? 'b' : 'h');
  rec[key].push(item);
  if (rec[key].length > max) rec[key] = rec[key].slice(-max);
  return item;
}

function update(state, bookId, noteId, patch) {
  const rec = state.books[bookId];
  if (!rec) return null;
  const all = [].concat(rec.highlights || [], rec.bookmarks || []);
  const item = all.find(x => x.id === noteId);
  if (!item) return null;
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'note')) {
    item.note = cut(patch.note, LIMITS.note);
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'label')) {
    item.label = cut(patch.label, LIMITS.label);
  }
  item.updatedAt = new Date().toISOString();
  return item;
}

function remove(state, bookId, noteId) {
  const rec = state.books[bookId];
  if (!rec) return false;
  let removed = false;
  ['highlights', 'bookmarks'].forEach(key => {
    if (!Array.isArray(rec[key])) return;
    const before = rec[key].length;
    rec[key] = rec[key].filter(x => x.id !== noteId);
    if (rec[key].length !== before) removed = true;
  });
  if (!rec.highlights.length && !rec.bookmarks.length) delete state.books[bookId];
  return removed;
}

function countFor(state, bookId) {
  const rec = state.books[bookId] || {};
  return {
    highlights: (rec.highlights || []).length,
    bookmarks: (rec.bookmarks || []).length
  };
}

function escapeMd(value) {
  return String(value == null ? '' : value).replace(/\r/g, '');
}

function toMarkdown(book, record) {
  const lines = [];
  lines.push('# ' + escapeMd(book.title || '未命名'));
  const meta = [book.author || '佚名', book.format ? book.format.toUpperCase() : '']
    .filter(Boolean).join(' · ');
  lines.push('');
  lines.push('> ' + meta + ' · 导出于 ' + new Date().toLocaleString('zh-CN'));
  lines.push('');

  const highlights = (record.highlights || []).slice().sort((a, b) => (a.percent || 0) - (b.percent || 0));
  const bookmarks = (record.bookmarks || []).slice().sort((a, b) => (a.percent || 0) - (b.percent || 0));

  lines.push('## 高亮与笔记（' + highlights.length + '）');
  lines.push('');
  if (!highlights.length) {
    lines.push('_还没有高亮。_');
  } else {
    highlights.forEach(h => {
      const quote = escapeMd(h.text).split('\n').map(l => '> ' + l).join('\n');
      lines.push(quote || '> (无摘录)');
      if (h.note) {
        lines.push('');
        lines.push('**笔记**：' + escapeMd(h.note));
      }
      const where = [h.chapter, h.percent ? Math.round(h.percent * 100) + '%' : ''].filter(Boolean).join(' · ');
      lines.push('');
      if (where) lines.push('— ' + where);
      lines.push('');
    });
  }

  lines.push('## 书签（' + bookmarks.length + '）');
  lines.push('');
  if (!bookmarks.length) {
    lines.push('_还没有书签。_');
  } else {
    bookmarks.forEach(b => {
      const where = [b.label || b.chapter, b.percent ? Math.round(b.percent * 100) + '%' : ''].filter(Boolean).join(' · ');
      lines.push('- ' + (where || '未命名位置') + (b.note ? '：' + escapeMd(b.note) : ''));
    });
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  emptyState,
  load,
  save,
  forBook,
  add,
  update,
  remove,
  countFor,
  toMarkdown,
  cleanState
};
