# feature: シーン導出とシーンキャッシュ（call-graph reachability）

## 目的

トレース記録が無いプロジェクトでも「各シーンが実際に何を activate するか」を静的に
答える。画面 (screens) の浅い帰属（自ファイルのドメインのみ）ではなく、**画面のファイル
に宣言された関数を起点に `calls` 辺を再帰的に辿り、閉包に現れる全ドメイン**をそのシーン
に帰属させる。ナビゲーション（navigatesTo）は解決できた対象だけ**シーン遷移**になる。

導出結果は決定的（ソート済み・LLM 無し・時刻無し）なので、fingerprint キー付き
artifact（= **シーンキャッシュ**）として永続化し、Omnipotens 等の下流解析が再解析なしで
読める。

## 層の関係

| 層 | 責務 |
|---|---|
| `screens/`（静的検出） | 画面の存在・構成・遷移をソーススキャンで検出する |
| `scenes/from-screens.ts` | ScreenGraph → SceneRef の浅い射影 + **シーン id 割当の正本**（`assignSceneIds`） |
| `scenes/derive.ts` | 本仕様。閉包歩行によるドメイン帰属 + 遷移解決（`DerivedSceneGraph`） |
| `scenes/store.ts` | 手動シーン（`spec/data/<project>.scenes.json`）。マージ時に **manual が id 衝突で勝つ** |
| `integral/scene.ts` | トレース由来シーン（局面）。SceneModel の型の所有者 |

derived / 浅い射影 / 手動は `assignSceneIds` により**同じ画面 = 同じシーン id** を共有する
（同一エンティティの精緻化であり、別エンティティにならない）。

## DerivedScene

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

## 不変条件

1. 決定的：同じ AnalysisContext + ScreenGraph からは byte 単位で同一の JSON。
   時刻・乱数・LLM を含まない。
2. 閉包は **`calls` 辺の outgoing 方向のみ**。depth 上限は任意（`maxDepth`、既定無制限）。
   1 シーンにつき起点集合からの BFS 1 回（関数ごとではない）。
3. ファイルを持たないシーン（LoadScene 名のみの Unity scene 等）も落とさない
   （entry 0・domains は空になり得る）。
4. 解決できない navigatesTo（外部 URL / 未検出画面）は遷移にしない（捨てる）。
5. 導出はソースの純関数 → **シーンキャッシュは fingerprint キーで安全**。手動シーン
   （scenes.json）は fingerprint に含まれないため、**artifact には derived だけを置き、
   manual は読み出し時にマージ**する（編集が再解析なしで反映される）。

## シーンキャッシュ（永続化）

- 置き場所: プロジェクトキャッシュの artifact（`<home>/cache/<projectId>/artifact-scenes-derived.json`、
  → data/project-cache.md）。envelope は `{ version, fingerprint, builtAt, data }`。
- fingerprint 不一致（ソース変更）は miss → 再導出。`--max-depth` 指定時は
  `scenes-derived-d<n>` と別スロットに置き、上限違いが cross-serve しない。
- 消費経路:
  - CLI: `anatomia scenes --project <id> [--json] [--max-depth <n>]`
  - Web: `GET /api/projects/:id/scenes` → `{ derived, manual, merged }`
  - web-cache prepare（scene-modules ビュー）は浅い射影の代わりに derived を使う。

## 限界

- 静的閉包は过大帰属し得る（dead 分岐・条件付き呼び出しも辿る）。トレース由来シーンが
  あればそちらが実挙動の正で、マージ順（manual > discovered）で精緻化できる。
- 画面検出（screens/detect.ts）のヒューリスティックが土台。検出されない画面は
  シーンにならない（→ 手動シーンで補う）。
- navigatesTo はファイル粒度帰属（screen-composition.md の既知の粗さ）を継承する。

## 関連

- [screen-composition.md](./screen-composition.md) — 画面検出（入力）
- [integral-search.md](./integral-search.md) — シーン層の消費者（scene 展開）
- [../data/project-cache.md](../data/project-cache.md) — artifact 機構
- [analysis-procedure.md](./analysis-procedure.md) — 操作手順
