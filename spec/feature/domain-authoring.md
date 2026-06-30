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

## ライブ / E2E 検証 runbook (#364)

ユニットは LLM/fs を注入で差し替えており実挙動を保証しない。実機検証は次の3経路。

### (1) 仕様 → ドラフト抽出 (実 LLM, claude -p) — **実走可・検証済**

```sh
npm run build                       # CLI は dist/ を読む
$env:ANATOMIA_LLM_BACKEND = "claude-cli"   # LUDIARS は claude -p 経由 (API 直叩き禁止)
node bin/anatomia.mjs domains draft --repo <repo> --dir <out> --json   # 実 LLM
node bin/anatomia.mjs domains draft --repo <repo> --dir <out> --no-llm # 決定的 seed (配線確認)
```

実測 (Anatomia 自身, fresh cache): 13 ドメインを抽出し **path/name パターンが実レイヤに
13/13 的中** (`/src/dag/` `/src/cache/` `/src/supply/` …)。description / specRefs (実 §9・G5
見出し) も充足。`mechanics` は空 = Anatomia は非ゲームなので正しい挙動。配線の hermetic
回帰は `src/domains/authoring/__tests__/draft-e2e.test.ts` (prompt 組立→LLM seam→parse→
reconcile→disk roundtrip) で固定。

> ⚠ **キャッシュのステール所見**: draft は content-keyed cache (spec 見出し+module map+
> modelId+prompt version) で再利用される。過去セッションの劣化出力 (description/specRefs が
> 空の最小ドラフト) がキャッシュに残っていると **次回も無言でそれが返る**。空キャッシュで
> 再走すると高品質出力が得られた。フォローアップ候補: prompt version bump / 品質ガード
> (空 description 比率が高い結果はキャッシュしない) / 明示的な cache 無効化フラグ。

### (2) Web `/flow` ファイル選択・URL/パス取得 — **実装済** (#456)

`src/adapters/web/routes/flow.ts` に以下の HTTP ルートを実装。`anatomia web` (manager
mode) で利用可能。

```
POST /api/projects/:id/flow/draft   -- 登録プロジェクトで draft 合成 (specClauses + filePaths)
GET  /api/projects/:id/flow/drafts  -- 現在の editable domains を一覧
POST /api/flow/draft                -- repoPath または specPath から直接 draft 合成
GET  /api/flow/drafts               -- 任意 dir のドメインを一覧 (?dir=<path>)
```

**入力モード**:
- `repoPath`: 任意リポを `analyze()` してフル解析 → specClauses + filePaths
- `specPath`: 単一 spec Markdown ファイルのパスを読んでパース → specClauses (filePaths=[])
- `project`: 登録済みプロジェクト ID → `manager.getContext()` で解析済み結果を取得

**オプション**: `noLlm` (決定的 seed)、`only` (ドメイン名フィルタ)、`force` (ロック上書き)、
`dir` (出力先 dir)。draft 後に project.ontologyDir を自動配線。

実走確認手順は runbook (3) を参照。URL フェッチ経路 (specUrl) は未実装。

### (3) Discord フォーラム添付の実 DL — **未実装**

サーバ側に Discord 連携 (添付 URL 取得・DL) は無い。実トークンも要る → 別タスクに分離。

## 限界

- 下書き品質は LLM/仕様の質に依存(雑でよい設計)。membership は人が締める。
- mechanics/specRefs はメタ情報(spec-linkage が権威の spec リンクとは別)。
