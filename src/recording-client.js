/* global document, window, MediaRecorder */

// Loaded only by the trusted review chrome. Artifact messages can open this view;
// only a trusted click on its Record button can request microphone access.
export function createRecordingPanel({ key, queueTake, isEnded }) {
  const dialog = document.createElement("dialog");
  dialog.className = "recording-dialog";
  dialog.id = "recordingDialog";
  dialog.setAttribute("aria-labelledby", "recordingTitle");
  dialog.innerHTML = `<div class="recording-heading"><h2 id="recordingTitle">Record takes</h2><button type="button" data-action="close">Close</button></div>
    <p>Record separate takes, listen, then use one for editing. The original audio stays unchanged.</p>
    <div class="recording-actions"><button type="button" data-action="record">Record</button><button type="button" data-action="stop" disabled>Stop</button><button type="button" data-action="refresh">Refresh takes</button></div>
    <p role="status" aria-live="polite" id="recordingStatus"></p>
    <div class="recording-recovery" hidden><button type="button" data-action="retry">Retry save</button><button type="button" data-action="download-unsaved">Download unsaved take</button><button type="button" data-action="discard">Discard unsaved take</button></div>
    <div id="recordingTakes"></div>
    <p class="recording-storage">Saved takes live in this Lavish server's local state directory. Download important audio as a backup. Closing the tab before saving finishes can lose the current take. Use this take preserves a local export and queues its path; Send to Agent delivers it.</p>`;
  document.body.append(dialog);
  const status = dialog.querySelector("#recordingStatus");
  const title = dialog.querySelector("#recordingTitle");
  const list = dialog.querySelector("#recordingTakes");
  const recovery = /** @type {HTMLElement} */ (dialog.querySelector(".recording-recovery"));
  const button = (action) => /** @type {HTMLButtonElement} */ (dialog.querySelector(`[data-action="${action}"]`));
  let section = "";
  let label = "";
  let phase = "idle";
  let generation = 0;
  let stream = null;
  let recorder = null;
  let timer = null;
  let pending = null;
  let closeAfterSave = false;
  let playing = null;
  let recordError = "";
  let loaded = false;
  let manifest = { takes: [], selected: null };
  let activeRequest = null;

  function endpoint(id = "") {
    return `/api/${key}/recordings/${section}${id ? `/${id}` : ""}`;
  }
  function message(text) {
    status.textContent = text;
  }
  function releaseMicrophone() {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  function pausePlayback() {
    playing?.pause();
    playing = null;
  }
  function controls() {
    button("record").disabled = phase !== "idle" || !loaded || isEnded();
    button("stop").disabled = phase !== "recording";
    button("refresh").disabled = phase !== "idle";
    recovery.hidden = phase !== "unsaved";
    for (const item of list.querySelectorAll("button")) item.disabled = phase !== "idle";
    for (const item of list.querySelectorAll("audio")) {
      item.controls = phase === "idle";
      item.setAttribute("aria-disabled", String(phase !== "idle"));
    }
    dialog.dataset.phase = phase;
  }
  async function request(url, options = {}) {
    const controller = new AbortController();
    activeRequest = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Recording request failed.");
      return data;
    } catch (error) {
      if (error.name === "AbortError")
        throw new Error("Lavish did not finish the request. Retry when the server is available.", { cause: error });
      throw error;
    } finally {
      clearTimeout(timeout);
      if (activeRequest === controller) activeRequest = null;
    }
  }
  function action(text, handler, parent) {
    const control = document.createElement("button");
    control.type = "button";
    control.textContent = text;
    control.onclick = handler;
    parent.append(control);
    return control;
  }
  function download(url, filename) {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
  }
  function render() {
    pausePlayback();
    list.replaceChildren();
    for (const take of manifest.takes) {
      const row = document.createElement("section");
      row.className = "recording-take";
      row.dataset.takeId = take.id;
      const heading = document.createElement("h3");
      heading.textContent = `Take ${take.number}${manifest.selected === take.id ? " · Selected for editing" : ""}`;
      row.append(heading);
      const details = document.createElement("p");
      details.textContent = `${(take.durationMs / 1000).toFixed(1)} seconds · ${new Date(take.createdAt).toLocaleString()}`;
      row.append(details);
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.preload = "metadata";
      audio.src = endpoint(take.id);
      audio.setAttribute("aria-label", `Play or seek take ${take.number}`);
      audio.onplay = () => {
        if (phase !== "idle") {
          audio.pause();
          return;
        }
        if (playing && playing !== audio) playing.pause();
        playing = audio;
      };
      audio.onerror = () =>
        message(
          `Take ${take.number} could not be played. Refresh takes or download the audio for a compatible player.`,
        );
      row.append(audio);
      const actions = document.createElement("div");
      actions.className = "recording-actions";
      action(
        "Use this take",
        async () => {
          if (phase !== "idle" || isEnded()) return;
          phase = "selecting";
          pausePlayback();
          controls();
          try {
            const exported = await request(`${endpoint(take.id)}/select`, { method: "POST" });
            manifest.selected = take.id;
            if (!queueTake({ section, label, take: exported }))
              throw new Error(
                "Selection saved. The note could not be queued; retry Use this take when the session accepts notes.",
              );
            message(`Take ${take.number} selected. Its audio path is queued; it leaves only on Send to Agent.`);
          } catch (error) {
            message(error.message);
          } finally {
            phase = "idle";
            render();
          }
        },
        actions,
      );
      action(
        "Download",
        () => download(`${endpoint(take.id)}?download=1`, `${section}-take-${take.number}.${take.extension}`),
        actions,
      );
      action(
        "Delete",
        () => {
          if (phase !== "idle") return;
          const confirm = document.createElement("div");
          confirm.className = "recording-delete";
          confirm.textContent = `Delete take ${take.number}? Exports already queued for editing are retained. `;
          action(
            "Confirm delete",
            async () => {
              if (phase !== "idle") return;
              phase = "deleting";
              pausePlayback();
              controls();
              try {
                manifest = await request(endpoint(take.id), { method: "DELETE" });
                message(`Take ${take.number} deleted.`);
              } catch (error) {
                message(error.message);
              } finally {
                phase = "idle";
                render();
              }
            },
            confirm,
          );
          action("Cancel", () => confirm.remove(), confirm);
          row.querySelector(".recording-delete")?.remove();
          row.append(confirm);
        },
        actions,
      );
      row.append(actions);
      list.append(row);
    }
    if (!manifest.takes.length) list.textContent = "No saved takes in this section.";
    controls();
  }
  async function refresh() {
    if (phase !== "idle") return;
    phase = "loading";
    controls();
    try {
      manifest = await request(endpoint());
      loaded = true;
      message("Ready. Click Record to request microphone access.");
    } catch (error) {
      loaded = false;
      message(error.message);
    } finally {
      phase = "idle";
      render();
    }
  }
  async function save() {
    if (!pending) return;
    phase = "saving";
    controls();
    message("Saving take to local disk…");
    try {
      const take = await request(`${endpoint(pending.id)}?duration_ms=${pending.durationMs}`, {
        method: "PUT",
        headers: { "content-type": pending.blob.type },
        body: pending.blob,
      });
      if (!manifest.takes.some((item) => item.id === take.id)) manifest.takes.push(take);
      pending = null;
      phase = "idle";
      message(`Take ${take.number} saved to local disk.${recordError ? ` Capture ended early: ${recordError}` : ""}`);
      if (closeAfterSave) dialog.close();
    } catch (error) {
      phase = "unsaved";
      closeAfterSave = false;
      message(`Take is not confirmed saved. ${error.message} Retry save or download it before leaving.`);
    }
    render();
  }
  function stop() {
    if (phase !== "recording") return;
    phase = "stopping";
    clearInterval(timer);
    timer = null;
    try {
      if (recorder?.state !== "inactive") recorder.stop();
    } finally {
      releaseMicrophone();
      controls();
    }
  }
  async function start(event) {
    if (!event.isTrusted || phase !== "idle" || !loaded || isEnded()) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      message(
        "Recording needs a supported browser at localhost, 127.0.0.1, or HTTPS. Reopen this board at a secure address.",
      );
      return;
    }
    const token = ++generation;
    pausePlayback();
    phase = "requesting";
    closeAfterSave = false;
    recordError = "";
    controls();
    message("Waiting for microphone permission. You can close this view to cancel.");
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
      if (token !== generation || !dialog.open) {
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = acquired;
      const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      if (!mimeType) throw new Error("This browser has no supported audio recording format.");
      recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 128000 });
      const chunks = [];
      let size = 0;
      const started = performance.now();
      recorder.ondataavailable = (event) => {
        if (event.data.size) {
          chunks.push(event.data);
          size += event.data.size;
        }
        if (size >= 60 * 1024 * 1024) {
          recordError = "size limit reached";
          stop();
        }
      };
      recorder.onerror = (event) => {
        recordError = event.error?.message || "microphone capture error";
        stop();
      };
      recorder.onstop = () => {
        clearInterval(timer);
        timer = null;
        releaseMicrophone();
        const blob = new Blob(chunks, { type: recorder.mimeType });
        recorder = null;
        if (!blob.size) {
          phase = "idle";
          message("No audio was captured. Check the microphone and try Record again.");
          controls();
          return;
        }
        pending = {
          id: window.crypto.randomUUID().replaceAll("-", ""),
          blob,
          durationMs: Math.max(1, Math.min(1800000, Math.round(performance.now() - started))),
        };
        void save();
      };
      for (const track of stream.getTracks())
        track.onended = () => {
          recordError = "microphone disconnected";
          stop();
        };
      recorder.start(1000);
      phase = "recording";
      controls();
      const tick = () => {
        const elapsed = performance.now() - started;
        message(`Recording · ${(elapsed / 1000).toFixed(0)} seconds. Stop to save this take.`);
        if (elapsed >= 1800000) {
          recordError = "30 minute limit reached";
          stop();
        }
      };
      tick();
      timer = setInterval(tick, 500);
    } catch (error) {
      if (token !== generation) return;
      releaseMicrophone();
      phase = "idle";
      const explanation =
        error.name === "NotAllowedError"
          ? "Microphone permission was refused. Allow microphone access in this site's browser controls, then click Record again."
          : `Microphone unavailable: ${error.message} Check the device, then try Record again.`;
      message(explanation);
      controls();
    }
  }
  function close() {
    pausePlayback();
    if (phase === "recording") {
      closeAfterSave = true;
      stop();
      return;
    }
    if (["stopping", "saving"].includes(phase)) {
      closeAfterSave = true;
      return;
    }
    if (pending) {
      message("This take is not confirmed saved. Retry save, download it, or explicitly discard it before closing.");
      return;
    }
    ++generation;
    activeRequest?.abort();
    releaseMicrophone();
    if (phase === "requesting") phase = "idle";
    dialog.close();
  }
  button("record").onclick = start;
  button("stop").onclick = stop;
  button("close").onclick = close;
  button("refresh").onclick = refresh;
  button("retry").onclick = save;
  button("download-unsaved").onclick = () => {
    if (!pending) return;
    const extension = pending.blob.type.includes("mp4") ? "m4a" : pending.blob.type.includes("ogg") ? "ogg" : "webm";
    const url = URL.createObjectURL(pending.blob);
    download(url, `${section}-unsaved-${pending.id}.${extension}`);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  button("discard").onclick = () => {
    if (pending && window.confirm("Discard this unsaved take? Download it first if you need a copy.")) {
      pending = null;
      phase = "idle";
      message("Unsaved take discarded.");
      controls();
    }
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stop();
      pausePlayback();
    }
  });
  window.addEventListener("pagehide", () => {
    stop();
    releaseMicrophone();
    pausePlayback();
  });
  window.addEventListener("beforeunload", (event) => {
    if (pending || ["recording", "stopping", "saving"].includes(phase)) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  return {
    close,
    async open(nextSection, nextLabel) {
      if (dialog.open || phase !== "idle" || pending) return;
      section = nextSection;
      label = nextLabel;
      title.textContent = `${label} · Record takes`;
      loaded = false;
      manifest = { takes: [], selected: null };
      render();
      dialog.showModal();
      await refresh();
    },
  };
}
