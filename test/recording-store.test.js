import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRecordingStore } from "../src/recording-store.js";

// Container-shaped bytes exercise storage; the browser suite records real synthetic media.
const audio = Buffer.from("1a45dfa3000000007765626d0000000000000000", "hex");
const key = "0123456789abcdef";
const id = "a".repeat(32);
const other = "b".repeat(32);
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-recordings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, store: createRecordingStore(dir) };
}

test("takes persist independently, retain numbering, and export unchanged bytes", async (t) => {
  const { dir, store } = await fixture(t);
  const first = await store.save(key, "intro", id, audio, 1200);
  const second = await store.save(key, "intro", other, audio, 2400);
  assert.equal(first.number, 1);
  assert.equal(second.number, 2);
  assert.equal((await store.list(key, "closing")).takes.length, 0);
  const selected = await store.select(key, "intro", other);
  assert.deepEqual(await readFile(selected.path), audio);
  assert.equal(selected.id, other);
  const reopened = createRecordingStore(dir);
  assert.equal((await reopened.list(key, "intro")).selected, other);
  await reopened.remove(key, "intro", other);
  assert.equal((await reopened.list(key, "intro")).selected, null);
  assert.deepEqual(await readFile(selected.path), audio, "queued export survives take deletion");
  assert.equal((await store.save(key, "intro", "c".repeat(32), audio, 500)).number, 3);
  assert.equal((await stat(selected.path)).mode & 0o777, 0o600);
});

test("lost upload responses retry idempotently and conflicting bytes are refused", async (t) => {
  const { store } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 3 }, () => store.save(key, "intro", id, audio, 1200)));
  assert.deepEqual(results[0], results[1]);
  assert.equal((await store.list(key, "intro")).takes.length, 1);
  await assert.rejects(store.save(key, "intro", id, Buffer.concat([audio, audio]), 1200), /different audio/);
});

test("export editing leaves the recorded original unchanged", async (t) => {
  const { store } = await fixture(t);
  await store.save(key, "intro", id, audio, 100);
  const selected = await store.select(key, "intro", id);
  await writeFile(selected.path, "edited export");
  assert.deepEqual(await readFile((await store.resolve(key, "intro", id)).path), audio);
});

test("paths, containers, duration, and missing selections fail closed", async (t) => {
  const { store } = await fixture(t);
  for (const section of ["../outside", "", "a".repeat(65), "exports"]) {
    await assert.rejects(store.save(key, section, id, audio, 100), /reference/);
  }
  await assert.rejects(store.save(key, "intro", "../bad", audio, 100), /reference/);
  await assert.rejects(store.save(key, "intro", id, Buffer.from("text"), 100), /audio container/);
  await assert.rejects(store.save(key, "intro", id, audio, NaN), /duration/);
  await assert.rejects(store.select(key, "intro", id), /not found/);
});

test("storage failures preserve saved takes and allow retry", async (t) => {
  const { dir, store } = await fixture(t);
  await writeFile(path.join(dir, "recordings"), "blocked directory");
  await assert.rejects(store.save(key, "intro", id, audio, 100));
  await rm(path.join(dir, "recordings"));
  await store.save(key, "intro", id, audio, 100);
  assert.equal((await store.list(key, "intro")).takes.length, 1);
});

test("a full recording budget refuses admission without removing previous takes", async (t) => {
  const { dir } = await fixture(t);
  const store = createRecordingStore(dir, { maxDiskBytes: 20_000 });
  await store.save(key, "intro", id, audio, 100);
  await assert.rejects(
    store.save(key, "intro", other, Buffer.concat([audio, Buffer.alloc(20_000)]), 100),
    /storage limit/,
  );
  assert.equal((await store.list(key, "intro")).takes.length, 1);
});
