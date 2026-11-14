// Frost & Thaw: unpacks one game pack (an uncompressed .zip) into the browser's
// private storage (OPFS). Runs in a worker because synchronous file handles,
// the only OPFS writer that works in every browser including iOS Safari, are
// worker-only.

type Req = { id: number; root: string; buf: ArrayBuffer };

const dirCache = new Map<string, FileSystemDirectoryHandle>();

async function dirFor(path: string): Promise<FileSystemDirectoryHandle> {
  const hit = dirCache.get(path);
  if (hit) return hit;
  let dir = await navigator.storage.getDirectory();
  let sofar = "";
  for (const part of path.split("/").filter((p) => p.length > 0)) {
    sofar += "/" + part;
    const cached = dirCache.get(sofar);
    if (cached) {
      dir = cached;
      continue;
    }
    dir = await dir.getDirectoryHandle(part, { create: true });
    dirCache.set(sofar, dir);
  }
  return dir;
}

type Entry = { name: string; start: number; size: number };

// Read the central directory of a stored (method 0) zip
function listZip(u8: Uint8Array): Entry[] {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("pack is not a zip");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: Entry[] = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("bad zip directory");
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    if (method !== 0) throw new Error("pack entry is compressed: " + name);
    const lnlen = dv.getUint16(local + 26, true);
    const lelen = dv.getUint16(local + 28, true);
    if (!name.endsWith("/")) {
      out.push({ name, start: local + 30 + lnlen + lelen, size: csize });
    }
    p += 46 + nlen + elen + clen;
  }
  return out;
}

self.onmessage = async (ev: MessageEvent<Req>) => {
  const { id, root, buf } = ev.data;
  try {
    const u8 = new Uint8Array(buf);
    const entries = listZip(u8);
    for (const e of entries) {
      const slash = e.name.lastIndexOf("/");
      const dir = await dirFor(root + "/" + (slash >= 0 ? e.name.slice(0, slash) : ""));
      const fh = await dir.getFileHandle(e.name.slice(slash + 1), { create: true });
      const h = await fh.createSyncAccessHandle();
      try {
        h.truncate(0);
        h.write(u8.subarray(e.start, e.start + e.size), { at: 0 });
        h.flush();
      } finally {
        h.close();
      }
    }
    self.postMessage({ id, ok: true, count: entries.length });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) });
  }
};
