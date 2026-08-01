# feature: シーン導出とシーンキャッシュ（call-graph reachability）

## 目的

現行の screen → call-graph reachability を維持しつつ、planned contract（T63-T66）では scene の
identity、composition、transition、reachability を **code / engine asset 正本で全自動割当**する。
active Domain は approved code-owner edge、SpecClause は approved code-spec link から自動導出する。
手動 scene は権威を持たず、trace は runtime observation を加えるだけとする。

トレース記録が無いプロジェクトでも「各シーンが実際に何を activate するか」を静的に
答える。画面 (screens) の浅い帰属（自ファイルのドメインのみ）ではなく、**画面のファイル
に宣言された関数を起点に `calls` 辺を再帰的に辿り、閉包に現れる全ドメイン**をそのシーン
に帰属させる。ナビゲーション（navigatesTo）は解決できた対象だけ**シーン遷移**になる。

導出結果は決定的（ソート済み・LLM 無し・時刻無し）なので、fingerprint キー付き
artifact（= **シーンキャッシュ**）として永続化し、Omnipotens 等の下流解析が再解析なしで
読める。

## 目標 SceneManifest（planned）

definition detector（static-code / engine-asset / route / workflow）は共通
`SceneDefinitionSeed` を返し、canonical `SceneManifest` へ正規化する。trace detector は別型の
`SceneObservation` を返し、stable scene ID / observed anchor で既存 scene にだけ結び付ける。
対応先の無い phase は provisional diagnostic とし、canonical identity、composition、transition を
新規作成しない。

stable scene ID の優先順:

1. engine GUID / native asset ID
2. explicit code annotation / route ID
3. qualified entry symbol
4. project ID + source identity の deterministic hash

表示 label、file path、domain name は identity にしない。rename/delete は alias/tombstone で追跡し、
同じ scene を無言で別 ID にしない。

Scene record:

- stable ID、label、kind、origin、source revision、provenance
- entry CodeSymbols と direct / reached の区別
- SceneElements と exact source anchors
- contains / subscene / transition edges
- active CodeSymbols
- CodeSymbol owner から導出した active Domains
- reached CodeSymbol の spec link から導出した SpecClauses
- definition provenance

`SceneObservation` は trace revision、observed anchors、time/frame range、対応 scene ID/confidence を持つ
local overlay。canonical Scene record / manifest / generated OKF には含めず、query/UI が必要時に join する。

scene の構成物を function **または** domain の一方へ分類しない。

```text
Scene ─contains→ SceneElement
Scene ─has-entry / activates→ CodeSymbol
SceneElement ─realized-by→ CodeSymbol
CodeSymbol ─owned-by→ Domain
Scene ─activates→ Domain               # 上の relation から導出
```

scene activation は many-to-many の利用関係で、CodeSymbol の exclusive ownership ではない。
同じ function が複数 scene で active でもよく、到達不能 function へ fake default scene を与えない。
subscene hierarchy と subdomain hierarchy は別 graph である。

## 目標永続化と同期（planned）

- code / asset 解析結果を knowledge log の code-sync transaction として保存する。
- `<knowledgeWriteRoot>/data/generated/anatomia/scene-manifest.json`、`scene-edges.jsonl`、
  `scenes/*.md` を deterministic projection として生成する。
- scene OKF は `type: data` + `x-anatomia.kind: scene`。人は編集しない。
- 大量の function/element edge は JSONL/Kuzu、OKF は可読 summary + refs を持つ。
- repository write は explicit `sync` / apply command だけ。GET / query は副作用を持たない。
- scene の entity/edge assignment に human Gate を置かない。sync は source revision と detector
  determinism を検証して自動的に全 relation を置換し、人は表示注記だけを加える。
- `replace-derived-set` は definition source 由来の scene/edge だけを対象にし、trace observation は
  Git 管理 log へ入れず local observation store に置く。
- manifest は `knowledgeHead`、scene definition fingerprint、approved relation revision、
  projection schema を持ち、consumer が stale を検証する。
- scene definition fingerprint は code/asset/detector config だけから作り、generated subtree と
  scene sync transaction 自身を除外する。output fingerprint と分ける。
- 任意の manual annotation は label/description/review note だけを持ち、identity、transition、
  composition、function/domain/spec relation を上書きしない。

完全な writer 契約は [OKF generation](./okf-generation.md)、machine relation は
[domain knowledge log](../data/domain-knowledge-log.md)。

## 現行実装の層（migration source）

| 層 | 責務 |
|---|---|
| `screens/`（静的検出） | 画面の存在・構成・遷移をソーススキャンで検出する |
| `scenes/from-screens.ts` | ScreenGraph → SceneRef の浅い射影 + **シーン id 割当の正本**（`assignSceneIds`） |
| `scenes/derive.ts` | 本仕様。閉包歩行によるドメイン帰属 + 遷移解決（`DerivedSceneGraph`） |
| `scenes/store.ts` | legacy 手動シーン。現行 merge では **manual が id 衝突で勝つ**が T66 で廃止する |
| `integral/scene.ts` | トレース由来シーン（局面）。SceneModel の型の所有者 |

現行 derived / 浅い射影 / 手動は `assignSceneIds` により同じ ID を共有する。これは migration
source の説明であり、manual override を目標契約として認めるものではない。

## 現行 DerivedScene

`SceneRef`（id / label / domains）の拡張：

| フィールド | 意味 |
|---|---|
| `file` / `kind` / `stack` / `route?` | 由来 ScreenNode の出自 |
| `directDomains` | 自ファイルだけの浅い帰属（ソート済み） |
| `domains` | **閉包帰属**：entry 関数から `calls` を辿って到達した全関数のドメイン ∪ directDomains |
| `entryFunctions` | 画面ファイルに宣言された関数数（閉包の起点集合） |
| `reachedFunctions` | 閉包サイズ（起点含む） |
| `transitions` | navigatesTo のうち検出画面に解決できたもののシーン id（ソート済み） |

`DerivedSceneGraph` は `version: 1` + `scenes[]`（id 順）+ summary
（total / withEntries / transitions / domainsCovered）。

## 現行 DerivedScene の不変条件

1. 決定的：同じ AnalysisContext + ScreenGraph からは byte 単位で同一の JSON。
   時刻・乱数・LLM を含まない。
2. 閉包は **`calls` 辺の outgoing 方向のみ**。depth 上限は任意（`maxDepth`、既定無制限）。
   1 シーンにつき起点集合からの BFS 1 回（関数ごとではない）。
3. ファイルを持たないシーン（LoadScene 名のみの Unity scene 等）も落とさない
   （entry 0・domains は空になり得る）。
4. 解決できない navigatesTo（外部 URL / 未検出画面）は遷移にしない（捨てる）。
5. 現行の導出はソースの純関数 → **シーンキャッシュは fingerprint キーで安全**。手動シーン
   （scenes.json）は fingerprint に含まれないため、**artifact には derived だけを置き、
   manual は読み出し時にマージ**する。これは T66 までの legacy behavior。

## 現行シーンキャッシュ（legacy compatibility）

- 置き場所: プロジェクトキャッシュの artifact（`<home>/cache/<projectId>/artifact-scenes-derived.json`、
  → data/project-cache.md）。envelope は `{ version, fingerprint, builtAt, data }`。
- fingerprint 不一致（ソース変更）は miss → 再導出。`--max-depth` 指定時は
  `scenes-derived-d<n>` と別スロットに置き、上限違いが cross-serve しない。
- 消費経路:
  - CLI: `anatomia scenes --project <id> [--json] [--max-depth <n>]`
  - Web: `GET /api/projects/:id/scenes` → `{ derived, manual, merged }`
  - web-cache prepare（scene-modules ビュー）は浅い射影の代わりに derived を使う。

## 限界

- 静的閉包は過大帰属し得る（dead 分岐・条件付き呼び出しも辿る）。trace は実際に通った経路の
  observation として confidence を補強するが、code / asset の scene 定義を黙って上書きしない。
- 画面検出（screens/detect.ts）のヒューリスティックが土台。検出されない画面は
  現行ではシーンにならない。planned contract では code annotation、asset detector、detector config
  のいずれかを補正し、manual scene identity で穴埋めしない。
- navigatesTo はファイル粒度帰属（screen-composition.md の既知の粗さ）を継承する。
- 現行 `SceneRef` / `DerivedScene` は exact entry/reached anchors、element、line/reason、spec refs、
  detector provenance を失うため、canonical manifest へ直接流用しない。

## 関連

- [screen-composition.md](./screen-composition.md) — 画面検出（入力）
- [integral-search.md](./integral-search.md) — シーン層の消費者（scene 展開）
- [../data/project-cache.md](../data/project-cache.md) — artifact 機構
- [analysis-procedure.md](./analysis-procedure.md) — 操作手順
- [okf-generation.md](./okf-generation.md) — generated scene OKF
- [domain-organization.md](./domain-organization.md) — scene と domain の直交
