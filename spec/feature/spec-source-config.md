# feature: spec 正本パス設定と自動検出

## 目的

各リポの spec 正本が必ず LUDIARS レイアウト（コード root 配下の markdown）に
沿っているわけではない。プロジェクトごとに spec の在処を設定できるようにし、
未設定でも見つけられるときは自動設定して進み、見つからないときはユーザに報告する。

## 設定の器

`Project.specDirs`（レジストリ永続、既存）を設定として使う。付随して
`specDirsAuto: boolean` が「自動検出された値」かを区別する:

| specDirs | specDirsAuto | 意味 |
|---|---|---|
| 無し | — | 既定。root 配下の markdown を解析（LUDIARS レイアウト） |
| 有り | true | 自動検出で設定された。次の検出で置換されうる |
| 有り | 無し | ユーザ設定。自動検出は決して上書きしない |

`specDirs` は fingerprint の config dir に折り込まれているため、変更すれば
次回解析はキャッシュを外して新しい spec 根で再リンクする。

## 解決順序（`ProjectManager.ensureSpecConfig`）

解析のたび（fingerprint 計算の前）に解決する。結果はプロセス内 memo
（`updateSpecDirs` とプロセス再起動でクリア）。

1. `specDirs` 設定済み → そのまま使う（`configured` / `auto`）。
2. rootPath 配下に markdown が 1 つでもある → 既定の walk で足りる（`root`）。
3. 自動検出（`project/spec-detect.ts`）: root が git root **でない**場合のみ、
   祖先（最大 3 hop、最寄りの git root まで）の `spec` / `specs` / `doc` /
   `docs` / `design` ディレクトリで markdown を含むものを候補にする。
   - 見つかった → `specDirs` に**永続化**（`specDirsAuto: true`）して続行（`auto`）。
   - 見つからない → `missing`。解析は spec 無しで続行し、CLI / ダッシュボードが
     ユーザに報告する。

git root ガードの理由: リポ root 直下に markdown が無いリポの親は、多くの場合
ワークスペース（兄弟クローンの集まり）であり、隣のプロジェクトの docs/ を
拾ってはならない。祖先探索はコード root がリポ内サブディレクトリのときだけ意味を持つ。

## 操作面

### CLI

```sh
anatomia project spec <id>                 # 現在の解決を表示（未設定なら検出も走る）
anatomia project spec <id> --set <dir>     # 設定（複数可、相対はプロジェクト root 基準）
anatomia project spec <id> --clear         # クリア（自動検出の既定に戻す）
```

- `--set` のパスは存在チェックあり（無ければ fail-fast）。
- `project analyze` の出力にも解決結果が付く（`auto` の検出報告 / `missing` の警告）。

### Web（ダッシュボード）

- `GET  /api/projects/:id/spec-config` → `{ projectId, source, dirs? }`
- `PUT  /api/projects/:id/spec-config` body `{ specDirs: string[] }`（設定）/
  `{ specDirs: null }`（クリア）
- プロジェクト一覧の各行の **Spec** ボタンから表示・設定・クリアできる。

## 不変条件

1. ユーザ設定（`specDirsAuto` 無し）を自動検出が上書きすることはない。
2. `missing` は解析を止めない（spec リンクが空になるだけ）。ただし毎回報告する。
3. 検出は決定的（候補名の固定順・祖先の近い順）。LLM を使わない。
4. 設定変更は fingerprint を変えるので、古い解析キャッシュが誤って返ることはない。

## 関連

- [spec-linkage.md](./spec-linkage.md) — 収集した spec がどうリンクされるか
- [../data/project-cache.md](../data/project-cache.md) — fingerprint と config dirs
- [analysis-procedure.md](./analysis-procedure.md) — 操作手順
