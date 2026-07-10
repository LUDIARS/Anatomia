import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { buildFromSource } from "../../../supply/__tests__/helpers.js";
import { startServer } from "../server.js";

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

describe("startServer", () => {
  it("treats an occupied address as a controlled duplicate start", async () => {
    const blocker = createServer((_request, response) => response.end());
    const port = await listenOnEphemeralPort(blocker);
    const { graph, file, functions } = await buildFromSource("void noop() { }");

    try {
      const result = await startServer({
        ctx: {
          repoPath: "/fixture",
          graph,
          files: [file],
          functions,
          domains: [],
          links: [],
          specClauses: [],
        },
        port,
      });

      // The old implementation returned before the socket had finished
      // binding, so keep the competing listener alive through the bind turn.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(result).toBe("address-in-use");
    } finally {
      await closeServer(blocker);
    }
  });
});
