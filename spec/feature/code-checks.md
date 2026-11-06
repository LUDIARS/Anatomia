---
id: AN-CODE-CHECKS
title: C++ code-level static checks
type: feature
status: current
---

# C++ code-level static checks

C++ のソースを tree-sitter-cpp の構文木だけで判定する、決定的な検査器。LLM・ネットワーク・
ビルド・コンパイラを使わない。同じバイト列には必ず同じ指摘を返す。

Actio task: `actio:b4c334d4-f844-4e21-a64f-96f02316f15b`。Revisor はこの CLI を PR の
変更ファイルに対して呼び、登録テストとして判定する (Revisor 側の仕様が正本)。

## 責務の置き場所

| 置き場所 | 責務 |
|---|---|
| `src/code-checks/types.ts` | 指摘・設定・規則群の型 |
| `src/code-checks/config.ts` | 既定しきい値、`.anatomia/code-checks.json` の検証と合成 |
| `src/code-checks/syntax.ts` | 構文木の走査・関数名・宣言名の取得 |
| `src/code-checks/locals.ts` | 関数本体のローカル変数の抽出と、識別子 → 宣言の解決 (同名の影を区別) |
| `src/code-checks/cognitive-complexity.ts` | Cognitive Complexity と循環的複雑度の計算 |
| `src/code-checks/rules/*.ts` | 規則群 (1 ファイル 1 カテゴリ) |
| `src/code-checks/families.ts` | 規則群の登録 |
| `src/code-checks/run.ts` | パース → 規則群 → 重大度適用 → レポート |
| `src/code-checks/format.ts` | テキスト出力 |
| `src/adapters/code-check-cli.ts` | 引数・ファイル収集・終了コード |

ドメインは `code-checks` (`spec/domains/code-checks.domain.json`)。CLI アダプタは既存の
`delivery-surface` に属する。

## 規則

既定の重大度を括弧内に示す。参考にした OSS / 指針を各カテゴリに記す。

### メモリ (Rust 準拠) — `memory/*`

safe Rust が保証する「手動確保なし・move 後の使用なし・所有者より長生きする参照なし・
型の読み替えは unsafe」を C++ 側で破っている構文を指摘する。
参考: C++ Core Guidelines R.11 / C.149 / ES.56 / F.43 / Type.1、Lifetime profile、
clang-tidy `cppcoreguidelines-owning-memory` / `bugprone-use-after-move`。

| 規則 | 内容 |
|---|---|
| `memory/raw-new` (error) | 配置 new 以外の `new` |
| `memory/raw-delete` (error) | `delete` / `delete[]` |
| `memory/c-allocation` (error) | `malloc` / `calloc` / `realloc` / `free` / `strdup` / `aligned_alloc` |
| `memory/use-after-move` (error) | `std::move(x)` 後の同じ変数 `x` の使用 (再代入・`clear/reset/assign/emplace/swap` で解除) |
| `memory/dangling-return` (error) | ポインタ/参照を返す関数が、ローカル変数・値渡し引数のアドレス/参照を返す |
| `memory/unsafe-cast` (warning) | `reinterpret_cast` / `const_cast` / ポインタ型への C 形式キャスト |

### 難読化 — `obfuscation/*`

参考: clang-tidy `readability-identifier-length` / `cppcoreguidelines-macro-usage` /
`readability-avoid-nested-conditional-operator` / `cppcoreguidelines-avoid-goto`。

| 規則 | 内容 |
|---|---|
| `obfuscation/short-identifier` (warning) | 宣言名が `shortIdentifierMaxLength` 以下で許可リスト外 |
| `obfuscation/function-macro` (warning) | 関数形式マクロがファイルあたり `functionMacrosPerFile` 超 |
| `obfuscation/nested-ternary` (warning) | 条件演算子の入れ子 (最外のみ 1 件) |
| `obfuscation/goto` (warning) | `goto` |
| `obfuscation/dense-line` (warning) | 1 行の文が `statementsPerLine` 超 (`for` 初期化部と `case X: f(); break;` の `break` は数えない) |
| `obfuscation/long-line` (info) | 行長が `maxLineLength` 超 |

### 再配置 — `placement/*`

宣言が使う場所から離れている (置き場所が不適切な) ものを指摘する。
参考: C++ Core Guidelines ES.5 / ES.21、cppcheck `variableScope`。

| 規則 | 内容 |
|---|---|
| `placement/declaration-distance` (warning) | 宣言から最初の使用まで `declarationDistance` 行超 |
| `placement/narrow-scope` (info) | 全使用が 1 つの内側ブロックに収まる (ループ本体へは移さない、static は除外) |

### 変数宣言 — `declaration/*`

参考: C++ Core Guidelines ES.20 / ES.10 / Con.4、clang-tidy `cppcoreguidelines-init-variables` /
`readability-isolate-declaration` / `misc-const-correctness`。

| 規則 | 内容 |
|---|---|
| `declaration/uninitialized` (warning) | 初期値のない組込みスカラー・ポインタ (配列・static・クラス型は除外) |
| `declaration/multiple-per-statement` (info) | 1 文で複数変数を宣言 |
| `declaration/unused` (warning) | 使われない組込みスカラー (RAII 型は除外) |
| `declaration/const-candidate` (info) | 初期化後に書き換え・`&x`・引数渡し・メンバ関数呼び出し・ラムダ内使用がない非 const 値 |

### 人間にとっての複雑さ — `complexity/*`

Cognitive Complexity は SonarSource の仕様書 (G. Ann Campbell, "Cognitive Complexity")
に従う: if / else if / else / ?: / switch / ループ / catch / goto / 同種論理演算子の連なり /
直接再帰で +1、ネストする構造は現在のネスト深さを加算、ラムダはネストを 1 段深くする。
循環的複雑度は lizard と同じく 1 + 分岐点 (if・ループ・値付き case・catch・?:・`&&`/`||`)。

| 規則 | 既定しきい値 |
|---|---|
| `complexity/cognitive` (warning) | 15 (Sonar S3776 既定) |
| `complexity/cyclomatic` (warning) | 15 (lizard 既定) |
| `complexity/function-length` (warning) | 本体 80 行 |
| `complexity/parameter-count` (warning) | 6 |

### コメント — `comment/*`

参考: Doxygen の「宣言の直上に付くコメント」モデル、clang `-Wdocumentation`、Sonar S125。

| 規則 | 内容 |
|---|---|
| `comment/missing-doc` (warning) | ヘッダの公開クラス・関数・public メンバ関数の直上 (1 行以内) にコメントがない。`= default` / `= delete` / デストラクタ / 演算子は除外 |
| `comment/undocumented-complex` (info) | Cognitive Complexity が `commentRequiredComplexity` 以上で、直上にも本体内にもコメントがない |
| `comment/commented-out-code` (info) | 連続する `//` 行のブロックの半分以上がコード形。doc コメント・`@code`・`Usage:` などの例示導入があるブロックは除外 |

## 設定

リポジトリ直下の `.anatomia/code-checks.json`。無ければ既定値。**あるのに不正なら exit 2**
(未知の規則・しきい値・項目、負数、未知の重大度)。既定値へ黙って戻さない。

```json
{
  "thresholds": { "cognitiveComplexity": 20, "shortIdentifierAllow": ["i", "j", "dt"] },
  "disabledRules": ["obfuscation/long-line"],
  "severity": { "memory/unsafe-cast": "error" }
}
```

## 出力と終了コード

`--json` は `CodeCheckReport` (version 1): `files`、`findings[]`
(`rule, category, severity, file, line, column, message, symbol?, value?, threshold?`)、
`totals` (重大度別件数)、`parseErrors` (tree-sitter が ERROR / MISSING を含んだファイル。
回復解析した結果で検査は続けるが、指摘が欠けている可能性を明示する)。

終了コード: `--fail-on` (既定 error) 以上の指摘があれば 1、なければ 0、引数・設定不正は 2。
`--files-from` で渡された一覧の削除済みファイルは対象外として読み飛ばす (PR の変更一覧は
削除も含むため)。直接指定したパスが存在しない場合はエラー。`.c` は対象外 (C では
malloc/free が唯一の確保手段のため)。

## 既知の限界

- 構文木だけで判定するため、データフローを追えない。use-after-move はソース順で判定し、
  move の直後に同じブロックで return / throw / break / continue / goto する場合は対象外にする。
  ループの次の周回での使用、goto による逆流は検出しない。
- 型解決をしないため、`declaration/uninitialized` / `unused` は組込みスカラーの綴りで判定する
  (typedef された整数型は対象外)。`const-candidate` は書き換えの可能性があれば候補にしない
  (取りこぼし側に倒す)。
- マクロ展開・`#ifdef` は解釈しない。片方の分岐にしか使用がない変数は `unused` になりうる。
- `comment/missing-doc` はヘッダのみ。.cpp の関数はヘッダ側の宣言で文書化される前提。
- 完全な所有権・寿命検査は clang の解析 (clang-tidy、`-Wdangling`、Lifetime profile) が必要。
  本検査はそれらを置き換えない。

## 検証

`src/code-checks/__tests__/*.test.ts` が規則ごとに陽性・陰性の例を持つ (hermetic、
ファイルシステム不使用)。実コードでの誤検出確認として Pictor (`src/`、`include/`、370 ファイル)
に掛け、同名変数の再宣言・move 直後の return・条件宣言・`case` 行・特殊メンバ・例示コメントの
誤検出を修正し、回帰テストを追加した。
