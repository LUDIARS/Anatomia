import { describe, expect, it, vi } from "vitest";
import {
  DiscordAttachmentError,
  createDiscordAttachmentLoader,
} from "../discord-attachment.js";

const GUILD_ID = "123456789012345678";
const CHANNEL_ID = "223456789012345678";
const MESSAGE_ID = "323456789012345678";
const ATTACHMENT_ID = "423456789012345678";

function messageUrl(messageId = MESSAGE_ID): string {
  return `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/${messageId}`;
}

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    channel_id: CHANNEL_ID,
    attachments: [{
      id: ATTACHMENT_ID,
      filename: "feature.md",
      size: 18,
      url: "https://cdn.discordapp.com/attachments/a/b/feature.md?ex=signed",
      content_type: "text/markdown",
    }],
    ...overrides,
  };
}

/** Only a real fetch populates `Response.url`; stamp it so the origin check has input. */
function landedAt(response: Response, url: string): Response {
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("Discord attachment loader", () => {
  it("authenticates only the message lookup and downloads the selected Markdown", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith("https://discord.com/api/v10/")) {
        return Response.json(metadata());
      }
      return new Response("# Combat\n\nResolve attacks.\n", {
        headers: { "content-type": "text/markdown" },
      });
    }) as unknown as typeof fetch;
    const loader = createDiscordAttachmentLoader({ botToken: "secret-token", fetchImpl });

    const result = await loader.download({ messageUrl: messageUrl() });

    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bot secret-token");
    expect(new Headers(calls[1]!.init?.headers).has("authorization")).toBe(false);
    expect(result).toMatchObject({
      id: ATTACHMENT_ID,
      name: "feature.md",
      contentType: "text/markdown",
      text: "# Combat\n\nResolve attacks.\n",
    });
    expect(result.sourceLabel).toContain(`discord://${CHANNEL_ID}/${MESSAGE_ID}/${ATTACHMENT_ID}/`);
  });

  it("treats a forum thread URL as its starter message", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://discord.com/api/v10/")) {
        expect(url).toContain(`/channels/${CHANNEL_ID}/messages/${CHANNEL_ID}`);
        return Response.json(metadata({ id: CHANNEL_ID }));
      }
      return new Response("# Thread spec\n");
    }) as unknown as typeof fetch;
    const loader = createDiscordAttachmentLoader({ botToken: "token", fetchImpl });

    await expect(loader.download({
      messageUrl: `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}`,
    })).resolves.toMatchObject({ name: "feature.md" });
  });

  it("rejects a non-Discord message URL before any network call", async () => {
    const fetchImpl = vi.fn(async () => new Response("")) as unknown as typeof fetch;
    const loader = createDiscordAttachmentLoader({ botToken: "token", fetchImpl });

    await expect(loader.download({
      messageUrl: `https://discord.com.evil.invalid/channels/${GUILD_ID}/${CHANNEL_ID}/${MESSAGE_ID}`,
    })).rejects.toMatchObject({ statusCode: 400 } satisfies Partial<DiscordAttachmentError>);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects attachment URLs outside the Discord CDN allowlist", async () => {
    const fetchImpl = vi.fn(async () => Response.json(metadata({
      attachments: [{
        id: ATTACHMENT_ID,
        filename: "feature.md",
        size: 10,
        url: "https://example.invalid/feature.md",
        content_type: "text/markdown",
      }],
    }))) as unknown as typeof fetch;
    const loader = createDiscordAttachmentLoader({ botToken: "token", fetchImpl });

    await expect(loader.download({ messageUrl: messageUrl() })).rejects.toMatchObject({
      statusCode: 502,
    } satisfies Partial<DiscordAttachmentError>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-validates the CDN host on every redirect hop", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://discord.com/api/v10/")) return Response.json(metadata());
      return new Response(null, {
        status: 302,
        headers: { location: "https://exfil.invalid/feature.md" },
      });
    }) as unknown as typeof fetch;
    const loader = createDiscordAttachmentLoader({ botToken: "token", fetchImpl });

    await expect(loader.download({ messageUrl: messageUrl() })).rejects.toMatchObject({
      statusCode: 502,
    } satisfies Partial<DiscordAttachmentError>);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("re-fetches with follow when the runtime hides the redirect, and checks the final origin", async () => {
    const modes: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://discord.com/api/v10/")) return Response.json(metadata());
      modes.push(String(init?.redirect));
      // What Node's fetch actually hands back for `redirect: "manual"`.
      if (init?.redirect === "manual") return Response.error();
      return landedAt(new Response("# Redirected\n"), "https://cdn.discordapp.com/final/feature.md");
    }) as unknown as typeof fetch;
    const loader = createDiscordAttachmentLoader({ botToken: "token", fetchImpl });

    await expect(loader.download({ messageUrl: messageUrl() }))
      .resolves.toMatchObject({ text: "# Redirected\n" });
    expect(modes).toEqual(["manual", "follow"]);
  });

  it("rejects a hidden redirect chain that lands outside the CDN allowlist", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://discord.com/api/v10/")) return Response.json(metadata());
      if (init?.redirect === "manual") return Response.error();
      return landedAt(new Response("secret\n"), "https://exfil.invalid/feature.md");
    }) as unknown as typeof fetch;
    const loader = createDiscordAttachmentLoader({ botToken: "token", fetchImpl });

    await expect(loader.download({ messageUrl: messageUrl() })).rejects.toMatchObject({
      statusCode: 502,
    } satisfies Partial<DiscordAttachmentError>);
  });

  it("ignores malformed attachment entries in the Discord payload", async () => {
    const fetchImpl = vi.fn(async () => Response.json(metadata({
      attachments: [{ filename: "feature.md", size: 10, content_type: "text/markdown" }],
    }))) as unknown as typeof fetch;
    const loader = createDiscordAttachmentLoader({ botToken: "token", fetchImpl });

    await expect(loader.download({ messageUrl: messageUrl() })).rejects.toMatchObject({
      statusCode: 404,
    } satisfies Partial<DiscordAttachmentError>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a streamed body that outgrows the limit despite honest metadata", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://discord.com/api/v10/")) return Response.json(metadata());
      return new Response("x".repeat(200));
    }) as unknown as typeof fetch;
    const loader = createDiscordAttachmentLoader({ botToken: "token", fetchImpl, maxBytes: 100 });

    await expect(loader.download({ messageUrl: messageUrl() })).rejects.toMatchObject({
      statusCode: 413,
    } satisfies Partial<DiscordAttachmentError>);
  });

  it("rejects oversized metadata before downloading the CDN body", async () => {
    const fetchImpl = vi.fn(async () => Response.json(metadata({
      attachments: [{
        id: ATTACHMENT_ID,
        filename: "feature.md",
        size: 101,
        url: "https://cdn.discordapp.com/attachments/a/b/feature.md",
        content_type: "text/markdown",
      }],
    }))) as unknown as typeof fetch;
    const loader = createDiscordAttachmentLoader({ botToken: "token", fetchImpl, maxBytes: 100 });

    await expect(loader.download({ messageUrl: messageUrl() })).rejects.toMatchObject({
      statusCode: 413,
    } satisfies Partial<DiscordAttachmentError>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-UTF-8 attachment body", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://discord.com/api/v10/")) return Response.json(metadata());
      return new Response(new Uint8Array([0xff, 0xfe, 0xfd]));
    }) as unknown as typeof fetch;
    const loader = createDiscordAttachmentLoader({ botToken: "token", fetchImpl });

    await expect(loader.download({ messageUrl: messageUrl() })).rejects.toMatchObject({
      statusCode: 415,
    } satisfies Partial<DiscordAttachmentError>);
  });

  it("requires an explicit choice when multiple text attachments are present", async () => {
    const fetchImpl = vi.fn(async () => Response.json(metadata({
      attachments: [
        {
          id: ATTACHMENT_ID,
          filename: "one.md",
          size: 10,
          url: "https://cdn.discordapp.com/attachments/a/b/one.md",
          content_type: "text/markdown",
        },
        {
          id: "523456789012345678",
          filename: "two.txt",
          size: 10,
          url: "https://cdn.discordapp.com/attachments/a/b/two.txt",
          content_type: "text/plain",
        },
      ],
    }))) as unknown as typeof fetch;
    const loader = createDiscordAttachmentLoader({ botToken: "token", fetchImpl });

    await expect(loader.download({ messageUrl: messageUrl() })).rejects.toMatchObject({
      statusCode: 409,
    } satisfies Partial<DiscordAttachmentError>);
  });

  it("selects one of several attachments by name", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://discord.com/api/v10/")) {
        return Response.json(metadata({
          attachments: [
            {
              id: ATTACHMENT_ID,
              filename: "one.md",
              size: 10,
              url: "https://cdn.discordapp.com/attachments/a/b/one.md",
              content_type: "text/markdown",
            },
            {
              id: "523456789012345678",
              filename: "two.txt",
              size: 10,
              url: "https://cdn.discordapp.com/attachments/a/b/two.txt",
              content_type: "text/plain",
            },
          ],
        }));
      }
      return new Response("# Two\n");
    }) as unknown as typeof fetch;
    const loader = createDiscordAttachmentLoader({ botToken: "token", fetchImpl });

    await expect(loader.download({
      messageUrl: messageUrl(),
      attachmentName: "two.txt",
    })).resolves.toMatchObject({ name: "two.txt", text: "# Two\n" });
  });
});
