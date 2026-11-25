// 3D viewer: multi-part projects, assembled / print layouts, explode, selection, pin
// comments with a region, a two-point measure tool, and colour painting (whole part,
// face fill, brush, eraser) with filament-like finishes. Coordinates inside `world` are
// printer coordinates (mm, Z up); `world` is turned so Z points up on screen.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'

const PLA_DENSITY = 1.24 // g/cm3

export function analyse(geometry) {
  const pos = geometry.attributes.position.array
  const tri = pos.length / 9
  let vol = 0
  const ids = new Map()
  const id = i => {
    const k = `${Math.round(pos[i] * 1e4)},${Math.round(pos[i + 1] * 1e4)},${Math.round(pos[i + 2] * 1e4)}`
    let v = ids.get(k)
    if (v === undefined) { v = ids.size; ids.set(k, v) }
    return v
  }
  const edges = new Map()
  const S = 67108864
  for (let t = 0; t < tri; t++) {
    const o = t * 9
    const ax = pos[o], ay = pos[o + 1], az = pos[o + 2], bx = pos[o + 3], by = pos[o + 4], bz = pos[o + 5]
    const cx = pos[o + 6], cy = pos[o + 7], cz = pos[o + 8]
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
    const a = id(o), b = id(o + 3), c = id(o + 6)
    for (const [p, q] of [[a, b], [b, c], [c, a]]) edges.set(p * S + q, (edges.get(p * S + q) ?? 0) + 1)
  }
  let closed = tri > 0
  for (const [k, n] of edges) {
    const p = Math.floor(k / S), q = k % S
    if ((edges.get(q * S + p) ?? 0) !== n) { closed = false; break }
  }
  geometry.computeBoundingBox()
  const bb = geometry.boundingBox
  return {
    tri, closed, volume: Math.abs(vol) / 1000, grams: Math.abs(vol) / 1000 * PLA_DENSITY,
    min: bb.min.toArray(), max: bb.max.toArray(), size: [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z],
  }
}

// Filament-like finishes for the clay view
export const FINISHES = {
  matte: { label: 'Matte PLA', make: () => new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 }) },
  glossy: { label: 'Glossy', make: () => new THREE.MeshPhysicalMaterial({ roughness: 0.22, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.2 }) },
  silk: { label: 'Silk (metallic)', make: () => new THREE.MeshPhysicalMaterial({ roughness: 0.32, metalness: 0.55, sheen: 0.5, sheenRoughness: 0.4 }) },
  translucent: { label: 'Translucent', make: () => new THREE.MeshPhysicalMaterial({ roughness: 0.4, metalness: 0, transparent: true, opacity: 0.62, depthWrite: false }) },
}

export function createViewer(container, overlay, hooks) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.localClippingEnabled = true            // section / crop box
  container.append(renderer.domElement)
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 20000)
  camera.position.set(260, 220, 260)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true

  scene.add(new THREE.HemisphereLight(0xfff4e8, 0x6b5a4d, 1.1))
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(-200, 400, 300); scene.add(key)
  const fill = new THREE.DirectionalLight(0xffe2cc, 0.5); fill.position.set(300, 150, -200); scene.add(fill)

  const world = new THREE.Group(); world.rotation.x = -Math.PI / 2; scene.add(world)
  const bedGroup = new THREE.Group(); world.add(bedGroup)
  const partsGroup = new THREE.Group(); world.add(partsGroup)
  const markGroup = new THREE.Group(); scene.add(markGroup)

  let bedSize = [220, 220, 250]
  let dark = false   // theme: paper (light) or chalkboard (dark)
  const theme = () => dark
    ? { plate: 0x27302b, grid1: 0x8c978e, grid2: 0x4a554d, paper: 0xe9e6dc, line: 0x1b211d }
    : { plate: 0xd9cfba, grid1: 0x8a7f6a, grid2: 0xb8ad96, paper: 0xfbf8f0, line: 0x2b2a28 }
  const edgeMaterial = new THREE.LineBasicMaterial({ color: theme().line })
  function buildBed() {
    bedGroup.clear()
    const t = theme()
    const plate = new THREE.Mesh(new THREE.BoxGeometry(bedSize[0], bedSize[1], 1.5),
      new THREE.MeshStandardMaterial({ color: t.plate, roughness: 0.95 }))
    plate.position.z = -0.8
    const grid = new THREE.GridHelper(Math.max(bedSize[0], bedSize[1]), Math.round(Math.max(bedSize[0], bedSize[1]) / 10), t.grid1, t.grid2)
    grid.rotation.x = Math.PI / 2
    grid.position.z = 0.05
    bedGroup.add(plate, grid)
  }
  buildBed()

  // part: { def, wrap, holder, mesh, facts, color, finish, visible, paint (Uint8Array per triangle), adj, centroids }
  const parts = new Map()
  let layout = 'assembled', explode = 0, mode = 'clay', tool = 'select', selected = null
  let comments = [], focused = null, region = null
  let measure = null
  // paint state: palette index 0 = the part's own colour; k >= 1 = palette[k - 1]
  let palette = []
  let saved = {}           // part id -> { tri, paint (base64) } waiting to be applied after load
  const brush = { mode: 'part', color: '#c0573a', size: 6, angle: 25 }
  const loader = new STLLoader()

  // ---------------------------------------------------------------- section / crop box
  // The box lives in assembly coordinates (partsGroup space, mm, Z up). Six clipping planes cut
  // every part, its outlines and the selection overlay; inside surfaces are drawn double-sided.
  const section = { on: false, min: new THREE.Vector3(), max: new THREE.Vector3() }
  const planes = Array.from({ length: 6 }, () => new THREE.Plane())
  let sectionLines = null
  function updatePlanes() {
    partsGroup.updateMatrixWorld(true)
    const m = partsGroup.matrixWorld
    const { min, max } = section
    const defs = [[[1, 0, 0], min], [[-1, 0, 0], max], [[0, 1, 0], min], [[0, -1, 0], max], [[0, 0, 1], min], [[0, 0, -1], max]]
    defs.forEach(([n, pt], i) => planes[i].setFromNormalAndCoplanarPoint(new THREE.Vector3(...n), pt.clone()).applyMatrix4(m))
    if (sectionLines) { partsGroup.remove(sectionLines); sectionLines.geometry.dispose(); sectionLines = null }
    if (section.on) {
      const size = max.clone().sub(min), c = min.clone().add(max).multiplyScalar(0.5)
      sectionLines = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z)),
        new THREE.LineDashedMaterial({ color: 0xff7a1a, dashSize: 3, gapSize: 2 }))
      sectionLines.computeLineDistances()
      sectionLines.position.copy(c)
      partsGroup.add(sectionLines)
    }
    const clip = section.on ? planes : null
    for (const mat of [selMat, edgeMaterial, depthMat]) { mat.clippingPlanes = clip; mat.needsUpdate = true }
    restyle()
  }
  const toAssembly = new THREE.Matrix4()
  function insideSection(worldPoint) {
    if (!section.on) return true
    toAssembly.copy(partsGroup.matrixWorld).invert()
    const q = worldPoint.clone().applyMatrix4(toAssembly), e = 1e-3
    return q.x >= section.min.x - e && q.x <= section.max.x + e && q.y >= section.min.y - e && q.y <= section.max.y + e &&
      q.z >= section.min.z - e && q.z <= section.max.z + e
  }
  // all visible parts, in assembly coordinates, without explode
  function assemblyBounds() {
    const box = new THREE.Box3()
    for (const p of parts.values()) if (p.facts && p.wrap.visible) box.union(partBox(p))
    return box
  }

  // ---------------------------------------------------------------- materials and colours
  function material(p) {
    const m = baseMaterial(p)
    if (section.on) { m.clippingPlanes = planes; m.side = THREE.DoubleSide }
    return m
  }
  function baseMaterial(p) {
    const isSel = p.def.id === selected
    if (mode === 'sketch') {
      // paper surfaces, pushed back a little so the pencil outlines draw cleanly on top
      return new THREE.MeshLambertMaterial({ color: theme().paper, emissive: isSel ? (dark ? 0x3a3520 : 0x5a4a10) : 0x000000,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
    }
    if (mode === 'wire') return new THREE.MeshBasicMaterial({ color: new THREE.Color(p.color), wireframe: true })
    if (mode === 'xray') return new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.32, depthWrite: false,
      emissive: isSel ? 0x552200 : 0x000000, side: THREE.DoubleSide })
    const m = (FINISHES[p.finish] || FINISHES.matte).make()
    m.vertexColors = true
    m.emissive = new THREE.Color(isSel ? 0x3a1606 : 0x000000)
    return m
  }
  // pencil outlines: feature edges (sharper than 28°), built on first use per mesh
  function syncEdges(p) {
    if (!p.mesh) return
    if (mode === 'sketch' && !p.edges) {
      p.edges = new THREE.LineSegments(new THREE.EdgesGeometry(p.mesh.geometry, 28), edgeMaterial)
      p.mesh.add(p.edges)
    }
    if (p.edges) p.edges.visible = mode === 'sketch'
  }
  const restyle = () => { for (const p of parts.values()) if (p.mesh) { p.mesh.material = material(p); syncEdges(p) } }

  const tmp = new THREE.Color()
  function recolor(p, tris) {
    if (!p.mesh) return
    const attr = p.mesh.geometry.attributes.color
    const base = new THREE.Color(p.color)
    const cols = palette.map(h => new THREE.Color(h))
    const list = tris ?? null
    const n = list ? list.length : p.facts.tri
    for (let k = 0; k < n; k++) {
      const t = list ? list[k] : k
      const idx = p.paint[t]
      const c = idx ? (cols[idx - 1] || base) : base
      for (let v = 0; v < 3; v++) attr.setXYZ(t * 3 + v, c.r, c.g, c.b)
    }
    attr.needsUpdate = true
  }
  function paletteIndex(hex) {
    const h = hex.toLowerCase()
    let i = palette.indexOf(h)
    if (i < 0) { if (palette.length >= 254) return 1; palette.push(h); i = palette.length - 1 }
    return i + 1
  }

  async function loadPart(p, attempt = 0) {
    if (!p.def.exists || !p.def.path) return
    const res = await fetch(`/api/file?path=${encodeURIComponent(p.def.path)}&t=${Date.now()}`)
    if (!res.ok) return
    let geometry
    try {
      geometry = loader.parse(await res.arrayBuffer())
    } catch {
      // the file was caught half-written: keep what is shown and try again shortly
      if (attempt < 4) { await new Promise(r => setTimeout(r, 700)); return loadPart(p, attempt + 1) }
      return
    }
    if (geometry.index) geometry = geometry.toNonIndexed()
    p.facts = analyse(geometry)
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(p.facts.tri * 9), 3))
    // restore saved paint when the mesh still has the same triangles
    const s = saved[p.def.id]
    p.paint = new Uint8Array(p.facts.tri)
    if (s?.paint && s.tri === p.facts.tri) {
      try { p.paint.set(Uint8Array.from(atob(s.paint), c => c.charCodeAt(0)).subarray(0, p.facts.tri)) } catch {}
    } else if (s?.paint) {
      hooks.onPaintLost?.(p.def.id)
    }
    p.adj = null; p.centroids = null
    if (p.mesh) { p.holder.remove(p.mesh); p.mesh.geometry.dispose() }
    p.mesh = new THREE.Mesh(geometry, material(p))
    p.mesh.userData.partId = p.def.id
    p.holder.add(p.mesh)
    p.edges = null
    // a new shape invalidates the area selection on this part
    const hadSel = p.sel?.some(v => v)
    p.sel = null; p.selMesh = null; p.normals = null
    if (hadSel) hooks.onSelection?.(selectionSummary())
    syncEdges(p)
    recolor(p)
    hooks.onFacts?.(p.def.id, p.facts)
  }

  // ---------------------------------------------------------------- layout
  function partBox(p) {
    return new THREE.Box3(new THREE.Vector3(...p.facts.min), new THREE.Vector3(...p.facts.max)).applyMatrix4(p.holder.matrix)
  }
  function applyLayout() {
    let cursor = 0
    const loaded = [...parts.values()].filter(p => p.facts)
    for (const p of loaded) {
      p.wrap.position.set(0, 0, 0)
      if (layout === 'assembled') {
        const a = p.def.assembly || {}
        const [x, y, z] = a.position || [0, 0, 0]
        const [rx, ry, rz] = (a.rotation || [0, 0, 0]).map(THREE.MathUtils.degToRad)
        p.holder.position.set(x, y, z)
        p.holder.rotation.set(rx, ry, rz)
      } else {
        const [mnx, mny, mnz] = p.facts.min, [mxx, mxy] = p.facts.max
        p.holder.rotation.set(0, 0, 0)
        p.holder.position.set(cursor - mnx, -(mny + mxy) / 2, -mnz)
        cursor += (mxx - mnx) + 12
      }
      p.holder.updateMatrix()
    }
    partsGroup.position.set(0, 0, 0)
    partsGroup.updateMatrixWorld(true)
    const box = new THREE.Box3()
    for (const p of loaded) if (p.wrap.visible) box.expandByObject(p.holder)
    if (!box.isEmpty()) {
      const local = box.clone().applyMatrix4(new THREE.Matrix4().copy(world.matrixWorld).invert())
      partsGroup.position.set(-(local.min.x + local.max.x) / 2, -(local.min.y + local.max.y) / 2, -local.min.z)
    }
    applyExplode()
    if (section.on) updatePlanes()
  }

  function applyExplode() {
    const loaded = [...parts.values()].filter(p => p.facts && p.wrap.visible)
    const centres = loaded.map(p => partBox(p).getCenter(new THREE.Vector3()))
    const mid = centres.reduce((a, c) => a.add(c), new THREE.Vector3()).multiplyScalar(1 / Math.max(1, centres.length))
    const span = Math.max(...loaded.map(p => Math.max(...p.facts.size)), 1)
    let lowest = Infinity, floor = Infinity
    loaded.forEach((p, i) => {
      const d = centres[i].clone().sub(mid)
      if (d.length() < 1e-3) d.set(0, 0, i === 0 ? 0 : 1)
      p.wrap.position.copy(d.normalize().multiplyScalar(explode * span * 0.9))
      const zmin = partBox(p).min.z
      floor = Math.min(floor, zmin)
      lowest = Math.min(lowest, zmin + p.wrap.position.z)
    })
    // keep every part above the bed
    const lift = loaded.length ? Math.max(0, floor - lowest) : 0
    for (const p of loaded) p.wrap.position.z += lift
  }

  function fit() {
    const box = new THREE.Box3()
    for (const p of parts.values()) if (p.mesh && p.wrap.visible) box.expandByObject(p.mesh)
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(bedSize[0], 40, bedSize[1]))
    const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3())
    const r = Math.max(size.x, size.y, size.z)
    controls.target.copy(c)
    camera.position.set(c.x + r * 1.1, c.y + r * 0.85, c.z + r * 1.35)
    controls.update()
  }

  // ---------------------------------------------------------------- painting
  function centroids(p) {
    if (p.centroids) return p.centroids
    const pos = p.mesh.geometry.attributes.position.array
    const c = new Float32Array(p.facts.tri * 3)
    for (let t = 0; t < p.facts.tri; t++) {
      const o = t * 9
      c[t * 3] = (pos[o] + pos[o + 3] + pos[o + 6]) / 3
      c[t * 3 + 1] = (pos[o + 1] + pos[o + 4] + pos[o + 7]) / 3
      c[t * 3 + 2] = (pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3
    }
    return (p.centroids = c)
  }
  // neighbours across shared edges, 3 per triangle (-1 where none)
  function adjacency(p) {
    if (p.adj) return p.adj
    const pos = p.mesh.geometry.attributes.position.array
    const n = p.facts.tri
    const ids = new Map()
    const vid = i => {
      const k = `${Math.round(pos[i] * 1e4)},${Math.round(pos[i + 1] * 1e4)},${Math.round(pos[i + 2] * 1e4)}`
      let v = ids.get(k)
      if (v === undefined) { v = ids.size; ids.set(k, v) }
      return v
    }
    const owner = new Map()
    const adj = new Int32Array(n * 3).fill(-1)
    const S = 67108864
    for (let t = 0; t < n; t++) {
      const v = [vid(t * 9), vid(t * 9 + 3), vid(t * 9 + 6)]
      for (let e = 0; e < 3; e++) {
        const a = v[e], b = v[(e + 1) % 3]
        const key = Math.min(a, b) * S + Math.max(a, b)
        const other = owner.get(key)
        if (other === undefined) owner.set(key, t * 3 + e)
        else { adj[t * 3 + e] = Math.floor(other / 3); adj[other] = t }
      }
    }
    return (p.adj = adj)
  }
  function faceNormal(pos, t, out) {
    const o = t * 9
    const ax = pos[o + 3] - pos[o], ay = pos[o + 4] - pos[o + 1], az = pos[o + 5] - pos[o + 2]
    const bx = pos[o + 6] - pos[o], by = pos[o + 7] - pos[o + 1], bz = pos[o + 8] - pos[o + 2]
    out.set(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx).normalize()
    return out
  }
  function fillFrom(p, start, idx) {
    const adj = adjacency(p)
    const pos = p.mesh.geometry.attributes.position.array
    const from = p.paint[start]
    const cos = Math.cos(THREE.MathUtils.degToRad(brush.angle))
    const n0 = new THREE.Vector3(), n1 = new THREE.Vector3()
    const seen = new Uint8Array(p.facts.tri)
    const stack = [start], changed = []
    seen[start] = 1
    while (stack.length) {
      const t = stack.pop()
      changed.push(t)
      faceNormal(pos, t, n0)
      for (let e = 0; e < 3; e++) {
        const q = adj[t * 3 + e]
        if (q < 0 || seen[q] || p.paint[q] !== from) continue
        if (faceNormal(pos, q, n1).dot(n0) < cos) continue   // stop at edges sharper than the angle
        seen[q] = 1
        stack.push(q)
      }
    }
    for (const t of changed) p.paint[t] = idx
    recolor(p, changed)
  }
  function brushAt(p, local, idx) {
    const c = centroids(p)
    const r2 = brush.size * brush.size
    const changed = []
    for (let t = 0; t < p.facts.tri; t++) {
      const dx = c[t * 3] - local.x, dy = c[t * 3 + 1] - local.y, dz = c[t * 3 + 2] - local.z
      if (dx * dx + dy * dy + dz * dz <= r2 && p.paint[t] !== idx) { p.paint[t] = idx; changed.push(t) }
    }
    if (changed.length) recolor(p, changed)
  }
  function paintHit(hit) {
    const p = parts.get(hit.object.userData.partId)
    if (!p) return
    const local = hit.object.worldToLocal(hit.point.clone())
    if (brush.mode === 'part') {
      p.color = brush.color
      p.paint.fill(0)
      recolor(p)
      hooks.onPartColor?.(p.def.id, brush.color)
    } else if (brush.mode === 'fill') {
      fillFrom(p, hit.faceIndex, paletteIndex(brush.color))
    } else {
      const idx = brush.mode === 'erase' ? 0 : paletteIndex(brush.color)
      // join up a stroke: fast moves leave gaps, so paint along the segment from the last point
      const last = lastStroke?.part === p.def.id ? lastStroke.local : null
      const steps = last ? Math.min(60, Math.floor(last.distanceTo(local) / (brush.size * 0.5))) : 0
      for (let i = 1; i <= steps; i++) brushAt(p, last.clone().lerp(local, i / (steps + 1)), idx)
      brushAt(p, local, idx)
      lastStroke = { part: p.def.id, local }
    }
  }
  let lastStroke = null

  // ---------------------------------------------------------------- area selection
  // Per part: p.sel (1 byte per triangle). Shown as an orange overlay mesh of the selected
  // triangles, so it works in every display mode. Box / lasso test triangle centres on screen
  // and, unless X-ray is on, keep only those the camera can see (depth-buffer check).
  const area = { mode: 'box', xray: false, size: 6, angle: 25 }
  const selMat = new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.55, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide })
  let dragSel = null, selStroke = null

  const mask = p => (p.sel && p.sel.length === p.facts.tri ? p.sel : (p.sel = new Uint8Array(p.facts.tri)))
  function normalsOf(p) {
    if (p.normals) return p.normals
    const pos = p.mesh.geometry.attributes.position.array
    const n = new Float32Array(p.facts.tri * 3), v = new THREE.Vector3()
    for (let t = 0; t < p.facts.tri; t++) { faceNormal(pos, t, v); n[t * 3] = v.x; n[t * 3 + 1] = v.y; n[t * 3 + 2] = v.z }
    return (p.normals = n)
  }
  function drawSelection(p) {
    if (p.selMesh) { p.selMesh.parent?.remove(p.selMesh); p.selMesh.geometry.dispose(); p.selMesh = null }
    if (!p.mesh || !p.sel) return
    let n = 0
    for (let t = 0; t < p.sel.length; t++) n += p.sel[t]
    if (!n) return
    const src = p.mesh.geometry.attributes.position.array
    const out = new Float32Array(n * 9)
    for (let t = 0, o = 0; t < p.sel.length; t++) if (p.sel[t]) { out.set(src.subarray(t * 9, t * 9 + 9), o); o += 9 }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(out, 3))
    p.selMesh = new THREE.Mesh(g, selMat)
    p.selMesh.renderOrder = 5
    p.selMesh.raycast = () => {}           // picking goes through to the part
    p.mesh.add(p.selMesh)
  }
  function selectionChanged(list) { for (const p of list) drawSelection(p); hooks.onSelection?.(selectionSummary()) }
  function clearAll() { for (const p of parts.values()) if (p.sel) p.sel.fill(0); selectionChanged([...parts.values()]) }

  // depth of the scene at every pixel, to know which triangles are visible
  const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  function readDepth() {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    const rt = new THREE.WebGLRenderTarget(size.x, size.y)
    const hide = [bedGroup, markGroup, region, ...[...parts.values()].flatMap(p => [p.selMesh, p.edges])].filter(Boolean)
    const was = hide.map(o => o.visible)
    hide.forEach(o => { o.visible = false })
    scene.overrideMaterial = depthMat
    renderer.setRenderTarget(rt)
    renderer.render(scene, camera)
    const buf = new Uint8Array(size.x * size.y * 4)
    renderer.readRenderTargetPixels(rt, 0, 0, size.x, size.y, buf)
    renderer.setRenderTarget(null)
    scene.overrideMaterial = null
    hide.forEach((o, i) => { o.visible = was[i] })
    rt.dispose()
    return { buf, w: size.x, h: size.y }
  }
  const UNPACK = [1 / 16777216, 1 / 65536, 1 / 256, 1].map(f => f * 255 / 256 / 255)
  const depthAt = (d, x, y) => {
    const i = (y * d.w + x) * 4
    return d.buf[i] * UNPACK[0] + d.buf[i + 1] * UNPACK[1] + d.buf[i + 2] * UNPACK[2] + d.buf[i + 3] * UNPACK[3]
  }
  const viewDist = depth => -(camera.near * camera.far) / ((camera.far - camera.near) * depth - camera.far)

  // select the triangles that overlap a screen shape (rect or polygon, canvas CSS px). CAD meshes
  // have large triangles, so a triangle counts when any of its corners, edge midpoints or centre is
  // inside the shape, or when the shape's centre lies inside the triangle. Unless X-ray is on, the
  // point used must also be visible (depth-buffer check) and the triangle must face the camera.
  const W = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [.5, .5, 0], [0, .5, .5], [.5, 0, .5], [1 / 3, 1 / 3, 1 / 3]]
  function selectInShape(inside, op, centre) {
    const rect = renderer.domElement.getBoundingClientRect()
    const depth = area.xray ? null : readDepth()
    const camPos = camera.getWorldPosition(new THREE.Vector3())
    const nrm = new THREE.Vector3(), nm = new THREE.Matrix3()
    const P = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], S = [[0, 0], [0, 0], [0, 0]]
    const q = new THREE.Vector3(), w = new THREE.Vector3()
    const touched = []
    if (op === 'replace') for (const p of parts.values()) if (p.sel) p.sel.fill(0)
    const toView = new THREE.Vector3()
    const visible = (world, ndc) => {
      if (!depth) return true
      const px = Math.min(depth.w - 1, Math.max(0, Math.floor((ndc.x + 1) / 2 * depth.w)))
      const py = Math.min(depth.h - 1, Math.max(0, Math.floor((ndc.y + 1) / 2 * depth.h)))
      // compare depth along the view direction (what the depth buffer stores), not straight-line distance
      const dist = -toView.copy(world).applyMatrix4(camera.matrixWorldInverse).z
      return dist <= viewDist(depthAt(depth, px, py)) + Math.max(0.6, dist * 0.004)
    }
    for (const p of parts.values()) {
      if (!p.mesh || !p.wrap.visible) continue
      const m = mask(p), nr = normalsOf(p), pos = p.mesh.geometry.attributes.position.array
      const mw = p.mesh.matrixWorld
      nm.getNormalMatrix(mw)
      let hit = false
      for (let t = 0; t < p.facts.tri; t++) {
        const o = t * 9
        for (let k = 0; k < 3; k++) P[k].set(pos[o + k * 3], pos[o + k * 3 + 1], pos[o + k * 3 + 2]).applyMatrix4(mw)
        if (depth && !section.on) {   // with a section box, inner (back) faces are visible and selectable
          nrm.set(nr[t * 3], nr[t * 3 + 1], nr[t * 3 + 2]).applyMatrix3(nm)
          if (nrm.dot(q.copy(camPos).sub(P[0])) <= 0) continue                      // facing away
        }
        let ok = false
        for (const [a, b, c] of W) {                                                 // sample points
          w.set(0, 0, 0).addScaledVector(P[0], a).addScaledVector(P[1], b).addScaledVector(P[2], c)
          if (!insideSection(w)) continue
          q.copy(w).project(camera)
          if (q.z > 1 || q.z < -1) continue
          if (inside((q.x + 1) / 2 * rect.width, (1 - q.y) / 2 * rect.height) && visible(w, q)) { ok = true; break }
        }
        if (!ok && centre) {                                                         // shape inside a big triangle
          for (let k = 0; k < 3; k++) { q.copy(P[k]).project(camera); S[k][0] = (q.x + 1) / 2 * rect.width; S[k][1] = (1 - q.y) / 2 * rect.height }
          const [cx, cy] = centre
          const d = (S[1][1] - S[2][1]) * (S[0][0] - S[2][0]) + (S[2][0] - S[1][0]) * (S[0][1] - S[2][1])
          if (Math.abs(d) > 1e-9) {
            const l1 = ((S[1][1] - S[2][1]) * (cx - S[2][0]) + (S[2][0] - S[1][0]) * (cy - S[2][1])) / d
            const l2 = ((S[2][1] - S[0][1]) * (cx - S[2][0]) + (S[0][0] - S[2][0]) * (cy - S[2][1])) / d
            if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) {
              w.set(0, 0, 0).addScaledVector(P[0], l1).addScaledVector(P[1], l2).addScaledVector(P[2], 1 - l1 - l2)
              ok = visible(w, q.copy(w).project(camera))
            }
          }
        }
        if (!ok) continue
        m[t] = op === 'subtract' ? 0 : 1
        hit = true
      }
      if (hit || op === 'replace') touched.push(p)
    }
    selectionChanged(op === 'replace' ? [...parts.values()] : touched)
  }
  function selectFace(hit, op) {
    const p = parts.get(hit.object.userData.partId)
    if (!p) return
    if (op === 'replace') for (const q of parts.values()) if (q.sel) q.sel.fill(0)
    const m = mask(p), adj = adjacency(p), pos = p.mesh.geometry.attributes.position.array
    const cos = Math.cos(THREE.MathUtils.degToRad(area.angle))
    const n0 = new THREE.Vector3(), n1 = new THREE.Vector3()
    const seen = new Uint8Array(p.facts.tri), stack = [hit.faceIndex]
    seen[hit.faceIndex] = 1
    while (stack.length) {
      const t = stack.pop()
      m[t] = op === 'subtract' ? 0 : 1
      faceNormal(pos, t, n0)
      for (let e = 0; e < 3; e++) {
        const q = adj[t * 3 + e]
        if (q < 0 || seen[q] || faceNormal(pos, q, n1).dot(n0) < cos) continue
        seen[q] = 1; stack.push(q)
      }
    }
    selectionChanged(op === 'replace' ? [...parts.values()] : [p])
  }
  function brushSelect(hit, op) {
    const p = parts.get(hit.object.userData.partId)
    if (!p) return
    const local = hit.object.worldToLocal(hit.point.clone())
    const m = mask(p), c = centroids(p), r2 = area.size * area.size
    const steps = selStroke?.part === p.def.id ? Math.min(60, Math.floor(selStroke.local.distanceTo(local) / (area.size * 0.5))) : 0
    const centres = [local, ...Array.from({ length: steps }, (_, i) => selStroke.local.clone().lerp(local, (i + 1) / (steps + 1)))]
    for (const q of centres) {
      for (let t = 0; t < p.facts.tri; t++) {
        const dx = c[t * 3] - q.x, dy = c[t * 3 + 1] - q.y, dz = c[t * 3 + 2] - q.z
        if (dx * dx + dy * dy + dz * dz <= r2) m[t] = op === 'subtract' ? 0 : 1
      }
    }
    selStroke = { part: p.def.id, local }
    drawSelection(p)
  }

  // facts about the selection, per part, in each part's file coordinates (mm)
  function selectionSummary() {
    const out = []
    const AXES = [['+X (right)', 0, 1], ['−X (left)', 0, -1], ['+Y (back)', 1, 1], ['−Y (front)', 1, -1], ['+Z (top)', 2, 1], ['−Z (bottom)', 2, -1]]
    for (const p of parts.values()) {
      if (!p.mesh || !p.sel) continue
      const pos = p.mesh.geometry.attributes.position.array
      let n = 0, surf = 0
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], cen = [0, 0, 0], nrm = [0, 0, 0]
      for (let t = 0; t < p.facts.tri; t++) {
        if (!p.sel[t]) continue
        const o = t * 9
        const ax = pos[o + 3] - pos[o], ay = pos[o + 4] - pos[o + 1], az = pos[o + 5] - pos[o + 2]
        const bx = pos[o + 6] - pos[o], by = pos[o + 7] - pos[o + 1], bz = pos[o + 8] - pos[o + 2]
        const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx
        const a = Math.hypot(cx, cy, cz) / 2
        n++; surf += a
        nrm[0] += cx / 2; nrm[1] += cy / 2; nrm[2] += cz / 2
        for (let k = 0; k < 3; k++) {
          cen[k] += a * (pos[o + k] + pos[o + 3 + k] + pos[o + 6 + k]) / 3
          for (let v = 0; v < 3; v++) { mn[k] = Math.min(mn[k], pos[o + v * 3 + k]); mx[k] = Math.max(mx[k], pos[o + v * 3 + k]) }
        }
      }
      if (!n) continue
      const len = Math.hypot(...nrm)
      const dir = len / Math.max(surf, 1e-9)           // 1 = all facing one way, ~0 = mixed
      const unit = nrm.map(x => x / (len || 1))
      const best = AXES.reduce((b, ax) => (unit[ax[1]] * ax[2] > unit[b[1]] * b[2] ? ax : b))
      out.push({
        part: p.def.id, name: p.def.name, triangles: n, area: surf,
        min: mn, max: mx, size: mx.map((v, k) => v - mn[k]),
        centre: cen.map(v => v / (surf || 1)), normal: unit,
        facing: dir > 0.5 ? best[0] : 'several directions',
      })
    }
    return out
  }

  // ---------------------------------------------------------------- picking
  const raycaster = new THREE.Raycaster()
  let down = null, painting = false, dirty = false
  function hitAt(e) {
    const rect = renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(ndc, camera)
    const meshes = [...parts.values()].filter(p => p.mesh && p.wrap.visible).map(p => p.mesh)
    // with a section box, the first hit that is not cut away (so you can pick inside the model)
    const hit = raycaster.intersectObjects(meshes, false).find(h => insideSection(h.point))
    return { hit, screen: { x: e.clientX - rect.left, y: e.clientY - rect.top } }
  }
  const strokes = () => tool === 'paint' && (brush.mode === 'brush' || brush.mode === 'erase')
  const selOp = e => (e.altKey ? 'subtract' : e.shiftKey ? 'add' : 'replace')
  const localXY = e => { const r = renderer.domElement.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] }
  renderer.domElement.addEventListener('pointerdown', e => {
    down = { x: e.clientX, y: e.clientY }
    if (strokes() && e.button === 0) {
      const { hit } = hitAt(e)
      if (hit) { painting = true; controls.enabled = false; paintHit(hit); dirty = true }
    }
    if (tool === 'area' && e.button === 0) {
      if (area.mode === 'box' || area.mode === 'lasso') {
        const el = document.createElement('div')
        el.className = area.mode === 'box' ? 'sel-box' : 'sel-lasso'
        el.innerHTML = area.mode === 'lasso' ? '<svg><polyline/></svg>' : ''
        overlay.append(el)
        dragSel = { op: selOp(e), points: [localXY(e)], el }
      } else if (area.mode === 'brush') {
        const { hit } = hitAt(e)
        selStroke = null
        if (hit) { painting = true; controls.enabled = false; brushSelect(hit, e.altKey ? 'subtract' : 'add'); dirty = 'sel' }
      }
    }
  })
  renderer.domElement.addEventListener('pointermove', e => {
    if (dragSel) {
      dragSel.points.push(localXY(e))
      const [x0, y0] = dragSel.points[0], [x1, y1] = dragSel.points[dragSel.points.length - 1]
      if (area.mode === 'box') Object.assign(dragSel.el.style, { left: `${Math.min(x0, x1)}px`, top: `${Math.min(y0, y1)}px`,
        width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` })
      else dragSel.el.querySelector('polyline').setAttribute('points', dragSel.points.map(p => p.join(',')).join(' '))
      return
    }
    if (!painting) return
    const { hit } = hitAt(e)
    if (!hit) return
    if (tool === 'area') brushSelect(hit, e.altKey ? 'subtract' : 'add')
    else paintHit(hit)
  })
  window.addEventListener('pointerup', e => {
    lastStroke = null; selStroke = null
    if (dragSel) dragSel.points.push(localXY(e))     // the release point always counts
    if (painting) { painting = false; controls.enabled = true }
    if (dirty === 'sel') { dirty = false; hooks.onSelection?.(selectionSummary()) }
    else if (dirty) { dirty = false; hooks.onPaintChanged?.() }
    if (dragSel) {
      const { points, op, el } = dragSel
      dragSel = null
      el.remove()
      const [x0, y0] = points[0], [x1, y1] = points[points.length - 1]
      if (Math.hypot(x1 - x0, y1 - y0) < 5 && points.length < 4) { if (op === 'replace') clearAll(); return }
      if (area.mode === 'box') {
        const [l, r, t, b] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)]
        selectInShape((x, y) => x >= l && x <= r && y >= t && y <= b, op, [(l + r) / 2, (t + b) / 2])
      } else {
        const cx = points.reduce((s, p) => s + p[0], 0) / points.length, cy = points.reduce((s, p) => s + p[1], 0) / points.length
        selectInShape((x, y) => {        // point in polygon
          let c = false
          for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
            const [xi, yi] = points[i], [xj, yj] = points[j]
            if ((yi > y) !== (yj > y) && x < xi + (y - yi) * (xj - xi) / (yj - yi)) c = !c
          }
          return c
        }, op, [cx, cy])
      }
    }
  })
  renderer.domElement.addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
    if (strokes()) return
    if (tool === 'area') {
      if (area.mode !== 'face') return
      const { hit } = hitAt(e)
      if (hit) selectFace(hit, selOp(e))
      else if (selOp(e) === 'replace') clearAll()
      return
    }
    const { hit, screen } = hitAt(e)
    if (!hit) { if (tool === 'select') hooks.onSelect?.(null); return }
    const partId = hit.object.userData.partId
    const local = hit.object.worldToLocal(hit.point.clone())
    const normal = hit.face?.normal?.clone() ?? new THREE.Vector3(0, 0, 1)
    if (tool === 'select') hooks.onSelect?.(partId)
    else if (tool === 'comment') hooks.onPick?.({ part: partId, point: local.toArray(), normal: normal.toArray(), screen })
    else if (tool === 'paint') { paintHit(hit); hooks.onPaintChanged?.() }
    else if (tool === 'measure') {
      const pt = { part: partId, local: local.toArray() }
      if (!measure || measure.b) measure = { a: pt }
      else { measure.b = pt; hooks.onMeasure?.(measurement()) }
    }
  })

  function assemblyPoint(pt) {
    const p = parts.get(pt.part)
    return p ? new THREE.Vector3(...pt.local).applyMatrix4(p.holder.matrix) : null
  }
  function worldPoint(partId, local) {
    const p = parts.get(partId)
    if (!p?.mesh || !p.wrap.visible) return null
    return p.mesh.localToWorld(new THREE.Vector3(...local))
  }
  function measurement() {
    if (!measure?.a || !measure?.b) return null
    const A = assemblyPoint(measure.a), B = assemblyPoint(measure.b)
    if (!A || !B) return null
    const d = B.clone().sub(A)
    return { a: { part: measure.a.part, point: measure.a.local }, b: { part: measure.b.part, point: measure.b.local },
      distance: d.length(), dx: Math.abs(d.x), dy: Math.abs(d.y), dz: Math.abs(d.z) }
  }

  // ---------------------------------------------------------------- overlay (pins, measure)
  const els = new Map()
  function overlayEl(key, cls, html) {
    let el = els.get(key)
    if (!el) { el = document.createElement('div'); overlay.append(el); els.set(key, el) }
    el.className = cls
    if (html !== undefined && el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html }
    return el
  }
  const toScreen = v => {
    const p = v.clone().project(camera)
    const rect = renderer.domElement.getBoundingClientRect()
    return { x: (p.x + 1) / 2 * rect.width, y: (1 - p.y) / 2 * rect.height, behind: p.z > 1 }
  }
  let measureLine = null
  function updateOverlay() {
    const seen = new Set()
    for (const c of comments) {
      if (c.view === 'blueprint') continue
      const w = worldPoint(c.part, c.point)
      if (!w) continue
      const s = toScreen(w)
      const el = overlayEl(`c${c.n}`, `pin ${c.status === 'resolved' ? 'resolved' : ''} ${focused === c.n ? 'on' : ''}`, String(c.n))
      el.style.left = `${s.x}px`; el.style.top = `${s.y}px`; el.style.display = s.behind ? 'none' : ''
      el.onclick = () => hooks.onPinClick?.(c.n)
      seen.add(`c${c.n}`)
    }
    if (measureLine) { markGroup.remove(measureLine); measureLine.geometry.dispose(); measureLine = null }
    if (measure?.a) {
      const A = worldPoint(measure.a.part, measure.a.local)
      const B = measure.b ? worldPoint(measure.b.part, measure.b.local) : null
      if (A && B) {
        measureLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([A, B]),
          new THREE.LineBasicMaterial({ color: 0xff6a2a, depthTest: false }))
        measureLine.renderOrder = 10
        markGroup.add(measureLine)
        const m = measurement()
        const s = toScreen(A.clone().add(B).multiplyScalar(0.5))
        const el = overlayEl('measure', 'measure-label', m ? hooks.measureHtml?.(m) ?? '' : '')
        el.style.left = `${s.x}px`; el.style.top = `${s.y}px`
        seen.add('measure')
      }
      for (const [k, P] of [['ma', A], ['mb', B]]) {
        if (!P) continue
        const s = toScreen(P)
        const el = overlayEl(k, 'pin', k === 'ma' ? 'A' : 'B')
        el.style.left = `${s.x}px`; el.style.top = `${s.y}px`
        seen.add(k)
      }
    }
    for (const [k, el] of els) if (!seen.has(k)) { el.remove(); els.delete(k) }
  }

  function updateRegion() {
    if (region) { region.parent?.remove(region); region.geometry.dispose(); region = null }
    const c = comments.find(x => x.n === focused && x.view !== 'blueprint')
    const p = c && parts.get(c.part)
    if (!p?.mesh) return
    region = new THREE.Mesh(new THREE.SphereGeometry(c.radius || 5, 32, 16),
      new THREE.MeshBasicMaterial({ color: 0xff6a2a, transparent: true, opacity: 0.28, depthWrite: false }))
    region.position.set(...c.point)
    p.mesh.add(region)
  }

  function resize() {
    const { clientWidth: w, clientHeight: h } = container
    if (!w || !h) return
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  new ResizeObserver(resize).observe(container)
  resize()
  renderer.setAnimationLoop(() => {
    controls.update()
    renderer.render(scene, camera)
    if (container.offsetParent) updateOverlay()
    else if (els.size) { for (const el of els.values()) el.remove(); els.clear() }
  })

  // ---------------------------------------------------------------- paint data in / out
  function encode(u8) {
    let s = ''
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
    return btoa(s)
  }
  function paintSummary(p) {
    if (!p?.paint) return null
    const c = centroids(p)
    const groups = new Map()
    for (let t = 0; t < p.facts.tri; t++) {
      const idx = p.paint[t]
      if (!idx) continue
      let g = groups.get(idx)
      if (!g) groups.set(idx, g = { n: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] })
      g.n++
      for (let k = 0; k < 3; k++) { g.min[k] = Math.min(g.min[k], c[t * 3 + k]); g.max[k] = Math.max(g.max[k], c[t * 3 + k]) }
    }
    return {
      base: p.color, finish: p.finish,
      regions: [...groups].map(([idx, g]) => ({ color: palette[idx - 1], share: g.n / p.facts.tri, min: g.min, max: g.max })),
    }
  }

  return {
    // turn the camera around the model (degrees) and/or move closer (factor < 1); used by demos and recordings
    orbit(deg = 0, zoom = 1) {
      const off = camera.position.clone().sub(controls.target)
      off.applyAxisAngle(new THREE.Vector3(0, 1, 0), deg * Math.PI / 180).multiplyScalar(zoom)
      camera.position.copy(controls.target).add(off)
      controls.update()
    },
    async setProject(data, { refit = true } = {}) {
      bedSize = data.bed || bedSize
      buildBed()
      const pd = data.paint || {}
      palette = Array.isArray(pd.palette) ? pd.palette.slice(0, 254) : []
      saved = pd.parts || {}
      for (const p of parts.values()) partsGroup.remove(p.wrap)
      const old = new Map(parts)
      parts.clear()
      for (const def of data.parts) {
        const prev = old.get(def.id)
        const wrap = new THREE.Group(), holder = new THREE.Group()
        holder.matrixAutoUpdate = false
        wrap.add(holder)
        partsGroup.add(wrap)
        const sp = saved[def.id] || {}
        const p = { def, wrap, holder, mesh: null, facts: null, color: sp.color || def.color, finish: sp.finish || def.finish || 'matte',
          visible: prev?.visible ?? true, paint: null }
        wrap.visible = p.visible
        parts.set(def.id, p)
      }
      await Promise.all([...parts.values()].map(p => loadPart(p)))
      applyLayout(); updateRegion()
      if (refit) fit()
    },
    async reloadPath(path) {
      const hit = [...parts.values()].filter(p => p.def.path === path)
      if (!hit.length) return false
      for (const p of hit) if (p.paint) saved[p.def.id] = { tri: p.facts.tri, paint: encode(p.paint) }
      await Promise.all(hit.map(p => loadPart(p)))
      applyLayout(); updateRegion()
      return true
    },
    paintData() {
      const out = { palette: [...palette], parts: {} }
      for (const p of parts.values()) {
        const entry = { color: p.color, finish: p.finish }
        if (p.paint?.some(v => v)) { entry.tri = p.facts.tri; entry.paint = encode(p.paint) }
        out.parts[p.def.id] = entry
      }
      return out
    },
    paintSummary: id => paintSummary(parts.get(id)),
    // per-triangle colours from outside (e.g. AI texture -> filament colours); idx[t] indexes hexes, -1 = base
    setPaintIndices(id, hexes, idx) {
      const p = parts.get(id)
      if (!p?.paint || idx.length !== p.facts.tri) return false
      const map = hexes.map(h => paletteIndex(h))
      for (let t = 0; t < idx.length; t++) p.paint[t] = idx[t] < 0 ? 0 : map[idx[t]]
      recolor(p)
      return true
    },
    setBrush(opts) { Object.assign(brush, opts) },
    clearPaint(id) { const p = parts.get(id); if (p?.paint) { p.paint.fill(0); recolor(p) } },
    setFinish(id, finish) { const p = parts.get(id); if (p) { p.finish = finish; p.mesh && (p.mesh.material = material(p)) } },
    setLayout(v) { layout = v; applyLayout(); fit() },
    setExplode(v) { explode = section.on ? 0 : v; applyExplode() },
    // section / crop box ---------------------------------------------------------
    assemblyBounds() { const b = assemblyBounds(); return b.isEmpty() ? null : { min: b.min.toArray(), max: b.max.toArray() } },
    setSection(on, min, max) {
      section.on = !!on
      if (min) section.min.set(...min)
      if (max) section.max.set(...max)
      if (section.on && explode) { explode = 0; applyExplode() }     // crop works on the assembled positions
      updatePlanes()
    },
    // the selected area as a box in assembly coordinates (for "fit to selection")
    selectionAssemblyBox(margin = 3) {
      const box = new THREE.Box3()
      for (const s of selectionSummary()) {
        const p = parts.get(s.part)
        box.union(new THREE.Box3(new THREE.Vector3(...s.min), new THREE.Vector3(...s.max)).applyMatrix4(p.holder.matrix))
      }
      if (box.isEmpty()) return null
      box.expandByScalar(margin)
      return { min: box.min.toArray(), max: box.max.toArray() }
    },
    // parts the crop box touches, with their file -> assembly matrix (row-major, for OpenSCAD)
    cropParts() {
      const box = new THREE.Box3(section.min.clone(), section.max.clone())
      const rows = m => { const e = m.elements; return [0, 1, 2, 3].map(r => [0, 1, 2, 3].map(c => e[c * 4 + r])) }
      return [...parts.values()].filter(p => p.facts && p.wrap.visible && p.def.path && partBox(p).intersectsBox(box))
        .map(p => ({ id: p.def.id, matrix: rows(p.holder.matrix), inverse: rows(p.holder.matrix.clone().invert()) }))
    },
    setMode(v) { mode = v; restyle() },
    setTheme(isDark) {
      dark = !!isDark
      edgeMaterial.color.set(theme().line)
      buildBed()
      restyle()
    },
    setBedVisible(v) { bedGroup.visible = v },
    setTool(v) {
      tool = v
      if (v !== 'measure') measure = null
      controls.enabled = true
      // while selecting areas the left button selects; right-drag rotates, wheel zooms
      controls.mouseButtons = v === 'area'
        ? { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }
        : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
    },
    setArea(opts) { Object.assign(area, opts) },
    clearSelection: clearAll,
    selectionSummary,
    // a picture of the current view (selection highlighted), as a PNG data URL
    snapshot() { renderer.render(scene, camera); return renderer.domElement.toDataURL('image/png') },
    select(id) { selected = id; restyle() },
    setColor(id, color) { const p = parts.get(id); if (p) { p.color = color; recolor(p) } },
    setVisible(id, v) { const p = parts.get(id); if (p) { p.visible = v; p.wrap.visible = v; applyLayout() } },
    isolate(id) { for (const p of parts.values()) { p.visible = !id || p.def.id === id; p.wrap.visible = p.visible } applyLayout(); fit() },
    setComments(list) { comments = list; updateRegion() },
    focusComment(n) { focused = n; updateRegion() },
    clearMeasure() { measure = null },
    measurement,
    fit,
    part: id => parts.get(id),
    facts: id => parts.get(id)?.facts,
  }
}
