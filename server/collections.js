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
// 手动建的组允许暂时是空的（先建组、再挑书放进去），但空着超过一小时就说明
// 这组没人要了：左栏挂一个「燕麦 0」既点不出东西，也分不清是坏了还是没用。
// 一小时从「最后一次变动」算起——空掉那一刻 updatedAt 会被刷新。
const EMPTY_GRACE_MS = 60 * 60 * 1000;

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
      updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
      // 「这组从什么时候开始一本都看不见」的起点。必须存下来，否则每次重启
      // 都重新计一小时，空组就永远删不掉。
      emptySince: item.emptySince || null
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
  // 落盘前顺手清掉已经空了一小时以上的组：所有写入口都会经过这里，
  // 所以不需要在每个路由里各写一遍。
  dropEmpty(state);
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
  // 又往里放书了，就别记着「从某时起是空的」了——留着会让下一次变空时
  // 拿着一个很老的起点，一秒钟都还没等就被清掉。
  if (add.length) delete item.emptySince;
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
  if (target.bookIds.length > before) delete target.emptySince;
  return { item: target, removed, added: target.bookIds.length - before };
}

// Two hand-built series with the same meaning get folded into one; the source
// disappears and its books join the target.
function merge(state, fromId, intoId) {
  const from = state.collections.find(c => c.id === fromId);
  const into = state.collections.find(c => c.id === intoId);
  if (!from || !into || from.id === into.id) return null;
  const set = new Set(into.bookIds);
  const before = set.size;
  from.bookIds.forEach(id => set.add(id));
  into.bookIds = Array.from(set);
  into.updatedAt = new Date().toISOString();
  if (into.bookIds.length > before) delete into.emptySince;
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
    if (kept.length !== item.bookIds.length) {
      item.bookIds = kept;
      // 变空的那一刻才算「空置起点」，否则一个两周前建、今天刚被删空的组
      // 会在下一次保存时立刻消失，读者连发生了什么都来不及看见。
      item.updatedAt = new Date().toISOString();
    }
  });
  return removed;
}

// 一本都没有的组不要留着。注意判定只认成员表，不看隐藏：隐藏是「藏书」那条线
// 上的事，收起的书仍然算这个组的，组名和册数都不该因为收起而消失。
// 宽限期从「发现它空了」那一刻算（见 EMPTY_GRACE_MS），期间往里放书就活过来。
// 返回删掉的个数，调用方据此决定要不要落盘。
function dropEmpty(state, now) {
  const t = now == null ? Date.now() : now;
  const before = state.collections.length;
  state.collections = state.collections.filter(item => {
    if (item.bookIds.length) {
      delete item.emptySince;
      return true;
    }
    if (!item.emptySince) {
      // 从「发现它空了」这一刻开始计时，不去追溯创建时间：追了反而会让一个
      // 上周建、今天才被清空的组当场消失。起点存在文件里，重启不会重新计时。
      item.emptySince = new Date(t).toISOString();
    }
    const since = Date.parse(item.emptySince) || t;
    return t - since < EMPTY_GRACE_MS;
  });
  return before - state.collections.length;
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
  dropEmpty,
  EMPTY_GRACE_MS,
  cleanName
};
