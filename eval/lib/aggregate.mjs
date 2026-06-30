// records + grades → (model × arm) スコアボード。3 軸 (①cache ②quality ③speed) を集計。
import { resolve } from 'node:path';
import { readdirSync, writeFileSync, existsSync } from 'node:fs';
import { config } from '../config.mjs';
import { readJSON, ensureDir } from './util.mjs';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r2 = (x) => Math.round(x * 100) / 100;

export function collect() {
  const out = [];
  if (!existsSync(config.resultsDir)) return out;
  for (const runId of readdirSync(config.resultsDir)) {
    const rec = readJSON(resolve(config.resultsDir, runId, 'record.json'));
    if (!rec) continue;
    rec.grade = readJSON(resolve(config.resultsDir, runId, 'grade.json'), null);
    out.push(rec);
  }
  return out;
}

function cell(recs) {
  const ok = recs.filter((r) => r.ok && !r.diffEmpty);
  const graded = ok.map((r) => r.grade).filter((g) => g && g.graded);
  const avoid = (cls) => {
    const vals = [];
    for (const g of graded) for (const [id, v] of Object.entries(g.footguns || {})) {
      const def = (readJSON(config.rubricFile).footguns || []).find((f) => f.id === id);
      if (def && def.class === cls && v && typeof v.tripped === 'boolean') vals.push(v.tripped ? 0 : 1);
    }
    return vals.length ? mean(vals) : null;
  };
  const axis = (id) => { const v = graded.map((g) => g.axes?.[id]?.score).filter((s) => typeof s === 'number'); return v.length ? r2(mean(v)) : null; };
  const findingsWeighted = graded.map((g) => (g.findings || []).reduce((a, f) => a + ({ high: 3, med: 2, low: 1 }[f.severity] || 1), 0));
  return {
    n: recs.length, ok: ok.length,
    // ② quality
    avoid_anatomia: avoid('anatomia') == null ? null : r2(avoid('anatomia')),
    avoid_outcome: avoid('outcome') == null ? null : r2(avoid('outcome')),
    domain_landing: axis('domain_landing'), exemplar: axis('exemplar_adherence'),
    completeness: axis('completeness'), correctness: axis('correctness'),
    findingsWeighted: r2(mean(findingsWeighted)),
    verifyFires: r2(mean(ok.map((r) => (r.verifyFired || []).length))),
    // ③ speed
    wallS: r2(mean(ok.map((r) => r.wallMs / 1000))),
    overheadS: r2(mean(ok.map((r) => (r.anatomiaOverheadMs || 0) / 1000))),
    turns: r2(mean(ok.map((r) => r.agent?.numTurns || 0))),
    costUsd: r2(mean(ok.map((r) => r.agent?.costUsd || 0))),
    // ① cache (記述)
    cacheHitRate: r2(mean(ok.map((r) => r.cache?.hitRate || 0))),
    cacheLlmCalls: r2(mean(ok.map((r) => r.cache?.llmCalls || 0))),
  };
}

export function aggregate() {
  const recs = collect();
  const cells = {};
  for (const m of config.models) for (const a of config.arms) {
    cells[`${m}|${a}`] = cell(recs.filter((r) => r.model === m && r.arm === a));
  }
  const date = new Date().toISOString().slice(0, 10);
  const md = render(cells, recs, date);
  ensureDir(config.resultsDir);
  writeFileSync(resolve(config.resultsDir, 'scoreboard.md'), md, 'utf8');
  writeFileSync(resolve(config.resultsDir, 'scoreboard.json'), JSON.stringify({ date, cells, n: recs.length }, null, 2), 'utf8');
  // Review/ へ集約 (task 別)
  const reviewDir = resolve(config.arsRoot, 'Review/Anatomia-eval', date, config.task);
  ensureDir(reviewDir);
  writeFileSync(resolve(reviewDir, 'scoreboard.md'), md, 'utf8');
  return { md, reviewDir };
}

function render(cells, recs, date) {
  const L = [`# Anatomia eval scoreboard — ${config.task} — ${date}`, '', `runs: ${recs.length} (ok: ${recs.filter((r) => r.ok && !r.diffEmpty).length})`, ''];
  for (const m of config.models) {
    L.push(`## ${m}`, '');
    L.push('| arm | ②avoid(anat/out) | landing | exemplar | complete | correct | findings | verifyFires | ③wall(s) | overhead(s) | turns | cost$ | ①hit% | llm |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const a of config.arms) {
      const c = cells[`${m}|${a}`];
      L.push(`| ${a} | ${c.avoid_anatomia ?? '-'} / ${c.avoid_outcome ?? '-'} | ${c.domain_landing ?? '-'} | ${c.exemplar ?? '-'} | ${c.completeness ?? '-'} | ${c.correctness ?? '-'} | ${c.findingsWeighted} | ${c.verifyFires} | ${c.wallS} | ${c.overheadS} | ${c.turns} | ${c.costUsd} | ${r2((c.cacheHitRate || 0) * 100)} | ${c.cacheLlmCalls} | (n=${c.ok}/${c.n}) |`);
    }
    L.push('');
  }
  L.push('## 読み方', '- ②avoid = footgun 回避率 (anatomia系/outcome系, 1.0=全回避)。 off→both で上がれば supply/verify が効いている。',
    '- ③overhead = Anatomia フックの追加遅延 (秒)。wall(s) の off vs on 差と合わせて「介在コスト vs 手戻り(turns)削減」を読む。',
    '- ①hit%/llm = run 中の Anatomia 蒸留キャッシュ命中率と LLM 呼び出し数 (記述用、主測定は cache-microbench)。');
  return L.join('\n');
}
