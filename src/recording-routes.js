import { createRecordingStore, MAX_RECORDING_BYTES, validRecordingReference } from "./recording-store.js";

export function installRecordingRoutes(app, { stateDir, store, sameOrigin, readBody }) {
  const recordings = createRecordingStore(stateDir, { runExclusive: (operation) => store.runExclusive(operation) });
  const route = "/api/:key/recordings/:section";
  let uploads = 0;
  app.use(route, async (req, res, next) => {
    try {
      if (!sameOrigin(req)) return res.status(403).json({ error: "Cross-origin recording access rejected." });
      if (!validRecordingReference(req.params.key, req.params.section) || !(await store.findByKey(req.params.key))) {
        return res.status(404).json({ error: "Recording section not found." });
      }
      res.setHeader("cache-control", "no-store");
      next();
    } catch (error) {
      next(error);
    }
  });
  const handle = (operation) => async (req, res) => {
    try {
      await operation(req, res);
    } catch (error) {
      res.status(error.status || 500).json({
        error: error.status
          ? error.message
          : "Recording storage failed. Check local disk space and permissions, then retry.",
      });
    }
  };
  app.get(
    route,
    handle(async (req, res) => res.json(await recordings.list(req.params.key, req.params.section))),
  );
  app.put(
    `${route}/:id`,
    handle(async (req, res) => {
      if (!validRecordingReference(req.params.key, req.params.section, req.params.id))
        return res.status(400).json({ error: "Invalid recording reference." });
      if (uploads >= 2) return res.status(429).json({ error: "Another recording is saving. Retry shortly." });
      uploads += 1;
      try {
        const { tooLarge, buffer } = await readBody(req, MAX_RECORDING_BYTES);
        if (tooLarge) return res.status(413).json({ error: "Recording exceeds the 64 MiB take limit." });
        const take = await recordings.save(
          req.params.key,
          req.params.section,
          req.params.id,
          buffer,
          Number(req.query.duration_ms),
        );
        res.json(take);
      } finally {
        uploads -= 1;
      }
    }),
  );
  app.get(
    `${route}/:id`,
    handle(async (req, res) => {
      const take = await recordings.resolve(req.params.key, req.params.section, req.params.id);
      res.setHeader("x-content-type-options", "nosniff");
      res.type(take.mime);
      if (req.query.download === "1") res.attachment(`${req.params.section}-take-${take.number}.${take.extension}`);
      res.sendFile(take.path, { dotfiles: "allow" });
    }),
  );
  app.post(
    `${route}/:id/select`,
    handle(async (req, res) => res.json(await recordings.select(req.params.key, req.params.section, req.params.id))),
  );
  app.delete(
    `${route}/:id`,
    handle(async (req, res) => res.json(await recordings.remove(req.params.key, req.params.section, req.params.id))),
  );
}
