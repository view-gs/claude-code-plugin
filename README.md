# View.gs plugin for Claude Code

Publish Gaussian Splat `.ply` / `.splat` files to [View.gs](https://view.gs) and open
published scenes in an interactive 3D viewer, from inside Claude Code.

## Install

```
/plugin marketplace add view-gs/viewgs-plugin
/plugin install viewgs@l2labs
```

## Viewing needs no account

Once installed, paste any View.gs scene link and ask to see it:

> Open this scene: https://view.gs/v/YOUR_SCENE_ID

`show_scene` opens the interactive viewer; `get_scene` returns name, format, size, camera
and expiry. Both read through the hosted connector at `https://view.gs/api/mcp`, which is
read-only and anonymous. Only published, unexpired scenes are readable.

## Uploading needs a key

Publishing a local file requires a View.gs service-account key. Set it in `/plugin` →
View.gs → Configure. It is stored as a sensitive value and passed only to a local
process — it never reaches a remote endpoint, your repository, or the conversation.

With a key configured, this works:

> my training run wrote out/scene.ply — can you get me a link to share?

Claude uploads the file, publishes it, and reports the viewer URL with its expiry.

Contact L2labs for a service-account key.

## Limits

- `.ply` and `.splat` only, up to 500,000,000 bytes.
- Free-plan scenes expire **48 hours** after upload. Every result reports its `expiresAt`.
- Uploads are rate limited per service account, per hour.
- A published link grants access to that scene to anyone holding it.
- Interactive rendering needs a host with MCP Apps support, WebGL, workers and WebAssembly.
  Elsewhere you get metadata and a link.

## Requirements

Node.js 20 or newer on `PATH`. The uploader has no npm dependencies.

## Layout

```
.claude-plugin/marketplace.json   this marketplace
plugins/viewgs/                   the plugin
```

See [`plugins/viewgs/README.md`](plugins/viewgs/README.md) for scripted/CI use and
troubleshooting.
