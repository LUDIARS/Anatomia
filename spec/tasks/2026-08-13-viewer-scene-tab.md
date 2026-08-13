---
task: viewer-scene-tab-20260813
project: Anatomia
kind: 実装
created: 2026-08-13T04:00:00.000Z
memory_links:
  - spec/feature/viewer-scene-domain-tabs.md
  - spec/feature/scene-derivation.md
  - spec/feature/screen-composition.md
---
# ビューア シーンタブ (画面再現 + 二層ドメイン列挙)

## 目的
[viewer-scene-domain-tabs.md](../feature/viewer-scene-domain-tabs.md) のシーンタブを実装する。
管理パネルをシーン / ドメインの 2 トップタブに再編する土台もこのタスクで行う。

## 完了条件
- [ ] トップタブ再編: [シーン] [ドメイン] の 2 タブ構成 (既存 Domain View / graph / scenes タブは新構成へ整理)。
- [ ] シーン一覧: canonical SceneManifest を kind / stack ごとに一覧。
- [ ] 画面再現の忠実度 fallback: キャプチャ artifact → ScreenGraph ワイヤーフレーム → SceneElement ツリー。表示中の忠実度をバッジで明示。
- [ ] 関連ドメイン列挙: active Domains (ビジネス) + belongs-to 導出のプログラムドメインを両方列挙し、ドメインタブ該当層へ stable ID ベースで deep link。
- [ ] 遷移: transition edges を隣接 scene への link として表示。
- [ ] `GET /api/projects/:id/scene-view` (prepared cache から読む。開いた瞬間の再解析なし)。
- [ ] typecheck / vitest green。

## スコープ (編集可ディレクトリ)
- `src/adapters/web/`, `src/web-cache/`, `src/scenes/`, `src/screens/`, `public/`
