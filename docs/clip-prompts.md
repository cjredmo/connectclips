# Clip prompt library

In a sermon's **Pick clips** section, open **AI Chat · Prompt Library**. Choose
Balanced Clips, Short & Punchy, Teaching / Theology, or Pastoral / Application.
These built-in selection focuses are read-only. **Duplicate / Customize** makes
an editable copy; custom selection instructions can also be created, renamed,
edited, duplicated, and deleted. The last selected prompt is remembered in the
browser.

**Copy Prompt + Transcript** assembles the shared clip-selection rules, the
selected focus, the shared ConnectClips JSON output contract, and then the
latest effective, timestamped transcript. **Preview full prompt** shows the
assembled instructions without transcript text. Paste the copied result into
an external AI chat. The contract asks for `schema_version: 1` JSON; bring
that JSON back with
**Import JSON** in Pick clips. ConnectClips does not send the transcript to an
AI service in this workflow. **Copy transcript only** remains available in the
full transcript review.

Custom prompts are installation-local runtime settings in the configured work
directory under `_settings/clip_prompts.json`. This versioned file is ignored by
Git and contains names, selection instructions, IDs, timestamps, and revisions,
never the shared rules, output contract, or copied transcript. Built-in
definitions live in the application and are not written to that file. Existing
version 1 custom prompts are read without rewriting the file; known shared
sections are stripped while custom additions remain, and the next save writes
the version 2 focus-only format.
