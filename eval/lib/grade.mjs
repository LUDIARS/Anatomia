// 独立レビュア採点。arm/model を伏せ、diff + rubric だけ渡す。grader は workspace を
// 読んで既存規約と突き合わせできる (run 直後・次の reset 前に呼ぶこと)。
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { config } from '../config.mjs';
import { run, readJSON } from './util.mjs';

function extractJSON(text) {
  if (typeof text !== 'string') return null;
  const s = text.indexOf('{'); const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}
function parseResult(stdout) {
  try { const a = JSON.parse(stdout); if (Array.isArray(a)) return a.find((x) => x?.type === 'result') || null; } catch { /* */ }
  return null;
}

function buildPrompt(rubric, diff) {
  return [
    'あなたはコードレビューの審査員です。以下の「タスク」に対する diff を、与えた rubric で採点してください。',
    'どの実験条件で生成されたかは伏せられています。先入観なく diff と既存コードだけで判断してください。',
    'カレントディレクトリは対象リポジトリです。既存の規約・kill-switch 実装を Read/Grep で確認してよい。',
    '',
    `# タスク\n${rubric.task}`,
    '',
    `# Rubric (footguns / axes / 出力スキーマ)\n\`\`\`json\n${JSON.stringify(rubric, null, 2)}\n\`\`\``,
    '',
    '# 採点対象 diff',
    '```diff',
    diff.length > 60000 ? diff.slice(0, 60000) + '\n...(truncated)...' : diff,
    '```',
    '',
    '# 出力',
    'output_schema に厳密に従う **JSON オブジェクトだけ** を出力してください (前後に文章を付けない)。',
    'footguns は各 id について tripped(boolean)+evidence、axes は各 id について score(0-5)+note、',
    'findings は配列、summary は一文。',
  ].join('\n');
}

export async function gradeRun(record) {
  const dir = resolve(config.resultsDir, record.runId);
  const diffPath = resolve(dir, 'diff.patch');
  if (!existsSync(diffPath)) return { graded: false, reason: 'no diff' };
  const diff = readFileSync(diffPath, 'utf8');
  if (!diff.trim()) { const g = { graded: false, reason: 'empty diff' }; writeFileSync(resolve(dir, 'grade.json'), JSON.stringify(g, null, 2)); return g; }

  const rubric = readJSON(config.rubricFile);
  const prompt = buildPrompt(rubric, diff);
  const env = { ...process.env, CLAUDE_CODE_GIT_BASH_PATH: config.gitBash };
  // grader は anatomia フックを無効化 (ANATOMIA_HOOKS を渡さない)
  delete env.ANATOMIA_HOOKS;
  const res = await run('claude', [
    '-p', '--model', config.graderModel, '--output-format', 'json', '--dangerously-skip-permissions',
  ], { input: prompt, timeoutMs: 8 * 60 * 1000, cwd: config.workspace, env });

  const result = parseResult(res.stdout);
  const grade = extractJSON(result?.result) || { graded: false, reason: 'unparseable', raw: (result?.result || '').slice(0, 1000) };
  grade.graded = grade.graded !== false;
  grade.graderCostUsd = result?.total_cost_usd;
  writeFileSync(resolve(dir, 'grade.json'), JSON.stringify(grade, null, 2), 'utf8');
  return grade;
}
