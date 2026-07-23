# interface: CLI（bin/anatomia.mjs）

`bin/anatomia.mjs` → `src/adapters/cli.ts`。`dist/` をロードするので**コード変更後は
`npm run build` 必須**。SRP は arg パース + 出力整形のみ（解析は core.ts、プロジェクト
ライフサイクルは ProjectManager）。

## サブコマンド

```
anatomia <verify|context|where|find|callers|callees|review|spec-review|domain-review|
          project|export-graph|web|cache-stats|integral|domains|trace|screens|scenes|links> [flags]
```

| サブコマンド | 何をする | 出力 / 終了コード |
|---|---|---|
| `verify` | diff を 5 ゲート検証（→ feature/verify-gates.md） | block 失敗で **exit 1**、PASS は 0 |
| `context --task <t>` | タスク用 ContextBundle を組む | JSON / 0 |
| `where --task <t>` | 着地点（landing）を解決 | `{ landings }` JSON / 0 |
| `find <name>` | シンボル検索（→ feature/symbol-navigation.md） | ヒット一覧 / 0 |
| `callers <name>` / `callees <name>` | 直接 caller / callee | ヒット一覧 / 0 |
| `review` | コード構造レビュー（→ feature/code-review.md） | レポート / 0 |
| `spec-review` | spec/ の AIFormat 監査（→ feature/spec-review.md） | レポート / 0 |
| `domain-review` | ドメイン健全性レビュー（→ feature/domain-review.md） | レポート / 0 |
| `export-graph -o <f>` | 自己完結インタラクティブ HTML グラフ | `exported graph to …` / 0 |
| `web --port <n>` | 複数プロジェクト管理パネル（HTTP 常駐） | サーバ（exit しない） |
| `project <add\|list\|remove\|analyze>` | レジストリ管理（→ data/project-cache.md） | 下記 |
| `cache-stats` | A-3 cache transcript を hit 率レポートに集計 | レポート / JSON |
| `integral --entry <ref>` | 3 層スコープド検索（→ feature/integral-search.md） | レポート / 0 |
| `domains <draft\|list\|reconstruct\|suggest>` | ドメイン authoring（→ feature/domain-authoring.md） | 下記 |
| `trace <plan\|ingest>` | 動的トレース準備 / 取り込み（→ feature/trace-recording.md） | 下記 |
| `screens` | 静的画面構成の検出（→ feature/screen-composition.md） | 一覧 / 0 |
| `scenes` | シーン導出 + シーンキャッシュ（→ feature/scene-derivation.md） | 一覧 / 0 |
| `links <list\|ratify\|candidates>` | コード↔仕様リンクの硬化（→ feature/spec-linkage.md） | 下記 |

### project analyze の部分実行フラグ

`project analyze <id>` は段階的 / 部分的解析を受ける（→ feature/analysis-procedure.md §部分実行）:

| フラグ | 意味 |
|---|---|
| `--path <prefix>`（複数可） | repo 相対 prefix 配下のソースだけ解析する |
| `--no-domains` | Phase 4（ドメイン検出）をスキップ |
| `--no-spec` | Phase 5（仕様リンク）をスキップ |

いずれかを指定した結果は `partial` マーカー付きで返り、プロジェクトの正準スナップ
ショットには**保存されない**（フル解析キャッシュを汚さない）。フルキャッシュが新鮮な
場合はその superset がそのまま返る。

### scenes のフラグ

| フラグ | 意味 |
|---|---|
| `--project <id>` / `--repo <path>` | 対象（--project は fingerprint キー付きシーンキャッシュを使う） |
| `--max-depth <n>` | 呼び出し閉包の深さ上限（既定: 無制限） |
| `--json` | `{ derived, manual, merged }` を JSON で出力 |

## 共通フラグ

`verify` / `context` / `where` / `export-graph`：

| フラグ | 別名 | 意味 |
|---|---|---|
| `--repo <path>` | `-r` | 解析対象 repo（既定 cwd） |
| `--task <t>` | `-t` | context / where のタスク記述 |
| `--diff <path>` | `-d` | verify の diff ファイル（既定 `-` = stdin） |
| `--project <id>` | `-p` | 登録プロジェクトを対象（registered rootPath が --repo を上書き） |
| `--json` | `-j` | 生 JSON 出力 |
| `--output <f>` | `-o` | export-graph の出力先 |

`--project` 無指定なら `--repo`（既定 cwd）を直接解析する単発互換動作。

## verify は stdin から diff

```sh
git diff | node bin/anatomia.mjs verify --project adventure --json
echo $?    # 0=PASS / 1=block ゲート失敗
```

`--json` で生 `Verdict`、無指定なら人間向けサマリ（`PASS`/`FAIL` + `[PASS/FAIL] <gate>` 行 +
suggestion）。

## project サブコマンド

| 形 | 出力例 |
|---|---|
| `project add <name> <path>` | `added project "<id>" -> <rootPath>` |
| `project list` | `* <id>\t<name>\t<rootPath>`（`*` = selected）/ `(no projects registered)` |
| `project remove <id>` | `removed project "<id>"` / `no such project "<id>"`（exit 1） |
| `project analyze <id>` | `analyzed "<id>": N files, M functions [(cache hit)]` |

## cache-stats

```sh
node bin/anatomia.mjs cache-stats --log <path.jsonl> [--json]
```

`--log` 省略時は `ANATOMIA_CACHE_LOG`。未設定なら exit 1（「set ANATOMIA_CACHE_LOG …」）。
global / namespace 別 / session 別の hit 率 + token spend を出す（→ data/llm-cache.md）。

## 終了処理メモ

Windows のパイプ出力で write→即 exit すると libuv abort することがあるため、CLI は
write callback を待ってから exit する（`writeThenExit`）。`web` だけは exit せず常駐。

## 関連

- 操作手順: [feature/analysis-procedure.md](../feature/analysis-procedure.md)
- 他経路: [interface/mcp.md](./mcp.md)、[interface/web.md](./web.md)
