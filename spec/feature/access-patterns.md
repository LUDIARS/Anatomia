# feature: アクセスパターン検出（singleton / service-locator / facade）

## 目的

ゲームは**シングルトン**を多用し、**Facade / Service Locator** 的な集約点経由でサブシステムへ
アクセスする。これらは全所から触られる横断的ハブで、ドメインビューを毛玉化させる一方、
「どのドメインが・どの集約点に・どうアクセスするか」はアーキテクチャ理解の核心。これを
**ヒューリスティックに検出**し、ドメインビューに重ねて視覚化する。

## なぜソーススキャンか

C# Unity の支配的なシングルトン形は**静的プロパティ** `public static GameManager Instance { get; }`
／`=> s_instance;`。プロパティと `Type.Instance` メンバアクセスは関数 DAG に抽出されないため、
グラフ overlay では実ゲームで 0 件になる（実証: KS で graph 方式=0、source 方式=28 検出）。よって
**ソーステキストを走査**して宣言と `Type.Member` 使用を拾い、使用箇所を**行範囲で内包する解析済み
関数**→そのドメインへ帰属させる。

## 振る舞い

`detectAccessPatterns(ctx)`（`src/patterns/detect.ts`、`src/domains/` とは独立＝B-3 非干渉）。
純関数 `scanForPatterns(files, functions, domains, repoPath)` ＋ fs 読みラッパ。

- **singleton**: `static … Instance/GetInstance`（プロパティ`{`/式`=`/メソッド`(`/フィールド`;`）。
  小文字 `instance/getInstance` はメソッド`(`のみ（C++ Meyers/TS getter）＝private backing field を誤検出しない。
  識別子＝**内包クラス名**（上方向に `class/struct` 走査）。
- **service-locator**: locator-ish ファイル（`locator|servicelocator|container`）内の `Resolve/Provide/GetService/Locate`。
- **facade**: クラス名 `*Facade`。
- **network**: 通信クライアント。クラス名 `*ApiClient/*HttpClient/*WebSocketClient/*Gateway` 等、または
  ネットワーク API トークン（`UnityWebRequest/HttpClient/WebSocket/System.Net/fetch(` …）を含むクラス。
  **通信先 URL/host は DI されるのでソースに無い → クライアント名から論理的なサーバ種別を分類**
  （`classifyServer`: login→ログインサーバ / rank→ランキングサーバ / match・lobby→ゲームサーバ /
  error・log→ログ解析 / serial・billing→課金/コード / asset→アセット配信 / 既定→APIサーバ）。`target` に格納。
- **accessors**: singleton/locator/facade は `Type.Instance` / `Type.Resolve(` 使用 → 使用行を内包する関数 →
  そのドメイン＋種別（`reads`=プロパティ/`calls`=メソッド）。network は実体が DI されるため、クライアントを
  **所有するドメイン**（クライアントのファイルの関数群）を `calls` で帰属。`{domain, access}` で集約。

精度優先（汎用 `get`・素の `registry.get` は除外）。返りは `AccessPattern[]`
`{ name, file, line, kind, reason, target?, accessors:[{domain,access}] }`。route `GET /api/projects/:id/access-patterns`。

## パネルでの使われ方（ドメインビュー）

[feature/domain-view.md](./domain-view.md) の機能単位グラフに重ねる:

- パターンを含む機能単位ノードを**枠色＋アイコン**で明示（◆ singleton / ⬡ locator / ▤ facade は黄枠、
  **☁ network は青緑（teal）枠で「色を変えて」明示し、ノードに通信先サーバ種別を併記**）。tooltip に検出名。
- 下部「Access patterns（このドメインが触る）」に、選択中ドメインが accessor に含まれるパターンを
  `名前 [kind / network→種別] reads/calls` で一覧（＝**どのドメインが・どの集約点/サーバに・どうアクセスするか**）。

## 制約

- 名前/署名/ソースのヒューリスティックなので完全ではない（精度優先＝見逃しあり）。
- accessor の解像度は検出ドメインの粒度に依存（粗い builtin だと帰属が大雑把、B-3 で改善）。
- 通信先サーバは**論理種別**まで（DI される具体 URL/host はソースに無いので出さない）。種別分類は名前ヒューリスティック。

## 関連

- 利用先: [feature/domain-view.md](./domain-view.md)
- インターフェース: [interface/web.md](../interface/web.md)
