---
task: domain-map-content-naming
project: Anatomia
kind: 実装
created: 2026-09-05
memory_links: []
---
# 横断ドメインマップのコンテンツ命名 (`dirname`) と membership 由来パスの是正

## 目的
設計書 `Ars/spec/plan/2026-09-05-anatomia-domain-plan-tool.md` §12.2 の横断ドメイン
マップ索引に、2026-09-05 実測で「コンテンツを取りこぼす」経路が 2 つ残っていた。

1. **名乗るものが無いコンテンツを宣言できない**。`Pictor/demo/` 配下には 19 本の
   デモがあるのに `spec/feature/*.md` があるのは影絵デモ 1 本だけで、残りは索引に
   載らない。`content-sources.json` の `nameFrom` は `manifest.json:title` / `h1` /
   `frontmatter:title` の 3 種しかなく、`manifest.json` も README も持たない
   ディレクトリには**今の語彙では名前を付けられない**。

2. **membership の literal 化不足で content レコードが潰れる**。
   `pathHintFromPattern` は非 literal な部分で打ち切り、literal な前置きを
   そのままドメインのパスとして採っていた。Figmentum の
   `(^|/)spec/feature/kirie(?:-anim|-transform)\.md$` からは `spec/feature` が採られ、
   同ディレクトリの **18 本すべてが kirie-transform を owner とする同一 key** になり、
   `dedupeContent` が 1 件へ畳んでいた。実測で `GET /api/domain-map/search?q=切り絵`
   から Figmentum の content レコード (H1「kirie-transform — 実写真→切り絵風イラスト変換」)
   が消えていた。

併せて、削除済み作業系統にしか残っていなかった `spec/tasks/` の記録 6 本を復元する。

## 完了条件
- `ContentNameSource` に `dirname` を足し、ディレクトリ名 (ファイル名) を
  区切り文字を空白へ均すだけで名前にする (`shadow_play` → 「shadow play」)。
  **日本語へ訳さない** (リポが書いていない名前を索引に持ち込まない)。
- `dirname` のエントリは、同じものを指す `spec/feature/*.md` があればそちらへ寄せる。
  名前はその H1、`paths` はディレクトリ、`spec` はその文書。2 レコードに割らない。
- `pathHintsFromPattern` は membership を 2 通りでだけパスに戻す。
  (a) リテラル + 単純な選択肢は**実パスへ展開**する
  (`kirie(?:-anim|-transform)\.md` → 2 本)。
  (b) リテラル前置き + サブツリー主張 (`src/kirie/(?:.*/)?[^/]+`) は前置きを返す。
  それ以外 (名前を絞る末尾) は**何も返さない**。確定できない membership に
  パスを主張させない。
- `dedupeContent` の同一性に**その文書自身** (`spec`) を含める。owner とパスが同じでも、
  別の spec 文書を説明するレコードは別のコンテンツとして残す。カタログ
  (`manifest.json:title`) と同じものの spec H1 を 1 件へ畳む従来の挙動は壊さない。
- `src/map/__tests__/content-naming.test.ts` に fixture テストを足し、既存の受け入れ例
  (「トランポリンカウンターで…」→ ludellus `uni-jump-trampoline` が 1 位、
  「切り絵のデモを実装する」→ Pictor 影絵デモが 1 位) を壊さない。
- `spec/feature/domain-map.md` に `nameFrom` の一覧と membership → パスの規則を書く。
- 削除済み作業系統にしか無かった `spec/tasks/` の記録 6 本を内容そのままで復元する
  (実装はしない。`domain-map-register-missing-projects` と
  `domain-map-supply-hook-prefix` のみ末尾に現況を追記)。

## 範囲外
- 各プロダクトリポへの `spec/domains/content-sources.json` の実投入
  (Pictor は本 PR のマージ後に別 PR)。復元した
  `2026-09-05-domain-map-content-sources-rollout.md` が正本。
