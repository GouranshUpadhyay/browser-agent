import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from './api'
import { newRun } from './agentRun'
import ExecutionGraph from './ExecutionGraph'
import { useNow, useRuns } from './hooks'
import { Turn } from './RunCards'

const EXAMPLES = [
  'Find 3 laptops under 60000 rupees on Flipkart',
  'Find the price of iPhone 16 on Flipkart',
  "Search Google for 'wireless mouse' and list the top 3 results",
]

const HISTORY = 20

export default function Chat({ onBackend }) {
  const [goal, setGoal] = useState('')
  const [sending, setSending] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const { runs, setRuns, follow, load } = useRuns({ onConnection: (ok) => onBackend(ok ? 'ready' : 'offline') })
  const threadRef = useRef(null)
  const stickRef = useRef(true)
  const inputRef = useRef(null)

  const latest = runs[runs.length - 1]
  const loading = sending || latest?.status === 'connecting' || latest?.status === 'running'
  const now = useNow(runs.some((r) => r.status === 'connecting' || r.status === 'running'))

  // Restore recent chat runs (and resume any still running) after a refresh
  useEffect(() => {
    let ignore = false
    api(`/runs?source=chat&limit=${HISTORY}`)
      .then((list) => Promise.all(list.map((r) => api(`/runs/${r.id}`))))
      .then((full) => {
        if (ignore) return
        full.reverse().forEach((r) => load(r, r.events))
      })
      .catch((err) => !ignore && setLoadError(err.message))
    return () => {
      ignore = true
    }
  }, [load])

  // Follow new activity, unless the user has scrolled up to read something
  useLayoutEffect(() => {
    const el = threadRef.current
    if (el && stickRef.current) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [runs])

  const onScroll = () => {
    const el = threadRef.current
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  const run = async () => {
    const text = goal.trim()
    if (text.length < 3 || loading) return
    setSending(true)
    stickRef.current = true
    try {
      const summary = await api('/runs', { method: 'POST', body: { goal: text } })
      setRuns((rs) => [...rs, newRun(text, { id: summary.id, createdAt: summary.created_at })])
      follow(summary.id)
      setGoal('')
      onBackend('ready')
    } catch (err) {
      setLoadError(err.message)
      onBackend('offline')
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  const stop = () => {
    if (latest?.id) api(`/runs/${latest.id}/cancel`, { method: 'POST' }).catch((err) => setLoadError(err.message))
  }

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      run()
    }
  }

  return (
    <>
      <main className="thread" ref={threadRef} onScroll={onScroll}>
        <div className="thread-inner">
          {loadError && (
            <div className="card error notice">
              <p>{loadError}</p>
              <button className="link" onClick={() => setLoadError(null)}>Dismiss</button>
            </div>
          )}
          {runs.length === 0 ? (
            <section className="hero">
              <h1>Browser <span>Agent</span></h1>
              <p>Tell it what you need. It opens a real browser, browses on its own, and brings back results with links.</p>
              <div className="chips">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    className="chip"
                    onClick={() => {
                      setGoal(ex)
                      inputRef.current?.focus()
                    }}
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </section>
          ) : (
            runs.map((r) => <Turn key={r.id} run={r} now={now} />)
          )}
        </div>
      </main>

      <div className="dock">
        <section className="composer card">
          <div className="composer-input">
            <textarea
              ref={inputRef}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={onKey}
              placeholder="e.g. Find 3 laptops under 60000 rupees on Flipkart"
              rows={2}
              disabled={loading}
              aria-label="Goal for the agent"
            />
            <div className="composer-row">
              <span className="hint">
                Enter to run · Shift+Enter for a new line · <a href="#/automations">Schedule it instead</a>
              </span>
              {loading ? (
                <button className="run stop" onClick={stop} disabled={!latest?.id}>Stop</button>
              ) : (
                <button className="run" onClick={run} disabled={goal.trim().length < 3}>Run agent</button>
              )}
            </div>
          </div>
          <ExecutionGraph run={latest} now={now} />
        </section>
        <footer>Results come straight from the pages the agent visited. Always open the link to confirm important details.</footer>
      </div>
    </>
  )
}
