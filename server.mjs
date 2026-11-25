#!/usr/bin/env node
// 3D Studio v2 (personal): projects of parts, tags, pin comments, measurements, parameters,
// and saved conversations, driven by YOUR installed Claude Code in headless mode
// (`claude -p`, stream-json), so it runs on your Claude Code login - no API key.
//
//   node 3d-studio/server.mjs            then open http://localhost:4317
//
// Env: STUDIO_PORT (4317), STUDIO_WORKSPACE (default: the folder holding 3d-studio),
// STUDIO_MODEL (optional model alias). No npm packages. Listens on 127.0.0.1 only.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { createGenerator, createSecrets, PROVIDERS } from './lib/generate.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.STUDIO_PORT || 4317)
const WORKSPACE = path.resolve(process.env.STUDIO_WORKSPACE || path.join(HERE, '..'))
const PUBLIC = path.join(HERE, 'public')
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.studio'])
const PALETTE = ['#d9a27c', '#7fa7c9', '#9fc48a', '#d68fb0', '#c9b26b', '#8fd0c8', '#b59ad6', '#e08f6a']
const HISTORY_LIMIT = 3000
// Printer build volume, e.g. STUDIO_BED=220x220x250 (mm). Default: a common 220 mm bed-slinger.
const BED = (process.env.STUDIO_BED || '220x220x250').split('x').map(Number)
const PRINTER = process.env.STUDIO_PRINTER || 'an FDM printer'

// ------------------------------------------------------------------ OpenSCAD (CAD engine)
// Preference: STUDIO_OPENSCAD, a system `openscad`, the macOS app, then the bundled
// WebAssembly build (bin/openscad, needs the optional npm dependency). Always a separate process.
const BUNDLED_SCAD = path.join(HERE, 'bin', 'openscad')
function findOpenSCAD() {
  if (process.env.STUDIO_OPENSCAD && fs.existsSync(process.env.STUDIO_OPENSCAD)) return process.env.STUDIO_OPENSCAD
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, 'openscad')
    if (dir && p !== BUNDLED_SCAD && fs.existsSync(p)) return p
  }
  for (const p of ['/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD', 'C:\\Program Files\\OpenSCAD\\openscad.exe'])
    if (fs.existsSync(p)) return p
  if (fs.existsSync(path.join(HERE, 'node_modules', 'openscad-wasm-prebuilt'))) return BUNDLED_SCAD
  return null
}
const OPENSCAD = findOpenSCAD()

// OpenSCAD Customizer syntax: `name = 120; // [20:1:200] Label` at the top level
function parseCustomizer(src) {
  const params = {}
  for (const line of src.split('\n')) {
    if (/^\s*(module|function)\b/.test(line)) break
    const m = /^([A-Za-z_]\w*)\s*=\s*(-?\d+(?:\.\d+)?)\s*;\s*(?:\/\/\s*(?:\[([^\]]*)\])?\s*(.*))?$/.exec(line.trim())
    if (!m || m[1] === 'part' || m[1].startsWith('$')) continue
    const label = (m[4] || m[1]).trim() || m[1]
    const unit = /degree|angle|twist|°/i.test(label + m[1]) ? '°' : /count|number of|segments|\bqty\b/i.test(label) ? '' : 'mm'
    const p = { value: Number(m[2]), unit, label }
    const range = (m[3] || '').split(':').map(Number)
    if (range.length === 3 && range.every(Number.isFinite)) { p.min = range[0]; p.step = range[1]; p.max = range[2] }
    else if (range.length === 2 && range.every(Number.isFinite)) { p.min = range[0]; p.max = range[1] }
    params[m[1]] = p
  }
  return params
}

const promptFor = project => `
You are running inside "3D Studio", a local design app. The person chats with you on the left; the
centre shows the project's 2D blueprints or its 3D parts. Active project folder: ${project.abs}
(your working directory). Other projects in ${WORKSPACE} may hold code worth reusing.

Workflow: blueprint first, then 3D.
1. BLUEPRINT stage: draw the design as 2D SVG sheets in blueprints/ (front, top, side views, plus
   sections or details when useful) and list them in studio.json "blueprints". Each sheet:
   - viewBox in millimetres (1 user unit = 1 mm), a white background rect, black outlines, a title
     block (name, scale, units, sheet name).
   - Every dimension as <g class="dim" data-dim="<param or unique id>" data-value="<number>"
     data-unit="mm" data-label="<what it measures>"> containing its lines, arrows and <text>.
     Use the same data-dim id as the matching entry in "params" where one exists.
   - Parts drawn inside <g data-part="<part id>">.
   - Plain SVG only: no scripts, event handlers, foreignObject, external links or embedded images.
   Ideally write the sheets from a Python script that reads the same params as the 3D build.
2. The person reviews: dimension edits, pin comments (with sheet coordinates in mm) and tags.
3. When the person clicks "Convert to 3D", build the 3D parts matching every blueprint dimension
   and note, set "stage": "3d", and keep the blueprints in sync with later 3D changes.

Project file: keep ${project.abs}/studio.json up to date. Schema:
{
  "name": "Brick lamp",
  "stage": "blueprint",                    // "blueprint" or "3d"
  "build": "make_brick.py",                // optional generator script in this folder
  "params": {                              // settings the person can edit directly
    "length": {"value": 200, "unit": "mm", "min": 60, "max": 220, "step": 1, "label": "Length"}
  },
  "blueprints": [{"id": "front", "name": "Front view", "file": "blueprints/front.svg"}],
  "parts": [
    {"id": "shell", "name": "Brick shell", "file": "brick_shell.stl", "color": "#c0573a",
     "assembly": {"position": [0, 0, 60], "rotation": [180, 0, 0]},   // mm and degrees, Z up
     "notes": "print upside down"}
  ]
}
CAD engine: ${OPENSCAD ? `OpenSCAD is available as the \`openscad\` command. It is the DEFAULT for 3D parts.
- Write the model as ${project.abs}/model.scad (more files in lib/ via use <lib/x.scad> are fine).
  Put editable sizes at the top in OpenSCAD Customizer form, e.g. \`length = 120; // [40:1:220] Length\`,
  and a selector \`part = "all"; // [all, body, lid]\`; one module per part; units mm; $fn 64-96 for
  curves; overlap boolean operands by 0.01 mm so the result is manifold.
- In studio.json set "engine": "openscad", "source": "model.scad", and list every part as
  {"id": "lid", "file": "build/lid.stl", "part": "lid", ...}. Do not put mesh geometry in Python.
- The studio renders every part automatically within seconds after model.scad (or lib/) changes,
  and the Params panel edits the Customizer values directly. Do not render into build/ yourself;
  to check for errors run: openscad -o /tmp/check.stl -D 'part="lid"' model.scad
- AI-generated meshes (parts with "source": "ai") live in ai/<id>/model.stl, already in mm and Z up.
  To combine one with CAD (a base, a slot, an LED pocket), import() it in model.scad, e.g.
  difference() { import("ai/<id>/model.stl"); translate([0,0,-1]) cylinder(d=20, h=15); }
- Values the person set in the Params panel are stored as overrides in studio.json "params"; when you
  change a Customizer default on purpose, update or remove that override too.
- Use Python only for what OpenSCAD cannot express well (e.g. organic surface textures).` :
  'OpenSCAD is not installed, so generate geometry with Python (below).'}
Rules:
- Python geometry: binary STL from Python 3 (standard library only unless the person installs more).
  Units mm, Z up.
- If the project has a Python "build" script, it must read param values from the STUDIO_PARAMS
  environment variable (JSON object of name -> value) with sensible defaults, write every part
  STL (and blueprint SVG if it draws them), and keep "params" values in studio.json in sync.
  The studio re-runs it when the person edits a param, without asking you.
- "assembly" places a part in the assembled view (parts may be stored in print orientation).
- Messages may start with a <studio-context> block: tagged parts (@id), pin comments (#n, on a 3D
  part with a point in that part's file coordinates, normal and region radius, or on a blueprint
  sheet with a point in sheet millimetres), measurements, dimension edits and resize requests.
  Treat these as precise instructions about exactly what to change.
- Target printer: ${PRINTER}, build volume ${BED.join(' x ')} mm. Prefer support-free, closed meshes.
- Project memory: keep ${project.abs}/CLAUDE.md (Claude Code loads it at every session start) short
  and current, under ~60 lines: what the product is, key decisions and dimensions, file layout,
  what is done, open issues. Update it whenever a decision or dimension changes. The studio
  compacts long conversations, so anything worth keeping must be in CLAUDE.md or the files.
- Be economical with tokens: change existing scripts with Edit instead of rewriting them; keep
  generators modular; make scripts print a short summary (files written, sizes), never mesh data;
  read only the files you need. The studio checks meshes, rebuilds params and exports by itself.
- After a change, briefly say what changed and what to check. Never delete files without asking.
- Do not edit the .studio folder; the studio owns it.
`.trim()

// ------------------------------------------------------------------ helpers
const readJSON = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fallback } }
const writeJSON = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2)) }
function inside(base, rel) {
  const abs = path.resolve(base, rel || '')
  return abs === base || abs.startsWith(base + path.sep) ? abs : null
}
function stlFiles(dir, depth = 2, out = [], base = dir) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory() && depth > 0) stlFiles(p, depth - 1, out, base)
    else if (e.isFile() && e.name.toLowerCase().endsWith('.stl')) out.push(path.relative(base, p))
  }
  return out
}

// ------------------------------------------------------------------ projects
function projectRef(id) {
  const abs = inside(WORKSPACE, id)
  if (!abs || abs === WORKSPACE || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return null
  return { id: path.relative(WORKSPACE, abs), abs, meta: path.join(abs, '.studio') }
}

function listProjects() {
  const out = []
  for (const e of fs.readdirSync(WORKSPACE, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name) || e.name === path.basename(HERE)) continue
    const abs = path.join(WORKSPACE, e.name)
    const manifest = readJSON(path.join(abs, 'studio.json'), null)
    const files = manifest ? [] : stlFiles(abs)
    if (!manifest && files.length === 0) continue
    out.push({ id: e.name, name: manifest?.name || e.name, managed: !!manifest,
      parts: manifest ? (manifest.parts || []).length : files.length, updated: fs.statSync(abs).mtimeMs })
  }
  return out.sort((a, b) => b.updated - a.updated)
}

function loadProject(p) {
  const manifest = readJSON(path.join(p.abs, 'studio.json'), null)
  let parts
  if (manifest && Array.isArray(manifest.parts)) {
    parts = manifest.parts.map((part, i) => ({ color: PALETTE[i % PALETTE.length], ...part }))
  } else {
    parts = stlFiles(p.abs).map((file, i) => ({
      id: path.basename(file, path.extname(file)).replace(/[^a-zA-Z0-9_-]/g, '_'),
      name: path.basename(file, path.extname(file)), file, color: PALETTE[i % PALETTE.length],
    }))
  }
  for (const part of parts) {
    const abs = inside(p.abs, part.file)
    part.exists = !!abs && fs.existsSync(abs)
    part.path = abs ? path.relative(WORKSPACE, abs) : null   // workspace-relative, for /api/file
    part.mtime = part.exists ? fs.statSync(abs).mtimeMs : 0
  }
  // blueprint sheets: listed in studio.json, else every SVG in blueprints/
  let blueprints = Array.isArray(manifest?.blueprints) ? manifest.blueprints : []
  if (blueprints.length === 0) {
    try {
      blueprints = fs.readdirSync(path.join(p.abs, 'blueprints'))
        .filter(f => f.toLowerCase().endsWith('.svg'))
        .map(f => ({ id: path.basename(f, '.svg'), name: path.basename(f, '.svg'), file: `blueprints/${f}` }))
    } catch {}
  }
  blueprints = blueprints.map(b => {
    const abs = inside(p.abs, b.file)
    const exists = !!abs && fs.existsSync(abs)
    return { ...b, exists, path: abs ? path.relative(WORKSPACE, abs) : null, mtime: exists ? fs.statSync(abs).mtimeMs : 0 }
  })
  const engine = manifest?.engine === 'openscad' ? 'openscad' : 'python'
  let params = manifest?.params || {}
  if (engine === 'openscad') {
    // the .scad file's Customizer values are the source of truth; studio.json keeps overrides
    const src = inside(p.abs, manifest.source || 'model.scad')
    const parsed = src && fs.existsSync(src) ? parseCustomizer(fs.readFileSync(src, 'utf8')) : {}
    params = { ...parsed }
    for (const [k, v] of Object.entries(manifest.params || {})) params[k] = { ...(parsed[k] || {}), ...v }
  }
  return {
    id: p.id, name: manifest?.name || p.id, managed: !!manifest, engine,
    build: engine === 'openscad' ? (OPENSCAD ? 'openscad' : null) : (manifest?.build || null),
    stage: manifest?.stage || (parts.length ? '3d' : 'blueprint'),
    params, parts, blueprints, bed: BED,
    comments: readJSON(path.join(p.meta, 'comments.json'), []),
    paint: readJSON(path.join(p.meta, 'paint.json'), {}),
  }
}

// ------------------------------------------------------------------ events + history
const clients = new Set()               // { res, project }
const histories = new Map()             // project id -> events (in memory)

function history(p) {
  if (!histories.has(p.id)) {
    const file = path.join(p.meta, 'history.jsonl')
    let lines = []
    try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) } catch {}
    histories.set(p.id, lines.slice(-HISTORY_LIMIT).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean))
  }
  return histories.get(p.id)
}

function emit(p, obj, { save = true } = {}) {
  const msg = { ...obj, project: p.id }
  if (save) {
    const h = history(p)
    h.push(msg)
    if (h.length > HISTORY_LIMIT) h.splice(0, h.length - HISTORY_LIMIT)
    // streaming deltas are kept in memory for a reload, but only whole events go to disk
    if (!(obj.kind === 'claude' && obj.ev?.type === 'stream_event')) {
      fs.mkdirSync(p.meta, { recursive: true })
      fs.appendFileSync(path.join(p.meta, 'history.jsonl'), JSON.stringify(msg) + '\n')
    }
  }
  const data = `data: ${JSON.stringify(msg)}\n\n`
  for (const c of clients) if (c.project === p.id) c.res.write(data)
}
const emitAll = obj => { const data = `data: ${JSON.stringify(obj)}\n\n`; for (const c of clients) c.res.write(data) }

// ------------------------------------------------------------------ Claude per project
const runs = new Map()   // project id -> { proc, busy, buf, mode, pending }
// Native compaction: when the conversation Claude re-reads per request grows past this many
// tokens, the studio runs Claude Code's own /compact before the next message.
const COMPACT_AT = Number(process.env.STUDIO_COMPACT_AT || 60000)
const COMPACT_PROMPT = '/compact Keep: the current design, every decided dimension and parameter, file names and ' +
  'their roles, the last request and anything still open. Drop: old alternatives, exploration, long tool outputs ' +
  'and code listings (the files and CLAUDE.md hold those).'

const sessionFile = p => path.join(p.meta, 'session.json')
function session(p) { return readJSON(sessionFile(p), {}).sessionId || null }
function contextSize(p) {
  const saved = readJSON(sessionFile(p), {})
  if (saved.context || !saved.sessionId) return saved.context || 0
  // older sessions: take the size from the last request recorded in the chat history
  const h = history(p)
  for (let i = h.length - 1; i >= 0; i--) {
    const u = h[i].kind === 'claude' && h[i].ev?.type === 'assistant' ? h[i].ev.message?.usage : null
    if (u) return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
    if (h[i].kind === 'reset') break
  }
  return 0
}
function saveSession(p, patch) { writeJSON(sessionFile(p), { ...readJSON(sessionFile(p), {}), ...patch }) }

// Cost modes: which model and how much thinking. Switching mode restarts the process and
// resumes the same conversation. STUDIO_MODEL overrides the model of every mode.
const MODES = {
  quick: { model: 'sonnet', effort: 'low' },        // small edits, questions: cheapest
  standard: { model: 'sonnet', effort: 'medium' },  // most design work
  deep: { model: 'opus', effort: 'high' },          // new designs, hard geometry
}

function startClaude(p, mode = 'standard') {
  const m = MODES[mode] || MODES.standard
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--permission-mode', 'acceptEdits',
    // Lean harness: only the design tools, none of the person's other MCP servers, plugins,
    // skills or user settings. Measured: ~22.8k -> ~8.4k prompt tokens per request, and the
    // studio session can no longer reach mail, drives or other connected services.
    // Slash commands stay enabled (+~600 tokens) so the studio can run Claude Code's native /compact.
    '--tools', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash',
    '--strict-mcp-config', '--setting-sources', 'project,local',
    '--exclude-dynamic-system-prompt-sections',
    '--allowedTools', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'Bash(python3:*)', 'Bash(openscad:*)', 'Bash(ls:*)', 'Bash(mkdir:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(wc:*)',
    '--model', process.env.STUDIO_MODEL || m.model, '--effort', m.effort,
    '--add-dir', WORKSPACE, '--append-system-prompt', promptFor(p),
  ]
  const sid = session(p)
  if (sid) args.push('--resume', sid)
  // make `openscad` resolve to the engine the studio uses (e.g. the bundled WebAssembly build)
  const env = { ...process.env }
  if (OPENSCAD) env.PATH = `${path.dirname(OPENSCAD)}${path.delimiter}${env.PATH || ''}`
  const run = { proc: spawn('claude', args, { cwd: p.abs, env, stdio: ['pipe', 'pipe', 'pipe'] }), busy: false, buf: '', mode }
  runs.set(p.id, run)
  run.proc.stdout.setEncoding('utf8')
  run.proc.stdout.on('data', chunk => {
    run.buf += chunk
    let nl
    while ((nl = run.buf.indexOf('\n')) >= 0) {
      const line = run.buf.slice(0, nl).trim()
      run.buf = run.buf.slice(nl + 1)
      if (!line) continue
      let ev
      try { ev = JSON.parse(line) } catch { continue }
      if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) saveSession(p, { sessionId: ev.session_id })
      // how much conversation each request re-reads: the latest API call's input
      if (ev.type === 'assistant' && ev.message?.usage) {
        const u = ev.message.usage
        const size = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
        if (size) { saveSession(p, { context: size }); emit(p, { kind: 'context', tokens: size }, { save: false }) }
      }
      if (ev.type === 'system' && ev.subtype === 'compact_boundary') {
        const m = ev.compact_metadata || {}
        saveSession(p, { context: m.post_tokens || 0 })
        emit(p, { kind: 'compact', status: 'done', pre: m.pre_tokens, post: m.post_tokens, ms: m.duration_ms })
      }
      if (ev.type === 'result') {
        if (run.pending) {
          // the compaction finished: now send the person's message into the compacted conversation
          const content = run.pending
          run.pending = null
          run.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n')
        } else {
          run.busy = false
          emit(p, { kind: 'status', busy: false }, { save: false })
        }
      }
      // live-only events (progress ticks) are shown but not kept in the saved history
      emit(p, { kind: 'claude', ev }, { save: ev.type !== 'rate_limit_event' && ev.subtype !== 'thinking_tokens' })
      if (ev.type === 'rate_limit_event') emitAll({ kind: 'usage', info: ev.rate_limit_info })
    }
  })
  run.proc.stderr.setEncoding('utf8')
  run.proc.stderr.on('data', t => emit(p, { kind: 'stderr', text: t }, { save: false }))
  run.proc.on('exit', code => {
    runs.delete(p.id)
    if (run.busy) emit(p, { kind: 'status', busy: false }, { save: false })
    if (code) emit(p, { kind: 'exit', code })
  })
  return run
}

// The person's words go to the chat; the context block goes to Claude only.
function contextBlock(p, ctx = {}) {
  const proj = loadProject(p)
  const lines = []
  const partById = id => proj.parts.find(x => x.id === id)
  for (const id of ctx.parts || []) {
    const part = partById(id)
    if (!part) continue
    const facts = ctx.facts?.[id]
    lines.push(`Tagged part @${part.id} "${part.name}": file ${part.file}` +
      (facts ? `, size ${facts.size.map(v => v.toFixed(1)).join(' x ')} mm (file coords), ${facts.closed ? 'closed' : 'NOT closed'} mesh` : '') +
      (part.assembly ? `, assembly ${JSON.stringify(part.assembly)}` : ''))
    const paint = ctx.paint?.[id]
    if (paint) {
      const regions = (paint.regions || []).map(r => `${r.color} on ${(r.share * 100).toFixed(1)}% of the surface within ` +
        `(${r.min.map(v => v.toFixed(1)).join(', ')})-(${r.max.map(v => v.toFixed(1)).join(', ')}) mm`)
      lines.push(`  Colours the person painted on @${part.id} in the preview: base ${paint.base}, finish ${paint.finish}` +
        (regions.length ? `; painted areas: ${regions.join('; ')}` : '; no painted areas'))
    }
  }
  for (const n of ctx.comments || []) {
    const c = proj.comments.find(x => x.n === n)
    if (!c) continue
    if (c.view === 'blueprint') {
      lines.push(`Comment #${c.n} on blueprint sheet "${c.sheet}" at (${c.point.map(v => v.toFixed(1)).join(', ')}) in sheet ` +
        `millimetres (SVG user units)${c.target ? `, on ${c.target}` : ''}: "${c.text}"`)
    } else {
      lines.push(`Comment #${c.n} on @${c.part} at point (${c.point.map(v => v.toFixed(1)).join(', ')}) mm in that part's file ` +
        `coordinates, surface normal (${c.normal.map(v => v.toFixed(2)).join(', ')}), region radius ${c.radius} mm: "${c.text}"`)
    }
  }
  for (const d of ctx.dims || []) {
    lines.push(`Blueprint dimension "${d.dim}"${d.label ? ` (${d.label})` : ''} on sheet "${d.sheet}": change from ${d.from} to ${d.to} ${d.unit || 'mm'}` +
      `${proj.params[d.dim] ? ` (this is param "${d.dim}")` : ''}. Update the blueprint${proj.parts.length ? ' and the 3D parts' : ''} to match.`)
  }
  if (ctx.convert) {
    lines.push(`CONVERT TO 3D: the person approved the blueprints (${proj.blueprints.map(b => b.file).join(', ') || 'none listed'}). ` +
      'Build the 3D parts matching every dimension and note, add a build script that reads STUDIO_PARAMS, update studio.json ' +
      '(parts with assembly placement, params, stage "3d"), then summarise what you built and what to check.')
  }
  for (const m of ctx.measures || []) {
    lines.push(`Measurement between @${m.a.part} point (${m.a.point.map(v => v.toFixed(1)).join(', ')}) and @${m.b.part} point ` +
      `(${m.b.point.map(v => v.toFixed(1)).join(', ')}) (file coordinates, mm): currently ${m.distance.toFixed(2)} mm` +
      (m.target ? `; the person wants it to be ${m.target} mm` : ''))
  }
  for (const [i, a] of (ctx.areas || []).entries()) {
    const v = arr => `(${(arr || []).map(x => Number(x).toFixed(1)).join(', ')})`
    lines.push(`Selected area ${i + 1} on @${a.part}: ${a.triangles} triangles, surface ≈ ${Number(a.area).toFixed(0)} mm², ` +
      `bounding box ${v(a.min)} to ${v(a.max)} mm (size ${(a.size || []).map(x => Number(x).toFixed(1)).join(' x ')}) in the part's ` +
      `file coordinates, centre ${v(a.centre)}, facing ${a.facing}. Apply the request to exactly this region.`)
    const img = a.image && inside(p.abs, a.image)
    if (img && fs.existsSync(img)) lines.push(`  Snapshot of the view with this area highlighted in orange: ${img} (Read it to see the area).`)
  }
  for (const r of ctx.resize || []) {
    lines.push(`Resize request for @${r.part}: from ${r.from.map(v => v.toFixed(1)).join(' x ')} mm to ${r.to.map(v => v.toFixed(1)).join(' x ')} mm (W x D x H, file coords)`)
  }
  return lines.length ? `<studio-context>\nProject: ${proj.name} (${p.abs})\n${lines.join('\n')}\n</studio-context>\n\n` : ''
}

function send(p, text, ctx, mode = 'standard') {
  let run = runs.get(p.id)
  if (run && run.mode !== mode && !run.busy) {      // mode changed: restart, same conversation
    run.proc.removeAllListeners('exit')
    run.proc.kill('SIGINT')
    runs.delete(p.id)
    run = null
  }
  if (!run) run = startClaude(p, mode)
  run.busy = true
  emit(p, { kind: 'status', busy: true }, { save: false })
  emit(p, { kind: 'user', text, chips: ctx?.chips || [] })
  const content = contextBlock(p, ctx) + text
  const size = contextSize(p)
  if (size > COMPACT_AT) {
    // long conversation: compact natively first, then send the message (see the 'result' handler)
    run.pending = content
    emit(p, { kind: 'compact', status: 'running', pre: size, auto: true })
    run.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: COMPACT_PROMPT } }) + '\n')
    return
  }
  run.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n')
}

function compactNow(p, mode) {
  let run = runs.get(p.id)
  if (run?.busy) return { ok: false, error: 'Claude is busy' }
  if (!session(p)) return { ok: false, error: 'No conversation to compact yet' }
  if (!run) run = startClaude(p, mode)
  run.busy = true
  emit(p, { kind: 'status', busy: true }, { save: false })
  emit(p, { kind: 'compact', status: 'running', pre: contextSize(p), auto: false })
  run.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: COMPACT_PROMPT } }) + '\n')
  return { ok: true }
}

// ------------------------------------------------------------------ OpenSCAD builds
const scadBuilds = new Map()   // project id -> { running, again }

function runScad(args, cwd) {
  return new Promise(resolve => {
    const proc = spawn(OPENSCAD, args, { cwd })
    let out = ''
    const timer = setTimeout(() => proc.kill('SIGKILL'), 300000)
    proc.stdout.on('data', d => { out += d })
    proc.stderr.on('data', d => { out += d })
    proc.on('error', err => { clearTimeout(timer); resolve({ code: 1, out: String(err) }) })
    proc.on('exit', code => { clearTimeout(timer); resolve({ code, out }) })
  })
}
const scadValue = v => (typeof v === 'string' ? JSON.stringify(v) : typeof v === 'boolean' ? String(v) : String(Number(v)))

async function buildScad(p, values) {
  const manifestPath = path.join(p.abs, 'studio.json')
  const manifest = readJSON(manifestPath, null)
  if (!OPENSCAD) return { ok: false, output: 'OpenSCAD is not installed: run `npm install` in 3d-studio, or install OpenSCAD.' }
  if (manifest?.engine !== 'openscad') return { ok: false, output: 'Not an OpenSCAD project.' }
  const src = inside(p.abs, manifest.source || 'model.scad')
  if (!src || !fs.existsSync(src)) return { ok: false, output: `${manifest.source || 'model.scad'} not found.` }
  // a build is running: run once more after it, with the newest values
  const state = scadBuilds.get(p.id) || { running: false, again: false }
  scadBuilds.set(p.id, state)
  if (state.running) { state.again = true; return { ok: true, output: 'queued' } }
  state.running = true

  if (values) {
    manifest.params = manifest.params || {}
    for (const [k, v] of Object.entries(values)) if (typeof v === 'number' && Number.isFinite(v)) manifest.params[k] = { ...(manifest.params[k] || {}), value: v }
    writeJSON(manifestPath, manifest)
  }
  const defines = Object.entries(manifest.params || {}).filter(([, v]) => v && 'value' in v)
    .flatMap(([k, v]) => /^[A-Za-z_]\w*$/.test(k) ? ['-D', `${k}=${scadValue(v.value)}`] : [])
  const parts = (manifest.parts || []).filter(x => x.file && inside(p.abs, x.file))
  emit(p, { kind: 'build', status: 'running', engine: 'openscad', parts: parts.map(x => x.id) })
  const started = Date.now()
  const results = []
  const queue = [...parts]
  const worker = async () => {
    for (let part; (part = queue.shift());) {
      const t0 = Date.now()
      const out = inside(p.abs, part.file)
      const r = await runScad(['-o', out, '--export-format', 'binstl', ...defines, '-D', `part=${scadValue(part.part ?? part.id)}`, src], p.abs)
      results.push({ id: part.id, ok: r.code === 0, ms: Date.now() - t0,
        output: r.out.split('\n').filter(l => /error|warning|assert/i.test(l)).slice(0, 12).join('\n') })
    }
  }
  await Promise.all([worker(), worker()])
  const ok = results.every(r => r.ok)
  const summary = results.map(r => `${r.ok ? '✓' : '✗'} ${r.id} ${(r.ms / 1000).toFixed(1)} s${r.output ? `\n${r.output}` : ''}`).join('\n')
  emit(p, { kind: 'build', status: ok ? 'done' : 'failed', engine: 'openscad', ms: Date.now() - started, output: summary })
  state.running = false
  if (state.again) { state.again = false; setTimeout(() => buildScad(p), 50) }
  return { ok, output: summary }
}

// ------------------------------------------------------------------ test pieces (crop box)
// Cuts each touched part to the box with OpenSCAD and keeps the part's own (print) orientation:
//   multmatrix(inverse) intersection() { multmatrix(matrix) import(part); translate(min) cube(size); }
async function cropTestPieces(p, { min, max, parts: list, name }) {
  if (!OPENSCAD) return { ok: false, error: 'OpenSCAD is not available (run npm install in 3d-studio).' }
  const num = v => Number.isFinite(Number(v)) ? Number(v) : NaN
  const lo = (min || []).map(num), hi = (max || []).map(num)
  if (lo.length !== 3 || hi.length !== 3 || [...lo, ...hi].some(Number.isNaN) || hi.some((v, i) => v - lo[i] < 0.2))
    return { ok: false, error: 'invalid crop box' }
  const proj = loadProject(p)
  const safe = String(name || 'test').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'test'
  const outDir = path.join(p.abs, 'test-pieces')
  fs.mkdirSync(outDir, { recursive: true })
  const mat = m => Array.isArray(m) && m.length === 4 && m.every(r => Array.isArray(r) && r.length === 4 && r.every(v => Number.isFinite(Number(v))))
  const results = []
  for (const req of (list || []).slice(0, 20)) {
    const part = proj.parts.find(x => x.id === req.id)
    const src = part && inside(p.abs, part.file)
    if (!src || !fs.existsSync(src) || !mat(req.matrix) || !mat(req.inverse)) { results.push({ id: req.id, ok: false, error: 'unknown part' }); continue }
    const rel = path.relative(p.abs, src).split(path.sep).join('/')
    const fmt = m => `[${m.map(r => `[${r.map(Number).join(',')}]`).join(',')}]`
    const scad = path.join(p.abs, `_crop_${safe}_${req.id.replace(/\W+/g, '_')}.scad`)
    fs.writeFileSync(scad, `// temporary: test piece of ${part.id} (3D Studio)\n` +
      `multmatrix(${fmt(req.inverse)}) intersection() {\n  multmatrix(${fmt(req.matrix)}) import(${JSON.stringify(rel)}, convexity = 10);\n` +
      `  translate([${lo.join(',')}]) cube([${hi.map((v, i) => v - lo[i]).join(',')}]);\n}\n`)
    const out = path.join(outDir, `${safe}-${part.id}.stl`)
    const t0 = Date.now()
    const r = await runScad(['-o', out, '--export-format', 'binstl', scad], p.abs)
    fs.rmSync(scad, { force: true })
    const facts = r.code === 0 && fs.existsSync(out) ? stlFacts(fs.readFileSync(out)) : null
    if (r.code === 0 && facts && facts.triangles > 0) {
      results.push({ id: part.id, ok: true, file: path.relative(WORKSPACE, out), size: facts.size, triangles: facts.triangles, ms: Date.now() - t0 })
    } else {
      fs.rmSync(out, { force: true })
      results.push({ id: part.id, ok: false, error: facts?.triangles === 0 || /empty/i.test(r.out) ? 'the box does not touch this part'
        : r.out.split('\n').filter(l => /error|warning/i.test(l)).slice(0, 4).join(' ') || 'OpenSCAD failed' })
    }
  }
  const ok = results.some(r => r.ok)
  emit(p, { kind: 'testpiece', results })
  return { ok, results }
}

// ------------------------------------------------------------------ AI mesh generation
const secrets = createSecrets(path.join(HERE, '.secrets.json'))
const generator = createGenerator({
  secrets,
  onEvent(projectId, obj) {
    const p = projectRef(projectId)
    if (p) emit(p, obj, { save: ['done', 'failed', 'cancelled'].includes(obj.job.status) })
  },
  onDone: job => addAiPart(job),
})

// place a finished AI mesh in the project as a new part, to the right of the existing parts
function addAiPart(job) {
  const p = projectRef(job.project)
  if (!p) return
  const manifestPath = path.join(p.abs, 'studio.json')
  const manifest = readJSON(manifestPath, null)
  if (!manifest) { emitAll({ kind: 'manifest', project: p.id }); return }   // file-based project: the STL shows up by itself
  manifest.parts = manifest.parts || []
  let right = 0
  for (const part of manifest.parts) {
    const abs = inside(p.abs, part.file)
    if (!abs || !fs.existsSync(abs) || fs.statSync(abs).size > 80e6) continue
    const f = stlFacts(fs.readFileSync(abs))
    if (f) right = Math.max(right, (part.assembly?.position?.[0] || 0) + f.size[0] / 2)
  }
  const size = job.result.check?.size || [job.size, job.size, job.size]
  manifest.parts.push({
    id: job.partId, name: job.prompt ? job.prompt.slice(0, 40) : 'AI model from photo', file: `${job.relProject}/model.stl`,
    color: '#cfc4b0', source: 'ai', prompt: job.prompt || undefined, glb: `${job.relProject}/model.glb`,
    assembly: { position: [manifest.parts.length ? Math.round(right + 15 + size[0] / 2) : 0, 0, 0], rotation: [0, 0, 0] },
    notes: `AI-generated (${job.mode === 'text' ? 'text' : `${job.images.length} image(s)`}), ${job.result.check?.closed ? 'closed mesh' : 'mesh has open edges: check before printing'}`,
  })
  writeJSON(manifestPath, manifest)
  emitAll({ kind: 'manifest', project: p.id })
}

function startGeneration(p, body) {
  const mode = body.mode === 'image' ? 'image' : 'text'
  const prompt = String(body.prompt || '').trim().slice(0, 500)
  if (mode === 'text' && prompt.length < 3) return { error: 'Describe the object you want (a few words at least).' }
  const images = []
  if (mode === 'image') {
    for (const d of (Array.isArray(body.images) ? body.images : []).slice(0, 4)) {
      const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(d))
      if (!m) return { error: 'Images must be PNG, JPEG or WebP.' }
      const buf = Buffer.from(m[2], 'base64')
      if (buf.length > 10e6) return { error: 'Each image must be under 10 MB.' }
      images.push(buf)
    }
    if (!images.length) return { error: 'Add at least one photo or drawing of the object.' }
  }
  const size = Math.min(Math.max(Number(body.size) || 80, 10), Math.max(...BED))
  const seed = Number.isInteger(Number(body.seed)) && body.seed !== '' && body.seed != null ? Number(body.seed) : Math.floor(Math.random() * 1e6)
  const slug = (prompt || 'photo').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'model'
  const id = `ai_${slug}_${Date.now().toString(36).slice(-5)}`
  const relProject = `ai/${id}`
  const job = generator.submit({
    id, project: p.id, partId: id, mode, prompt, images, size, seed,
    detailLevel: ['low', 'medium', 'high'].includes(body.detail) ? body.detail : 'medium',
    dir: path.join(p.abs, relProject), rel: `${p.id}/${relProject}`, relProject,
  })
  if (mode === 'image') {
    fs.mkdirSync(path.join(p.abs, relProject), { recursive: true })
    images.forEach((b, i) => fs.writeFileSync(path.join(p.abs, relProject, `input-${i + 1}.png`), b))
  }
  return { ok: true, job }
}

// ------------------------------------------------------------------ params -> rebuild
function rebuild(p, values) {
  const manifestPath = path.join(p.abs, 'studio.json')
  const manifest = readJSON(manifestPath, null)
  if (manifest?.engine === 'openscad') return buildScad(p, values)
  if (!manifest?.build) return Promise.resolve({ ok: false, output: 'This project has no build script.' })
  const script = inside(p.abs, manifest.build)
  if (!script || !script.endsWith('.py') || !fs.existsSync(script)) return Promise.resolve({ ok: false, output: 'Build script not found.' })
  for (const [k, v] of Object.entries(values || {})) {
    if (manifest.params?.[k] && typeof v === 'number' && Number.isFinite(v)) manifest.params[k].value = v
  }
  writeJSON(manifestPath, manifest)
  const env = { ...process.env, STUDIO_PARAMS: JSON.stringify(Object.fromEntries(
    Object.entries(manifest.params || {}).map(([k, v]) => [k, v.value]))) }
  emit(p, { kind: 'build', status: 'running', params: env.STUDIO_PARAMS })
  return new Promise(resolve => {
    const proc = spawn('python3', [script], { cwd: p.abs, env })
    let out = ''
    const timer = setTimeout(() => proc.kill('SIGKILL'), 180000)
    proc.stdout.on('data', d => { out += d })
    proc.stderr.on('data', d => { out += d })
    proc.on('exit', code => {
      clearTimeout(timer)
      const result = { ok: code === 0, output: out.slice(-4000) }
      emit(p, { kind: 'build', status: code === 0 ? 'done' : 'failed', output: result.output })
      resolve(result)
    })
  })
}

// ------------------------------------------------------------------ ZIP export (no dependencies)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}
function makeZip(entries) {
  const locals = [], centrals = []
  let offset = 0
  for (const { name, data, mtime } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const deflated = zlib.deflateRawSync(data, { level: 6 })
    const method = deflated.length < data.length ? 8 : 0
    const body = method ? deflated : data
    const crc = crc32(data)
    const { time, date } = dosTime(mtime || new Date())
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(method, 10); central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

// size and closed-mesh check of a binary STL, for the print notes
function stlFacts(buf) {
  if (buf.length < 84) return null
  const n = buf.readUInt32LE(80)
  if (buf.length !== 84 + 50 * n) return null
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let t = 0; t < n; t++) {
    for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) {
      const x = buf.readFloatLE(84 + 50 * t + 12 + v * 12 + k * 4)
      if (x < min[k]) min[k] = x
      if (x > max[k]) max[k] = x
    }
  }
  return { triangles: n, size: max.map((m, k) => m - min[k]) }
}

const EXPORT_EXT = new Set(['.stl', '.glb', '.webp', '.3mf', '.obj', '.step', '.stp', '.svg', '.py', '.json', '.md', '.txt', '.png', '.jpg', '.gcode'])
function exportProject(p, what) {
  const proj = loadProject(p)
  const folder = p.id.replace(/[^\w.-]+/g, '_')
  const entries = []
  let total = 0
  const addFile = rel => {
    const abs = inside(p.abs, rel)
    if (!abs || !fs.existsSync(abs)) return
    const st = fs.statSync(abs)
    if (!st.isFile() || st.size > 100e6 || total + st.size > 500e6) return
    total += st.size
    entries.push({ name: `${folder}/${rel.split(path.sep).join('/')}`, data: fs.readFileSync(abs), mtime: st.mtime })
  }
  const walk = (dir, depth) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory() && depth > 0) walk(abs, depth - 1)
      else if (e.isFile() && EXPORT_EXT.has(path.extname(e.name).toLowerCase())) {
        const rel = path.relative(p.abs, abs)
        if (what === 'stl' && !rel.toLowerCase().endsWith('.stl')) continue
        addFile(rel)
      }
    }
  }
  if (what === 'parts') proj.parts.forEach(x => x.exists && addFile(x.file))
  else walk(p.abs, 3)

  // print notes: one block per part
  const paint = proj.paint?.parts || {}
  const lines = [`${proj.name}`, `${'='.repeat(proj.name.length)}`, `Exported ${new Date().toISOString().slice(0, 16).replace('T', ' ')} from 3D Studio`,
    `Printer build volume: ${BED.join(' x ')} mm`, '']
  for (const part of proj.parts) {
    const entry = entries.find(x => x.name === `${folder}/${part.file}`)
    const f = entry && stlFacts(entry.data)
    const pp = paint[part.id] || {}
    lines.push(`- ${part.name} (@${part.id}): ${part.file}${part.exists ? '' : '  [MISSING]'}`)
    if (f) lines.push(`    size ${f.size.map(v => v.toFixed(1)).join(' x ')} mm · ${f.triangles.toLocaleString('en')} triangles` +
      (f.size[0] > BED[0] || f.size[1] > BED[1] || f.size[2] > BED[2] ? ' · TOO BIG for the bed' : ''))
    lines.push(`    colour ${pp.color || part.color || '-'} · finish ${pp.finish || 'matte'}${pp.paint ? ' · has painted areas (see the studio preview)' : ''}`)
    if (part.notes) lines.push(`    notes: ${part.notes}`)
  }
  if (Object.keys(proj.params).length) {
    lines.push('', 'Parameters:')
    for (const [k, v] of Object.entries(proj.params)) lines.push(`- ${v.label || k}: ${v.value} ${v.unit || ''}`)
  }
  const open = proj.comments.filter(c => c.status !== 'resolved')
  if (open.length) { lines.push('', 'Open comments:'); for (const c of open) lines.push(`- #${c.n} ${c.view === 'blueprint' ? `sheet ${c.sheet}` : `@${c.part}`}: ${c.text}`) }
  entries.push({ name: `${folder}/PRINT-NOTES.txt`, data: Buffer.from(lines.join('\n') + '\n'), mtime: new Date() })
  return { name: `${folder}${what === 'all' ? '' : `-${what}`}.zip`, data: makeZip(entries) }
}

// ------------------------------------------------------------------ file watching
// a saved .scad file re-renders its OpenSCAD project (debounced: editors save in bursts)
const scadTimers = new Map()
function scheduleScad(projectId) {
  const p = projectRef(projectId)
  if (!p || readJSON(path.join(p.abs, 'studio.json'), null)?.engine !== 'openscad') return
  clearTimeout(scadTimers.get(p.id))
  scadTimers.set(p.id, setTimeout(() => { scadTimers.delete(p.id); buildScad(p) }, 700))
  emitAll({ kind: 'manifest', project: p.id })   // Customizer params may have changed
}

let watchTimer = null
const pending = new Set()
try {
  fs.watch(WORKSPACE, { recursive: true }, (_t, name) => {
    if (!name) return
    const parts = name.split(path.sep)
    if (parts.some(x => x === '.studio' || SKIP_DIRS.has(x))) return
    const lower = name.toLowerCase()
    if (lower.endsWith('.scad')) { if (!path.basename(lower).startsWith('_crop')) scheduleScad(parts[0]); return }
    if (!lower.endsWith('.stl') && !lower.endsWith('.svg') && !lower.endsWith('studio.json')) return
    pending.add(name)
    clearTimeout(watchTimer)
    watchTimer = setTimeout(() => {
      for (const rel of pending) {
        const lowerRel = rel.toLowerCase()
        if (lowerRel.endsWith('studio.json')) {
          const id = rel.split(path.sep)[0]
          emitAll({ kind: 'manifest', project: id })
          // OpenSCAD parts listed before (or without) a render: build the missing STLs.
          // (Claude often writes model.scad first and the part list afterwards.)
          const m = readJSON(path.join(WORKSPACE, id, 'studio.json'), null)
          if (m?.engine === 'openscad' && (m.parts || []).some(pt => pt.part && pt.file && !fs.existsSync(path.join(WORKSPACE, id, pt.file))))
            scheduleScad(id)
        }
        else if (!fs.existsSync(path.join(WORKSPACE, rel))) continue
        else if (lowerRel.endsWith('.svg')) emitAll({ kind: 'blueprint', path: rel, project: rel.split(path.sep)[0] })
        else emitAll({ kind: 'model', path: rel, mtime: Date.now() })
      }
      pending.clear()
    }, 500)
  })
} catch (err) { console.warn('File watching unavailable:', err.message) }

// ------------------------------------------------------------------ HTTP
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const readBody = req => new Promise(resolve => {
  let body = ''
  req.on('data', c => { body += c; if (body.length > 16e6) req.destroy() })   // paint data can be a few MB
  req.on('end', () => { try { resolve(JSON.parse(body || '{}')) } catch { resolve({}) } })
})

// Only the studio's own page may talk to it. The Host check stops DNS-rebinding pages from reading
// the API; the Origin check stops other websites from POSTing (e.g. a chat turn, which runs Claude).
const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`])
function trusted(req) {
  if (!LOCAL_HOSTS.has(String(req.headers.host || '').toLowerCase())) return false
  const origin = req.headers.origin
  if (origin && !LOCAL_HOSTS.has(origin.toLowerCase().replace(/^http:\/\//, ''))) return false
  return !(req.method !== 'GET' && req.method !== 'HEAD' && req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')
}

const server = http.createServer(async (req, res) => {
  if (!trusted(req)) { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('Forbidden: 3D Studio only accepts requests from its own page.') }
  const url = new URL(req.url, 'http://localhost')
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
  const q = url.searchParams
  const body = req.method === 'POST' ? await readBody(req) : {}
  const proj = () => projectRef(q.get('project') || body.project)

  try {
    if (url.pathname === '/api/events') {
      const p = proj()
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const client = { res, project: p?.id }
      res.write(`data: ${JSON.stringify({ kind: 'hello', project: p?.id, busy: !!(p && runs.get(p.id)?.busy),
        context: p ? contextSize(p) : 0, compactAt: COMPACT_AT, history: p ? history(p) : [] })}\n\n`)
      clients.add(client)
      req.on('close', () => clients.delete(client))
      return
    }
    if (url.pathname === '/api/projects' && req.method === 'GET') return json(200, listProjects())
    if (url.pathname === '/api/projects' && req.method === 'POST') {
      const slug = String(body.name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
      if (!slug) return json(400, { error: 'name required' })
      const abs = inside(WORKSPACE, slug)
      if (!abs || fs.existsSync(abs)) return json(409, { error: 'A folder with that name exists' })
      writeJSON(path.join(abs, 'studio.json'), { name: String(body.name).slice(0, 120), stage: body.stage === '3d' ? '3d' : 'blueprint',
        ...(OPENSCAD ? { engine: 'openscad', source: 'model.scad' } : {}), parts: [] })
      return json(200, { id: slug })
    }
    if (url.pathname === '/api/project') {
      const p = proj(); if (!p) return json(404, { error: 'no project' })
      return json(200, loadProject(p))
    }
    if (url.pathname === '/api/send' && req.method === 'POST') {
      const p = proj(); if (!p) return json(404, { error: 'no project' })
      if (!body.text || typeof body.text !== 'string') return json(400, { error: 'text required' })
      send(p, body.text, body.context, MODES[body.mode] ? body.mode : 'standard')
      return json(200, { ok: true })
    }
    if (url.pathname === '/api/generate' && req.method === 'POST') {
      const p = proj(); if (!p) return json(404, { error: 'no project' })
      const r = startGeneration(p, body)
      return json(r.error ? 400 : 200, r)
    }
    if (url.pathname === '/api/generate/cancel' && req.method === 'POST') return json(200, { ok: generator.cancel(String(body.id || '')) })
    if (url.pathname === '/api/generate/jobs') { const p = proj(); return json(200, p ? generator.list(p.id) : []) }
    if (url.pathname === '/api/settings' && req.method === 'GET') {
      // the token itself never leaves the server
      return json(200, { hfToken: secrets.hasToken(), tokenFromEnv: secrets.tokenFromEnv(), providers: PROVIDERS })
    }
    if (url.pathname === '/api/settings' && req.method === 'POST') {
      const t = String(body.hfToken ?? '').trim()
      if (t && !/^hf_[A-Za-z0-9]{20,}$/.test(t)) return json(400, { error: 'That does not look like a Hugging Face token (it starts with hf_).' })
      secrets.setToken(t || null)
      return json(200, { ok: true, hfToken: secrets.hasToken() })
    }
    if (url.pathname === '/api/crop' && req.method === 'POST') {
      const p = proj(); if (!p) return json(404, { error: 'no project' })
      return json(200, await cropTestPieces(p, body))
    }
    if (url.pathname === '/api/snapshot' && req.method === 'POST') {
      // a PNG of the 3D view with the selected area highlighted, for Claude to look at
      const p = proj(); if (!p) return json(404, { error: 'no project' })
      const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.png || ''))
      if (!m) return json(400, { error: 'png data URL required' })
      const data = Buffer.from(m[1], 'base64')
      if (data.length > 12e6 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return json(400, { error: 'not a PNG' })
      const dir = path.join(p.meta, 'snapshots')
      fs.mkdirSync(dir, { recursive: true })
      // keep the 30 newest snapshots
      const old = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort()
      for (const f of old.slice(0, Math.max(0, old.length - 29))) fs.rmSync(path.join(dir, f), { force: true })
      const name = `area-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
      fs.writeFileSync(path.join(dir, name), data)
      return json(200, { path: `.studio/snapshots/${name}` })
    }
    if (url.pathname === '/api/compact' && req.method === 'POST') {
      const p = proj(); if (!p) return json(404, { error: 'no project' })
      return json(200, compactNow(p, MODES[body.mode] ? body.mode : 'standard'))
    }
    if (url.pathname === '/api/stop' && req.method === 'POST') {
      const p = proj(); runs.get(p?.id)?.proc.kill('SIGINT'); return json(200, { ok: true })
    }
    if (url.pathname === '/api/new' && req.method === 'POST') {
      const p = proj(); if (!p) return json(404, { error: 'no project' })
      runs.get(p.id)?.proc.kill('SIGINT')
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const h = path.join(p.meta, 'history.jsonl')
      if (fs.existsSync(h)) fs.renameSync(h, path.join(p.meta, `history-${stamp}.jsonl`)) // archived, not deleted
      writeJSON(path.join(p.meta, 'session.json'), {})
      histories.delete(p.id)
      emit(p, { kind: 'reset' }, { save: false })
      return json(200, { ok: true })
    }
    if (url.pathname === '/api/comments' && req.method === 'POST') {
      const p = proj(); if (!p) return json(404, { error: 'no project' })
      const file = path.join(p.meta, 'comments.json')
      const list = readJSON(file, [])
      if (body.action === 'add') {
        const c = body.comment || {}
        const n = list.reduce((m, x) => Math.max(m, x.n), 0) + 1
        const base = { n, text: String(c.text || '').slice(0, 2000), status: 'open', created: Date.now() }
        if (c.view === 'blueprint') {
          list.push({ ...base, view: 'blueprint', sheet: String(c.sheet), point: (c.point || []).slice(0, 2).map(Number),
            target: c.target ? String(c.target).slice(0, 200) : undefined })
        } else {
          list.push({ ...base, view: '3d', part: String(c.part), point: (c.point || []).slice(0, 3).map(Number),
            normal: (c.normal || [0, 0, 1]).slice(0, 3).map(Number), radius: Number(c.radius) || 5 })
        }
      } else if (body.action === 'update') {
        const c = list.find(x => x.n === body.n)
        if (c) Object.assign(c, pick(body.patch, ['text', 'status', 'radius']))
      } else if (body.action === 'delete') {
        list.splice(list.findIndex(x => x.n === body.n) >>> 0, 1)
      }
      writeJSON(file, list)
      emitAll({ kind: 'comments', project: p.id, comments: list })
      return json(200, list)
    }
    if (url.pathname === '/api/paint' && req.method === 'POST') {
      const p = proj(); if (!p) return json(404, { error: 'no project' })
      const d = body.data || {}
      const clean = { palette: (Array.isArray(d.palette) ? d.palette : []).slice(0, 254).map(String).filter(c => /^#[0-9a-f]{6}$/i.test(c)), parts: {} }
      for (const [id, v] of Object.entries(d.parts || {})) {
        const entry = {}
        if (/^#[0-9a-f]{6}$/i.test(v.color)) entry.color = v.color
        if (['matte', 'glossy', 'silk', 'translucent'].includes(v.finish)) entry.finish = v.finish
        if (typeof v.paint === 'string' && Number.isInteger(v.tri)) { entry.tri = v.tri; entry.paint = v.paint }
        clean.parts[String(id).slice(0, 80)] = entry
      }
      writeJSON(path.join(p.meta, 'paint.json'), clean)
      return json(200, { ok: true })
    }
    if (url.pathname === '/api/params' && req.method === 'POST') {
      const p = proj(); if (!p) return json(404, { error: 'no project' })
      return json(200, await rebuild(p, body.values))
    }
    if (url.pathname === '/api/export') {
      const p = proj(); if (!p) return json(404, { error: 'no project' })
      const what = ['all', 'parts', 'stl'].includes(q.get('what')) ? q.get('what') : 'all'
      const zip = exportProject(p, what)
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.data.length,
        'content-disposition': `attachment; filename="${zip.name}"`, 'cache-control': 'no-store' })
      return res.end(zip.data)
    }
    if (url.pathname === '/api/file') {
      const abs = inside(WORKSPACE, q.get('path'))
      const ext = abs ? path.extname(abs).toLowerCase() : ''
      // SVG is sent as plain text: the page sanitises it before showing it (no scripts run)
      const FILE_TYPES = { '.stl': 'model/stl', '.svg': 'text/plain; charset=utf-8', '.glb': 'model/gltf-binary',
        '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }
      if (!abs || !FILE_TYPES[ext] || !fs.existsSync(abs)) return json(404, { error: 'not found' })
      res.writeHead(200, { 'content-type': FILE_TYPES[ext], 'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
        ...(q.get('download') ? { 'content-disposition': `attachment; filename="${path.basename(abs).replace(/"/g, '')}"` } : {}) })
      return fs.createReadStream(abs).pipe(res)
    }
    // static files
    const abs = inside(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname.slice(1))
    if (!abs || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); return res.end('not found') }
    res.writeHead(200, { 'content-type': TYPES[path.extname(abs)] || 'application/octet-stream', 'cache-control': 'no-cache' })
    fs.createReadStream(abs).pipe(res)
  } catch (err) {
    json(500, { error: String(err?.message || err) })
  }
})

function pick(obj = {}, keys) { return Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]])) }

server.listen(PORT, '127.0.0.1', () => {
  console.log(`3D Studio running: http://localhost:${PORT}`)
  console.log(`Workspace: ${WORKSPACE}`)
  console.log(`CAD engine: ${OPENSCAD ? `OpenSCAD (${OPENSCAD === BUNDLED_SCAD ? 'bundled WebAssembly build' : OPENSCAD})` : 'none found: Python geometry only (run npm install for OpenSCAD)'}`)
  console.log('Claude runs on your Claude Code login (headless). Ctrl+C to quit.')
})
process.on('SIGINT', () => { for (const r of runs.values()) r.proc.kill('SIGINT'); process.exit(0) })
