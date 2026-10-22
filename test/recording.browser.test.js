import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { serve } from "../src/server.js";

const exec = promisify(execFile);
const enabled = process.env.LAVISH_AXI_BROWSER_E2E === "1";

test(
  "synthetic microphone records, plays, selects, exports, recovers, and reopens through a Lavish board",
  { skip: !enabled, timeout: 300_000 },
  async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "lavish-recorder-browser-"));
    const stateDir = path.join(dir, "state");
    await mkdir(stateDir);
    const env = {
      ...process.env,
      LAVISH_AXI_STATE_DIR: stateDir,
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      ...process.env,
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-recording-${process.pid}`,
      CHROME_DEVTOOLS_AXI_AUTO_CONNECT: "0",
      CHROME_DEVTOOLS_AXI_BROWSER_URL: "",
      CHROME_DEVTOOLS_AXI_HEADED: "0",
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(dir, "chrome"),
      // Set before launch. The browser uses synthetic input and produces no sound.
      CHROME_DEVTOOLS_AXI_CHROME_ARGS:
        "--mute-audio --use-fake-device-for-media-stream --use-fake-ui-for-media-stream --no-sandbox",
    };
    const server = await serve({
      port: 0,
      stateFile: path.join(stateDir, "state.json"),
      env,
      hosts: ["127.0.0.1"],
      linkHost: "127.0.0.1",
    });
    async function chrome(...args) {
      const result = await exec("chrome-devtools-axi", args, {
        env: chromeEnv,
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return result.stdout;
    }
    async function evaluate(expression) {
      const output = await chrome("eval", `async () => JSON.stringify(await (${expression}))`);
      const raw = output.match(/result:\s*("(?:[^"\\]|\\.)*")/s)?.[1];
      assert.ok(raw, output);
      let value = JSON.parse(raw);
      while (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          break;
        }
      }
      return value;
    }
    async function until(expression) {
      const deadline = Date.now() + 20_000;
      while (!(await evaluate(expression))) {
        assert.ok(Date.now() < deadline, `Timed out: ${expression}\n${await chrome("snapshot")}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    async function click(name) {
      const execution = exec("chrome-devtools-axi", ["run"], {
        env: chromeEnv,
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      execution.child.stdin.end(`
      const snapshot = await page.snapshot();
      const line = snapshot.split("\\n").find(line => line.includes('button ' + JSON.stringify(${JSON.stringify(name)})) && !line.includes("disabled"));
      if (!line) throw new Error(snapshot);
      await page.click("@" + line.trim().split(/\\s+/)[0].replace(/^uid=/, ""));
    `);
      await execution;
    }
    try {
      const file = path.join(dir, "board.html");
      await writeFile(file, await readFile(new URL("./fixtures/recording-board.html", import.meta.url)));
      const base = `http://127.0.0.1:${server.port}`;
      const session = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file }),
      }).then((r) => r.json());
      const sectionUrl = `${base}/api/${session.key}/recordings/intro-evolution`;
      const headers = { origin: base };
      const list = () => fetch(sectionUrl, { headers }).then((r) => r.json());
      await chrome("open", session.url);
      await until("document.getElementById('layoutGateOverlay').hidden");
      await evaluate(`(() => {
      window.testTracks = [];
      window.testGetUserMediaCalls = 0;
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.originalGetUserMedia = original;
      navigator.mediaDevices.getUserMedia = async options => {
        window.testGetUserMediaCalls++;
        const stream = await original(options);
        window.testTracks.push(...stream.getTracks());
        return stream;
      };
      return true;
    })()`);
      await click("Intro takes");
      await until("document.getElementById('recordingDialog')?.dataset.phase === 'idle'");
      assert.equal(
        await evaluate("window.testGetUserMediaCalls"),
        0,
        "opening a recording section requests no microphone",
      );
      await evaluate("(document.getElementById('chatInput').value = 'Unsent unrelated draft')");
      for (let i = 0; i < 2; i++) {
        await click("Record");
        await until("document.getElementById('recordingDialog').dataset.phase === 'recording'");
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await click("Stop");
        await until("document.getElementById('recordingStatus').textContent.includes('saved to local disk')");
        assert.equal(await evaluate("window.testTracks.every(track => track.readyState === 'ended')"), true);
      }
      let saved = await list();
      assert.equal(saved.takes.length, 2);
      assert.deepEqual(
        saved.takes.map((take) => take.number),
        [1, 2],
      );
      assert.notEqual(saved.takes[0].id, saved.takes[1].id);
      assert.equal(await evaluate("window.testTracks.every(track => track.label.includes('Fake'))"), true);
      assert.equal(await evaluate("isSecureContext"), true);
      await until("[...document.querySelectorAll('#recordingTakes audio')].every(audio => audio.readyState >= 1)");
      await evaluate(
        "(async () => { const a = document.querySelectorAll('#recordingTakes audio'); await a[0].play(); return true; })()",
      );
      await until("document.querySelector('#recordingTakes audio').currentTime > 0");
      await evaluate(
        "(async () => { const a = document.querySelectorAll('#recordingTakes audio'); await a[1].play(); return true; })()",
      );
      assert.equal(await evaluate("document.querySelectorAll('#recordingTakes audio')[0].paused"), true);
      await evaluate(
        "(() => { const a = document.querySelectorAll('#recordingTakes audio')[1]; a.currentTime = 0.5; return true; })()",
      );
      await until("document.querySelectorAll('#recordingTakes audio')[1].currentTime >= 0.5");
      await click("Record");
      await until("document.getElementById('recordingDialog').dataset.phase === 'recording'");
      assert.equal(
        await evaluate("[...document.querySelectorAll('#recordingTakes audio')].every(audio => audio.paused)"),
        true,
      );
      await click("Close");
      await until("!document.getElementById('recordingDialog').open");
      assert.equal(await evaluate("window.testTracks.every(track => track.readyState === 'ended')"), true);
      await click("Intro takes");
      await until("document.querySelectorAll('.recording-take').length === 3");
      await evaluate(
        "(() => { const row = document.querySelectorAll('.recording-take')[1]; [...row.querySelectorAll('button')].find(b => b.textContent === 'Use this take').click(); return true; })()",
      );
      await until("document.getElementById('recordingStatus').textContent.includes('path is queued')");
      assert.equal(await evaluate("document.getElementById('chatInput').value"), "Unsent unrelated draft");
      saved = await list();
      assert.equal(saved.selected, saved.takes[1].id);
      const queuedText = await evaluate("document.getElementById('queuedLog').textContent");
      assert.match(queuedText, /Use take 2/);
      assert.match(queuedText, new RegExp(saved.takes[1].sha256));
      const exported = path.join(
        stateDir,
        "recordings",
        session.key,
        "exports",
        `intro-evolution-${saved.selected}.webm`,
      );
      const audioResponse = await fetch(`${sectionUrl}/${saved.selected}`, { headers });
      const originalAudio = Buffer.from(await audioResponse.arrayBuffer());
      assert.ok(originalAudio.length > 1000);
      assert.deepEqual(await readFile(exported), originalAudio);
      assert.equal(
        JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8")).sessions[session.key].prompts.length,
        0,
      );
      await click("Close");
      const poll = fetch(`${base}/api/poll?file=${encodeURIComponent(file)}&timeoutMs=15000`, {
        signal: AbortSignal.timeout(20000),
      }).then((response) => response.json());
      await until("!document.getElementById('send').disabled");
      await click("Send to Agent");
      const delivered = await poll;
      assert.ok(delivered.prompts.some((prompt) => prompt.prompt === "Unsent unrelated draft"));
      assert.ok(
        delivered.prompts.some(
          (prompt) => prompt.prompt.includes(exported) && prompt.prompt.includes(saved.takes[1].sha256),
        ),
      );
      await click("Intro takes");
      await until("document.querySelectorAll('.recording-take').length === 3");
      await click("Delete");
      await click("Cancel");
      assert.equal((await list()).takes.length, 3);
      await click("Delete");
      await click("Confirm delete");
      await until("document.querySelectorAll('.recording-take').length === 2");
      await click("Close");
      await chrome("open", session.url);
      await until("document.getElementById('layoutGateOverlay').hidden");
      await click("Intro takes");
      await until("document.querySelectorAll('.recording-take').length === 2");
      assert.match(await evaluate("document.getElementById('recordingTakes').textContent"), /Take 2 · Selected/);
      await click("Close");
      await click("Opening takes");
      await until("document.getElementById('recordingDialog').dataset.phase === 'idle'");
      assert.equal(await evaluate("document.querySelectorAll('.recording-take').length"), 0);

      t.diagnostic("Next permission refusal and storage failure are EXPECTED ERROR conditions using synthetic media.");
      await evaluate(
        "(() => { window.originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Test permission refusal', 'NotAllowedError'); }; return true; })()",
      );
      await click("Record");
      await until("document.getElementById('recordingStatus').textContent.includes('permission was refused')");
      await evaluate(
        "(() => { navigator.mediaDevices.getUserMedia = window.originalGetUserMedia; window.realFetch = window.fetch; window.fetch = (url, options) => options?.method === 'PUT' ? Promise.resolve(new Response(JSON.stringify({error:'Synthetic disk failure'}), {status:507})) : window.realFetch(url,options); return true; })()",
      );
      await click("Record");
      await until("document.getElementById('recordingDialog').dataset.phase === 'recording'");
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await click("Stop");
      await until("document.getElementById('recordingDialog').dataset.phase === 'unsaved'");
      assert.match(await evaluate("document.getElementById('recordingStatus').textContent"), /not confirmed saved/);
      await evaluate("(() => { window.fetch = window.realFetch; return true; })()");
      await click("Retry save");
      await until("document.getElementById('recordingStatus').textContent.includes('saved to local disk')");
      assert.equal(await evaluate("document.querySelectorAll('.recording-take').length"), 1);
      t.diagnostic(
        "Actual synthetic getUserMedia/MediaRecorder and silent playback passed; permission/storage faults were injected for recovery coverage.",
      );
      await click("Close");
      await chrome("stop");
      chromeEnv.CHROME_DEVTOOLS_AXI_USER_DATA_DIR = path.join(dir, "chrome-denied");
      chromeEnv.CHROME_DEVTOOLS_AXI_CHROME_ARGS =
        "--mute-audio --use-fake-device-for-media-stream --use-fake-ui-for-media-stream=deny --no-sandbox";
      await chrome("open", session.url);
      await until("document.getElementById('layoutGateOverlay').hidden");
      await click("Closing takes");
      await until("document.getElementById('recordingDialog').dataset.phase === 'idle'");
      await click("Record");
      await until("document.getElementById('recordingStatus').textContent.includes('permission was refused')");
      assert.equal(await evaluate("document.querySelectorAll('.recording-take').length"), 0);
      t.diagnostic(
        "A separate silent fake-media browser also refused permission through Chromium's actual permission path.",
      );
    } finally {
      try {
        await chrome("stop");
      } finally {
        await server.close();
        await rm(dir, { recursive: true, force: true });
      }
    }
  },
);
