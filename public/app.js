/* ============================== STATE ============================== */
let snapshots = [];
let backlogStatus = {};
let currentGroups = [];
let filteredCards = [];
let cardsShown = 0;
const CARD_PAGE = 30;

/* ============================== UTIL ============================== */
function fmt(n){ return (n||0).toLocaleString('en-US'); }
function shortDate(iso){ return new Date(iso).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'}); }
function pct(n, d){ return d>0 ? Math.round(100*n/d) : 0; }

/* ============================== TAB NAV ============================== */
document.querySelectorAll('.nav button').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.nav button').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('page-'+btn.dataset.page).classList.add('active');
  });
});

/* ============================== UPLOAD MODAL ============================== */
const modalBackdrop = document.getElementById('modalBackdrop');
document.getElementById('openUploadBtn').addEventListener('click', ()=>modalBackdrop.classList.add('show'));
document.getElementById('closeModalBtn').addEventListener('click', ()=>modalBackdrop.classList.remove('show'));
modalBackdrop.addEventListener('click', e=>{ if(e.target===modalBackdrop) modalBackdrop.classList.remove('show'); });

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const statusLine = document.getElementById('statusLine');
const statusText = document.getElementById('statusText');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');
const errorBanner = document.getElementById('errorBanner');

dropzone.addEventListener('click', ()=>fileInput.click());
dropzone.addEventListener('dragover', e=>{ e.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', ()=> dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', e=>{
  e.preventDefault(); dropzone.classList.remove('drag');
  if(e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', e=>{ if(e.target.files.length) handleFile(e.target.files[0]); });

function setStatus(msg){ statusLine.style.display='flex'; statusText.textContent = msg; }
function showError(msg){ errorBanner.textContent = msg; errorBanner.classList.add('show'); }
function hideError(){ errorBanner.classList.remove('show'); }

async function handleFile(file){
  hideError();
  progressWrap.classList.remove('show');
  setStatus('Reading ' + file.name + '…');

  const formData = new FormData();
  formData.append('file', file);

  let resp;
  try{
    resp = await fetch('/api/upload', { method:'POST', body: formData });
  }catch(e){
    showError('Could not reach the server. Check your connection and try again.');
    return;
  }
  if(!resp.ok || !resp.body){
    showError('Upload failed (server error).');
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;

  while(true){
    const {value, done} = await reader.read();
    if(done) break;
    buffer += decoder.decode(value, {stream:true});
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for(const line of lines){
      if(!line.trim()) continue;
      try{ handleStreamEvent(JSON.parse(line), file); finished = finished || false; }
      catch(e){ /* ignore malformed line */ }
    }
  }
  if(buffer.trim()){
    try{ handleStreamEvent(JSON.parse(buffer), file); }catch(e){ /* ignore */ }
  }
}

function handleStreamEvent(obj, file){
  if(obj.type === 'status'){
    setStatus(obj.message);
  } else if(obj.type === 'progress'){
    progressWrap.classList.add('show');
    const p = obj.total ? Math.round(100*obj.batch/obj.total) : 100;
    progressFill.style.width = p + '%';
    progressLabel.textContent = 'Classifying batch ' + obj.batch + ' of ' + obj.total;
  } else if(obj.type === 'error'){
    progressWrap.classList.remove('show');
    showError(obj.message);
  } else if(obj.type === 'done'){
    progressWrap.classList.remove('show');
    snapshots.push(obj.snapshot);
    snapshots.sort((a,b)=> new Date(a.date) - new Date(b.date));
    currentGroups = obj.groups;
    setStatus('Done — analyzed ' + fmt(obj.snapshot.total) + ' comments from ' + file.name + '.');
    renderAll();
    setTimeout(()=>modalBackdrop.classList.remove('show'), 900);
  }
}

/* ============================== INIT / STATE LOAD ============================== */
async function init(){
  try{
    const resp = await fetch('/api/state');
    const state = await resp.json();
    snapshots = state.snapshots || [];
    backlogStatus = state.backlogStatus || {};
    const flag = document.getElementById('modeFlag');
    if(state.hasApiKey){
      flag.textContent = 'Live classifier: ' + state.model;
      flag.classList.add('live');
    } else {
      flag.textContent = 'Demo mode — no API key set (see README)';
    }
  }catch(e){
    document.getElementById('modeFlag').textContent = 'Could not reach server';
  }
  if(snapshots.length) renderAll();
}

/* ============================== TOP-LEVEL RENDER ============================== */
function renderAll(){
  const latest = snapshots[snapshots.length-1];
  if(!latest) return;
  const renderers = [
    ()=>renderOverview(),
    ()=>renderAuthorEditor(latest),
    ()=>renderMastercopier(latest),
    ()=>renderBacklog(),
    ()=>renderExplorer(),
  ];
  renderers.forEach(fn=>{
    try{ fn(); }catch(e){ console.error('Render step failed:', e); }
  });
}

/* ============================== OVERVIEW ============================== */
function deltaHtml(cur, prevVal){
  if(prevVal===null || prevVal===undefined) return '<span class="delta flat">first snapshot</span>';
  if(prevVal===0) return '<span class="delta flat">—</span>';
  const diffPct = Math.round(100*(cur-prevVal)/prevVal);
  if(diffPct===0) return '<span class="delta flat">flat vs last upload</span>';
  const cls = diffPct<0 ? 'down':'up';
  const arrow = diffPct<0 ? '▼':'▲';
  return `<span class="delta ${cls}">${arrow} ${Math.abs(diffPct)}% vs last upload</span>`;
}

function renderOverview(){
  document.getElementById('overviewEmpty').style.display = 'none';
  const latest = snapshots[snapshots.length-1];
  const prev = snapshots.length>1 ? snapshots[snapshots.length-2] : null;

  document.getElementById('northstarSection').style.display = 'block';
  const stats = [
    {n: fmt(latest.bucket_counts.product||0), l:'Product-related comments', h:'The number to shrink', delta: deltaHtml(latest.bucket_counts.product||0, prev?(prev.bucket_counts.product||0):null)},
    {n: fmt(latest.total), l:'Total comments this upload', h:'', delta: deltaHtml(latest.total, prev?prev.total:null)},
    {n: fmt(latest.bucket_counts.content||0), l:'Content / editorial comments', h:'Not a product issue', delta: deltaHtml(latest.bucket_counts.content||0, prev?(prev.bucket_counts.content||0):null)},
    {n: fmt(latest.long_tail||0), l:'Not yet classified', h:'Rare patterns, low priority', delta:''},
  ];
  document.getElementById('northstarRow').innerHTML = stats.map(s=>`
    <div class="ns-stat"><div class="n">${s.n}</div><div class="l">${s.l}</div>${s.h?'<div class="h">'+s.h+'</div>':''}${s.delta}</div>
  `).join('');

  document.getElementById('trendSection').style.display = 'block';
  renderTrendChart();
}

let trendChartInstance = null;
function renderTrendChart(){
  if(typeof Chart === 'undefined'){ console.error('Chart.js failed to load — skipping trend chart.'); return; }
  const labels = snapshots.map(s=>shortDate(s.date));
  const totals = snapshots.map(s=>s.total);
  const products = snapshots.map(s=>s.bucket_counts.product||0);
  if(trendChartInstance) trendChartInstance.destroy();
  trendChartInstance = new Chart(document.getElementById('trendChart'), {
    type:'line',
    data:{labels, datasets:[
      {label:'Total comments', data:totals, borderColor:'#0071e3', backgroundColor:'rgba(0,113,227,.08)', tension:.3, fill:true},
      {label:'Product-related', data:products, borderColor:'#ff9f0a', backgroundColor:'rgba(255,159,10,.12)', tension:.3, fill:true},
    ]},
    options:{
      plugins:{legend:{position:'bottom', labels:{color:'#6e6e73', font:{size:11}, boxWidth:10}}},
      scales:{
        x:{ticks:{color:'#86868b', font:{size:11}}, grid:{color:'#eeeef0'}},
        y:{ticks:{color:'#86868b', font:{size:11}}, grid:{color:'#eeeef0'}, beginAtZero:true}
      }
    }
  });
}

/* ============================== AUTHOR & EDITOR ============================== */
function topThemes(themeStats, roleKeys, filterFn, n){
  return Object.entries(themeStats)
    .filter(([name, ts])=> filterFn(ts) && roleKeys.reduce((s,r)=>s+(ts[r]||0),0) > 0 && name!=='Unclassified')
    .map(([name, ts])=>({name, count: roleKeys.reduce((s,r)=>s+(ts[r]||0),0), action: ts.action}))
    .sort((a,b)=>b.count-a.count).slice(0,n);
}

function renderAuthorEditor(latest){
  document.getElementById('auedEmpty').style.display = 'none';
  const roleKeys = ['au','ed'];
  const auedTotal = (latest.role_counts.au||0) + (latest.role_counts.ed||0);

  // bucket split
  const bucketTotals = {product:0, content:0, unclassified:0};
  Object.values(latest.theme_stats).forEach(ts=>{
    const c = roleKeys.reduce((s,r)=>s+(ts[r]||0),0);
    bucketTotals[ts.bucket] = (bucketTotals[ts.bucket]||0) + c;
  });
  const tot = Math.max(1, bucketTotals.product+bucketTotals.content+bucketTotals.unclassified);

  document.getElementById('auedBucketSection').style.display = auedTotal ? 'block' : 'none';
  document.getElementById('auedBucketPanel').innerHTML = `
    <h4>Product vs. content</h4>
    <div class="sub">${fmt(auedTotal)} author &amp; editor comments in this upload</div>
    <div class="bucket-split">
      <div style="width:${100*bucketTotals.product/tot}%;background:var(--gold)"></div>
      <div style="width:${100*bucketTotals.content/tot}%;background:var(--blue)"></div>
      <div style="width:${100*bucketTotals.unclassified/tot}%;background:var(--ink-600)"></div>
    </div>
    <div class="bucket-legend">
      <span class="chip"><span class="dot" style="background:var(--gold)"></span>Product ${pct(bucketTotals.product,tot)}% — the tool is missing something</span>
      <span class="chip"><span class="dot" style="background:var(--blue)"></span>Content ${pct(bucketTotals.content,tot)}% — genuine editorial note</span>
      <span class="chip"><span class="dot" style="background:var(--ink-600)"></span>Unclassified ${pct(bucketTotals.unclassified,tot)}%</span>
    </div>
  `;

  const sc = latest.au_sentiment_counts;
  const sTot = Math.max(1, sc.positive+sc.neutral+sc.negative);
  document.getElementById('auedSentimentPanel').innerHTML = `
    <h4>Tone</h4>
    <div class="sub">How authors &amp; editors sound when they write these — a secondary, earlier-warning signal</div>
    <div class="bucket-split">
      <div style="width:${100*sc.positive/sTot}%;background:var(--sage)"></div>
      <div style="width:${100*sc.neutral/sTot}%;background:var(--paper-faint)"></div>
      <div style="width:${100*sc.negative/sTot}%;background:var(--red)"></div>
    </div>
    <div class="bucket-legend">
      <span class="chip"><span class="dot" style="background:var(--sage)"></span>Positive ${pct(sc.positive,sTot)}%</span>
      <span class="chip"><span class="dot" style="background:var(--paper-faint)"></span>Neutral ${pct(sc.neutral,sTot)}%</span>
      <span class="chip"><span class="dot" style="background:var(--red)"></span>Negative ${pct(sc.negative,sTot)}%</span>
    </div>
  `;

  // owner columns
  document.getElementById('auedOwnerSection').style.display = auedTotal ? 'block' : 'none';
  const owners = [
    {key:'engineering', el:'ownerEngineering'},
    {key:'design', el:'ownerDesign'},
    {key:'customer_success', el:'ownerCustomerSuccess'},
  ];
  owners.forEach(o=>{
    const themes = topThemes(latest.theme_stats, roleKeys, ts=>ts.bucket==='product' && ts.owner===o.key, 6);
    document.getElementById(o.el).innerHTML = themes.length ? themes.map(t=>`
      <div class="theme-row"><div class="t-head"><span class="t-name">${t.name}</span><span class="t-count">${fmt(t.count)}</span></div>
      <div class="t-action">${t.action && t.action!=='n/a' ? t.action : 'No suggested action yet.'}</div></div>
    `).join('') : '<div class="empty-note" style="padding:6px 0;">Nothing routed here this upload.</div>';
  });

  // content themes
  const contentThemes = topThemes(latest.theme_stats, roleKeys, ts=>ts.bucket==='content', 8);
  document.getElementById('auedContentSection').style.display = contentThemes.length ? 'block' : 'none';
  document.getElementById('auedContentPanel').innerHTML = contentThemes.map(t=>`
    <div class="theme-row"><div class="t-head"><span class="t-name">${t.name}</span><span class="t-count">${fmt(t.count)}</span></div></div>
  `).join('');
}

/* ============================== MASTERCOPIER ============================== */
const MC_CATEGORY_META = {
  xml: {label:'XML', desc:'Tagging structure, metadata, and markup — should be rule-based automation.'},
  graphics: {label:'Graphics', desc:'Figure/image handling — should be a self-service upload &amp; edit flow.'},
  text: {label:'Text', desc:'In-body text fixes — should be editable directly, not described in a comment.'},
  layout: {label:'Layout', desc:'Spatial placement decisions — genuinely needs a human judgment call.'}
};

function renderMastercopier(latest){
  document.getElementById('mcEmpty').style.display = 'none';
  const mcTotal = latest.role_counts.mc || 0;
  const layoutCount = (latest.mc_category_totals.layout && latest.mc_category_totals.layout.count) || 0;
  const readinessPct = pct(layoutCount, mcTotal);
  const gap = mcTotal - layoutCount;

  document.getElementById('mcReadinessSection').style.display = mcTotal ? 'block' : 'none';
  document.getElementById('readinessPct').textContent = readinessPct + '%';
  document.getElementById('readinessGapText').textContent = fmt(gap) + ' comments';
  document.getElementById('readinessMeter').style.width = readinessPct + '%';

  document.getElementById('mcCategorySection').style.display = mcTotal ? 'block' : 'none';
  const order = ['xml','graphics','text','layout'];
  document.getElementById('mcCategoryGrid').innerHTML = order.map(cat=>{
    const meta = MC_CATEGORY_META[cat];
    const totals = latest.mc_category_totals[cat] || {count:0, product:0, content:0, unclassified:0};
    const themesObj = latest.mc_category_themes[cat] || {};
    const topCatThemes = Object.entries(themesObj).sort((a,b)=>b[1].count-a[1].count).slice(0,4);
    const isLayout = cat === 'layout';
    return `
      <div class="cat-card">
        <div class="cat-name">${meta.label}</div>
        <div class="cat-verdict ${isLayout?'expected':'target-zero'}">${isLayout?'Expected to remain':'Target: zero'}</div>
        <div class="cat-count">${fmt(totals.count)}</div>
        <div class="cat-count-label">${meta.desc}</div>
        <div class="cat-themes">
          ${topCatThemes.length ? topCatThemes.map(([name,t])=>`
            <div class="cat-mini-theme">
              <div class="mt-head"><span>${name}</span><span>${fmt(t.count)}</span></div>
              ${!isLayout ? `<div class="mt-action">${t.action && t.action!=='n/a' ? t.action : 'No suggested action yet.'}</div>` : ''}
            </div>
          `).join('') : '<div class="empty-note" style="padding:4px 0;">None this upload.</div>'}
        </div>
      </div>
    `;
  }).join('');
}

/* ============================== BACKLOG ============================== */
function renderBacklog(){
  document.getElementById('backlogEmpty').style.display = 'none';
  document.getElementById('backlogSection').style.display = 'block';

  const latest = snapshots[snapshots.length-1];
  const prev = snapshots.length>1 ? snapshots[snapshots.length-2] : null;
  const allThemeNames = new Set();
  snapshots.forEach(s=>Object.keys(s.theme_stats).forEach(t=>allThemeNames.add(t)));
  allThemeNames.delete('Unclassified');

  let rows = Array.from(allThemeNames).map(name=>{
    const latestTs = latest.theme_stats[name];
    if(!latestTs) return null;
    const prevCount = prev && prev.theme_stats[name] ? prev.theme_stats[name].count : null;
    const history = snapshots.map(s=> s.theme_stats[name] ? s.theme_stats[name].count : 0);
    const sevAvg = latestTs.sev_n ? (latestTs.sev_sum/latestTs.sev_n) : 3;
    const source = (latestTs.au+latestTs.ed) >= latestTs.mc ? 'aued' : 'mc';
    return {
      name, bucket: latestTs.bucket, owner: latestTs.owner, count: latestTs.count, action: latestTs.action,
      prevCount, history, priority: latestTs.count * sevAvg, source
    };
  }).filter(Boolean);

  const sourceF = document.getElementById('backlogSourceFilter').value;
  const bucketF = document.getElementById('backlogBucketFilter').value;
  const ownerF = document.getElementById('backlogOwnerFilter').value;
  rows = rows.filter(r=>{
    if(sourceF && r.source!==sourceF) return false;
    if(bucketF && r.bucket!==bucketF) return false;
    if(ownerF && r.owner!==ownerF) return false;
    return true;
  }).sort((a,b)=>b.priority-a.priority);

  const maxHist = Math.max(1, ...rows.flatMap(r=>r.history));
  document.getElementById('backlogBody').innerHTML = rows.map(r=>{
    const status = (backlogStatus[r.name] && backlogStatus[r.name].status) || 'New';
    let deltaCell = '<span class="delta-cell flat">—</span>';
    if(r.prevCount!==null){
      const diff = r.count - r.prevCount;
      if(diff===0) deltaCell = '<span class="delta-cell flat">flat</span>';
      else { const cls = diff<0?'down':'up'; const arrow = diff<0?'▼':'▲'; deltaCell = `<span class="delta-cell ${cls}">${arrow}${Math.abs(diff)}</span>`; }
    }
    const sparkBars = r.history.slice(-8).map((v,i,arr)=>{
      const h = Math.max(2, Math.round(20*v/maxHist));
      const isLast = i===arr.length-1;
      return `<div class="${isLast?'cur':''}" style="height:${h}px;"></div>`;
    }).join('');
    const ownerLabel = {engineering:'Engineering', design:'Design', customer_success:'Customer Success', none:'—'}[r.owner] || '—';
    return `<tr>
      <td class="b-theme">${r.name}</td>
      <td>${r.source==='aued'?'Author/Editor':'Mastercopier'}</td>
      <td><span class="badge ${r.bucket}">${r.bucket}</span></td>
      <td><span class="badge ${r.owner}">${ownerLabel}</span></td>
      <td>${fmt(r.count)}</td>
      <td>${deltaCell}</td>
      <td><div class="spark">${sparkBars}</div></td>
      <td><select class="status-select" data-theme="${encodeURIComponent(r.name)}">
        ${['New','Investigating','Planned','Shipped'].map(s=>`<option value="${s}" ${s===status?'selected':''}>${s}</option>`).join('')}
      </select></td>
      <td class="b-action">${r.action && r.action!=='n/a' ? r.action : (r.bucket==='content' ? 'Editorial — no product action needed.' : '—')}</td>
    </tr>`;
  }).join('');

  document.querySelectorAll('.status-select').forEach(sel=>{
    sel.addEventListener('change', async (e)=>{
      const theme = decodeURIComponent(e.target.getAttribute('data-theme'));
      const status = e.target.value;
      backlogStatus[theme] = {status, updatedAt: new Date().toISOString()};
      try{
        await fetch('/api/backlog/'+encodeURIComponent(theme), {
          method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({status})
        });
      }catch(err){ console.error('failed to save status', err); }
    });
  });
}
['backlogSourceFilter','backlogBucketFilter','backlogOwnerFilter'].forEach(id=>{
  document.getElementById(id).addEventListener('change', ()=>{ if(snapshots.length) renderBacklog(); });
});

/* ============================== EXPLORER ============================== */
const searchBox = document.getElementById('searchBox');
const roleFilter = document.getElementById('roleFilter');
const bucketFilter = document.getElementById('bucketFilter');
const cardContainer = document.getElementById('cardContainer');
const resultCount = document.getElementById('resultCount');
const loadMoreBtn = document.getElementById('loadMoreBtn');

function renderExplorer(){
  if(!currentGroups.length){
    document.getElementById('explorerSection').style.display = 'none';
    document.getElementById('explorerEmpty').style.display = 'block';
    return;
  }
  document.getElementById('explorerEmpty').style.display = 'none';
  document.getElementById('explorerSection').style.display = 'block';
  applyExplorerFilters();
}
function applyExplorerFilters(){
  const q = searchBox.value.trim().toLowerCase();
  const r = roleFilter.value, b = bucketFilter.value;
  filteredCards = currentGroups.filter(g=>{
    if(r && g.role!==r) return false;
    if(b && g.classification.bucket!==b) return false;
    if(q && !g.text.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a,b2)=>b2.count-a.count);
  cardsShown = 0;
  cardContainer.innerHTML='';
  resultCount.textContent = fmt(filteredCards.length) + ' matching comment patterns';
  renderMoreCards();
}
function renderMoreCards(){
  const roleNames = {au:'Author', ed:'Editor', mc:'Mastercopier', other:'Other'};
  const next = filteredCards.slice(cardsShown, cardsShown+CARD_PAGE);
  cardContainer.insertAdjacentHTML('beforeend', next.map(g=>`
    <div class="comment-card ${g.role}">
      <div class="cc-meta">
        <span>${roleNames[g.role]||g.role}</span> ·
        <span class="badge ${g.classification.bucket}">${g.classification.bucket}</span> ·
        ${g.classification.theme} · ×${g.count}${g.articleCount ? ' across '+g.articleCount+' article(s)' : ''}
      </div>
      <div class="cc-text">${g.text.replace(/</g,'&lt;')}</div>
    </div>
  `).join(''));
  cardsShown += next.length;
  loadMoreBtn.style.display = cardsShown>=filteredCards.length ? 'none' : 'block';
}
[searchBox, roleFilter, bucketFilter].forEach(el=>el.addEventListener('input', applyExplorerFilters));
loadMoreBtn.addEventListener('click', renderMoreCards);

/* ============================== RESET ============================== */
document.getElementById('resetBtn').addEventListener('click', async ()=>{
  if(!confirm('This clears all cached classifications, snapshots, and backlog statuses stored on the server. Continue?')) return;
  try{ await fetch('/api/reset', {method:'POST'}); }catch(e){ /* ignore */ }
  location.reload();
});

/* ============================== GO ============================== */
init();
