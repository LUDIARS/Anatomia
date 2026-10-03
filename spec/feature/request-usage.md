---
id: AN-REQUEST-USAGE
type: feature
---
# Incoming request usage

Value UX-AN-W1/W2: operators can tell whether agents actually consume supply/verify, without mistaking absent telemetry for no usage.

`platform-foundation` owns completed-call metadata and Vestigium log aggregation. `delivery-surface` owns HTTP/CLI/MCP instrumentation. These are generic supporting boundaries, not the analysis core.

One `anatomia request completed` event per completed HTTP request, CLI command or MCP tool call: transport, operation, caller, status, duration_ms. HTTP uses route templates (never raw paths/query/body), other transports use registered command/tool names. Caller is self-reported `X-Anatomia-Caller` for HTTP or `ANATOMIA_CALLER` for CLI/MCP; absent/invalid becomes `unknown`. Attribution is not authentication. Never infer Cc from localhost or generic node user-agent. Protocol/header/token/body and session identifiers are not stored.

`GET /api/request-usage?from=YYYY-MM-DD&to=YYYY-MM-DD` aggregates retained Vestigium JSONL for inclusive UTC days (default today, maximum 31 days). Response includes available files, malformed lines and truncation so a partial report cannot imply complete historical coverage. Exclude this reporting endpoint from request records to avoid observer inflation. Logs before instrumentation are not reconstructed. CLI start/exit legacy events are not double counted. Logging errors never fail analysis. Logging disabled state is visible in the API. Logs use the existing VESTIGIUM_LOGS_DIR and retention policy; different processes must share that directory for a combined report. Counts reflect completions, not in-flight/terminated calls. Read cap: 100,000 lines/file and 1,000 groups, with explicit truncation.

Acceptance: success/error requests counted once; secrets/parameters omitted; explicit caller and unknown distinguishable; date boundaries, malformed JSON and limits visible; CLI/MCP preserve results/errors and protocol stdout. Cc clients must send `X-Anatomia-Caller: concordia` to be attributable; older untagged clients remain unknown.

Rollback: revert instrumentation; existing Vestigium data is retained. No analysis/cache semantic changes.
