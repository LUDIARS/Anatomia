# Integral Search — 3 層スコープ検索

## 目的

ユーザ/エージェントが「やりたい領域」から作業を始めるとき、最初に読むべき
**必要点をまとめる**第一手。エントリ点から **構造グラフ → 機能(module) →
ドメイン → シーンステート** の包含鎖を、探索範囲の枠内で**決定的に**辿り、層
ごとの束を返す。LLM・embedding を使わないので キャッシュ安全・高速。**努力値:
本体(Phase A)は 10 秒以内**。その後、束をどこまで使うかを Sonnet エージェントが
判断し(Phase B)、辿った経路を結果としてキャッシュする(Phase C)。

## 層の境界 (DESIGN 課題2)

typed stable ID と canonical Scene の記述は planned contract（T55/T66）。現行 Integral は既存
`AnchorId` / `SceneRef` と、adapter が渡す `SceneModel` を消費する。現行の供給元はトレース
（`sceneModelFromTraceFile` / `sceneModelFromTrace`）だけで、CLI `integral` は
`emptySceneModel()` を渡す（`src/adapters/cli.ts` / `src/adapters/web/routes/integral.ts`）。
目標の scene authority は [scene derivation](./scene-derivation.md)、実装順は
[`../../docs/plan-okf-domain-scene-flow.md`](../../docs/plan-okf-domain-scene-flow.md) を参照する。

同じ typed knowledge graph 上の **直交する分割**。CodeSymbol は Anchor ID evidence、
Domain / SpecClause / Scene は各 stable ID を持つ:

| 層 | 何の分割か | 性質 |
|---|---|---|
| 構造グラフ | call/data DAG (関数=Anchor, 辺=calls/reads/…) | 常在・接地真実 |
| 機能 (module) | 構造の凝集単位 (ディレクトリ / クラス) | 決定的・[[module-layer]] |
| ドメイン | 意味的分割 (仕様由来・人手調整) | 静的・重複可・再構成可 |
| シーン | code/asset の runtime context が複数ドメインを activate | 静的定義 + trace observation |

探索方向: `scene → {active code} → {owned domain}`（逆引きも可）。機能はドメインに属し、ドメインは
複数機能にまたがる。**シーンとドメインは直交**(ドメインにシーン状態を含めない)が、
シーンの active-domain が単集合のとき `scene ≈ domain` の一致を**注記**する。
subscene と subdomain の ancestor traversal は別 edge kind を使う。

## Agent 入力フォーマット (固定 3 部)

```ts
interface IntegralQuery {
  entry: { ref: string; scope: "function" | "domain" | "scene" };  // ① 初回に見る点+スコープ
  graph?: { seedAnchors?; knownDomains?; knownScenes? };           // ② 関連グラフ情報
  range?: { maxHops?; maxNodes?; budgetMs?; climb? };              // ③ 探索範囲
}
```

`ref` は寛容に解決: AnchorId / 関数名 / `file:line` / ファイルパス / ドメイン名 /
シーン id。曖昧名は全一致を anchor 昇順で決定的に返す。

## Phase A — integral search (決定的, ≤10s)

1. `entry` を seed anchor に解決。
2. `climb` レベルまで包含鎖を辿る:
   - `function` … seeds + グラフ半径 (maxHops, 両方向)
   - `module` … + seed の属する機能まるごと
   - `domain` … + seed が属するドメイン
   - `scene` … + その function/domain を activate する scene（T66 後は canonical manifest）
   - `scene-adjacent` (既定) … + シーン内の**他**ドメイン
3. `maxNodes` / `budgetMs` を超えたら停止し `truncated` + `stopReason` を立てる
   (**サイレントな打ち切り禁止**)。
4. 出力 `IntegralResult`: seeds / anchors(層タグ付き) / **modules(凝集つき)** /
   domains / scenes / specClauses / rules / contentKey。

`domains` とそこから選ぶ `rules` は semantic project domain に限定する。policy evaluation は
Integral の domain/scene/seed として表示せず、rule/violation は Verify・Supply・Review の各経路で保持する。

`contentKey = sha256(seeds⊕range)`。

## Phase B — Sonnet スコープ判断 (任意)

3 部入力 + Phase A 結果を Sonnet に渡し `ScopeDecision`(sufficientScope /
keepAnchors / keepDomains / reason / confidence / **answer**)を得る。束だけで
タスクが解けるとき `answer` に自己完結回答を返す(ブラックボックスケース)。
判断器は Anatomia 内蔵プロバイダ(既定 `claude-sonnet-4-6`)で動き、MCP/HTTP から
ヘッドレスに動作する。

## Phase C — パスキャッシュ

`judgeInput = assembleJudgePrompt(query, result)` とし、
`key = versionedKey(judgeInput + "\0" + fingerprint, model, JUDGE_PROMPT_VERSION)`。
`judgeInput` は query と Phase A の完全な結果（domain / scene の表示を含む）から決定的に組み立てる。
content-addressed `CacheStore`(memory/file/redis)に `{result, decision}` を保存し、
**LLM の prompt キャッシュが消えた後の再調査**でも Sonnet を呼ばず replay する。
fingerprint によってソース変更で失効し、judgeInput によって domain / scene の意味割当や
探索結果が変わった場合も、同じソース fingerprint のまま旧判断を再利用しない。

## 取得面

- CLI: `anatomia integral --project <id> --entry <ref> --scope <function|domain|scene>
  [--climb <lvl>] [--max-hops N] [--max-nodes N] [--judge] [--json]`
- HTTP(warm): `POST /api/integral { project?, entry, graph?, range?, judge? }`
  / `GET /api/projects/:id/modules`

## 限界

- **現行**: Integral のシーン層はトレース録画が要る。トレース未供給なら空シーンに
  **graceful 縮退**し、構造+機能+ドメインで動く（`scenesFromPhaseSignatures` で局面学習に接続可）。
  `scenes/derive.ts` の静的シーンは web-cache / `anatomia scenes` 側の消費で、Integral には未配線。
- **planned**（T66）: シーン層を code/asset から静的に構築し、trace 録画を必須にしない。
  detector 未対応時だけ空シーンへ縮退し、trace phase は canonical scene への observation
  evidence として接続する。
- 機能粒度は決定的構造単位(再クラスタリングしない)。低凝集は signal として surface。
- 呼び出し解決の偽辺(汎用名)は構造グラフ側の既知限界([[static-analysis]])を継承。
