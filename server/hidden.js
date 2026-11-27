/*
 * Books the user has put away.
 *
 * A library built by scraping a NAS folder picks up everything, including
 * shelves of books nobody will open again (old cookbooks, exam papers). Hiding
 * keeps them out of the default shelf without deleting the file or its progress
 * — unhide and the book is exactly where it was.
 *
 * Only ids are stored. Like collections, a renamed file changes its id, so
 * stale entries are pruned against the live index after every scan.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const MAX_IDS = 20000;

function emptyState() {
  return { ids: [], set: new Set() };
}

function cleanState(raw) {
  const state = emptyState();
  const list = raw && Array.isArray(raw.ids) ? raw.ids : [];
  const seen = new Set();
  list.slice(0, MAX_IDS).forEach(value => {
    const id = String(value || '');
    if (!id || seen.has(id)) return;
    seen.add(id);
    state.ids.push(id);
  });
  state.set = seen;
  return state;
}

async function load(cfg) {
  try {
    return cleanState(JSON.parse(await fsp.readFile(path.join(cfg.dataDir, 'hidden.json'), 'utf8')));
  } catch (e) {
    return emptyState();
  }
}

let writeChain = Promise.resolve();
function save(cfg, state) {
  const file = path.join(cfg.dataDir, 'hidden.json');
  const tmp = file + '.tmp';
  const payload = JSON.stringify({ ids: state.ids, updatedAt: new Date().toISOString() }, null, 2);
  writeChain = writeChain
    .then(() => fsp.writeFile(tmp, payload, 'utf8'))
    .then(() => fsp.rename(tmp, file))
    .catch(() => {});
  return writeChain;
}

function has(state, id) {
  return state.set.has(String(id || ''));
}

// Returns how many ids actually changed, so the caller can skip a write when a
// request repeats what is already stored.
function setMany(state, ids, hidden) {
  let changed = 0;
  (Array.isArray(ids) ? ids : []).forEach(raw => {
    const id = String(raw || '');
    if (!id) return;
    if (hidden) {
      if (state.set.has(id)) return;
      state.set.add(id);
      state.ids.push(id);
      changed++;
    } else {
      if (!state.set.has(id)) return;
      state.set.delete(id);
      changed++;
    }
  });
  if (changed) state.ids = state.ids.filter(id => state.set.has(id));
  return changed;
}

function count(state) {
  return state.ids.length;
}

function prune(state, validIds) {
  const valid = validIds instanceof Set ? validIds : new Set(validIds || []);
  const before = state.ids.length;
  const kept = state.ids.filter(id => valid.has(id));
  if (kept.length === before) return 0;
  state.ids = kept;
  state.set = new Set(kept);
  return before - kept.length;
}

module.exports = {
  emptyState,
  load,
  save,
  has,
  setMany,
  count,
  prune
};
