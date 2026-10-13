import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'

const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

const IDEAS = [
  'Every weekday at 9am, find the price of iPhone 16 on Flipkart',
  'Tomorrow at 6pm, list the top 3 wireless mice on Amazon India',
  'Every Monday at 8:30, search Google News for AI regulation headlines',
]

const REPEAT_PRESETS = [
  ['Daily 09:00', '0 9 * * *'],
  ['Weekdays 09:00', '0 9 * * 1-5'],
  ['Mondays 09:00', '0 9 * * 1'],
  ['Every 6 hours', '0 */6 * * *'],
]

const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const formatWhen = (iso) => (iso ? fmt.format(new Date(iso)) : '—')

function relative(iso, now = Date.now()) {
  if (!iso) return ''
  const diff = Date.parse(iso) - now
  const abs = Math.abs(diff)
  const unit = abs < 3600e3 ? [Math.max(1, Math.round(abs / 60e3)), 'min'] : abs < 86400e3 ? [Math.round(abs / 3600e3), 'h'] : [Math.round(abs / 86400e3), 'd']
  return diff >= 0 ? `in ${unit[0]} ${unit[1]}` : `${unit[0]} ${unit[1]} ago`
}

function emptyDraft(tz) {
  const soon = new Date(Date.now() + 60 * 60e3)
  soon.setMinutes(0, 0, 0)
  const local = new Date(soon.getTime() - soon.getTimezoneOffset() * 60e3).toISOString().slice(0, 16)
  return { name: '', instruction: '', schedule_kind: 'once', run_at_local: local, cron: '0 9 * * *', timezone: tz, notify: 'app' }
}

export default function Automations({ health }) {
  const [tasks, setTasks] = useState(null)
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)

  const refresh = useCallback(() => {
    api('/tasks')
      .then((t) => {
        setTasks(t)
        setError(null)
      })
      .catch((err) => setError(err.message))
  }, [])

  // Keep next-run times and last results fresh while the page is open
  useEffect(() => {
    refresh()
    const t = setInterval(() => document.visibilityState === 'visible' && refresh(), 10000)
    return () => clearInterval(t)
  }, [refresh])

  const act = async (fn) => {
    try {
      await fn()
      refresh()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <main className="thread">
      <div className="thread-inner page">
        <div className="page-head">
          <div>
            <h1 className="page-title">Automations</h1>
            <p className="page-sub">Give the agent a goal and a time. It runs on schedule — even when this page is closed — as long as the backend is running.</p>
          </div>
          {!creating && <button className="run" onClick={() => setCreating(true)}>New automation</button>}
        </div>

        {error && (
          <div className="card error notice">
            <p>{error}</p>
            <button className="link" onClick={() => setError(null)}>Dismiss</button>
          </div>
        )}

        {creating && (
          <Creator
            health={health}
            onCancel={() => setCreating(false)}
            onCreated={() => {
              setCreating(false)
              refresh()
            }}
          />
        )}

        {tasks === null ? (
          !error && <p className="muted-text">Loading…</p>
        ) : tasks.length === 0 ? (
          !creating && (
            <div className="card empty">
              <h2>No automations yet</h2>
              <p>Try something like “{IDEAS[0]}”.</p>
            </div>
          )
        ) : (
          <div className="task-list">
            {tasks.map((t) => (
              <TaskCard
                key={t.id}
                task={t}
                onRunNow={() => act(() => api(`/tasks/${t.id}/run`, { method: 'POST' }))}
                onToggle={() => act(() => api(`/tasks/${t.id}`, { method: 'PATCH', body: { enabled: !t.enabled } }))}
                onDelete={() => window.confirm(`Delete “${t.name}”? Its run history stays available.`) && act(() => api(`/tasks/${t.id}`, { method: 'DELETE' }))}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  )
}

function Creator({ health, onCancel, onCreated }) {
  const [text, setText] = useState('')
  const [parsing, setParsing] = useState(false)
  const [draft, setDraft] = useState(null)
  const [preview, setPreview] = useState(null) // { schedule_text, next_runs } | { error }
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const seq = useRef(0)

  const parse = async () => {
    if (text.trim().length < 3) return
    setParsing(true)
    setError(null)
    try {
      const res = await api('/tasks/parse', { method: 'POST', body: { text: text.trim(), timezone: BROWSER_TZ } })
      setDraft({ ...res.draft, notify: health?.telegram_configured ? 'telegram' : 'app' })
    } catch (err) {
      setError(err.message)
    } finally {
      setParsing(false)
    }
  }

  // Re-check the schedule on every edit (debounced) so the confirmation always matches what will be saved
  const { schedule_kind, run_at_local, cron, timezone } = draft || {}
  useEffect(() => {
    if (!schedule_kind) return
    const id = ++seq.current
    setPreview(null)
    const t = setTimeout(() => {
      api('/tasks/preview', { method: 'POST', body: { schedule_kind, run_at_local, cron, timezone } })
        .then((p) => id === seq.current && setPreview(p))
        .catch((err) => id === seq.current && setPreview({ error: err.message }))
    }, 350)
    return () => clearTimeout(t)
  }, [schedule_kind, run_at_local, cron, timezone])

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }))

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await api('/tasks', { method: 'POST', body: draft })
      onCreated()
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  const valid = preview && !preview.error && draft?.name.trim() && draft?.instruction.trim().length >= 3

  return (
    <section className="card creator">
      {!draft ? (
        <>
          <h2>Describe it</h2>
          <textarea
            className="field"
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), parse())}
            placeholder={IDEAS[0]}
            autoFocus
            disabled={parsing}
          />
          <div className="chips">
            {IDEAS.map((i) => (
              <button key={i} className="chip" onClick={() => setText(i)} disabled={parsing}>{i}</button>
            ))}
          </div>
          {error && <p className="form-error">{error}</p>}
          <div className="form-actions">
            <button className="link" onClick={() => setDraft(emptyDraft(BROWSER_TZ))}>Set it up manually</button>
            <span className="spacer" />
            <button className="btn" onClick={onCancel}>Cancel</button>
            <button className="run" onClick={parse} disabled={parsing || text.trim().length < 3}>
              {parsing ? 'Reading…' : 'Continue'}
            </button>
          </div>
        </>
      ) : (
        <>
          <h2>Check and confirm</h2>
          <div className="form-grid">
            <label>
              <span>Name</span>
              <input className="field" value={draft.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} />
            </label>
            <label className="wide">
              <span>What the agent should do each time</span>
              <textarea className="field" rows={2} value={draft.instruction} maxLength={1000} onChange={(e) => set({ instruction: e.target.value })} />
            </label>

            <div className="wide">
              <span className="label">When</span>
              <div className="segmented" role="radiogroup" aria-label="Schedule type">
                {[['once', 'One time'], ['cron', 'Repeat']].map(([k, l]) => (
                  <button key={k} role="radio" aria-checked={draft.schedule_kind === k} className={draft.schedule_kind === k ? 'on' : ''} onClick={() => set({ schedule_kind: k })}>
                    {l}
                  </button>
                ))}
              </div>
            </div>

            {draft.schedule_kind === 'once' ? (
              <label>
                <span>Date and time</span>
                <input className="field" type="datetime-local" value={draft.run_at_local || ''} onChange={(e) => set({ run_at_local: e.target.value })} />
              </label>
            ) : (
              <label>
                <span>Repeat pattern (cron: minute hour day month weekday)</span>
                <input className="field mono" value={draft.cron || ''} onChange={(e) => set({ cron: e.target.value })} placeholder="0 9 * * 1-5" />
                <div className="chips small">
                  {REPEAT_PRESETS.map(([l, c]) => (
                    <button key={c} type="button" className={`chip ${draft.cron === c ? 'on' : ''}`} onClick={() => set({ cron: c })}>{l}</button>
                  ))}
                </div>
              </label>
            )}
            <label>
              <span>Timezone</span>
              <input className="field" value={draft.timezone} onChange={(e) => set({ timezone: e.target.value })} />
            </label>

            <label>
              <span>Deliver results to</span>
              <select className="field" value={draft.notify} onChange={(e) => set({ notify: e.target.value })}>
                <option value="app">This app (Automations page)</option>
                <option value="telegram" disabled={!health?.telegram_configured}>
                  Telegram{health?.telegram_configured ? '' : ' — not configured on the backend'}
                </option>
              </select>
            </label>
          </div>

          <div className={`schedule-preview ${preview?.error ? 'bad' : ''}`} aria-live="polite">
            {!preview ? (
              'Checking schedule…'
            ) : preview.error ? (
              preview.error
            ) : (
              <>
                <b>{preview.schedule_text}</b>
                <span>
                  {preview.next_runs.length > 1 ? 'Next runs: ' : 'Runs: '}
                  {preview.next_runs.map(formatWhen).join(' · ')}
                </span>
              </>
            )}
          </div>

          {error && <p className="form-error">{error}</p>}
          <div className="form-actions">
            <button className="link" onClick={() => (setDraft(null), setPreview(null))}>← Start over</button>
            <span className="spacer" />
            <button className="btn" onClick={onCancel}>Cancel</button>
            <button className="run" onClick={save} disabled={!valid || saving}>{saving ? 'Saving…' : 'Create automation'}</button>
          </div>
        </>
      )}
    </section>
  )
}

const STATUS_LABEL = { queued: 'Queued', running: 'Running', done: 'Completed', failed: 'Failed', stopped: 'Stopped' }

function TaskCard({ task, onRunNow, onToggle, onDelete }) {
  const [open, setOpen] = useState(false)
  const [history, setHistory] = useState(null)
  const last = task.last_run
  const running = last && (last.status === 'queued' || last.status === 'running')
  const finished = !task.enabled && task.schedule_kind === 'once' && last
  const state = running ? 'running' : task.enabled ? 'active' : finished ? 'finished' : 'paused'

  useEffect(() => {
    if (!open) return
    api(`/tasks/${task.id}/runs?limit=10`).then(setHistory).catch(() => setHistory([]))
  }, [open, task.id, last?.id, last?.status])

  return (
    <article className={`card task ${state}`}>
      <div className="task-top">
        <div className="task-main">
          <div className="task-name">
            <h3>{task.name}</h3>
            <span className={`state ${state}`}>{{ running: 'Running', active: 'Active', finished: 'Done', paused: 'Paused' }[state]}</span>
          </div>
          <p className="task-instruction">{task.instruction}</p>
          <div className="task-meta">
            <span>{task.schedule_text}</span>
            {task.next_run_at && <span>Next: <b>{formatWhen(task.next_run_at)}</b> ({relative(task.next_run_at)})</span>}
            {task.notify === 'telegram' && <span>→ Telegram</span>}
          </div>
        </div>
        <div className="task-actions">
          <button className="btn" onClick={onRunNow} disabled={running}>Run now</button>
          {!finished && <button className="btn" onClick={onToggle}>{task.enabled ? 'Pause' : 'Resume'}</button>}
          <button className="btn danger" onClick={onDelete} aria-label={`Delete ${task.name}`}>Delete</button>
        </div>
      </div>

      {last && (
        <a className="last-run" href={`#/runs/${last.id}`}>
          <span className={`dot ${last.status}`} />
          <span className="last-run-label">Last run · {STATUS_LABEL[last.status]} · {formatWhen(last.created_at)}</span>
          {last.summary && <span className="last-run-summary">{last.summary}</span>}
        </a>
      )}

      <button className="link history-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? 'Hide history' : 'History'}
      </button>
      {open && (
        <ul className="history">
          {history === null ? (
            <li className="muted-text">Loading…</li>
          ) : history.length === 0 ? (
            <li className="muted-text">No runs yet.</li>
          ) : (
            history.map((r) => (
              <li key={r.id}>
                <a href={`#/runs/${r.id}`}>
                  <span className={`dot ${r.status}`} />
                  <span>{formatWhen(r.created_at)}</span>
                  <span className="muted-text">{STATUS_LABEL[r.status]}</span>
                  {r.summary && <span className="history-summary">{r.summary}</span>}
                </a>
              </li>
            ))
          )}
        </ul>
      )}
    </article>
  )
}
