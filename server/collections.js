/*
 * Shelves the user builds by hand: 「今年要读」「历史专题」and so on.
 *
 * A shelf only stores book ids. Book ids are a hash of folder + relative path,
 * so renaming a file on the NAS produces a new id and the old one goes stale.
 * Stale ids are pruned against the live index on read instead of being kept
 * forever, and a shelf that loses every book is left in place (empty) rather
 * than silently disappearing.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const MAX_NAME = 40;
const MAX_SHELVES = 60;

function emptyState() {
  return { collections: [] };
}

function cleanName(raw) {
  return String(raw == null ? '' : raw).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

// Two names that differ only in case or spacing are the same series as far as a
// reader is concerned, so they must not sit next to each other in the rail.
function nameKey(raw) {
  return cleanName(raw).replace(/\s+/g, '').toLowerCase();
}

function findByName(state, rawName) {
  const key = nameKey(rawName);
  if (!key) return null;
  return state.collections.find(c => nameKey(c.name) === key) || null;
}

function cleanState(raw) {
  const state = emptyState();
  if (!raw || !Array.isArray(raw.collections)) return state;
  const seen = new Set();
  raw.collections.slice(0, MAX_SHELVES).forEach(item => {
    if (!item || typeof item !== 'object') return;
    const name = cleanName(item.name);
    const id = String(item.id || '');
    if (!name || !id || seen.has(id)) return;
    seen.add(id);
    const ids = Array.isArray(item.bookIds)
      ? item.bookIds.map(v => String(v || '')).filter(Boolean)
      : [];
    state.collections.push({
      id,
      name,
      bookIds: Array.from(new Set(ids)),
      createdAt: item.createdAt || new Date().toISOString(),
      updatedAt: item.updatedAt || item.createdAt || new Date().toISOString()
    });
  });
  return state;
}

async function load(cfg) {
  try {
    return cleanState(JSON.parse(await fsp.readFile(path.join(cfg.dataDir, 'collections.json'), 'utf8')));
  } catch (e) {
    return emptyState();
  }
}

let writeChain = Promise.resolve();
function save(cfg, state) {
  const file = path.join(cfg.dataDir, 'collections.json');
  const tmp = file + '.tmp';
  const payload = JSON.stringify(cleanState(state), null, 2);
  writeChain = writeChain
    .then(() => fsp.writeFile(tmp, payload, 'utf8'))
    .then(() => fsp.rename(tmp, file))
    .catch(() => {});
  return writeChain;
}

function newId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function create(state, rawName) {
  const name = cleanName(rawName);
  if (!name) {
    const err = new Error('书单名称不能为空');
    err.code = 'BAD_NAME';
    throw err;
  }
  if (state.collections.length >= MAX_SHELVES) {
    const err = new Error('书单最多 ' + MAX_SHELVES + ' 个');
    err.code = 'TOO_MANY';
    throw err;
  }
  if (findByName(state, name)) {
    const err = new Error('已经有一个叫「' + name + '」的书单');
    err.code = 'DUPLICATE';
    throw err;
  }
  const now = new Date().toISOString();
  const item = { id: newId(), name, bookIds: [], createdAt: now, updatedAt: now };
  state.collections.push(item);
  return item;
}

function rename(state, id, rawName) {
  const item = state.collections.find(c => c.id === id);
  if (!item) return null;
  const name = cleanName(rawName);
  if (!name) {
    const err = new Error('书单名称不能为空');
    err.code = 'BAD_NAME';
    throw err;
  }
  if (state.collections.some(c => c.id !== id && nameKey(c.name) === nameKey(name))) {
    const err = new Error('已经有一个叫「' + name + '」的书单');
    err.code = 'DUPLICATE';
    throw err;
  }
  item.name = name;
  item.updatedAt = new Date().toISOString();
  return item;
}

function remove(state, id) {
  const at = state.collections.findIndex(c => c.id === id);
  if (at < 0) return false;
  state.collections.splice(at, 1);
  return true;
}

function members(state, id, changes) {
  const item = state.collections.find(c => c.id === id);
  if (!item) return null;
  const add = Array.isArray(changes && changes.add) ? changes.add.map(String) : [];
  const del = Array.isArray(changes && changes.remove) ? changes.remove.map(String) : [];
  const set = new Set(item.bookIds);
  del.forEach(v => set.delete(v));
  add.forEach(v => { if (v) set.add(v); });
  item.bookIds = Array.from(set);
  item.updatedAt = new Date().toISOString();
  return item;
}

// Moving files a book from one series to another: it leaves every other series
// first, so the target is the only place it lives. Adding (members) keeps the
// old home - that difference is the whole point of the two buttons.
function moveMembers(state, id, ids) {
  const target = state.collections.find(c => c.id === id);
  if (!target) return null;
  const pick = new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean));
  if (!pick.size) return { item: target, removed: 0, added: 0 };
  const now = new Date().toISOString();
  let removed = 0;
  state.collections.forEach(item => {
    if (item.id === id) return;
    const kept = item.bookIds.filter(v => !pick.has(v));
    if (kept.length === item.bookIds.length) return;
    removed += item.bookIds.length - kept.length;
    item.bookIds = kept;
    item.updatedAt = now;
  });
  const set = new Set(target.bookIds);
  const before = set.size;
  pick.forEach(v => set.add(v));
  target.bookIds = Array.from(set);
  target.updatedAt = now;
  return { item: target, removed, added: target.bookIds.length - before };
}

// Two hand-built series with the same meaning get folded into one; the source
// disappears and its books join the target.
function merge(state, fromId, intoId) {
  const from = state.collections.find(c => c.id === fromId);
  const into = state.collections.find(c => c.id === intoId);
  if (!from || !into || from.id === into.id) return null;
  const set = new Set(into.bookIds);
  from.bookIds.forEach(id => set.add(id));
  into.bookIds = Array.from(set);
  into.updatedAt = new Date().toISOString();
  const moved = from.bookIds.length;
  state.collections.splice(state.collections.indexOf(from), 1);
  return { item: into, moved };
}

// Called after a scan: a renamed file changes its id, and a deleted file leaves
// an id that no longer resolves. Dropping them keeps counts honest.
function prune(state, validIds) {
  const valid = validIds instanceof Set ? validIds : new Set(validIds || []);
  let removed = 0;
  state.collections.forEach(item => {
    const kept = item.bookIds.filter(id => valid.has(id));
    removed += item.bookIds.length - kept.length;
    item.bookIds = kept;
  });
  return removed;
}

module.exports = {
  emptyState,
  load,
  save,
  create,
  rename,
  remove,
  members,
  moveMembers,
  merge,
  findByName,
  nameKey,
  prune,
  cleanName
};
