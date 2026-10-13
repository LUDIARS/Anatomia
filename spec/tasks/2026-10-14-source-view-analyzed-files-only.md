# ソースビューの読み取り範囲と起動元検証

Actio: actio:200343a5-32cc-40a2-b696-81a507af30be

- [x] 解析ファイル集合と内容ハッシュの有無を分け、共通検証で対象外を I/O 前に拒否する。
- [x] Host の構文・loopback を検証し、既存の Origin / proxy 判定を維持する。
- [x] ダミー隠しファイル、Host 欠落・外部名・IPv6 と解析済み正常系の回帰テストを用意する。
- [x] 実装前に C-1 / C-2 の述語と manifest を作成し、Augur で注入する。

## 契約

C-1 resolveSourceTarget(request): 解析結果に含まれないファイルを読み取り前に拒否する
C-2 classifyLaunchRequest(input): Host が無い要求と非 loopback Host を local にしない

## 検証計画

augur plan (bug_fix / web) の回帰優先計画に従い、source-view.test.ts の content / launch 拒否と既存正常系を対で確認する。
サービスの起動・再起動は行わない。テストスイート実行は明示許可が無いため行わず、契約の実行証跡は委託で指定された契約実行に限定する。

## 再利用

resolveSourceTarget を両 route 共通の拒否箇所として再利用する。analyzedContentHash と同じ repo 相対表記で集合を照合するが、contentHash の存在を所属判定に使わない。isLoopbackHost は再利用し、HTTP Host で 127. 接頭辞だけの外部名を許さないよう IP 構文検証を加える。

## 検証結果

- 型検査（tsc --noEmit）とビルド（tsc）成功。既存 checkout の依存パッケージを読み取り参照。
- 契約実行: C-1 は 2 呼び出し、C-2 は 4 呼び出し、違反 0。Augur acceptance は両方 met=true。
- 回帰テストスイートは未実行。サービス起動・再起動なし。
