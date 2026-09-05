---
title: 横断ドメインマップ検索 (anatomia map)
type: feature
service: anatomia
domain: supply-verify
status: implemented
tags:
  - map
  - domain
  - supply
x-anatomia:
  kind: specification
---

# 横断ドメインマップ検索 (`anatomia map`) {#SPEC-domain-map}

- 正本設計: `Ars/spec/plan/2026-09-05-anatomia-domain-plan-tool.md` §12
- 実装: `src/map/`、`src/adapters/map-cli.ts`、`src/adapters/web/routes/domain-map.ts`
- 関連: `spec/feature/analysis-procedure.md`、`plan` (`src/supply/plan/`)

## 目的

作業開始時の指示文は **プロダクト名やコンテンツ名で書かれる**。
「トランポリンカウンターで〇〇」「切り絵のデモを実装する」は、リポジトリ名も
ドメイン名も含まない。従来の `where` / `plan` は 1 プロジェクトの中でしか探せず、
プロジェクト選択は人間 (または hook の cwd) 任せだった。

ドメインマップは **プロダクト → コンテンツ → コアドメイン → 主要パス → 関連サービス**
を全プロジェクト横断で引く索引で、`plan` の前段に立つ。LLM を使わず、
検索はミリ秒級。

## 索引の作り方 (決定的)

1 レコード = `{ project, kind, name, aliases[], coreDomain, programDomains[], paths[], spec, links[] }`。
`kind` は `content | core-domain | program-domain | spec | scene | service`。

| # | 出所 | 実装 |
|---|---|---|
| 1 | `spec/domains/*.domain.json` の name / description | `sources.ts` |
| 2 | `spec/domains/content-sources.json` で宣言されたコンテンツ (宣言が無いリポは `spec/feature/*.md` の H1 で代替) | `content-sources.ts` |
| 3 | `.anatomia/layers.json` (プログラムドメイン / 層) | `sources.ts` |
| 4 | spec 本文中の他プロジェクト名 (Cc `GET /v1/project-codes`) と HTTP 経路 (`loopback <port>` / `/api/...`) | `links.ts` / `project-codes.ts` |
| 5 | 表記ゆれ正規化 (NFKC 全角/半角、カタカナ→ひらがな、スペース・長音・中黒の除去) | `aliases.ts` |

Concordia が落ちている場合、プロジェクト名ロースターは **空**になり、
名前ベースのリンクだけが落ちる (経路ベースのリンクは残る)。
その旨は project map の `notes[]` に記録され、黙って劣化させない。

## 更新と再構築

- プロジェクト解析時に web-cache artifact `domain-map` として保存される
  (`src/web-cache/build.ts`)。
- 索引は `sourceKey` (宣言と、その glob が選んだ manifest / Markdown の
  path + file bytes のハッシュ) で変更検知し、warm process では短い検査間隔内の
  要求を走査なしで再利用する。検査期限後も **変わったプロジェクトだけ**を再構築する
  (`bundle.ts`)。
- Concordia の場所は Excubitor が `CONCORDIA_URL` として供給し、ポートを埋め込まない。
  ロースターは短時間メモ化し、停止→復旧または内容変更時はリンクを再構築する。

## 検索

- 完全一致エイリアス (正規化キーが指示文に含まれる) が最優先。
  次点で識別子トークン + 日本語 2-gram の重み付き重なり。
- 雑音カット閾値 `MIN_SCORE = 0.3`。「する」だけの偶然一致は 0 件として扱う。
- 0 件のときは「索引に無い。新規コンテンツか表記ゆれ」を返し、
  `plan` の `questions[]` に載る。

## インタフェース

```sh
anatomia map search "トランポリンカウンターで連続跳躍を数える" [--limit N] [--project <id>] [--json] [--refresh]
anatomia map show <project> [--json]
```

```
GET /api/domain-map/search?q=<指示文>&limit=N   # project / kind / name / coreDomain / paths / links / score
GET /api/domain-map/:project                   # 1 プロジェクトの全レコード
```

`plan` は既定でこの検索を前置きする (`--hints-from-map`、既定 ON / `--no-map` で無効)。

- `--project` が無いとき、命中した project が `--project` の候補になる。
- 命中した coreDomain が着地ドメイン候補 (domainHints) として plan に流れる。
- 0 件なら plan の `questions[]` に「索引に無い」を載せる。
- `POST /api/plan` も同じ挙動 (`{"map": false}` で無効)。

## 各リポへ投入する `content-sources.json`

これらは **本 PR では実ファイルを置かない** (対象リポは読み取り専用)。
同等物は `src/map/__tests__/fixtures/` にテスト fixture として置いてある。

### Ludellus — `spec/domains/content-sources.json`

```json
[
  { "glob": "renderer/mr/games/*", "nameFrom": "manifest.json:title" },
  { "glob": "renderer/games/*", "nameFrom": "manifest.json:title" },
  { "glob": "spec/feature/*.md", "nameFrom": "h1" }
]
```

### Ludellus-Server — `spec/domains/content-sources.json`

```json
[
  { "glob": "spec/feature/*.md", "nameFrom": "h1" },
  { "glob": "spec/interface/*.md", "nameFrom": "h1" }
]
```

### Pictor — `spec/domains/content-sources.json`

```json
[
  { "glob": "visus/**/*.md", "nameFrom": "frontmatter:title" },
  { "glob": "samples/*", "nameFrom": "manifest.json:title" },
  { "glob": "spec/feature/*.md", "nameFrom": "h1" }
]
```

### Figmentum — `spec/domains/content-sources.json`

```json
[
  { "glob": "spec/feature/*.md", "nameFrom": "h1" },
  { "glob": "tools/*", "nameFrom": "manifest.json:title" }
]
```

## 受け入れ

`src/map/__tests__/search.test.ts` で固定している。

- 「トランポリンカウンターで連続跳躍を数える」→ `ludellus` / `uni-jump-trampoline` が 1 位、
  `paths` に `renderer/mr/games/uni-jump` と `renderer/lib/jump` を含む。
- 「トランポリン カウンター を直す」(スペース入り) も同じ 1 位。
- 「切り絵のデモを実装する」→ `figmentum/kirie-transform` と Pictor の該当ドメインが上位。
- 「量子暗号の鍵配送を実装する」→ 0 件 (plan の question になる)。
