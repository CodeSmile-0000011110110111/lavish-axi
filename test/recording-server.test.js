import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { serve } from "../src/server.js";

test("recording HTTP routes enforce origin, save, select, download ranges, and delete", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-recording-http-"));
  const env = { ...process.env, LAVISH_AXI_STATE_DIR: dir, LAVISH_AXI_HOST: "127.0.0.1" };
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    env,
    hosts: ["127.0.0.1"],
    linkHost: "127.0.0.1",
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const file = path.join(dir, "board.html");
    await writeFile(file, "<!doctype html><title>Recording</title><p>Intro</p>");
    const session = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file }),
    }).then((r) => r.json());
    const endpoint = `${base}/api/${session.key}/recordings/intro`;
    const id = "a".repeat(32);
    const audio = Buffer.from("1a45dfa3000000007765626d0000000000000000", "hex");
    for (const origin of [undefined, "null", "https://unrelated.example"]) {
      const response = await fetch(`${endpoint}/${id}?duration_ms=500`, {
        method: "PUT",
        headers: origin ? { origin } : {},
        body: audio,
      });
      assert.equal(response.status, 403);
    }
    const headers = { origin: base };
    const response = await fetch(`${endpoint}/${id}?duration_ms=500`, { method: "PUT", headers, body: audio });
    assert.equal(response.status, 200, await response.clone().text());
    const list = await fetch(endpoint, { headers }).then((r) => r.json());
    assert.equal(list.takes.length, 1);
    const media = await fetch(`${endpoint}/${id}`, { headers: { ...headers, range: "bytes=4-10" } });
    assert.equal(media.status, 206);
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), audio.subarray(4, 11));
    const selected = await fetch(`${endpoint}/${id}/select`, { method: "POST", headers }).then((r) => r.json());
    assert.deepEqual(await readFile(selected.path), audio);
    assert.equal((await fetch(`${endpoint}/${id}`, { method: "DELETE", headers })).status, 200);
    assert.deepEqual(await readFile(selected.path), audio);
    assert.equal((await fetch(`${endpoint}/${id}`, { headers })).status, 404);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
