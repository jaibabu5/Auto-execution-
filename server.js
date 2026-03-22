// institutional_execution_bot.js
// UPDATED vPRO 1.2 – Daily loss REMOVED | Full Telegram command suite

const axios = require('axios');
const { MongoClient } = require('mongodb');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
require('dotenv').config();

const BINANCE_API = 'https://fapi.binance.com'; // ← change to testnet for testing
const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MONGO_URI = process.env.MONGO_URI;

const client = new MongoClient(MONGO_URI);
const dbName = 'institutional_trading';

let isPaused = false;
const activeTrades = new Map();           // ← ONLY 1 trade allowed
const MAX_CONCURRENT = 1;
const RISK_PERCENT = 0.70;
const LEVERAGE = 3;

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// ──────────────────────────────────────────────
// SIGNED BINANCE REQUEST (rate-limit safe)
function getSignature(query) {
  return crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
}

async function binanceSigned(method, endpoint, params = {}) {
  const timestamp = Date.now();
  const queryString = new URLSearchParams({ ...params, timestamp }).toString();
  const signature = getSignature(queryString);
  const url = `\( {BINANCE_API} \){endpoint}?\( {queryString}&signature= \){signature}`;

  const { data } = await axios({ method, url, headers: { 'X-MBX-APIKEY': API_KEY } });
  await new Promise(r => setTimeout(r, 80));
  return data;
}

async function getUSDTBalance() {
  const data = await binanceSigned('GET', '/fapi/v2/balance');
  return parseFloat(data.find(a => a.asset === 'USDT').availableBalance);
}

async function getAccountInsights() {
  const acc = await binanceSigned('GET', '/fapi/v2/account');
  return {
    totalWallet: parseFloat(acc.totalWalletBalance),
    totalUnrealizedPnL: parseFloat(acc.totalUnrealizedProfit),
    availableBalance: parseFloat(acc.availableBalance),
    usedMargin: parseFloat(acc.totalMarginBalance) - parseFloat(acc.availableBalance),
    equity: parseFloat(acc.totalMarginBalance)
  };
}

async function setupSymbol(symbol) {
  await binanceSigned('POST', '/fapi/v1/leverage', { symbol, leverage: LEVERAGE });
  await binanceSigned('POST', '/fapi/v1/marginType', { symbol, marginType: 'ISOLATED' });
}

async function getQuantity(symbol, entryPrice) {
  const balance = await getUSDTBalance();
  let margin = balance * RISK_PERCENT;
  let qty = (margin * LEVERAGE) / entryPrice;

  const info = await axios.get(`${BINANCE_API}/fapi/v1/exchangeInfo`);
  const filter = info.data.symbols.find(s => s.symbol === symbol).filters.find(f => f.filterType === 'LOT_SIZE');
  const stepSize = parseFloat(filter.stepSize);
  qty = Math.floor(qty / stepSize) * stepSize;
  return Math.max(qty, parseFloat(filter.minQty));
}

async function placeOrder(symbol, side, type, qty, stopPrice = null) {
  const params = {
    symbol, side, type, quantity: qty.toFixed(4),
    workingType: 'MARK_PRICE',
    reduceOnly: true,
    closePosition: true
  };
  if (stopPrice) params.stopPrice = stopPrice.toFixed(4);
  return await binanceSigned('POST', '/fapi/v1/order', params);
}

async function sendProTelegram(title, symbol, details = {}) {
  let msg = `🚨 *\( {title}*\n\n* \){symbol}*\n`;
  Object.entries(details).forEach(([k, v]) => msg += `• ${k}: ${v}\n`);
  await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' });
}

// ──────────────────────────────────────────────
// EXECUTION ENGINE
async function executeSignal(signal) {
  if (isPaused || activeTrades.size >= MAX_CONCURRENT) {
    await sendProTelegram('TRADE SKIPPED', signal.symbol, { Reason: activeTrades.size ? 'One trade already active' : 'Bot paused' });
    return;
  }

  const { symbol, direction, entryPrice, stopLoss, takeProfit } = signal;
  const side = direction === 'long' ? 'BUY' : 'SELL';

  try {
    await setupSymbol(symbol);
    const quantity = await getQuantity(symbol, entryPrice);

    await sendProTelegram('EXECUTING', symbol, {
      Direction: direction.toUpperCase(),
      'Risk Used': (quantity * entryPrice / LEVERAGE).toFixed(0) + ' USDT',
      Leverage: '3x'
    });

    // MARKET ENTRY (retry 3x)
    let entryOrder;
    for (let i = 0; i < 3; i++) {
      try {
        entryOrder = await placeOrder(symbol, side, 'MARKET', quantity);
        break;
      } catch (e) {
        if (i === 2) throw e;
        await new Promise(r => setTimeout(r, 1200 * (i + 1)));
      }
    }

    const actualEntry = parseFloat(entryOrder.avgPrice || entryPrice);

    // Place FULL TP + SL on exchange (100% close)
    await placeOrder(symbol, side === 'BUY' ? 'SELL' : 'BUY', 'STOP_MARKET', quantity, stopLoss);
    await placeOrder(symbol, side === 'BUY' ? 'SELL' : 'BUY', 'TAKE_PROFIT_MARKET', quantity, takeProfit);

    await client.db(dbName).collection('signals').updateOne(
      { _id: signal._id },
      { $set: { status: 'executed', actualEntryPrice: actualEntry, quantity, executedAt: new Date() } }
    );

    activeTrades.set(symbol, { ...signal, quantity, actualEntryPrice: actualEntry });

    await sendProTelegram('POSITION OPENED ✅ (100% TP)', symbol, {
      Entry: actualEntry,
      SL: stopLoss,
      'Full TP': takeProfit,
      Quantity: quantity
    });

  } catch (err) {
    await sendProTelegram('EXECUTION FAILED ❌', symbol, { Error: err.message });
  }
}

// ──────────────────────────────────────────────
// MONITOR FOR FULL TP / SL HIT (every 10s)
async function monitorPositions() {
  for (const [symbol, trade] of activeTrades) {
    try {
      const positions = await binanceSigned('GET', '/fapi/v2/positionRisk', { symbol });
      const pos = positions.find(p => p.symbol === symbol);

      if (!pos || Math.abs(parseFloat(pos.positionAmt)) < 0.0001) {
        const currentPrice = await getCurrentPrice(symbol);
        let hitType = 'SL';
        let pnl = ((currentPrice - trade.actualEntryPrice) / trade.actualEntryPrice * 100 * LEVERAGE).toFixed(2);

        if ((trade.direction === 'long' && currentPrice >= trade.takeProfit) ||
            (trade.direction === 'short' && currentPrice <= trade.takeProfit)) {
          hitType = 'FULL TP HIT - 100% CLOSED';
        }

        await sendProTelegram(hitType, symbol, {
          Exit: currentPrice,
          'P&L': pnl + '% (3x leveraged)',
          Status: 'Closed'
        });

        await client.db(dbName).collection('signals').updateOne(
          { symbol, status: 'executed' },
          { $set: { status: hitType.includes('TP') ? 'tp_hit' : 'sl_hit', closedAt: new Date(), pnlPercent: parseFloat(pnl), hitPrice: currentPrice } }
        );

        activeTrades.delete(symbol);
      }
    } catch (e) {}
  }
}

async function getCurrentPrice(symbol) {
  const { data } = await axios.get(`\( {BINANCE_API}/fapi/v1/ticker/price?symbol= \){symbol}`);
  return parseFloat(data.price);
}

// ──────────────────────────────────────────────
// TELEGRAM COMMANDS (professional suite)
bot.onText(/\/start|\/resume/, () => {
  isPaused = false;
  bot.sendMessage(TELEGRAM_CHAT_ID, '▶️ **Bot STARTED / RESUMED** – Ready for new signals', { parse_mode: 'Markdown' });
});

bot.onText(/\/stop|\/pause/, () => {
  isPaused = true;
  bot.sendMessage(TELEGRAM_CHAT_ID, '🛑 **Bot STOPPED / PAUSED** – No new trades', { parse_mode: 'Markdown' });
});

bot.onText(/\/status/, async () => {
  const balance = await getUSDTBalance();
  bot.sendMessage(TELEGRAM_CHAT_ID,
    `*Status:* ${isPaused ? '⏸️ PAUSED' : '▶️ RUNNING'}\n` +
    `*Balance:* \[ {balance.toFixed(2)}\n` +
    `*Active Trades:* ${activeTrades.size}/1`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/dashboard/, async () => {
  const collection = client.db(dbName).collection('signals');
  const all = await collection.find().sort({ timestamp: -1 }).limit(500).toArray();
  const open = all.filter(s => s.status === 'open' || s.status === 'executed').length;
  const tp = all.filter(s => s.status === 'tp_hit').length;
  const sl = all.filter(s => s.status === 'sl_hit').length;
  const closed = tp + sl;
  const winRate = closed ? ((tp / closed) * 100).toFixed(1) : '0';
  const insights = await getAccountInsights();

  let msg = `📊 *INSTITUTIONAL DASHBOARD vPRO 1.2*\n\n` +
            `*Balance:* \]{insights.totalWallet.toFixed(2)}\n` +
            `*Equity:* \[ {insights.equity.toFixed(2)} (+${insights.totalUnrealizedPnL.toFixed(2)} PnL)\n` +
            `*Available:* \]{insights.availableBalance.toFixed(2)}\n` +
            `*Used Margin:* \[ {insights.usedMargin.toFixed(2)}\n\n` +
            `*Signals:* Total ${all.length} | Open ${open} | Closed ${closed}\n` +
            `*Win Rate:* \( {winRate}% ( \){tp} TP • ${sl} SL)\n` +
            `*Active Trades:* ${activeTrades.size}/1`;

  bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' });
});

bot.onText(/\/balance/, async () => {
  const insights = await getAccountInsights();
  bot.sendMessage(TELEGRAM_CHAT_ID,
    `*💰 ACCOUNT INSIGHTS*\n\n` +
    `• Total Wallet: \]{insights.totalWallet.toFixed(2)}\n` +
    `• Equity: \[ {insights.equity.toFixed(2)}\n` +
    `• Unrealized PnL: ${insights.totalUnrealizedPnL > 0 ? '+' : ''} \]{insights.totalUnrealizedPnL.toFixed(2)}\n` +
    `• Available Margin: \[ {insights.availableBalance.toFixed(2)}\n` +
    `• Used Margin: \]{insights.usedMargin.toFixed(2)}\n` +
    `• Risk Capacity (70%): $${(insights.availableBalance * 0.70).toFixed(0)}`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/positions/, async () => {
  if (!activeTrades.size) return bot.sendMessage(TELEGRAM_CHAT_ID, '📭 No active position');
  let text = '📍 *ACTIVE TRADE*\n\n';
  for (const [s, t] of activeTrades) {
    text += `*${s}* ${t.direction.toUpperCase()} @ ${t.actualEntryPrice}\nTP: ${t.takeProfit} | SL: ${t.stopLoss}\nQty: ${t.quantity}\n`;
  }
  bot.sendMessage(TELEGRAM_CHAT_ID, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/history/, async () => {
  const collection = client.db(dbName).collection('signals');
  const closed = await collection.find({ status: { $in: ['tp_hit', 'sl_hit'] } }).sort({ closedAt: -1 }).limit(5).toArray();
  let msg = '📜 *LAST 5 CLOSED TRADES*\n\n';
  closed.forEach(t => {
    msg += `*${t.symbol}* ${t.direction.toUpperCase()} → ${t.status.toUpperCase()} | P&L: ${t.pnlPercent || '—'}%\n`;
  });
  bot.sendMessage(TELEGRAM_CHAT_ID, msg || 'No closed trades yet', { parse_mode: 'Markdown' });
});

bot.onText(/\/close (.+)/, async (_, match) => {
  const symbol = match[1].toUpperCase();
  if (activeTrades.has(symbol)) {
    const trade = activeTrades.get(symbol);
    const side = trade.direction === 'long' ? 'SELL' : 'BUY';
    await placeOrder(symbol, side, 'MARKET', trade.quantity);
    activeTrades.delete(symbol);
    await sendProTelegram('MANUAL CLOSE', symbol, { Reason: 'Telegram command' });
  }
});

bot.onText(/\/closeall/, async () => {
  for (const [symbol, trade] of activeTrades) {
    const side = trade.direction === 'long' ? 'SELL' : 'BUY';
    await placeOrder(symbol, side, 'MARKET', trade.quantity);
  }
  activeTrades.clear();
  await sendProTelegram('EMERGENCY CLOSEALL', 'ALL', { Status: 'All positions closed' });
});

bot.onText(/\/help/, () => {
  bot.sendMessage(TELEGRAM_CHAT_ID,
    `*📋 COMMAND LIST*\n\n` +
    `/start or /resume → Start bot\n` +
    `/stop or /pause → Stop bot\n` +
    `/status → Quick status\n` +
    `/dashboard → Full stats + winrate\n` +
    `/balance → Account insights\n` +
    `/positions → Active trade\n` +
    `/history → Last 5 trades\n` +
    `/close SYMBOL → Close specific\n` +
    `/closeall → Close everything\n` +
    `/help → This menu`,
    { parse_mode: 'Markdown' }
  );
});

// ──────────────────────────────────────────────
// START
(async () => {
  await client.connect();

  const collection = client.db(dbName).collection('signals');
  const changeStream = collection.watch([{ $match: { operationType: 'insert', 'fullDocument.status': 'open' } }]);

  changeStream.on('change', async (change) => {
    if (change.fullDocument) await executeSignal(change.fullDocument);
  });

  setInterval(monitorPositions, 10000);

  console.log('🚀 EXECUTION BOT vPRO 1.2 LIVE – Daily loss removed | Full Telegram control');
  bot.sendMessage(TELEGRAM_CHAT_ID, '✅ *vPRO 1.2 READY*\nDaily loss protection removed\nType /help for commands', { parse_mode: 'Markdown' });
})();
