---
title: Anatomia knowledge adapter and legacy migration
type: feature
service: anatomia
domain: knowledge-model
status: implemented
x-anatomia:
  kind: knowledge-adapter-migration
---

# Knowledge application service と legacy migration {#SPEC-knowledge-adapter-migration}

`src/knowledge/application/` が domain/scene の command/query、revision conflict、projection rebuild status
を所有する。CLI/MCP/Web/Integral/web-cache はこの service または同じ canonical reader result を消費し、
adapter 固有の merge/write rule を持たない。

legacy migration は次の二段階だけを許可する。

1. `.anatomia/domains`、committed DomainDef、taxonomy、screens、manual scenes を read-only inventory し、
   stable ID operations、annotation writes、conflict、warning、source fingerprint を dry-run plan として返す。
2. 人が plan を確認して `confirmApply=true` を渡した場合だけ、source fingerprint と knowledge head を再検証し、
   rollback-safe に migration transaction と annotation-only file を書く。

元 artifact は削除・変更しない。executable DomainDef は実行しない。manual scene の domain/composition/transition
override は移行せず、canonical scene に一致する label/description/review note だけが annotation 候補になる。

HTTP は `GET /api/projects/:id/knowledge/status`、
`POST /api/projects/:id/knowledge/migration/plan`、
`POST /api/projects/:id/knowledge/migration/apply`。MCP は status と read-only plan を公開する。
CLI は `anatomia knowledge status --project <id>` と
`anatomia knowledge migration-plan --project <id>` を同じ service へ接続する。
