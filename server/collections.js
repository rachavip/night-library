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
  if (state.collections.some(c => c.name === name)) {
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
  if (state.collections.some(c => c.id !== id && c.name === name)) {
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
  prune,
  cleanName
};
