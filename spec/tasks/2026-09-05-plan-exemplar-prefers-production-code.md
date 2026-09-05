---
task: plan-exemplar-prefers-production-code
project: Anatomia
kind: 実装
created: 2026-09-05
memory_links: []
---
# plan の手本にテストコードを選ばせない

## 目的

PR #1393 でアクセサ除外と task トークン一致による手本選択を入れたが、実データで
回すと**テストファイルが手本になる**ケースが残っている。

2026-09-05 実測 (`plan --task "トランポリンカウンターのミッション表示を直す" --no-llm`):

```
1. ludellus/uni-jump-trampoline	[既存] layer=test
       手本: test/uni-jump-pile-world.test.mjs:createWorld (被参照 15)
```

`renderer/lib/jump/missions.js` の `startMissionRun` / `advanceMissionRun` という
まさに task が言っているプロダクションコードがありながら、手本はテストになる。
原因は 2 つある:

1. ドメインの主 layer が `test` と算出されている (このドメインは
   membership にテストディレクトリを含み、実装より関数数が多い)。
   `exemplar.ts` は「同 layer」を優先条件にしているので、test 内へ引き寄せられる。
2. テストヘルパは被参照数が大きくなりやすく、同点処理の被参照数で勝つ。

手本は「これを真似して書け」という指示なので、テストコードを指すのは誤りに近い。

## 完了条件

- 手本候補から**テストファイル**を除外する優先条件を `pickExemplarSibling` に足す
  (パスや layer が `test` / `__tests__` / `*.test.*` / `*.spec.*` に当たるもの)。
  他の絞り込みと同じく、全滅する場合は条件を飛ばして候補を残す。
- ドメインの主 layer 算出 (`detectors.ts` の `domainLayerMap`) が test に倒れる件を、
  手本選択の側で吸収するか主 layer 算出の側で直すかを決め、理由をコメントに残す
  (`where` の着地点選択の挙動を変えないこと)。
- 上記の実測ケース (uni-jump-trampoline の task で
  `renderer/lib/jump/missions.js` 側が手本になる) に相当する回帰テストを
  `src/supply/plan/__tests__/quality.test.ts` に足す。
