# Anatomia MCP — connecting a real AI (A-1 / A-2)

This is the "重心" of Anatomia: an AI host (Claude Code / Famulus / Concordia)
calls Anatomia over MCP **before** it writes code (`context` / `where`) and
**after** (`verify`), so the supply→verify loop runs against real architecture.

## 1. Build

```sh
npm install
npm run build      # the MCP bin loads dist/, not the .ts sources
```

## 2. Providers (real LLM + embedder)

Anatomia takes its LLM and embedder as injected providers (`src/providers/`).
They are resolved from the environment at MCP startup; the server logs what it
wired to **stderr** on boot:

```
[anatomia/mcp] providers: llm=anthropic(claude-opus-4-8), embed=openai-compat(...)
```

| Variable | Effect |
|---|---|
| `ANATOMIA_LLM_BACKEND` | LLM backend: `anthropic` \| `claude-cli` \| `stub`. Omit to infer (key set → `anthropic`, else → **`claude-cli`**). `stub` is an EXPLICIT offline placeholder — never an automatic fallback for a missing key (a config deficiency is an error, not a silent downgrade). |
| `ANTHROPIC_API_KEY` | Selects/enables the Anthropic SDK distiller. **Unset → `claude -p` subscription CLI** (the default real distiller; no key needed). |
| `ANATOMIA_CLAUDE_BIN` | `claude` executable path for the `claude-cli` backend (default resolves on PATH). |
| `ANATOMIA_LLM_MODEL` | Distiller model id (SDK + CLI). Default `claude-opus-4-8` (set `claude-haiku-4-5` for cheap/fast). |
| `ANATOMIA_EMBED_BASE_URL` | OpenAI-compatible embeddings base URL incl. `/v1`. **Unset → deterministic hash embedder** (lexical-overlap only, not semantic). |
| `ANATOMIA_EMBED_API_KEY` | Bearer key for the embeddings endpoint (omit for keyless local servers). |
| `ANATOMIA_EMBED_MODEL` | Embeddings model id. Default `text-embedding-3-small`. |
| `ANATOMIA_EMBED_DIM` | Hash-embedder dimension (offline fallback). Default `256`. |
| `ANATOMIA_CACHE_DIR` | Persist the domain-card LLM cache to this dir (content-addressed, keyed by content + model + prompt version) so cards are reused across MCP invocations / sessions / repos. **Unset → in-memory** (per-process). |

The embedder is what makes the **duplication gate** real: with the zero-vector
mock (or no embedder) it always passes — "ザル". A real embedder (or at least
the hash fallback) gives it a similarity signal. Anthropic has no embeddings
product, so the embedder is intentionally a separate, swappable backend — point
it at OpenAI, a local Ollama serving (`http://127.0.0.1:11434/v1`), or any
OpenAI-compatible endpoint.

### Example — Anthropic distiller + local Ollama embedder

```sh
export ANTHROPIC_API_KEY=sk-ant-...
export ANATOMIA_EMBED_BASE_URL=http://127.0.0.1:11434/v1
export ANATOMIA_EMBED_MODEL=nomic-embed-text
```

## 3. Register with Claude Code

A project-scoped `.mcp.json` ships at the repo root. From the Anatomia repo
root (so the relative `args` path resolves):

```sh
claude   # picks up .mcp.json; approve the "anatomia" server when prompted
```

The `${VAR}` entries in `.mcp.json` are expanded from your shell environment at
launch (unset ones fall back to the offline providers). To register Anatomia for
**another** project, copy the `anatomia` block into that project's `.mcp.json`
and point `args` at this repo's absolute `bin/anatomia-mcp.mjs`, then add the
target repo with `anatomia.projects.add`.

Manual one-off (any MCP host that speaks stdio):

```sh
ANTHROPIC_API_KEY=sk-ant-... node /abs/path/to/Anatomia/bin/anatomia-mcp.mjs
```

## 4. Tools exposed

| Tool | Use |
|---|---|
| `anatomia.context` | Assemble a deterministic ContextBundle for a task (rules + spec + exemplars + existing domains). |
| `anatomia.verify` | Run the 5-gate verify on a diff (rule conformance, **duplication**, spec linkage, coupling delta, convention drift). |
| `anatomia.where` | Resolve landing point(s) for a task. |
| `anatomia.find` | Find function symbols and call fan counts without reading source files. |
| `anatomia.callers` | List callers of a function symbol or anchor. |
| `anatomia.callees` | List callees of a function symbol or anchor. |
| `anatomia.impact` | BFS impact radius from an anchor. |
| `anatomia.domains.suggest` | Suggest coarse domains from spec clauses (LLM-backed, or deterministic with `noLlm`). |
| `anatomia.projects.{list,add,analyze}` | Manage / analyze registered projects (multi-repo). |

## 5. Multi-project

The server starts a `ProjectManager`; if no registry exists it registers the
launch cwd as `default`. Add more repos at runtime with `anatomia.projects.add`
(name + absolute rootPath), then pass `project` to any tool to target it.
