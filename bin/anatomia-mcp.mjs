#!/usr/bin/env node
// bin/anatomia-mcp.mjs — MCP stdio server entry point (A-1).
//
// Launches the Anatomia MCP server over stdio so an AI host (Claude Code,
// Famulus, Concordia) can call anatomia.context / verify / where / impact and
// the project tools. Providers (embedder + LLM) are resolved from the
// environment — see docs/mcp-setup.md. stdout is the MCP transport; all
// diagnostics go to stderr.
import { main } from "../dist/adapters/mcp.js";
await main();
