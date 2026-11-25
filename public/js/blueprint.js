// 2D blueprint viewer: shows SVG sheets (viewBox in mm), pan / zoom, clickable dimensions
// (<g class="dim" data-dim data-value data-unit data-label>) and comment pins in sheet mm.
// SVG comes from files Claude writes, so it is sanitised before it is shown.

const BASE = 4 // px per mm at zoom 1

const BLOCKED = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'image', 'use', 'animate', 'set', 'animatemotion', 'animatetransform'])

export function sanitise(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const svg = doc.documentElement
  if (!svg || svg.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return null
  const walk = el => {
    for (const child of [...el.children]) {
      if (BLOCKED.has(child.nodeName.toLowerCase())) { child.remove(); continue }
      walk(child)
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase(), value = attr.value.trim().toLowerCase()
      if (name.startsWith('on')) el.removeAttribute(attr.name)
      else if ((name === 'href' || name === 'xlink:href') && !value.startsWith('#')) el.removeAttribute(attr.name)
      else if (name === 'style' && /url\s*\(|expression|javascript:/.test(value)) el.removeAttribute(attr.name)
    }
  }
  walk(svg)
  for (const style of [...svg.querySelectorAll('style')]) {
    if (/@import|url\s*\(|javascript:/i.test(style.textContent)) style.remove()
  }
  return document.importNode(svg, true)
}

export function createBlueprint(container, overlay, hooks) {
  let sheets = [], current = null, svg = null, tool = 'select'
  let view = { x: 40, y: 40, s: 1 }, vb = [0, 0, 297, 210]
  let comments = [], focused = null
  const pins = new Map()

  function apply() {
    if (!svg) return
    svg.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`
  }

  function fit() {
    if (!svg) return
    const w = container.clientWidth, h = container.clientHeight
    const s = Math.min((w - 60) / (vb[2] * BASE), (h - 60) / (vb[3] * BASE))
    view = { s, x: (w - vb[2] * BASE * s) / 2, y: (h - vb[3] * BASE * s) / 2 }
    apply()
  }

  async function show(id, { keepView = false } = {}) {
    current = sheets.find(s => s.id === id) || sheets[0] || null
    container.innerHTML = ''
    svg = null
    if (!current) { hooks.onEmpty?.(); return }
    const res = await fetch(`/api/file?path=${encodeURIComponent(current.path)}&t=${Date.now()}`)
    if (!res.ok) { container.textContent = `Could not load ${current.file}`; return }
    svg = sanitise(await res.text())
    if (!svg) { container.textContent = `${current.file} is not a valid SVG`; return }
    const box = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number)
    vb = box.length === 4 && box.every(Number.isFinite) ? box
      : [0, 0, parseFloat(svg.getAttribute('width')) || 297, parseFloat(svg.getAttribute('height')) || 210]
    svg.setAttribute('viewBox', vb.join(' '))
    svg.setAttribute('width', vb[2] * BASE)
    svg.setAttribute('height', vb[3] * BASE)
    container.append(svg)
    if (keepView) apply(); else fit()
    hooks.onShown?.(current)
  }

  // pan / zoom
  let drag = null
  container.addEventListener('wheel', e => {
    e.preventDefault()
    const rect = container.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    const k = Math.exp(-e.deltaY * 0.0015)
    const s = Math.min(20, Math.max(0.05, view.s * k))
    view.x = mx - (mx - view.x) * (s / view.s)
    view.y = my - (my - view.y) * (s / view.s)
    view.s = s
    apply()
  }, { passive: false })
  container.addEventListener('pointerdown', e => {
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }
    container.setPointerCapture(e.pointerId)
  })
  container.addEventListener('pointermove', e => {
    if (!drag) return
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y
    if (Math.hypot(dx, dy) > 4) { drag.moved = true; container.classList.add('panning') }
    if (drag.moved) { view.x = drag.vx + dx; view.y = drag.vy + dy; apply() }
  })
  container.addEventListener('pointerup', e => {
    const wasDrag = drag?.moved
    drag = null
    container.classList.remove('panning')
    if (wasDrag || !svg) return
    const rect = container.getBoundingClientRect()
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const target = document.elementFromPoint(e.clientX, e.clientY)
    const dim = target?.closest?.('.dim')
    const point = toSheet(e.clientX, e.clientY)
    if (tool === 'comment') {
      const label = dim?.dataset.label || dim?.dataset.dim || target?.closest?.('[data-part]')?.dataset.part
      hooks.onPick?.({ sheet: current.id, point, target: label, screen })
    } else if (dim) {
      container.querySelectorAll('.dim.hot').forEach(x => x.classList.remove('hot'))
      dim.classList.add('hot')
      hooks.onDim?.({ sheet: current.id, dim: dim.dataset.dim, value: Number(dim.dataset.value),
        unit: dim.dataset.unit || 'mm', label: dim.dataset.label || dim.dataset.dim, screen })
    } else {
      const part = target?.closest?.('[data-part]')?.dataset.part
      if (part) hooks.onSelect?.(part)
    }
  })

  function toSheet(clientX, clientY) {
    const m = svg.getScreenCTM()
    if (!m) return [0, 0]
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse())
    return [p.x, p.y]
  }
  function toScreen(x, y) {
    const m = svg.getScreenCTM()
    if (!m) return null
    const p = new DOMPoint(x, y).matrixTransform(m)
    const rect = container.getBoundingClientRect()
    return { x: p.x - rect.left, y: p.y - rect.top }
  }

  function updatePins() {
    const seen = new Set()
    if (svg && current && !container.hidden) {
      for (const c of comments) {
        if (c.view !== 'blueprint' || c.sheet !== current.id) continue
        const s = toScreen(c.point[0], c.point[1])
        if (!s) continue
        let el = pins.get(c.n)
        if (!el) { el = document.createElement('div'); overlay.append(el); pins.set(c.n, el) }
        el.className = `pin ${c.status === 'resolved' ? 'resolved' : ''} ${focused === c.n ? 'on' : ''}`
        el.textContent = c.n
        el.style.left = `${s.x}px`; el.style.top = `${s.y}px`
        el.onclick = () => hooks.onPinClick?.(c.n)
        seen.add(c.n)
      }
    }
    for (const [n, el] of pins) if (!seen.has(n)) { el.remove(); pins.delete(n) }
    requestAnimationFrame(updatePins)
  }
  requestAnimationFrame(updatePins)
  new ResizeObserver(() => { if (svg && !container.hidden) apply() }).observe(container)

  return {
    setSheets(list) { sheets = list.filter(s => s.exists) },
    sheets: () => sheets,
    current: () => current,
    show,
    async reload(path) { if (current && current.path === path) await show(current.id, { keepView: true }) },
    fit,
    setTool(v) { tool = v },
    setComments(list) { comments = list },
    focusComment(n) { focused = n },
  }
}
