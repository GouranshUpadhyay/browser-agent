import ActivityTimeline from './ActivityTimeline'

// One goal + its live activity + its results. Used by the chat, the run page and automations.
export function Turn({ run, now, label }) {
  const ended = run.result && run.status !== 'connecting' && run.status !== 'running'
  return (
    <article className="turn">
      {label && <div className="turn-label">{label}</div>}
      <div className="bubble">{run.goal}</div>
      <ActivityTimeline run={run} now={now} />
      {ended &&
        (run.result.success ? (
          <Results data={run.result} />
        ) : (
          <ErrorCard message={run.result.error} stopped={run.status === 'stopped'} />
        ))}
    </article>
  )
}

export function Results({ data }) {
  const items = data.items || []
  const sources = data.sources || []
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

      {items.length > 0 && (
        <div className="grid">
          {items.map((it, i) => (
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

      {sources.length > 0 && (
        <div className="card sources">
          <h2>Pages the agent visited</h2>
          <ul>
            {sources.map((s) => (
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

export function ErrorCard({ message, stopped }) {
  return (
    <section className={`card error ${stopped ? 'muted' : ''}`}>
      <h2>{stopped ? 'Stopped' : "That didn't work"}</h2>
      <p>{message}</p>
    </section>
  )
}
