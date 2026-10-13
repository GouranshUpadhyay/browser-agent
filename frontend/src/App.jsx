import { useEffect, useState } from 'react'
import './App.css'
import { api } from './api'
import Automations from './Automations'
import Chat from './Chat'
import RunPage from './RunPage'

// Hash routes: #/ (chat), #/automations, #/runs/:id
function parseRoute(hash) {
  const path = hash.replace(/^#/, '') || '/'
  const run = path.match(/^\/runs\/(\d+)$/)
  if (run) return { name: 'run', runId: Number(run[1]) }
  if (path === '/automations') return { name: 'automations' }
  return { name: 'chat' }
}

export default function App() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash))
  const [health, setHealth] = useState(null)
  const [backend, setBackend] = useState('checking')

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Re-check health periodically (faster while offline) so the pill recovers on its own
  useEffect(() => {
    let timer
    let stopped = false
    const check = () =>
      api('/health')
        .then((h) => {
          setHealth(h)
          setBackend(h.api_key_loaded ? 'ready' : 'nokey')
          return 30000
        })
        .catch(() => {
          setBackend('offline')
          return 3000
        })
        .then((delay) => {
          if (!stopped) timer = setTimeout(check, delay)
        })
    check()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [])

  // A live stream reconnecting doesn't override a missing-key warning
  const onBackend = (state) => setBackend((b) => (b === 'nokey' && state === 'ready' ? b : state))

  const badge = {
    checking: ['', 'Checking backend…'],
    ready: ['ok', 'Backend ready'],
    nokey: ['warn', 'Backend running · API key missing'],
    offline: ['bad', 'Backend offline · reconnecting'],
  }[backend]

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Browser <span>Agent</span>
        </div>
        <nav className="tabs" aria-label="Sections">
          <a href="#/" className={route.name === 'chat' ? 'on' : ''} aria-current={route.name === 'chat' ? 'page' : undefined}>Chat</a>
          <a href="#/automations" className={route.name === 'automations' ? 'on' : ''} aria-current={route.name === 'automations' ? 'page' : undefined}>Automations</a>
        </nav>
        <span className={`pill ${badge[0]}`}><i /> <span className="pill-text">{badge[1]}</span></span>
      </header>

      {route.name === 'chat' && <Chat onBackend={onBackend} />}
      {route.name === 'automations' && <Automations health={health} />}
      {route.name === 'run' && <RunPage key={route.runId} runId={route.runId} onBackend={onBackend} />}
    </div>
  )
}
