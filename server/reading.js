/*
 * Reading ledger: how long each day was spent reading, plus the roll-ups the
 * shelf shows (继续阅读, 本周读了多久, 连续天数, 今年读完几本).
 *
 * A book's reading position stays in progress.json, which library.js owns.
 * This module only adds the time dimension. Book status flags (未读/在读/读完)
 * are written into the same progress record by index.js, so there is exactly
 * one source of truth per book.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// Container clocks are usually UTC. "Today" has to match the reader's wall
// calendar, otherwise a session at 23:30 lands on tomorrow's bar.
const TIME_ZONE = process.env.READING_TZ || process.env.TZ || 'Asia/Shanghai';

// A heartbeat is a few dozen seconds; a bogus one could claim hours. Cap it so
// a bad client cannot invent a reading marathon.
const MAX_PING_SECONDS = 3600;
// 400 days is enough for a year-on-year streak without letting the file grow.
const KEEP_DAYS = 400;

const dateFormatter = (() => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE,
      year: 'numeric', month: '2-digit', day: '2-digit'
    });
  } catch (e) {
    return null;
  }
})();

function dayKey(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  if (dateFormatter) {
    // en-CA formats as YYYY-MM-DD; formatToParts keeps it stable even if a
    // runtime decides to reorder the parts.
    const parts = dateFormatter.formatToParts(d);
    const get = t => (parts.find(p => p.type === t) || {}).value || '';
    return get('year') + '-' + get('month') + '-' + get('day');
  }
  const shifted = new Date(d.getTime() + 8 * 3600 * 1000);
  return shifted.toISOString().slice(0, 10);
}

// Date arithmetic on the key itself: UTC midnight never observes DST, so
// adding days is always exactly 86400000 ms.
function shiftKey(key, delta) {
  const [y, m, d] = String(key).split('-').map(Number);
  const t = Date.UTC(y, (m || 1) - 1, d || 1) + delta * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

function emptyState() {
  return { days: {}, updatedAt: null };
}

function cleanState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object' || !raw.days || typeof raw.days !== 'object') return state;
  Object.keys(raw.days).forEach(key => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return;
    const day = raw.days[key];
    if (!day || typeof day !== 'object') return;
    const seconds = Math.max(0, Math.round(Number(day.seconds) || 0));
    if (!seconds) return;
    const books = {};
    if (day.books && typeof day.books === 'object') {
      Object.keys(day.books).forEach(id => {
        const s = Math.max(0, Math.round(Number(day.books[id]) || 0));
        if (s) books[id] = s;
      });
    }
    state.days[key] = { seconds, books };
  });
  state.updatedAt = raw.updatedAt || null;
  return trim(state);
}

function trim(state) {
  const keys = Object.keys(state.days).sort();
  const extra = keys.length - KEEP_DAYS;
  for (let i = 0; i < extra; i++) delete state.days[keys[i]];
  return state;
}

async function load(cfg) {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(cfg.dataDir, 'reading.json'), 'utf8'));
    return cleanState(raw);
  } catch (e) {
    return emptyState();
  }
}

// Serialised, atomic write. Two heartbeats can arrive together; without the
// chain the second one would rewrite the file from a stale snapshot.
let writeChain = Promise.resolve();
function save(cfg, state) {
  const file = path.join(cfg.dataDir, 'reading.json');
  const tmp = file + '.tmp';
  const payload = JSON.stringify(trim(state), null, 2);
  writeChain = writeChain
    .then(() => fsp.writeFile(tmp, payload, 'utf8'))
    .then(() => fsp.rename(tmp, file))
    .catch(() => { /* a lost minute of stats is not worth failing the request */ });
  return writeChain;
}

function addTime(state, bookId, seconds, date) {
  const s = Math.max(0, Math.min(MAX_PING_SECONDS, Math.round(Number(seconds) || 0)));
  if (!s || !bookId) return null;
  const key = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : dayKey(new Date());
  const bucket = state.days[key] || (state.days[key] = { seconds: 0, books: {} });
  bucket.seconds += s;
  bucket.books[bookId] = (bucket.books[bookId] || 0) + s;
  state.updatedAt = new Date().toISOString();
  return key;
}

function statusOf(book, progress) {
  const rec = progress[book.id] || {};
  if (rec.status === 'finished') return 'finished';
  if (rec.status === 'unread') return 'unread';
  const percent = Number(rec.percent) || 0;
  if (percent >= 0.98) return 'finished';
  if (percent > 0 || rec.location) return 'reading';
  return 'unread';
}

function summary(state, opts) {
  const books = (opts && opts.books) || [];
  const progress = (opts && opts.progress) || {};
  const days = state.days || {};
  const today = dayKey(new Date());
  const weekFrom = shiftKey(today, -6);
  const monthKey = today.slice(0, 7);
  const yearKey = today.slice(0, 4);

  function secondsOn(key) {
    const day = days[key];
    return day ? Math.max(0, Number(day.seconds) || 0) : 0;
  }

  function totalWhere(predicate) {
    let total = 0;
    Object.keys(days).forEach(key => {
      if (predicate(key)) total += Math.max(0, Number(days[key].seconds) || 0);
    });
    return total;
  }

  const todaySeconds = secondsOn(today);
  const weekSeconds = totalWhere(k => k >= weekFrom && k <= today);
  const monthSeconds = totalWhere(k => k.slice(0, 7) === monthKey);
  const yearSeconds = totalWhere(k => k.slice(0, 4) === yearKey);

  // A day still counts as "today" until midnight; before the first page of the
  // day the streak is measured from yesterday so the number does not read 0.
  let streakFrom = today;
  if (!secondsOn(today)) {
    streakFrom = shiftKey(today, -1);
    if (!secondsOn(streakFrom)) {
      streakFrom = '';
    }
  }
  let streak = 0;
  let cursor = streakFrom;
  while (cursor && secondsOn(cursor) > 0 && streak < KEEP_DAYS) {
    streak += 1;
    cursor = shiftKey(cursor, -1);
  }

  const daily = [];
  for (let i = 29; i >= 0; i--) {
    const key = shiftKey(today, -i);
    daily.push({ date: key, seconds: secondsOn(key) });
  }

  const totals = { books: books.length, reading: 0, finished: 0, unread: 0 };
  const finishedByYear = {};
  books.forEach(book => {
    const status = statusOf(book, progress);
    totals[status] = (totals[status] || 0) + 1;
    if (status === 'finished') {
      const at = (progress[book.id] || {}).finishedAt;
      if (at) {
        const y = String(at).slice(0, 4);
        finishedByYear[y] = (finishedByYear[y] || 0) + 1;
      }
    }
  });

  // Per-book time across the whole retained window, so "最常翻的书" survives
  // across days instead of resetting at midnight.
  const perBook = {};
  Object.keys(days).forEach(key => {
    const dayBooks = days[key].books || {};
    Object.keys(dayBooks).forEach(id => {
      perBook[id] = (perBook[id] || 0) + Math.max(0, Number(dayBooks[id]) || 0);
    });
  });
  const titleOf = {};
  books.forEach(b => { titleOf[b.id] = b.title || '未命名'; });
  const top = Object.keys(perBook)
    .filter(id => titleOf[id])
    .sort((a, b) => perBook[b] - perBook[a])
    .slice(0, 5)
    .map(id => ({ id, title: titleOf[id], seconds: perBook[id] }));

  const recentFinished = books
    .map(b => ({ book: b, rec: progress[b.id] || {} }))
    .filter(x => statusOf(x.book, progress) === 'finished' && x.rec.finishedAt)
    .sort((a, b) => String(b.rec.finishedAt).localeCompare(String(a.rec.finishedAt)))
    .slice(0, 5)
    .map(x => ({ id: x.book.id, title: x.book.title || '未命名', finishedAt: x.rec.finishedAt }));

  return {
    timeZone: TIME_ZONE,
    today: { date: today, seconds: todaySeconds, books: Object.keys((days[today] || {}).books || {}).length },
    week: { from: weekFrom, seconds: weekSeconds },
    month: { key: monthKey, seconds: monthSeconds },
    year: { key: yearKey, seconds: yearSeconds, finished: finishedByYear[yearKey] || 0 },
    streak,
    totals,
    daily,
    top,
    recentFinished
  };
}

module.exports = {
  dayKey,
  shiftKey,
  emptyState,
  load,
  save,
  addTime,
  summary,
  statusOf
};
