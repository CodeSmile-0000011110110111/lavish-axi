import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { AsyncMutex } from "./async-mutex.js";

export const MAX_RECORDING_BYTES = 64 * 1024 * 1024;
export const MAX_RECORDING_DURATION_MS = 30 * 60 * 1000;
const MAX_DISK_BYTES = 512 * 1024 * 1024;

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function validRecordingReference(key, section, id = "a".repeat(32)) {
  return (
    /^[0-9a-f]{16}$/.test(key) &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(section) &&
    section !== "exports" &&
    /^[0-9a-f]{32}$/.test(id)
  );
}

function audioType(bytes) {
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && bytes.subarray(0, 512).includes("webm")) {
    return { extension: "webm", mime: "audio/webm" };
  }
  if (bytes.subarray(0, 4).toString() === "OggS" && bytes.subarray(0, 512).includes("OpusHead")) {
    return { extension: "ogg", mime: "audio/ogg" };
  }
  if (bytes.length >= 16 && bytes.subarray(4, 8).toString() === "ftyp") {
    return { extension: "m4a", mime: "audio/mp4" };
  }
  throw fail("Unsupported audio container. Record WebM, Ogg Opus, or MP4 audio.");
}

async function privateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

async function durableWrite(file, bytes) {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function manifestWrite(dir, manifest) {
  const temporary = path.join(dir, `${randomUUID()}.tmp`);
  try {
    await durableWrite(temporary, JSON.stringify(manifest));
    await rename(temporary, path.join(dir, "index.json"));
    if (process.platform !== "win32") {
      const handle = await open(dir, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function diskUsage(dir) {
  let bytes = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) bytes += await diskUsage(file);
    else {
      const info = await stat(file);
      bytes += Math.max(4096, info.size, (Number(info.blocks) || 0) * 512);
    }
  }
  return bytes;
}

// The server supplies SessionStore.runExclusive so recording writes share its lock.
// A standalone instance owns a lock for tests and local callers.
export function createRecordingStore(stateDir, { runExclusive = null, maxDiskBytes = MAX_DISK_BYTES } = {}) {
  const mutex = new AsyncMutex();
  const locked = runExclusive || ((operation) => mutex.runExclusive(operation));
  const root = path.resolve(stateDir, "recordings");
  function directory(key, section, id) {
    if (!validRecordingReference(key, section, id)) throw fail("Invalid recording reference.");
    return path.join(root, key, section);
  }
  async function list(key, section) {
    const dir = directory(key, section);
    try {
      return JSON.parse(await readFile(path.join(dir, "index.json"), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { nextNumber: 1, selected: null, takes: [] };
      throw error;
    }
  }
  async function resolve(key, section, id) {
    const dir = directory(key, section, id);
    const manifest = await list(key, section);
    const take = manifest.takes.find((take) => take.id === id);
    if (!take) throw fail("Recording take not found.", 404);
    return { ...take, path: path.join(dir, `${id}.${take.extension}`) };
  }
  async function budget(extra) {
    if ((await diskUsage(root)) + extra > maxDiskBytes)
      throw fail(
        "Recording storage limit reached. Export and delete unused takes, or archive recordings from the local state directory.",
        507,
      );
  }
  return {
    list,
    resolve,
    save: (key, section, id, bytes, durationMs) =>
      locked(async () => {
        const dir = directory(key, section, id);
        if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_RECORDING_DURATION_MS + 5000)
          throw fail("Invalid recording duration.");
        if (!bytes.length || bytes.length > MAX_RECORDING_BYTES)
          throw fail("Recording exceeds the 64 MiB take limit.", 413);
        const type = audioType(bytes);
        const hash = createHash("sha256").update(bytes).digest("hex");
        const manifest = await list(key, section);
        const previous = manifest.takes.find((take) => take.id === id);
        if (previous) {
          if (previous.sha256 !== hash) throw fail("Take id already contains different audio.", 409);
          const saved = await readFile(path.join(dir, `${id}.${previous.extension}`));
          if (!bytes.equals(saved))
            throw fail("Saved audio changed on disk. Download the unsaved take to recover it.", 409);
          return previous;
        }
        if (manifest.takes.length >= 100)
          throw fail("This section has 100 takes. Export and delete unused takes.", 507);
        await budget(Math.ceil(bytes.length / 4096) * 4096 + 8192);
        for (const folder of [root, path.join(root, key), dir]) await privateDir(folder);
        const file = path.join(dir, `${id}.${type.extension}`);
        try {
          await durableWrite(file, bytes);
        } catch (error) {
          // A process exit after audio sync can leave audio without its manifest entry.
          if (error.code !== "EEXIST") {
            await rm(file, { force: true }).catch(() => {});
            throw error;
          }
          if (!bytes.equals(await readFile(file))) throw fail("Take id already contains different audio.", 409);
        }
        const take = {
          id,
          number: manifest.nextNumber++,
          durationMs,
          bytes: bytes.length,
          sha256: hash,
          createdAt: new Date().toISOString(),
          ...type,
        };
        manifest.takes.push(take);
        await manifestWrite(dir, manifest);
        return take;
      }),
    select: (key, section, id) =>
      locked(async () => {
        const take = await resolve(key, section, id);
        const dir = directory(key, section, id);
        const exportedDir = path.join(root, key, "exports");
        await privateDir(exportedDir);
        const exported = path.join(exportedDir, `${section}-${id}.${take.extension}`);
        try {
          const exportedBytes = await readFile(exported);
          if (createHash("sha256").update(exportedBytes).digest("hex") !== take.sha256) {
            throw fail(
              "The export was edited on disk. Archive the edited export before selecting this original again.",
              409,
            );
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          await budget(take.bytes + 4096);
          // A separate file also preserves the original when an editor modifies its export.
          try {
            await durableWrite(exported, await readFile(take.path));
          } catch (error) {
            await rm(exported, { force: true });
            throw error;
          }
        }
        const manifest = await list(key, section);
        manifest.selected = id;
        await manifestWrite(dir, manifest);
        return { ...take, path: exported };
      }),
    remove: (key, section, id) =>
      locked(async () => {
        const take = await resolve(key, section, id);
        const dir = directory(key, section, id);
        const manifest = await list(key, section);
        manifest.takes = manifest.takes.filter((take) => take.id !== id);
        if (manifest.selected === id) manifest.selected = null;
        await manifestWrite(dir, manifest);
        await rm(take.path, { force: true });
        return manifest;
      }),
  };
}
