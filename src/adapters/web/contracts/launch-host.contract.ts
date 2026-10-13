import type { LaunchOrigin, classifyLaunchRequest } from "../source-view-request.js";

export default {
  post: (result: LaunchOrigin, input: Parameters<typeof classifyLaunchRequest>[0]): boolean | string => {
    if (!result.local) return true;
    const host = input.header("host") ?? "";
    return /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|\[::ffff:127(?:\.\d{1,3}){3}\])(?::\d+)?$/i.test(host) || "non-loopback Host accepted";
  },
};
