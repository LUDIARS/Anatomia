---
task: layers-declared-order
project: Anatomia
kind: 実装
created: 2026-09-05
memory_links: []
---
# .anatomia/layers.json に層の順序と許可依存を宣言できるようにする (A-7)

## 目的
設計書 `Ars/spec/plan/2026-09-05-anatomia-domain-plan-tool.md` §7.2 A-7。
プログラムドメインの層違反判定 (`layerViolation`) は層の順序が**コードに固定**されている
(`LAYER_RANK`: infrastructure < domain < application < presentation)。
レイヤはプロダクトの大きさで柔軟に変わり、オニオン状にもなるため、
リポごとの層数・依存方向を表現できない。

## 完了条件
- 既存の `layers` (path glob → layer) と `mergeCouplingThreshold` を維持したまま、
  `.anatomia/layers.json` に層順・許可依存の宣言を追加で受ける
  (`order: [...]` もしくは `allow: { from: [to...] }`)。オニオンは `allow` で
  内向きのみ許可として表現する。
- 宣言が無いリポは現行 `LAYER_RANK` の挙動を維持する (既存リポの判定を変えない)。
- `layerViolation` の判定を宣言に従わせる。宣言と `LAYER_RANK` が両方ある場合は宣言が勝つ。
- `order` / `allow` が参照する層名は、同じ設定の `layers[].layer` と組み込み分類器が
  生成し得る層名に限る。独自層も `layers` と依存方針の両方に宣言すれば受け付ける。
- 壊れた宣言 (未宣言の層名・重複した `order`・循環した `allow`) は既定へ落とさず、
  `loadProgramDomainConfig` と同様に設定エラーとして fail-fast する。誤った既定順で
  `layerViolation` を判定済みにしない。
- 宣言あり / 宣言なし / 壊れた宣言の 3 ケースをテストで固定する。
- `npm run typecheck` / `npm test` green、`npm run build`。Revisor local PR 提出。

## スコープ (編集可ディレクトリ)
- `src/domains/program/`
- `src/web-cache/program-domain-view.ts` / `src/web-cache/program-domain-view.test.ts`
- `spec/feature/domain-dual-layer.md` / `spec/feature/module-layer.md`
