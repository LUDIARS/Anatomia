# feature: 解析を回す操作手順（解析して使う中核ループ）

Anatomia を実際に動かしてコードベースを解析し、AI のクリーンコード生成に使うまでの操作手順。
（旧 `spec/usage/analysis-procedure.md` の操作手順をここへ移設。env/依存は
[setup/environment.md](../setup/environment.md)、契約は interface/ を参照。）

設計の正本は `DESIGN.md`、タスクは `TASKS.md`、MCP 接続は `docs/mcp-setup.md`、
MCP を使わない Skill 接続は Ars 配下のスキル `anatomia-analyze`。

## 0. 前提：ビルド

`bin/anatomia.mjs` / `bin/anatomia-mcp.mjs` は `dist/` を読む（`.ts` ソースではない）。
コード変更後は必ずビルドする。

```sh
npm install
npm run build      # tsc → dist/
```

## 1. 静的解析（核）

`analyze(repoPath)` が G1→G5 を一気通貫で走らせる（パイプライン詳細は
[feature/static-analysis.md](./static-analysis.md)）。

### ルート A：単発解析（その場の repo を見る）

```sh
node bin/anatomia.mjs context --repo <path> --task "freeze effect を追加"
node bin/anatomia.mjs export-graph <path> -o graph.html
```

### ルート B：プロジェクト登録（キャッシュ前提・複数リポ）

登録すると Anatomia home に Merkle キャッシュが効き、変更が無ければ再解析がヒットで即返る。

```sh
node bin/anatomia.mjs project add adventure <path-to-AdventureCube>
node bin/anatomia.mjs project list
node bin/anatomia.mjs project analyze adventure   # → "N files, M functions (cache hit)"
```

以後 `--project adventure` を各サブコマンドに付けると、登録 root を解析対象にする。

## 2. サブコマンド別の用途

サブコマンドの一覧・フラグ・終了コードは [interface/cli.md](../interface/cli.md)。
**verify は stdin から diff を受ける**（検証ループの肝）：

```sh
git diff | node bin/anatomia.mjs verify --project adventure --json
echo $?    # 0=PASS / 1=block ゲート失敗
```

`--json` で生 JSON、無指定なら人間向けサマリ（`PASS/FAIL` + ゲート別 + suggestion）。

## 3. 実 LLM / embedder を効かせる（任意）

未設定なら duplication ゲートは hash-embedder + mock カードで動作（hermetic・API 不要）。
実プロバイダ・キャッシュ・計測の環境変数は [setup/environment.md](../setup/environment.md)。

## 4. AI に接続する 2 経路

生成前に文脈を supply、生成後に verify する「重心」ループを AI ホストから回す経路は 2 つ。

- **MCP（常駐サーバ）**: `.mcp.json` に `bin/anatomia-mcp.mjs` を登録し 7 ツールを公開
  （→ [interface/mcp.md](../interface/mcp.md)、設定は `docs/mcp-setup.md`）。
- **Skill（MCP 不要・CLI ラッパ）**: Claude Code のスキル `anatomia-analyze` から CLI を直接叩く。
  常駐プロセス不要・設定ゼロ。

## 5. 自己解析（dogfood）・計測

```sh
npm run measure                 # scripts/measure.mjs：ハッシュ命中率 / 束決定性 / verify 精度
node scripts/self-analyze.mjs   # 自分の src/ を解析（→ docs/self-analysis.md の数値）
```

## 6. 動的解析（実行トレース → 局面）

動的層（`src/dynamic/`）は現状ライブラリ API のみ（CLI 未配線）。詳細は
[feature/dynamic-trace-and-phase.md](./dynamic-trace-and-phase.md)。

## 最短ループ

```
npm run build → project add → project analyze → git diff | verify
```

これが Anatomia の「解析して使う」中核ループ。

## ドメインを発見・承認する

プロジェクト固有 ontology を作るときは、LLM draft や retune をそのまま権威データへ
流さず、[人間承認付きドメイン発見ワークフロー](./domain-discovery-workflow.md)を使う。

```text
spec proposal → 人間編集 → Gate A → 未所属 function/module 調査
              → 大きい孤立群 proposal + spec draft → 人間補足 → Gate B
              → 再解析 → 残余未所属関数 file:line
```

proposal / inspect は read-only。apply は `confirmApply` と提案時 `snapshotId` が必要で、
解析対象が変わっていれば stale として再提案する。孤立とは「承認済みドメインに未所属」を
指し、unresolved call / unreachable code とは別に表示する。
