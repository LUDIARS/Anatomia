import { relative, sep } from "node:path";
import type { SourceTargetRequest, SourceTargetResult } from "../source-view-target.js";

export default {
  post: (result: SourceTargetResult, request: SourceTargetRequest): boolean | string => {
    const analyzed = request.analyzedFiles.some((path) => relative(request.repoPath, path).split(sep).join("/") === request.file);
    return analyzed || (!result.ok && ["not-analyzed", "invalid-request", "outside-repository"].includes(result.reason)) || "unanalyzed source accepted";
  },
};
