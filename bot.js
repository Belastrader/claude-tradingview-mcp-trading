/**
 * Claude + TradingView MCP – Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via BitGet if everything lines up.
 *
 * Exit system: manages positions with TP/SL only (signal reversal disabled).
 * Parameters: take_profit_pct and stop_loss_pct in rules.json (Claude optimizes these)
 *
 * v3 improvements:
 *  - 15m higher-timeframe trend filter (only trade WITH the 15m trend)
 *  - Volume confirmation (entry only on volume > 1.3x 20-candle avg)
 *  - Tighter RSI zones: LONG 50-65, SHORT 35-50
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ── Onboarding ──────────────────────────────────────────────────────────────────

function checkOnboarding() { if (process.env.BITGET_API_KEY) return;
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env")) {
    console.log("\n⚠  No .env file found – opening it for you to fill in...\n");
    writeFileSync(".env", [
      "# BitGet credentials",
      "BITGET_API_KEY=",
      "BITGET_SECRET_KEY=",
      "BITGET_PASSPHRASE=",
      "",
      "# Trading config",
      "PORTFOLIO_VALUE_USD=1000",
      "MAX_TRADE_SIZE_USD=100",
      "MAX_TRADES_PER_DAY=3",
      "PAPER_TRADING=true",
      "SYMBOL=BTCUSDT",
      "TIMEFRAME=4H",
    ].join("\n") + "\n");
    try { execSync("open .env"); } catch {}
    console.log("Fill in your BitGet credentials in .env then re-run: node bot.js\n");
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try { execSync("open .env"); } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  const csvPath = DATA_DIR + '/trades.csv';
  console.log(`\n📋 Trade log: ${csvPath}`);
  console.log(`   Open in Google Sheets or Excel any time\n`);
}

// ── Config ──────────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol:          process.env.SYMBOL || "BTCUSDT",
  timeframe:       process.env.TIMEFRAME || "3m",
  portfolioValue:  parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading:    process.env.PAPER_TRADING !== "false",
  tradeMode:       process.env.TRADE_MODE || "spot",
  bitget: {
    apiKey:     process.env.BITGET_API_KEY,
    secretKey:  process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl:    process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

const DATA_DIR      = existsSync('/data') ? '/data' : '.';
const POSITION_FILE = DATA_DIR + '/positions.json';
const LOG_FILE      = DATA_DIR + '/safety-check-log.json';
const CSV_FILE      = DATA_DIR + '/trades.csv';

// ── Logging ─────────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced
  ).length;
}

// ── Position Management ──────────────────────────────────────────────────────────

function loadPosition() {
  if (!existsSync(POSITION_FILE)) return { open: false };
  try { return JSON.parse(readFileSync(POSITION_FILE, "utf8")); }
  catch { return { open: false }; }
}

function savePosition(pos) {
  writeFileSync(POSITION_FILE, JSON.stringify(pos, null, 2));
}

const SL_COOLDOWN_MS = 20 * 60 * 1000; // 20 minutos após SL

function clearPosition(exitReason = null) {
  const cooldown = exitReason === 'SL_HIT'
    ? { slCooldownUntil: Date.now() + SL_COOLDOWN_MS }
    : {};
  savePosition({ open: false, ...cooldown });
}

function calcPnlPct(direction, entryPrice, exitPrice) {
  if (direction === "LONG") {
    return (exitPrice - entryPrice) / entryPrice * 100;
  } else {
    return (entryPrice - exitPrice) / entryPrice * 100;
  }
}

// ── TradingView Scanner API ───────────────────────────────────────────────────────
// Usa o endpoint público do screener do TV (sem autenticação, funciona no free)
// Retorna o consenso de 26 indicadores: STRONG_BUY / BUY / NEUTRAL / SELL / STRONG_SELL

async function fetchTVAnalysis(symbol, interval = "3") {
  const tvInterval = interval === "3m" ? "3" : interval.replace("m","").replace("h","0");
  const ticker = `BINANCE:${symbol}|${tvInterval}`;
  try {
    const res = await fetch("https://scanner.tradingview.com/crypto/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbols: { tickers: [ticker] },
        columns: ["Recommend.All", "Recommend.MA", "Recommend.Other"],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return "UNAVAILABLE";
    const data = await res.json();
    const rec = data?.data?.[0]?.d?.[0];
    if (rec === null || rec === undefined) return "UNAVAILABLE";
    if (rec >=  0.5) return "STRONG_BUY";
    if (rec >=  0.1) return "BUY";
    if (rec <= -0.5) return "STRONG_SELL";
    if (rec <= -0.1) return "SELL";
    return "NEUTRAL";
  } catch {
    return "UNAVAILABLE";
  }
}

// ── Market Data ──────────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, limit = 500) {
  // Tentamos múltiplas fontes em ordem — a primeira que responder com dados válidos vence.
  // Bybit e OKX funcionam em servidores dos EUA (Railway). Binance fica como último recurso.

  // Bybit usa formato numérico: "1m"→"1", "15m"→"15", "1h"→"60"
  const bybitInterval = interval.endsWith('h')
    ? String(parseInt(interval) * 60)
    : interval.replace('m', '');

  // OKX usa o mesmo formato que o bot: "1m", "15m"
  const okxSymbol = symbol.replace('USDT', '-USDT'); // BTCUSDT → BTC-USDT

  const sources = [
    // 1. Bybit — sem geo-restrições, alta liquidez em BTCUSDT perp
    async () => {
      const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${bybitInterval}&limit=${limit}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Bybit HTTP ${res.status}`);
      const json = await res.json();
      if (json.retCode !== 0) throw new Error(`Bybit: ${json.retMsg}`);
      // Bybit retorna do mais recente para o mais antigo → inverter
      // Formato: [startTime, open, high, low, close, volume(BTC), turnover(USDT)]
      return json.result.list.reverse().map(k => ({
        time: parseInt(k[0]),
        open:   parseFloat(k[1]),
        high:   parseFloat(k[2]),
        low:    parseFloat(k[3]),
        close:  parseFloat(k[4]),
        volume: parseFloat(k[6]),  // turnover = volume em USDT
      }));
    },

    // 2. OKX — exchange global, acessível em qualquer região
    async () => {
      const url = `https://www.okx.com/api/v5/market/candles?instId=${okxSymbol}&bar=${interval}&limit=${Math.min(limit, 300)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`OKX HTTP ${res.status}`);
      const json = await res.json();
      if (json.code !== '0') throw new Error(`OKX: ${json.msg}`);
      // OKX: [ts, o, h, l, c, vol(BTC), volCcy(BTC), volCcyQuote(USDT), confirm]  mais recente primeiro
      return json.data.reverse().map(k => ({
        time: parseInt(k[0]),
        open:   parseFloat(k[1]),
        high:   parseFloat(k[2]),
        low:    parseFloat(k[3]),
        close:  parseFloat(k[4]),
        volume: parseFloat(k[7]),  // volCcyQuote = volume em USDT
      }));
    },

    // 3. Binance global — pode ser bloqueada em servidores dos EUA
    async () => {
      const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
      const json = await res.json();
      return json.map(k => ({
        time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
        low:  parseFloat(k[3]), close: parseFloat(k[4]),
        volume: parseFloat(k[7]),  // quote volume em USDT
      }));
    },
  ];

  let lastErr;
  for (const source of sources) {
    try {
      const candles = await source();
      if (candles && candles.length > 0) return candles;
    } catch (e) {
      lastErr = e;
      console.log(`  [dados] fonte indisponivel: ${e.message}`);
    }
  }
  throw lastErr ?? new Error('Todas as fontes de dados falharam');
}

// ── Indicators ───────────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcVolumeAvg(candles, period = 20) {
  const recent = candles.slice(-period - 1, -1); // last N closed candles (exclude current)
  if (recent.length === 0) return 0;
  return recent.reduce((sum, c) => sum + c.volume, 0) / recent.length;
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const recent = candles.slice(-(period + 1));
  let trSum = 0;
  for (let i = 1; i < recent.length; i++) {
    const high     = recent[i].high;
    const low      = recent[i].low;
    const prevClose = recent[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low  - prevClose)
    );
    trSum += tr;
  }
  return trSum / period;
}

function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume, 0
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ── Safety Check ─────────────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, ema21, vwap, rsi14, ema8_15m, ema21_15m, currentVolume, avgVolume, atr) {
  const bullishBias    = price > vwap;
  const bearishBias    = price < vwap;
  const emaUptrend     = ema8 > ema21;
  const emaDowntrend   = ema8 < ema21;
  // v3: tighter RSI zones — above/below midpoint confirms momentum direction
  const rsiLong        = rsi14 >= 50 && rsi14 <= 65;
  const rsiShort       = rsi14 >= 35 && rsi14 <= 50;
  // v3: 15m trend filter
  const trend15mBull   = ema8_15m > ema21_15m;
  const trend15mBear   = ema8_15m < ema21_15m;
  // v3: volume confirmation
  const volumeOk       = avgVolume > 0 && currentVolume >= avgVolume * 1.3;
  // v4.4: ATR filter — bloqueia entradas em mercado lateral/choppy
  // ATR(14) deve ser >= 0.12% do preco para garantir movimento direcional suficiente
  const atrPct         = atr ? (atr / price) * 100 : 0;
  const atrOk          = atr !== null && atrPct >= 0.12;

  let signal = "NEUTRAL";
  let reason = "";

  const results = [
    {
      pass: bullishBias || bearishBias,
      label: bullishBias
        ? `VWAP bullish: preco ${price.toFixed(2)} > VWAP ${vwap.toFixed(2)}`
        : bearishBias
        ? `VWAP bearish: preco ${price.toFixed(2)} < VWAP ${vwap.toFixed(2)}`
        : "Sem vies VWAP (preco na VWAP)",
    },
    {
      pass: emaUptrend || emaDowntrend,
      label: emaUptrend
        ? `EMA1m uptrend: EMA8 ${ema8.toFixed(2)} > EMA21 ${ema21.toFixed(2)}`
        : emaDowntrend
        ? `EMA1m downtrend: EMA8 ${ema8.toFixed(2)} < EMA21 ${ema21.toFixed(2)}`
        : `EMA1m lateral: EMA8 == EMA21`,
    },
    {
      pass: (bullishBias && emaUptrend && rsiLong) || (bearishBias && emaDowntrend && rsiShort),
      label: `RSI14 ${rsi14.toFixed(1)}` + (bullishBias ? " (zona alvo: 50-65)" : " (zona alvo: 35-50)"),
    },
    {
      pass: (bullishBias && trend15mBull) || (bearishBias && trend15mBear),
      label: trend15mBull
        ? `Tendencia 15m: ALTA (EMA8_15m ${ema8_15m.toFixed(2)} > EMA21_15m ${ema21_15m.toFixed(2)})`
        : trend15mBear
        ? `Tendencia 15m: BAIXA (EMA8_15m ${ema8_15m.toFixed(2)} < EMA21_15m ${ema21_15m.toFixed(2)})`
        : `Tendencia 15m: indefinida`,
    },
    {
      pass: volumeOk,
      label: `Volume USDT: $${currentVolume.toFixed(0)} vs media $${avgVolume.toFixed(0)} (min: $${(avgVolume*1.3).toFixed(0)})`,
    },
    {
      pass: atrOk,
      label: atr
        ? `ATR(14): $${atr.toFixed(1)} (${atrPct.toFixed(3)}% do preco${atrOk ? '' : ', min: 0.12% — mercado lateral'})`
        : `ATR(14): dados insuficientes`,
    },
  ];

  const allPass = results.every((r) => r.pass);

  if (bullishBias && emaUptrend && rsiLong && trend15mBull && volumeOk && atrOk) {
    signal = "LONG";
    reason = `LONG | VWAP bull | EMA1m bull | EMA15m bull | RSI14=${rsi14.toFixed(1)} | vol=$${(currentVolume/1000).toFixed(0)}K | ATR=${atrPct.toFixed(3)}%`;
  } else if (bearishBias && emaDowntrend && rsiShort && trend15mBear && volumeOk && atrOk) {
    signal = "SHORT";
    reason = `SHORT | VWAP bear | EMA1m bear | EMA15m bear | RSI14=${rsi14.toFixed(1)} | vol=$${(currentVolume/1000).toFixed(0)}K | ATR=${atrPct.toFixed(3)}%`;
  } else {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    reason = "NEUTRO | " + failed.join(" | ");
  }

  return { results, allPass, signal, reason };
}

// ── Trade Limits ─────────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`⊘ Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`);
    return false;
  }

  const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);

  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(`⊘ Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`);
    return false;
  }

  console.log(`✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} – within limit`);
  console.log(`✅ Trade size: $${tradeSize.toFixed(2)} – within max $${CONFIG.maxTradeSizeUSD}`);

  return true;
}

// ── BitGet Execution ─────────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto.createHmac("sha256", CONFIG.bitget.secretKey).update(message).digest("base64");
}

async function placeBitGetOrder(symbol, side, sizeUSD, price) {
  const quantity = (sizeUSD / price).toFixed(6);
  const timestamp = Date.now().toString();
  const path = CONFIG.tradeMode === "spot"
    ? "/api/v2/spot/trade/placeOrder"
    : "/api/v2/mix/order/placeOrder";

  const body = JSON.stringify({
    symbol, side, orderType: "market", quantity,
    ...(CONFIG.tradeMode === "futures" && {
      productType: "USDT-FUTURES", marginMode: "isolated", marginCoin: "USDT",
    }),
  });

  const signature = signBitGet(timestamp, "POST", path, body);
  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") throw new Error(`BitGet order failed: ${data.msg}`);
  return data.data;
}

// ── CSV Logging ──────────────────────────────────────────────────────────────────

const CSV_HEADERS = [
  "Date","Time (UTC)","Exchange","Symbol","Side",
  "Quantity","Price","Total USD","Fee (est.)","Net Amount",
  "Order ID","Mode","Notes",
].join(",");

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
    console.log(`📋 Created ${CSV_FILE} – open in Google Sheets or Excel to track trades.`);
  }
}

function writeTradeCsv(logEntry) {
  const now  = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);
  let side="",quantity="",totalUSD="",fee="",netAmount="",orderId="",mode="",notes="";

  if (!logEntry.allPass) {
    const failed = (logEntry.conditions||[]).filter((c)=>!c.pass).map((c)=>c.label).join("; ");
    mode="BLOCKED"; orderId="BLOCKED"; notes=`Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side      = logEntry.signal === "SHORT" ? "SELL" : "BUY";
    quantity  = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD  = logEntry.tradeSize.toFixed(2);
    fee       = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId   = logEntry.orderId || "";
    mode      = "PAPER";
    notes     = `ENTRY ${logEntry.signal||"BUY"} | tp=${logEntry.takeProfitPrice?logEntry.takeProfitPrice.toFixed(2):""} sl=${logEntry.stopLossPrice?logEntry.stopLossPrice.toFixed(2):""}`;
  } else {
    side      = logEntry.signal === "SHORT" ? "SELL" : "BUY";
    quantity  = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD  = logEntry.tradeSize.toFixed(2);
    fee       = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId   = logEntry.orderId || "";
    mode      = "LIVE";
    notes     = logEntry.error ? `Error: ${logEntry.error}` : `ENTRY ${logEntry.signal||"BUY"} | tp=${logEntry.takeProfitPrice?logEntry.takeProfitPrice.toFixed(2):""} sl=${logEntry.stopLossPrice?logEntry.stopLossPrice.toFixed(2):""}`;
  }

  const row = [date,time,"BitGet",logEntry.symbol,side,quantity,
    logEntry.price.toFixed(2),totalUSD,fee,netAmount,orderId,mode,notes].join(",");
  appendFileSync(CSV_FILE, row + "\n");
}

function writeExitCsv(position, exitPrice, exitReason, paperTrading) {
  const now      = new Date();
  const date     = now.toISOString().slice(0, 10);
  const time     = now.toISOString().slice(11, 19);
  const pnlPct   = calcPnlPct(position.direction, position.entryPrice, exitPrice);
  const pnlUSD   = (pnlPct / 100 * position.sizeUSD).toFixed(2);
  const closeSide = position.direction === "LONG" ? "SELL" : "BUY";
  const quantity  = (position.sizeUSD / exitPrice).toFixed(6);
  const mode      = paperTrading ? "PAPER" : "LIVE";
  const sign      = pnlPct >= 0 ? "+" : "";

  const row = [
    date, time, "BitGet", CONFIG.symbol,
    closeSide, quantity, exitPrice.toFixed(2),
    position.sizeUSD.toFixed(2), "0", pnlUSD,
    `EXIT-${exitReason}`, mode,
    `EXIT ${position.direction} | entry=${position.entryPrice.toFixed(2)} exit=${exitPrice.toFixed(2)} pnl=${sign}${pnlPct.toFixed(2)}% motivo=${exitReason}`,
  ].join(",");

  appendFileSync(CSV_FILE, row + "\n");
  const emoji = pnlPct >= 0 ? "✅ WIN" : "❌ LOSS";
  console.log(`\n[SAIDA] ${emoji} | ${position.direction} | PnL: ${sign}${pnlPct.toFixed(2)}% ($${pnlUSD}) | Motivo: ${exitReason}`);
}

// ── Tax Summary ──────────────────────────────────────────────────────────────────

function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) { console.log("No trades.csv found."); return; }
  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows  = lines.slice(1).map((l) => l.split(","));
  const live    = rows.filter((r) => r[11] === "LIVE");
  const paper   = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");
  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees   = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);
  console.log("\n── Tax Summary ──────────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("────────────────────────────────────────────────────────────\n");
}

// ── Enter Position ───────────────────────────────────────────────────────────────

async function enterPosition(signal, price, tpPct, slPct, log) {
  const sizeUSD = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);

  const tpPrice = signal === "LONG"
    ? price * (1 + tpPct)
    : price * (1 - tpPct);
  const slPrice = signal === "LONG"
    ? price * (1 - slPct)
    : price * (1 + slPct);

  console.log(`\n[ENTRANDO ${signal}]`);
  console.log(`  Preco: $${price.toFixed(2)} | TP: $${tpPrice.toFixed(2)} | SL: $${slPrice.toFixed(2)}`);
  console.log(`  Tamanho: $${sizeUSD.toFixed(2)} | TP: ${(tpPct*100).toFixed(1)}% | SL: ${(slPct*100).toFixed(1)}%`);

  let orderId = null;

  if (CONFIG.paperTrading) {
    orderId = `PAPER-${Date.now()}`;
    console.log(`  PAPER TRADE – ${signal} ${CONFIG.symbol} ~$${sizeUSD.toFixed(2)} at market`);
    console.log(`  (Set PAPER_TRADING=false in .env to place real orders)`);
  } else {
    const side = signal === "LONG" ? "buy" : "sell";
    try {
      const order = await placeBitGetOrder(CONFIG.symbol, side, sizeUSD, price);
      orderId = order.orderId;
      console.log(`  ORDER PLACED – ${orderId}`);
    } catch (err) {
      console.log(`  ORDER FAILED – ${err.message}`);
      return;
    }
  }

  // Save open position
  savePosition({
    open: true,
    direction: signal,
    entryPrice: price,
    entryTime: new Date().toISOString(),
    sizeUSD,
    takeProfitPrice: tpPrice,
    stopLossPrice: slPrice,
    orderId,
  });

  // Log entry to CSV and JSON
  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    price,
    signal,
    indicators: {},
    conditions: [],
    allPass: true,
    tradeSize: sizeUSD,
    orderPlaced: true,
    orderId,
    paperTrading: CONFIG.paperTrading,
    takeProfitPrice: tpPrice,
    stopLossPrice: slPrice,
    limits: {},
  };
  log.trades.push(logEntry);
  saveLog(log);
  writeTradeCsv(logEntry);
}

// ── Main ──────────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();

  // Load TP/SL params from rules.json (Claude optimizes these)
  let rules = {};
  if (existsSync("rules.json")) {
    try { rules = JSON.parse(readFileSync("rules.json", "utf8")); } catch {}
  }
  const tpPct = rules.take_profit_pct || 0.01;   // 1% default
  const slPct = rules.stop_loss_pct  || 0.005;   // 0.5% default

  const log = loadLog();

  console.log("================================================");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "PAPER TRADING" : "LIVE TRADING"}`);
  console.log("================================================");

  // Load strategy
  console.log(`\nStrategy: ${rules.strategy?.name || "Default"}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);
  console.log(`TP: ${(tpPct*100).toFixed(1)}% | SL: ${(slPct*100).toFixed(1)}%`);

  // Fetch candle data (3m primary + 15m trend filter) + TradingView consensus
  console.log("\n── Fetching market data ─────────────────────────────────────\n");
  const [candles, candles15m, tvSignal] = await Promise.all([
    fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500),
    fetchCandles(CONFIG.symbol, "15m", 100),
    fetchTVAnalysis(CONFIG.symbol, CONFIG.timeframe),
  ]);
  const closes    = candles.map((c) => c.close);
  const closes15m = candles15m.map((c) => c.close);
  const price     = closes[closes.length - 1];

  // Calculate indicators
  const ema8        = calcEMA(closes, 8);
  const ema21       = calcEMA(closes, 21);
  const ema8_15m    = calcEMA(closes15m, 8);
  const ema21_15m   = calcEMA(closes15m, 21);
  const vwap        = calcVWAP(candles);
  const rsi3        = calcRSI(closes, 3);
  const rsi14       = calcRSI(closes);
  const avgVolume   = calcVolumeAvg(candles, 20);
  const curVolume   = candles[candles.length - 1].volume;
  const atr         = calcATR(candles, 14);

  const trend15m = ema8_15m > ema21_15m ? "ALTA" : "BAIXA";

  console.log(`  Current price: $${price.toFixed(2)}`);
  console.log(`  EMA(8):       ${ema8.toFixed(2)}`);
  console.log(`  EMA(21):      ${ema21.toFixed(2)}`);
  console.log(`  VWAP:         ${vwap ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(14):      ${rsi14 ? rsi14.toFixed(2) : "N/A"}`);
  console.log(`  Tendencia 15m: ${trend15m} (EMA8=${ema8_15m.toFixed(2)} EMA21=${ema21_15m.toFixed(2)})`);
  const fmtVol = (v) => v >= 1e6 ? `$${(v/1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v/1e3).toFixed(1)}K` : `$${v.toFixed(0)}`;
  console.log(`  Volume atual (USDT): ${fmtVol(curVolume)} | Media 20c: ${fmtVol(avgVolume)}`);
  console.log(`  ATR(14):      ${atr ? `$${atr.toFixed(1)} (${((atr/price)*100).toFixed(3)}%)` : 'N/A'}`);
  console.log(`  TradingView:  ${tvSignal}`);

  if (vwap === null || vwap === undefined || rsi14 === null || rsi14 === undefined) {
    console.log("\n⚠  Not enough data to calculate indicators. Exiting.");
    return;
  }

  // Run safety check
  const { results, allPass, signal, reason } = runSafetyCheck(
    price, ema8, ema21, vwap, rsi14, ema8_15m, ema21_15m, curVolume, avgVolume, atr
  );

  console.log("\n── Decision ─────────────────────────────────────────────────\n");
  // Soft filter: log quando TV discorda (não bloqueia, mas avisa)
  const tvConflict =
    (signal === "LONG"  && (tvSignal === "STRONG_SELL" || tvSignal === "SELL")) ||
    (signal === "SHORT" && (tvSignal === "STRONG_BUY"  || tvSignal === "BUY"));
  if (tvConflict) {
    console.log(`  ⚠️  TradingView consensus (${tvSignal}) diverge do sinal ${signal} — cautela extra`);
  }
  console.log(`  Signal: ${signal} | ${reason}`);

  // ── Check open position first ──────────────────────────────────────────────
  const position = loadPosition();

  if (position.open) {
    const pnlPct = calcPnlPct(position.direction, position.entryPrice, price);
    const sign   = pnlPct >= 0 ? "+" : "";
    console.log(`\n[POSICAO ABERTA] ${position.direction} @ $${position.entryPrice.toFixed(2)}`);
    console.log(`  TP: $${position.takeProfitPrice.toFixed(2)} | SL: $${position.stopLossPrice.toFixed(2)}`);
    console.log(`  Preco atual: $${price.toFixed(2)} | PnL flutuante: ${sign}${pnlPct.toFixed(2)}%`);

    let exitReason = null;
    let exitPrice  = price;

    // Check TP
    if (position.direction === "LONG"  && price >= position.takeProfitPrice) {
      exitReason = "TP_HIT"; exitPrice = position.takeProfitPrice;
    } else if (position.direction === "SHORT" && price <= position.takeProfitPrice) {
      exitReason = "TP_HIT"; exitPrice = position.takeProfitPrice;
    }
    // Check SL
    else if (position.direction === "LONG"  && price <= position.stopLossPrice) {
      exitReason = "SL_HIT"; exitPrice = position.stopLossPrice;
    } else if (position.direction === "SHORT" && price >= position.stopLossPrice) {
      exitReason = "SL_HIT"; exitPrice = position.stopLossPrice;
    }
    if (exitReason) {
      // Close the position
      if (!CONFIG.paperTrading) {
        const closeSide = position.direction === "LONG" ? "sell" : "buy";
        try {
          await placeBitGetOrder(CONFIG.symbol, closeSide, position.sizeUSD, exitPrice);
        } catch (e) {
          console.error("Error closing position:", e.message);
        }
      }
      writeExitCsv(position, exitPrice, exitReason, CONFIG.paperTrading);
      clearPosition(exitReason);
    } else {
      console.log(`\n  Posicao mantida. Aguardando TP/SL.`);
    }

  } else {
    // ── No open position: look for entry ──────────────────────────────────────

    // v4.4: cooldown após SL — aguarda 20 minutos antes de nova entrada
    const savedPos = loadPosition();
    if (savedPos.slCooldownUntil && Date.now() < savedPos.slCooldownUntil) {
      const remainingMin = Math.ceil((savedPos.slCooldownUntil - Date.now()) / 60000);
      console.log(`\n⏳ COOLDOWN POS-SL: aguardando ${remainingMin}min antes de nova entrada (proteção anti-chop)`);
      console.log("\n================================================\n");
      return;
    }

    const withinLimits = checkTradeLimits(log);
    if (!withinLimits) return;

    if (!allPass) {
      const failed = results.filter((r) => !r.pass).map((r) => r.label);
      console.log(`\n⊘ TRADE BLOQUEADO`);
      console.log(`  Failed conditions:`);
      failed.forEach((f) => console.log(`    - ${f}`));

      // Log blocked analysis
      const logEntry = {
        timestamp: new Date().toISOString(),
        symbol: CONFIG.symbol, timeframe: CONFIG.timeframe, price, signal,
        tvSignal,
        indicators: { ema8, vwap, rsi14: rsi3 }, conditions: results,
        allPass, tradeSize: Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD),
        orderPlaced: false, orderId: null, paperTrading: CONFIG.paperTrading,
        limits: { maxTradeSizeUSD: CONFIG.maxTradeSizeUSD, maxTradesPerDay: CONFIG.maxTradesPerDay, tradesToday: countTodaysTrades(log) },
      };
      log.trades.push(logEntry);
      saveLog(log);
      writeTradeCsv(logEntry);

    } else if (signal === "LONG" || signal === "SHORT") {
      console.log(`\n✅ TODAS CONDICOES ATENDIDAS – Entrando ${signal}`);
      // Aviso se TV diverge — não impede a entrada (estratégia principal domina)
      if (tvConflict) console.log(`  ⚠️  Nota: TradingView consensus=${tvSignal} mas entrando com base na estratégia v4`);
      await enterPosition(signal, price, tpPct, slPct, log);

    } else {
      console.log(`\n  Sinal NEUTRAL – aguardando oportunidade.`);
      const logEntry = {
        timestamp: new Date().toISOString(),
        symbol: CONFIG.symbol, timeframe: CONFIG.timeframe, price, signal,
        tvSignal,
        indicators: { ema8, vwap, rsi14: rsi3 }, conditions: results,
        allPass: false, tradeSize: Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD),
        orderPlaced: false, orderId: null, paperTrading: CONFIG.paperTrading, limits: {},
      };
      log.trades.push(logEntry);
      saveLog(log);
      writeTradeCsv(logEntry);
    }
  }

  console.log("\n================================================\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  const INTERVAL_MS = 1 * 60 * 1000; // 1 minuto

  // ── Status HTTP server (Railway expõe automaticamente) ───────────────────────
  import("http").then(({ default: http }) => {
    const PORT = process.env.PORT || 3000;
    http.createServer((req, res) => {
      if (req.url === "/trades") {
        try {
          const data = existsSync(CSV_FILE) ? readFileSync(CSV_FILE, "utf8") : "no trades yet";
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(data);
        } catch (e) {
          res.writeHead(500); res.end(e.message);
        }
      } else if (req.url === "/status") {
        const pos = loadPosition();
        const log = loadLog();
        const entries = log.trades || [];
        const paper  = entries.filter(t => t.orderPlaced && t.paperTrading);
        const blocked = entries.filter(t => !t.orderPlaced);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          version: "v3",
          uptime: process.uptime(),
          position: pos,
          totalAnalyses: entries.length,
          tradesEntered: paper.length,
          blocked: blocked.length,
          lastAnalysis: entries[entries.length - 1]?.timestamp || null,
        }, null, 2));
      } else {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("trading-bot v3 online\nEndpoints: /trades /status");
      }
    }).listen(PORT, () => console.log(`📡 Status server on :${PORT}`));
  });

  async function mainLoop() {
    while (true) {
      const start = Date.now();
      try {
        await run();
      } catch (err) {
        console.error("Bot error:", err.message);
      }
      const elapsed = Date.now() - start;
      const wait = Math.max(0, INTERVAL_MS - elapsed);
      console.log(`\n⏱  Proxima analise em ${Math.round(wait/1000)}s\n`);
      await new Promise(r => setTimeout(r, wait));
    }
  }

  mainLoop();
}
