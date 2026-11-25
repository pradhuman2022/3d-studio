#!/usr/bin/env node
// A command-line `openscad` backed by the OpenSCAD WebAssembly build (openscad-wasm-prebuilt,
// GPL-2.0-or-later, installed separately as an optional npm dependency). It always runs as
// its own process, so the studio (MIT) only calls it, the same as a system OpenSCAD.
//
// Usage is the same as OpenSCAD's CLI, e.g.:
//   openscad -o out.stl --export-format binstl -D 'length=120' -D 'part="lid"' model.scad
// The .scad file's folder (and sub-folders) is mounted so `use <...>` / `include <...>` work.

import fs from 'node:fs'
import path from 'node:path'

let createOpenSCAD
try {
  ({ createOpenSCAD } = await import('openscad-wasm-prebuilt'))
} catch {
  console.error('OpenSCAD is not available: run `npm install` in 3d-studio (optional dependency openscad-wasm-prebuilt), ' +
    'or install OpenSCAD from https://openscad.org and put it on your PATH.')
  process.exit(127)
}

const args = process.argv.slice(2)
if (args.includes('--version') || args.includes('-v')) {
  console.error('OpenSCAD (WebAssembly build via openscad-wasm-prebuilt)')
  process.exit(0)
}

// find the input .scad and the outputs among the arguments
const takesValue = new Set(['-o', '-D', '-p', '-P', '--export-format', '--render', '--camera', '--imgsize', '--projection',
  '--colorscheme', '--view', '--backend', '--enable', '-d', '-m', '--csglimit', '--summary', '--summary-file'])
let input = null
const outputs = []
for (let i = 0; i < args.length; i++) {
  if (takesValue.has(args[i])) { if (args[i] === '-o') outputs.push(i + 1); i++; continue }
  if (!args[i].startsWith('-')) input = i
}
if (input === null) { console.error('openscad: no input .scad file given'); process.exit(1) }

const realInput = path.resolve(args[input])
const root = path.dirname(realInput)
const MOUNT = '/work'

const quiet = t => /Could not initialize localization/.test(t)
const openscad = await createOpenSCAD({ noInitialRun: true, print: t => console.log(t), printErr: t => { if (!quiet(t)) console.error(t) } })
const inst = openscad.getInstance()
const FS = inst.FS

// mount the model's folder: every .scad / data file up to 3 levels deep, small files only
function mkdirp(p) {
  let cur = ''
  for (const part of p.split('/').filter(Boolean)) { cur += `/${part}`; try { FS.mkdir(cur) } catch {} }
}
function mount(dir, vdir, depth) {
  mkdirp(vdir)
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const abs = path.join(dir, e.name)
    if (e.isDirectory() && depth > 0) mount(abs, `${vdir}/${e.name}`, depth - 1)
    else if (e.isFile() && /\.(scad|csv|json|dat|svg|dxf|stl)$/i.test(e.name) && fs.statSync(abs).size < 50e6)
      FS.writeFile(`${vdir}/${e.name}`, fs.readFileSync(abs))
  }
}
mount(root, MOUNT, 3)
mkdirp('/out')

const vargs = [...args]
vargs[input] = `${MOUNT}/${path.relative(root, realInput).split(path.sep).join('/')}`
const realOutputs = outputs.map(i => path.resolve(vargs[i]))
const virtualOutputs = realOutputs.map((p, k) => `/out/${k}-${path.basename(p)}`)
outputs.forEach((i, k) => { vargs[i] = virtualOutputs[k] })
if (!vargs.some(a => a.startsWith('--backend') || a.startsWith('--enable'))) vargs.unshift('--backend=manifold')

let code
try {
  code = inst.callMain(vargs)
} catch (err) {
  code = typeof err?.status === 'number' ? err.status : 1
  if (!err?.status) console.error(String(err?.message || err))
}
code = typeof code === 'number' ? code : 0
// an expected output that was not produced is a failure, whatever the exit status said
realOutputs.forEach((real, k) => {
  let data = null
  try { data = FS.readFile(virtualOutputs[k]) } catch {}
  if (!data || !data.length) {
    console.error(`openscad: no output produced for ${path.basename(real)}`)
    code = code || 1
    return
  }
  if (code === 0) {
    fs.mkdirSync(path.dirname(real), { recursive: true })
    fs.writeFileSync(real, data)
  }
})
process.exit(code)
