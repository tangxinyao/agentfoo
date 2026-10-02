/**
 * Styles and helpers shared by the review and compare pages.
 * Self-contained on purpose: no CDN or font requests, so it works offline and
 * nothing about the run leaves the machine.
 */
export const PAGE_CSS = `
:root {
  --bg: #f7f7f5; --panel: #ffffff; --ink: #1d1d1b; --muted: #6b6b66; --line: #e3e2dc;
  --accent: #3552c8; --accent-soft: #e8ecfb; --pass: #1f7a4d; --pass-soft: #e3f3ea;
  --fail: #b3261e; --fail-soft: #fbe9e7; --warn: #8a5a00; --warn-soft: #fbf1dc;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161615; --panel: #1f1f1d; --ink: #ecebe6; --muted: #9c9b94; --line: #33322f;
    --accent: #8ea2ff; --accent-soft: #262c47; --pass: #6fd3a0; --pass-soft: #19302a;
    --fail: #ff8a80; --fail-soft: #3a1f1d; --warn: #f2c46b; --warn-soft: #362b17;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--ink); font: 14px/1.55 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Micro Hei", sans-serif; }
button, input, select, textarea { font: inherit; color: inherit; }
.app { display: grid; grid-template-columns: 300px 1fr; grid-template-rows: auto 1fr; height: 100vh; }
header { grid-column: 1 / -1; display: flex; gap: 20px; align-items: center; padding: 10px 18px; border-bottom: 1px solid var(--line); background: var(--panel); }
header h1 { font-size: 15px; margin: 0; font-weight: 600; }
header .run { font-family: var(--mono); color: var(--muted); font-size: 12px; }
header .stat { color: var(--muted); font-size: 13px; }
header .stat b { color: var(--ink); font-variant-numeric: tabular-nums; }
header .save { margin-left: auto; font-size: 12px; color: var(--muted); }
header .save.err { color: var(--fail); }
aside { border-right: 1px solid var(--line); overflow: auto; background: var(--panel); }
.filters { display: flex; gap: 6px; flex-wrap: wrap; padding: 10px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--panel); }
.filters select { padding: 3px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); font-size: 12px; }
.case-item { display: grid; grid-template-columns: 8px 1fr auto; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--line); cursor: pointer; }
.case-item:hover { background: var(--bg); }
.case-item.active { background: var(--accent-soft); }
.dot { width: 8px; height: 8px; border-radius: 50%; }
.dot.pass { background: var(--pass); } .dot.fail { background: var(--fail); }
.case-item .nm { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.case-item .rt { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.case-item .rt.done { color: var(--accent); }
main { overflow: auto; padding: 20px 24px 60px; }
.case-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.case-head h2 { font-size: 17px; margin: 0; font-weight: 600; }
.badge { font-size: 12px; padding: 1px 8px; border-radius: 999px; font-weight: 600; }
.badge.pass { background: var(--pass-soft); color: var(--pass); } .badge.fail { background: var(--fail-soft); color: var(--fail); }
.chip { font-size: 12px; padding: 1px 8px; border-radius: 6px; background: var(--bg); border: 1px solid var(--line); color: var(--muted); }
.grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 18px; align-items: start; }
@media (max-width: 1100px) { .grid { grid-template-columns: 1fr; } .app { grid-template-columns: 220px 1fr; } }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.panel + .panel { margin-top: 14px; }
.panel h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 0 0 10px; font-weight: 600; }
.prompt { white-space: pre-wrap; color: var(--muted); font-size: 13px; }
.article { font-size: 15px; line-height: 1.75; }
.article h1, .article h2, .article h3, .article h4 { line-height: 1.35; margin: 1.2em 0 .4em; }
.article h1 { font-size: 20px; } .article h2 { font-size: 17px; } .article h3, .article h4 { font-size: 15px; }
.article p { margin: .6em 0; }
.article blockquote { margin: .8em 0; padding: 2px 12px; border-left: 3px solid var(--line); color: var(--muted); }
.article code { font-family: var(--mono); font-size: 13px; background: var(--bg); padding: 0 4px; border-radius: 4px; }
.article pre { background: var(--bg); padding: 10px; border-radius: 8px; overflow: auto; }
.article table { border-collapse: collapse; margin: .8em 0; font-size: 13px; }
.article th, .article td { border: 1px solid var(--line); padding: 4px 8px; }
.article hr { border: 0; border-top: 1px solid var(--line); margin: 1.2em 0; }
.stars { display: flex; gap: 6px; margin-bottom: 10px; }
.stars button { width: 36px; height: 32px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); cursor: pointer; font-weight: 600; }
.stars button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.hint { font-size: 12px; color: var(--muted); }
textarea { width: 100%; min-height: 84px; resize: vertical; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; background: var(--bg); }
.grading { border-top: 1px solid var(--line); padding-top: 10px; margin-top: 10px; }
.grading:first-of-type { border-top: 0; margin-top: 0; padding-top: 0; }
.grading-head { display: flex; gap: 8px; align-items: baseline; font-size: 13px; margin-bottom: 6px; }
.grading-head .sc { font-weight: 600; font-variant-numeric: tabular-nums; }
.grading-head .sc.pass { color: var(--pass); } .grading-head .sc.fail { color: var(--fail); }
.crit { display: grid; grid-template-columns: 20px 1fr; gap: 6px; padding: 8px 0; border-bottom: 1px dashed var(--line); }
.crit:last-child { border-bottom: 0; }
.crit .ic { font-weight: 700; } .crit .ic.met { color: var(--pass); } .crit .ic.unmet { color: var(--fail); }
.crit .txt { font-size: 13px; }
.crit .txt .aside { color: var(--muted); font-size: 12px; }
.crit .why { font-size: 12px; color: var(--muted); margin-top: 2px; }
.crit.removed .txt { text-decoration: line-through; color: var(--muted); }
.crit .edited { font-size: 12px; margin-top: 4px; padding: 4px 8px; border-radius: 6px; background: var(--warn-soft); color: var(--warn); }
.actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.actions button { font-size: 12px; padding: 2px 9px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); cursor: pointer; }
.actions button:hover { border-color: var(--accent); }
.actions button.agree.on { background: var(--pass-soft); border-color: var(--pass); color: var(--pass); }
.actions button.disagree.on { background: var(--fail-soft); border-color: var(--fail); color: var(--fail); }
.editor { margin-top: 6px; display: grid; gap: 6px; }
.editor input[type=text], .editor textarea { width: 100%; border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; background: var(--bg); min-height: 0; }
.editor .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.editor input.layer { width: 140px; }
.primary { background: var(--accent) !important; border-color: var(--accent) !important; color: #fff !important; }
.added { font-size: 13px; padding: 6px 8px; border-radius: 6px; background: var(--accent-soft); margin-top: 6px; display: flex; gap: 8px; align-items: start; }
.added .layer-tag { font-family: var(--mono); font-size: 11px; color: var(--accent); white-space: nowrap; }
.added button { margin-left: auto; font-size: 12px; border: 0; background: none; color: var(--muted); cursor: pointer; }
.empty { color: var(--muted); padding: 40px; text-align: center; }
kbd { font-family: var(--mono); font-size: 11px; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; }
`

/** DOM builder, escaping and a deliberately small Markdown renderer (everything escaped first). */
export const PAGE_HELPERS_JS = `const $ = (id) => document.getElementById(id)
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid))
  return el
}
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// Deliberately small Markdown: enough for articles, and everything is escaped first.
function inline(s) {
  return esc(s)
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\\*([^*\\n]+)\\*/g, '$1<em>$2</em>')
}
function markdown(src) {
  const lines = (src || '').replace(/\\r/g, '').split('\\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    if (/^\`\`\`/.test(l)) {
      const buf = []; i++
      while (i < lines.length && !/^\`\`\`/.test(lines[i])) buf.push(lines[i++])
      i++; out.push('<pre><code>' + esc(buf.join('\\n')) + '</code></pre>'); continue
    }
    let m
    if ((m = l.match(/^(#{1,6})\\s+(.*)$/))) { const n = Math.min(4, m[1].length); out.push('<h' + n + '>' + inline(m[2]) + '</h' + n + '>'); i++; continue }
    if (/^\\s*(---|\\*\\*\\*)\\s*$/.test(l)) { out.push('<hr>'); i++; continue }
    if (/^\\s*\\|/.test(l)) {
      const rows = []
      while (i < lines.length && /^\\s*\\|/.test(lines[i])) rows.push(lines[i++])
      const cells = (r) => r.trim().replace(/^\\||\\|$/g, '').split('|').map((c) => inline(c.trim()))
      const body = rows.filter((r) => !/^\\s*\\|[\\s:|-]+\\|?\\s*$/.test(r))
      out.push('<table>' + body.map((r, k) => '<tr>' + cells(r).map((c) => (k ? '<td>' : '<th>') + c + (k ? '</td>' : '</th>')).join('') + '</tr>').join('') + '</table>')
      continue
    }
    if (/^>\\s?/.test(l)) {
      const buf = []
      while (i < lines.length && /^>\\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\\s?/, ''))
      out.push('<blockquote>' + markdown(buf.join('\\n')) + '</blockquote>'); continue
    }
    if (/^\\s*([-*]|\\d+\\.)\\s+/.test(l)) {
      const ordered = /^\\s*\\d+\\./.test(l), buf = []
      while (i < lines.length && /^\\s*([-*]|\\d+\\.)\\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\\s*([-*]|\\d+\\.)\\s+/, ''))
      const t = ordered ? 'ol' : 'ul'
      out.push('<' + t + '>' + buf.map((b) => '<li>' + inline(b) + '</li>').join('') + '</' + t + '>'); continue
    }
    if (!l.trim()) { i++; continue }
    const buf = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\\s|\`\`\`|>|\\s*\\||\\s*([-*]|\\d+\\.)\\s)/.test(lines[i])) buf.push(lines[i++])
    out.push('<p>' + inline(buf.join('\\n')).replace(/\\n/g, '<br>') + '</p>')
  }
  return out.join('\\n')
}

`

/**
 * The single-file review UI served by `agentfoo review` (see review.ts).
 * Self-contained on purpose: no CDN or font requests, so it works offline and
 * nothing about the run leaves the machine.
 */
export const REVIEW_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agentfoo review</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="app">
  <header>
    <h1>agentfoo review</h1>
    <span class="run" id="run"></span>
    <span class="stat">reviewed <b id="done">0</b>/<b id="total">0</b></span>
    <span class="stat">judge agreement <b id="agree">–</b></span>
    <span class="stat hint"><kbd>j</kbd>/<kbd>k</kbd> move · <kbd>1</kbd>–<kbd>5</kbd> rate</span>
    <span class="save" id="save">loading…</span>
  </header>
  <aside>
    <div class="filters">
      <select id="f-state"><option value="">all states</option><option value="fail">failed</option><option value="pass">passed</option></select>
      <select id="f-done"><option value="">all</option><option value="todo">not reviewed</option><option value="done">reviewed</option></select>
      <select id="f-meta"></select>
    </div>
    <div id="list"></div>
  </aside>
  <main id="main"><div class="empty">Loading run…</div></main>
</div>
<script>
const LAYERS = ['mustHave', 'coverage', 'mustNot', 'quality']
let data = null, review = null, current = null, saveTimer = null

${PAGE_HELPERS_JS}
// Criteria often end in a long parenthetical grading instruction; keep it, but quieter.
function criterionText(c) {
  const m = c.match(/^([\\s\\S]*?)(（[^（）]*）|\\([^()]*\\))\\s*$/)
  return m && m[1].trim() ? [m[1], ' ', h('span', { class: 'aside' }, m[2])] : [c]
}

const caseReview = (name) => (review.cases[name] ||= {})
const isDone = (name) => !!(review.cases[name] && review.cases[name].rating)

function scheduleSave() {
  $('save').textContent = 'unsaved…'; $('save').className = 'save'
  clearTimeout(saveTimer)
  saveTimer = setTimeout(save, 500)
}
async function save() {
  try {
    const res = await fetch('/api/review', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(review) })
    const body = await res.json()
    if (!body.ok) throw new Error(body.error)
    $('save').textContent = 'saved ' + new Date().toLocaleTimeString(); $('save').className = 'save'
  } catch (err) {
    $('save').textContent = 'save failed: ' + err.message; $('save').className = 'save err'
  }
  renderStats(); renderList()
}

function renderStats() {
  $('done').textContent = data.cases.filter((c) => isDone(c.name)).length
  $('total').textContent = data.cases.length
  let a = 0, d = 0
  for (const c of Object.values(review.cases)) for (const v of Object.values(c.verdicts || {})) v === 'agree' ? a++ : d++
  $('agree').textContent = a + d ? Math.round((100 * a) / (a + d)) + '% (' + a + '/' + (a + d) + ')' : '–'
}

function visibleCases() {
  const st = $('f-state').value, dn = $('f-done').value, mt = $('f-meta').value
  return data.cases.filter((c) =>
    (!st || c.state === st) &&
    (!dn || (dn === 'done') === isDone(c.name)) &&
    (!mt || Object.entries(c.meta).some(([k, v]) => k + '=' + v === mt)))
}

function renderList() {
  const list = $('list'); list.replaceChildren()
  for (const c of visibleCases()) {
    const r = review.cases[c.name]
    list.append(h('div', { class: 'case-item' + (current === c.name ? ' active' : ''), onclick: () => select(c.name) },
      h('span', { class: 'dot ' + c.state }),
      h('span', { class: 'nm', title: c.name }, c.name),
      h('span', { class: 'rt' + (r && r.rating ? ' done' : '') }, r && r.rating ? r.rating + '/5' : '')))
  }
}

function select(name) { current = name; renderList(); renderCase(); $('main').scrollTop = 0 }

function renderCase() {
  const c = data.cases.find((x) => x.name === current)
  const main = $('main'); main.replaceChildren()
  if (!c) { main.append(h('div', { class: 'empty' }, 'Pick a case on the left.')); return }
  const r = caseReview(c.name)

  const article = h('div', { class: 'article' }); article.innerHTML = markdown(c.finalMessage) || '<p class="hint">(empty answer)</p>'

  const stars = h('div', { class: 'stars' }, [1, 2, 3, 4, 5].map((n) =>
    h('button', { class: r.rating === n ? 'on' : '', title: n + '/5', onclick: () => { rate(n) } }, n)))
  const comment = h('textarea', { placeholder: 'What is good or wrong about this answer? What should the skill do differently?' })
  comment.value = r.comment || ''
  comment.addEventListener('input', () => { r.comment = comment.value; r.reviewedAt = new Date().toISOString(); scheduleSave() })

  main.append(
    h('div', { class: 'case-head' },
      h('h2', {}, c.name),
      h('span', { class: 'badge ' + c.state }, c.state === 'pass' ? 'passed' : 'failed'),
      Object.entries(c.meta).map(([k, v]) => h('span', { class: 'chip' }, k + ': ' + v))),
    h('div', { class: 'grid' },
      h('div', {},
        h('div', { class: 'panel' }, h('h3', {}, 'Prompt'), h('div', { class: 'prompt' }, c.prompt || '(not recorded)')),
        h('div', { class: 'panel' }, h('h3', {}, 'Agent answer'), article)),
      h('div', {},
        h('div', { class: 'panel' },
          h('h3', {}, 'Your rating'), stars,
          h('div', { class: 'hint', style: 'margin:-4px 0 8px' }, '1 = unusable · 3 = acceptable · 5 = what a great science writer would produce'),
          comment),
        h('div', { class: 'panel' }, h('h3', {}, 'Judge verdicts & evaluation points'),
          c.judges.length ? c.judges.map((j) => renderGrading(c, j)) : h('div', { class: 'hint' }, 'No gradings (e.g. a trigger-only case).'),
          renderAdd(c)))))
}

function rate(n) {
  const r = caseReview(current)
  r.rating = r.rating === n ? undefined : n
  r.reviewedAt = new Date().toISOString()
  scheduleSave(); renderCase(); renderList()
}

function editsFor(name) { return (caseReview(name).criteriaEdits ||= []) }

function renderGrading(c, j) {
  const r = caseReview(c.name)
  return h('div', { class: 'grading' },
    h('div', { class: 'grading-head' },
      h('span', {}, 'Grading ' + j.index),
      h('span', { class: 'sc ' + (j.passed ? 'pass' : 'fail') }, j.score.toFixed(2) + (j.passed ? ' ≥ ' : ' < ') + j.threshold),
      j.samples > 1 ? h('span', { class: 'hint' }, '±' + j.stdev.toFixed(2) + ' over ' + j.samples) : null,
      h('span', { class: 'hint' }, j.model)),
    j.breakdown.map((b, i) => {
      const key = j.index + ':' + (i + 1)
      const verdict = (r.verdicts || {})[key]
      const edit = editsFor(c.name).find((e) => e.judge === j.index && e.criteria === b.criteria && e.action !== 'add')
      const box = h('div', {})
      const setVerdict = (v) => {
        r.verdicts ||= {}
        if (r.verdicts[key] === v) delete r.verdicts[key]; else r.verdicts[key] = v
        r.reviewedAt = new Date().toISOString(); scheduleSave(); renderCase()
      }
      const openEditor = () => {
        const text = h('textarea', { rows: 2 }); text.value = edit && edit.text ? edit.text : b.criteria
        const layer = h('input', { type: 'text', class: 'layer', list: 'layers', placeholder: 'layer (optional)', value: edit && edit.layer || '' })
        box.replaceChildren(h('div', { class: 'editor' }, text, h('div', { class: 'row' }, layer,
          h('button', { class: 'primary', onclick: () => { upsertEdit(c.name, { action: 'edit', criteria: b.criteria, judge: j.index, text: text.value.trim(), layer: layer.value.trim() || undefined }) } }, 'Save'),
          h('button', { onclick: () => renderCase() }, 'Cancel'))))
      }
      return h('div', { class: 'crit' + (edit && edit.action === 'remove' ? ' removed' : '') },
        h('span', { class: 'ic ' + (b.met ? 'met' : 'unmet') }, b.met ? '✓' : '✗'),
        h('div', {},
          h('div', { class: 'txt' }, criterionText(b.criteria)),
          b.reason ? h('div', { class: 'why' }, 'judge: ' + b.reason + (b.metRate != null ? ' (met ' + Math.round(b.metRate * j.samples) + '/' + j.samples + ')' : '')) : null,
          edit && edit.action === 'edit' ? h('div', { class: 'edited' }, '→ ' + edit.text + (edit.layer ? '  [' + edit.layer + ']' : '')) : null,
          h('div', { class: 'actions' },
            h('button', { class: 'agree' + (verdict === 'agree' ? ' on' : ''), onclick: () => setVerdict('agree') }, 'Judge right'),
            h('button', { class: 'disagree' + (verdict === 'disagree' ? ' on' : ''), onclick: () => setVerdict('disagree') }, 'Judge wrong'),
            h('button', { onclick: openEditor }, edit && edit.action === 'edit' ? 'Re-edit point' : 'Edit point'),
            h('button', { onclick: () => edit && edit.action === 'remove' ? dropEdit(c.name, edit) : upsertEdit(c.name, { action: 'remove', criteria: b.criteria, judge: j.index }) },
              edit && edit.action === 'remove' ? 'Keep point' : 'Remove point'),
            edit && edit.action === 'edit' ? h('button', { onclick: () => dropEdit(c.name, edit) }, 'Undo edit') : null),
          box))
    }))
}

function upsertEdit(name, e) {
  const list = editsFor(name)
  const i = list.findIndex((x) => x.action !== 'add' && x.judge === e.judge && x.criteria === e.criteria)
  if (i >= 0) list[i] = e; else list.push(e)
  caseReview(name).reviewedAt = new Date().toISOString(); scheduleSave(); renderCase()
}
function dropEdit(name, e) {
  const list = editsFor(name); list.splice(list.indexOf(e), 1); scheduleSave(); renderCase()
}

function renderAdd(c) {
  const added = editsFor(c.name).filter((e) => e.action === 'add')
  const text = h('input', { type: 'text', placeholder: 'A new evaluation point this case should check…' })
  const layer = h('input', { type: 'text', class: 'layer', list: 'layers', placeholder: 'layer, e.g. mustHave' })
  return h('div', { class: 'grading' },
    h('div', { class: 'grading-head' }, h('span', {}, 'Add an evaluation point')),
    added.map((e) => h('div', { class: 'added' }, h('span', { class: 'layer-tag' }, e.layer || '—'), h('span', {}, e.text),
      h('button', { title: 'remove', onclick: () => dropEdit(c.name, e) }, '✕'))),
    h('div', { class: 'editor' }, text, h('div', { class: 'row' }, layer,
      h('button', { class: 'primary', onclick: () => {
        if (!text.value.trim()) return
        editsFor(c.name).push({ action: 'add', text: text.value.trim(), layer: layer.value.trim() || undefined })
        caseReview(c.name).reviewedAt = new Date().toISOString(); scheduleSave(); renderCase()
      } }, 'Add'))))
}

document.addEventListener('keydown', (e) => {
  if (!data || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return
  const vis = visibleCases(), i = vis.findIndex((c) => c.name === current)
  if (e.key === 'j' && i < vis.length - 1) select(vis[i + 1].name)
  else if (e.key === 'k' && i > 0) select(vis[i - 1].name)
  else if (/^[1-5]$/.test(e.key) && current) rate(Number(e.key))
})
for (const id of ['f-state', 'f-done', 'f-meta']) $(id).addEventListener('change', renderList)

fetch('/api/run').then((r) => r.json()).then((d) => {
  data = d; review = d.review || { cases: {} }; review.cases ||= {}
  $('run').textContent = d.runId
  const metas = [...new Set(d.cases.flatMap((c) => Object.entries(c.meta).map(([k, v]) => k + '=' + v)))].sort()
  $('f-meta').append(h('option', { value: '' }, 'all tags'), metas.map((m) => h('option', { value: m }, m)))
  document.body.append(h('datalist', { id: 'layers' }, LAYERS.map((l) => h('option', { value: l }))))
  $('save').textContent = 'saved to review.json'
  renderStats(); renderList()
  const first = d.cases.find((c) => c.state === 'fail') || d.cases[0]
  if (first) select(first.name)
}).catch((err) => { $('main').replaceChildren(h('div', { class: 'empty' }, 'Could not load run: ' + err.message)) })
</script>
</body>
</html>
`
