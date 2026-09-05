---
task: domain-map-content-sources-rollout
project: Anatomia
kind: 実装
created: 2026-09-05
memory_links: []
---
# content-sources.json を各プロダクトリポへ実投入する

## 目的

PR #1393 で横断ドメインマップ (`src/map/`) が入ったが、A-14 の「主要リポへの
`spec/domains/content-sources.json` 投入」は**内容を文書化しただけ**で終わっている。
対象リポ (Ludellus / Ludellus-Server / Pictor / Figmentum) は当該委託から読み取り専用
だったため、実ファイルは置かず `spec/feature/domain-map.md` に JSON を記載し、
同等物を `src/map/__tests__/fixtures/` に fixture として置いた。

宣言が無いリポは `spec/feature/*.md` の H1 で代替されるため索引自体は動くが、
代替経路ではコンテンツ名が設計文書のタイトル (「〇〇 — 実装スペック」等) になり、
カタログ上の呼び名 (「トランポリン カウンター」) と一致しない。実測でも、宣言のある
Ludellus は 1 位で当たる一方、宣言の無い Pictor は spec H1 由来のレコードが
コアドメインに紐づかず `coreDomain: null` のまま出る。

## 完了条件

- `spec/feature/domain-map.md` に記載した JSON を、各リポの
  `spec/domains/content-sources.json` として実際に追加する
  (Ludellus / Ludellus-Server / Pictor / Figmentum、各リポの PR として)。
- 投入後、`anatomia map show <project>` で `kind: content` のレコードが
  カタログ名で並び、`coreDomain` が埋まることを確認する。
- glob が実ツリーに当たらない (0 件になる) リポがあれば、そのリポの実配置に合わせて
  glob を直し、`spec/feature/domain-map.md` の記載も同じ内容へ更新する。
- 各リポの投入内容が Anatomia 側 fixture (`src/map/__tests__/fixtures/`) と
  食い違ったままにしない。
