// ============================================
// Almacenamiento local para trabajar sin internet
// - BMStore.cacheGet/cacheSet: última copia de los datos descargados.
// - BMStore.outbox*: registros creados sin conexión, con sus fotos (Blob),
//   que se envían a Supabase cuando vuelve el internet.
// Usa IndexedDB (soporta Blobs y varios MB, a diferencia de localStorage).
// ============================================
(function () {
  const DB_NAME = 'bettermancera-offline';
  const DB_VERSION = 1;
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB no disponible'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache');
        if (!db.objectStoreNames.contains('outbox')) {
          db.createObjectStore('outbox', { keyPath: 'localId', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
    return dbPromise;
  }

  async function tx(storeName, mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const req = fn(t.objectStore(storeName));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const BMStore = {
    async cacheGet(key) {
      try {
        return await tx('cache', 'readonly', (s) => s.get(key));
      } catch (err) {
        console.warn('cacheGet', key, err);
        return undefined;
      }
    },
    async cacheSet(key, value) {
      try {
        await tx('cache', 'readwrite', (s) => s.put({ value, savedAt: Date.now() }, key));
      } catch (err) {
        console.warn('cacheSet', key, err);
      }
    },
    async cacheClear() {
      try {
        await tx('cache', 'readwrite', (s) => s.clear());
      } catch (err) {
        console.warn('cacheClear', err);
      }
    },
    async outboxAdd(item) {
      return tx('outbox', 'readwrite', (s) => s.add({ ...item, createdAt: Date.now() }));
    },
    async outboxPut(item) {
      return tx('outbox', 'readwrite', (s) => s.put(item));
    },
    async outboxList() {
      try {
        const items = await tx('outbox', 'readonly', (s) => s.getAll());
        return (items || []).sort((a, b) => a.localId - b.localId);
      } catch (err) {
        console.warn('outboxList', err);
        return [];
      }
    },
    async outboxDelete(localId) {
      return tx('outbox', 'readwrite', (s) => s.delete(localId));
    },
    async outboxClear() {
      return tx('outbox', 'readwrite', (s) => s.clear());
    },
  };

  window.BMStore = BMStore;
})();
