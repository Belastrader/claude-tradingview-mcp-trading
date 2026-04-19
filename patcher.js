// patcher.js — aplica a estrategia agressiva no bot.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const botPath = path.join(__dirname, 'bot.js');

if (!fs.existsSync(botPath)) {
  console.error('ERRO: bot.js nao encontrado em', botPath);
  process.exit(1);
}

fs.copyFileSync(botPath, botPath + '.bak');
console.log('Backup criado: bot.js.bak');

let code = fs.readFileSync(botPath, 'utf8');

// PATCH 1: nova runSafetyCheck
const newSafetyCheck = `function runSafetyCheck(price, ema8, ema21, vwap, rsi14) {
  const bullishBias  = price > vwap;
  const bearishBias  = price < vwap;
  const emaUptrend   = ema8 > ema21;
  const emaDowntrend = ema8 < ema21;

  let signal = 'NEUTRAL';
  let reason  = '';

  if (bullishBias && emaUptrend && rsi14 >= 45 && rsi14 <= 70) {
    signal = 'LONG';
    reason = 'LONG | Preco ' + price.toFixed(2) + ' > VWAP ' + vwap.toFixed(2) + ' | EMA8 ' + ema8.toFixed(2) + ' > EMA21 ' + ema21.toFixed(2) + ' | RSI14 ' + rsi14.toFixed(1) + ' em [45-70]';
  } else if (bearishBias && emaDowntrend && rsi14 >= 30 && rsi14 <= 55) {
    signal = 'SHORT';
    reason = 'SHORT | Preco ' + price.toFixed(2) + ' < VWAP ' + vwap.toFixed(2) + ' | EMA8 ' + ema8.toFixed(2) + ' < EMA21 ' + ema21.toFixed(2) + ' | RSI14 ' + rsi14.toFixed(1) + ' em [30-55]';
  } else {
    const why = [];
    if (bullishBias  && !emaUptrend)   why.push('EMA8(' + ema8.toFixed(0) + ') < EMA21(' + ema21.toFixed(0) + ') contra-tendencia');
    if (bearishBias  && !emaDowntrend) why.push('EMA8(' + ema8.toFixed(0) + ') > EMA21(' + ema21.toFixed(0) + ') contra-tendencia');
    if (!bullishBias && !bearishBias)  why.push('Preco na VWAP sem vies');
    if (bullishBias  && emaUptrend  && (rsi14 < 45 || rsi14 > 70)) why.push('RSI14=' + rsi14.toFixed(1) + ' fora de [45-70]');
    if (bearishBias  && emaDowntrend && (rsi14 < 30 || rsi14 > 55)) why.push('RSI14=' + rsi14.toFixed(1) + ' fora de [30-55]');
    reason = 'NEUTRO | ' + (why.join(' | ') || 'condicoes nao atendidas');
  }

  return { signal, reason };
}`;

// Localiza de 'function runSafetyCheck(' ate o fechamento contando chaves
const start = code.indexOf('function runSafetyCheck(');
if (start === -1) {
  console.error('ERRO: runSafetyCheck nao encontrada no bot.js');
  process.exit(1);
}
let depth = 0, i = start, foundOpen = false;
while (i < code.length) {
  if (code[i] === '{') { depth++; foundOpen = true; }
  if (code[i] === '}') { depth--; }
  if (foundOpen && depth === 0) { i++; break; }
  i++;
}
code = code.slice(0, start) + newSafetyCheck + '\n' + code.slice(i);
console.log('PATCH 1 OK: runSafetyCheck substituida');

// PATCH 2: adicionar ema21 e rsi14 na run()
const ema8Idx = code.indexOf('const ema8 = calcEMA(closes, 8);');
if (ema8Idx !== -1) {
  const endOfLine = code.indexOf('\n', ema8Idx);
  const insert = '\n    const ema21 = calcEMA(closes, 21);\n    const rsi14 = calcRSI(closes, 14);';
  code = code.slice(0, endOfLine) + insert + code.slice(endOfLine);
  console.log('PATCH 2 OK: ema21 e rsi14 adicionados');
} else {
  console.error('ERRO PATCH 2: linha ema8 nao encontrada');
  process.exit(1);
}

// PATCH 3: atualizar chamada de runSafetyCheck na run()
const callStart = code.indexOf('runSafetyCheck(');
let pi = callStart + 'runSafetyCheck('.length;
let pd = 1;
while (pi < code.length && pd > 0) {
  if (code[pi] === '(') pd++;
  if (code[pi] === ')') pd--;
  pi++;
}
if (callStart !== -1) {
  code = code.slice(0, callStart) + 'runSafetyCheck(price, ema8, ema21, vwap, rsi14)' + code.slice(pi);
  console.log('PATCH 3 OK: chamada runSafetyCheck atualizada');
} else {
  console.warn('AVISO PATCH 3: chamada nao encontrada');
}

fs.writeFileSync(botPath, code, 'utf8');
console.log('\nbot.js atualizado com estrategia agressiva!');
console.log('  Long:  VWAP bullish + EMA8>EMA21 + RSI14 em [45-70]');
console.log('  Short: VWAP bearish + EMA8<EMA21 + RSI14 em [30-55]');
console.log('\nRode agora: node bot.js');
