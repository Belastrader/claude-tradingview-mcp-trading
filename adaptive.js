import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADES_CSV = path.join(__dirname, 'trades.csv');
const RULES_JSON = path.join(__dirname, 'rules.json');
const OPT_LOG    = path.join(__dirname, 'optimization-log.json');
const BINANCE    = 'https://api.binance.com/api/v3';
const MIN_TRADES = 5;
const CFG = { tp: 1.0, sl: 0.5, candles: 30, rsi_min: 10, rsi_max: 35 };

async function klines(symbol, interval, startTime) {
  const url = `${BINANCE}/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime+1000}&limit=${CFG.candles}`;
  try {
    const r = await fetch(url);
    const d = await r.json();
    return d.map(k => ({ high: parseFloat(k[2]), low: parseFloat(k[3]) }));
  } catch { return null; }
}

async function evalSignal(symbol, side, price, ts, tf) {
  const cs = await klines(symbol, tf, ts);
  if (!cs?.length) return null;
  const tp = side==='buy' ? price*(1+CFG.tp/100) : price*(1-CFG.tp/100);
  const sl = side==='buy' ? price*(1-CFG.sl/100) : price*(1+CFG.sl/100);
  for (const c of cs) {
    if (side==='buy') {
      if (c.high >= tp) return { result:'WIN',  pnl: CFG.tp  };
      if (c.low  <= sl) return { result:'LOSS', pnl:-CFG.sl  };
    } else {
      if (c.low  <= tp) return { result:'WIN',  pnl: CFG.tp  };
      if (c.high >= sl) return { result:'LOSS', pnl:-CFG.sl  };
    }
  }
  return { result:'OPEN', pnl:0 };
}

function parseCsv() {
  if (!fs.existsSync(TRADES_CSV)) return [];
  const lines = fs.readFileSync(TRADES_CSV,'utf-8').trim().split('\n').filter(l=>l&&!l.startsWith('#'));
  if (lines.length < 2) return [];
  const hdrs = lines[0].split(',').map(h=>h.trim().toLowerCase().replace(/\s+/g,'_'));
  return lines.slice(1).map(l=>{ const v=l.split(','),o={}; hdrs.forEach((h,i)=>o[h]=v[i]?.trim()||''); return o; })
    .filter(t=>{
      const paper = (t.mode||t.paper_trading||t.paper||'').toLowerCase();
      return (paper.includes('paper')||paper==='true') && parseFloat(t.price||t.entry_price)>0 && (t.side||t.direction);
    });
}

function extractRsi(rules) {
  const l = (rules.entry_rules?.long||[]).join(' ');
  const s = (rules.entry_rules?.short||[]).join(' ');
  const lm = l.match(/abaixo de (\d+)/i); 
  const sm = s.match(/acima de (\d+)/i);
  return { rsiLong: lm?parseInt(lm[1]):20, rsiShort: sm?parseInt(sm[1]):80 };
}

async function run() {
  console.log('\nðŸ¤– Sistema Adaptativo v1 â€” ETH Scalping Bot\n' + 'â”€'.repeat(50));
  if (!fs.existsSync(RULES_JSON)) { console.error('âŒ rules.json nÃ£o encontrado.'); process.exit(1); }
  const rules = JSON.parse(fs.readFileSync(RULES_JSON,'utf-8'));
  const tf     = rules.default_timeframe || '5m';
  console.log(`   EstratÃ©gia: ${rules.strategy?.name}\n   Timeframe : ${tf}`);

  const trades = parseCsv();
  console.log(`\nðŸ“‚ ${trades.length} trades paper encontrados`);
  if (trades.length < MIN_TRADES) {
    console.log(`\nâ³ MÃ­nimo ${MIN_TRADES} trades necessÃ¡rio. Continue rodando o bot.\n`); return;
  }

  console.log('\nðŸ“Š Avaliando trades...');
  const results = [];
  for (let i=0; i<trades.length; i++) {
    const t = trades[i];
    const symbol = (t.symbol||'ETHUSDT').toUpperCase();
    const side   = (t.side||t.direction||'').toLowerCase().includes('buy') ? 'buy' : 'sell';
    const price  = parseFloat(t.price||t.entry_price);
    const ts     = new Date(t.date||t.timestamp||'').getTime();
    if (!price||!ts||isNaN(ts)) { console.log(`   âš ï¸  Trade ${i+1} ignorado`); continue; }
    process.stdout.write(`   Trade ${i+1}/${trades.length}...`);
    const ev = await evalSignal(symbol, side, price, ts, tf);
    if (ev) { results.push({...t,symbol,side,price,ts,...ev}); process.stdout.write(` ${ev.result}\n`); }
    else process.stdout.write(` sem dados\n`);
    await new Promise(r=>setTimeout(r,300));
  }

  const done = results.filter(r=>r.result!=='OPEN');
  if (!done.length) { console.log('\nâš ï¸  Nenhum trade avaliÃ¡vel ainda.\n'); return; }

  const wins     = done.filter(r=>r.result==='WIN').length;
  const wr       = parseFloat((wins/done.length*100).toFixed(1));
  const pnl      = parseFloat(done.reduce((s,r)=>s+r.pnl,0).toFixed(2));
  const longs    = done.filter(r=>r.side==='buy');
  const shorts   = done.filter(r=>r.side==='sell');
  const lwr      = longs.length  ? parseFloat((longs.filter(r=>r.result==='WIN').length/longs.length*100).toFixed(1))  : null;
  const swr      = shorts.length ? parseFloat((shorts.filter(r=>r.result==='WIN').length/shorts.length*100).toFixed(1)) : null;
  const bar      = p => 'â–ˆ'.repeat(Math.round(p/5))+'â–‘'.repeat(20-Math.round(p/5));

  console.log('\n'+'â•'.repeat(55));
  console.log('  ðŸ“ˆ RELATÃ“RIO DE PERFORMANCE');
  console.log('â•'.repeat(55));
  console.log(`  Trades avaliados : ${done.length}  (VitÃ³rias: ${wins} | Derrotas: ${done.length-wins})`);
  console.log(`  Win Rate         : ${wr}%  ${bar(wr)}`);
  console.log(`  P&L Simulado     : ${pnl>0?'+':''}${pnl}%`);
  if (lwr!==null) console.log(`  Long Win Rate    : ${lwr}%  (${longs.length} trades)`);
  if (swr!==null) console.log(`  Short Win Rate   : ${swr}%  (${shorts.length} trades)`);
  console.log('â•'.repeat(55));

  const params   = extractRsi(rules);
  const changes  = [];
  const newRules = JSON.parse(JSON.stringify(rules));
  let   newL     = params.rsiLong, newS = params.rsiShort;

  if (wr < 45) {
    newL = Math.max(CFG.rsi_min, params.rsiLong-3);
    newS = Math.min(100-CFG.rsi_min, params.rsiShort+3);
    changes.push({ param:'RSI threshold', de:`Long<${params.rsiLong} | Short>${params.rsiShort}`, para:`Long<${newL} | Short>${newS}`, motivo:`Win rate ${wr}% abaixo de 45% â€” apertando filtro RSI.` });
  } else if (wr > 68 && done.length < 15) {
    newL = Math.min(CFG.rsi_max, params.rsiLong+3);
    newS = Math.max(100-CFG.rsi_max, params.rsiShort-3);
    changes.push({ param:'RSI threshold', de:`Long<${params.rsiLong} | Short>${params.rsiShort}`, para:`Long<${newL} | Short>${newS}`, motivo:`Win rate ${wr}% Ã³timo mas poucos trades â€” relaxando RSI para mais frequÃªncia.` });
  }

  if (lwr!==null && swr!==null && Math.abs(lwr-swr)>20) {
    const melhor = lwr>swr?'LONG':'SHORT';
    changes.push({ param:'ViÃ©s direcional', de:'Neutro', para:`Favorece ${melhor}`, motivo:`DiferenÃ§a de ${Math.abs(lwr-swr).toFixed(1)}% entre long e short â€” mercado favorece ${melhor.toLowerCase()}s.` });
  }

  if (changes.length === 0) {
    console.log('\nâœ… EstratÃ©gia dentro dos parÃ¢metros ideais. Nenhum ajuste necessÃ¡rio.\n');
  } else {
    if (newL !== params.rsiLong) {
      newRules.entry_rules.long  = newRules.entry_rules.long.map(r=>r.match(/RSI/i)?r.replace(/abaixo de \d+/,`abaixo de ${newL}`):r);
      newRules.entry_rules.short = newRules.entry_rules.short.map(r=>r.match(/RSI/i)?r.replace(/acima de \d+/,`acima de ${newS}`):r);
      newRules.strategy.name = rules.strategy.name.replace(/ \(auto.*\)$/,'') + ` (auto-otimizado ${new Date().toLocaleDateString('pt-BR')})`;
    }
    fs.writeFileSync(RULES_JSON, JSON.stringify(newRules,null,2));
    const log = JSON.parse(fs.existsSync(OPT_LOG)?fs.readFileSync(OPT_LOG,'utf-8'):'[]');
    log.push({ timestamp:new Date().toISOString(), winRate:wr, pnl, changes });
    fs.writeFileSync(OPT_LOG, JSON.stringify(log,null,2));
    console.log('\nðŸ”§ Ajustes aplicados:');
    changes.forEach((c,i)=>{ console.log(`\n   ${i+1}. ${c.param}`); console.log(`      ${c.de} â†’ ${c.para}`); console.log(`      ${c.motivo}`); });
    console.log('\nâœ… rules.json atualizado. Rode: railway up\n');
  }
}

run().catch(e=>{ console.error('âŒ Erro:', e.message); process.exit(1); });
