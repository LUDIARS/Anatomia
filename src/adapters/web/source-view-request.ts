/**
 * src/adapters/web/source-view-request.ts — is this request allowed to open a
 * window on the server's own desktop?
 *
 * Only a DIRECT request from the server machine is. A loopback socket alone is
 * not enough: a tunnel or the Excubitor viewer proxy also connects from
 * 127.0.0.1 while the person is on another device, so any forwarding header
 * marks the request as remote. A cross-origin page in the local browser is
 * refused by the Origin check (the launch body is JSON, which also forces a
 * CORS preflight this server never answers).
 *
 * SRP: classify the request. The route decides what to answer.
 *
 * @spec Tela source viewer launch
 */

import { isLoopbackHost } from "./auth.js";

const FORWARDING_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "cf-connecting-ip"] as const;

export type LaunchOrigin =
  | { local: true }
  | { local: false; reason: "remote-client" | "forwarded" | "cross-origin" };

export function classifyLaunchRequest(input: {
  remoteAddress: string | undefined;
  header: (name: string) => string | undefined;
}): LaunchOrigin {
  if (!input.remoteAddress || !isLoopbackHost(input.remoteAddress)) return { local: false, reason: "remote-client" };
  if (FORWARDING_HEADERS.some((name) => (input.header(name) ?? "").trim() !== "")) {
    return { local: false, reason: "forwarded" };
  }
  const origin = input.header("origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return { local: false, reason: "cross-origin" };
    }
    if (originHost !== (input.header("host") ?? "")) return { local: false, reason: "cross-origin" };
  }
  return { local: true };
}

/** What the user sees when the launch is refused for where the request came from. */
export function remoteLaunchMessage(reason: Exclude<LaunchOrigin, { local: true }>["reason"]): string {
  if (reason === "cross-origin") return "別のサイトからの起動要求は受け付けません。Anatomia の画面から操作してください。";
  return "Tela はこのサーバーの PC 上に開きます。別の端末や中継経由の画面からは起動できません。サーバーの PC で Anatomia を開いて操作するか、表示されたファイルと行を参照してください。";
}
