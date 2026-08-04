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

## accessor 帰属解像度（#322、implemented 2026-08-04）

accessor の domain 解決は単一の resolver `domainsAt(ranges, line, enclosingType, domainsOf)` に集約し、
狭い scope から順に一意に解けた時点で確定する:

1. **関数 scope** — 使用行を内包する解析関数のうち**行範囲が最小**のもの（`enclosingFn`）。
   nested / local function が外側関数に飲み込まれるのを防ぐ。
2. **型 scope** — property/field initializer のように関数外だが class 内の使用は、同じ `enclosingType`
   を持つ解析関数だけから domain を取る。複数 class 同居ファイルでの過大帰属を防ぐ。
3. **file scope** — 型情報が無い file-scope 使用は、そのファイルの semantic domain が**一意な場合だけ**採用。
   複数 domain なら推測せず欠落にする。

`Type` と `.Instance` / `.Resolve` が改行で分かれた accessor も 2 行 window で検出し、使用行は型トークン側の
行として記録する。内包クラス名はファイルを前方に 1 パス走査して追跡する（`trackEnclosingClass`）＝
使用行ごとの後方再走査による二乗コストを避ける。network client の owner（同名 class の関数を優先）と
DI field も同じ resolver を使い、単純な「ファイル内の全 domain」への拡散を行わない。

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
- accessor の解像度は検出済み semantic domain の粒度に依存する。関数/型/file-unique のいずれでも
  一意に解けない使用は欠落として残し、複数 domain へ推測展開しない。
- 通信先サーバは**論理種別**まで（DI される具体 URL/host はソースに無いので出さない）。種別分類は名前ヒューリスティック。

## 関連

- 利用先: [feature/domain-view.md](./domain-view.md)
- インターフェース: [interface/web.md](../interface/web.md)
