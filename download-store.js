/* Transfer a large Blob from the service worker to the offscreen download page. */
globalThis.downloadStore = (() => {
  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("slideshots-download", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("files");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function transact(mode, operation) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("files", mode);
        const request = operation(tx.objectStore("files"));
        let value;
        request.onsuccess = () => { value = request.result; };
        tx.oncomplete = () => resolve(value);
        tx.onerror = () => reject(tx.error || request.error);
        tx.onabort = () => reject(tx.error || new Error("PDFの一時保存に失敗しました。"));
      });
    } finally { db.close(); }
  }
  return {
    get: (key) => transact("readonly", (s) => s.get(key)),
    put: (key, blob) => transact("readwrite", (s) => s.put(blob, key)),
    remove: (key) => transact("readwrite", (s) => s.delete(key))
  };
})();
