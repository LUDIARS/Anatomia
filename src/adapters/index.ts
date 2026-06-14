/**
 * adapters/ — G6 adapter public API.
 * T30: MCP adapter, T31: CLI gate, T32: Web viz.
 */

// MCP adapter
export { createServer, createHandlers, AnatomiaServer } from "./mcp.js";
export type { ToolHandlers } from "./mcp.js";

// CLI adapter
export { parseArgs, runCli, main as runCliMain } from "./cli.js";
export type { CliArgs } from "./cli.js";

// Web viz adapter
export { createApp, startServer } from "./web/server.js";
export type { WebServerOptions } from "./web/server.js";
