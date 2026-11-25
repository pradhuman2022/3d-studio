// Minimal GLB (binary glTF 2.0) reader -> triangle soup, and STL writing. No dependencies.
// Used to turn AI-generated meshes into print-ready STL in millimetres, Z up.

const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

export function parseGLB(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB file')
  let offset = 12, json = null, bin = null
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32LE(offset), type = buf.readUInt32LE(offset + 4)
    const chunk = buf.subarray(offset + 8, offset + 8 + len)
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'))
    else if (type === 0x004e4942) bin = chunk
    offset += 8 + len
  }
  if (!json) throw new Error('GLB has no JSON chunk')
  return { json, bin }
}

function readAccessor({ json, bin }, index) {
  const acc = json.accessors[index]
  const view = json.bufferViews[acc.bufferView]
  const Type = COMPONENT[acc.componentType]
  const n = SIZE[acc.type]
  const stride = view.byteStride || Type.BYTES_PER_ELEMENT * n
  const base = (view.byteOffset || 0) + (acc.byteOffset || 0)
  const out = new Float64Array(acc.count * n)
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  const get = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[acc.componentType]
  for (let i = 0; i < acc.count; i++) {
    for (let k = 0; k < n; k++) out[i * n + k] = dv[get](base + i * stride + k * Type.BYTES_PER_ELEMENT, true)
  }
  return out
}

// 4x4 column-major helpers (glTF convention)
const ident = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
function mul(a, b) {
  const o = new Array(16).fill(0)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  return o
}
function trs(node) {
  if (node.matrix) return node.matrix.slice()
  const [tx, ty, tz] = node.translation || [0, 0, 0]
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1]
  const [sx, sy, sz] = node.scale || [1, 1, 1]
  return [
    (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ]
}

/**
 * All triangles of the default scene, in document order (depth-first, children in order,
 * primitives in order: the same order three.js GLTFLoader yields), world transforms applied.
 * Returns Float32Array, 9 numbers per triangle, in glTF axes (Y up, metres or whatever units).
 */
export function glbTriangles(glb) {
  const { json } = glb
  const out = []
  const scene = json.scenes?.[json.scene ?? 0]
  const roots = scene ? scene.nodes : (json.nodes || []).map((_, i) => i)
  const visit = (ni, parent) => {
    const node = json.nodes[ni]
    const m = mul(parent, trs(node))
    if (node.mesh !== undefined) {
      for (const prim of json.meshes[node.mesh].primitives) {
        if ((prim.mode ?? 4) !== 4 || prim.attributes.POSITION === undefined) continue
        const pos = readAccessor(glb, prim.attributes.POSITION)
        const idx = prim.indices !== undefined ? readAccessor(glb, prim.indices) : Float64Array.from({ length: pos.length / 3 }, (_, i) => i)
        for (let i = 0; i + 2 < idx.length; i += 3) {
          for (let k = 0; k < 3; k++) {
            const v = idx[i + k] * 3
            const x = pos[v], y = pos[v + 1], z = pos[v + 2]
            out.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14])
          }
        }
      }
    }
    for (const c of node.children || []) visit(c, m)
  }
  for (const r of roots) visit(r, ident())
  return Float32Array.from(out)
}

/**
 * glTF (Y up) -> printer (Z up), uniformly scaled so the largest dimension is `size` mm,
 * centred on X/Y and resting on Z = 0.
 */
export function toPrintable(tri, size) {
  const n = tri.length / 3
  const out = new Float32Array(tri.length)
  for (let i = 0; i < n; i++) { out[i * 3] = tri[i * 3]; out[i * 3 + 1] = -tri[i * 3 + 2]; out[i * 3 + 2] = tri[i * 3 + 1] }
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], out[i * 3 + k]); mx[k] = Math.max(mx[k], out[i * 3 + k]) }
  const span = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1
  const s = size / span
  const cx = (mn[0] + mx[0]) / 2, cy = (mn[1] + mx[1]) / 2
  for (let i = 0; i < n; i++) {
    out[i * 3] = (out[i * 3] - cx) * s
    out[i * 3 + 1] = (out[i * 3 + 1] - cy) * s
    out[i * 3 + 2] = (out[i * 3 + 2] - mn[2]) * s
  }
  return out
}

export function meshCheck(tri) {
  const count = tri.length / 9
  const ids = new Map(), edges = new Map()
  const id = i => {
    const k = `${Math.round(tri[i] * 1e3)},${Math.round(tri[i + 1] * 1e3)},${Math.round(tri[i + 2] * 1e3)}`
    let v = ids.get(k)
    if (v === undefined) { v = ids.size; ids.set(k, v) }
    return v
  }
  const S = 67108864
  let vol = 0
  for (let t = 0; t < count; t++) {
    const o = t * 9
    const a = id(o), b = id(o + 3), c = id(o + 6)
    for (const [p, q] of [[a, b], [b, c], [c, a]]) edges.set(p * S + q, (edges.get(p * S + q) || 0) + 1)
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = tri.subarray(o, o + 9)
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
  }
  let open = 0
  for (const [k, n] of edges) { const p = Math.floor(k / S), q = k % S; if ((edges.get(q * S + p) || 0) !== n) open++ }
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < tri.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], tri[i + k]); mx[k] = Math.max(mx[k], tri[i + k]) }
  return { triangles: count, closed: open === 0, openEdges: open, volume: Math.abs(vol) / 1000, size: mx.map((v, k) => v - mn[k]) }
}

export function writeSTL(tri) {
  const n = tri.length / 9
  const buf = Buffer.alloc(84 + 50 * n)
  buf.write('3D Studio AI mesh', 0)
  buf.writeUInt32LE(n, 80)
  for (let t = 0; t < n; t++) {
    const o = t * 9, at = 84 + 50 * t
    const ax = tri[o + 3] - tri[o], ay = tri[o + 4] - tri[o + 1], az = tri[o + 5] - tri[o + 2]
    const bx = tri[o + 6] - tri[o], by = tri[o + 7] - tri[o + 1], bz = tri[o + 8] - tri[o + 2]
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx
    const l = Math.hypot(nx, ny, nz) || 1
    buf.writeFloatLE(nx / l, at); buf.writeFloatLE(ny / l, at + 4); buf.writeFloatLE(nz / l, at + 8)
    for (let k = 0; k < 9; k++) buf.writeFloatLE(tri[o + k], at + 12 + k * 4)
  }
  return buf
}
