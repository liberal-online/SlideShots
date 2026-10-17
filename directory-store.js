/* FileSystemDirectoryHandle is stored in IndexedDB because chrome.storage cannot clone it. */
globalThis.directoryStore = (() => {
  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("slideshots-directory", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("settings");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function transact(mode, operation) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction("settings", mode);
        const request = operation(transaction.objectStore("settings"));
        let value;
        request.onsuccess = () => { value = request.result; };
        transaction.oncomplete = () => resolve(value);
        transaction.onerror = () => reject(transaction.error || request.error);
        transaction.onabort = () => reject(transaction.error || new Error("保存先を読み書きできませんでした。"));
      });
    } finally { db.close(); }
  }
  return {
    get: () => transact("readonly", (store) => store.get("folder")),
    set: (handle) => transact("readwrite", (store) => store.put(handle, "folder"))
  };
})();
