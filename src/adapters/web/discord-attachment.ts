/**
 * src/adapters/web/discord-attachment.ts — fetch ONE Markdown/text attachment
 * from a Discord message (or forum thread starter) for /flow/draft.
 *
 * Trust boundary, in order:
 *   1. Only https Discord message/thread URLs with snowflake ids are accepted,
 *      so a caller cannot steer the lookup at an arbitrary host.
 *   2. The Bot token is sent to the Discord API lookup only (`redirect: "error"`),
 *      never to the CDN — a signed CDN URL must not carry our credential.
 *   3. The CDN host allowlist is re-checked on every visible redirect hop, and
 *      on the landing origin when the runtime hides the hops (Node's fetch
 *      answers `redirect: "manual"` with an opaque, header-less response).
 *   4. Size is bounded three times (metadata, Content-Length, stream) and the
 *      body must decode as strict UTF-8.
 * Errors carry an HTTP status but never the token or the signed CDN URL.
 *
 * SRP: Discord retrieval only. Spec parsing/proposal shaping lives in routes/flow.ts.
 *
 * @spec (3) Discord フォーラム添付の実 DL
 */

const DISCORD_API = "https://discord.com/api/v10";
const TRUSTED_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
/** Client hosts that address the same messages (stable + canary/ptb builds). */
const DISCORD_HOSTS = new Set([
  "discord.com",
  "www.discord.com",
  "canary.discord.com",
  "ptb.discord.com",
  "discordapp.com",
  "www.discordapp.com",
]);
const SNOWFLAKE = /^\d{15,22}$/;
const MARKDOWN_NAME = /\.(?:md|markdown|txt)$/i;
const MARKDOWN_CONTENT_TYPE = /^(?:text\/markdown|text\/plain)(?:;|$)/i;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const CDN_HEADERS = { Accept: "text/markdown,text/plain;q=0.9" };

export interface DiscordAttachmentRequest {
  messageUrl: string;
  attachmentId?: string;
  attachmentName?: string;
}

export interface DownloadedDiscordAttachment {
  id: string;
  name: string;
  size: number;
  contentType: string | null;
  sourceLabel: string;
  text: string;
}

export interface DiscordAttachmentLoader {
  download(request: DiscordAttachmentRequest): Promise<DownloadedDiscordAttachment>;
}

export type DiscordAttachmentStatus = 400 | 404 | 409 | 413 | 415 | 501 | 502;

export class DiscordAttachmentError extends Error {
  constructor(message: string, readonly statusCode: DiscordAttachmentStatus) {
    super(message);
    this.name = "DiscordAttachmentError";
  }
}

interface DiscordAttachmentMetadata {
  id: string;
  filename: string;
  size: number;
  url: string;
  content_type?: string | null;
}

interface DiscordMessage {
  id: string;
  channel_id: string;
  attachments: DiscordAttachmentMetadata[];
}

function parseMessageReference(value: string): { channelId: string; messageId: string } {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new DiscordAttachmentError("discordMessageUrl must be an absolute Discord message/thread URL", 400); }
  if (url.protocol !== "https:" || !DISCORD_HOSTS.has(url.hostname.toLowerCase())) {
    throw new DiscordAttachmentError("discordMessageUrl host is not Discord", 400);
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "channels" || (parts.length !== 3 && parts.length !== 4)) {
    throw new DiscordAttachmentError("Discord URL must identify one message or forum thread", 400);
  }
  const channelId = parts[2]!;
  const messageId = parts[3] ?? channelId;
  if (!SNOWFLAKE.test(channelId) || !SNOWFLAKE.test(messageId)) throw new DiscordAttachmentError("Discord URL contains an invalid snowflake", 400);
  return { channelId, messageId };
}

/** The message payload is external JSON, so the `as DiscordMessage` cast is a claim, not a check. */
function isAttachmentMetadata(value: unknown): value is DiscordAttachmentMetadata {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item["id"] === "string"
    && typeof item["filename"] === "string"
    && typeof item["url"] === "string";
}

function eligible(metadata: DiscordAttachmentMetadata): boolean {
  return MARKDOWN_NAME.test(metadata.filename) || MARKDOWN_CONTENT_TYPE.test(metadata.content_type ?? "");
}

function selectAttachment(message: DiscordMessage, request: DiscordAttachmentRequest): DiscordAttachmentMetadata {
  let candidates = message.attachments.filter(isAttachmentMetadata).filter(eligible);
  if (request.attachmentId) candidates = candidates.filter((item) => item.id === request.attachmentId);
  if (request.attachmentName) candidates = candidates.filter((item) => item.filename === request.attachmentName);
  if (candidates.length === 0) throw new DiscordAttachmentError("no matching Markdown/text attachment on the Discord message", 404);
  if (candidates.length > 1) {
    throw new DiscordAttachmentError(`multiple compatible attachments; choose attachmentId or attachmentName: ${candidates.map((item) => item.filename).join(", ")}`, 409);
  }
  return candidates[0]!;
}

function trustedCdnUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new DiscordAttachmentError("Discord returned an invalid attachment URL", 502); }
  if (url.protocol !== "https:" || !TRUSTED_CDN_HOSTS.has(url.hostname.toLowerCase())) {
    throw new DiscordAttachmentError("Discord attachment URL is outside the trusted CDN", 502);
  }
  return url;
}

async function fetchCdn(fetchImpl: typeof fetch, initial: URL): Promise<Response> {
  let current = initial;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetchImpl(current, { redirect: "manual", headers: CDN_HEADERS });
    // Per the Fetch spec a "manual" redirect is surfaced as an opaque-redirect
    // response — status 0, no headers — so on Node's fetch the per-hop check
    // below never sees a Location and every redirecting attachment would fail.
    if (response.type === "opaqueredirect" || response.status === 0) return followCdn(fetchImpl, current);
    if (!REDIRECT_STATUS.has(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new DiscordAttachmentError("Discord CDN redirect has no location", 502);
    current = trustedCdnUrl(new URL(location, current).toString());
  }
  throw new DiscordAttachmentError("Discord CDN redirect limit exceeded", 502);
}

/**
 * Fallback for runtimes that hide redirect hops. The intermediate hops are
 * invisible here (they carry no credential either way), so validate the origin
 * the body actually came from before a single byte is read.
 */
async function followCdn(fetchImpl: typeof fetch, initial: URL): Promise<Response> {
  const response = await fetchImpl(initial, { redirect: "follow", headers: CDN_HEADERS });
  if (!response.url) return response;
  try {
    trustedCdnUrl(response.url);
  } catch (err) {
    await response.body?.cancel();
    throw err;
  }
  return response;
}

async function boundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new DiscordAttachmentError(`attachment exceeds ${maxBytes} bytes`, 413);
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new DiscordAttachmentError(`attachment exceeds ${maxBytes} bytes`, 413);
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

export function createDiscordAttachmentLoader(options: {
  botToken: string;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
}): DiscordAttachmentLoader {
  const token = options.botToken.trim();
  if (!token) throw new Error("Discord bot token is empty");
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  return {
    async download(request) {
      const { channelId, messageId } = parseMessageReference(request.messageUrl);
      const metadataResponse = await fetchImpl(`${DISCORD_API}/channels/${channelId}/messages/${messageId}`, {
        headers: { Authorization: `Bot ${token}`, Accept: "application/json" },
        redirect: "error",
      });
      if (!metadataResponse.ok) {
        await metadataResponse.body?.cancel();
        const status = metadataResponse.status === 404 ? 404 : 502;
        throw new DiscordAttachmentError(`Discord message lookup failed (${metadataResponse.status})`, status);
      }
      let message: DiscordMessage;
      try { message = await metadataResponse.json() as DiscordMessage; }
      catch { throw new DiscordAttachmentError("Discord message response is not JSON", 502); }
      if (!message || !Array.isArray(message.attachments)) throw new DiscordAttachmentError("Discord message response is malformed", 502);
      const attachment = selectAttachment(message, request);
      if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) throw new DiscordAttachmentError("Discord attachment size is invalid", 502);
      if (attachment.size > maxBytes) throw new DiscordAttachmentError(`attachment exceeds ${maxBytes} bytes`, 413);
      const response = await fetchCdn(fetchImpl, trustedCdnUrl(attachment.url));
      if (!response.ok) {
        await response.body?.cancel();
        throw new DiscordAttachmentError(`Discord attachment download failed (${response.status})`, 502);
      }
      const bytes = await boundedBody(response, maxBytes);
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new DiscordAttachmentError("Discord attachment is not valid UTF-8 text", 415); }
      return {
        id: attachment.id,
        name: attachment.filename,
        size: bytes.byteLength,
        contentType: attachment.content_type ?? null,
        // Flows into SpecClause.sourceFile and the draft prompt, so no segment
        // may carry raw separators out of the Discord payload.
        sourceLabel: `discord://${channelId}/${messageId}/${encodeURIComponent(attachment.id)}/${encodeURIComponent(attachment.filename)}`,
        text,
      };
    },
  };
}
