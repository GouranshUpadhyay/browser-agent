import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import './App.css'
import ActivityTimeline from './ActivityTimeline'
import ExecutionGraph from './ExecutionGraph'
import { applyEvent, finish, newRun, streamRun } from './agentRun'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

const EXAMPLES = [
  'Find 3 laptops under 60000 rupees on Flipkart',
  'Find the price of iPhone 16 on Flipkart',
  "Search Google for 'wireless mouse' and list the top 3 results",
]

export default function App() {
  const [goal, setGoal] = useState('')
  const [turns, setTurns] = useState([]) // [{ id, run }]
  const [backend, setBackend] = useState('checking')
  const [now, setNow] = useState(Date.now())
  const abortRef = useRef(null)
  const threadRef = useRef(null)
  const stickRef = useRef(true)
  const inputRef = useRef(null)
  const nextId = useRef(1)

  const latest = turns[turns.length - 1]?.run
  const loading = latest?.status === 'connecting' || latest?.status === 'running'

  useEffect(() => {
    fetch(`${API}/health`)
      .then((r) => r.json())
      .then((h) => setBackend(h.api_key_loaded ? 'ready' : 'nokey'))
      .catch(() => setBackend('offline'))
  }, [])

  // Real wall-clock time for the elapsed counters while a run is live
  useEffect(() => {
    if (!loading) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [loading])

  useEffect(() => () => abortRef.current?.abort(), [])

  // Follow new activity, unless the user has scrolled up to read something
  useLayoutEffect(() => {
    const el = threadRef.current
    if (el && stickRef.current) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [turns])

  const onScroll = () => {
    const el = threadRef.current
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  const updateRun = useCallback((id, fn) => {
    setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, run: fn(t.run) } : t)))
  }, [])

  const run = async () => {
    const text = goal.trim()
    if (text.length < 3 || loading) return
    const id = nextId.current++
    const controller = new AbortController()
    abortRef.current = controller
    stickRef.current = true
    setNow(Date.now())
    setTurns((ts) => [...ts, { id, run: newRun(text) }])
    setGoal('')

    try {
      await streamRun(API, text, {
        signal: controller.signal,
        onEvent: (ev) => updateRun(id, (r) => applyEvent(r, ev)),
      })
      setBackend('ready')
    } catch (err) {
      if (controller.signal.aborted) {
        updateRun(id, (r) => finish(r, 'stopped', { success: false, error: 'You stopped this run.', items: [], sources: [] }))
      } else {
        setBackend('offline')
        updateRun(id, (r) =>
          finish(r, 'failed', {
            success: false,
            error: `Could not reach the backend (${err.message}). Is it running on ${API}?`,
            items: [],
            sources: [],
          }),
        )
      }
    } finally {
      abortRef.current = null
      setNow(Date.now())
      inputRef.current?.focus()
    }
  }

  const stop = () => abortRef.current?.abort()

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      run()
    }
  }

  const badge = {
    checking: ['', 'Checking backend…'],
    ready: ['ok', 'Backend ready'],
    nokey: ['warn', 'Backend running · API key missing'],
    offline: ['bad', 'Backend offline'],
  }[backend]

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Browser <span>Agent</span>
        </div>
        <span className={`pill ${badge[0]}`}><i /> {badge[1]}</span>
      </header>

      <main className="thread" ref={threadRef} onScroll={onScroll}>
        <div className="thread-inner">
          {turns.length === 0 ? (
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
            turns.map(({ id, run: r }) => <Turn key={id} run={r} now={now} />)
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
              <span className="hint">Enter to run · Shift+Enter for a new line</span>
              {loading ? (
                <button className="run stop" onClick={stop}>Stop</button>
              ) : (
                <button className="run" onClick={run} disabled={goal.trim().length < 3}>Run agent</button>
              )}
            </div>
          </div>
          <ExecutionGraph run={latest} now={now} />
        </section>
        <footer>Results come straight from the pages the agent visited. Always open the link to confirm important details.</footer>
      </div>
    </div>
  )
}

function Turn({ run, now }) {
  const ended = run.result && run.status !== 'connecting' && run.status !== 'running'
  return (
    <article className="turn">
      <div className="bubble">{run.goal}</div>
      <ActivityTimeline run={run} now={now} />
      {ended && (run.result.success ? <Results data={run.result} /> : <ErrorCard message={run.result.error} stopped={run.status === 'stopped'} />)}
    </article>
  )
}

function Results({ data }) {
  return (
    <section className="results">
      {data.verified === false && (
        <div className="card warning">
          <h2>Could not verify these results</h2>
          <p>
            {data.warning ||
              "The agent's own check found that some of these details may not match the pages it visited."}{' '}
            Open the links to confirm, or run the goal again.
          </p>
        </div>
      )}

      {data.summary && (
        <div className="card summary">
          <h2>Answer</h2>
          <p>{data.summary}</p>
        </div>
      )}

      {data.items.length > 0 && (
        <div className="grid">
          {data.items.map((it, i) => (
            <article className="card item" key={i}>
              <div className="rank">{i + 1}</div>
              <h3>{it.title}</h3>
              {it.price && <div className="price">{it.price}</div>}
              {it.details && <p className="details">{it.details}</p>}
              <div className="item-foot">
                {it.source && <span className="source">{it.source}</span>}
                {it.url && (
                  <a className="open" href={it.url} target="_blank" rel="noreferrer">
                    Open link ↗
                  </a>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {data.sources.length > 0 && (
        <div className="card sources">
          <h2>Pages the agent visited</h2>
          <ul>
            {data.sources.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noreferrer">
                  <b>{s.domain}</b>
                  <span>{s.url}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

function ErrorCard({ message, stopped }) {
  return (
    <section className={`card error ${stopped ? 'muted' : ''}`}>
      <h2>{stopped ? 'Stopped' : "That didn't work"}</h2>
      <p>{message}</p>
    </section>
  )
}
