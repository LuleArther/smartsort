/* =========================================================
   SMARTSORT, LOCAL STORE
   Everything stays on this device, in IndexedDB:
     records  one row per recorded identification
     thumbs   small JPEG previews of recorded items (optional)
     samples  training photos for the local model: feature vector
              plus a thumbnail, never the full photo
     kv       small values (current session)
   If IndexedDB is unavailable (private window, blocked storage) an
   in-memory store is used and `persistent` is false, so the UI can
   warn that nothing will survive a reload.
   ========================================================= */

const DB_NAME = 'smartsort';
const DB_VERSION = 1;
const STORES = ['records', 'thumbs', 'samples', 'kv'];

let db = null;
const memory = Object.fromEntries(STORES.map((s) => [s, new Map()]));
export let persistent = false;

const keyOf = (store, v) => (store === 'kv' ? v.key : v.id);
const reqP = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

export async function open() {
  try {
    db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('records')) {
          const r = d.createObjectStore('records', { keyPath: 'id' });
          r.createIndex('ts', 'ts');
        }
        if (!d.objectStoreNames.contains('thumbs')) d.createObjectStore('thumbs', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('samples')) {
          const s = d.createObjectStore('samples', { keyPath: 'id' });
          s.createIndex('mode', 'mode');
        }
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('database blocked by another tab'));
    });
    persistent = true;
  } catch (e) {
    console.warn('[smartsort] IndexedDB unavailable, using memory only:', e);
    db = null;
    persistent = false;
  }
  return persistent;
}

function tx(store, mode = 'readonly') { return db.transaction(store, mode).objectStore(store); }

export async function put(store, value) {
  if (!db) { memory[store].set(keyOf(store, value), structuredClone(value)); return; }
  await reqP(tx(store, 'readwrite').put(value));
}

export async function get(store, key) {
  if (!db) return memory[store].get(key) ?? null;
  return (await reqP(tx(store).get(key))) ?? null;
}

export async function del(store, key) {
  if (!db) { memory[store].delete(key); return; }
  await reqP(tx(store, 'readwrite').delete(key));
}

export async function all(store) {
  if (!db) return [...memory[store].values()];
  return reqP(tx(store).getAll());
}

export async function byIndex(store, index, value) {
  if (!db) return [...memory[store].values()].filter((v) => v[index] === value);
  return reqP(tx(store).index(index).getAll(value));
}

export async function clear(store) {
  if (!db) { memory[store].clear(); return; }
  await reqP(tx(store, 'readwrite').clear());
}

export async function kvGet(key, fallback = null) {
  const row = await get('kv', key);
  return row ? row.value : fallback;
}

export async function kvSet(key, value) { await put('kv', { key, value }); }

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
