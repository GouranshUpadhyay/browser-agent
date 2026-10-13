import { useEffect, useState } from 'react'
import { actionLabel, domainOf, formatElapsed } from './agentRun'

function Entry({ status, title, children }) {
  return (
    <li className={`tl-item ${status}`}>
      <span className="tl-dot" aria-hidden="true" />
      <div className="tl-body">
        <div className="tl-title">{title}</div>
        {children}
      </div>
    </li>
  )
}

export default function ActivityTimeline({ run, now }) {
  const live = run.status === 'connecting' || run.status === 'running'
  const [open, setOpen] = useState(live)

  // Collapse once the run ends; the user can re-open it.
  useEffect(() => {
    if (!live) setOpen(false)
  }, [live])

  const elapsed = formatElapsed((run.endedAt || now) - run.startedAt)
  const n = run.steps.length

  return (
    <details className={`timeline ${live ? 'live' : ''}`} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className={`tl-state ${run.status}`} />
        {live ? 'Working' : 'Activity'} · {n} step{n === 1 ? '' : 's'} · {elapsed}
      </summary>

      <ol>
        <Entry
          status={n > 0 ? 'done' : live ? 'running' : run.status}
          title={n > 0 ? 'Browser started' : run.status === 'connecting' ? 'Connecting to agent' : 'Starting browser'}
        />

        {run.steps.map((s) => (
          <Entry
            key={s.step}
            status={s.status === 'thinking' || s.status === 'acting' ? 'running' : s.status}
            title={
              <>
                <span className="tl-step">Step {s.step}</span>
                {s.goal ||
                  (s.status === 'thinking'
                    ? 'Reading the page and deciding…'
                    : s.actions.some((a) => a.name === 'done')
                      ? 'Reporting the answer'
                      : 'Step completed')}
              </>
            }
          >
            {(s.actions.length > 0 || s.url) && (
              <div className="tl-meta">
                {s.actions.map((a, i) => (
                  <span className="tl-action" key={i} title={a.detail || undefined}>
                    <b>{actionLabel(a.name)}</b>
                    {a.detail && <span>{a.detail}</span>}
                  </span>
                ))}
                {s.url && domainOf(s.url) && <span className="tl-domain">{domainOf(s.url)}</span>}
              </div>
            )}
            {s.errors.map((e, i) => (
              <p className="tl-error" key={i}>{e}</p>
            ))}
          </Entry>
        ))}

        {(run.finalizing || run.status === 'done') && (
          <Entry
            status={run.status === 'done' ? 'done' : live ? 'running' : run.status}
            title={run.status === 'done' ? 'Answer ready' : 'Verifying and composing answer'}
          />
        )}
        {!live && run.status !== 'done' && n > 0 && !run.finalizing && (
          <Entry status={run.status} title={run.status === 'stopped' ? 'Stopped' : 'Run failed'} />
        )}
      </ol>
    </details>
  )
}
