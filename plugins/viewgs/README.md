# View.gs plugin for Claude Code

Publish Gaussian Splat `.ply` / `.splat` files to [View.gs](https://view.gs) and open them
in an interactive 3D viewer, without leaving Claude Code.

## Install

```bash
/plugin marketplace add l2labs/viewgs-plugin
/plugin install viewgs@l2labs
```

Then set your API key: `/plugin` → View.gs → Configure → **View.gs API key**. It is stored
as a sensitive value and passed to the uploader process only; it never appears in the
transcript, in your repository, or in any file this plugin writes.

Viewing published scenes needs no key. Uploading does.

## What you get

| | |
|---|---|
| `viewgs_upload` | Uploads and publishes a local `.ply`/`.splat`, returns the viewer link. Runs locally; your key never leaves your machine. |
| `show_scene` | Opens a published scene in an interactive viewer. |
| `get_scene` | Scene metadata and links. |

The two read tools come from the hosted connector at `https://view.gs/api/mcp`
(Streamable HTTP, read-only, anonymous).

## Use it

Just say what you want — the skills trigger on their own:

> publish this splat: `out/scene.ply`
>
> show me the model from the last run

Or from a script / CI:

```bash
export VIEWGS_API_KEY=vgs_sa_...
node scripts/viewgs-upload.mjs scene.ply --name "Warehouse bay 3" --save result.json --json
```

`--camera camera.json` sets the opening camera; see `examples/camera.json`. Omit it and
the scene opens on the standard viewer camera.

## Things to know

- **Scenes expire.** The free plan keeps a link online for 48 hours. `expiresAt` in every
  result is authoritative.
- **Max file size is 500,000,000 bytes**, `.ply` and `.splat` only.
- **Uploads are rate limited** per service account, per hour. One key per user or per CI
  job, not one key shared across a team.
- **A published link is the credential.** Anyone who has it can open the scene, and the
  MCP connector reads it anonymously. Don't publish anything you wouldn't hand out.
- Interactive rendering needs a host with MCP Apps support, WebGL, workers and WebAssembly.
  Elsewhere you get metadata and a link.

## Requirements

Node.js 20 or newer, on `PATH`. No npm dependencies.

## Troubleshooting

**`tools fetch failed — Request timed out` on the View.gs connector.** The hosted endpoint
can be slow to wake after an idle period, and the first connection may exceed the client's
timeout. Run `/plugin` → Errors to confirm, then start a new session or run
`/reload-plugins`; the second attempt connects. `show_scene` and `get_scene` are missing
until it does — `viewgs_upload` is local and unaffected.

**`VIEWGS_API_KEY is not set`.** The plugin has no key configured. `/plugin` → View.gs →
Configure. Viewing needs no key; uploading does.

**Check what loaded:** `claude mcp list` shows `plugin:viewgs:viewgs` (hosted, viewer) and
`plugin:viewgs:viewgs-upload` (local, uploader). Both should report `✔ Connected`.
