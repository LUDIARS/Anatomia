# data: クロスサービス cost-feed ストア

LUDIARS 横断の LLM コスト可視化で、各サービスが PUSH してくるコスト要約を web サーバ内に
latest-wins で保持するストア（`src/cost/feed.ts`）。Anatomia は受信ハブ側。
プロセス内データ（永続 DB ではない）。

## エントリ

`CostFeedEntry`（POST `/api/cost-feed` で取り込み、→ [interface/web.md](../interface/web.md)）。
キーは `service`、後着が前着を上書きする（latest-wins）。

POST body：

```jsonc
{
  "service": "discutere",      // 送信元サービス名（latest-wins のキー）
  "ts": 1750000000000,         // 任意。省略時はサーバ受信時刻
  "sessions": [
    {
      "sessionId": "…",
      "model": "claude-opus-4-8",   // 任意
      "backend": "claude-cli",       // 任意
      "calls": 12,
      "inputTokens": 0,
      "outputTokens": 0,
      "cacheReadTokens": 0,
      "cacheCreationTokens": 0,
      "costUsd": 0.0
    }
  ]
}
```

GET `/api/cost-feed` は `aggregateCostFeed`（`src/cost/aggregate.ts`）で全サービス分を
集計したレポートを返す（管理パネル用）。

> このフィードは Anatomia の解析機能とは独立した観測レーン。コアの supply→verify には関与しない。
