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

import { isIP } from "node:net";
import { isLoopbackHost } from "./auth.js";
import { contract } from './contracts/runtime.js'; /* augur-inject:import:36e027ea */
import augurContract_bf8a54ef from './contracts/launch-host.contract.js'; /* augur-inject:contract-predicate:6588e57b */

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
  const host = input.header("host");
  // Parse an HTTP authority only: URL userinfo, paths and unbracketed IPv6 are not Hosts.
  if (!host || !/^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d+)?$/i.test(host)) {
    return { local: false, reason: "cross-origin" };
  }
  try {
    const hostname = new URL("http://" + host).hostname.replace(/^\[|\]$/g, "");
    // isLoopbackHost also serves bind configuration and accepts a 127. prefix.
    // HTTP names must additionally be localhost or a valid IP, not 127.example.
    if ((hostname !== "localhost" && isIP(hostname) === 0) || !isLoopbackHost(hostname)) {
      return { local: false, reason: "cross-origin" };
    }
  } catch {
    return { local: false, reason: "cross-origin" };
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
// @ts-expect-error augur-inject
classifyLaunchRequest = contract(classifyLaunchRequest, { ...augurContract_bf8a54ef, contractId: 'C-2', mode: 'observe', sample: 1, where: 'src/adapters/web/source-view-request.ts:25', rule: 'contract-wrap', id: 'bf8a54ef' }); /* augur-inject:contract-wrap:bf8a54ef */

/** What the user sees when the launch is refused for where the request came from. */
export function remoteLaunchMessage(reason: Exclude<LaunchOrigin, { local: true }>["reason"]): string {
  if (reason === "cross-origin") return "別のサイトからの起動要求は受け付けません。Anatomia の画面から操作してください。";
  return "Tela はこのサーバーの PC 上に開きます。別の端末や中継経由の画面からは起動できません。サーバーの PC で Anatomia を開いて操作するか、表示されたファイルと行を参照してください。";
}
