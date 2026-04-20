import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const TRADES_CSV = path.join(__dirname, 'trades.csv');
const RULES_JSON = path.join(__dirname, 'rules.json');
const OPT_LOG    = path.join(__dirname, 'optimization-log.json');
const SAFETY_LOG = path.join(__dirname, 'safety-check-log.json');
const ENV_PATH   = path.join(__dirname, '.env');
const PORT       = 3000;

function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  fs.readFileSync(ENV_PATH, 'utf-8').split('\n').forEach(line => {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  });
}
loadEnv();

const RAILWAY_TOKEN          = process.env.RAILWAY_TOKEN          || '';
const RAILWAY_PROJECT_ID     = process.env.RAILWAY_PROJECT_ID     || '';
const RAILWAY_SERVICE_ID     = process.env.RAILWAY_SERVICE_ID     || '';
const RAILWAY_ENVIRONMENT_ID = process.env.RAILWAY_ENVIRONMENT_ID || '';
const RAILWAY_API            = 'https://backboard.railway.app/graphql/v2';

async function railwayGQL(query, variables = {}) {
  if (!RAILWAY_TOKEN) return null;
  try {
    const body = JSON.stringify({ query, variables });
    const res  = await fetch(RAILWAY_API, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RAILWAY_TOKEN}` },
      body,
    });
    const json = await res.json();
    if (json.errors) { console.error('Railway GQL errors:', json.errors); return null; }
    return json.data;
  } catch (e) {
    console.error('Railway API error:', e.message);
    return null;
  }
}

// ── Railway cache (3 min TTL to avoid rate limits) ────────────────────────────
let _railwayCache = null;
let _railwayCacheAt = 0;
const CACHE_TTL_MS = 3 * 60 * 1000;

async function getRailwayRuns() {
  if (!RAILWAY_TOKEN) return { runs: [], error: 'RAILWAY_TOKEN nao configurado' };

  // Return cached data if fresh
  if (_railwayCache && (Date.now() - _railwayCacheAt) < CACHE_TTL_MS) {
    return _railwayCache;
  }

  const projId = RAILWAY_PROJECT_ID;
  const svcId  = RAILWAY_SERVICE_ID;
  if (!projId || !svcId) {
    return { runs: [], error: 'Adicione RAILWAY_PROJECT_ID e RAILWAY_SERVICE_ID no dashboard.bat' };
  }

  // 1. Get the latest active deployment (just 1 call)
  const input = { projectId: projId, serviceId: svcId };
  if (RAILWAY_ENVIRONMENT_ID) input.environmentId = RAILWAY_ENVIRONMENT_ID;
  const depData = await railwayGQL(`
    query($input: DeploymentListInput!) {
      deployments(input: $input) { edges { node { id status createdAt } } }
    }
  `, { input });

  const edges = depData?.deployments?.edges || [];
  if (!edges.length) {
    return { runs: [], error: 'Nenhum deployment encontrado — verifique se o bot ja rodou no Railway.' };
  }

  // Find the most recent SUCCESS or INITIALIZING deployment (the running one)
  const activeDep = edges.find(e => ['SUCCESS','INITIALIZING','DEPLOYING'].includes(e.node.status))
                 || edges[0];

  // 2. Get logs from that deployment (1 call)
  const logData = await railwayGQL(`
    query($deploymentId: String!) {
      deploymentLogs(deploymentId: $deploymentId) { timestamp message }
    }
  `, { deploymentId: activeDep.node.id });

  const logs = logData?.deploymentLogs || [];

  // 3. Split logs into individual cron executions by "Starting Container" marker
  const runs = [];
  let currentBlock = [];
  let currentTime  = null;

  for (const log of logs) {
    const msg = (log.message || '').trim();
    if (msg === 'Starting Container') {
      if (currentBlock.length > 0 && currentTime) {
        runs.push(parseLogBlock(currentBlock, currentTime));
      }
      currentBlock = [];
      currentTime  = log.timestamp;
    } else {
      currentBlock.push(msg);
    }
  }
  if (currentBlock.length > 0 && currentTime) {
    runs.push(parseLogBlock(currentBlock, currentTime));
  }

  // Most recent first, cap at 15
  runs.reverse();
  const result = { runs: runs.slice(0, 15), error: null };

  _railwayCache   = result;
  _railwayCacheAt = Date.now();
  console.log(`Railway: ${runs.length} execucoes parseadas dos logs`);
  return result;
}

function parseLogBlock(lines, timestamp) {
  const text = lines.join('\n');

  // Signal detection
  let signal = 'NEUTRAL';
  let reason = 'Sem sinal';

  const sigMatch = text.match(/Signal:\s*(LONG|SHORT|NEUTRAL)[^\n]*/i);
  if (sigMatch) {
    signal = sigMatch[1].toUpperCase();
    reason = sigMatch[0].replace(/Signal:\s*/i,'').trim();
  } else if (/ENTRANDO LONG/i.test(text))  { signal = 'LONG';    reason = 'Entrada LONG'; }
  else if (/ENTRANDO SHORT/i.test(text)) { signal = 'SHORT';   reason = 'Entrada SHORT'; }
  else if (/Not enough data/i.test(text)) { signal = 'NEUTRAL'; reason = 'Dados insuficientes (RSI)'; }
  else if (/POSICAO ABERTA/i.test(text))  {
    const dirMatch = text.match(/POSICAO ABERTA\]\s*(LONG|SHORT)/i);
    signal = dirMatch ? dirMatch[1].toUpperCase() : 'NEUTRAL';
    reason = 'Posicao mantida';
  }

  // Price
  const priceMatch = text.match(/Current price:\s*\$?([\d.]+)/i)
                  || text.match(/Preco atual:\s*\$?([\d.]+)/i);
  // RSI
  const rsiMatch = text.match(/RSI\(14\):\s*([\d.]+)/i) || text.match(/RSI14?[=:\s]+([\d.]+)/i);
  // Trade executed?
  const entered   = /ENTRANDO (LONG|SHORT)/i.test(text);
  const paperTrade = text.match(/PAPER TRADE[^\n]{0,100}/i);
  const exited    = /\[SAIDA\]/i.test(text);
  const exitMatch  = text.match(/\[SAIDA\][^\n]{0,100}/i);
  const traded = entered || exited;

  // Position info
  const posMatch = text.match(/POSICAO ABERTA\]\s*(LONG|SHORT)\s*@\s*\$?([\d.]+)/i);
  const pnlMatch = text.match(/PnL flutuante:\s*([+-][\d.]+%)/i);

  let tradeInfo = null;
  if (exited && exitMatch) tradeInfo = exitMatch[0].trim().slice(0, 100);
  else if (entered && paperTrade) tradeInfo = paperTrade[0].trim().slice(0, 100);
  else if (posMatch) tradeInfo = `Posicao ${posMatch[1]} @ $${posMatch[2]}${pnlMatch ? ' | '+pnlMatch[1] : ''}`;

  // Status
  const status = /Not enough data/i.test(text) ? 'SKIP'
               : exited ? 'EXIT'
               : entered ? 'ENTRY'
               : 'SUCCESS';

  return {
    time:      new Date(timestamp).toLocaleString('pt-BR'),
    signal,
    reason:    reason.slice(0, 80),
    status,
    price:     priceMatch ? priceMatch[1] : '--',
    rsi14:     rsiMatch   ? rsiMatch[1]   : '--',
    traded,
    tradeInfo,
  };
}

function loadJson(p, fb) { try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf-8')) : fb; } catch { return fb; } }
function parseCsv() {
  if (!fs.existsSync(TRADES_CSV)) return [];
  const lines = fs.readFileSync(TRADES_CSV,'utf-8').trim().split('\n').filter(l=>l&&!l.startsWith('#'));
  if (lines.length < 2) return [];
  const hdrs = lines[0].split(',').map(h=>h.trim().toLowerCase().replace(/\s+/g,'_'));
  return lines.slice(1).map(l=>{ const v=l.split(','),o={}; hdrs.forEach((h,i)=>o[h]=v[i]?.trim()||''); return o; });
}

function getLocalData() {
  const trades = parseCsv();
  const rules  = loadJson(RULES_JSON, {});
  const optLog = loadJson(OPT_LOG, []);
  const safety = loadJson(SAFETY_LOG, []);
  const paper  = trades.filter(t=>{ const m=(t.mode||t.paper_trading||t.paper||'').toLowerCase(); return m.includes('paper')||m==='true'; });
  const longs  = paper.filter(t=>(t.side||t.direction||'').toLowerCase().includes('buy'));
  const shorts = paper.filter(t=>(t.side||t.direction||'').toLowerCase().includes('sell'));
  const byDay  = {};
  paper.forEach(t=>{ const d=(t.date||t.timestamp||'').split('T')[0].split(' ')[0]; if(d) byDay[d]=(byDay[d]||0)+1; });
  const dayLabels = Object.keys(byDay).sort().slice(-14);
  return {
    totalAnalises: safety.length || 0,
    totalTrades:   paper.length,
    longs:         longs.length,
    shorts:        shorts.length,
    otimizacoes:   optLog.length,
    lastRun:       safety.length > 0 ? new Date(safety[safety.length-1]?.timestamp||'').toLocaleString('pt-BR') : 'Ainda nao rodou',
    lastOpt:       optLog.length > 0 ? new Date(optLog[optLog.length-1].timestamp).toLocaleString('pt-BR') : 'Nenhuma ainda',
    lastWr:        optLog.length > 0 ? (optLog[optLog.length-1].winRate || null) : null,
    symbol:        rules.watchlist?.[0] || 'ETHUSDT',
    timeframe:     rules.default_timeframe || '3m',
    strategy:      (rules.strategy?.name || 'Estrategia nao carregada').replace(/ \(auto.*\)$/,''),
    dayLabels,
    dayCounts:     dayLabels.map(d=>byDay[d]),
    optLabels:     optLog.slice(-8).map((_,i)=>`Opt ${i+1}`),
    optWrData:     optLog.slice(-8).map(o=>o.winRate||0),
    updatedAt:     new Date().toLocaleString('pt-BR'),
    hasRailwayToken: !!RAILWAY_TOKEN,
  };
}

const HTML = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Trading Bot Dashboard</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e2e8f0}
.header{background:linear-gradient(135deg,#1a1f2e,#16213e);padding:20px 32px;border-bottom:1px solid #2d3748;display:flex;align-items:center;justify-content:space-between}
.header h1{font-size:20px;font-weight:700;color:#fff}.header h1 span{color:#63b3ed}
.live{display:flex;align-items:center;gap:8px;font-size:12px;color:#68d391}
.dot{width:8px;height:8px;border-radius:50%;background:#68d391;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.badge{background:#1a3a2a;color:#68d391;border:1px solid #2f855a;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600}
.railway-badge{background:#1a2a3a;color:#63b3ed;border:1px solid #2b6cb0;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600}
.sub{color:#718096;font-size:13px;margin-top:4px}
.main{max-width:1260px;margin:0 auto;padding:24px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:24px}
.card{background:#1a1f2e;border:1px solid #2d3748;border-radius:12px;padding:18px}
.card .label{font-size:11px;color:#718096;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
.card .value{font-size:26px;font-weight:700;color:#fff}
.card .value.green{color:#68d391}.card .value.yellow{color:#f6e05e}.card .value.blue{color:#63b3ed}
.card .meta{font-size:11px;color:#718096;margin-top:5px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:20px}
.panel{background:#1a1f2e;border:1px solid #2d3748;border-radius:12px;padding:18px}
.panel h3{font-size:12px;font-weight:600;color:#a0aec0;text-transform:uppercase;letter-spacing:.05em;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between}
.panel h3 .src{font-size:10px;padding:2px 7px;border-radius:8px;font-weight:600}
.src.railway{background:#1a2a3a;color:#63b3ed}.src.local{background:#2d2b1f;color:#f6e05e}
.chart-wrap{position:relative;height:190px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;color:#718096;font-weight:500;padding:7px 10px;border-bottom:1px solid #2d3748;font-size:11px;text-transform:uppercase}
td{padding:9px 10px;border-bottom:1px solid #1e2535;color:#cbd5e0}
tr:last-child td{border-bottom:none}
.pill{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700}
.pill.long{background:#1a3a2a;color:#68d391}.pill.short{background:#2d1f1f;color:#fc8181}
.pill.neutral{background:#2d2b1f;color:#f6e05e}.pill.sym{background:#1a3050;color:#63b3ed}
.pill.success{background:#1a3050;color:#63b3ed}.pill.crashed{background:#2d1f1f;color:#fc8181}
.prow{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #1e2535;font-size:13px}
.prow:last-child{border-bottom:none}.prow .k{color:#718096}.prow .v{color:#e2e8f0;font-weight:500}
.sbox{background:#0f1117;border:1px solid #2d3748;border-radius:8px;padding:14px;margin-bottom:14px}
.sbox .name{font-size:14px;font-weight:600;color:#63b3ed;margin-bottom:10px}
.empty{color:#4a5568;font-size:13px;text-align:center;padding:20px}
.footer{color:#4a5568;font-size:11px;margin-top:16px;display:flex;justify-content:space-between;align-items:center}
.countdown{color:#63b3ed;font-size:11px;font-weight:600}
.err-bar{border-radius:8px;padding:10px 16px;margin-bottom:16px;font-size:12px;display:none}
.err-bar.warn{background:#2d2b1f;border:1px solid #d69e2e;color:#f6e05e}
.err-bar.err{background:#2d1f1f;border:1px solid #c53030;color:#fc8181}
.setup-box{background:#0d1f2d;border:1px solid #2b6cb0;border-radius:12px;padding:20px;margin-bottom:24px;display:none}
.setup-box h3{color:#63b3ed;font-size:14px;margin-bottom:12px}
.setup-box code{background:#0f1117;border:1px solid #2d3748;border-radius:4px;padding:2px 6px;font-size:12px;color:#68d391;font-family:monospace}
.setup-box ol{margin-left:20px;font-size:13px;color:#a0aec0;line-height:2}
.spinning{animation:spin 1s linear infinite;display:inline-block}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@media(max-width:700px){.grid2{grid-template-columns:1fr}}
</style></head><body>
<div class="header">
  <div><h1>Trading Bot <span>Dashboard</span></h1><div class="sub" id="sub">Carregando...</div></div>
  <div style="display:flex;gap:12px;align-items:center">
    <div class="live"><div class="dot"></div>Ao vivo 10s</div>
    <span class="badge">PAPER TRADING</span>
    <span class="railway-badge" id="railway-status">Railway</span>
  </div>
</div>
<div class="main">
  <div class="err-bar warn" id="warn-bar"></div>
  <div class="err-bar err"  id="err-bar"></div>
  <div class="setup-box" id="setup-box">
    <h3 id="setup-title">Configure o acesso ao Railway</h3>
    <div id="setup-no-token">
      <p style="font-size:13px;color:#a0aec0;margin-bottom:12px">Sem token Railway. Adicione no <code>dashboard.bat</code>:</p>
      <ol>
        <li>Acesse <strong>railway.app/account/tokens</strong> e crie um <strong>Personal Token</strong></li>
        <li>No <code>dashboard.bat</code>, adicione: <code>set RAILWAY_TOKEN=seu_token_aqui</code></li>
        <li>Reinicie o dashboard</li>
      </ol>
    </div>
    <div id="setup-needs-ids" style="display:none">
      <p style="font-size:13px;color:#a0aec0;margin-bottom:12px">Token de projeto detectado — adicione os IDs no <code>dashboard.bat</code>:</p>
      <ol>
        <li>Abra <strong>railway.app</strong> seu projeto clique no servico do bot</li>
        <li>Copie o ID do projeto e do servico da URL:<br>
            <code style="font-size:11px">railway.app/project/PROJECT_ID/service/SERVICE_ID</code></li>
        <li>Adicione no <code>dashboard.bat</code>:<br>
            <code>set RAILWAY_PROJECT_ID=cole-o-project-id-aqui</code><br>
            <code>set RAILWAY_SERVICE_ID=cole-o-service-id-aqui</code></li>
        <li>Reinicie o dashboard</li>
      </ol>
    </div>
  </div>
  <div class="cards">
    <div class="card"><div class="label">Analises (Railway)</div><div class="value blue" id="c-analises">--</div><div class="meta" id="c-lastrun">--</div></div>
    <div class="card"><div class="label">Ultimo sinal</div><div class="value" id="c-signal">--</div><div class="meta" id="c-signal-time">--</div></div>
    <div class="card"><div class="label">Trades locais</div><div class="value yellow" id="c-trades">--</div><div class="meta" id="c-ls">--</div></div>
    <div class="card"><div class="label">Win Rate</div><div class="value green" id="c-wr">--</div><div class="meta" id="c-wrsub">--</div></div>
    <div class="card"><div class="label">Simbolo / TF</div><div class="value blue" style="font-size:20px" id="c-sym">--</div><div class="meta" id="c-tf">--</div></div>
  </div>
  <div class="grid2">
    <div class="panel" style="grid-column:1/-1">
      <h3>Ultimas execucoes no Railway <span class="src railway" id="railway-src">API</span></h3>
      <div id="railway-wrap"><div class="empty"><span class="spinning">Loading</span> Buscando dados do Railway...</div></div>
    </div>
  </div>
  <div class="grid2">
    <div class="panel"><h3>Trades por dia <span class="src local">Local</span></h3><div class="chart-wrap"><canvas id="cDays"></canvas></div><div class="empty" id="empty-days" style="display:none">Sem trades ainda</div></div>
    <div class="panel">
      <h3>Parametros <span class="src local">Local</span></h3>
      <div class="sbox"><div class="name" id="p-name">--</div>
        <div class="prow"><span class="k">Indicadores</span><span class="v">EMA 8/21 RSI(14) VWAP</span></div>
        <div class="prow"><span class="k">Take Profit</span><span class="v">1.0%</span></div>
        <div class="prow"><span class="k">Stop Loss</span><span class="v">0.5%</span></div>
        <div class="prow"><span class="k">R/R</span><span class="v">1:2</span></div>
        <div class="prow"><span class="k">Modo</span><span class="v" style="color:#68d391">Paper Trading</span></div>
        <div class="prow"><span class="k">Cron</span><span class="v">A cada 3 minutos</span></div>
        <div class="prow"><span class="k">Max Trades/dia</span><span class="v" style="color:#63b3ed">1000</span></div>
      </div>
    </div>
  </div>
  <div class="footer">
    <span id="footer-left">--</span>
    <span class="countdown" id="countdown"></span>
  </div>
</div>
<script>
let chartDays=null,nextRefresh=10,countdownTimer=null;
const co={responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#718096',font:{size:10}},grid:{color:'#1e2535'}},y:{ticks:{color:'#718096',font:{size:10}},grid:{color:'#1e2535'}}}};
function pillSignal(s){const u=(s||'').toUpperCase();if(u==='LONG'||u.includes('BUY'))return '<span class="pill long">LONG</span>';if(u==='SHORT'||u.includes('SELL'))return '<span class="pill short">SHORT</span>';return '<span class="pill neutral">NEUTRAL</span>';}
function pillStatus(s){const u=(s||'').toUpperCase();if(u==='SUCCESS')return '<span class="pill success">OK</span>';if(u.includes('CRASH')||u.includes('FAIL'))return '<span class="pill crashed">Erro</span>';return '<span class="pill neutral">'+s+'</span>';}
function startCountdown(){if(countdownTimer)clearInterval(countdownTimer);nextRefresh=10;const el=document.getElementById('countdown');el.textContent='Proxima atualizacao em '+nextRefresh+'s';countdownTimer=setInterval(()=>{nextRefresh--;if(nextRefresh<=0)nextRefresh=10;el.textContent='Proxima atualizacao em '+nextRefresh+'s';},1000);}
function setErr(msg){const el=document.getElementById('err-bar');el.style.display=msg?'block':'none';if(msg)el.textContent='Erro: '+msg;}
function setWarn(msg){const el=document.getElementById('warn-bar');el.style.display=msg?'block':'none';if(msg)el.textContent='Info: '+msg;}
async function refresh(){
  try{
    const d=await fetch('/data').then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json();});
    setErr(null);
    document.getElementById('setup-box').style.display=d.hasRailwayToken?'none':'block';
    document.getElementById('railway-status').textContent=d.hasRailwayToken?'Railway OK':'Railway (sem token)';
    document.getElementById('sub').textContent=d.symbol+' '+d.timeframe+' '+d.strategy;
    document.getElementById('c-trades').textContent=d.totalTrades;
    document.getElementById('c-ls').textContent='Longs: '+d.longs+' Shorts: '+d.shorts;
    document.getElementById('c-sym').textContent=d.symbol;
    document.getElementById('c-tf').textContent='Grafico de '+d.timeframe;
    document.getElementById('p-name').textContent=d.symbol+' '+d.timeframe;
    document.getElementById('footer-left').textContent='Atualizado em '+d.updatedAt+' localhost:3000';
    if(d.lastWr!==null){document.getElementById('c-wr').textContent=d.lastWr+'%';document.getElementById('c-wrsub').textContent=d.lastWr>=50?'Acima de 50%':'Abaixo de 50%';}
    if(d.dayLabels.length>0){
      document.getElementById('empty-days').style.display='none';
      if(!chartDays)chartDays=new Chart(document.getElementById('cDays').getContext('2d'),{type:'bar',data:{labels:d.dayLabels,datasets:[{data:d.dayCounts,backgroundColor:'#3182ce',borderRadius:4}]},options:co});
      else{chartDays.data.labels=d.dayLabels;chartDays.data.datasets[0].data=d.dayCounts;chartDays.update();}
    }else document.getElementById('empty-days').style.display='block';
    const r=await fetch('/railway').then(res=>{if(!res.ok)throw new Error('HTTP '+res.status);return res.json();});
    const rw=document.getElementById('railway-wrap');
    if(r.error){
      setWarn(r.error);
      rw.innerHTML='<div class="empty">'+r.error+'</div>';
      document.getElementById('c-analises').textContent='--';
      if(d.hasRailwayToken&&r.error.includes('RAILWAY_PROJECT_ID')){
        document.getElementById('setup-box').style.display='block';
        document.getElementById('setup-no-token').style.display='none';
        document.getElementById('setup-needs-ids').style.display='block';
        document.getElementById('setup-title').textContent='Token de projeto Railway: adicione os IDs';
      }
    }else{
      setWarn(null);
      document.getElementById('c-analises').textContent=r.runs.length;
      document.getElementById('c-lastrun').textContent=r.runs.length>0?'Ultimo: '+r.runs[0].time:'--';
      if(r.runs.length>0){const last=r.runs[0];document.getElementById('c-signal').innerHTML=pillSignal(last.signal);document.getElementById('c-signal-time').textContent=last.time;}
      if(r.runs.length===0){
        rw.innerHTML='<div class="empty">Nenhuma execucao encontrada. O bot ainda nao rodou.</div>';
      }else{
        rw.innerHTML='<table><thead><tr><th>Horario</th><th>Sinal</th><th>Preco</th><th>RSI14</th><th>Trade</th><th>Status</th><th>Motivo</th></tr></thead><tbody>'+
          r.runs.map(run=>'<tr style="'+(run.traded?'background:rgba(104,211,145,0.05);border-left:2px solid #68d391':'')+'">'+
            '<td style="white-space:nowrap">'+run.time+'</td>'+
            '<td>'+pillSignal(run.signal)+'</td>'+
            '<td style="color:#63b3ed">'+run.price+'</td>'+
            '<td style="color:#a0aec0">'+run.rsi14+'</td>'+
            '<td>'+(run.traded?'<span class="pill long" title="'+run.tradeInfo+'">Executado</span>':'<span style="color:#4a5568;font-size:11px">--</span>')+'</td>'+
            '<td>'+pillStatus(run.status)+'</td>'+
            '<td style="color:#718096;font-size:11px;max-width:250px">'+(run.traded&&run.tradeInfo?'<span style="color:#68d391">'+run.tradeInfo+'</span>':run.reason)+'</td>'+
          '</tr>').join('')+
        '</tbody></table>';
      }
    }
  }catch(e){setErr(e.message);console.error(e);}
  startCountdown();
}
refresh();
setInterval(refresh,10000);
<\/script></body></html>`;

const server = http.createServer(async (req, res) => {
  if (req.url === '/data') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getLocalData()));
  } else if (req.url === '/railway') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const result = await getRailwayRuns(15);
      res.end(JSON.stringify(result));
    } catch (e) {
      res.end(JSON.stringify({ runs: [], error: e.message }));
    }
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
  }
});

server.listen(3000, () => {
  const hasToken = !!RAILWAY_TOKEN;
  console.log('===============================================');
  console.log('  Trading Bot Dashboard -- localhost:3000');
  console.log('===============================================');
  console.log('  Railway API: ' + (hasToken ? 'Token configurado' : 'RAILWAY_TOKEN nao encontrado'));
  console.log('  Atualiza automaticamente a cada 10 segundos.');
  console.log('  Pressione Ctrl+C para parar.');
  console.log('===============================================\n');
  const cmd = process.platform === 'win32' ? 'start http://localhost:3000' : 'open http://localhost:3000';
  exec(cmd);
});
