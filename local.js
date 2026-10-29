// Speicher der Handy-App: alles bleibt in der IndexedDB dieses Geräts.
// Bildet dieselben Funktionen nach, die die App in Claude nutzt (db, assets, downloads).
(() => {
  const DBNAME = "trainingsbuch", VERSION = 1;
  let idbP = null;
  const idb = () => idbP || (idbP = new Promise((res, rej) => {
    const r = indexedDB.open(DBNAME, VERSION);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains("docs")) d.createObjectStore("docs"); if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs"); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (store, mode, fn) => { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction(store, mode), s = t.objectStore(store); const out = fn(s); t.oncomplete = () => res(out && "result" in out ? out.result : out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error("abgebrochen")); }); };
  const err = (code, message) => Object.assign(new Error(message), { code, message });

  const listeners = {};
  async function readCollection(path) {
    const d = await idb();
    return new Promise((res, rej) => {
      const out = [], t = d.transaction("docs"), range = IDBKeyRange.bound(path + "/", path + "/￿");
      const c = t.objectStore("docs").openCursor(range);
      c.onsuccess = () => { const cur = c.result; if (!cur) return res(out); const id = cur.key.slice(path.length + 1); if (!id.includes("/")) out.push({ id, data: cur.value }); cur.continue(); };
      c.onerror = () => rej(c.error);
    });
  }
  async function notify(path) {
    const list = listeners[path]; if (!list?.length) return;
    const rows = await readCollection(path);
    const snap = { docs: rows.map((r) => ({ id: r.id, exists: true, data: () => r.data, metadata: { fromCache: false, hasPendingWrites: false } })), size: rows.length, empty: !rows.length, docChanges: () => [] };
    list.forEach((fn) => { try { fn(snap); } catch (e) { console.error(e); } });
  }
  const parent = (path) => path.split("/").slice(0, -1).join("/");
  const docRef = (path) => ({
    id: path.split("/").pop(), path,
    async get() { const v = await tx("docs", "readonly", (s) => s.get(path)); return { id: path.split("/").pop(), exists: v !== undefined, data: () => v }; },
    async set(data) {
      try { await tx("docs", "readwrite", (s) => s.put(JSON.parse(JSON.stringify(data)), path)); }
      catch (e) { throw err(e?.name === "QuotaExceededError" ? "quota_exceeded" : "unavailable", "Speichern fehlgeschlagen"); }
      notify(parent(path));
    },
    async delete() { await tx("docs", "readwrite", (s) => s.delete(path)); notify(parent(path)); },
  });
  const db = {
    doc: docRef,
    collection: (path) => ({
      path, doc: (id) => docRef(path + "/" + (id || crypto.randomUUID())),
      onSnapshot(next) { (listeners[path] ||= []).push(next); notify(path); return () => { listeners[path] = listeners[path].filter((f) => f !== next); }; },
    }),
  };

  const urls = {};
  const hexId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const toDataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
  const assets = {
    async upload(blob, opts) {
      const b = opts?.type && blob.type !== opts.type ? new Blob([blob], { type: opts.type }) : blob;
      const id = hexId();
      try { await tx("blobs", "readwrite", (s) => s.put(b, id)); } catch (e) { throw err("quota_or_state", "Speicher voll"); }
      urls[id] = URL.createObjectURL(b);
      return { id, url: urls[id], sizeBytes: b.size, contentType: b.type };
    },
    async urlFor(id) {
      if (urls[id]) return urls[id];
      const b = await tx("blobs", "readonly", (s) => s.get(id));
      return b ? (urls[id] = URL.createObjectURL(b)) : null;
    },
    async delete(id) { await tx("blobs", "readwrite", (s) => s.delete(id)); return { deleted: true }; },
    async exportAll(ids) {
      const out = {};
      for (const id of new Set(ids)) { const b = await tx("blobs", "readonly", (s) => s.get(id)); if (b) out[id] = await toDataUrl(b); }
      return out;
    },
    async importAll(map) {
      for (const [id, dataUrl] of Object.entries(map)) {
        if (!/^[0-9a-f]{32}$/.test(id) || typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) continue;
        const blob = await (await fetch(dataUrl)).blob();
        await tx("blobs", "readwrite", (s) => s.put(blob, id));
      }
    },
  };

  const MIME = { json: "application/json", csv: "text/csv" };
  const downloads = {
    async save({ filename, data }) {
      const type = MIME[filename.split(".").pop()] || "application/octet-stream";
      const file = new File([data], filename, { type });
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file] }); return { status: "saved" }; }
        catch (e) { if (e?.name === "AbortError") throw err("declined", "abgebrochen"); }
      }
      const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = filename;
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      return { status: "saved" };
    },
  };

  window.TB_LOCAL = {
    caps: async () => { await idb(); return [db, assets, downloads]; },
    persisted: async () => { try { return (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.()) || false; } catch (e) { return false; } },
  };
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
