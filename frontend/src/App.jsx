import { useEffect, useRef, useState } from 'react'
import './App.css'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

const EXAMPLES = [
  'Find 3 laptops under 60000 rupees on Flipkart',
  'Find the price of iPhone 16 on Flipkart',
  "Search Google for 'wireless mouse' and list the top 3 results",
]

const PROGRESS = [
  'Opening a real browser…',
  'Reading the page…',
  'Deciding the next click…',
  'Collecting details…',
  'Double-checking what it found…',
]

export default function App() {
  const [goal, setGoal] = useState('')
  const [loading, setLoading] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [data, setData] = useState(null)
  const [backend, setBackend] = useState('checking')
  const timer = useRef(null)

  useEffect(() => {
    fetch(`${API}/health`)
      .then((r) => r.json())
      .then((h) => setBackend(h.api_key_loaded ? 'ready' : 'nokey'))
      .catch(() => setBackend('offline'))
  }, [])

  useEffect(() => () => clearInterval(timer.current), [])

  const run = async () => {
    if (goal.trim().length < 3 || loading) return
    setLoading(true)
    setData(null)
    setElapsed(0)
    timer.current = setInterval(() => setElapsed((s) => s + 1), 1000)
    try {
      const res = await fetch(`${API}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal }),
      })
      if (!res.ok) throw new Error(`Server returned ${res.status}`)
      setData(await res.json())
      setBackend('ready')
    } catch (err) {
      setBackend('offline')
      setData({
        success: false,
        error: `Could not reach the backend (${err.message}). Is it running on ${API}?`,
        items: [],
        sources: [],
      })
    } finally {
      clearInterval(timer.current)
      setLoading(false)
    }
  }

  const onKey = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run()
  }

  const badge = {
    checking: ['', 'Checking backend…'],
    ready: ['ok', 'Backend ready'],
    nokey: ['warn', 'Backend running · API key missing'],
    offline: ['bad', 'Backend offline'],
  }[backend]

  return (
    <div className="page">
      <header className="hero">
        <span className={`pill ${badge[0]}`}><i /> {badge[1]}</span>
        <h1>Browser <span>Agent</span></h1>
        <p>Tell it what you need. It opens a real browser, browses on its own, and brings back results with links.</p>
      </header>

      <section className="card input-card">
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={onKey}
          placeholder="e.g. Find 3 laptops under 60000 rupees on Flipkart"
          rows={3}
          disabled={loading}
        />
        <div className="row">
          <div className="chips">
            {EXAMPLES.map((ex) => (
              <button key={ex} className="chip" onClick={() => setGoal(ex)} disabled={loading}>
                {ex}
              </button>
            ))}
          </div>
          <button className="run" onClick={run} disabled={loading || goal.trim().length < 3}>
            {loading ? 'Working…' : 'Run agent'}
          </button>
        </div>
      </section>

      {loading && (
        <section className="card loading">
          <div className="spinner" />
          <div>
            <strong>{PROGRESS[Math.floor(elapsed / 6) % PROGRESS.length]}</strong>
            <p>{elapsed}s elapsed · a browser window will open on the server — this usually takes 1–3 minutes.</p>
          </div>
        </section>
      )}

      {data && !loading && (data.success ? <Results data={data} /> : <ErrorCard message={data.error} />)}

      <footer>Results come straight from the pages the agent visited. Always open the link to confirm important details.</footer>
    </div>
  )
}

function Results({ data }) {
  return (
    <section className="results">
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

function ErrorCard({ message }) {
  return (
    <section className="card error">
      <h2>That didn't work</h2>
      <p>{message}</p>
    </section>
  )
}
