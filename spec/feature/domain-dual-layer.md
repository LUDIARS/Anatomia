---
title: Anatomia dual-layer domain model
type: feature
service: anatomia
domain: domain-modeling
status: planned
tags:
  - domain
  - program-domain
  - business-domain
  - layered-architecture
  - review-policy
x-anatomia:
  kind: domain-dual-layer
---

# feature: ドメイン二層モデル（ビジネスドメイン / プログラムドメイン）

## 目的

ドメインを単一の意味軸で扱うのをやめ、**2 つの独立したドメイン層**として解析・管理する。

| 層 | 正本 | 導出 | 調整 |
|---|---|---|---|
| **ビジネスドメイン** | 仕様書 (spec / OKF) | SpecClause 解析 → 人間承認 (Gate A) | 人間が調整可能 |
| **プログラムドメイン** | コード（プログラムツリー + レイヤードアーキテクチャ） | 決定的解析で全自動割当 | リファクタリング提案 → 調整タスク発行（[viewer-scene-domain-tabs.md](./viewer-scene-domain-tabs.md)） |

従来契約（[domain-organization.md](./domain-organization.md)）では
「architectural layer / module directory は domain hierarchy と別軸」としていた。本仕様は
これを**改訂**し、レイヤードアーキテクチャ + プログラムツリーに基づく構造的まとまりを
**プログラムドメイン**として第一級のドメイン層に昇格させる。既存のビジネスドメイン契約
（spec 権威・Gate A/B/C・knowledge transaction）は変更しない。

## 二層の定義

### プログラムドメイン（program domain）

- **プログラムツリーを踏まえた形 + レイヤードアーキテクチャをベース**に分解する。
  構成要素は既存の機能(module)層（[module-layer.md](./module-layer.md)：ディレクトリ /
  `enclosingType`）を基礎単位とし、各機能単位に **layer 分類**
  （presentation / application / domain-logic / infrastructure / shared 等、リポごとに
  検出 + 設定可能）を与える。
- プログラムドメイン = `layer × プログラムツリー上の凝集まとまり`。決定的
  （LLM 無し・時刻無し）に導出し、fingerprint キー付き artifact として永続化する。
- **すべての CodeSymbol はいずれかのプログラムドメインに属する**（全域性）。属せない
  symbol の存在は導出のバグまたは layer 設定の欠落であり、`unclassified` diagnostic として
  surface する。ビジネスドメインの `abstain`（未割当のまま許容）とは対照的である。
- 人間の Gate を置かない。scene（[scene-derivation.md](./scene-derivation.md)）と同じく
  code-authoritative で、sync のたびに全 relation を置換する。誤りの修正先は layer 設定
  （detector config）・code annotation・source code であり、手動 override ではない。

### ビジネスドメイン（business domain）

- 既存の approved domain（[domain-organization.md](./domain-organization.md)）を
  そのまま**ビジネスドメイン**と呼び替える。purpose / boundary / hierarchy は
  human-approved specification が決め、人間が調整できる（Gate A/B/C 経由）。
- code → ビジネスドメインの owner edge は従来どおり evidence ベースの proposal + Gate B。
  **「紐づけなし」がありうる**：新解析ロジック導入後も、既存ビジネスドメインのどれにも
  属さないコードは `abstain` / `code-only` のまま正当である。無理に既存ドメインへ
  押し込まない（default domain 禁止の従来契約を維持）。

### 相互リンク

二層は独立した hierarchy を持ち、**CodeSymbol / SpecClause を介して相互に接続**する。

```text
SpecClause ─owned-by→ BusinessDomain          # 必須 (下記レビュー指針)
SpecClause ─refines?→ ProgramDomain           # 任意 (spec-code link 経由の導出)
CodeSymbol ─belongs-to→ ProgramDomain         # 必須・全自動
CodeSymbol ─owned-by?→ BusinessDomain         # 任意・Gate B 承認
BusinessDomain ⇄ ProgramDomain                # 上 2 つの edge から導出した many-to-many 対応
```

`BusinessDomain ⇄ ProgramDomain` の対応は保存せず query 時に導出する（transitive edge を
保存しない従来原則を踏襲）。導出根拠（どの CodeSymbol / SpecClause を経由したか）を
必ず提示できること。

## Revisor レビュー指針（gate contract）

Revisor の PR レビュー（[pr-diff-review.md](./pr-diff-review.md) の `domain` / `spec`
フィールドを拡張）は次の対称な指針で判定する。

| 対象 | プログラムドメイン | ビジネスドメイン |
|---|---|---|
| **コード**（変更 CodeSymbol） | 紐づかないのは **NG**（block） | 紐づけなしは**許容** |
| **spec**（変更 SpecClause / 新規 spec） | 紐づけなしは**許容** | 紐づかないのは **NG**（block） |

- コード側 NG の実際の意味：プログラムドメイン導出は全域なので、NG になるのは
  「layer 設定・プログラムツリーのどこにも分類できない配置」= 新規ディレクトリ /
  レイヤ違反の配置である。修正は layer 設定の宣言追加か配置の是正。
  （現行 Revisor の domain gate「target domain missing」の後継。判定の単位を
  ビジネスドメイン紐づけからプログラムドメイン分類へ移す。）
- spec 側 NG：新規 / 変更 spec がどのビジネスドメインにも owned されない場合。修正は
  既存ビジネスドメインへの割当 proposal か、新ドメイン起案（Gate A）。
- いずれも advisory ではなく block。ただし判定は PR worktree のドメイン定義 / layer 設定で
  行う（pr-diff-review の一時性契約を維持）ので、PR 内で宣言を足せば同 PR で解消できる。

### 依存系（package 等）の扱い

- package manifest / lockfile / submodule 参照等の**依存系ファイルは infrastructure 層の
  プログラムドメインに紐づける**（layer 分類器の builtin 既定。`package.json` /
  `package-lock.json` / `.gitmodules` / lib vendoring 等）。
- **依存パッケージの更新はプログラムドメインの紐づけのみで審査を通す**：変更が依存系
  ファイルに閉じる PR（deps-sweep / Dependabot 対応等）は、spec / ビジネスドメイン
  紐づけを要求しない。spec 側 NG 判定の対象外とし、コード側もプログラムドメイン
  （infrastructure）紐づけが自動で立つため block しない。
- 依存更新に伴うコード修正（API 変更追従等）が同 PR に含まれる場合、そのコード部分は
  通常のコード判定（プログラムドメイン必須 / ビジネス任意）に従う。

## 導出ロジック

1. 既存解析（Merkle-AST → call graph → 機能(module)集約）をそのまま入力にする。
2. **layer 分類器**: 機能単位ごとに layer を決める。優先順：
   1. リポの layer 設定（`.anatomia/layers.json`、path glob → layer 宣言）
   2. フレームワーク規約（既存 `frameworks/` の検出結果：routes/ = presentation 等）
   3. 依存方向ヒューリスティック（UI 依存を持つ / 永続化 API を触る 等）

   ただし依存系ファイル（package manifest / lockfile / `.gitmodules` / vendored lib）は
   設定に先立つ builtin 既定として **infrastructure 層**に分類する（前節参照）。
   決定不能は `unclassified` diagnostic（NG の素）。
3. **プログラムドメイン合成**: 同一 layer 内でプログラムツリー的に隣接し越境結合
   （module-layer の coupling 指標）が強い機能単位群を 1 プログラムドメインに畳む。
   分割の質は modularity Q / cohesion で評価し、閾値・畳み方は設定で決定的に固定する。
4. **ビジネスドメイン対応の導出**: CodeSymbol の owner edge（Gate B 承認済み）を
   プログラムドメイン単位に集計し、`ProgramDomain → BusinessDomain[]`（重み付き）を作る。
   逆方向も同様。owner edge が無い部分は「紐づけなし」として空のまま提示する。

出力は knowledge log の code-sync transaction（scene と同型）+ deterministic projection
（`program-domains.json` / Kuzu / Web cache）。

## 現行実装との差（migration）

- `src/domains/detect.ts` 系の builtin オントロジー検出は**どちらの層でもない**中間物と
  なる。検出結果はビジネスドメイン proposal の evidence としては残すが、ドメインそのもの
  として表示しない（catch-all `state-machine` 等を廃する従来方針を完遂）。
- `ReviewReport.domainCoupling` / domain-view の集約は、参照する層を明示する
  （構造の話はプログラムドメイン、意味の話はビジネスドメイン）。
- Revisor domain gate は「.json ドメイン定義への紐づけ」から本仕様の二層判定へ移行する。
  移行期間は両判定を併走させ、差分を advisory で出してから切り替える。
- 移行の前提は各リポの `.anatomia/layers.json` が全 module を覆うこと。投入前点検は
  `anatomia domains program --project <id> [--json] [--unclassified]`（→ interface/cli.md）で
  行う。CLI と Revisor gate は同じ module/symbol 構築 (`domains/program/diagnose.ts`) を読むので、
  CLI で `unclassified: 0` なら gate のプログラム側判定も pass する。

## 関連

- [domain-organization.md](./domain-organization.md) — ビジネスドメインの権威・Gate 契約
- [module-layer.md](./module-layer.md) — プログラムドメインの基礎単位
- [scene-derivation.md](./scene-derivation.md) — code-authoritative 自動割当の先行例
- [pr-diff-review.md](./pr-diff-review.md) — Revisor gate の載せ先
- [viewer-scene-domain-tabs.md](./viewer-scene-domain-tabs.md) — ビューア
