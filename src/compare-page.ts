import { PAGE_CSS, PAGE_HELPERS_JS } from './review-page.js'

/**
 * Blind side-by-side preference page served by `agentfoo review --compare`.
 * Each case shows the two versions' answers on a left/right side fixed per case
 * by a hash (so A isn't always on the left), and hides the judge's verdict until
 * the reviewer has voted — otherwise the vote measures agreement with the judge.
 */
export const COMPARE_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agentfoo compare</title>
<style>${PAGE_CSS}
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
.pair .panel + .panel { margin-top: 0; }
@media (max-width: 1100px) { .pair { grid-template-columns: 1fr; } }
.side h3 { display: flex; justify-content: space-between; }
.vote { display: flex; gap: 8px; margin: 14px 0 10px; }
.vote button { flex: 1; padding: 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); cursor: pointer; font-weight: 600; }
.vote button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.reveal { font-size: 13px; padding: 10px 12px; border-radius: 8px; background: var(--bg); border: 1px dashed var(--line); }
.reveal .who { font-weight: 600; }
.pick-l { color: var(--accent); }
</style>
</head>
<body>
<div class="app">
  <header>
    <h1>agentfoo compare</h1>
    <span class="run" id="run"></span>
    <span class="stat">voted <b id="done">0</b>/<b id="total">0</b></span>
    <span class="stat">you: B better <b id="hb">0</b> · A better <b id="ha">0</b> · tie <b id="ht">0</b></span>
    <span class="stat">agree with judge <b id="agree">–</b></span>
    <span class="stat hint"><kbd>j</kbd>/<kbd>k</kbd> move · <kbd>←</kbd> <kbd>↓</kbd> <kbd>→</kbd> vote</span>
    <span class="save" id="save">loading…</span>
  </header>
  <aside>
    <div class="filters">
      <select id="f-done"><option value="">all</option><option value="todo">not voted</option><option value="done">voted</option></select>
      <select id="f-meta"></select>
    </div>
    <div id="list"></div>
  </aside>
  <main id="main"><div class="empty">Loading…</div></main>
</div>
<script>
${PAGE_HELPERS_JS}
let data = null, prefs = null, current = null, saveTimer = null

// Deterministic per-case side assignment: blind, but stable across reloads.
function swapped(name) { let x = 0; for (const ch of name) x = (x * 31 + ch.charCodeAt(0)) | 0; return (x & 1) === 1 }
const sides = (c) => swapped(c.name) ? [['B', c.b], ['A', c.a]] : [['A', c.a], ['B', c.b]]
const pref = (name) => (prefs.cases[name] ||= {})
const voted = (name) => !!(prefs.cases[name] && prefs.cases[name].pick)

function scheduleSave() {
  $('save').textContent = 'unsaved…'; $('save').className = 'save'
  clearTimeout(saveTimer); saveTimer = setTimeout(save, 400)
}
async function save() {
  try {
    const res = await fetch('/api/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(prefs) })
    const body = await res.json()
    if (!body.ok) throw new Error(body.error)
    $('save').textContent = 'saved ' + new Date().toLocaleTimeString(); $('save').className = 'save'
  } catch (err) { $('save').textContent = 'save failed: ' + err.message; $('save').className = 'save err' }
  renderStats(); renderList()
}

function renderStats() {
  const picks = data.cases.map((c) => (prefs.cases[c.name] || {}).pick).filter(Boolean)
  $('done').textContent = picks.length; $('total').textContent = data.cases.length
  $('hb').textContent = picks.filter((p) => p === 'b').length
  $('ha').textContent = picks.filter((p) => p === 'a').length
  $('ht').textContent = picks.filter((p) => p === 'tie').length
  let same = 0, n = 0
  for (const c of data.cases) { const p = (prefs.cases[c.name] || {}).pick; if (p && c.judge) { n++; if (p === c.judge.winner) same++ } }
  $('agree').textContent = n ? Math.round((100 * same) / n) + '% (' + same + '/' + n + ')' : '–'
}

function visible() {
  const dn = $('f-done').value, mt = $('f-meta').value
  return data.cases.filter((c) => (!dn || (dn === 'done') === voted(c.name)) &&
    (!mt || Object.entries(c.meta).some(([k, v]) => k + '=' + v === mt)))
}
function renderList() {
  const list = $('list'); list.replaceChildren()
  for (const c of visible()) {
    const p = (prefs.cases[c.name] || {}).pick
    list.append(h('div', { class: 'case-item' + (current === c.name ? ' active' : ''), onclick: () => select(c.name) },
      h('span', { class: 'dot ' + (p ? 'pass' : '') }), h('span', { class: 'nm', title: c.name }, c.name),
      h('span', { class: 'rt' + (p ? ' done' : '') }, p ? '✓' : '')))
  }
}
function select(name) { current = name; renderList(); renderCase(); $('main').scrollTop = 0 }

function vote(which) {
  const c = data.cases.find((x) => x.name === current); if (!c) return
  const [[left], [right]] = sides(c)
  const pick = which === 'tie' ? 'tie' : (which === 'left' ? left : right).toLowerCase()
  const p = pref(c.name); p.pick = p.pick === pick ? undefined : pick; p.votedAt = new Date().toISOString()
  scheduleSave(); renderCase(); renderList()
}

function renderCase() {
  const c = data.cases.find((x) => x.name === current)
  const main = $('main'); main.replaceChildren()
  if (!c) { main.append(h('div', { class: 'empty' }, 'Pick a case on the left.')); return }
  const p = pref(c.name)
  const [[lv, lt], [rv, rt]] = sides(c)
  const panel = (label, text) => { const a = h('div', { class: 'article' }); a.innerHTML = markdown(text); return h('div', { class: 'panel side' }, h('h3', {}, h('span', {}, label)), a) }
  const comment = h('textarea', { placeholder: 'Why? What made one better — or what both got wrong?' })
  comment.value = p.comment || ''
  comment.addEventListener('input', () => { p.comment = comment.value; scheduleSave() })
  const reveal = p.pick && c.judge
    ? h('div', { class: 'reveal' },
        h('span', { class: 'who' }, 'Judge: ' + (c.judge.winner === 'tie' ? 'tie' : c.judge.winner === lv.toLowerCase() ? 'left better' : 'right better')),
        c.judge.orders[0] !== c.judge.orders[1] ? h('span', { class: 'hint' }, ' (the two presentation orders disagreed → counted as tie)') : null,
        h('div', { class: 'why' }, c.judge.reasons[0]),
        h('div', { class: 'hint', style: 'margin-top:6px' }, 'Left was version ' + lv + ', right was version ' + rv + '.'))
    : c.judge ? h('div', { class: 'hint' }, 'The judge verdict and which side is which appear after you vote.') : null
  main.append(
    h('div', { class: 'case-head' }, h('h2', {}, c.name), Object.entries(c.meta).map(([k, v]) => h('span', { class: 'chip' }, k + ': ' + v))),
    h('div', { class: 'panel' }, h('h3', {}, 'Prompt'), h('div', { class: 'prompt' }, c.prompt || '(not recorded)')),
    h('div', { class: 'vote' },
      h('button', { class: p.pick && p.pick === lv.toLowerCase() ? 'on' : '', onclick: () => vote('left') }, '← Left is better'),
      h('button', { class: p.pick === 'tie' ? 'on' : '', onclick: () => vote('tie') }, 'Tie'),
      h('button', { class: p.pick && p.pick === rv.toLowerCase() ? 'on' : '', onclick: () => vote('right') }, 'Right is better →')),
    comment, reveal ? h('div', { style: 'margin:10px 0 14px' }, reveal) : null,
    h('div', { class: 'pair' }, panel('Left', lt), panel('Right', rt)))
}

document.addEventListener('keydown', (e) => {
  if (!data || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return
  const vis = visible(), i = vis.findIndex((c) => c.name === current)
  if (e.key === 'j' && i < vis.length - 1) select(vis[i + 1].name)
  else if (e.key === 'k' && i > 0) select(vis[i - 1].name)
  else if (e.key === 'ArrowLeft') vote('left')
  else if (e.key === 'ArrowRight') vote('right')
  else if (e.key === 'ArrowDown') { e.preventDefault(); vote('tie') }
})
for (const id of ['f-done', 'f-meta']) $(id).addEventListener('change', renderList)

fetch('/api/compare').then((r) => r.json()).then((d) => {
  data = d; prefs = d.preferences || { cases: {} }; prefs.cases ||= {}
  $('run').textContent = d.label
  const metas = [...new Set(d.cases.flatMap((c) => Object.entries(c.meta).map(([k, v]) => k + '=' + v)))].sort()
  $('f-meta').append(h('option', { value: '' }, 'all tags'), metas.map((m) => h('option', { value: m }, m)))
  $('save').textContent = 'saved to preferences.json'
  renderStats(); renderList()
  const first = d.cases.find((c) => !voted(c.name)) || d.cases[0]
  if (first) select(first.name)
}).catch((err) => { $('main').replaceChildren(h('div', { class: 'empty' }, 'Could not load: ' + err.message)) })
</script>
</body>
</html>
`
