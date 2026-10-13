/**
 * source-view-logic.js — pure shaping for the "open in Tela" panel of a domain card.
 *
 * Kept free of DOM so the choices the user is offered (candidate labels, what a
 * refusal means and which next steps exist) are unit-tested. The panel in
 * index.html only renders what these functions return.
 *
 * Loaded in the browser as an ES module (`/source-view-logic.js`), which also
 * publishes the API on `window.SourceViewLogic` for the panel's classic inline
 * scripts. Imported directly by the test.
 *
 * @spec Tela source viewer launch
 */

/** `path:line  Type.name` — the label of one candidate in the picker. */
export function candidateLabel(candidate) {
  const owner = candidate.enclosingType ? candidate.enclosingType + "." : "";
  return candidate.file + ":" + candidate.line + "  " + owner + candidate.name;
}

/**
 * Which ways to open the code this machine offers, from GET /source-view/status.
 * Tela is offered only where it is installed (`configured`: viewer and font
 * exist on the server). Elsewhere the panel shows the Web view alone and says
 * nothing about setting Tela up (neco 2026-10-13「Telaはインストール済みのマシンのみ有効」).
 * The note is only for an installed Tela that cannot open for THIS request
 * (a remote or forwarded browser).
 *
 * @returns { tela: boolean, note: string | null }
 */
export function viewerChoices(status) {
  const tela = Boolean(status && status.configured === true);
  const note = tela && status.local === false && status.message ? status.message : null;
  return { tela, note };
}

/** Body of POST /source-view/launch for the chosen candidate. */
export function launchBody(candidate, acceptStale) {
  return { file: candidate.file, line: candidate.line, ...(acceptStale ? { acceptStale: true } : {}) };
}

/**
 * What to show after a launch response, and which next steps to offer.
 * Actions: "open-anyway" (re-send with acceptStale), "reanalyze", "open-first-line",
 * "retry". The file and line stay visible in every outcome so the user can still
 * find the code by hand.
 *
 * @returns { tone: "ok" | "warn" | "error", text: string, location: string | null, actions: string[] }
 */
export function launchOutcome(response) {
  const location = response && response.file ? response.file + (response.line ? ":" + response.line : "") : null;
  if (response && response.ok) {
    return {
      tone: response.stale ? "warn" : "ok",
      text: response.stale ? "Tela で開きました (解析後に変更されたファイルです)。" : "Tela で開きました。",
      location,
      actions: [],
    };
  }
  const reason = response && response.reason;
  const text = (response && response.message) || "Tela で開けませんでした。";
  const actions = {
    "stale": ["open-anyway", "reanalyze"],
    "missing-file": ["reanalyze"],
    "line-out-of-range": ["open-first-line", "reanalyze"],
    "launch-failed": ["retry"],
  }[reason] || [];
  return { tone: reason === "stale" ? "warn" : "error", text, location, actions };
}

/** Japanese button label of a next-step action. */
export function actionLabel(action) {
  return {
    "open-anyway": "現在の内容で開く",
    "reanalyze": "再解析する",
    "open-first-line": "先頭から開く",
    "retry": "もう一度試す",
  }[action] || action;
}

/**
 * Rows of the web code view: original line numbers, the requested line marked,
 * and the lines inside the enclosing function marked so its extent is visible.
 * Text stays text — the panel assigns it with textContent, never innerHTML.
 *
 * @returns Array<{ number, text, target, inFunction }>
 */
export function codeRows(content) {
  const fn = content.enclosing;
  return content.lines.map((text, index) => {
    const number = content.start + index;
    return {
      number,
      text,
      target: number === content.line,
      inFunction: !!fn && number >= fn.startLine && number <= fn.endLine,
    };
  });
}

/** Query string of GET /source-view/content for a file and line. */
export function contentQuery(file, line) {
  return "file=" + encodeURIComponent(file) + "&line=" + encodeURIComponent(String(line));
}

/** Window navigation: the line to request for the previous / next page. */
export function pageLine(content, direction) {
  const size = content.lines.length || 1;
  if (direction === "prev") return Math.max(1, content.start - 1);
  return Math.min(content.lineCount, content.start + size);
}

// Publish for the panel's classic inline scripts when loaded in a browser.
if (typeof window !== "undefined") {
  window.SourceViewLogic = { candidateLabel, viewerChoices, launchBody, launchOutcome, actionLabel, codeRows, contentQuery, pageLine };
}
