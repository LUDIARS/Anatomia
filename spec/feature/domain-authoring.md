# Domain Authoring — 仕様シードの人手調整ドメイン

## 目的 (DESIGN 課題1: ドメイン解析が弱い)

ドメイン検出は builtin ヒューリスティック + plugin に頼り、実コードに合った
ドメインを起こせなかった。これを **仕様 + ユーザ補助入力** で補間する:

1. **仕様からドメイン定義を抜粋し雑に作る** (LLM が下書き)。
2. **人間が調整する** (`.anatomia/domains/*.json` を直接編集)。
3. **再構成してもよい** が、人の編集を壊さない(ロック保全)。

ドメインの作りは人により異なる(メカニクスを含んでも含めなくてもよい)ので、
明確なルールは決めない。シーンステートはドメインに含めない(一致ケースは注記)。

## データモデル

`EditableDomainDef = DomainDef + { source, lockedFields?, mechanics?, specRefs?,
rationale?, updatedAt? }`。`source ∈ {spec-draft, manual, reconstructed}`。
余剰フィールドは検出パイプラインが無視する(`isDomainDef` は name/description/
presetRules/templateRules のみ検証)ので、**プロジェクトの ontologyDir に置けば
既存の検出・ルール・spec-linkage がそのまま消費する**(追加配線ゼロ)。

`DomainDraft`(下書き)= name / description / pathPatterns / namePatterns /
specRefs / mechanics / rationale。membership は **membership-marker preset**
(`couplingCap` を巨大上限で張る)に変換され、検出が NodeFilter を集めて
implementors を起こす(違反は出ない)。

## フロー

```
analyze → specClauses + module map
  → synthesizeDomainDrafts(LLM)  ─┐  (または seedDraftsFromStructure: 決定的 no-LLM)
                                  ├→ reconcileDrafts(existing, drafts) → EditableDomainDef[]
  loadEditableDomains(dir) ───────┘        ↓ ロック保全 / 部分再構成
                                  saveEditableDomains(dir) → 検出が消費
```

### reconcile ポリシー (非破壊的再構成)

- 既存なし → 新規追加 (spec-draft)。
- ロック済み / manual → そのまま保全。
- それ以外 → ロック外フィールドのみ draft で更新、source=`reconstructed`。
- draft に無い既存定義は素通し → **部分再構成**(`--only` で対象を絞れる)。
- `--force` でロックも上書き。

`lockedFields: ["*"]` は全ロック。source=`manual` は既定で全ロック扱い。

## LLM 非依存の宣言的代替

`seedDraftsFromStructure` は spec 見出しから骨組み下書きを決定的に起こす。
**サイレントフォールバックではなく明示選択**(`--no-llm`)。membership は空で人が
埋める。LLM 経路(`synthesizeDomainDrafts`)は content-keyed キャッシュで再実行が安い。

> 実装順序: **決定的な検索・部分再構成を実証してから** LLM キャッシュを使う
> (Phase A / reconcile は LLM 非依存で裏取り済み)。

## 取得面

- CLI: `anatomia domains <draft|list|reconstruct> --project <id>
  [--no-llm] [--only a,b] [--force] [--dir <path>] [--json]`
- 保存先 = `<repoRoot>/.anatomia/domains/`(= ontology pluginDir)。draft 時に
  project.ontologyDir 未設定なら自動で配線。ファイル名は名前ハッシュ付きで衝突回避。

## 限界

- 下書き品質は LLM/仕様の質に依存(雑でよい設計)。membership は人が締める。
- mechanics/specRefs はメタ情報(spec-linkage が権威の spec リンクとは別)。
