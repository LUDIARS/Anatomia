function escaped(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

/** Self-contained review surface; every mutation goes through proposal + Gate endpoints. */
export function domainOrganizationPage(projectId: string): string {
  const project = escaped(projectId);
  const serializedProject = JSON.stringify(projectId).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Domain organization — ${project}</title>
<style>
body{font-family:system-ui;margin:0;background:#111827;color:#e5e7eb}header{padding:16px 24px;border-bottom:1px solid #374151;display:flex;gap:12px;align-items:center}
button,select,input,textarea{font:inherit}button{background:#2563eb;color:white;border:0;border-radius:6px;padding:8px 12px;cursor:pointer}button.secondary{background:#374151}
main{display:grid;grid-template-columns:2fr 1fr;gap:16px;padding:16px}.panel{background:#1f2937;border:1px solid #374151;border-radius:10px;padding:14px}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}
.card{background:#111827;border:1px solid #4b5563;border-radius:8px;padding:12px}.muted{color:#9ca3af;font-size:12px}.missing{border-color:#d97706}.error{color:#fca5a5;white-space:pre-wrap}.ok{color:#86efac}.proposal{border-color:#2563eb}textarea{width:100%;min-height:70px;background:#0f172a;color:#e5e7eb;border:1px solid #475569;border-radius:5px}select,input{background:#0f172a;color:#e5e7eb;border:1px solid #475569;border-radius:5px;padding:5px}
@media(max-width:850px){main{grid-template-columns:1fr}}
</style></head><body><header><strong>Domain organization</strong><span class="muted">${project}</span><button id="refresh" class="secondary">再読込</button><button id="propose">仕様から提案</button></header>
<main><section class="panel"><h2>Domain canvas</h2><div id="status" class="muted"></div><label><input id="missingOnly" type="checkbox"> 実装なし domain のみ</label><div id="domains" class="cards"></div><h2>Typed edges</h2><div id="edges"></div><h2>Proposal / before → after</h2><div id="proposals" class="cards"></div></section>
<aside class="panel"><h2>Drift / unassigned code</h2><label>表示 <select id="driftFilter"><option value="code-only">code-only</option><option value="spec-only">spec-only</option><option value="all">all drift</option></select></label><div id="drift"></div><div id="unassigned"></div><div id="message"></div></aside></main>
<script type="module">
const project=${serializedProject}, base='/api/projects/'+encodeURIComponent(project)+'/domain-organization';
let view=null, proposalBundle=null;
const el=id=>document.getElementById(id), message=(text,ok=false)=>{el('message').className=ok?'ok':'error';el('message').textContent=text};
// A whole-repository view can hold thousands of unassigned symbols; render a
// bounded slice and say what was withheld rather than build one huge fragment.
const LIMIT=200, overflow=items=>items.length>LIMIT?'<div class="muted">'+items.length+' 件中 '+LIMIT+' 件のみ表示（filter で絞り込んでください）</div>':'';
const h=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
function domainOptions(selected=''){return '<option value="">未割当</option>'+view.domains.map(d=>'<option '+(d.id===selected?'selected':'')+' value="'+h(d.id)+'">'+h(d.name)+'</option>').join('')}
function render(){el('status').textContent='knowledge head: '+(view.knowledgeHead??'<empty>');const domains=el('missingOnly').checked?view.domains.filter(d=>d.implementationStatus==='missing'):view.domains;el('domains').innerHTML=domains.map(d=>'<article class="card '+(d.implementationStatus==='missing'?'missing':'')+'"><strong>'+h(d.name)+'</strong><div class="muted">'+h(d.id)+'</div><p>'+h(d.purpose)+'</p><div>parent: '+h(d.parentId??'root')+'</div><div>spec '+d.ownedClauseIds.length+' / code '+d.ownedCodeSymbolIds.length+'</div></article>').join('');
el('edges').innerHTML=view.typedEdges.map(edge=>'<div class="card"><strong>'+h(edge.kind)+'</strong> '+h(edge.from)+' → '+h(edge.to)+(edge.evidence?'<pre>'+h(JSON.stringify(edge.evidence,null,2))+'</pre>':'')+'</div>').join('')||'<span class="muted">edge なし</span>';
const filter=el('driftFilter').value,findings=filter==='all'?view.driftFindings:view.driftFindings.filter(f=>f.kind===filter);el('drift').innerHTML=(findings.slice(0,LIMIT).map(f=>'<div class="muted">'+h(f.kind)+' · '+h(f.entityId)+' · '+h(f.disposition)+'</div>').join('')+overflow(findings))||'<span class="muted">該当なし</span>';
const unassigned=filter==='code-only'||filter==='all'?view.unassignedCodeSymbols:[],options=domainOptions();
el('unassigned').innerHTML=unassigned.slice(0,LIMIT).map(s=>'<article class="card"><strong>'+h(s.qualifiedName)+'</strong><div class="muted">'+h(s.sourcePath)+':'+h(s.sourceRange?.startLine??'?')+'</div><select>'+options+'</select><button '+(s.anchorId?'data-assign="'+h(s.anchorId)+'"':'disabled')+'>割当案</button><div class="assignment-review"></div></article>').join('')+overflow(unassigned);}
async function load(){const r=await fetch(base);const b=await r.json();if(!r.ok)throw Error(b.error);view=b;render()}
el('refresh').onclick=()=>load().catch(e=>message(e.message));
el('missingOnly').onchange=()=>view&&render();
el('driftFilter').onchange=()=>view&&render();
el('propose').onclick=async()=>{try{const r=await fetch(base+'/proposals/spec',{method:'POST'}),b=await r.json();if(!r.ok)throw Error(b.error);proposalBundle=b;el('proposals').innerHTML=b.proposals.map((p,i)=>'<article class="card proposal" data-proposal="'+i+'"><strong>'+h(p.name)+'</strong><div class="muted">'+h(p.candidateId)+'</div><div><b>before:</b> '+(view.domains.some(d=>d.id===p.candidateId)?'existing domain':'absent')+'</div><div><b>after:</b> purpose / boundary / hierarchy proposal</div><label>Purpose<textarea data-field="purpose">'+h(p.purpose)+'</textarea></label><label>Parent (subdomain-of)<select data-field="parentCandidateId">'+domainOptions(p.parentCandidateId??'')+'</select></label><label><input type="checkbox" data-field="assignable" '+(p.assignable?'checked':'')+'> assignable</label><details><summary>evidence</summary><pre>'+h(JSON.stringify(p.evidence,null,2))+'</pre></details></article>').join('')+'<button id="gateA">Gate A 承認</button>';el('gateA').onclick=gateA}catch(e){message(e.message)}};
async function gateA(){try{const cards=[...document.querySelectorAll('[data-proposal]')];const proposals=proposalBundle.proposals.map((p,i)=>({...p,purpose:cards[i].querySelector('[data-field=purpose]').value,parentCandidateId:cards[i].querySelector('[data-field=parentCandidateId]').value||null,assignable:cards[i].querySelector('[data-field=assignable]').checked}));const hierarchy=proposals.filter(p=>p.parentCandidateId).map(p=>({childId:p.candidateId,parentId:p.parentCandidateId}));if(!confirm('Domain OKF と knowledge transaction を適用しますか？'))return;const r=await fetch(base+'/gate-a',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmApply:true,proposals,hierarchy,expectedHead:proposalBundle.expectedHead,reviewRef:'web:domain-organization'})}),b=await r.json();if(!r.ok)throw Error(b.error);message('Gate A applied',true);await load()}catch(e){message(e.message)}}
// Both the assignment proposal and the Gate B approval it renders own a catch:
// the rejection paths (409 head conflict, stale proposal, non-assignable target)
// are what a reviewer most needs to see, and an uncaught rejection in the nested
// onclick would leave the approve button looking like a no-op.
document.addEventListener('click',async e=>{const button=e.target.closest('[data-assign]');if(!button)return;try{const card=button.closest('.card'),anchorId=button.dataset.assign,select=card.querySelector('select');if(!select.value)throw Error('domain を選択してください');const r=await fetch(base+'/proposals/assignment',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({anchorId,domainId:select.value})}),b=await r.json();if(!r.ok)throw Error(b.error);const review=card.querySelector('.assignment-review');review.replaceChildren();const detail=document.createElement('pre');detail.textContent=JSON.stringify({action:b.action.action,before:b.action.beforeOwner,after:b.action.afterOwner,positiveEvidence:b.action.positiveEvidence,negativeEvidence:b.action.negativeEvidence,rationale:b.action.rationale},null,2);review.append(detail);const approve=document.createElement('button');approve.textContent='Gate B 承認';approve.onclick=async()=>{try{if(!confirm('この exact symbol assignment を適用しますか？'))return;const rr=await fetch(base+'/gate-b',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmApply:true,actions:[b.action],expectedHead:b.expectedHead,codeRevision:b.codeRevision,reviewRef:'web:domain-organization'})}),bb=await rr.json();if(!rr.ok)throw Error(bb.error);message('Gate B applied',true);await load()}catch(err){message(err.message)}};review.append(approve)}catch(err){message(err.message)}});
load().catch(e=>message(e.message));
</script></body></html>`;
}
