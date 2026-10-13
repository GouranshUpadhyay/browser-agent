// Small client for the backend API.

export const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'
// Only needed if the backend sets API_TOKEN. Sent as a header, never in a URL.
const TOKEN = import.meta.env.VITE_API_TOKEN || ''

const headers = (extra = {}) => ({
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
  ...extra,
})

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  let res
  try {
    const init = { method, headers: headers(), signal }
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    res = await fetch(`${API}${path}`, init)
  } catch (err) {
    if (err.name === 'AbortError') throw err
    throw new ApiError(`Could not reach the backend at ${API}. Is it running?`, 0)
  }
  if (res.status === 204) return null
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const detail = Array.isArray(data?.detail) ? data.detail.map((d) => d.msg).join('; ') : data?.detail
    throw new ApiError(detail || `Server returned ${res.status}`, res.status)
  }
  return data
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })

// Follows a run's live events until its "result". If the connection drops (network blip,
// backend restart) it reconnects with Last-Event-ID, so no event is lost or repeated.
export async function followRun(runId, { after = 0, signal, onEvent, onConnection }) {
  let lastId = after
  let failures = 0
  while (!signal?.aborted) {
    try {
      const res = await fetch(`${API}/runs/${runId}/events`, {
        headers: headers(lastId ? { 'Last-Event-ID': String(lastId) } : {}),
        signal,
      })
      if (res.status === 404 || res.status === 401) throw new ApiError(`Server returned ${res.status}`, res.status)
      if (!res.ok || !res.body) throw new Error(`Server returned ${res.status}`)
      onConnection?.(true)
      failures = 0

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += value.replace(/\r\n/g, '\n')
        let cut
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          let id = null
          const data = []
          for (const line of block.split('\n')) {
            if (line.startsWith('id:')) id = Number(line.slice(3).trim())
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
          }
          if (!data.length) continue
          if (id) lastId = id
          const event = JSON.parse(data.join('\n'))
          onEvent(event)
          if (event.type === 'result') return
        }
      }
    } catch (err) {
      if (signal?.aborted || err.name === 'AbortError') return
      if (err instanceof ApiError) throw err
    }
    // Stream ended without a result, or the network failed: back off and resume.
    onConnection?.(false)
    failures += 1
    await sleep(Math.min(1000 * 2 ** (failures - 1), 10000), signal)
  }
}
