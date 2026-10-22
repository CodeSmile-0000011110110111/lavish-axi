# Recording board integration

Lavish owns microphone access, take management, and disk persistence. Boards use the
existing SDK message channel to open a recording panel in the trusted review chrome.
This keeps the artifact's opaque-origin sandbox intact. The browser refuses microphone
capture inside that sandbox, even on loopback. The trusted chrome can record from a
secure context after a user clicks Record and grants normal browser permission.

## Board API

```html
<button id="opening-takes" type="button" disabled>Opening takes</button>
<p id="recording-availability" role="status">Recording requires a compatible Lavish server.</p>
<script>
  document.addEventListener("DOMContentLoaded", () => {
    if (typeof window.lavish?.openRecorder !== "function") return;
    const button = document.getElementById("opening-takes");
    button.disabled = false;
    button.onclick = () => window.lavish.openRecorder({ section: "opening", label: "Opening" });
    document.getElementById("recording-availability").textContent = "Open takes, then click Record to begin.";
  });
</script>
```

`section` is a stable identifier, starting with a letter or digit, followed by letters,
digits, `_`, or `-`, up to 64 characters. `exports` is reserved. `label` is display text,
limited to 120 characters. The SDK validates the id and sends a token-stamped message;
the chrome validates its source, current artifact load, and id. A message only opens the
panel. Recording requires a trusted click on the chrome's Record button.

The [complete example](../test/fixtures/recording-board.html) has no external resources.
Its sections are `intro-evolution`, `issues`, `opening`, and `closing`. The same API can be
used on other boards. An existing button's own label and surrounding script remain the
board author's responsibility. No extension registration or additional service is needed.

## Adopting in the existing recording boards

The owner of the intro evolution/issues board can copy its published content to a new
durable filename and add buttons for `intro-evolution` and `issues`. The owner of the
opening/closing comparison board can do the same with `opening` and `closing`. Existing
published HTML, sessions, and feedback remain unchanged. Each new canonical HTML file
gets its own recordings; section ids distinguish takes within that file. Use the existing
guarded publication and feedback-watch procedure for the new versions.

The installed Lavish server must include this change. The legacy opaque-origin artifact
frame and response sandbox reject `getUserMedia`; a board-side script cannot add the
trusted capture and disk routes. Deployment requires an authorized update of the Lavish
installation and server process, followed by opening the newly published boards. Development
and verification use an isolated server on an ephemeral port. This implementation performs
no update, restart, replacement, or migration of a running shared server.

The current Firstmate guarded publication checker also needs to model `openRecorder`
and its `lavish:openRecorder` message before it can approve boards using this API.
The guarded check of the integration demo refused that unmodeled member. Its source is
`bin/fm-lavish-board-check.mjs` in Firstmate; that separate repository was left unchanged.
The demo remains unpublished until that checker supports the API. Recording never runs
inside its publication check: the board only opens the trusted recording view, whose
Record button is a separate user action.

## Audio handoff and recovery

Stop saves the browser's original WebM/Opus, Ogg/Opus, or MP4 audio bytes and metadata in
`recordings/<session-key>/<section>/` inside Lavish's state directory. A take has a random
id and an increasing section-local number. The id makes a retry after a lost response
idempotent. The manifest is replaced atomically after the audio is written and synced.
New recordings never overwrite an earlier take. The original audio is used for playback
and downloads without processing.

Use this take creates a retained local export, persists the selected id, and queues a
note containing the export's absolute path, duration, and SHA-256. The existing queued
note for that section is replaced when another take is chosen before sending. Other
queued notes and the composer draft remain intact. Sending remains an explicit user
action. The video worker can read the path from the delivered prompt and verify the
hash before importing. A browser blob URL is never presented as a filesystem path.

Downloads copy individual takes to the browser's download location. Previously exported
audio is retained when its take is deleted, so already queued or delivered notes still
refer to readable audio. Downloads and exports are unchanged copies. The recording budget
counts both original takes and their separate exported copies.
Archive the state directory and downloaded files separately for backup.

Closing the recorder during capture stops and saves first. Hiding the document stops
capture and playback. Closing the tab during capture or an incomplete save cannot
guarantee preservation; the browser receives a leave-page warning when possible.
Permission denial, missing devices, and unsupported browsers show recoverable status.
A save failure retains an unsaved Blob only for that tab's lifetime. Retry save uses the
same id; downloading gives a manual recovery copy. Browser storage is not used as a backup.
HTML export and hosted sharing omit all takes.

## Verification

`pnpm run check` runs the local build and standard checks. Focused storage and HTTP tests:

```sh
node --test test/recording-store.test.js test/recording-server.test.js
LAVISH_AXI_BROWSER_E2E=1 node --test test/recording.browser.test.js
```

The browser test launches a dedicated `chrome-devtools-axi` session with fake media and
`--mute-audio` set before launch. It records actual synthetic `MediaRecorder` data through
a Lavish-served board, exercises multiple takes, playback, seeking, selection and byte
identity, deletion, close/reopen, section separation, and recovery from injected permission
and storage failures. It never accesses a physical microphone or plays audible output.
A separate isolated Chromium session with fake-media permission set to deny verifies
the real browser permission-refusal path. The test also explicitly sends the selected
take note through a live Lavish poll with an unrelated composer draft preserved.
Real microphone acceptance remains a user action after activation: click Record, grant
permission, speak, Stop, listen, choose a take, and verify the downloaded/exported audio.
