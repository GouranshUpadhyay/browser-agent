import { useEffect, useState } from 'react'
import { api } from './api'
import ExecutionGraph from './ExecutionGraph'
import { useNow, useRuns } from './hooks'
import { Turn } from './RunCards'

// A single run by id: the target of "View run" links in notifications and automation history.
export default function RunPage({ runId, onBackend }) {
  const [summary, setSummary] = useState(null)
  const [error, setError] = useState(null)
  const { runs, load } = useRuns({ onConnection: (ok) => onBackend(ok ? 'ready' : 'offline') })
  const run = runs.find((r) => r.id === runId)
  const live = run && (run.status === 'connecting' || run.status === 'running')
  const now = useNow(live)

  useEffect(() => {
    let ignore = false
    api(`/runs/${runId}`)
      .then((full) => {
        if (ignore) return
        setSummary(full)
        load(full, full.events)
      })
      .catch((err) => !ignore && setError(err.status === 404 ? 'This run does not exist (it may have been deleted).' : err.message))
    return () => {
      ignore = true
    }
  }, [runId, load])

  const stop = () => api(`/runs/${runId}/cancel`, { method: 'POST' }).catch((err) => setError(err.message))

  return (
    <main className="thread">
      <div className="thread-inner page">
        <div className="page-head">
          <a className="back" href={summary?.source === 'task' ? '#/automations' : '#/'}>
            ← {summary?.source === 'task' ? 'Automations' : 'Chat'}
          </a>
          {live && <button className="btn" onClick={stop}>Stop run</button>}
        </div>
        {error && <div className="card error"><p>{error}</p></div>}
        {run && (
          <>
            <div className="card graph-card">
              <ExecutionGraph run={run} now={now} />
            </div>
            <Turn
              run={run}
              now={now}
              label={`Run #${run.id}${summary?.source === 'task' ? ' · from an automation' : ''} · ${new Date(run.startedAt).toLocaleString()}`}
            />
          </>
        )}
      </div>
    </main>
  )
}
