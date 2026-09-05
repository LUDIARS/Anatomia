---
title: ドメイン計画 (anatomia plan) と plan_conformance
type: feature
service: anatomia
domain: supply-verify
status: implemented
tags:
  - plan
  - domain
  - supply
x-anatomia:
  kind: specification
---

# feature: ドメイン計画（`anatomia plan` / `verify --plan`）

## 目的

コードを書く**前**に、task を**ドメイン単位の作業計画に分解して提示する**。
`context` / `where` は「この task の着地点はどこか」までしか答えず、
「この task はどの責務に分かれ、各責務にどの型/データ定義があり、既に似た実装が無いか」
を並べる工程が無かった。`plan` がその工程を 1 コマンドにする。

設計書: `Ars/spec/plan/2026-09-05-anatomia-domain-plan-tool.md` §3。

## インタフェース

```sh
anatomia plan --task "<日本語可>" --project <id> [--project <id> ...] \
              [--repo <path>] [--json] [--no-llm] [--format okf]
```

- `--project` は**繰り返し可**。1 つの task が Pictor（デモ / シェーダ / Visus）と
  Figmentum（画像変換）に跨がるとき、リポごとに別々に計画すると跨りが失われる。
- `--repo` は未登録チェックアウトを単発解析する経路。
- 終了コードは常に 0。計画は gate ではなく briefing。
- 出力は既定が Markdown、`--json` で生 JSON、`--format okf` で委託プロンプト用の
  OKF ドキュメント（frontmatter + ドメインごとの節）。
- JSON は各 repo の `.anatomia/plan/<task-hash>.json` にも保存する。

## パイプライン（`src/supply/plan/`）

| 段 | ファイル | 決定性 |
|---|---|---|
| 1. 候補収集 | `collect.ts` | 決定的。各 project の `spec/domains/*.domain.json` を name / description / membership / implementors 数で集める。宣言が読めないが検出ドメインはある場合（operator plugin dir 経由）は検出結果から候補を作る |
| 2. 分解 | `decompose-llm.ts` / `decompose-fallback.ts` | LLM（`claude -p`、モデル固定 `claude-opus-5`、既定 60 秒）。CLI 不在 / `--no-llm` / 失敗 / 期限超過は決定的検出にフォールバックし、**理由を `notes` に残す** |
| 3. データ定義 | `data-defs.ts` | 決定的。ドメインの membership + implementors のファイルから型宣言と公開関数を列挙（型 8 件 / 関数 6 件まで、関数は被参照順） |
| 4. 重複確認 | `duplicates.ts` | 決定的。responsibility + neededTypes のトークンとリポ全体の型名 / 関数名 / ファイル名を照合。対象ドメイン自身のファイルは除外 |
| 5. 手本 | `exemplar.ts` | 決定的。`landing.ts` の `pickPrecedent`（layer 優先 + 被参照数）を再利用 |
| 6. 出力 | `format.ts` / `format-okf.ts` / `store.ts` | 決定的 |

判断が要るのは 2 だけで、他はすべて解析グラフから読む。

## unresolved と questions

自動で紐付けられない責務は `unresolved[]`、人間に聞くべきことは `questions[]` に載せる
（新規ドメインの説明レビュー、着地ドメイン不明）。
**人間の回答を待たずに実装を進めてよい**。必要なのは実装後のレビューで
「計画したドメイン ⇔ 実際に触ったファイル」を突合できる資料であり、それが
`.anatomia/plan/<hash>.json` と `plan_conformance` 所見。

## verify との連結

```sh
git diff | anatomia verify --repo <path> --plan [<plan.json>]
```

`--plan` に値を渡さないとそのリポの直近の plan を使う。plan が無ければエラー
（黙って gate 無しで検証しない）。

`plan_conformance` は **advisory**：`verdict.pass` には寄与せず、suggestion にだけ出る。
計画は書く前の予測であり、実装は計画に無い作業を正当に発見する。

判定は diff 全体に対して **1 回**走る（5 ゲートはファイル単位、conformance は
「全 plan item を見て初めて計画外と言える」ため）。

- 変更ファイルが `plannedPaths` にも対象ドメインの membership にも入らない
  → 「計画外: <path> → どのドメインに入れるか決めて membership を足す」
- plan に `status: new` の item があるのに `spec/domains/*.json` が diff に無い
  → 「新規ドメインの宣言を同じ PR に入れる」

## plan item 間の層依存の事前警告 (A-11)

各 item は plan 内で安定した `id`（`<repo>/<domain>`、同じ組が二度出たら `#2` を付ける）と
`dependsOn[]`（依存先 item id）を持つ。依存の向きは **分解が明示したものだけ**を使い、
`plannedPaths` からは推測しない（パスは「どこに書くか」であって「どちらが呼ぶか」ではない）。
決定的フォールバックは依存を確定できないので `dependsOn` は空にし、その限界を `notes[]` に残す。

`dependsOn` の各辺について、両 item の `plannedPaths` が属する層を
`.anatomia/layers.json` の `order` / `allow`（無ければ組み込み順）で照合し、
許されない向きを `layerWarnings[]` に出す。plan は gate ではないので **exit code は変わらない**。
層が決まらない item（新規ドメイン / 層外のパス / パスが複数層にまたがる）は違反と断定せず
`unresolved[]` に回す。

Markdown・JSON・OKF のすべてに item id・依存辺・警告を出す。保存形状が変わったため
`PLAN_VERSION` は `plan-v2`。読込 validation は item id の一意性と、`dependsOn` /
`layerWarnings` が実在する item を指すことを確認する。

新規ドメインの `description` は LLM 下書きであることを出力に明示し、
「要人間レビュー」を付けて `questions[]` に載せる。

## UX 直結ドメインの plan / test-suggestions への引き継ぎ (A-10)

ビジネスドメインの `uxCritical`（`spec/feature/domain-dual-layer.md`）は plan の
検出 taxonomy とは **別の名前空間**にある。plan item / `test-suggestions` へ引き継ぐときは
承認済み `domain-owns-code` を経由して「同じ code symbol を主張している検出ドメイン」を求め、
**同名一致では引き継がない**（`src/supply/plan/ux-critical-bridge.ts`）。

- plan: 着地ドメインが UX 直結なら item に印を付け、レビュー観点（画面遷移・入力・エラー表示）を出す
- verify: `plan_conformance` の所見の先頭で UX 直結を告げ、テスト候補の提示を必須と書く
- `POST /api/projects/:id/test-suggestions`: UX 直結ドメインを `critical` として
  focusedTesting へ必ず混ぜる（呼び出し側が外せない）。knowledge log が無いリポでは何もしない

## warm server

`POST /api/plan { project, projects?, task, llm?, okf? }`。
`llm` の既定は **true**（設計書 §5 の決定: hook は LLM 分解前提、10 秒級の待ちを受容）。
`llm: false` で決定的分解のみ。応答は `{ plan, markdown, okf? }`。

## 前提となる修正（同 PR）

- レジストリの `ontologyDir` / `specDirs` が消えたパスを指すとき、例外で domains を
  全落ちさせず警告して無視し、リポ既定（`spec/domains`）へフォールバックする
  （`src/project/config-paths.ts`）。
- 検出器がドメイン description を候補テキストに含め、日本語を 2-gram で扱い、
  IDF 重み + task 語（「実装する」等）の除外でランキングする
  （`src/supply/detectors.ts` / `relevance.ts`）。
- 手本の選択を anchor 辞書順から **layer 優先 + 被参照数**へ置換
  （`src/supply/landing.ts` `pickPrecedent`）。
