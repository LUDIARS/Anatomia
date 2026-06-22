# feature: ドメインビュー自己調整（domain re-tune）

## 目的

ドメイン検出（[domain-detection.md](./domain-detection.md)）/ ドメインビュー
（[domain-view.md](./domain-view.md)）が依存する **ドメイン × モジュールの taxonomy** を、
プロジェクトの目的（README/DESIGN）と `spec/feature/*` を起点に **自己調整** する。

ビルトインオントロジー（`state-machine` / `hot-path-processor`）は汎用ルールであって、
個々のコードベースが「何のために存在するか」を表す taxonomy ではない。Anatomia 自身を含む
多くのリポは `ontologyDir` 未設定でドメインビューが無意味になっていた。本機能は対象リポを
解析し、**そのリポ固有のドメイン/モジュール taxonomy** を生成・登録してドメインビューを意味の
あるものにする。

## 自己調整の 7 ステップ

入力 = 対象リポの解析結果（`analyze()` の `AnalysisContext`：関数ノード + メトリクス +
spec 節）+ 既存 taxonomy（2 回目以降）。

1. **目的 + spec/feature からドメインと大モジュールを決める**（LLM）。README/DESIGN 見出しと
   `spec/feature/*.md` のファイル名・見出し、`src/` 直下のディレクトリ一覧（=モジュール候補、
   ノード件数つき）を渡し、ドメイン骨子 `[{domain, modules[]}]` を出させる。
2. **大きいノードをドメイン/モジュールに関連付ける**（LLM）。サイズ上位のディレクトリ
   （代表関数を evidence に同梱）を (1) のドメイン/モジュールへ割り当てる。
3. **結合できない小さいノードをグループ化検討**（LLM）。(2) で確信を持って割り当たらなかった
   ディレクトリ/ファイル群を新規モジュールにまとめられるか提案させる。
4. **グループを spec に新規登録、ノードを関連付ける**（機械的）。(1)〜(3) を taxonomy に確定し、
   `spec/data/ontology/<project>.taxonomy.json` + ドメインごとの `*.domain.json`（membership
   付き DomainDef）+ `spec/feature/domain-taxonomy.<project>.md` を冪等に書き出す。
5. **大きいドメイン（モジュール過多）を分割**（サイズは機械的、分割は LLM）。
   モジュール数が `RETUNE_MAX_MODULES_PER_DOMAIN`(=6) を超えるドメインを、LLM にサブドメインへ
   割らせる。
6. **多すぎる小モジュールを統合**（LLM 判断）。ノード数 `RETUNE_MIN_NODES_PER_MODULE`(=3) 未満の
   小モジュールが閾値以上ある場合、LLM に統合案を出させる。
7. **2 反復したら人間判断を仰ぐ**。反復回数を `.anatomia/retune-state.json` に記録し、
   `iterations >= 2` で自動反復を止め、人間レビュー用レポート（差分・未割当・自信の低い割当）を
   出して停止する。

LLM は providers（[providers](../../src/providers/index.ts)）の既定（`claude -p` サブスク CLI）を
使う。設定不備の無言フォールバックは禁止（[domain-detection.md] と同じく、stub は明示選択時のみ）。

## データモデル

- `DomainDef.membership?: NodeFilter[]`（[ontology.ts](../../src/domains/ontology.ts)）— ドメインが
  **宣言的に所有するノード集合**。`detectDomain` は membership フィルタにマッチしたノードを
  implementors に加える（違反は出さない）。これで「ルール（presetRules）」と「所有（membership）」を
  直交させ、taxonomy をルールゼロでもドメインビューに乗せられる。
- `Taxonomy`（[retune/types.ts](../../src/domains/retune/types.ts)）= `domains[] → modules[] →
  {paths[], names[]}`。モジュールは **パス前置/正規表現** でノードを所有する（Anatomia は
  ディレクトリ構造でレイヤを表すため `NodeFilter.pathPattern` と整合）。

## ドメインビューへの反映

- ドメイン: 生成された `*.domain.json` を `ontologyDir` 経由で `loadOntology` が読み、既存
  detect→domain-view 経路にそのまま乗る。
- モジュール: vis-data の group をディレクトリ（`groupFor`）でなく taxonomy のモジュールで
  解決する optional な `moduleResolver` を `buildVisData` に追加。taxonomy があればモジュール単位
  集約、無ければ従来のディレクトリ集約にフォールバック。

## 制約

- LLM 出力は短い構造化 JSON のみを要求する（長文 Markdown を JSON で返させない:
  メモリ feedback_llm_long_markdown_no_json）。配列/オブジェクトの揺れは正規化して受ける。
- taxonomy は committed 成果物（`spec/data/ontology/`）。`.anatomia/` はローカル状態
  （反復カウンタ）のみ。

## 関連

- 検出: [domain-detection.md](./domain-detection.md) / ビュー: [domain-view.md](./domain-view.md)
- 実行: `npm run retune`（[scripts/retune.mjs](../../scripts/retune.mjs)）
