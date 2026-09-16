---
name: publish
description: Publish a Gaussian Splat file to View.gs and get a shareable viewer link. Use whenever the user has, produces, or asks to look at a .ply or .splat Gaussian Splat — including after a training or reconstruction run finishes, or when they ask to share, preview, view, or send someone a splat, 3D scan, radiance field, or point cloud.
---

# Publishing a scene to View.gs

View.gs hosts Gaussian Splat scenes and gives each one a viewer link. This skill covers
getting a file up there. Opening one for the user is a separate skill, `show`.

## Offer it when it is useful

When a Gaussian Splat file is in play and the user has not asked for anything else,
say you can publish it and get them a link they can open or send on. Ask once, then
do it. Do not publish files the user has not pointed you at.

If there is no `.ply` or `.splat` file yet, ask for the path. Only those two formats
work, and the file must be at most 500,000,000 bytes.

## Publishing

Call the **`viewgs_upload`** tool with the absolute path:

```
viewgs_upload({file: "/abs/path/scene.ply", name: "Warehouse bay 3"})
```

It handles the multipart upload, retries, verification, publication and cleanup in one
call, and returns:

```json
{"shareId": "...", "viewerUrl": "https://view.gs/v/...", "expiresAt": "...", "name": "...", "sizeBytes": 0, "format": "ply"}
```

- `name` is optional and defaults to the filename without its extension. It is trimmed
  to 80 characters.
- `camera` is optional. Omit it and the scene opens on the standard viewer camera. Pass
  one only when you have a real opening camera for *this* scene, as three finite vectors
  in the View.gs convention:
  `{"position": [x,y,z], "direction": [x,y,z], "up": [x,y,z]}`.
  `direction` and `up` must be non-zero and non-parallel. Never pass a training-camera
  matrix, a COLMAP pose or a view matrix without converting it first — a wrong camera
  opens the scene pointing at nothing. See `examples/camera.json` in this plugin.
- A large file takes a while. Do not start a second upload of the same file because the
  first is slow.

## After it succeeds

Report the `viewerUrl` and say when it expires. **Scenes are not permanent** — the
`expiresAt` timestamp is the moment the link stops working, and on the free plan that
is 48 hours after upload. Tell the user that, without being asked.

Keep each result with the run it came from: the file path, and whatever run name,
parameters and metrics produced it. If the project has somewhere natural to record it,
write it there (the CLI's `--save result.json` does this for scripted runs). You need
this later to show the right model, and to avoid re-uploading something already online.

Never reuse a `shareId` or `viewerUrl` from an example, from documentation, or from a
different file. Each upload returns its own.

## When it fails

The tool returns a message and an `error` code. Pass the meaning on plainly:

| Code | What to tell the user |
|---|---|
| `authentication` (401) | The View.gs credential is missing, invalid, disabled or expired. They need to set the API key in `/plugin` configuration for the `viewgs` plugin. |
| `file_too_large` (413) | The file exceeds the size limit for this account's plan. |
| `unsupported_format`, `invalid_camera`, `invalid_parts` (422) | The file is not a usable PLY/SPLAT, or the camera is invalid. Do not retry unchanged. |
| `rate_limited` (429) | This service account hit its hourly upload limit. Wait, do not hammer it. |
| `network`, 5xx | Already retried with backoff. Report that View.gs is unreachable or unhealthy. |

The tool cleans up its own failed upload sessions. Do not try to delete anything yourself,
and never treat a *published* scene as something to remove during error recovery.

## What this does not do

Uploading is an authenticated HTTP call made by this tool. It does not render anything.
To actually show the user the scene, use `show`. Printing the viewer URL, or
describing a tool call, is not the same as displaying the model.

## Scripted use

The same uploader runs as a command for CI and batch jobs, reading `VIEWGS_API_KEY` and
`VIEWGS_API_BASE` from the environment:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/viewgs-upload.mjs" scene.ply \
  --name "Warehouse bay 3" [--camera camera.json] [--save result.json] [--json]
```

Never print, log, hardcode or commit the API key, and never hand it to browser or
client-side code.
