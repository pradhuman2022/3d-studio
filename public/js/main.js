import { createViewer, FINISHES } from './viewer3d.js'
import { createBlueprint } from './blueprint.js'

const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const f1 = v => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1))
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json())
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} },
}

const state = {
  project: null, data: null, view: '3d', tool: 'select', selected: null,
  facts: {}, chips: [], busy: false, events: null, focused: null,
}

// =================================================================== viewers
const viewer = createViewer($('view3d'), $('overlay'), {
  onSelect: id => selectPart(id),
  onFacts: (id, facts) => { state.facts[id] = facts; renderParts(); renderInfo(); if (id === state.selected) renderInspector() },
  onPick: pick => openCommentPopover({ view: '3d', ...pick }),
  onPinClick: n => focusComment(n, true),
  onMeasure: () => {},
  onSelection: list => renderSelCard(list),
  onPartColor: () => { renderParts(); savePaint() },
  onPaintChanged: () => savePaint(),
  onPaintLost: id => alertNote(`Painted areas on @${id} were cleared because its shape changed.`),
  measureHtml: m => `<b>${m.distance.toFixed(1)} mm</b> <span class="muted">dX ${f1(m.dx)} · dY ${f1(m.dy)} · dZ ${f1(m.dz)}</span>
    <div class="row" style="margin-top:4px"><input data-role="mtarget" type="number" step="0.1" placeholder="set to…" style="width:80px">
    <button class="small" data-action="measure-ask">Ask Claude</button><button class="small ghost" data-action="measure-clear">✕</button></div>`,
})
// ?demo in the URL exposes the studio to scripts (screen recordings, tests). Off by default.
if (new URLSearchParams(location.search).has('demo')) window.studio = { viewer, state, setView, selectPart }
const blueprint = createBlueprint($('view2d'), $('overlay'), {
  onPick: pick => openCommentPopover({ view: 'blueprint', ...pick }),
  onDim: dim => openDimPopover(dim),
  onSelect: id => selectPart(id),
  onPinClick: n => focusComment(n, true),
  onShown: () => { renderSheets(); renderInfo() },
})

// =================================================================== theme: paper (light) / chalkboard (dark)
const systemDark = window.matchMedia('(prefers-color-scheme: dark)')
const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : systemDark.matches)
function applyTheme() {
  const dark = isDark()
  viewer.setTheme(dark)
  $('themeToggle').textContent = dark ? '☀' : '☾'
  $('themeToggle').title = dark ? 'Switch to paper (light)' : 'Switch to chalkboard (dark)'
}
$('themeToggle').onclick = () => {
  const next = isDark() ? 'light' : 'dark'
  document.documentElement.dataset.theme = next
  store.set('studio.theme', next)
  applyTheme()
}
systemDark.addEventListener('change', () => { if (!document.documentElement.dataset.theme) applyTheme() })
applyTheme()

// =================================================================== projects
async function loadProjects(selectId) {
  const list = await (await fetch('/api/projects')).json()
  const sel = $('project')
  sel.innerHTML = list.map(p => `<option value="${esc(p.id)}">${esc(p.name)}${p.managed ? '' : ' (files)'}</option>`).join('')
  const fromUrl = new URLSearchParams(location.search).get('project')   // e.g. /?project=hex_pen_holder
  const want = selectId || fromUrl || store.get('studio.project') || list[0]?.id
  if (want && list.some(p => p.id === want)) sel.value = want
  if (sel.value) openProject(sel.value)
  else $('empty').textContent = 'No projects yet. Click ＋ to create one.'
}
$('project').onchange = e => openProject(e.target.value)

async function openProject(id) {
  state.project = id
  state.selected = null; state.focused = null; state.facts = {}; state.chips = []
  if (state.section) setSectionOn(false)
  store.set('studio.project', id)
  renderChips()
  connectEvents()
  await refreshProject({ refit: true, chooseView: true })
}

async function refreshProject({ refit = false, chooseView = false } = {}) {
  const data = await (await fetch(`/api/project?project=${encodeURIComponent(state.project)}`)).json()
  if (data.error) return
  state.data = data
  blueprint.setSheets(data.blueprints)
  blueprint.setComments(data.comments)
  viewer.setComments(data.comments)
  if (chooseView) setView(data.stage === 'blueprint' && blueprint.sheets().length ? 'blueprint' : (data.parts.length || !blueprint.sheets().length ? '3d' : 'blueprint'))
  await viewer.setProject(data, { refit })
  if (state.view === 'blueprint') {
    const cur = blueprint.current()
    await blueprint.show(cur?.id, { keepView: !!cur && !chooseView })
  }
  renderAll()
}

$('newProject').onclick = () => { $('projectName').value = ''; $('projectDialog').showModal() }
$('projectDialog').addEventListener('close', async () => {
  if ($('projectDialog').returnValue !== 'ok') return
  const name = $('projectName').value.trim()
  if (!name) return
  const stage = document.querySelector('input[name=stage]:checked').value
  const res = await post('/api/projects', { name, stage })
  if (res.error) return alertNote(res.error)
  await loadProjects(res.id)
  $('input').value = stage === 'blueprint'
    ? `Sketch a 2D blueprint for "${name}": `
    : `Build a 3D model of "${name}": `
  $('input').focus()
})

// =================================================================== events
function connectEvents() {
  state.events?.close()
  const es = new EventSource(`/api/events?project=${encodeURIComponent(state.project)}`)
  state.events = es
  es.onmessage = e => onEvent(JSON.parse(e.data))
  es.onerror = () => setState('Disconnected from the studio server. Is it running?')
}

function onEvent(msg) {
  const mine = !msg.project || msg.project === state.project
  switch (msg.kind) {
    case 'hello':
      resetLog()
      replaying = true
      for (const m of msg.history) renderChatEvent(m)
      replaying = false
      state.compactAt = msg.compactAt
      setContext(msg.context)
      setBusy(msg.busy)
      break
    case 'context':
      if (mine) setContext(msg.tokens)
      break
    case 'model':
      if (state.data && msg.path.startsWith(`${state.project}/`))
        viewer.reloadPath(msg.path).then(found => { if (!found) refreshProject() ; renderInfo() })
      break
    case 'blueprint':
      if (mine && state.data) refreshProject()
      break
    case 'manifest':
      if (mine && state.data) refreshProject()
      break
    case 'comments':
      if (mine && state.data) { state.data.comments = msg.comments; viewer.setComments(msg.comments); blueprint.setComments(msg.comments); renderComments() }
      break
    case 'usage': renderUsage(msg.info); break
    default:
      if (mine) renderChatEvent(msg)
  }
}

// =================================================================== chat log
const log = $('log')
let current = null, replaying = false
const streamed = new Set(), tools = new Map(), blocks = new Map()
function resetLog() { log.innerHTML = ''; streamed.clear(); tools.clear(); blocks.clear(); genCards.clear(); current = null }
function markdown(src) {
  return src.split(/```[a-zA-Z0-9]*\n?/).map((part, i) => {
    if (i % 2 === 1) return `<pre><code>${esc(part.replace(/\n$/, ''))}</code></pre>`
    return esc(part).split(/\n{2,}/).filter(p => p.trim()).map(p => `<p>${p
      .replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>')}</p>`).join('')
  }).join('')
}
function add(cls, html) {
  const el = document.createElement('div')
  el.className = cls; el.innerHTML = html
  log.append(el); log.scrollTop = log.scrollHeight
  return el
}
const alertNote = text => add('note', esc(text))
function toolLabel(name, input = {}) {
  if (name === 'Bash') return `Ran: ${input.command ?? ''}`
  if (input.file_path) return `${name}: ${input.file_path.split('/').pop()}`
  return input.pattern ? `${name}: ${input.pattern}` : name
}

function renderChatEvent(msg) {
  switch (msg.kind) {
    case 'user':
      add('msg user', (msg.chips || []).map(c => `<span class="chip">${esc(c)}</span>`).join('') + esc(msg.text))
      break
    case 'reset': resetLog(); add('note', 'New conversation'); break
    case 'status': setBusy(msg.busy); break
    case 'exit': add('note', `Claude Code exited (code ${msg.code}). Your next message continues the conversation.`); break
    case 'gen': renderGenCard(msg.job); break
    case 'testpiece': {
      const ok = (msg.results || []).filter(r => r.ok)
      add('note', ok.length ? `Test piece saved: ${ok.map(r => `${r.file.split('/').pop()} (${r.size.map(f1).join('×')} mm)`).join(', ')}`
        : 'Test piece: nothing was cut')
      break
    }
    case 'compact':
      if (msg.status === 'running') {
        add('note', `${msg.auto ? 'Long conversation: ' : ''}compacting with Claude Code /compact (${Math.round((msg.pre || 0) / 1000)}k tokens)…`)
        setStep('Compacting the conversation…')
      } else {
        add('note', `Compacted ✓ ${Math.round((msg.pre || 0) / 1000)}k → ${Math.round((msg.post || 0) / 1000)}k tokens${msg.ms ? ` · ${dur(Math.round(msg.ms / 1000))}` : ''}`)
        if (!replaying) setContext(msg.post)
      }
      break
    case 'build':
      if (msg.engine === 'openscad') {
        if (msg.status === 'running') add('note', `OpenSCAD: rendering ${(msg.parts || []).length} part(s)…`)
        else {
          const el = add(`tool ${msg.status === 'done' ? 'done' : 'error'}`,
            `<details${msg.status === 'done' ? '' : ' open'}><summary>OpenSCAD: ${msg.status === 'done' ? 'rendered' : 'render failed'} · ${((msg.ms || 0) / 1000).toFixed(1)} s</summary>
             <div class="tool-body"><pre>${esc(msg.output || '')}</pre></div></details>`)
          el.querySelector('summary').style.listStyle = 'none'
        }
      } else if (msg.status === 'running') add('note', 'Rebuilding with new parameters…')
      else add('note', msg.status === 'done' ? 'Rebuilt ✓' : `Rebuild failed: ${esc((msg.output || '').slice(-300))}`)
      break
    case 'claude': onClaude(msg.ev); break
  }
}

// ---- live activity: what Claude is doing right now, how long, and whether output stopped
const STUCK_AFTER = 45 // seconds without any event
const activity = { since: 0, last: 0, step: '', timer: null }
const dur = s => (s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s} s`)
function setStep(step) { if (!replaying) { activity.step = step; tick() } }
function tick() {
  if (!state.busy) return
  const now = Date.now()
  const idle = Math.round((now - activity.last) / 1000)
  let text = `Working · ${dur(Math.round((now - activity.since) / 1000))}${activity.step ? ` · ${activity.step}` : ''}`
  const stuck = idle >= STUCK_AFTER
  if (stuck) text += ` · no new output for ${dur(idle)}. Could be a long step; press Stop if it looks stuck.`
  $('state').textContent = text
  $('state').title = text
  $('state').classList.toggle('warn', stuck)
}

// a tool step: a collapsible row showing the call and, once done, its output
function toolInputHtml(name, input = {}) {
  if (name === 'Bash') return `<pre>${esc(input.command ?? '')}</pre>`
  if (name === 'Write') return `<div>${esc(input.file_path ?? '')} · ${((input.content ?? '').length / 1024).toFixed(1)} KB</div>`
  if (name === 'Edit') return `<div>${esc(input.file_path ?? '')}</div><pre>- ${esc((input.old_string ?? '').slice(0, 600))}\n+ ${esc((input.new_string ?? '').slice(0, 600))}</pre>`
  return `<pre>${esc(JSON.stringify(input, null, 1).slice(0, 1500))}</pre>`
}
function toolChip(id, name, input) {
  let t = tools.get(id)
  if (!t) {
    const el = document.createElement('details')
    el.className = 'tool running'
    el.innerHTML = '<summary></summary><div class="tool-body"><div class="tool-in"></div><div class="tool-out"></div></div>'
    log.append(el); log.scrollTop = log.scrollHeight
    t = { el, name, started: Date.now() }
    tools.set(id, t)
  }
  t.input = input || t.input || {}
  t.el.querySelector('summary').textContent = toolLabel(name, t.input)
  t.el.querySelector('.tool-in').innerHTML = toolInputHtml(name, t.input)
  return t
}
// a partial JSON input while Claude is still writing it: pull out what is readable
function partialInput(name, json) {
  const pick = key => { const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(json); return m ? m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : undefined }
  return { file_path: pick('file_path'), command: pick('command'), pattern: pick('pattern'), content: name === 'Write' ? ' '.repeat(json.length) : undefined }
}

function onClaude(ev) {
  if (!replaying) activity.last = Date.now()
  if (ev.type === 'stream_event') {
    const e = ev.event
    if (e.type === 'message_start') { streamed.add(e.message.id); setStep('Thinking…') }
    if (e.type === 'content_block_start') {
      const cb = e.content_block
      if (cb.type === 'text') { current = add('msg assistant', ''); current.dataset.src = ''; setStep('Writing a reply…') }
      if (cb.type === 'thinking') {
        const el = add('thinking', '<details><summary>Thinking…</summary><div class="think-text"></div></details>')
        blocks.set(e.index, { kind: 'thinking', el, started: Date.now(), text: '' })
        setStep('Thinking…')
      }
      if (cb.type === 'tool_use') {
        toolChip(cb.id, cb.name, {})
        blocks.set(e.index, { kind: 'tool', id: cb.id, name: cb.name, json: '' })
        setStep(`Preparing ${cb.name}…`)
      }
    }
    if (e.type === 'content_block_delta') {
      const b = blocks.get(e.index)
      if (e.delta.type === 'text_delta' && current) {
        current.dataset.src += e.delta.text
        current.innerHTML = markdown(current.dataset.src)
        log.scrollTop = log.scrollHeight
      }
      if (e.delta.type === 'thinking_delta' && b?.kind === 'thinking') {
        b.text += e.delta.thinking
        b.el.querySelector('.think-text').textContent = b.text
      }
      if (e.delta.type === 'input_json_delta' && b?.kind === 'tool') {
        b.json += e.delta.partial_json
        const input = partialInput(b.name, b.json)
        const t = toolChip(b.id, b.name, input)
        const kb = (b.json.length / 1024).toFixed(1)
        t.el.querySelector('summary').textContent = `${toolLabel(b.name, input)} · ${kb} KB…`
        setStep(`${b.name === 'Write' ? 'Writing' : b.name === 'Edit' ? 'Editing' : b.name} ${input.file_path?.split('/').pop() || input.command?.slice(0, 50) || ''} (${kb} KB)`)
      }
    }
    if (e.type === 'content_block_stop') {
      const b = blocks.get(e.index)
      if (b?.kind === 'thinking') {
        const secs = Math.max(1, Math.round((Date.now() - b.started) / 1000))
        b.el.querySelector('summary').textContent = b.text.trim() ? `Thought for ${dur(secs)}` : `Thought for ${dur(secs)} (details hidden)`
      }
      if (b?.kind === 'tool') setStep(`Running ${toolLabel(b.name, tools.get(b.id)?.input || {})}`)
      if (!b) current = null
      blocks.delete(e.index)
    }
    return
  }
  // live estimate of how much Claude has thought so far (long Deep-mode plans can take minutes)
  if (ev.type === 'system' && ev.subtype === 'thinking_tokens') {
    const k = `${(ev.estimated_tokens / 1000).toFixed(1)}k`
    setStep(`Thinking · ~${k} tokens so far`)
    for (const b of blocks.values()) if (b.kind === 'thinking') b.el.querySelector('summary').textContent = `Thinking… ~${k} tokens`
    return
  }
  if (ev.type === 'assistant') {
    for (const b of ev.message.content ?? []) {
      if (b.type === 'text' && !streamed.has(ev.message.id) && b.text.trim()) add('msg assistant', markdown(b.text))
      if (b.type === 'tool_use') {
        const t = toolChip(b.id, b.name, b.input)
        setStep(`Running ${toolLabel(b.name, b.input)}`)
        if (replaying) t.started = 0
      }
    }
  } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
    for (const b of ev.message.content) {
      if (b.type !== 'tool_result' || !tools.has(b.tool_use_id)) continue
      const t = tools.get(b.tool_use_id)
      const out = typeof b.content === 'string' ? b.content
        : (b.content || []).map(c => c.text ?? (c.type === 'image' ? '[image]' : '')).join('\n')
      t.el.className = `tool ${b.is_error ? 'error' : 'done'}`
      const secs = t.started && !replaying ? Math.round((Date.now() - t.started) / 1000) : null
      t.el.querySelector('summary').textContent = `${toolLabel(t.name, t.input || {})}${secs !== null ? ` · ${dur(secs)}` : ''}`
      t.el.querySelector('.tool-out').innerHTML = out.trim()
        ? `<div class="muted">${b.is_error ? 'Error' : 'Output'}</div><pre>${esc(out.slice(0, 4000))}${out.length > 4000 ? '\n…' : ''}</pre>` : ''
      if (b.is_error && !replaying) t.el.open = true
    }
    setStep('Reading the result…')
  } else if (ev.type === 'system' && ev.subtype === 'status' && ev.status) {
    setStep(String(ev.status))
  } else if (ev.type === 'result') {
    const bits = [ev.is_error ? 'Stopped' : 'Done']
    if (ev.duration_ms) bits.push(dur(Math.round(ev.duration_ms / 1000)))
    if (ev.num_turns) bits.push(`${ev.num_turns} step${ev.num_turns > 1 ? 's' : ''}`)
    const u = ev.usage || {}
    const read = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
    if (read) bits.push(`${Math.round(read / 1000)}k tokens read (${Math.round(100 * (u.cache_read_input_tokens || 0) / read)}% from cache)`)
    if (u.output_tokens) bits.push(`${u.output_tokens.toLocaleString()} written`)
    if (ev.total_cost_usd) bits.push(`≈ $${ev.total_cost_usd.toFixed(3)} at API prices`)
    add('note', bits.join(' · '))
  }
}

function renderUsage(info) {
  const w = info?.unifiedWindows
  if (!w) return
  const pct = v => `${Math.round((v ?? 0) * 100)}%`
  $('usage').textContent = `Claude plan usage · 5 h ${pct(w.five_hour?.utilization)} · 7 days ${pct(w.seven_day?.utilization)}`
}
function setBusy(b) {
  const was = state.busy
  state.busy = b
  $('stop').disabled = !b; $('sendBtn').disabled = b
  if (b && !was) {
    activity.since = activity.last = Date.now()
    activity.step = 'Starting Claude Code…'
    clearInterval(activity.timer)
    activity.timer = setInterval(tick, 1000)
    tick()
  }
  if (!b) {
    clearInterval(activity.timer)
    $('state').classList.remove('warn')
    setState(readyText())
    for (const t of tools.values()) if (t.el.classList.contains('running')) t.el.className = 'tool stopped'
  }
}
const setState = t => { $('state').textContent = t }

// how much conversation each message re-reads, and whether it will be compacted first
function readyText() {
  const k = Math.round((state.context || 0) / 1000)
  if (!k) return 'Ready'
  return state.context > (state.compactAt || 60000)
    ? `Ready · conversation ${k}k tokens · compacts before your next message`
    : `Ready · conversation ${k}k tokens`
}
function setContext(tokens) {
  state.context = tokens || 0
  if (!state.busy) setState(readyText())
}
$('compact').onclick = async () => {
  const res = await post('/api/compact', { project: state.project, mode: $('mode').value })
  if (!res.ok) alertNote(res.error || 'Could not compact')
}

// =================================================================== composer: chips, mentions, send
function addChip(chip) {
  const key = JSON.stringify([chip.type, chip.id ?? chip.n ?? chip.label])
  if (!state.chips.some(c => JSON.stringify([c.type, c.id ?? c.n ?? c.label]) === key)) state.chips.push(chip)
  renderChips()
}
function renderChips() {
  $('chips').innerHTML = state.chips.map((c, i) => `<span class="chip">${esc(c.label)}<button type="button" data-i="${i}" title="Remove">×</button></span>`).join('')
}
$('chips').onclick = e => {
  const i = e.target.dataset.i
  if (i !== undefined) { state.chips.splice(Number(i), 1); renderChips() }
}

const input = $('input')
let mention = null // { start, items, index }
input.addEventListener('input', () => {
  const upto = input.value.slice(0, input.selectionStart)
  const m = /@([\w-]*)$/.exec(upto)
  if (!m || !state.data?.parts.length) { hideMentions(); return }
  const q = m[1].toLowerCase()
  const items = state.data.parts.filter(p => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)).slice(0, 8)
  if (!items.length) { hideMentions(); return }
  mention = { start: upto.length - m[0].length, items, index: 0 }
  renderMentions()
})
function renderMentions() {
  const box = $('mentions')
  box.hidden = false
  box.innerHTML = mention.items.map((p, i) => `<div data-i="${i}" class="${i === mention.index ? 'on' : ''}">
    <span class="swatch" style="background:${esc(p.color)};display:inline-block"></span> <b>@${esc(p.id)}</b> <span class="muted">${esc(p.name)}</span></div>`).join('')
}
function hideMentions() { mention = null; $('mentions').hidden = true }
function pickMention(i) {
  const p = mention.items[i]
  const end = input.selectionStart
  input.value = `${input.value.slice(0, mention.start)}@${p.id} ${input.value.slice(end)}`
  const caret = mention.start + p.id.length + 2
  input.setSelectionRange(caret, caret)
  addChip({ type: 'part', id: p.id, label: `@${p.id}` })
  hideMentions(); input.focus()
}
$('mentions').onmousedown = e => { const row = e.target.closest('[data-i]'); if (row) { e.preventDefault(); pickMention(Number(row.dataset.i)) } }
input.addEventListener('keydown', e => {
  if (mention) {
    if (e.key === 'ArrowDown') { e.preventDefault(); mention.index = (mention.index + 1) % mention.items.length; return renderMentions() }
    if (e.key === 'ArrowUp') { e.preventDefault(); mention.index = (mention.index - 1 + mention.items.length) % mention.items.length; return renderMentions() }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pickMention(mention.index) }
    if (e.key === 'Escape') return hideMentions()
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit() }
})
input.addEventListener('blur', () => setTimeout(hideMentions, 150))

function buildContext(text) {
  const ctx = { parts: [], comments: [], measures: [], dims: [], resize: [], facts: {}, chips: [] }
  const ids = new Set(state.data?.parts.map(p => p.id) || [])
  for (const m of text.matchAll(/@([\w-]+)/g)) if (ids.has(m[1]) && !ctx.parts.includes(m[1])) ctx.parts.push(m[1])
  for (const c of state.chips) {
    ctx.chips.push(c.label)
    if (c.type === 'part' && !ctx.parts.includes(c.id)) ctx.parts.push(c.id)
    if (c.type === 'comment') ctx.comments.push(c.n)
    if (c.type === 'measure') { ctx.measures.push(c.m); for (const k of ['a', 'b']) if (!ctx.parts.includes(c.m[k].part)) ctx.parts.push(c.m[k].part) }
    if (c.type === 'dim') ctx.dims.push(c.d)
    if (c.type === 'resize') { ctx.resize.push(c.r); if (!ctx.parts.includes(c.r.part)) ctx.parts.push(c.r.part) }
    if (c.type === 'convert') ctx.convert = true
    if (c.type === 'area') { (ctx.areas ||= []).push(c.a); if (!ctx.parts.includes(c.a.part)) ctx.parts.push(c.a.part) }
  }
  for (const n of ctx.comments) {
    const c = state.data?.comments.find(x => x.n === n)
    if (c?.part && !ctx.parts.includes(c.part)) ctx.parts.push(c.part)
  }
  for (const id of ctx.parts) if (state.facts[id]) ctx.facts[id] = { size: state.facts[id].size, closed: state.facts[id].closed }
  ctx.paint = {}
  for (const id of ctx.parts) { const s = viewer.paintSummary(id); if (s) ctx.paint[id] = s }
  return ctx
}

async function send(text) {
  text = text.trim()
  if (!text || !state.project) return
  const context = buildContext(text)
  state.chips = []; renderChips()
  input.value = ''
  await post('/api/send', { project: state.project, text, context, mode: $('mode').value })
}
$('mode').value = store.get('studio.mode', 'standard')
$('mode').onchange = e => store.set('studio.mode', e.target.value)
$('composer').addEventListener('submit', e => { e.preventDefault(); send(input.value) })
$('stop').onclick = () => post('/api/stop', { project: state.project })
$('newChat').onclick = () => {
  const b = $('newChat')
  if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = 'Click to confirm'; setTimeout(() => { delete b.dataset.armed; b.textContent = 'New chat' }, 3000); return }
  delete b.dataset.armed; b.textContent = 'New chat'
  post('/api/new', { project: state.project })
}
function prefill(text, chip) {
  if (chip) addChip(chip)
  input.value = text
  input.focus()
  input.setSelectionRange(text.length, text.length)
}

// =================================================================== view + tools
function setView(v) {
  state.view = v
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === v))
  $('view3d').hidden = v !== '3d'; $('bar3d').hidden = v !== '3d'
  $('view2d').hidden = v !== 'blueprint'; $('bar2d').hidden = v !== 'blueprint'
  if (v === 'blueprint' && state.data) blueprint.show(blueprint.current()?.id)
  if (v === 'blueprint' && ['measure', 'paint', 'area'].includes(state.tool)) setTool('select')
  $('barPaint').hidden = !(v === '3d' && state.tool === 'paint')
  $('barArea').hidden = !(v === '3d' && state.tool === 'area')
  $('selCard').hidden = v !== '3d' || !(state.selection || []).length
  closePopover()
  renderEmpty(); renderInfo(); renderConvert()
}
document.querySelectorAll('[data-view]').forEach(b => { b.onclick = () => setView(b.dataset.view) })

function setTool(t) {
  if (['measure', 'paint', 'area'].includes(t) && state.view !== '3d') return
  state.tool = t
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t))
  viewer.setTool(t); blueprint.setTool(t)
  $('stage').style.cursor = t === 'select' ? '' : 'crosshair'
  $('barPaint').hidden = t !== 'paint'
  $('barArea').hidden = t !== 'area'
  closePopover()
}

// =================================================================== section / crop box
const AX = ['X', 'Y', 'Z']
function setSectionOn(on) {
  state.section = on ? state.section : null
  $('sectionToggle').classList.toggle('on', on)
  $('barSection').hidden = !on
  if (!on) { viewer.setSection(false); return }
  const b = viewer.assemblyBounds()
  if (!b) { $('barSection').hidden = true; $('sectionToggle').classList.remove('on'); return }
  state.bounds = { min: b.min.map(v => Math.floor(v - 2)), max: b.max.map(v => Math.ceil(v + 2)) }
  state.section = state.section || { min: [...state.bounds.min], max: [...state.bounds.max] }
  renderSectionAxes()
  viewer.setSection(true, state.section.min, state.section.max)
  if (!$('explode').value || Number($('explode').value)) $('explode').value = 0
}
function renderSectionAxes() {
  const { min, max } = state.bounds, s = state.section
  $('sectionAxes').innerHTML = AX.map((a, i) => `<b>${a}</b>
    <input type="range" data-ax="${i}" data-end="min" min="${min[i]}" max="${max[i]}" step="0.5" value="${s.min[i]}" title="${a} from">
    <input type="range" data-ax="${i}" data-end="max" min="${min[i]}" max="${max[i]}" step="0.5" value="${s.max[i]}" title="${a} to">
    <span class="muted" id="axv${i}">${f1(s.min[i])} → ${f1(s.max[i])} mm</span>`).join('')
}
$('sectionAxes').addEventListener('input', e => {
  const i = Number(e.target.dataset.ax), end = e.target.dataset.end
  if (Number.isNaN(i)) return
  const s = state.section, v = Number(e.target.value)
  if (end === 'min') s.min[i] = Math.min(v, s.max[i] - 0.5); else s.max[i] = Math.max(v, s.min[i] + 0.5)
  e.target.value = end === 'min' ? s.min[i] : s.max[i]
  $(`axv${i}`).textContent = `${f1(s.min[i])} → ${f1(s.max[i])} mm`
  viewer.setSection(true, s.min, s.max)
})
$('sectionToggle').onclick = () => setSectionOn(!state.section)
$('sectionReset').onclick = () => { state.section = { min: [...state.bounds.min], max: [...state.bounds.max] }; renderSectionAxes(); viewer.setSection(true, state.section.min, state.section.max) }
$('sectionFit').onclick = () => {
  const box = viewer.selectionAssemblyBox(3)
  if (!box) { alertNote('Select an area first (Area tool), then Fit to selection.'); return }
  // the sliders' range must include the box
  state.bounds = { min: state.bounds.min.map((v, i) => Math.min(v, Math.floor(box.min[i]))), max: state.bounds.max.map((v, i) => Math.max(v, Math.ceil(box.max[i]))) }
  state.section = { min: box.min.map(v => Math.round(v * 2) / 2), max: box.max.map(v => Math.round(v * 2) / 2) }
  renderSectionAxes()
  viewer.setSection(true, state.section.min, state.section.max)
}
$('sectionExport').onclick = () => {
  const s = state.section
  const size = s.max.map((v, i) => v - s.min[i])
  const parts = viewer.cropParts()
  const rect = $('stage').getBoundingClientRect()
  const pop = openPopover({ x: rect.width / 2 - 150, y: 20 }, `<h4>Export test piece</h4>
    <div class="muted">Box ${size.map(f1).join(' × ')} mm · cuts ${parts.length} part(s): ${parts.map(p => '@' + esc(p.id)).join(', ') || 'none'}.
      Each piece keeps its part's print orientation.</div>
    <input data-role="name" value="test" placeholder="name, e.g. hinge">
    <div class="pieces" data-role="out"></div>
    <div class="row"><span class="grow"></span><button class="ghost small" data-role="close">Close</button>
      <button class="small" data-role="go" ${parts.length ? '' : 'disabled'}>Cut with OpenSCAD</button></div>`)
  pop.querySelector('[data-role=close]').onclick = closePopover
  pop.querySelector('[data-role=go]').onclick = async e => {
    e.target.disabled = true; e.target.textContent = 'Cutting…'
    const res = await post('/api/crop', { project: state.project, min: s.min, max: s.max, parts, name: pop.querySelector('[data-role=name]').value })
    e.target.textContent = 'Cut with OpenSCAD'; e.target.disabled = false
    pop.querySelector('[data-role=out]').innerHTML = res.error ? `<p class="errmsg">${esc(res.error)}</p>` : (res.results || []).map(r => r.ok
      ? `<p>✓ <a href="/api/file?path=${encodeURIComponent(r.file)}&download=1" download>${esc(r.file.split('/').pop())}</a>
         <span class="muted">${r.size.map(f1).join(' × ')} mm · ${(r.ms / 1000).toFixed(1)} s</span></p>`
      : `<p class="errmsg">✗ @${esc(r.id)}: ${esc(r.error)}</p>`).join('')
  }
}

// =================================================================== AI generation (text / photos -> 3D)
let genMode = 'text', genImages = []
const genCards = new Map()
async function refreshGenSettings() {
  const s = await (await fetch('/api/settings')).json()
  $('genTokenState').textContent = s.hfToken ? (s.tokenFromEnv ? '· token from HF_TOKEN ✓' : '· token saved ✓') : '· no token (shared quota)'
  $('genTokenClear').disabled = !s.hfToken || s.tokenFromEnv
  if (!s.hfToken) $('genSettings').open = true
}
$('genOpen').onclick = async () => { $('genMsg').textContent = ''; await refreshGenSettings(); $('genDialog').showModal() }
document.querySelectorAll('[data-gmode]').forEach(b => {
  b.onclick = () => {
    genMode = b.dataset.gmode
    document.querySelectorAll('[data-gmode]').forEach(x => x.classList.toggle('on', x === b))
    document.querySelector('[data-for=text]').hidden = genMode !== 'text'
    document.querySelector('[data-for=image]').hidden = genMode !== 'image'
  }
})
// photos are scaled down to at most 1024 px before upload (enough for the model, much smaller)
function shrink(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const s = Math.min(1, 1024 / Math.max(img.width, img.height))
      const c = document.createElement('canvas')
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s)
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
      URL.revokeObjectURL(img.src)
      resolve(c.toDataURL('image/png'))
    }
    img.onerror = reject
    img.src = URL.createObjectURL(file)
  })
}
$('genFiles').onchange = async e => {
  genImages = await Promise.all([...e.target.files].slice(0, 4).map(shrink))
  $('genThumbs').innerHTML = genImages.map(d => `<img src="${d}" alt="">`).join('')
}
$('genTokenSave').onclick = async () => {
  const res = await post('/api/settings', { hfToken: $('genToken').value })
  $('genToken').value = ''
  $('genMsg').textContent = res.error || ''
  refreshGenSettings()
}
$('genTokenClear').onclick = async () => { await post('/api/settings', { hfToken: '' }); refreshGenSettings() }
async function startGen(spec) {
  const res = await post('/api/generate', { project: state.project, ...spec })
  if (res.error) return res.error
  return null
}
$('genGo').onclick = async () => {
  const spec = { mode: genMode, prompt: $('genPrompt').value, images: genMode === 'image' ? genImages : [],
    size: Number($('genSize').value), detail: $('genDetail').value, seed: $('genSeed').value === '' ? null : Number($('genSeed').value) }
  $('genGo').disabled = true
  const err = await startGen(spec)
  $('genGo').disabled = false
  if (err) { $('genMsg').textContent = err; return }
  state.lastGen = spec
  $('genDialog').close()
}

function renderGenCard(job) {
  let el = genCards.get(job.id)
  if (!el) { el = document.createElement('div'); log.append(el); genCards.set(job.id, el) }
  el.className = `gen-card ${job.status}`
  const ref = job.result?.reference ? `<img src="/api/file?path=${encodeURIComponent(job.result.reference)}" alt="reference">` : ''
  const c = job.result?.check
  const title = job.prompt ? `“${esc(job.prompt.slice(0, 60))}”` : 'From photos'
  let body = ''
  if (job.status === 'queued') body = `<div class="stage">Waiting${job.queuePos ? ` · position ${job.queuePos}` : ''}</div>`
  if (job.status === 'running') body = `<div class="stage">${esc(job.stage)}${job.detail ? ` · ${esc(job.detail)}` : ''}</div>`
  if (job.status === 'failed') body = `<div class="errmsg">${esc(job.error || 'Failed')}</div>`
  if (job.status === 'cancelled') body = '<div class="stage">Cancelled</div>'
  if (job.status === 'done' && c) body = `<div class="stage">Added <b>@${esc(job.id)}</b> · ${c.size.map(f1).join(' × ')} mm ·
    ${c.triangles.toLocaleString()} triangles · ${c.closed ? '<span class="okmsg">closed ✓</span>' : `<span class="errmsg">${c.openEdges} open edges</span>`}</div>`
  const acts = []
  if (['queued', 'running'].includes(job.status)) acts.push('<button class="small ghost" data-gen="cancel">Cancel</button>')
  if (job.status === 'done') acts.push('<button class="small" data-gen="colours">Apply AI colours</button>',
    '<button class="small ghost" data-gen="show">Show</button>')
  if (job.mode === 'text' && ['done', 'failed', 'cancelled'].includes(job.status))
    acts.push(`<button class="small ghost" data-gen="${job.status === 'done' ? 'variant' : 'retry'}">${job.status === 'done' ? 'New variant' : 'Retry'}</button>`)
  el.innerHTML = `${ref}<div class="head"><b>✨ ${title}</b></div>${body}<div class="actions">${acts.join(' ')}</div>`
  el.dataset.job = JSON.stringify({ id: job.id, prompt: job.prompt, size: job.size, glb: job.result?.glb })
  log.scrollTop = log.scrollHeight
}
log.addEventListener('click', async e => {
  const act = e.target.dataset?.gen
  if (!act) return
  const job = JSON.parse(e.target.closest('.gen-card').dataset.job)
  if (act === 'cancel') post('/api/generate/cancel', { id: job.id })
  if (act === 'show') { setView('3d'); selectPart(job.id) }
  if (act === 'variant' || act === 'retry') {
    const err = await startGen({ mode: 'text', prompt: job.prompt, size: job.size, detail: 'medium', seed: null })
    if (err) alertNote(err)
  }
  if (act === 'colours') {
    e.target.disabled = true; e.target.textContent = 'Reading colours…'
    try { await applyAiColours(job.id, job.glb) } catch (err) { alertNote(`AI colours: ${err.message}`) }
    e.target.disabled = false; e.target.textContent = 'Apply AI colours'
  }
})

// AI texture -> a few filament colours, painted per triangle. The STL was written from the GLB in
// the same triangle order three.js loads it, so triangle t of the GLB is triangle t of the part.
async function applyAiColours(partId, glbPath, k = 5) {
  const [{ GLTFLoader }, THREE] = await Promise.all([import('three/addons/loaders/GLTFLoader.js'), import('three')])
  const gltf = await new GLTFLoader().loadAsync(`/api/file?path=${encodeURIComponent(glbPath)}`)
  const cols = [], weights = []
  const pix = new Map()
  const pixelsOf = image => {
    if (!pix.has(image)) {
      const c = document.createElement('canvas'); c.width = image.width; c.height = image.height
      const g = c.getContext('2d'); g.drawImage(image, 0, 0)
      pix.set(image, { w: c.width, h: c.height, data: g.getImageData(0, 0, c.width, c.height).data })
    }
    return pix.get(image)
  }
  gltf.scene.traverse(o => {
    if (!o.isMesh) return
    const g = o.geometry, idx = g.index, pos = g.attributes.position, uv = g.attributes.uv, vc = g.attributes.color
    const mat = Array.isArray(o.material) ? o.material[0] : o.material
    const base = mat?.color ? mat.color.clone().convertLinearToSRGB() : new THREE.Color(1, 1, 1)
    const tex = mat?.map?.image ? pixelsOf(mat.map.image) : null
    const n = (idx ? idx.count : pos.count) / 3
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
    for (let t = 0; t < n; t++) {
      const v = [0, 1, 2].map(i => (idx ? idx.getX(t * 3 + i) : t * 3 + i))
      let r = 0, gg = 0, bb = 0
      // average the texture at three points inside the triangle (avoids seams at the corners)
      for (const [w0, w1, w2] of [[0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6]]) {
        let cr = 255, cg = 255, cb = 255
        if (tex && uv) {
          const u = w0 * uv.getX(v[0]) + w1 * uv.getX(v[1]) + w2 * uv.getX(v[2])
          const s = w0 * uv.getY(v[0]) + w1 * uv.getY(v[1]) + w2 * uv.getY(v[2])
          const px = Math.min(tex.w - 1, Math.max(0, Math.floor((u - Math.floor(u)) * tex.w)))
          const py = Math.min(tex.h - 1, Math.max(0, Math.floor((s - Math.floor(s)) * tex.h)))
          const i = (py * tex.w + px) * 4
          cr = tex.data[i]; cg = tex.data[i + 1]; cb = tex.data[i + 2]
        } else if (vc) {
          const i = v[0]; cr = vc.getX(i) * 255; cg = vc.getY(i) * 255; cb = vc.getZ(i) * 255
        }
        r += cr * base.r / 3; gg += cg * base.g / 3; bb += cb * base.b / 3
      }
      cols.push([r, gg, bb])
      a.fromBufferAttribute(pos, v[0]); b.fromBufferAttribute(pos, v[1]); c.fromBufferAttribute(pos, v[2])
      weights.push(b.clone().sub(a).cross(c.clone().sub(a)).length() / 2 + 1e-9)
    }
  })
  const facts = viewer.facts(partId)
  if (!facts) throw new Error('the part is not loaded yet')
  if (cols.length !== facts.tri) throw new Error(`triangle counts differ (${cols.length} vs ${facts.tri}); regenerate the model`)
  // k-means in RGB, weighted by triangle area; tiny clusters merge into their nearest neighbour
  const d2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2
  const step = Math.max(1, Math.floor(cols.length / 20000))
  const sample = cols.filter((_, i) => i % step === 0), sw = weights.filter((_, i) => i % step === 0)
  const centres = [sample[0]]
  while (centres.length < k) {
    let best = 0, bi = 0
    sample.forEach((p, i) => { const d = Math.min(...centres.map(c => d2(p, c))) * sw[i]; if (d > best) { best = d; bi = i } })
    if (!best) break
    centres.push(sample[bi])
  }
  for (let it = 0; it < 10; it++) {
    const sum = centres.map(() => [0, 0, 0, 0])
    sample.forEach((p, i) => {
      let j = 0, dj = Infinity
      centres.forEach((c, ci) => { const d = d2(p, c); if (d < dj) { dj = d; j = ci } })
      sum[j][0] += p[0] * sw[i]; sum[j][1] += p[1] * sw[i]; sum[j][2] += p[2] * sw[i]; sum[j][3] += sw[i]
    })
    sum.forEach((s, j) => { if (s[3]) centres[j] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]] })
  }
  const assign = new Int16Array(cols.length), share = centres.map(() => 0)
  const total = weights.reduce((s, w) => s + w, 0)
  cols.forEach((p, i) => {
    let j = 0, dj = Infinity
    centres.forEach((c, ci) => { const d = d2(p, c); if (d < dj) { dj = d; j = ci } })
    assign[i] = j; share[j] += weights[i] / total
  })
  const keep = centres.map((_, j) => share[j] >= 0.015)
  const remap = centres.map((c, j) => {
    if (keep[j]) return j
    let best = j, bd = Infinity
    centres.forEach((o, oi) => { if (keep[oi] && d2(c, o) < bd) { bd = d2(c, o); best = oi } })
    return best
  })
  for (let i = 0; i < assign.length; i++) assign[i] = remap[assign[i]]
  const hex = centres.map(c => `#${c.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`)
  if (!viewer.setPaintIndices(partId, hex, assign)) throw new Error('could not paint the part')
  savePaint()
  const used = [...new Set(assign)].length
  alertNote(`AI colours applied to @${partId}: ${used} filament colour${used > 1 ? 's' : ''} (${[...new Set(assign)].map(j => hex[j]).join(', ')})`)
}

// =================================================================== area selection
document.querySelectorAll('[data-amode]').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('[data-amode]').forEach(x => x.classList.toggle('on', x === b))
    viewer.setArea({ mode: b.dataset.amode })
    $('selSizeWrap').hidden = b.dataset.amode !== 'brush'
    $('selAngleWrap').hidden = b.dataset.amode !== 'face'
  }
})
$('selSize').oninput = e => { viewer.setArea({ size: Number(e.target.value) }); $('selSizeVal').textContent = `${e.target.value} mm` }
$('selAngle').oninput = e => { viewer.setArea({ angle: Number(e.target.value) }); $('selAngleVal').textContent = `${e.target.value}°` }
$('xray').onchange = e => viewer.setArea({ xray: e.target.checked })

const fmtV = v => `(${v.map(f1).join(', ')})`
function renderSelCard(list) {
  state.selection = list
  const card = $('selCard')
  if (!list.length) { card.hidden = true; return }
  card.hidden = false
  card.innerHTML = `<h4>Selected area</h4>` + list.map(s => `<div class="part-line">
      <div><b>@${esc(s.part)}</b> <span class="muted">${s.triangles.toLocaleString()} triangles</span></div>
      <div class="kv"><span>Size</span><span>${s.size.map(f1).join(' × ')} mm</span>
        <span>Surface</span><span>≈ ${f1(s.area)} mm²</span>
        <span>Faces</span><span>${esc(s.facing)}</span>
        <span>Centre</span><span>${fmtV(s.centre)}</span></div></div>`).join('') +
    `<div class="actions"><button class="small" data-sel="ask">Ask Claude about this</button>
      <button class="small ghost" data-sel="comment">Comment</button><button class="small ghost" data-sel="clear">Clear</button></div>`
}
$('selCard').addEventListener('click', async e => {
  const act = e.target.dataset.sel
  const list = state.selection || []
  if (!act || !list.length) return
  if (act === 'clear') { viewer.clearSelection(); return }
  if (act === 'comment') {
    const s = list[0]
    const rect = $('stage').getBoundingClientRect()
    openCommentPopover({ view: '3d', part: s.part, point: s.centre, normal: s.normal,
      radius: Math.max(2, Math.round(Math.hypot(...s.size) / 2)), screen: { x: rect.width / 2 - 140, y: rect.height / 2 - 100 } })
    return
  }
  // Ask Claude: a picture of the view with the area highlighted + the exact numbers
  e.target.disabled = true
  let image = null
  try {
    const res = await post('/api/snapshot', { project: state.project, png: viewer.snapshot() })
    image = res.path || null
  } catch {}
  e.target.disabled = false
  for (const s of list) {
    addChip({ type: 'area', label: `▦ @${s.part} area ${s.size.map(f1).join('×')} mm`, a: { ...s, image } })
  }
  prefill('Change the selected area: ')
})

// =================================================================== paint
const FILAMENTS = [
  ['White', '#f2f0ea'], ['Black', '#1e1e20'], ['Grey', '#8a8f98'], ['Red', '#c62828'], ['Brick red', '#b5472f'],
  ['Orange', '#ef6c00'], ['Yellow', '#f9c80e'], ['Green', '#2e7d32'], ['Mint', '#7fd1b0'], ['Blue', '#1565c0'],
  ['Sky blue', '#6fb3e0'], ['Purple', '#6a3fa0'], ['Pink', '#f48fb1'], ['Wood', '#a47148'], ['Silk gold', '#c9a227'],
  ['Silk copper', '#b4693a'],
]
function setBrushColor(hex) {
  viewer.setBrush({ color: hex })
  $('customColor').value = hex
  document.querySelectorAll('#swatches button').forEach(b => b.classList.toggle('on', b.dataset.color === hex))
}
$('swatches').innerHTML = FILAMENTS.map(([name, hex]) =>
  `<button type="button" data-color="${hex}" title="${name}" style="background:${hex}"></button>`).join('')
$('swatches').onclick = e => { const c = e.target.dataset.color; if (c) setBrushColor(c) }
$('customColor').oninput = e => setBrushColor(e.target.value)
setBrushColor('#b5472f')
document.querySelectorAll('[data-pmode]').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('[data-pmode]').forEach(x => x.classList.toggle('on', x === b))
    const m = b.dataset.pmode
    viewer.setBrush({ mode: m })
    $('brushSizeWrap').hidden = !(m === 'brush' || m === 'erase')
    $('fillAngleWrap').hidden = m !== 'fill'
  }
})
$('brushSize').oninput = e => { viewer.setBrush({ size: Number(e.target.value) }); $('brushSizeVal').textContent = `${e.target.value} mm` }
$('fillAngle').oninput = e => { viewer.setBrush({ angle: Number(e.target.value) }); $('fillAngleVal').textContent = `${e.target.value}°` }

let paintTimer = null
function savePaint() {
  clearTimeout(paintTimer)
  const project = state.project
  paintTimer = setTimeout(() => post('/api/paint', { project, data: viewer.paintData() }), 600)
}
document.querySelectorAll('[data-tool]').forEach(b => { b.onclick = () => setTool(b.dataset.tool) })
document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, select, dialog')) return
  const map = { v: 'select', c: 'comment', m: 'measure', p: 'paint', a: 'area' }
  if (map[e.key]) setTool(map[e.key])
  if (e.key === 'Escape') { closePopover(); viewer.clearMeasure(); if (state.tool === 'area') viewer.clearSelection() }
})

document.querySelectorAll('[data-layout]').forEach(b => {
  b.onclick = () => { document.querySelectorAll('[data-layout]').forEach(x => x.classList.toggle('on', x === b)); viewer.setLayout(b.dataset.layout) }
})
document.querySelectorAll('[data-mode]').forEach(b => {
  b.onclick = () => { document.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x === b)); viewer.setMode(b.dataset.mode) }
})
$('explode').oninput = e => viewer.setExplode(Number(e.target.value))
$('bed').onchange = e => viewer.setBedVisible(e.target.checked)
$('fit').onclick = () => viewer.fit()
$('fit2d').onclick = () => blueprint.fit()

function renderSheets() {
  const cur = blueprint.current()
  $('sheets').innerHTML = blueprint.sheets().map(s => `<button data-sheet="${esc(s.id)}" class="${cur?.id === s.id ? 'on' : ''}">${esc(s.name)}</button>`).join('')
}
$('sheets').onclick = e => { const id = e.target.dataset.sheet; if (id) blueprint.show(id) }

function renderConvert() {
  $('convert').hidden = !(state.view === 'blueprint' && blueprint.sheets().length)
  $('convert').textContent = state.data?.parts.length ? 'Update 3D from blueprint →' : 'Convert to 3D →'
}
$('convert').onclick = () => {
  const open = (state.data?.comments || []).filter(c => c.view === 'blueprint' && c.status !== 'resolved')
  for (const c of open) addChip({ type: 'comment', n: c.n, label: `#${c.n}` })
  addChip({ type: 'convert', label: '⇢ Convert to 3D' })
  send(state.data?.parts.length
    ? 'The blueprint is updated and approved. Update the 3D model to match it exactly.'
    : 'The blueprint is approved. Convert it to a 3D model, matching every dimension.')
  setView('3d')
}

function renderEmpty() {
  let text = ''
  if (state.view === '3d' && state.data && !state.data.parts.some(p => p.exists))
    text = blueprint.sheets().length
      ? 'No 3D parts yet. Review the blueprint, then click "Convert to 3D".'
      : 'No 3D parts yet. Ask Claude to sketch a blueprint first, or to build the model directly.'
  if (state.view === 'blueprint' && state.data && !blueprint.sheets().length)
    text = 'No blueprint yet. Try: "Sketch a 2D blueprint with front, top and side views and all dimensions."'
  $('empty').textContent = text
}

// =================================================================== popovers
function openPopover(screen, html) {
  const pop = $('popover')
  pop.innerHTML = html
  pop.hidden = false
  const stage = $('stage').getBoundingClientRect()
  pop.style.left = `${Math.min(Math.max(8, screen.x + 12), stage.width - 290)}px`
  pop.style.top = `${Math.min(Math.max(8, screen.y + 12), stage.height - 220)}px`
  pop.querySelector('textarea, input')?.focus()
  return pop
}
function closePopover() { $('popover').hidden = true }

function openCommentPopover(pick) {
  const where = pick.view === 'blueprint'
    ? `Sheet ${esc(pick.sheet)}${pick.target ? ` · ${esc(pick.target)}` : ''}`
    : `@${esc(pick.part)} at (${pick.point.map(f1).join(', ')}) mm`
  const pop = openPopover(pick.screen, `<h4>New comment</h4><div class="muted">${where}</div>
    <textarea rows="3" data-role="text" placeholder="What should change here?"></textarea>
    ${pick.view === '3d' ? `<label class="muted">Area radius <input data-role="radius" type="number" value="${pick.radius || 5}" min="1" max="200" style="width:70px"> mm</label>` : ''}
    <label class="muted"><input type="checkbox" data-role="attach" checked> Add to my next message</label>
    <div class="row"><span class="grow"></span><button class="ghost small" data-role="cancel">Cancel</button><button class="small" data-role="save">Save</button></div>`)
  pop.querySelector('[data-role=cancel]').onclick = closePopover
  pop.querySelector('[data-role=save]').onclick = async () => {
    const text = pop.querySelector('[data-role=text]').value.trim()
    if (!text) return
    const comment = { ...pick, text, radius: Number(pop.querySelector('[data-role=radius]')?.value) || 5 }
    delete comment.screen
    const list = await post('/api/comments', { project: state.project, action: 'add', comment })
    const added = list[list.length - 1]
    if (pop.querySelector('[data-role=attach]').checked && added) addChip({ type: 'comment', n: added.n, label: `#${added.n}` })
    closePopover()
    focusComment(added?.n)
  }
}

function openDimPopover(d) {
  const isParam = !!state.data?.params?.[d.dim] && !!state.data?.build
  const pop = openPopover(d.screen, `<h4>${esc(d.label)}</h4><div class="muted">Sheet ${esc(d.sheet)} · now ${d.value} ${esc(d.unit)}</div>
    <input data-role="value" type="number" step="0.1" value="${d.value}">
    <div class="row">${isParam ? '<button class="small" data-role="apply" title="Re-run the generator now, no AI turn">Apply now</button>' : ''}
      <span class="grow"></span><button class="ghost small" data-role="queue">Add to message</button><button class="small" data-role="send">Ask Claude</button></div>`)
  const chip = () => {
    const to = Number(pop.querySelector('[data-role=value]').value)
    return { type: 'dim', label: `⟷ ${d.label}: ${d.value} → ${to} ${d.unit}`, d: { sheet: d.sheet, dim: d.dim, label: d.label, from: d.value, to, unit: d.unit } }
  }
  pop.querySelector('[data-role=queue]').onclick = () => { addChip(chip()); closePopover(); input.focus() }
  pop.querySelector('[data-role=send]').onclick = () => { const c = chip(); addChip(c); closePopover(); send(`Change ${d.label} to ${c.d.to} ${d.unit}.`) }
  const apply = pop.querySelector('[data-role=apply]')
  if (apply) apply.onclick = async () => { closePopover(); await applyParams({ [d.dim]: Number(pop.querySelector('[data-role=value]').value) }) }
}

// measure label actions (the label lives in the overlay)
$('overlay').addEventListener('click', e => {
  const action = e.target.dataset?.action
  if (action === 'measure-clear') viewer.clearMeasure()
  if (action === 'measure-ask') {
    const m = viewer.measurement()
    if (!m) return
    const target = Number(e.target.closest('.measure-label').querySelector('[data-role=mtarget]').value) || null
    addChip({ type: 'measure', label: `📏 ${m.distance.toFixed(1)}${target ? ` → ${target}` : ''} mm`, m: { ...m, target } })
    viewer.clearMeasure()
    prefill(target ? `Change this distance to ${target} mm.` : 'About this measurement: ')
  }
})

// =================================================================== side panels
document.querySelectorAll('.tabs button').forEach(b => { b.onclick = () => showTab(b.dataset.tab) })
function showTab(tab) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab))
  document.querySelectorAll('.panel').forEach(p => { p.hidden = p.dataset.panel !== tab })
}

function selectPart(id) {
  state.selected = id
  viewer.select(id)
  renderParts(); renderInspector(); renderInfo()
  if (id) showTab('inspect')
}

function renderParts() {
  const parts = state.data?.parts || []
  const pid = encodeURIComponent(state.project || '')
  const downloads = parts.some(p => p.exists) ? `<div class="downloads">
      <a class="btn" href="/api/export?project=${pid}&what=all" download title="STL parts, blueprints, scripts, studio.json and print notes">⬇ Download project (.zip)</a>
      <a class="btn ghost" href="/api/export?project=${pid}&what=parts" download title="Only this project's part STLs and print notes">Parts only</a></div>` : ''
  $('partsList').innerHTML = downloads + (parts.length ? parts.map(p => {
    const vp = viewer.part(p.id)
    const f = state.facts[p.id]
    return `<div class="item ${state.selected === p.id ? 'on' : ''}" data-part="${esc(p.id)}">
      <input type="color" value="${esc(vp?.color || p.color)}" data-role="color" title="Colour" style="width:22px;height:22px;padding:0;border:none;background:none">
      <span class="name" title="${esc(p.file)}">${esc(p.name)} <span class="muted">@${esc(p.id)}</span>${p.exists ? '' : ' <span class="errmsg">missing</span>'}
        ${f && !f.closed ? ' <span class="errmsg" title="Mesh is not closed">⚠</span>' : ''}</span>
      <button data-role="tag" title="Tag in chat">@</button>
      <button data-role="eye" title="Show / hide">${vp?.visible === false ? '◌' : '●'}</button>
    </div>`
  }).join('') : '<p class="muted">No parts yet.</p>')
  renderTotals()
}
$('partsList').addEventListener('click', e => {
  const row = e.target.closest('[data-part]'); if (!row) return
  const id = row.dataset.part, role = e.target.dataset.role
  if (role === 'tag') { addChip({ type: 'part', id, label: `@${id}` }); input.focus(); return }
  if (role === 'eye') { const vp = viewer.part(id); viewer.setVisible(id, vp?.visible === false); renderParts(); return }
  if (role === 'color') return
  selectPart(state.selected === id ? null : id)
})
$('partsList').addEventListener('input', e => {
  if (e.target.dataset.role !== 'color') return
  const id = e.target.closest('[data-part]').dataset.part
  viewer.setColor(id, e.target.value)
  savePaint()
})

function renderTotals() {
  const parts = (state.data?.parts || []).filter(p => state.facts[p.id])
  if (!parts.length) return
  const grams = parts.reduce((s, p) => s + state.facts[p.id].grams, 0)
  const bad = parts.filter(p => !state.facts[p.id].closed).length
  $('partsList').insertAdjacentHTML('beforeend', `<div class="section" style="margin-top:12px"><h4>Project</h4><div class="kv">
    <span>Parts</span><span>${parts.length}</span><span>PLA if solid</span><span>≈ ${Math.round(grams)} g</span>
    <span>Meshes</span><span>${bad ? `<span class="errmsg">${bad} not closed</span>` : '<span class="okmsg">all closed ✓</span>'}</span></div></div>`)
}

const QUICK = [
  ['Thinner walls', 'Make the walls of @{id} thinner while keeping it printable.'],
  ['Round edges', 'Round / chamfer the sharp outer edges of @{id}.'],
  ['Add a hole', 'Add a hole to @{id}: '],
  ['Check printability', 'Check @{id} for printability (overhangs, thin walls, bed fit) and fix what you can.'],
  ['Explain', 'Explain how @{id} is built and how it fits with the other parts.'],
  ['Split colours into parts', 'Split the colour areas I painted on @{id} into separate parts (one STL per colour) that fit together, so it can be printed in several colours.'],
]
function renderInspector() {
  const id = state.selected
  const part = state.data?.parts.find(p => p.id === id)
  if (!part) { $('inspector').innerHTML = '<p class="muted">Select a part in the 3D view or the Parts list.</p>'; return }
  const f = state.facts[id]
  const bed = state.data.bed
  const fits = f && f.size[0] <= bed[0] && f.size[1] <= bed[1] && f.size[2] <= bed[2]
  $('inspector').innerHTML = `
    <div class="section"><h4>${esc(part.name)} <span class="muted">@${esc(part.id)}</span></h4>
      <div class="kv"><span>File</span><span>${esc(part.file)}</span>
      ${f ? `<span>Triangles</span><span>${f.tri.toLocaleString()}</span>
      <span>Mesh</span><span>${f.closed ? '<span class="okmsg">closed ✓</span>' : '<span class="errmsg">not closed ✗</span>'}</span>
      <span>Bed</span><span>${fits ? '<span class="okmsg">fits ✓</span>' : '<span class="errmsg">too big ✗</span>'}</span>
      <span>PLA</span><span>≈ ${Math.round(f.grams)} g if solid</span>` : ''}
      ${part.notes ? `<span>Notes</span><span>${esc(part.notes)}</span>` : ''}</div></div>
    ${f ? `<div class="section"><h4>Size (mm) · edit to resize</h4>
      <div class="dims">${['W', 'D', 'H'].map((k, i) => `<label>${k}<input type="number" step="0.1" data-axis="${i}" value="${f.size[i].toFixed(1)}"></label>`).join('')}</div>
      <label class="muted"><input type="checkbox" id="lockProp"> Keep proportions</label>
      <div class="row" style="margin-top:6px"><span class="grow"></span><button class="small" id="askResize">Ask Claude to resize</button></div></div>` : ''}
    <div class="section"><h4>Colour & finish</h4>
      <div class="row"><input type="color" id="partColor" class="colorpick" value="${esc(viewer.part(id)?.color || part.color)}" title="Part colour">
        <select id="partFinish" class="finish">${Object.entries(FINISHES).map(([k, v]) =>
          `<option value="${k}" ${viewer.part(id)?.finish === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
      <div class="row" style="margin-top:6px"><button class="ghost small" id="paintPart">Paint this part</button>
        <button class="ghost small" id="clearPaint">Clear painted areas</button></div>
      ${part.glb ? '<div class="row" style="margin-top:6px"><button class="small" id="aiColours">Apply AI colours</button></div>' : ''}</div>
    <div class="section"><h4>Quick actions</h4><div class="actions">
      ${QUICK.map(([label], i) => `<button class="ghost" data-quick="${i}">${label}</button>`).join('')}
      <button class="ghost" id="isolate">Isolate</button><button class="ghost" id="showAll">Show all</button></div></div>`
  const dims = [...$('inspector').querySelectorAll('[data-axis]')]
  dims.forEach(el => el.oninput = () => {
    if (!$('lockProp').checked) return
    const k = Number(el.value) / f.size[Number(el.dataset.axis)]
    dims.forEach(o => { if (o !== el) o.value = (f.size[Number(o.dataset.axis)] * k).toFixed(1) })
  })
  $('askResize')?.addEventListener('click', () => {
    const to = dims.map(d => Number(d.value))
    addChip({ type: 'resize', label: `⤢ @${id} → ${to.map(f1).join('×')} mm`, r: { part: id, from: f.size, to } })
    prefill(`Resize @${id} to ${to.map(f1).join(' x ')} mm.`)
  })
  $('inspector').querySelectorAll('[data-quick]').forEach(b => {
    b.onclick = () => prefill(QUICK[Number(b.dataset.quick)][1].replaceAll('{id}', id), { type: 'part', id, label: `@${id}` })
  })
  $('partColor').oninput = e => { viewer.setColor(id, e.target.value); renderParts(); savePaint() }
  $('partFinish').onchange = e => { viewer.setFinish(id, e.target.value); savePaint() }
  $('paintPart').onclick = () => { setTool('paint'); document.querySelector('[data-pmode=brush]').click() }
  $('clearPaint').onclick = () => { viewer.clearPaint(id); savePaint() }
  $('aiColours')?.addEventListener('click', async e => {
    e.target.disabled = true; e.target.textContent = 'Reading colours…'
    try { await applyAiColours(id, `${state.project}/${part.glb}`) } catch (err) { alertNote(`AI colours: ${err.message}`) }
    e.target.disabled = false; e.target.textContent = 'Apply AI colours'
  })
  $('isolate').onclick = () => { viewer.isolate(id); renderParts() }
  $('showAll').onclick = () => { viewer.isolate(null); renderParts() }
}

function focusComment(n, fromPin) {
  state.focused = n
  viewer.focusComment(n); blueprint.focusComment(n)
  if (fromPin) showTab('comments')
  const c = state.data?.comments.find(x => x.n === n)
  if (c?.view === 'blueprint' && state.view !== 'blueprint') { setView('blueprint'); blueprint.show(c.sheet, { keepView: true }) }
  if (c?.view === 'blueprint' && blueprint.current()?.id !== c.sheet) blueprint.show(c.sheet, { keepView: true })
  if (c && c.view !== 'blueprint' && state.view !== '3d') setView('3d')
  renderComments()
}

function renderComments() {
  const list = state.data?.comments || []
  const open = list.filter(c => c.status !== 'resolved')
  $('commentCount').textContent = open.length || ''
  $('commentsList').innerHTML = (list.length ? `<div class="row" style="margin-bottom:8px">
      <span class="muted">${open.length} open</span><span class="grow"></span>
      ${open.length ? '<button class="small" id="sendOpen">Send open comments to Claude</button>' : ''}</div>` : '') +
    (list.length ? [...list].reverse().map(c => `<div class="comment ${c.status} ${state.focused === c.n ? 'on' : ''}" data-n="${c.n}">
      <div class="head"><b>#${c.n}</b> ${c.view === 'blueprint' ? `sheet ${esc(c.sheet)}` : `@${esc(c.part)}`}
        <span class="grow"></span>${c.status === 'resolved' ? 'resolved' : ''}</div>
      <p>${esc(c.text)}</p>
      <div class="row"><button class="link" data-act="ask">Ask Claude</button><button class="link" data-act="show">Show</button>
        <button class="link" data-act="toggle">${c.status === 'resolved' ? 'Reopen' : 'Resolve'}</button>
        <span class="grow"></span><button class="link" data-act="delete">Delete</button></div></div>`).join('')
      : '<p class="muted">No comments. Choose the Comment tool (C) and click the model or the blueprint.</p>')
  $('sendOpen')?.addEventListener('click', () => {
    for (const c of open) addChip({ type: 'comment', n: c.n, label: `#${c.n}` })
    send('Please address these comments.')
  })
}
$('commentsList').addEventListener('click', async e => {
  const card = e.target.closest('[data-n]'); const act = e.target.dataset.act
  if (!card || !act) return
  const n = Number(card.dataset.n), c = state.data.comments.find(x => x.n === n)
  if (act === 'ask') prefill(`Please address comment #${n}.`, { type: 'comment', n, label: `#${n}` })
  if (act === 'show') focusComment(n)
  if (act === 'toggle') await post('/api/comments', { project: state.project, action: 'update', n, patch: { status: c.status === 'resolved' ? 'open' : 'resolved' } })
  if (act === 'delete') await post('/api/comments', { project: state.project, action: 'delete', n })
})

function renderParams() {
  const params = state.data?.params || {}
  const keys = Object.keys(params)
  if (!keys.length) {
    $('paramsForm').innerHTML = '<p class="muted">No parameters yet. Ask Claude to "make the size and wall thickness editable parameters" and they will appear here. Editing them re-runs the model instantly, without an AI turn.</p>'
    return
  }
  $('paramsForm').innerHTML = keys.map(k => {
    const p = params[k]
    return `<div class="param"><div class="top"><span>${esc(p.label || k)}</span><span class="muted">${esc(p.unit || '')}</span></div>
      <div class="row"><input type="range" data-k="${esc(k)}" min="${p.min ?? 0}" max="${p.max ?? (p.value * 2 || 100)}" step="${p.step ?? 0.1}" value="${p.value}">
      <input type="number" data-n="${esc(k)}" step="${p.step ?? 0.1}" value="${p.value}" style="width:80px"></div></div>`
  }).join('') + (state.data.build
    ? '<div class="row"><span id="paramStatus" class="muted"></span><span class="grow"></span><button class="small" id="applyParams">Apply</button></div>'
    : '<p class="muted">This project has no build script, so changes go to Claude instead.</p><button class="small" id="askParams">Ask Claude</button>')
  const form = $('paramsForm')
  form.querySelectorAll('[data-k]').forEach(r => r.oninput = () => { form.querySelector(`[data-n="${r.dataset.k}"]`).value = r.value })
  form.querySelectorAll('[data-n]').forEach(n => n.oninput = () => { form.querySelector(`[data-k="${n.dataset.n}"]`).value = n.value })
  const values = () => Object.fromEntries([...form.querySelectorAll('[data-n]')].map(n => [n.dataset.n, Number(n.value)]))
  $('applyParams')?.addEventListener('click', () => applyParams(values()))
  $('askParams')?.addEventListener('click', () => {
    const changed = Object.entries(values()).filter(([k, v]) => v !== params[k].value)
    if (changed.length) send(`Change these parameters: ${changed.map(([k, v]) => `${params[k].label || k} = ${v} ${params[k].unit || ''}`).join(', ')}.`)
  })
}
async function applyParams(values) {
  showTab('params')
  const status = $('paramStatus'); if (status) status.textContent = 'Rebuilding…'
  const res = await post('/api/params', { project: state.project, values })
  const s = $('paramStatus')
  if (s) s.innerHTML = res.ok ? '<span class="okmsg">Rebuilt ✓</span>' : `<span class="errmsg">Failed</span>`
  if (!res.ok) alertNote(`Rebuild failed: ${(res.output || '').slice(-300)}`)
}

function renderInfo() {
  if (!state.data) return
  if (state.view === 'blueprint') {
    const cur = blueprint.current()
    $('info').innerHTML = cur ? `<b>${esc(cur.name)}</b> · ${esc(cur.file)} · ${blueprint.sheets().length} sheet(s)` : ''
    return
  }
  const id = state.selected, f = id && state.facts[id]
  if (f) {
    $('info').innerHTML = `<b>@${esc(id)}</b> · ${f.size.map(f1).join(' × ')} mm · ${f.tri.toLocaleString()} triangles · ${f.closed ? 'closed ✓' : '<span class="errmsg">not closed</span>'} · ≈ ${Math.round(f.grams)} g`
  } else {
    const n = state.data.parts.filter(p => state.facts[p.id]).length
    $('info').innerHTML = n ? `<b>${esc(state.data.name)}</b> · ${n} part(s) · click a part to inspect · C comment · M measure` : ''
  }
}

function renderAll() { renderParts(); renderInspector(); renderComments(); renderParams(); renderSheets(); renderEmpty(); renderInfo(); renderConvert() }

loadProjects()

