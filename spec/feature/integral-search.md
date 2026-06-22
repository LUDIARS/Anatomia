# Integral Search — 3 層スコープ検索

## 目的

ユーザ/エージェントが「やりたい領域」から作業を始めるとき、最初に読むべき
**必要点をまとめる**第一手。エントリ点から **構造グラフ → 機能(module) →
ドメイン → シーンステート** の包含鎖を、探索範囲の枠内で**決定的に**辿り、層
ごとの束を返す。LLM・embedding を使わないので キャッシュ安全・高速。**努力値:
本体(Phase A)は 10 秒以内**。その後、束をどこまで使うかを Sonnet エージェントが
判断し(Phase B)、辿った経路を結果としてキャッシュする(Phase C)。

## 層の境界 (DESIGN 課題2)

同一 AnchorId 基盤上の **直交する分割**:

| 層 | 何の分割か | 性質 |
|---|---|---|
| 構造グラフ | call/data DAG (関数=Anchor, 辺=calls/reads/…) | 常在・接地真実 |
| 機能 (module) | 構造の凝集単位 (ディレクトリ / クラス) | 決定的・[[module-layer]] |
| ドメイン | 意味的分割 (仕様由来・人手調整) | 静的・重複可・再構成可 |
| シーンステート | 局面 (phase/FSM, 動的層) が複数ドメインを activate | 動的・トレース由来 |

包含方向: `scene → {active domain} → {function}`。機能はドメインに属し、ドメインは
複数機能にまたがる。**シーンとドメインは直交**(ドメインにシーン状態を含めない)が、
シーンの active-domain が単集合のとき `scene ≈ domain` の一致を**注記**する。

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
   - `scene` … + そのドメインを activate するシーン
   - `scene-adjacent` (既定) … + シーン内の**他**ドメイン
3. `maxNodes` / `budgetMs` を超えたら停止し `truncated` + `stopReason` を立てる
   (**サイレントな打ち切り禁止**)。
4. 出力 `IntegralResult`: seeds / anchors(層タグ付き) / **modules(凝集つき)** /
   domains / scenes / specClauses / rules / contentKey。

`contentKey = sha256(seeds⊕range)`。

## Phase B — Sonnet スコープ判断 (任意)

3 部入力 + Phase A 結果を Sonnet に渡し `ScopeDecision`(sufficientScope /
keepAnchors / keepDomains / reason / confidence / **answer**)を得る。束だけで
タスクが解けるとき `answer` に自己完結回答を返す(ブラックボックスケース)。
判断器は Anatomia 内蔵プロバイダ(既定 `claude-sonnet-4-6`)で動き、MCP/HTTP から
ヘッドレスに動作する。

## Phase C — パスキャッシュ

`key = versionedKey(contentKey + fingerprint, model, JUDGE_PROMPT_VERSION)`。
content-addressed `CacheStore`(memory/file/redis)に `{result, decision}` を保存。
**LLM の prompt キャッシュが消えた後の再調査**でも Sonnet を呼ばず replay。
fingerprint を畳むのでソース変更で自然失効(Merkle 無効化と同じ)。

## 取得面

- CLI: `anatomia integral --project <id> --entry <ref> --scope <function|domain|scene>
  [--climb <lvl>] [--max-hops N] [--max-nodes N] [--judge] [--json]`
- HTTP(warm): `POST /api/integral { project?, entry, graph?, range?, judge? }`
  / `GET /api/projects/:id/modules`

## 限界

- シーン層はトレース録画が要る。未配線なら空シーンに **graceful 縮退**し、
  構造+機能+ドメインで動く(`scenesFromPhaseSignatures` で局面学習に接続可)。
- 機能粒度は決定的構造単位(再クラスタリングしない)。低凝集は signal として surface。
- 呼び出し解決の偽辺(汎用名)は構造グラフ側の既知限界([[static-analysis]])を継承。
