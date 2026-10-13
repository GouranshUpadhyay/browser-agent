import { NODES, actionLabel, activeNode, domainOf, formatElapsed, nodeStates } from './agentRun'

const STATUS_TEXT = {
  connecting: 'Connecting',
  running: 'Running',
  done: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
}

function caption(run) {
  if (!run) return 'Waiting for a goal'
  const last = run.steps[run.steps.length - 1]
  if (run.status === 'done') return `Finished in ${run.steps.length} step${run.steps.length === 1 ? '' : 's'}`
  if (run.status === 'stopped') return 'Stopped by you'
  if (run.status === 'failed') return 'Run failed — see details above'
  switch (activeNode(run)) {
    case 'goal':
      return 'Sending goal to the agent'
    case 'browser':
      return 'Launching browser'
    case 'think':
      return last?.url ? `Deciding next action on ${domainOf(last.url) || 'page'}` : 'Deciding next action'
    case 'act': {
      const a = last.actions[0]
      return a ? `${actionLabel(a.name)}${a.detail ? ` · ${a.detail}` : ''}` : 'Executing action'
    }
    case 'answer':
      return 'Verifying and composing answer'
    default:
      return ''
  }
}

export default function ExecutionGraph({ run, now }) {
  const states = nodeStates(run)
  const elapsed = run ? (run.endedAt || now) - run.startedAt : 0
  const steps = run?.steps.length || 0

  return (
    <div className="graph" aria-label="Agent execution graph">
      <div className="graph-head">
        <span>Execution</span>
        {run && (
          <span className={`graph-status ${run.status}`}>
            <i /> {STATUS_TEXT[run.status]} · {formatElapsed(elapsed)}
          </span>
        )}
      </div>

      <ol className="graph-nodes">
        {NODES.map((n, i) => (
          <li key={n.id} className={`gnode ${states[n.id]}`}>
            {i > 0 && (
              <span className={`gedge ${states[n.id] !== 'idle' ? 'on' : ''} ${n.id === 'act' ? 'loop' : ''}`}>
                {n.id === 'act' && steps > 0 && <b title="Reason → Act cycles">↻{steps}</b>}
              </span>
            )}
            <span className="gdot" aria-hidden="true" />
            <span className="glabel">{n.label}</span>
            <span className="sr-only">: {states[n.id]}</span>
          </li>
        ))}
      </ol>

      <div className="graph-foot">
        {run?.maxSteps ? <span className="graph-steps">Step {steps}/{run.maxSteps}</span> : null}
        <span className="graph-caption" title={caption(run)}>{caption(run)}</span>
      </div>
    </div>
  )
}
