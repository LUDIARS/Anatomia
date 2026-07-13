# feature: 集中的テスト (Focused Testing)

## 目的

同じゲームコードでも、NPC の補助行動とプレイヤー入力・進行状態では、失敗時の影響と
必要なテスト密度が異なる。集中的テストは、ユーザーが定義したドメイン優先度と重要変数を
Anatomia の静的解析結果へ重ね、Augur が重点テストを決定的に提案できる入力へ変換する。

LLM は使用しない。提案の根拠は、ユーザー設定と Anatomia が検出済みの domain implementor、
関数引数、所有型の field に限定する。

## 入力

`POST /api/projects/:id/test-suggestions` の任意フィールド `focusedTesting.domains` に、
次を指定する。

| field | meaning |
|---|---|
| `domain` | Anatomia が検出した domain 名 |
| `priority` | `critical` / `high` / `medium` / `low` |
| `risks?` | 明示する場合は `boundary` / `memory_safety` / `authorization` / `state_transition` / `concurrency` / `contract`。省略/空なら解析から推定 |
| `variables` | `{ pattern, priority }[]`。引数名・field 名への大小文字を無視した部分一致 |
| `rationale?` | ユーザーがこの domain を重視する理由 |

同じ domain を複数回指定した入力、未知の domain、implementor が 0 件の domain、
空 pattern、不正な enum は副作用前に 400 で拒否する。

## 決定的解析

`src/domains/focused-testing.ts` が `AnalysisContext` と入力を受け、次を行う。

1. domain implementor anchor を `FunctionNode` へ解決する。
2. implementor ごとに引数と、`enclosingType` に属する field を収集する。
3. variable pattern に一致した変数だけを、指定 priority 付きで残す。
4. risks 未指定なら、境界/契約を基底に、native lifetime、入力/権限語、状態語、並行語を
   signature・変数・AST 本文から決定的に推定する。critical な C/C++ target は
   `memory_safety` も含める。
5. repo-relative path、symbol、line、variable facts を安定ソートする。
6. Augur の `focusedTesting` 契約へ渡す。

変数指定がない場合も domain implementor は重点対象になる。変数 pattern が 1 件も一致しない
場合は設定誤りを隠さず 400 で拒否する。

## UI

Test Suggestions タブは 1 行を次の形式で受け付ける。

```text
player-actions | critical | auto | input:critical,health:high
```

最後の rationale は任意で 5 列目に指定できる。空欄なら通常の Augur 提案のみを取得する。

## 関連

- [ドメイン検出](./domain-detection.md)
- [Web interface](../interface/web.md)
- Augur `spec/feature/focused-testing.md`
