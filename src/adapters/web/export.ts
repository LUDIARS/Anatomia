/**
 * src/adapters/web/export.ts -- Static interactive HTML graph export (T50).
 *
 * Exports `exportGraphHtml(ctx, opts?)` which returns a fully self-contained
 * single-file HTML document that can be opened directly in a browser without
 * any running server:
 *
 *   - vis-network loaded from CDN (<script> tag)
 *   - all graph data (nodes, edges, metrics, domain membership) inlined as JSON
 *     built by buildVisData() (shared with the live panel's /api/projects/:id/vis-data)
 *   - nodes coloured and sized by coupling and cyclomatic complexity
 *   - nodes grouped/clustered by file (module segment of the path)
 *   - click a node → detail panel (name, file, complexity, fan-in/out, domain)
 *   - small header with project name + summary counts (files/functions/nodes/edges)
 *   - legend explains colour + size encoding
 *   - group filter dropdown so large graphs remain readable
 *
 * SRP: builds the HTML string from an AnalysisContext only. Data transformation
 *      is delegated to vis-data.ts. CLI wires I/O.
 */

import { buildVisData } from "./vis-data.js";
import { loadTaxonomyResolver } from "../../domains/retune/load-taxonomy.js";
import type { AnalysisContext } from "../../core.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExportOptions {
  /** Title shown in the HTML header. Defaults to the repo basename. */
  title?: string;
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
 * Graph data is built by buildVisData() — the same function that serves the
 * live panel's /api/projects/:id/vis-data endpoint — so both the static export
 * and the live panel use an identical visual encoding.
 */
export async function exportGraphHtml(
  ctx: AnalysisContext,
  opts: ExportOptions = {},
): Promise<string> {
  const data = await buildVisData(ctx, opts.title, {
    moduleResolver: await loadTaxonomyResolver(ctx.repoPath),
  });
  const { summary } = data;
  const title = summary.title;

  // Inline all vis-network data as JSON
  const dataJson = safeJson(data);

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
    #group-filter, #view-mode { background: #21262d; color: #e1e4e8; border: 1px solid #30363d;
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
      <label for="view-mode" style="font-size:0.75rem;color:#8b949e;">View:</label>
      <select id="view-mode"><option value="function">関数</option><option value="class">クラス</option></select>
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
    var PAYLOAD = ${dataJson};
    var requestedMode = window.location.hash.slice(1);
    var activeMode = requestedMode === 'class' || requestedMode === 'function'
      ? requestedMode
      : (PAYLOAD.defaultView || 'function');
    var DATA = PAYLOAD.views && PAYLOAD.views[activeMode]
      ? PAYLOAD.views[activeMode]
      : PAYLOAD;

    var viewMode = document.getElementById('view-mode');
    viewMode.value = activeMode;
    viewMode.addEventListener('change', function() {
      window.location.hash = viewMode.value;
      window.location.reload();
    });

    // --- Populate summary ---
    var s = DATA.summary;
    document.getElementById('summary').textContent =
      s.title + ' — ' + s.fileCount + ' files, ' + s.funcCount + ' functions, ' +
      s.nodeCount + ' nodes, ' + s.edgeCount + ' edges, ' + s.groupCount + ' groups, ' +
      s.unresolvedCount + ' unresolved calls';

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
