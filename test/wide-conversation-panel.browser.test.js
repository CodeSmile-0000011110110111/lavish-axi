import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The side-by-side layout, measured in a real browser: the artifact and the conversation panel
// share the whole window at every width, the panel grows with the window between its 360px floor
// and 640px ceiling, the toolbar Conversation switch hides the panel so the artifact takes the
// full width, that choice survives a reload, and the phone dock ignores it.
const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, env, timeout = 45_000) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a TCP port");
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}

// The annotation card lives in the SDK's shadow root inside the sandboxed artifact frame, which
// the chrome page cannot read. The fixture measures the card itself and writes the numbers into
// a heading, so the accessibility snapshot carries them out of the frame.
const ARTIFACT = `<!doctype html>
<html><head><meta charset="utf-8"><title>Wide panel fixture</title>
<style>body{margin:0;padding:24px;font-family:Georgia,serif;background:#fffbf3;color:#17130a}</style>
</head><body>
<h1>Review this board</h1>
<p id="target">Annotate this paragraph to open the comment card.</p>
<h2 id="measure">card pending</h2>
<script>
setInterval(() => {
  for (const host of document.querySelectorAll("*")) {
    const card = host.shadowRoot && host.shadowRoot.querySelector(".lavish-annotation-card");
    if (!card) continue;
    const textarea = card.querySelector("textarea");
    document.getElementById("measure").textContent =
      "card " + Math.round(card.getBoundingClientRect().width) + " textarea " + Math.round(textarea.getBoundingClientRect().height);
    return;
  }
}, 100);
</script>
</body></html>`;

const GEOMETRY = `() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) }; };
  const panel = document.getElementById("panel");
  const toggle = document.getElementById("conversationToggle");
  return JSON.stringify({
    viewport: { width: innerWidth, height: innerHeight },
    frame: rect(document.getElementById("artifact")),
    panel: rect(panel),
    panelDisplayed: getComputedStyle(panel).display !== "none",
    panelPosition: getComputedStyle(panel).position,
    panelInert: panel.inert,
    toggle: rect(toggle),
    toggleVisible: toggle.getClientRects().length > 0,
    pressed: toggle.getAttribute("aria-pressed"),
    status: document.getElementById("conversationStatus").hidden ? null : document.getElementById("conversationStatus").textContent,
    textarea: rect(document.getElementById("chatInput")),
    draft: document.getElementById("chatInput").value,
    sheetOpen: document.body.classList.contains("sheet-open"),
    documentScrollable: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth,
  });
}`;

test(
  "the desktop layout fills the window and the Conversation sidebar hides, persists, and leaves the phone dock alone",
  { skip: !runBrowserE2e, timeout: 300_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-wide-panel-"));
    const port = await freePort();
    const lavishEnv = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: path.join(temp, "state"),
      LAVISH_AXI_NO_OPEN: "1",
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-wide-panel-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };

    function evaluate(expression) {
      const output = run("chrome-devtools-axi", ["eval", expression], chromeEnv);
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

    // A plain pause on this side: chrome-devtools-axi 0.1.34 fails `wait <ms>` with
    // "fn is not a function", and the steps between commands only need the page to settle.
    function wait(ms) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    }

    function emulate(viewport) {
      run("chrome-devtools-axi", ["emulate", "--viewport", viewport], chromeEnv);
      wait(300);
    }

    function open(url, settleMs = 4000) {
      run("chrome-devtools-axi", ["open", url], chromeEnv);
      wait(settleMs);
    }

    function geometry() {
      return evaluate(GEOMETRY);
    }

    function clickToggle() {
      evaluate('() => { document.getElementById("conversationToggle").click(); return "ok"; }');
      wait(300);
    }

    // The artifact starts at the left edge, the panel ends at the right edge, and they meet: no
    // column of the window is left unused at any width.
    function assertSideBySide(g, panelWidth) {
      assert.equal(g.panelDisplayed, true);
      assert.equal(g.panelInert, false);
      assert.equal(g.pressed, "true");
      assert.equal(g.status, null);
      assert.equal(g.panel.width, panelWidth, `panel width at ${g.viewport.width}px: ${JSON.stringify(g.panel)}`);
      assert.equal(g.frame.left, 0);
      assert.equal(g.frame.right, g.panel.left, "artifact and panel meet");
      assert.equal(g.panel.right, g.viewport.width, "panel reaches the right edge");
      assert.ok(g.textarea.height >= 160, `the composer opens tall: ${JSON.stringify(g.textarea)}`);
      assert.equal(g.documentScrollable, false);
    }

    function assertHidden(g) {
      assert.equal(g.panelDisplayed, false);
      assert.equal(g.panelInert, true);
      assert.equal(g.pressed, "false");
      assert.equal(g.frame.left, 0);
      assert.equal(g.frame.width, g.viewport.width, "the artifact takes the whole window width");
      assert.equal(g.toggleVisible, true, "the switch to bring the panel back stays in the toolbar");
      assert.ok(g.toggle.right <= g.viewport.width && g.toggle.bottom <= 56, JSON.stringify(g.toggle));
      assert.ok(g.status, "the toolbar reports the conversation while it is hidden");
      assert.equal(g.documentScrollable, false);
    }

    try {
      const artifact = path.join(temp, "review.html");
      await writeFile(artifact, ARTIFACT);
      const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);

      // Emulation needs a selected page.
      open(url);

      // ---- Fluid side-by-side layout ----
      for (const [viewport, panelWidth] of [
        ["961x700x1", 360],
        ["1440x1000x1", 432],
        ["2560x1200x1", 640],
      ]) {
        emulate(viewport);
        open(url);
        assertSideBySide(geometry(), panelWidth);
      }

      // ---- The comment card in the artifact ----
      emulate("1440x1000x1");
      open(url);
      const snapshot = run("chrome-devtools-axi", ["snapshot"], chromeEnv);
      const target = snapshot.split("\n").find((line) => /Annotate this paragraph/.test(line));
      assert.ok(target, `annotatable paragraph missing from snapshot:\n${snapshot}`);
      const uid = target.trim().split(/\s+/)[0].replace(/^uid=/, "");
      run("chrome-devtools-axi", ["click", `@${uid}`], chromeEnv);
      wait(800);
      const measured = run("chrome-devtools-axi", ["snapshot"], chromeEnv).match(/card (\d+) textarea (\d+)/);
      assert.ok(measured, "the fixture measured the annotation card");
      assert.equal(Number(measured[1]), 720, "the card is 720px wide when the frame has room");
      assert.equal(Number(measured[2]), 160, "the card's textarea opens 160px tall");

      // ---- Hide and restore ----
      open(url);
      evaluate('() => { document.getElementById("chatInput").value = "Keep this draft"; return "ok"; }');
      clickToggle();
      let g = geometry();
      assertHidden(g);
      assert.equal(g.draft, "Keep this draft");
      clickToggle();
      g = geometry();
      assertSideBySide(g, 432);
      assert.equal(g.draft, "Keep this draft");

      // The hidden state survives a reload of the review page.
      clickToggle();
      open(url);
      assertHidden(geometry());

      // ---- The phone dock ignores the desktop preference ----
      emulate("390x844x3,mobile,touch");
      open(url);
      g = geometry();
      assert.equal(g.panelDisplayed, true);
      assert.equal(g.panelPosition, "fixed");
      assert.equal(g.panelInert, false);
      assert.equal(g.toggleVisible, false, "the phone has its own dock control");
      assert.equal(g.sheetOpen, false);

      // Widening again brings the preference back, and the switch restores the panel.
      emulate("1440x1000x1");
      assertHidden(geometry());
      clickToggle();
      assertSideBySide(geometry(), 432);
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
