# feature: ドメインビュー（domain view）

## 目的

コードベースの「やりたいことの中核（ドメイン）」を分析し、**ドメイン別にフォーカスして**
グラフを描画する専用ビューを提供する。さらに spec の情報を参照して、各ドメインの意味を
**日本語で補間**して見せる（DESIGN §4.4: ドメインが中核の意図、spec リンクがその人間可読な意味）。

## 振る舞い

`buildDomainView(domains, links, specClauses)`（`src/domains/view.ts`）。純関数で、
ドメイン検出結果（[feature/domain-detection.md](./domain-detection.md)）に spec リンク
（[feature/spec-linkage.md](./spec-linkage.md)）を重ねて 1 ドメイン 1 `DomainView` を作る。

- 実装関数 0 のドメインは除外。`implementorCount` 降順にソート。
- `implementors`: AnchorId 集合 → パネルがフォーカスするグラフのノード集合。
- `specRefs`: そのドメインの実装関数（`link.from ∈ implementors`）に紐づく spec 節を
  **節ごとに最高 confidence の link を 1 本**だけ採り、confidence 降順で上位 5 件。
  各 ref は `{ clauseId, heading, file, excerpt(240字), confidence, evidence }`。
- `description`: 最上位 ref の `heading: excerpt` を**日本語の説明**として補間（spec が日本語なら
  日本語になる）。紐づく節が無ければ null。

LLM 蒸留の `DomainCard`（[feature/domain-detection.md](./domain-detection.md)）とは別レイヤーで、
このビューは LLM を呼ばない（spec の実テキストだけで補間する決定的経路）。

## パネルでの使われ方

`Domain View` タブ。左にドメイン一覧（名前 + 日本語説明 + conforms バッジ + 実装数）、
ドメインを選ぶと右の専用キャンバスに**そのドメインの実装関数だけ**のサブグラフ（ノード間の
エッジのみ）を描画し、下部に紐づく spec 節（日本語）を表示する。route は
`GET /api/projects/:id/domain-view`。グラフデータは `/api/projects/:id/vis-data` を共有。

**巨大ドメインの上限**: 粗い builtin ドメイン（例: state-machine が TS リポで数千関数に当たる）は
そのまま描画すると重く使い物にならないため、フォーカスグラフは coupling 上位 `DV_MAX_NODES`(=400) に
クランプし、「showing top 400 of N functions (by coupling)」と表示する（残りは間引き）。

## 制約

- 検出ドメインの粒度は builtin オントロジー + プラグインに依存（B-3 ゲームオントロジー未完）。
  粗いドメインはフォーカスグラフを上位 400 ノードに間引いて描画する（上記）。
- spec リンクが無いドメインは説明 null（「spec リンクなし」と表示）。

## 関連

- 検出: [feature/domain-detection.md](./domain-detection.md)
- リンク: [feature/spec-linkage.md](./spec-linkage.md)
- インターフェース: [interface/web.md](../interface/web.md)
