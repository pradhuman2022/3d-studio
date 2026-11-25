// AI mesh generation (Meshy-style features, our own implementation):
//   text -> reference image (FLUX.1-schnell) -> 3D (TRELLIS) -> print-ready STL
//   image(s) -> 3D (TRELLIS, up to 4 views) -> print-ready STL
// Models run on Hugging Face Spaces through the official Gradio client (optional dependency).
// A free Hugging Face token gives each user their own GPU quota; without one the shared
// anonymous quota is often used up. Providers are pluggable (see PROVIDERS).

import fs from 'node:fs'
import path from 'node:path'
import { glbTriangles, meshCheck, parseGLB, toPrintable, writeSTL } from './glb.mjs'

export const PROVIDERS = {
  textToImage: { space: process.env.STUDIO_T2I_SPACE || 'black-forest-labs/FLUX.1-schnell', model: 'FLUX.1-schnell (Apache-2.0)' },
  imageTo3D: { space: process.env.STUDIO_I23D_SPACE || 'trellis-community/TRELLIS', model: 'TRELLIS (MIT)' },
}
const DETAIL = { low: 0.98, medium: 0.95, high: 0.9 }     // TRELLIS mesh_simplify ratio (higher = fewer triangles)

let gradio = null
async function loadGradio() {
  if (!gradio) {
    try { gradio = await import('@gradio/client') } catch {
      throw new Error('AI generation needs the optional package @gradio/client: run `npm install` in 3d-studio.')
    }
  }
  return gradio
}

// ------------------------------------------------------------------ settings (token kept server-side only)
export function createSecrets(file) {
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} } }
  return {
    hfToken: () => process.env.HF_TOKEN || read().hfToken || null,
    hasToken: () => !!(process.env.HF_TOKEN || read().hfToken),
    tokenFromEnv: () => !!process.env.HF_TOKEN,
    setToken(token) {
      const data = read()
      if (token) data.hfToken = token; else delete data.hfToken
      fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 })
      fs.chmodSync(file, 0o600)
    },
  }
}

// ------------------------------------------------------------------ job queue
// One job runs at a time (free GPU quota); others wait in order. Each job reports progress
// through onEvent so the person sees every stage.
export function createGenerator({ secrets, onEvent, onDone }) {
  const jobs = new Map()
  const queue = []
  let running = null

  const publish = (job, patch) => {
    Object.assign(job, patch, { updated: Date.now() })
    onEvent(job.project, { kind: 'gen', job: view(job) })
  }
  const view = j => ({ id: j.id, status: j.status, stage: j.stage, detail: j.detail, error: j.error, prompt: j.prompt,
    mode: j.mode, size: j.size, created: j.created, result: j.result, queuePos: queue.indexOf(j) + 1 || 0 })

  async function connect(space) {
    const { Client } = await loadGradio()
    const token = secrets.hfToken()
    // ask for status events too: without them errors (e.g. quota) never reach us, only silence
    return Client.connect(space, { events: ['data', 'status'], ...(token ? { token } : {}) })
  }

  // run an endpoint with live status (queue position, progress) and a hard timeout
  async function call(job, client, endpoint, data, label, timeoutMs) {
    const sub = client.submit(endpoint, data)
    job.cancelHook = () => { try { sub.cancel?.() } catch {} }
    const timer = setTimeout(() => { job.timedOut = true; try { sub.cancel?.() } catch {} }, timeoutMs)
    try {
      for await (const msg of sub) {
        if (job.status === 'cancelled') throw new Error('cancelled')
        if (msg.type === 'status') {
          if (msg.stage === 'error') {
            const t = `${msg.title || ''}: ${msg.message || ''}`.replace(/^: |: $/g, '').trim()
            const wait = /Try again in ([\d:]*[1-9][\d:]*)/i.exec(t)?.[1]   // ignore "0:00:00"
            if (/quota/i.test(t)) throw new Error((secrets.hasToken()
              ? 'Your Hugging Face GPU quota is used up.'
              : 'The shared anonymous GPU quota is used up. Add your free Hugging Face token in ✨ Generate → AI settings to get your own quota.') +
              (wait ? ` It resets in ${wait}.` : ''))
            throw new Error(t || 'the model service reported an error')
          }
          const pos = msg.position != null ? ` · queue position ${msg.position + 1}` : ''
          const pct = msg.progress_data?.[0]
          const prog = pct && pct.length ? ` · ${pct.index ?? ''}/${pct.length}` : ''
          publish(job, { detail: `${label}${pos}${prog}` })
        }
        if (msg.type === 'data') return msg.data
      }
      throw new Error(job.timedOut ? `${label} took too long and was stopped` : `${label}: no result`)
    } finally {
      clearTimeout(timer)
      job.cancelHook = null
    }
  }

  async function download(url) {
    const headers = secrets.hfToken() ? { authorization: `Bearer ${secrets.hfToken()}` } : {}
    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`download failed (${res.status})`)
    return Buffer.from(await res.arrayBuffer())
  }

  async function run(job) {
    const { handle_file } = await loadGradio()
    fs.mkdirSync(job.dir, { recursive: true })
    let images = job.images
    // 1. text -> reference image
    if (job.mode === 'text') {
      publish(job, { status: 'running', stage: 'Reference image', detail: `Drawing a reference image with ${PROVIDERS.textToImage.model}` })
      const flux = await connect(PROVIDERS.textToImage.space)
      const prompt = `${job.prompt}. A single object, centered, whole object fully in view, plain white background, ` +
        'soft studio lighting, clean simple shapes, 3D render'
      const out = await call(job, flux, '/infer', { prompt, seed: job.seed, randomize_seed: false, width: 768, height: 768,
        num_inference_steps: 4 }, 'Reference image', 180000)
      const ref = await download(out[0].url)
      fs.writeFileSync(path.join(job.dir, 'reference.webp'), ref)
      images = [ref]
      publish(job, { result: { ...job.result, reference: `${job.rel}/reference.webp` } })
    }
    // 2. image(s) -> 3D
    publish(job, { status: 'running', stage: 'Building 3D', detail: `Building the 3D model with ${PROVIDERS.imageTo3D.model} (1-3 min)` })
    const trellis = await connect(PROVIDERS.imageTo3D.space)
    await trellis.predict('/start_session', {}).catch(() => {})
    const prepared = []
    for (const img of images) {
      const r = await call(job, trellis, '/preprocess_image', { image: handle_file(new Blob([img])) }, 'Removing the background', 180000)
      prepared.push(r[0])
    }
    const res = await call(job, trellis, '/generate_and_extract_glb', {
      image: prepared[0], multiimages: prepared.length > 1 ? prepared.map(image => ({ image, caption: null })) : [],
      seed: job.seed, ss_guidance_strength: 7.5, ss_sampling_steps: 12, slat_guidance_strength: 3, slat_sampling_steps: 12,
      multiimage_algo: 'stochastic', mesh_simplify: DETAIL[job.detailLevel] ?? 0.95, texture_size: 1024,
    }, 'Building 3D', 600000)
    const glbFile = res.find(x => x && typeof x === 'object' && /\.glb/i.test(x.url || x.path || ''))
    if (!glbFile) throw new Error('the 3D model service returned no GLB')
    const glb = await download(glbFile.url)
    fs.writeFileSync(path.join(job.dir, 'model.glb'), glb)
    // 3. print-ready STL: Z up, scaled to the requested size, on the bed
    publish(job, { stage: 'Making it printable', detail: `Converting to STL, ${job.size} mm` })
    const tri = toPrintable(glbTriangles(parseGLB(glb)), job.size)
    if (!tri.length) throw new Error('the generated model has no triangles')
    const check = meshCheck(tri)
    fs.writeFileSync(path.join(job.dir, 'model.stl'), writeSTL(tri))
    return { ...job.result, glb: `${job.rel}/model.glb`, stl: `${job.rel}/model.stl`, check }
  }

  async function pump() {
    if (running || !queue.length) return
    running = queue.shift()
    const job = running
    for (const j of queue) publish(j, {})                     // queue positions moved
    try {
      const result = await run(job)
      publish(job, { status: 'done', stage: 'Done', detail: '', result })
      await onDone(job)
    } catch (err) {
      if (job.status !== 'cancelled') publish(job, { status: 'failed', stage: 'Failed', error: String(err?.message || err) })
    } finally {
      running = null
      pump()
    }
  }

  return {
    submit(spec) {
      const job = { ...spec, status: 'queued', stage: 'Waiting', detail: 'Waiting for the previous job', created: Date.now(), result: {} }
      jobs.set(job.id, job)
      queue.push(job)
      publish(job, {})
      pump()
      return view(job)
    },
    cancel(id) {
      const job = jobs.get(id)
      if (!job || ['done', 'failed', 'cancelled'].includes(job.status)) return false
      const i = queue.indexOf(job)
      if (i >= 0) queue.splice(i, 1)
      publish(job, { status: 'cancelled', stage: 'Cancelled', detail: '' })
      job.cancelHook?.()
      return true
    },
    list: project => [...jobs.values()].filter(j => j.project === project).map(view),
  }
}
