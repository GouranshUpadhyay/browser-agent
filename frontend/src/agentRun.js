// Live agent run: reads the backend's /run/stream events and folds them into one run object
// that both the execution graph and the activity timeline render from.

export const NODES = [
  { id: 'goal', label: 'Goal' },
  { id: 'browser', label: 'Browser' },
  { id: 'think', label: 'Reason' },
  { id: 'act', label: 'Act' },
  { id: 'answer', label: 'Answer' },
]

const ACTION_LABELS = {
  navigate: 'Open',
  go_to_url: 'Open',
  search: 'Search',
  search_google: 'Search',
  click: 'Click',
  click_element_by_index: 'Click',
  input: 'Type',
  input_text: 'Type',
  scroll: 'Scroll',
  extract: 'Extract',
  extract_structured_data: 'Extract',
  go_back: 'Back',
  send_keys: 'Keys',
  switch_tab: 'Switch tab',
  close_tab: 'Close tab',
  wait: 'Wait',
  done: 'Finish',
}

export const actionLabel = (name) => ACTION_LABELS[name] || name.replace(/_/g, ' ')

export function newRun(goal) {
  return {
    goal,
    status: 'connecting', // connecting | running | done | failed | stopped
    startedAt: Date.now(),
    endedAt: null,
    maxSteps: null,
    steps: [], // { step, status: thinking|acting|done|failed, goal, url, title, actions, errors }
    finalizing: false,
    failedNode: null,
    result: null,
  }
}

const isLive = (run) => run.status === 'connecting' || run.status === 'running'

export function activeNode(run) {
  if (run.status === 'connecting') return 'goal'
  if (run.finalizing) return 'answer'
  const last = run.steps[run.steps.length - 1]
  if (!last) return 'browser'
  return last.status === 'acting' ? 'act' : 'think'
}

function updateLastStep(run, patch) {
  const steps = run.steps.slice()
  const i = steps.length - 1
  if (i >= 0) steps[i] = { ...steps[i], ...patch }
  return steps
}

export function applyEvent(run, ev) {
  switch (ev.type) {
    case 'run_started':
      return { ...run, status: 'running', maxSteps: ev.max_steps }
    case 'step_started':
      return {
        ...run,
        steps: [...run.steps, { step: ev.step, status: 'thinking', goal: null, url: null, title: null, actions: [], errors: [] }],
      }
    case 'step_planned':
      return {
        ...run,
        steps: updateLastStep(run, { status: 'acting', goal: ev.goal, url: ev.url, title: ev.title, actions: ev.actions || [] }),
      }
    case 'step_finished':
      return {
        ...run,
        steps: updateLastStep(run, {
          status: ev.ok ? 'done' : 'failed',
          errors: (ev.results || []).map((r) => r.error).filter(Boolean),
        }),
      }
    case 'finalizing':
      return { ...run, finalizing: true }
    case 'result':
      return finish(run, ev.success ? 'done' : 'failed', ev)
    default:
      return run
  }
}

// Ends the run. On failure, the stage that was running is the one marked as failed.
export function finish(run, status, result) {
  if (!isLive(run)) return run
  const failedNode = status === 'done' ? null : activeNode(run)
  const steps = run.steps.map((s) =>
    s.status === 'thinking' || s.status === 'acting' ? { ...s, status: status === 'done' ? 'done' : 'failed' } : s,
  )
  return { ...run, status, steps, failedNode, endedAt: Date.now(), result }
}

// idle | running | done | failed | stopped for each graph node
export function nodeStates(run) {
  if (!run) return Object.fromEntries(NODES.map((n) => [n.id, 'idle']))
  const reached = {
    goal: true,
    browser: run.steps.length > 0,
    think: run.steps.length > 0,
    act: run.steps.some((s) => s.status !== 'thinking'),
    answer: run.status === 'done',
  }
  const live = isLive(run)
  const current = live ? activeNode(run) : run.failedNode
  const currentState = live ? 'running' : run.status === 'stopped' ? 'stopped' : 'failed'
  return Object.fromEntries(
    NODES.map(({ id }) => [id, id === current ? currentState : reached[id] ? 'done' : 'idle']),
  )
}

export function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

// POSTs the goal and calls onEvent for every Server-Sent Event until the final "result".
export async function streamRun(api, goal, { signal, onEvent }) {
  const res = await fetch(`${api}/run/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal }),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`Server returned ${res.status}`)

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  let gotResult = false
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value.replace(/\r\n/g, '\n')
    let cut
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 2)
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (!data) continue
      const event = JSON.parse(data)
      if (event.type === 'result') gotResult = true
      onEvent(event)
    }
  }
  if (!gotResult) throw new Error('The connection closed before the agent finished')
}
