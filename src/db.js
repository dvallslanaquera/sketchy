// leaf module (imports nothing from the app) so id() and store helpers have no cycle risk

const DB_NAME = "sketchy";
const DB_VERSION = 1;

let _db = null;
let _counter = 0;

// randomUUID needs a secure context; a LAN IP over plain http doesn't qualify, hence the fallback
export function id() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
    }
  }
  return "id-" + Date.now().toString(36) + "-" + (_counter++).toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("canvases")) db.createObjectStore("canvases", { keyPath: "id" });
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("thumbs")) db.createObjectStore("thumbs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => {
      _db = req.result;
      _db.onversionchange = () => _db.close();
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => console.warn("sketchy: idb open blocked");
  });
}

function store(name, mode) {
  return _db.transaction(name, mode).objectStore(name);
}

function asPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function getAllCanvases() {
  return asPromise(store("canvases", "readonly").getAll());
}

export function getCanvas(cid) {
  return asPromise(store("canvases", "readonly").get(cid));
}

export function putCanvas(doc) {
  return asPromise(store("canvases", "readwrite").put(doc));
}

export function deleteCanvas(cid) {
  return asPromise(store("canvases", "readwrite").delete(cid));
}

// hard-delete deletedAt canvases and their thumbs; blobs left for now (refcounting in phase 7)
export function purgeDeleted() {
  return getAllCanvases().then((all) => {
    const dead = all.filter((c) => c.deletedAt);
    return Promise.all(
      dead.flatMap((c) => [deleteCanvas(c.id), deleteThumb(c.id)])
    );
  });
}

export function getMeta(key) {
  return asPromise(store("meta", "readonly").get(key)).then((r) =>
    r ? r.value : undefined
  );
}

export function setMeta(key, value) {
  return asPromise(store("meta", "readwrite").put({ key, value }));
}

export function putBlob(rec) {
  return asPromise(store("blobs", "readwrite").put(rec));
}

export function getBlob(blobId) {
  return asPromise(store("blobs", "readonly").get(blobId));
}

// { id, dataUrl, elementCount, updatedAt }; split from the canvas record so the hot save path
// never serializes a thumbnail string alongside the elements
export function putThumb(rec) {
  return asPromise(store("thumbs", "readwrite").put(rec));
}

export function getThumb(cid) {
  return asPromise(store("thumbs", "readonly").get(cid));
}

export function deleteThumb(cid) {
  return asPromise(store("thumbs", "readwrite").delete(cid));
}