#!/usr/bin/env node
// View.gs uploader. Runs as a CLI, or as a stdio MCP server with --mcp.
// The API key is read from the environment and never logged or echoed back.
import {open, stat, readFile, writeFile} from 'node:fs/promises'
import {basename} from 'node:path'
import {parseArgs} from 'node:util'

const VERSION = '0.1.0'
const MAX_BYTES = 500_000_000
const CONCURRENCY = 4
const NAME_LIMIT = 80
const ATTEMPTS = 5

class UploadError extends Error {
  constructor(message, {code = 'upload_failed', status} = {}) {super(message); this.code = code; this.status = status}
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// Full jitter keeps a fleet of retrying parts from re-colliding on the same tick.
const backoff = attempt => sleep(Math.round(Math.random() * Math.min(8000, 250 * 2 ** attempt)))
const retriable = status => status === undefined || status === 429 || status >= 500

function credentials() {
  const apiKey = process.env.VIEWGS_API_KEY
  if (!apiKey) throw new UploadError('VIEWGS_API_KEY is not set. Configure the View.gs plugin with a service-account key.', {code: 'authentication', status: 401})
  return {apiKey, apiBase: (process.env.VIEWGS_API_BASE || 'https://view.gs/api').replace(/\/+$/, '')}
}

// Maps the documented API failures onto messages a person can act on.
function explain(status, body) {
  const detail = typeof body?.message === 'string' ? body.message : ''
  const code = typeof body?.code === 'string' ? body.code : `http_${status}`
  if (status === 401) return new UploadError('View.gs rejected the service credential (missing, invalid, disabled or expired). Check the plugin configuration.', {code: 'authentication', status})
  if (status === 413) return new UploadError(detail || 'The file or request is too large for this View.gs plan.', {code, status})
  if (status === 422) return new UploadError(detail || 'View.gs could not accept this file, its parts, or the camera.', {code, status})
  if (status === 429) return new UploadError('This View.gs service account has reached its upload limit. Wait and try again.', {code: 'rate_limited', status})
  return new UploadError(detail || `View.gs returned HTTP ${status}.`, {code, status})
}

async function api(apiBase, apiKey, method, path, body) {
  let last
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt) await backoff(attempt)
    let response
    try {
      response = await fetch(`${apiBase}${path}`, {
        method,
        headers: {authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : {'content-type': 'application/json'})},
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (cause) {
      last = new UploadError(`Could not reach View.gs (${cause.message}).`, {code: 'network'}); continue
    }
    if (response.ok) return response.status === 204 ? {} : await response.json().catch(() => ({}))
    const parsed = await response.json().catch(() => undefined)
    last = explain(response.status, parsed)
    if (!retriable(response.status)) throw last
  }
  throw last
}

// One part at a time per worker: peak memory is CONCURRENCY * partSize, never the whole file.
async function putPart(handle, url, partNumber, offset, length) {
  const buffer = Buffer.allocUnsafe(length)
  let read = 0
  while (read < length) {
    const {bytesRead} = await handle.read(buffer, read, length - read, offset + read)
    if (!bytesRead) throw new UploadError(`The file ended early while reading part ${partNumber}.`, {code: 'file_truncated'})
    read += bytesRead
  }
  let last
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt) await backoff(attempt)
    let response
    try {
      // The signed S3 URL carries its own auth: never attach the View.gs bearer token here.
      response = await fetch(url, {method: 'PUT', headers: {'content-length': String(length)}, body: buffer})
    } catch (cause) {
      last = new UploadError(`Part ${partNumber} failed (${cause.message}).`, {code: 'network'}); continue
    }
    if (response.ok) {
      const etag = response.headers.get('etag')
      if (!etag) throw new UploadError(`Storage did not return an ETag for part ${partNumber}.`, {code: 'missing_etag'})
      return {PartNumber: partNumber, ETag: etag} // Preserved verbatim, quotes included.
    }
    await response.arrayBuffer().catch(() => {})
    last = new UploadError(`Part ${partNumber} was rejected by storage (HTTP ${response.status}).`, {code: 'storage', status: response.status})
    if (!retriable(response.status)) throw last
  }
  throw last
}

async function pool(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const run = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, run))
  return results
}

function validateCamera(camera) {
  if (camera === undefined) return undefined
  const axis = key => {
    const value = camera?.[key]
    if (!Array.isArray(value) || value.length !== 3 || !value.every(n => typeof n === 'number' && Number.isFinite(n))) {
      throw new UploadError(`camera.${key} must be three finite numbers.`, {code: 'invalid_camera', status: 422})
    }
    return value
  }
  const position = axis('position'), direction = axis('direction'), up = axis('up')
  const unit = (v, key) => {
    const length = Math.hypot(...v)
    if (length < 1e-6) throw new UploadError(`camera.${key} must not be a zero-length vector.`, {code: 'invalid_camera', status: 422})
    return v.map(n => n / length)
  }
  const d = unit(direction, 'direction'), u = unit(up, 'up')
  if (Math.abs(d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) > 0.9999) {
    throw new UploadError('camera.direction and camera.up must not be parallel.', {code: 'invalid_camera', status: 422})
  }
  return {position, direction, up}
}

export async function publish({file, name, camera, onProgress = () => {}}) {
  const {apiKey, apiBase} = credentials()
  const filename = basename(file)
  if (!/\.(ply|splat)$/i.test(filename)) throw new UploadError('View.gs accepts .ply and .splat Gaussian Splat files only.', {code: 'unsupported_format', status: 422})
  const info = await stat(file).catch(() => {throw new UploadError(`No such file: ${file}`, {code: 'missing_file'})})
  if (!info.isFile() || info.size <= 0) throw new UploadError(`${file} is empty or not a regular file.`, {code: 'empty_file', status: 422})
  if (info.size > MAX_BYTES) throw new UploadError(`${filename} is ${info.size} bytes; the limit is ${MAX_BYTES}.`, {code: 'file_too_large', status: 413})

  const pose = validateCamera(camera)
  const displayName = (name?.trim().replace(/\s+/g, ' ') || filename.replace(/\.(ply|splat)$/i, '')).slice(0, NAME_LIMIT)
  if (!displayName) throw new UploadError('The scene name is empty.', {code: 'invalid_name', status: 422})

  onProgress({phase: 'start', filename, sizeBytes: info.size})
  const session = await api(apiBase, apiKey, 'POST', '/uploads', {filename, sizeBytes: info.size})
  const {sessionId, partSize, partUrls} = session
  if (!sessionId || !Number.isSafeInteger(partSize) || partSize < 1 || !Array.isArray(partUrls) || !partUrls.length) {
    throw new UploadError('View.gs returned an unusable upload session.', {code: 'invalid_session'})
  }

  const handle = await open(file, 'r')
  let completed = false
  try {
    let done = 0
    const parts = await pool(partUrls, CONCURRENCY, async (url, index) => {
      const offset = index * partSize
      const part = await putPart(handle, url, index + 1, offset, Math.min(partSize, info.size - offset))
      onProgress({phase: 'part', done: ++done, total: partUrls.length})
      return part
    })
    parts.sort((a, b) => a.PartNumber - b.PartNumber)

    onProgress({phase: 'complete'})
    // api() already retries an ambiguous completion; completion is idempotent server-side.
    const draft = await api(apiBase, apiKey, 'POST', `/uploads/${sessionId}/complete`, {parts})
    completed = true
    if (!draft?.shareId) throw new UploadError('View.gs completed the upload without returning a shareId.', {code: 'invalid_completion'})

    onProgress({phase: 'publish', shareId: draft.shareId})
    const scene = await api(apiBase, apiKey, 'POST', `/shares/${draft.shareId}/publish`, {name: displayName, ...(pose ? {camera: pose} : {})})
    if (!scene?.isPublished || !scene.viewerUrl) throw new UploadError('View.gs did not report the scene as published.', {code: 'not_published'})

    return {
      shareId: scene.shareId,
      viewerUrl: scene.viewerUrl,
      embedUrl: scene.embedUrl,
      expiresAt: scene.expiresAt,
      name: scene.displayName ?? displayName,
      sizeBytes: scene.sizeBytes,
      format: scene.format,
      sourceFile: file,
    }
  } catch (error) {
    // Best effort only, and never for a scene that already exists as a draft or published share.
    if (!completed) await api(apiBase, apiKey, 'DELETE', `/uploads/${sessionId}`).catch(() => {})
    throw error
  } finally {
    await handle.close().catch(() => {})
  }
}

// --- MCP stdio server ---------------------------------------------------------

const TOOL = {
  name: 'viewgs_upload',
  title: 'Upload and publish a View.gs scene',
  description: 'Upload a local Gaussian Splat .ply or .splat file to View.gs and publish it, returning the scene id, viewer URL and expiry. Uploading is authenticated with the configured service account. This does not display the scene: use the View.gs show_scene tool with the returned viewerUrl for that.',
  inputSchema: {
    type: 'object',
    properties: {
      file: {type: 'string', description: 'Absolute path to a local .ply or .splat file, at most 500000000 bytes.'},
      name: {type: 'string', description: 'Scene name shown in the viewer, up to 80 characters. Defaults to the filename without its extension.'},
      camera: {
        type: 'object',
        description: 'Optional opening camera in the View.gs convention. Omit it unless you have a real camera for this scene; do not pass a training-camera matrix.',
        properties: {
          position: {type: 'array', items: {type: 'number'}, minItems: 3, maxItems: 3},
          direction: {type: 'array', items: {type: 'number'}, minItems: 3, maxItems: 3},
          up: {type: 'array', items: {type: 'number'}, minItems: 3, maxItems: 3},
        },
        required: ['position', 'direction', 'up'],
        additionalProperties: false,
      },
    },
    required: ['file'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      shareId: {type: 'string'}, viewerUrl: {type: 'string'}, embedUrl: {type: 'string'},
      expiresAt: {type: 'string'}, name: {type: 'string'}, sizeBytes: {type: 'number'},
      format: {type: 'string'}, sourceFile: {type: 'string'},
    },
    required: ['shareId', 'viewerUrl', 'expiresAt'],
    additionalProperties: true,
  },
  annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
}

const INSTRUCTIONS = 'Uploads local Gaussian Splat files to View.gs. Published scenes expire; always report the returned expiresAt. Showing a scene is a separate call to the View.gs show_scene tool with the viewerUrl this tool returned. Never reuse a viewerUrl from an example or from a different file.'

function serveMcp() {
  const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
  const reply = (id, result) => send({jsonrpc: '2.0', id, result})

  const handle = async message => {
    const {id, method, params} = message
    if (id === undefined || id === null) return // notification
    if (method === 'initialize') {
      const requested = params?.protocolVersion
      return reply(id, {
        protocolVersion: typeof requested === 'string' ? requested : '2025-06-18',
        capabilities: {tools: {}},
        serverInfo: {name: 'viewgs-upload', version: VERSION},
        instructions: INSTRUCTIONS,
      })
    }
    if (method === 'ping') return reply(id, {})
    if (method === 'tools/list') return reply(id, {tools: [TOOL]})
    if (method === 'tools/call') {
      if (params?.name !== TOOL.name) {
        return send({jsonrpc: '2.0', id, error: {code: -32602, message: `Unknown tool: ${params?.name}`}})
      }
      try {
        const result = await publish({...params.arguments, onProgress: event => process.stderr.write(`${JSON.stringify(event)}\n`)})
        return reply(id, {content: [{type: 'text', text: JSON.stringify(result)}], structuredContent: result})
      } catch (error) {
        const payload = {error: error.code ?? 'upload_failed', message: error.message, ...(error.status ? {status: error.status} : {})}
        return reply(id, {content: [{type: 'text', text: JSON.stringify(payload)}], isError: true})
      }
    }
    send({jsonrpc: '2.0', id, error: {code: -32601, message: `Unknown method: ${method}`}})
  }

  let buffer = ''
  let inFlight = 0
  let closed = false
  // stdin can close while an upload is still running. Drain before exiting, or the
  // tool call dies silently and its half-finished session is never cleaned up.
  const settle = () => {if (closed && inFlight === 0) process.exit(0)}
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try {message = JSON.parse(line)} catch {
        send({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error'}}); continue
      }
      inFlight++
      handle(message)
        .catch(cause => send({jsonrpc: '2.0', id: message.id ?? null, error: {code: -32603, message: cause.message}}))
        .finally(() => {inFlight--; settle()})
    }
  })
  process.stdin.on('end', () => {closed = true; settle()})
}

// --- CLI ----------------------------------------------------------------------

async function main() {
  if (process.argv.includes('--mcp')) return serveMcp()
  const {values, positionals} = parseArgs({
    allowPositionals: true,
    options: {name: {type: 'string'}, camera: {type: 'string'}, save: {type: 'string'}, json: {type: 'boolean'}, help: {type: 'boolean'}},
  })
  if (values.help || positionals.length !== 1) {
    process.stderr.write('Usage: viewgs-upload <file.ply|file.splat> [--name "Scene name"] [--camera camera.json] [--save result.json] [--json]\n')
    process.exit(values.help ? 0 : 2)
  }
  const camera = values.camera ? JSON.parse(await readFile(values.camera, 'utf8')) : undefined
  const result = await publish({
    file: positionals[0],
    name: values.name,
    camera,
    onProgress: event => {
      if (event.phase === 'start') process.stderr.write(`Uploading ${event.filename} (${event.sizeBytes} bytes)\n`)
      if (event.phase === 'part') process.stderr.write(`  part ${event.done}/${event.total}\n`)
      if (event.phase === 'publish') process.stderr.write('Publishing\n')
    },
  })
  if (values.save) await writeFile(values.save, `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.viewerUrl}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  })
}
