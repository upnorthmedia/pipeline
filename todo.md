# todo

- [confirmed] 2026-08-21 `pytest` writes real image files into `media/test-123/` on every run,
  and 39 of those artifacts are already committed to git. Running the backend suite from the
  host leaves untracked junk in the working tree. The images stage should write to a tmp dir
  under test. Out of scope for the Mastra port ledger; revisit when the images stage is ported
  (Phase 3.5).

- [confirmed] 2026-08-21 The `images` stage's featured-image handling never fires on real
  manifests. `images.py` tests `image_spec.get("placement") == "featured"`, but the manifest
  Claude actually produces (live capture, `docs/mastra-port/golden/how-to-choose-a-crm-for-a-small-team/images.json`)
  sets `placement` to an object (`{"location": "featured_image", "after_section": null}`) and
  carries the featured marker on `type`. Result: the 2K/16:9 override and the 1920px optimise
  width are skipped, and the `featured-<MMDDYY>-<NN>` rename only happens via the `type` branch.
  Port must decide which shape is canonical rather than copying the mismatch (Phase 3.5).

- [confirmed] 2026-08-21 The Gemini API key in the main checkout's `.env` has **zero** image
  quota: every `gemini-3.1-flash-image` call returns 429 `RESOURCE_EXHAUSTED` with
  `limit: 0, model: gemini-3.1-flash-image` on the free tier. No image can be generated in
  any environment using that key. Blocks the images half of Phase 0 golden capture and the
  Phase 5 images-model verification until billing is enabled on that Google project.

- [investigate] 2026-08-21 `ClaudeClient.chat` sends `thinking={"type": "enabled",
  "budget_tokens": 10000}`, which the installed anthropic SDK now warns is deprecated for
  `claude-opus-4-6`: "Use 'thinking.type=adaptive' instead which results in better model
  performance in our testing". Every live pipeline run emits this UserWarning. Decide the
  target thinking configuration during the Phase 3 stage ports rather than copying the
  deprecated shape into TypeScript.
