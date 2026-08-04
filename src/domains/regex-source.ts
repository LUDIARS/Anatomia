/**
 * ドメイン規則が持つ正規表現ソース文字列の検証。
 *
 * @spec ドメイン検出（G3）
 *
 * SRP: このファイルは「その文字列は JavaScript の RegExp としてコンパイルできるか」
 * だけを判断する。評価は predicate.ts、規則の組み立ては compile.ts が持つ。
 *
 * 必要な理由: ドメイン定義の targetPattern は LLM 生成 (domains draft) と手書きの
 * 両方から来る。生成側が Python 由来の書き方 (`(?i)auth` のインラインフラグ) を出すと
 * JS の `new RegExp` は "Invalid group" で throw し、**ドメイン検出そのものが例外終了**
 * して全ドメインが失われる。1 パターンの誤りを 1 規則の損失に閉じ込めるために、
 * 書き込み時と評価時の両方でここを通す。
 */

/** JS の RegExp が受け付けない書き方に、直し方まで書いた説明を返す。 */
export function regexSourceProblem(src: string): string | null {
  try {
    new RegExp(src);
    return null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // 実測でいちばん多い誤りなので、原因ではなく直し方を出す。
    if (/^\(\?[a-z]+\)/.test(src)) {
      return `${reason} — インラインフラグ (${src.slice(0, src.indexOf(")") + 1)}) は JavaScript では使えません。大文字小文字を無視したい場合は [Aa] 形式の文字クラスへ展開してください`;
    }
    return reason;
  }
}

/** JS の RegExp としてコンパイルできるか。 */
export function isValidRegexSource(src: string): boolean {
  return regexSourceProblem(src) === null;
}

/**
 * 規則パラメータのうち正規表現として扱われるものを取り出す。
 *
 * preset ごとに列挙すると preset 追加のたびに追従漏れが出るので、`*Pattern` という
 * 命名規約 (targetPattern / pathPattern / namePattern …) を唯一の根拠にする。
 */
export function regexParamEntries(
  params: Record<string, unknown> | undefined,
): Array<[string, string]> {
  if (!params) return [];
  return Object.entries(params).filter(
    (entry): entry is [string, string] =>
      entry[0].endsWith("Pattern") && typeof entry[1] === "string",
  );
}

/** 規則パラメータ内の壊れた正規表現をすべて列挙する (空なら健全)。 */
export function invalidRegexParams(
  params: Record<string, unknown> | undefined,
): Array<{ key: string; pattern: string; problem: string }> {
  const invalid: Array<{ key: string; pattern: string; problem: string }> = [];
  for (const [key, pattern] of regexParamEntries(params)) {
    const problem = regexSourceProblem(pattern);
    if (problem) invalid.push({ key, pattern, problem });
  }
  return invalid;
}
