# 機能(module) 層 — 関数とドメインの間の凝集単位

## 位置づけ

関数(構造グラフ)とドメイン(意味)の間に **機能/module** が入る。機能は
**決定的な構造凝集単位**: 既定はディレクトリ、`enclosingType` があればクラス。
ドメインは複数機能にまたがり、機能はドメインに属する。パネルの vis-data の
`group` 集約と一致するので、新概念ではなく既存集約の明示化+評価。

## 集約の評価 (再クラスタリングはしない)

機能境界は構造で確定し、**集約の質をスコアで評価**する:

| 指標 | 定義 | 用途 |
|---|---|---|
| 内部結合率 cohesion | `internal / (internal + outgoingExternal)` (0..1) | 機能の正メンバか |
| 越境結合 coupling | 機能境界をまたぐ fan-out/in | 機能間依存の太さ |
| misfit 関数 | 自機能より他機能に強く結合(`attractedTies > homeTies`) | 別機能へ移すべき signal |
| modularity Q | Newman (−0.5..1) | 分割全体の良さ / ドメイン↔機能ズレ |

構造-tie(calls/reads/writes)のみを数える。**自動再編はしない**(決定性維持)。
低凝集・misfit は人間 / Sonnet judge / ドメイン再構成への signal として surface する
だけ(黙って group を上書きしない)。

## 使い道

1. **integral search の climb 粒度** = 機能。関数から半径を広げるとき、機能まるごと
   を引く([[integral-search]] の climb=module)。
2. **Domain View 右ペイン** = 選択ドメインが張る機能を凝集度つきで一覧。解析時点で
   artifact 化(`cachedArtifact("module-eval"/"domain-view")`)するので、開いても
   再解析せず即時(従来の長時間停止を解消)。

## 取得面

- `GET /api/projects/:id/modules` → `ModuleEvaluation`
- `GET /api/projects/:id/domain-view` → `{ views, modulesByDomain, modularity,
  granularity, misfits }`(右ペインの機能リスト + misfit)

## 限界

- 既定粒度=ディレクトリ。クラス粒度は `.h`/`.cpp` 分割を跨がない(follow-up)。
- 凝集は呼び出し辺の解像度に依存([[static-analysis]] の解決限界を継承)。
