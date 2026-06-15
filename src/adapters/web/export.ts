/**
 * src/adapters/web/export.ts -- Static interactive HTML graph export (T50).
 *
 * Exports `exportGraphHtml(ctx, opts?)` which returns a fully self-contained
 * single-file HTML document that can be opened directly in a browser without
 * any running server:
 *
 *   - vis-network loaded from CDN (<script> tag)
 *   - all graph data (nodes, edges, metrics, domain membership) inlined as JSON
 *   - nodes coloured and sized by coupling and cyclomatic complexity
 *   - nodes grouped/clustered by file (module segment of the path)
 *   - click a node → detail panel (name, file, complexity, fan-in/out, domain)
 *   - small header with project name + summary counts (files/functions/nodes/edges)
 *   - legend explains colour + size encoding
 *   - group filter dropdown so large graphs remain readable
 *
 * SRP: builds the HTML string from an AnalysisContext only. CLI wires I/O.
 */

import { basename, relative, dirname } from "node:path";
import { computeMetrics } from "../../supply/metrics.js";
import type { AnalysisContext } from "../../core.js";
import type { NodeMetrics } from "../../supply/metrics.js";
import type { CodeNode, Edge } from "../../types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExportOptions {
  /** Title shown in the HTML header. Defaults to the repo basename. */
  title?: string;
}

// ---------------------------------------------------------------------------
// Colour palette (same as existing web UI)
// ---------------------------------------------------------------------------

const GROUP_PALETTE = [
  "#58a6ff", "#3fb950", "#d29922", "#f78166", "#bc8cff",
  "#39c5cf", "#e3b341", "#ff7b72", "#7ee787", "#ffa657",
  "#79c0ff", "#56d364", "#e3b341", "#ffa28b", "#d2a8ff",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map each unique group name to a stable palette colour. */
function buildGroupColorMap(groups: string[]): Record<string, string> {
  const unique = [...new Set(groups)].sort();
  const map: Record<string, string> = {};
  unique.forEach((g, i) => {
    map[g] = GROUP_PALETTE[i % GROUP_PALETTE.length];
  });
  return map;
}

/**
 * Derive a short "group" label from a file path (the file's basename without
 * extension, or the immediate directory name for index files).
 */
function groupFor(filePath: string, repoPath: string): string {
  try {
    const rel = relative(repoPath, filePath).replace(/\\/g, "/");
    // Use the first directory segment after the repo root, or the filename.
    const parts = rel.split("/");
    if (parts.length >= 2) {
      // e.g. "src/adapters/cli.ts" → group "src/adapters"
      return parts.slice(0, -1).join("/");
    }
    return basename(filePath, ".ts")
      .replace(/\.tsx$/, "")
      .replace(/\.cpp$/, "")
      .replace(/\.h$/, "")
      .replace(/\.cs$/, "");
  } catch {
    return dirname(filePath);
  }
}

/** Derive node size from cyclomatic complexity (clamped to 8–32). */
function sizeForCyclomatic(cyclomatic: number): number {
  return Math.max(8, Math.min(32, 8 + cyclomatic * 2));
}

/** Escape a value for safe JSON embedding inside an HTML script block. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/<\/script>/gi, "<\\/script>");
}

// ---------------------------------------------------------------------------
// exportGraphHtml
// ---------------------------------------------------------------------------

/**
 * Build a self-contained interactive HTML graph from an AnalysisContext.
 *
 * Visual encoding:
 *   - Node **colour**  : group (file/directory) — each file group gets a
 *                        distinct colour from the palette; the legend lists them.
 *   - Node **size**    : cyclomatic complexity (larger = more complex).
 *   - Node **border**  : coupling level — red border for coupling ≥ 10,
 *                        orange for ≥ 4, green otherwise.
 *   - Edges            : colour-coded by kind (calls/reads/writes/depends/…).
 */
export async function exportGraphHtml(
  ctx: AnalysisContext,
  opts: ExportOptions = {},
): Promise<string> {
  // --- Compute metrics ---
  const membershipMap = new Map<string, import("../../types.js").AnchorId[]>();
  for (const d of ctx.domains ?? []) {
    membershipMap.set(d.domain, d.implementors);
  }
  const metrics: NodeMetrics[] = await computeMetrics(ctx.graph, membershipMap);
  const metricsByAnchor = new Map(metrics.map((m) => [m.anchor, m]));

  // --- Collect graph data ---
  const nodes: CodeNode[] = await ctx.graph.allNodes();

  const edgeMap = new Map<string, Edge>();
  for (const node of nodes) {
    const edges = await ctx.graph.edgesFrom(node.id);
    for (const e of edges) {
      const key = `${e.from}|${e.to}|${e.kind}`;
      if (!edgeMap.has(key)) edgeMap.set(key, e);
    }
  }
  const edges = Array.from(edgeMap.values());

  // --- Build domain lookup: anchor -> first domain name ---
  const anchorDomain = new Map<string, string>();
  for (const d of ctx.domains ?? []) {
    for (const anchor of d.implementors) {
      if (!anchorDomain.has(anchor)) anchorDomain.set(anchor, d.domain);
    }
  }

  // --- Derive groups ---
  const nodeGroup = new Map<string, string>();
  for (const n of nodes) {
    nodeGroup.set(n.id, groupFor(n.sourceRange.filePath, ctx.repoPath));
  }
  const allGroups = [...new Set(nodeGroup.values())].sort();
  const groupColorMap = buildGroupColorMap(allGroups);

  // --- Build vis-network node/edge data ---
  const visNodes = nodes.map((n) => {
    const m = metricsByAnchor.get(n.id);
    const coupling = m?.coupling ?? 0;
    const cyclomatic = m?.cyclomatic ?? 1;
    const group = nodeGroup.get(n.id) ?? "unknown";
    const groupColor = groupColorMap[group] ?? "#8b949e";

    // Border colour signals coupling severity
    const borderColor =
      coupling >= 10 ? "#da3633" : coupling >= 4 ? "#d29922" : "#238636";

    const relPath = (() => {
      try { return relative(ctx.repoPath, n.sourceRange.filePath).replace(/\\/g, "/"); }
      catch { return n.sourceRange.filePath; }
    })();

    const domain = anchorDomain.get(n.id) ?? null;

    return {
      id: n.id,
      label: n.name,
      title: [
        n.name,
        relPath + ":" + n.sourceRange.start.line,
        "kind: " + n.kind,
        "coupling: " + coupling,
        "cyclomatic: " + cyclomatic,
        "fan-in: " + (m?.fanIn ?? 0),
        "fan-out: " + (m?.fanOut ?? 0),
        domain ? "domain: " + domain : null,
      ].filter(Boolean).join("\n"),
      group,
      color: {
        background: groupColor,
        border: borderColor,
        highlight: { background: "#ffffff", border: "#58a6ff" },
      },
      size: sizeForCyclomatic(cyclomatic),
      font: { color: "#e1e4e8", size: 10 },
      // Extra data for detail panel (not used by vis-network itself)
      _meta: {
        name: n.name,
        kind: n.kind,
        file: relPath,
        line: n.sourceRange.start.line,
        domain,
        coupling,
        cyclomatic,
        fanIn: m?.fanIn ?? 0,
        fanOut: m?.fanOut ?? 0,
        domainOverlap: m?.domainOverlap ?? 0,
        crossDomainDepth: m?.crossDomainDepth ?? 0,
      },
    };
  });

  const EDGE_COLORS: Record<string, string> = {
    calls:    "#58a6ff",
    reads:    "#3fb950",
    writes:   "#d29922",
    depends:  "#bc8cff",
    implements: "#39c5cf",
    overrides: "#ffa657",
    includes:  "#f78166",
  };

  const visEdges = edges.map((e) => ({
    from: e.from,
    to: e.to,
    label: e.kind,
    arrows: "to",
    font: { size: 8, color: "#6e7681", strokeWidth: 0 },
    color: { color: EDGE_COLORS[e.kind] ?? "#8b949e", opacity: 0.55 },
    width: 1,
  }));

  // --- Summary counts ---
  const title = opts.title ?? basename(ctx.repoPath);
  const fileCount = ctx.files.length;
  const funcCount = ctx.functions.length;
  const nodeCount = nodes.length;
  const edgeCount = edges.length;
  const groupCount = allGroups.length;

  // --- Build legend entries ---
  const legendItems = allGroups.map((g) => ({
    group: g,
    color: groupColorMap[g],
  }));

  // --- Inline all data as JSON ---
  const dataJson = safeJson({
    nodes: visNodes,
    edges: visEdges,
    groups: allGroups,
    groupColors: groupColorMap,
    legend: legendItems,
    summary: { title, fileCount, funcCount, nodeCount, edgeCount, groupCount },
  });

  // ---------------------------------------------------------------------------
  // HTML template
  // ---------------------------------------------------------------------------
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Anatomia Graph — ${escHtml(title)}</title>
  <script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body { font-family: system-ui, sans-serif; background: #0f1117; color: #e1e4e8;
           display: flex; flex-direction: column; }

    /* Header */
    #header { flex: none; display: flex; align-items: center; flex-wrap: wrap;
              gap: 12px; padding: 8px 14px;
              background: #161b22; border-bottom: 1px solid #30363d; }
    #header h1 { font-size: 1rem; white-space: nowrap; }
    #summary { font-size: 0.75rem; color: #8b949e; }
    #filter-wrap { margin-left: auto; display: flex; align-items: center; gap: 8px; }
    #group-filter { background: #21262d; color: #e1e4e8; border: 1px solid #30363d;
                    border-radius: 4px; padding: 3px 8px; font-size: 0.78rem; }

    /* Main area */
    #main { flex: 1; display: flex; min-height: 0; }
    #graph-wrap { flex: 1; position: relative; }
    #graph { width: 100%; height: 100%; }

    /* Side panel */
    #side { width: 300px; flex: none; display: flex; flex-direction: column;
            background: #161b22; border-left: 1px solid #30363d; overflow: hidden; }
    #detail-panel { flex: 1; overflow-y: auto; padding: 10px; }
    #detail-panel h2 { font-size: 0.8rem; color: #8b949e; text-transform: uppercase;
                       letter-spacing: .05em; margin-bottom: 8px; }
    .detail-row { display: flex; justify-content: space-between; gap: 8px;
                  font-size: 0.78rem; padding: 3px 0; border-bottom: 1px solid #21262d; }
    .detail-label { color: #8b949e; }
    .detail-val { font-family: monospace; color: #e1e4e8; text-align: right;
                  word-break: break-all; max-width: 160px; }
    #placeholder { color: #6e7681; font-size: 0.85rem; padding: 12px 0; }

    /* Legend */
    #legend-panel { flex: none; border-top: 1px solid #30363d; padding: 8px 10px;
                    max-height: 200px; overflow-y: auto; }
    #legend-panel h2 { font-size: 0.75rem; color: #8b949e; text-transform: uppercase;
                       letter-spacing: .05em; margin-bottom: 6px; }
    .legend-group { font-size: 0.72rem; display: flex; align-items: center; gap: 6px;
                    padding: 2px 0; }
    .legend-swatch { width: 12px; height: 12px; border-radius: 3px; flex: none; }
    .legend-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                    color: #c9d1d9; font-family: monospace; }
    .legend-sep { font-size: 0.7rem; color: #6e7681; margin-top: 6px; }
    .legend-encode { font-size: 0.7rem; color: #8b949e; padding: 2px 0; }

    /* Loading overlay */
    #loading { position: absolute; inset: 0; display: flex; align-items: center;
               justify-content: center; background: rgba(15,17,23,0.85); font-size: 1rem;
               z-index: 10; }
  </style>
</head>
<body>
  <div id="header">
    <h1>Anatomia Graph &mdash; ${escHtml(title)}</h1>
    <div id="summary"></div>
    <div id="filter-wrap">
      <label for="group-filter" style="font-size:0.75rem;color:#8b949e;">Group:</label>
      <select id="group-filter"><option value="">All groups</option></select>
    </div>
  </div>

  <div id="main">
    <div id="graph-wrap">
      <div id="graph"></div>
      <div id="loading">Rendering graph&hellip;</div>
    </div>
    <div id="side">
      <div id="detail-panel">
        <h2>Node Detail</h2>
        <div id="placeholder">Click a node to see details.</div>
        <div id="detail-rows" style="display:none"></div>
      </div>
      <div id="legend-panel">
        <h2>Legend</h2>
        <div class="legend-sep">Node colour = file group</div>
        <div id="legend-groups"></div>
        <div class="legend-sep" style="margin-top:8px">Node border = coupling</div>
        <div class="legend-encode"><span style="color:#da3633">&#9632;</span> red = coupling &ge; 10 (high)</div>
        <div class="legend-encode"><span style="color:#d29922">&#9632;</span> orange = coupling &ge; 4 (med)</div>
        <div class="legend-encode"><span style="color:#238636">&#9632;</span> green = coupling &lt; 4 (low)</div>
        <div class="legend-sep" style="margin-top:8px">Node size = cyclomatic complexity</div>
        <div class="legend-encode">larger = more complex</div>
      </div>
    </div>
  </div>

  <script>
  (function() {
    var DATA = ${dataJson};

    // --- Populate summary ---
    var s = DATA.summary;
    document.getElementById('summary').textContent =
      s.title + ' — ' + s.fileCount + ' files, ' + s.funcCount + ' functions, ' +
      s.nodeCount + ' nodes, ' + s.edgeCount + ' edges, ' + s.groupCount + ' groups';

    // --- Populate group filter dropdown ---
    var gf = document.getElementById('group-filter');
    DATA.groups.forEach(function(g) {
      var opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g;
      gf.appendChild(opt);
    });

    // --- Build legend ---
    var lgEl = document.getElementById('legend-groups');
    DATA.legend.forEach(function(item) {
      var div = document.createElement('div');
      div.className = 'legend-group';
      div.innerHTML = '<div class="legend-swatch" style="background:' + item.color + '"></div>' +
        '<span class="legend-label" title="' + escAttr(item.group) + '">' + escHtml(item.group) + '</span>';
      lgEl.appendChild(div);
    });

    // --- Build node map for detail lookup ---
    var nodeById = {};
    DATA.nodes.forEach(function(n) { nodeById[n.id] = n; });

    // --- Render vis-network ---
    var container = document.getElementById('graph');
    var dataset = {
      nodes: new vis.DataSet(DATA.nodes.map(function(n) {
        // vis-network doesn't use _meta, strip it for the DataSet
        return {
          id: n.id, label: n.label, title: n.title,
          color: n.color, size: n.size, font: n.font, group: n.group
        };
      })),
      edges: new vis.DataSet(DATA.edges),
    };

    var network = new vis.Network(container, dataset, {
      layout: { improvedLayout: true },
      physics: {
        solver: 'forceAtlas2Based',
        forceAtlas2Based: { gravitationalConstant: -50, springLength: 100, damping: 0.5 },
        stabilization: { iterations: 200, updateInterval: 25 },
      },
      interaction: { hover: true, tooltipDelay: 120, navigationButtons: true, keyboard: true },
      nodes: { shape: 'dot', borderWidth: 2 },
      edges: { smooth: { type: 'continuous', roundness: 0.3 } },
    });

    network.once('stabilizationIterationsDone', function() {
      document.getElementById('loading').style.display = 'none';
    });
    // Fallback: hide loading after 6 s even if physics never stabilises
    setTimeout(function() {
      document.getElementById('loading').style.display = 'none';
    }, 6000);

    // --- Detail panel on node click ---
    network.on('click', function(params) {
      if (!params.nodes || params.nodes.length === 0) {
        document.getElementById('placeholder').style.display = '';
        document.getElementById('detail-rows').style.display = 'none';
        return;
      }
      var id = params.nodes[0];
      var n = nodeById[id];
      if (!n) return;
      var m = n._meta;
      var rows = [
        ['Name', m.name],
        ['Kind', m.kind],
        ['File', m.file],
        ['Line', m.line],
        ['Domain', m.domain || '—'],
        ['Coupling', m.coupling],
        ['Fan-in', m.fanIn],
        ['Fan-out', m.fanOut],
        ['Cyclomatic', m.cyclomatic],
        ['Domain overlap', m.domainOverlap],
        ['Cross-domain depth', m.crossDomainDepth],
      ];
      document.getElementById('placeholder').style.display = 'none';
      var rowsEl = document.getElementById('detail-rows');
      rowsEl.style.display = '';
      rowsEl.innerHTML = rows.map(function(r) {
        return '<div class="detail-row"><span class="detail-label">' +
          escHtml(String(r[0])) + '</span><span class="detail-val">' +
          escHtml(String(r[1])) + '</span></div>';
      }).join('');
    });

    // --- Group filter ---
    gf.onchange = function() {
      var chosen = gf.value;
      var updates = DATA.nodes.map(function(n) {
        var hidden = chosen !== '' && n.group !== chosen;
        return { id: n.id, hidden: hidden };
      });
      dataset.nodes.update(updates);
    };

    // Utility: escape HTML
    function escHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function escAttr(s) { return escHtml(s); }
  })();
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Internal HTML escaping (build time, not browser)
// ---------------------------------------------------------------------------

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
