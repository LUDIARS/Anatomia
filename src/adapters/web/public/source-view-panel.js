/**
 * source-view-panel.js — the "コードを見る (Tela / Web)" panel inside a domain card.
 *
 * The picker lists every implementor of the domain (no "first file" guess).
 * "Tela で開く" asks the server to open the file in Tela on the server PC;
 * "Web で表示" renders the code here with the enclosing function highlighted and
 * its callers / callees as links. Everything stays inside the card, so the user
 * never leaves the domain. Source text is always assigned with textContent.
 *
 * DOM glue only: what to offer and how to read responses lives in
 * source-view-logic.js (pure, unit-tested). Loaded as an ES module and published
 * on `window.SourceViewPanel` for the panel's classic inline scripts.
 *
 * @spec Tela source viewer launch
 * @spec Web source view
 */

import { actionLabel, candidateLabel, codeRows, contentQuery, launchBody, launchOutcome, pageLine } from "./source-view-logic.js";

const SourceViewLogic = { actionLabel, candidateLabel, codeRows, contentQuery, launchBody, launchOutcome, pageLine };

function svApi(id, path) {
  return '/api/projects/' + encodeURIComponent(id) + '/source-view/' + path;
}

async function toggleSourceView(holder, id, domain) {
  if (holder.firstChild) { holder.innerHTML = ''; return; }
  var panel = document.createElement('div');
  panel.className = 'sv-panel';
  panel.textContent = '候補を読み込み中…';
  holder.appendChild(panel);
  var cand, status;
  try {
    cand = await (await fetch(svApi(id, 'candidates?domain=' + encodeURIComponent(domain)))).json();
    status = await (await fetch(svApi(id, 'status'))).json();
  } catch (e) {
    panel.textContent = '候補を取得できませんでした: ' + e.message;
    return;
  }
  if (!cand.ok) { panel.textContent = cand.message || '候補を取得できませんでした。'; return; }
  if (!cand.candidates.length) { panel.textContent = 'このドメインに属する関数が解析結果にありません。'; return; }
  renderSourcePicker(panel, id, cand.candidates, status);
}

function renderSourcePicker(panel, id, candidates, status) {
  panel.innerHTML = '';
  var select = document.createElement('select');
  candidates.forEach(function (c, i) {
    var o = document.createElement('option');
    o.value = String(i);
    o.textContent = SourceViewLogic.candidateLabel(c);
    select.appendChild(o);
  });
  var choices = SourceViewLogic.viewerChoices(status);
  var actions = document.createElement('div');
  actions.className = 'sv-actions';
  var tela = null;
  if (choices.tela) {
    tela = document.createElement('button');
    tela.className = 'btn-sm';
    tela.textContent = 'Tela で開く';
    actions.appendChild(tela);
  }
  var web = document.createElement('button');
  web.className = 'btn-sm';
  web.textContent = 'Web で表示';
  actions.appendChild(web);
  var note = document.createElement('div');
  note.className = 'sv-note';
  if (choices.note) note.textContent = choices.note;
  var result = document.createElement('div');
  var view = document.createElement('div');
  panel.appendChild(select);
  panel.appendChild(actions);
  panel.appendChild(note);
  panel.appendChild(result);
  panel.appendChild(view);
  var chosen = function () { return candidates[Number(select.value)]; };
  if (tela) tela.addEventListener('click', function () { launchInTela(id, chosen(), false, result); });
  web.addEventListener('click', function () { showOnWeb(id, chosen().file, chosen().line, view); });
}

async function launchInTela(id, candidate, acceptStale, result) {
  result.textContent = 'Tela を起動しています…';
  var body;
  try {
    var res = await fetch(svApi(id, 'launch'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(SourceViewLogic.launchBody(candidate, acceptStale)),
    });
    body = await res.json();
  } catch (e) {
    body = { ok: false, reason: 'launch-failed', message: '起動要求を送れませんでした: ' + e.message };
  }
  renderLaunchOutcome(id, candidate, acceptStale, result, SourceViewLogic.launchOutcome(body));
}

function renderLaunchOutcome(id, candidate, acceptStale, result, outcome) {
  result.innerHTML = '';
  var msg = document.createElement('div');
  msg.className = 'sv-msg-' + outcome.tone;
  msg.textContent = outcome.text + (outcome.location ? ' (' + outcome.location + ')' : '');
  result.appendChild(msg);
  if (!outcome.actions.length) return;
  var row = document.createElement('div');
  row.className = 'sv-actions';
  outcome.actions.forEach(function (action) {
    var b = document.createElement('button');
    b.className = 'btn-sm';
    b.textContent = SourceViewLogic.actionLabel(action);
    b.addEventListener('click', function () {
      if (action === 'open-anyway') launchInTela(id, candidate, true, result);
      else if (action === 'retry') launchInTela(id, candidate, acceptStale, result);
      else if (action === 'open-first-line') launchInTela(id, { file: candidate.file, line: 1 }, acceptStale, result);
      else if (action === 'reanalyze') result.textContent = 'プロジェクトを再解析してから、もう一度候補を開いてください。';
    });
    row.appendChild(b);
  });
  result.appendChild(row);
}

async function showOnWeb(id, file, line, view) {
  view.textContent = '読み込み中…';
  var body;
  try {
    body = await (await fetch(svApi(id, 'content?' + SourceViewLogic.contentQuery(file, line)))).json();
  } catch (e) {
    view.textContent = 'コードを取得できませんでした: ' + e.message;
    return;
  }
  if (!body.ok) { view.textContent = (body.message || 'コードを取得できませんでした。') + ' (' + file + ':' + line + ')'; return; }
  view.innerHTML = '';
  var head = document.createElement('div');
  head.className = 'sv-note';
  head.textContent = body.file + ':' + body.line + '  (' + body.start + '–' + (body.start + body.lines.length - 1) + ' / ' + body.lineCount + ' 行)' +
    (body.stale ? '  ※解析後に変更されたファイルです' : '');
  view.appendChild(head);
  var nav = document.createElement('div');
  nav.className = 'sv-actions';
  [['prev', '前へ'], ['next', '次へ']].forEach(function (pair) {
    var b = document.createElement('button');
    b.className = 'btn-sm';
    b.textContent = pair[1];
    b.disabled = pair[0] === 'prev' ? body.start <= 1 : body.start + body.lines.length > body.lineCount;
    b.addEventListener('click', function () { showOnWeb(id, body.file, SourceViewLogic.pageLine(body, pair[0]), view); });
    nav.appendChild(b);
  });
  view.appendChild(nav);
  var code = document.createElement('div');
  code.className = 'sv-code';
  var targetRow = null;
  SourceViewLogic.codeRows(body).forEach(function (r) {
    var row = document.createElement('div');
    row.className = 'sv-row' + (r.inFunction ? ' sv-fn' : '') + (r.target ? ' sv-target' : '');
    var no = document.createElement('span');
    no.className = 'sv-no';
    no.textContent = String(r.number);
    var text = document.createElement('span');
    text.textContent = r.text;
    row.appendChild(no);
    row.appendChild(text);
    code.appendChild(row);
    if (r.target) targetRow = row;
  });
  view.appendChild(code);
  if (targetRow) code.scrollTop = Math.max(0, targetRow.offsetTop - code.offsetTop - 60);
  if (!body.enclosing) return;
  var fn = body.enclosing;
  var partners = document.createElement('div');
  partners.className = 'sv-partners';
  [['呼び出し元', fn.callers], ['呼び出し先', fn.callees]].forEach(function (pair) {
    var box = document.createElement('div');
    var title = document.createElement('div');
    title.className = 'sv-note';
    title.textContent = (fn.enclosingType ? fn.enclosingType + '.' : '') + fn.name + ' の' + pair[0] + ' (' + pair[1].length + ')';
    box.appendChild(title);
    var ul = document.createElement('ul');
    pair[1].forEach(function (p) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.textContent = p.name + '  ' + p.file + ':' + p.line;
      a.addEventListener('click', function () { showOnWeb(id, p.file, p.line, view); });
      li.appendChild(a);
      ul.appendChild(li);
    });
    box.appendChild(ul);
    partners.appendChild(box);
  });
  view.appendChild(partners);
  if (fn.truncated) {
    var more = document.createElement('div');
    more.className = 'sv-note';
    more.textContent = '呼び出し関係が多いため先頭 30 件ずつ表示しています。';
    view.appendChild(more);
  }
}

if (typeof window !== "undefined") {
  window.SourceViewPanel = { toggleSourceView };
}
