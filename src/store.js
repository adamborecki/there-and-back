// Keeps the three tracks on this device (IndexedDB) so they survive a
// reload. Best effort: in private browsing or if storage is blocked, every
// call quietly does nothing. iOS Safari may clear a site's storage after
// about 7 days without a visit, so "Save" (a WAV file) is the durable copy.

const DB_NAME = 'there-and-back';
const STORE = 'tracks';
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => { console.warn('Track storage unavailable', err); return null; });
  }
  return dbPromise;
}

function run(mode, fn) {
  return db().then((d) => d && new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    tx.onerror = () => reject(tx.error);
  })).catch((err) => { console.warn('Track storage failed', err); return null; });
}

// buffer: a reversed AudioBuffer, or null to delete that slot.
export function saveTrack(index, buffer) {
  if (!buffer) return run('readwrite', (s) => s.delete(index));
  // Ask the browser not to evict our data under storage pressure.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const record = {
    sampleRate: buffer.sampleRate,
    data: buffer.getChannelData(0).slice(),
    savedAt: Date.now(),
  };
  return run('readwrite', (s) => s.put(record, index));
}

// Resolves to an array of { sampleRate, data } | null, one per slot.
export async function loadTracks(count) {
  const out = new Array(count).fill(null);
  await run('readonly', (s) => {
    for (let i = 0; i < count; i++) {
      const req = s.get(i);
      req.onsuccess = () => { if (req.result && req.result.data) out[i] = req.result; };
    }
  });
  return out;
}
