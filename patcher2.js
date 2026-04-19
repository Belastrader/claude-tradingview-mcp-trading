// patcher2.js — corrige runSafetyCheck + call site + display
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const botPath = path.join(__dirname, 'bot.js');

fs.copyFileSync(botPath, botPath + '.bak2');
console.log('Backup criado: bot.js.bak2');

let code = fs.readFileSync(botPath, 'utf8');

// ── PATCH A: substituir runSafetyCheck completa com retorno correto ──────────
const newFn = `function runSafetyCheck(price, ema8, ema21, vwap, rsi14) {
  const bullishBias  = price > vwap;
  const bearishBias  = price < vwap;
  const emaUptrend   = ema8 > ema21;
  const emaDowntrend = ema8 < ema21;
  const rsiLong      = rsi14 >= 45 && rsi14 <= 70;
  const rsiShort     = rsi14 >= 30 && rsi14 <= 55;

  let signal = 'NEUTRAL';
  let reason  = '';

  const results = [
    {
      pass:  bullishBias || bearishBias,
      label: bullishBias
        ? 'VWAP bullish: preco ' + price.toFixed(2) + ' > VWAP ' + vwap.toFixed(2)
        : bearishBias
          ? 'VWAP bearish: preco ' + price.toFixed(2) + ' < VWAP ' + vwap.toFixed(2)
          : 'Sem vies VWAP (preco na VWAP)',
    },
    {
      pass:  emaUptrend || emaDowntrend,
      label: emaUptrend
        ? 'EMA uptrend: EMA8 ' + ema8.toFixed(2) + ' > EMA21 ' + ema21.toFixed(2)
        : emaDowntrend
          ? 'EMA downtrend: EMA8 ' + ema8.toFixed(2) + ' < EMA21 ' + ema21.toFixed(2)
          : 'EMA lateral: EMA8 == EMA21',
    },
    {
      pass:  (bullishBias && emaUptrend && rsiLong) || (bearishBias && emaDowntrend && rsiShort),
      label: 'RSI14 ' + rsi14.toFixed(1) + (bullishBias ? ' (zona alvo: 45-70)' : ' (zona alvo: 30-55)'),
    },
  ];

  const allPass = results.every((r) => r.pass);

  if (bullishBias && emaUptrend && rsiLong) {
    signal = 'LONG';
    reason = 'LONG | preco>' + vwap.toFixed(2) + ' (VWAP) | EMA8>EMA21 | RSI14=' + rsi14.toFixed(1);
  } else if (bearishBias && emaDowntrend && rsiShort) {
    signal = 'SHORT';
    reason = 'SHORT | preco<' + vwap.toFixed(2) + ' (VWAP) | EMA8<EMA21 | RSI14=' + rsi14.toFixed(1);
  } else {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    reason = 'NEUTRO | ' + failed.join(' | ');
  }

  return { results, allPass, signal, reason };
}`;

// Encontrar e substituir a funcao inteira por contagem de chaves
const fnStart = code.indexOf('function runSafetyCheck(');
if (fnStart === -1) { console.error('ERRO: runSafetyCheck nao encontrada'); process.exit(1); }
let depth = 0, i = fnStart, opened = false;
while (i < code.length) {
  if (code[i] === '{') { depth++; opened = true; }
  if (code[i] === '}') depth--;
  if (opened && depth === 0) { i++; break; }
  i++;
}
code = code.slice(0, fnStart) + newFn + '\n' + code.slice(i);
console.log('PATCH A OK: runSafetyCheck substituida com retorno { results, allPass, signal, reason }');

// ── PATCH B: atualizar a call site na run() ──────────────────────────────────
// Texto exato da chamada antiga: runSafetyCheck(price, ema8, vwap, rsi3, rules)
const oldCall = 'runSafetyCheck(price, ema8, vwap, rsi3, rules)';
const newCall = 'runSafetyCheck(price, ema8, ema21, vwap, rsi14)';
if (code.includes(oldCall)) {
  code = code.replace(oldCall, newCall);
  console.log('PATCH B OK: call site atualizada');
} else {
  // Tentar sem o parametro rules
  const alt = 'runSafetyCheck(price, ema8, vwap, rsi3)';
  if (code.includes(alt)) {
    code = code.replace(alt, newCall);
    console.log('PATCH B OK (alt): call site atualizada');
  } else {
    console.warn('AVISO PATCH B: call site nao encontrada pelo texto exato');
  }
}

// ── PATCH C: atualizar destructuring para incluir signal ─────────────────────
const oldDestr = 'const { results, allPass } = runSafetyCheck(price, ema8, ema21, vwap, rsi14)';
const newDestr = 'const { results, allPass, signal, reason } = runSafetyCheck(price, ema8, ema21, vwap, rsi14)';
if (code.includes(oldDestr)) {
  code = code.replace(oldDestr, newDestr);
  console.log('PATCH C OK: destructuring atualizado com signal e reason');
} else {
  console.warn('AVISO PATCH C: destructuring nao encontrado — verifique se signal/reason ja estao incluidos');
}

// ── PATCH D: atualizar display de indicadores ────────────────────────────────
const oldDisplay = "console.log(`  RSI(3):  ${rsi3 ? rsi3.toFixed(2) : \"N/A\"}`);";
const newDisplay = `console.log(\`  EMA(21): \$\{ema21.toFixed(2)\}\`);
  console.log(\`  RSI(14): \$\{rsi14 ? rsi14.toFixed(2) : "N/A"\}\`);`;
if (code.includes(oldDisplay)) {
  code = code.replace(oldDisplay, newDisplay);
  console.log('PATCH D OK: display atualizado para EMA21 e RSI14');
} else {
  console.warn('AVISO PATCH D: linha de display RSI3 nao encontrada');
}

// ── PATCH E: adicionar log do signal no Decision ─────────────────────────────
const decisionHeader = '"\\n\\u2500\\u2500 Decision ';
const signalLog = `\n  console.log(\`  Signal: \$\{signal\} — \$\{reason\}\`);`;
// Procurar pela linha de console.log do Decision e adicionar signal depois
const decisionIdx = code.indexOf('Decision \u2500');
if (decisionIdx !== -1) {
  const afterDecision = code.indexOf('\n', decisionIdx) + 1;
  code = code.slice(0, afterDecision) + `  console.log(\`  Sinal: \${signal} | \${reason}\`);\n` + code.slice(afterDecision);
  console.log('PATCH E OK: log do sinal adicionado');
}

fs.writeFileSync(botPath, code, 'utf8');
console.log('\nbot.js totalmente corrigido!');
console.log('Rode: node bot.js');
