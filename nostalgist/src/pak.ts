// Frost & Thaw: installs the game into the browser's private storage (OPFS)
// from a manifest of packs. Each pack is an uncompressed zip of up to ~64 MB.
// Packs are named after their contents, so a game update only downloads the
// packs that changed, and a dropped connection resumes at the next pack.

export type Pack = { name: string; size: number; sha256: string };
export type Manifest = { version: string; packs: Pack[]; launch: string };

const DONE_KEY = "frost-thaw installed packs";

function installedPacks(): Record<string, true> {
  try {
    return JSON.parse(localStorage.getItem(DONE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function markInstalled(name: string) {
  const done = installedPacks();
  done[name] = true;
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify(done));
  } catch {
    /* storage full or blocked: the pack is still on disk, it just reinstalls next time */
  }
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchPack(url: string, onBytes: (n: number) => void): Promise<ArrayBuffer> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    let got = 0;
    try {
      const resp = await fetch(url, { cache: "no-store" });
      if (!resp.ok || resp.body === null) throw new Error("HTTP " + resp.status);
      const reader = resp.body.getReader();
      const parts: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        onBytes(value.length);
      }
      const out = new Uint8Array(got);
      let o = 0;
      for (const p of parts) {
        out.set(p, o);
        o += p.length;
      }
      return out.buffer;
    } catch (err) {
      lastErr = err;
      onBytes(-got); // take back the progress of the failed try
      await new Promise((r) => setTimeout(r, 1000 * Math.min(30, 2 ** attempt)));
    }
  }
  throw lastErr;
}

export async function installGame(
  manifestUrl: string,
  root: string,
  progress: (done: number, total: number) => void,
): Promise<Manifest> {
  const manifest: Manifest = await (await fetch(manifestUrl, { cache: "no-store" })).json();
  const base = new URL(".", new URL(manifestUrl, location.href));
  const done = installedPacks();
  const todo = manifest.packs.filter((p) => !done[p.name]);
  const total = todo.reduce((a, p) => a + p.size, 0);
  let bytes = 0;
  progress(0, total);
  if (todo.length === 0) return manifest;

  // Ask the browser to keep the game (and saves) instead of evicting them under storage pressure
  try {
    await navigator.storage.persist();
  } catch {
    /* not supported */
  }

  const worker = new Worker(new URL("./pak-worker.ts", import.meta.url), { type: "module" });
  let nextId = 1;
  const waiting = new Map<number, (r: { ok: boolean; error?: string }) => void>();
  worker.onmessage = (ev) => {
    const cb = waiting.get(ev.data.id);
    waiting.delete(ev.data.id);
    cb?.(ev.data);
  };
  const unpack = (buf: ArrayBuffer) =>
    new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      worker.postMessage({ id, root, buf }, [buf]);
    });

  try {
    // Download the next pack while the previous one unpacks
    let pending: Promise<void> = Promise.resolve();
    for (const pack of todo) {
      const buf = await fetchPack(new URL(pack.name, base).toString(), (n) => {
        bytes += n;
        progress(bytes, total);
      });
      const hash = await sha256Hex(buf);
      if (hash !== pack.sha256) throw new Error("Pack " + pack.name + " arrived damaged. Reload to try again.");
      await pending;
      pending = unpack(buf).then((r) => {
        if (!r.ok) throw new Error("Couldn't save " + pack.name + ": " + r.error);
        markInstalled(pack.name);
      });
    }
    await pending;
  } finally {
    worker.terminate();
  }
  return manifest;
}
