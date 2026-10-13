import { useCallback, useEffect, useRef, useState } from 'react'
import { api, followRun } from './api'
import { applyEvent, runFromEvents } from './agentRun'

const isLive = (run) => run && (run.status === 'connecting' || run.status === 'running')

// Wall-clock time that ticks every second while `active`, for elapsed counters.
export function useNow(active) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

// A list of runs kept in sync with the server: load from history, follow the live ones.
export function useRuns({ onConnection } = {}) {
  const [runs, setRuns] = useState([]) // chronological
  const controllers = useRef(new Map())
  const connRef = useRef(onConnection)
  connRef.current = onConnection

  const patch = useCallback((id, fn) => {
    setRuns((rs) => rs.map((r) => (r.id === id ? fn(r) : r)))
  }, [])

  const follow = useCallback(
    (id, after = 0) => {
      if (controllers.current.has(id)) return
      const controller = new AbortController()
      controllers.current.set(id, controller)
      followRun(id, {
        after,
        signal: controller.signal,
        onEvent: (ev) => patch(id, (r) => applyEvent(r, ev)),
        onConnection: (ok) => connRef.current?.(ok),
      })
        .catch((err) => console.error(`Following run ${id} failed`, err))
        .finally(() => {
          if (controllers.current.get(id) === controller) controllers.current.delete(id)
        })
    },
    [patch],
  )

  // Adds a run from its server summary + stored events, and follows it if still going.
  const load = useCallback(
    (summary, events) => {
      const run = runFromEvents(summary, events)
      setRuns((rs) => (rs.some((r) => r.id === run.id) ? rs : [...rs, run].sort((a, b) => a.id - b.id)))
      if (isLive(run)) follow(run.id, events.length ? events[events.length - 1].id : 0)
      return run
    },
    [follow],
  )

  const loadById = useCallback(
    async (id) => {
      const full = await api(`/runs/${id}`)
      return load(full, full.events)
    },
    [load],
  )

  useEffect(() => {
    const map = controllers.current
    return () => {
      map.forEach((c) => c.abort())
      map.clear()
    }
  }, [])

  return { runs, setRuns, follow, load, loadById }
}
