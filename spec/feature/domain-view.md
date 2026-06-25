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
ドメインを選ぶと右の専用キャンバスに**機能単位（モジュール = vis-data の `group`）で集約した**
グラフを描画する。**個々の関数までは下ろさず**、機能単位を 1 ノードとし、ラベルに**その機能に属する
関数の件数**を出す（ノードサイズも件数スケール）。関数→関数のエッジは**モジュール→モジュール**に畳み込み、
本数を重みにする（同一モジュール内は描かない）。下部に紐づく spec 節（日本語）を表示。route は
`GET /api/projects/:id/domain-view`。

ノードの tooltip には件数 + 代表関数名（最大 12）を出す。キャンバス上部に
「N functions across M feature units」（または上限超過時は間引き告知）を表示。

**機能単位グラフは事前集約**する（`src/domains/view-graph.ts` の `aggregateDomainUnits`）。
以前はパネルが全関数粒度の vis-data を丸ごと取得し、ドメインを選ぶ度にクライアントで
関数→モジュール集約を回していた（大規模リポで数 MB の DL + O(関数+エッジ) のループ）。
いまは prepare 時にドメイン毎の `{ units, unit(件数/色/代表名), pairs }` を
`domain-view` ペイロードの `graphByDomain` に同梱し、パネルは対象ドメイン分を引いて
**fold（hub/弱エッジ除去）だけ**をクライアントで行う（`public/domain-view-logic.js` の
`foldUnitGraph`、fold トグルは対話的なのでクライアント保持）。集約の機能単位上限は
`DV_MAX_UNITS`(=60) で、サーバの `DOMAIN_VIEW_MAX_UNITS` と一致させる。アクセスパターン
オーバーレイも prepared cache (`/web/access-patterns`) から読む。

**機能単位の上限**: 機能単位（モジュール）はふつう少数だが、念のため件数上位 `DV_MAX_UNITS`(=60) に
クランプし、超過時は「N functions · showing top 60 of M feature units (by function count)」と表示する。

## 制約

- 検出ドメインの粒度は builtin オントロジー + プラグインに依存（B-3 ゲームオントロジー未完）。
  粗いドメイン（例: state-machine が TS リポで数千関数）も**機能単位集約**なのでノード数は
  モジュール数で有界、関数件数はラベルに出る。
- spec リンクが無いドメインは説明 null（「spec リンクなし」と表示）。

## 関連

- 検出: [feature/domain-detection.md](./domain-detection.md)
- リンク: [feature/spec-linkage.md](./spec-linkage.md)
- インターフェース: [interface/web.md](../interface/web.md)
