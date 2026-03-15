const https = require('https');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');

// ============================================================
// 1. 配置区 (环境变量读取)
// ============================================================
const BINANCE_API_KEY = process.env.BINANCE_API_KEY || 'yfVasX0Ajqeb8IrauKvr6Le3jjW2ZoYvcWehSqXP1T5QCymmDZAmWVJUYdDVkmgX';
const BINANCE_SECRET = process.env.BINANCE_SECRET || 'kTS00yZ1TIfHHcWqTvZXd3e7D5PVaCrXIvshCK2bsZ110z7PzMxysUVA074zzBjG';

const SYMBOL = "ETHUSDT";
const CHECK_INTERVAL_MS = 30 * 1000;    
const SIGNAL_COOLDOWN_MS = 15 * 60 * 1000; 

// ============================================================
// 2. 全局状态 (增加了可被控制的开关)
// ============================================================
let PAPER_TRADING = true;  // 此变量现在可由前端切换
let monitorEnabled = true;
let lastSignalTime = 0;
let lastSignalType = null;
let lastPrice = null;
let currentPosition = null;
let dailyPnL = 0;
let tradeHistory = [];

// ============================================================
// 3. WebSocket 实时行情
// ============================================================
function initPriceSocket() {
    const wsUrl = `wss://fstream.binance.com/ws/${SYMBOL.toLowerCase()}@markPrice`;
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => console.log(`[WS] 实时价格流已连接`));
    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.p) { lastPrice = parseFloat(msg.p); }
    });
    ws.on('close', () => setTimeout(initPriceSocket, 5000));
}
initPriceSocket();

// ============================================================
// 4. 技术指标逻辑 (MA, RSI, ATR)
// ============================================================
function calcMA(data, p) { if (data.length < p) return null; return data.slice(-p).reduce((s,c) => s + c.close, 0) / p; }
function calcRSI(data, p = 14) {
    if (data.length < p + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = data.length - p; i < data.length; i++) {
        const diff = data[i].close - data[i - 1].close;
        if (diff > 0) gains += diff; else losses -= diff;
    }
    return losses === 0 ? 100 : 100 - (100 / (1 + (gains / p) / (losses / p)));
}
function calcATR(data, p = 14) {
    if (data.length < p + 1) return 5;
    let trSum = 0; const slice = data.slice(-p);
    for (let i = 1; i < slice.length; i++) {
        trSum += Math.max(slice[i].high - slice[i].low, Math.abs(slice[i].high - slice[i-1].close), Math.abs(slice[i].low - slice[i-1].close));
    }
    return trSum / p;
}

// ============================================================
// 5. 核心交易逻辑
// ============================================================
function detectSignal(data) {
    if (!data || data.length < 22) return null;
    const last = data.length - 1;
    const ma5 = calcMA(data, 5), ma10 = calcMA(data, 10), ma20 = calcMA(data, 20);
    const ma5p = calcMA(data.slice(0, -1), 5), ma10p = calcMA(data.slice(0, -1), 10);
    const rsi = calcRSI(data);
    const bull = ma5 > ma10 && ma10 > ma20 && ma5p <= ma10p && rsi < 70;
    const bear = ma5 < ma10 && ma10 < ma20 && ma5p >= ma10p && rsi > 30;
    if (bull) return { type: 'LONG', label: '做多', rsi, atr: calcATR(data) };
    if (bear) return { type: 'SHORT', label: '做空', rsi, atr: calcATR(data) };
    return null;
}

function calcTPSL(data, type) {
    const entryPrice = lastPrice || data[data.length - 1].close;
    const atr = calcATR(data);
    return type === 'LONG' 
        ? { tp: entryPrice + (atr * 3), sl: entryPrice - (atr * 1.5) }
        : { tp: entryPrice - (atr * 3), sl: entryPrice + (atr * 1.5) };
}

async function checkPosition() {
    if (!currentPosition) return;
    const price = lastPrice;
    const pos = currentPosition;
    let reason = null;
    if (pos.type === 'LONG') {
        if (price >= pos.tpsl.tp) reason = "止盈平仓";
        else if (price <= pos.tpsl.sl) reason = "止损割肉";
    } else {
        if (price <= pos.tpsl.tp) reason = "止盈平仓";
        else if (price >= pos.tpsl.sl) reason = "止损割肉";
    }
    if (reason) {
        const pnl = pos.type === 'LONG' ? (price - pos.entryPrice) * pos.qty : (pos.entryPrice - price) * pos.qty;
        dailyPnL += pnl;
        console.log(`🏁 【${reason}】盈亏: ${pnl.toFixed(2)}U`);
        tradeHistory.push({ ...pos, exitPrice: price, pnl, reason, endTime: new Date() });
        currentPosition = null;
        lastSignalTime = Date.now();
    }
}

async function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'ETH-Bot/3.0' } }, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        }).on('error', reject);
    });
}

async function checkSignal() {
    if (!monitorEnabled || (Date.now() - lastSignalTime < SIGNAL_COOLDOWN_MS)) return;
    try {
        const data = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL}&interval=1m&limit=100`);
        if (!Array.isArray(data)) return;
        const candles = data.map(d => ({ close: parseFloat(d[4]), high: parseFloat(d[2]), low: parseFloat(d[3]) }));
        if (currentPosition) { await checkPosition(); return; }
        const sig = detectSignal(candles);
        if (sig && sig.type !== lastSignalType) {
            const tpsl = calcTPSL(candles, sig.type);
            const qty = (100 * 10) / lastPrice; // 模拟100U 10倍杠杆
            currentPosition = { type: sig.type, entryPrice: lastPrice, qty, tpsl, startTime: new Date() };
            console.log(`🚀 【开仓】${sig.label} 价格: ${lastPrice}`);
            lastSignalType = sig.type;
        }
    } catch (e) { console.log("循环报错:", e.message); }
}

// ============================================================
// 6. HTTP 服务 (增加跨域 CORS 和 指令接收)
// ============================================================
const server = http.createServer((req, res) => {
    // 允许前端 Vercel 访问
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // 状态接口 (Vercel 面板读取这里)
    if (req.url === '/status' || req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            bot: "Active",
            price: lastPrice,
            position: currentPosition || "None",
            today_pnl: dailyPnL.toFixed(2),
            trades: tradeHistory.length,
            paperTrading: PAPER_TRADING
        }));
    }

    // 切换接口 (Vercel 开关控制这里)
    if (req.method === 'POST' && (req.url === '/api/toggle-paper' || req.url === '/api/settings')) {
        PAPER_TRADING = !PAPER_TRADING;
        console.log(`⚠️ 模式已切换为: ${PAPER_TRADING ? '模拟' : '实盘'}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, paperTrading: PAPER_TRADING }));
    }

    res.writeHead(200); res.end("ETH Trader Brain is Online");
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    setInterval(checkSignal, CHECK_INTERVAL_MS);
});
