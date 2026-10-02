import { PAGE_CSS, PAGE_HELPERS_JS } from './review-page.js'

/**
 * Session detail page: one agent session (one test's turns) plus the **OTel trace**
 * agentfoo would export for it (§9 → protocol).
 *
 * The waterfall is rendered from `planRunSpans()` — the very same plan the OTLP
 * exporter ships to a collector — so this page cannot drift from what a real
 * backend receives. That is deliberate: the point of being protocol-facing is
 * that the local view and the wire view are the same data.
 *
 * Self-contained like the other pages: no CDN, no font requests, nothing about
 * the run leaves the machine.
 */
export const SESSION_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agentfoo session</title>
<style>${PAGE_CSS}
main { padding: 18px 22px 60px; }
.wf { display: grid; gap: 2px; }
.wf-row { display: grid; grid-template-columns: minmax(240px, 34%) 1fr; gap: 10px; align-items: center; }
.wf-name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-name .kind { font-family: var(--mono); font-size: 11px; color: var(--muted); margin-right: 6px; }
.wf-track { position: relative; height: 26px; background: var(--bg); border-radius: 5px; border: 1px solid var(--line); }
.wf-bar { position: absolute; top: 0; bottom: 0; border-radius: 4px; background: var(--accent); opacity: .85; display: flex; overflow: hidden; }
.wf-bar.fail { background: var(--fail); }
.wf-bar .seg { height: 100%; }
.seg.agent { background: var(--accent); }
.seg.tool { background: var(--warn); }
.seg.mixed { background: var(--muted); opacity: .5; }
.wf-dur { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); font-family: var(--mono); font-size: 11px; color: var(--muted); }
.wf-ev { position: absolute; top: -3px; width: 3px; height: 32px; background: var(--fail); border-radius: 2px; opacity: .8; }
.wf-attr { grid-column: 1 / -1; margin: 0 0 8px; }
.wf-attr summary { cursor: pointer; font-size: 12px; color: var(--muted); }
table.kv { border-collapse: collapse; font-size: 12px; margin-top: 6px; }
table.kv td { border-top: 1px solid var(--line); padding: 3px 10px 3px 0; vertical-align: top; }
table.kv td:first-child { font-family: var(--mono); color: var(--muted); white-space: nowrap; }
.meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px 18px; }
.meta-grid div b { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 600; }
.siblings a { display: inline-block; margin: 2px 6px 2px 0; font-size: 12px; text-decoration: none; color: var(--accent); }
.root-link { font-size: 12px; color: var(--muted); text-decoration: none; }
</style>
</head>
<body>
<header>
  <h1>agentfoo session</h1>
  <span class="run" id="runId"></span>
  <span class="stat" id="agent"></span>
  <a class="root-link" id="back" href="/">← review</a>
  <span class="save" id="copy">copy OTLP JSON</span>
</header>
<main>
  <div class="panel"><h3>Session</h3><div id="meta"></div></div>
  <div class="panel">
    <h3>OTel trace <span class="chip" id="spanCount"></span></h3>
    <div class="hint" style="margin-bottom:10px">Rendered from the same span plan the OTLP exporter sends — identical names, attributes and events. Red ticks are stalls.</div>
    <div class="wf" id="wf"></div>
  </div>
  <div class="panel"><h3>Other sessions in this run</h3><div class="siblings" id="siblings"></div></div>
</main>
<script>
${PAGE_HELPERS_JS}
const index = Number(location.pathname.split('/').filter(Boolean).pop())
const fmt = (ms) => (ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' s')

function renderWf(wf) {
  const el = $('wf')
  el.textContent = ''
  if (!wf.rows.length) {
    el.append(h('div', { class: 'empty' }, 'This run has no span data — it was written by an older agentfoo, or the run is still in flight.'))
    return
  }
  $('spanCount').textContent = wf.spanCount + ' spans'
  for (const row of wf.rows) {
    const bar = h('div', { class: 'wf-bar' + (row.failed ? ' fail' : ''), style: 'left:' + row.leftPct + '%;width:' + row.widthPct + '%' },
      row.segments.length
        ? row.segments.map((s) => h('div', { class: 'seg ' + s.kind, style: 'width:' + s.pct + '%' }))
        : h('div', { class: 'seg agent', style: 'width:100%' }))
    const track = h('div', { class: 'wf-track' }, bar,
      row.events.map((e) => h('div', { class: 'wf-ev', style: 'left:' + e.leftPct + '%', title: e.title })),
      h('span', { class: 'wf-dur' }, fmt(row.durationMs)))
    el.append(h('div', { class: 'wf-row' },
      h('div', { class: 'wf-name', style: 'padding-left:' + (row.depth * 14) + 'px', title: row.name },
        h('span', { class: 'kind' }, row.kind), row.name),
      track))
    el.append(h('details', { class: 'wf-attr' },
      h('summary', {}, row.attributes.length + ' attributes' +
        (row.eventDetails.length ? ', ' + row.eventDetails.length + ' events' : '') +
        (row.failed ? ', failed' : '')),
      h('table', { class: 'kv' },
        row.attributes.map((pair) => h('tr', {}, h('td', {}, pair[0]), h('td', {}, pair[1]))),
        row.eventDetails.map((e) => h('tr', {}, h('td', {}, 'event ' + e.name), h('td', {}, e.text))))))
  }
}

function renderMeta(c, runId, agent) {
  $('runId').textContent = runId
  $('agent').textContent = agent || '(agent unset)'
  const m = $('meta')
  m.append(h('div', { class: 'case-head' },
    h('h2', {}, c.name),
    h('span', { class: 'badge ' + (c.state === 'fail' ? 'fail' : 'pass') }, c.state),
    Object.entries(c.meta || {}).map((kv) => h('span', { class: 'chip' }, kv[0] + ': ' + kv[1]))))
  const grid = h('div', { class: 'meta-grid' })
  m.append(grid)
  const block = (label, body) => {
    const d = h('div', {}, h('b', {}, label))
    d.append(body)
    return d
  }
  const pre = (t) => {
    const el = h('div', { class: 'prompt' })
    el.textContent = t || '(empty)'
    return el
  }
  grid.append(block('Prompt', pre(c.prompt)))
  grid.append(block('Final answer', pre((c.finalMessage || '').slice(0, 1200))))
  if (c.judges && c.judges.length) {
    grid.append(block('Judges', pre(c.judges.map((j) => 'judge ' + j.index + ': ' + Number(j.score).toFixed(2) +
      ' (threshold ' + j.threshold + ')').join(' · '))))
  }
}

async function boot() {
  const res = await fetch('/api/session/' + index)
  if (!res.ok) {
    $('wf').append(h('div', { class: 'empty' }, 'Session not found (HTTP ' + res.status + ')'))
    return
  }
  const data = await res.json()
  renderMeta(data.case, data.run.runId, data.agent)
  // Layout comes from the server (src/waterfall.ts) — the page only builds DOM.
  renderWf(data.waterfall)
  const sib = $('siblings')
  if (!data.siblings.length) sib.append(h('span', { class: 'hint' }, 'none'))
  for (const s of data.siblings) {
    sib.append(h('a', { href: '/session/' + s.index, title: s.name }, (s.state === 'fail' ? '✗ ' : '✓ ') + s.name))
  }
  $('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(data.spans, null, 2))
      $('copy').textContent = 'copied ✓'
      setTimeout(() => { $('copy').textContent = 'copy OTLP JSON' }, 1500)
    } catch {
      $('copy').textContent = 'copy failed'
    }
  })
}
boot()
</script>
</body>
</html>
`
