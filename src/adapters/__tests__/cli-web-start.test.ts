import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "../cli.js";

async function listenOnEphemeralPort(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe("web CLI startup", () => {
  it("exits cleanly when the warm server is already listening", async () => {
    const blocker = createServer((_request, response) => response.end());
    const port = await listenOnEphemeralPort(blocker);
    const home = await mkdtemp(join(tmpdir(), "anatomia-cli-web-"));
    const originalArgv = process.argv;
    const [runtime = "node", entrypoint = "anatomia"] = originalArgv;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      process.argv = [runtime, entrypoint, "web", "--port", String(port), "--home", home];

      await main();

      // Before the duplicate-start fix, main() returned before the listener's
      // asynchronous EADDRINUSE error escaped as an uncaught exception.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(warn).toHaveBeenCalledWith(
        `[anatomia/web] 127.0.0.1:${port} is already in use; duplicate start skipped`,
      );
    } finally {
      process.argv = originalArgv;
      warn.mockRestore();
      await closeServer(blocker);
      await rm(home, { recursive: true, force: true });
    }
  });
});
