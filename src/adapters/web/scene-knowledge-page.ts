function escaped(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

export function sceneKnowledgePage(projectId: string): string {
  const project = escaped(projectId);
  const serialized = JSON.stringify(projectId).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Scene knowledge — ${project}</title><style>
body{font-family:system-ui;margin:0;background:#0f172a;color:#e2e8f0}header{display:flex;gap:12px;align-items:center;padding:16px 22px;border-bottom:1px solid #334155}main{padding:18px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:12px}.card{background:#1e293b;border:1px solid #475569;border-radius:9px;padding:13px}.muted{color:#94a3b8}.stale{color:#fbbf24}.ok{color:#86efac}button{background:#2563eb;color:white;border:0;border-radius:6px;padding:8px 12px;cursor:pointer}code,pre{white-space:pre-wrap;overflow-wrap:anywhere}details{margin-top:8px}
</style></head><body><header><strong>Scene knowledge</strong><span class="muted">${project}</span><button id="refresh">再読込</button><button id="sync">明示 sync</button></header><main><div id="status"></div><div id="scenes" class="grid"></div></main>
<script type="module">
const project=${serialized},endpoint='/api/projects/'+encodeURIComponent(project)+'/scenes';let model=null;
const h=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
function render(){const status=document.querySelector('#status');status.className=model.stale?'stale':'ok';status.textContent=model.manifest?'head '+model.manifest.knowledgeHead+' · source '+model.manifest.sourceRevision+(model.stale?' · STALE '+model.staleReasons.join(', '):' · current'):'manifest missing — explicit sync required';document.querySelector('#scenes').innerHTML=(model.scenes||[]).map(scene=>'<article class="card"><strong>'+h(scene.annotation?.label||scene.label)+'</strong><div class="muted">'+h(scene.id)+'</div><p>'+h(scene.origin)+' / '+h(scene.identityBasis)+(scene.tombstone?' / tombstone':'')+'</p><div>source: '+h(scene.sourceAnchor.path)+':'+h(scene.sourceAnchor.startLine)+'</div><div>reason: '+h(scene.sourceAnchor.reason)+'</div><div>direct '+scene.entryCodeSymbolIds.length+' / reached '+scene.reachedCodeSymbolIds.length+'</div><details><summary>CodeSymbols</summary><pre>'+h(JSON.stringify({direct:scene.entryCodeSymbolIds,reached:scene.reachedCodeSymbolIds},null,2))+'</pre></details><details><summary>Relations</summary><pre>'+h(JSON.stringify({elements:scene.elements,transitions:scene.transitionSceneIds,domains:scene.activeDomainIds,specClauses:scene.relatedSpecClauseIds},null,2))+'</pre></details><details><summary>Observation overlay</summary><pre>'+h(JSON.stringify((model.observations||[]).filter(item=>item.sceneId===scene.id),null,2))+'</pre></details></article>').join('')}
async function load(){const response=await fetch(endpoint),body=await response.json();if(!response.ok)throw Error(body.error);model=body;render()}
document.querySelector('#refresh').onclick=()=>load().catch(error=>alert(error.message));document.querySelector('#sync').onclick=async()=>{if(!model||!confirm('code / asset definition から canonical scene を同期しますか？'))return;try{const expectedHead=model.manifest?.knowledgeHead??model.knowledgeHead??null,response=await fetch(endpoint+'/sync',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmSync:true,expectedHead})}),body=await response.json();if(!response.ok)throw Error(body.error);await load()}catch(error){alert(error.message)}};load().catch(error=>{document.querySelector('#status').textContent=error.message});
</script></body></html>`;
}
