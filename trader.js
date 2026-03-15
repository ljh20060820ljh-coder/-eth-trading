const https = require('https');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');

// ============================================================
// 1. 配置区 (优先读取 Render 环境变量)
// ============================================================
const BINANCE_API_KEY = process.env.BINANCE_API_KEY || 'yfVasX0Ajqeb8IrauKvr6Le3jjW2ZoYvcWehSqXP1T5QCymmDZAmWVJUYdDVkmgX';
const BINANCE_SECRET = process.env.BINANCE_SECRET || 'kTS00yZ1TIfHHcWqTvZXd3e7D5PVaCrXIvshCK2bsZ110z7PzMxysUVA074zzBjG';

const SYMBOL = "ETHUSDT";
const CHECK_INTERVAL_MS = 30 * 1000;    // 30秒检测一次K线信号
const SIGNAL_COOLDOWN_MS = 15 * 60 * 1000; // 交易后冷却15分钟

// ============================================================
// 2. 全局状态
// ============================================================
let PAPER_TRADING = true; 
let monitorEnabled = true;
let lastSignalTime = 0;
let lastSignalType = null;
let lastPrice = null;
let currentPosition = null;
let dailyPnL = 0;
let tradeHistory = [];

// ============================================================
// 3. WebSocket 实时行情 (不计入 API 频率限制)
// ============================================================
function initPriceSocket() {
    const wsUrl = `wss://fstream.binance.com/ws/${SYMBOL.toLowerCase()}@markPrice`;
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => console.log(`[WS] 成功连接币安 ${SYMBOL} 实时价格流`));
    
    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.p) { lastPrice = parseFloat(msg.p); }
    });

    ws.on('error', (e) => console.log('[WS] 错误:', e.message));
    ws.on('close', () => {
        console.log('[WS] 连接断开，5秒后尝试重连...');
        setTimeout(initPriceSocket, 5000);
    });
}
initPriceSocket();

// ============================================================
// 4. 技术指标计算 (MA, RSI, ATR)
// ============================================================
function calcMA(data, p) { 
    if (data.length < p) return null; 
    return data.slice(-p).reduce((s,c) => s + c.close, 0) / p; 
}

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
    let trSum = 0;
    const slice = data.slice(-p);
    for (let i = 1; i < slice.length; i++) {
        trSum += Math.max(
            slice[i].high - slice[i].low,
            Math.abs(slice[i].high - slice[i-1].close),
            Math.abs(slice[i].low - slice[i-1].close)
        );
    }
    return trSum / p;
}

// ============================================================
// 5. 核心交易逻辑 (入场、止盈止损、平仓)
// ============================================================
function detectSignal(data) {
    if (!data || data.length < 22) return null;
    const last = data.length - 1;
    const ma5 = calcMA(data, 5), ma10 = calcMA(data, 10), ma20 = calcMA(data, 20);
    const ma5p = calcMA(data.slice(0, -1), 5), ma10p = calcMA(data.slice(0, -1), 10);
    const rsi = calcRSI(data);

    // 多头信号：均线金叉且RSI未超买
    const bull = ma5 > ma10 && ma10 > ma20 && ma5p <= ma10p && rsi < 70;
    // 空头信号：均线死叉且RSI未超卖
    const bear = ma5 < ma10 && ma10 < ma20 && ma5p >= ma10p && rsi > 30;

    if (bull) return { type: 'LONG', label: '做多', rsi, atr: calcATR(data) };
    if (bear) return { type: 'SHORT', label: '做空', rsi, atr: calcATR(data) };
    return null;
}

function calcTPSL(data, type) {
    const entryPrice = lastPrice || data[data.length - 1].close;
    const atr = calcATR(data);
    // 动态止盈止损：止损设为1.5倍波动，止盈设为3倍波动（风险报酬比 1:2）
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
        console.log(`🏁 【${reason}】盈亏: ${pnl.toFixed(2)}U | 现价: ${price}`);
        tradeHistory.push({ ...pos, exitPrice: price, pnl, reason, endTime: new Date() });
        currentPosition = null;
        lastSignalTime = Date.now();
    }
}

// ============================================================
// 6. 基础网络函数
// ============================================================
function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'ETH-Bot/2.0' } }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        }).on('error', reject);
    });
}

// ============================================================
// 7. 定时主循环
// ============================================================
async function checkSignal() {
    if (!monitorEnabled || (Date.now() - lastSignalTime < SIGNAL_COOLDOWN_MS)) return;
    try {
        const data = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL}&interval=1m&limit=100`);
        if (!Array.isArray(data)) return;
        
        const candles = data.map(d => ({ close: parseFloat(d[4]), high: parseFloat(d[2]), low: parseFloat(d[3]) }));

        if (currentPosition) {
            await checkPosition();
            return;
        }

        const sig = detectSignal(candles);
        if (sig && sig.type !== lastSignalType) {
            const tpsl = calcTPSL(candles, sig.type);
            const balance = 100; // 模拟余额
            const qty = (balance * 10) / lastPrice; // 10倍杠杆全仓

            currentPosition = { 
                type: sig.type, entryPrice: lastPrice, qty, tpsl, startTime: new Date() 
            };
            console.log(`🚀 【开仓】${sig.label} 入场价: ${lastPrice} | 止盈: ${tpsl.tp.toFixed(2)} | 止损: ${tpsl.sl.toFixed(2)}`);
            lastSignalType = sig.type;
        }
    } catch (e) { console.log("循环报错:", e.message); }
}

// ============================================================
// 8. HTTP 服务 (用于监控和 Render 存活)
// ============================================================
const server = http.createServer((req, res) => {
    if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            bot: "Active",
            price: lastPrice,
            position: currentPosition || "None",
            today_pnl: dailyPnL.toFixed(2) + " USDT",
            trades: tradeHistory.length
        }));
    }
    res.writeHead(200); res.end("ETH Trader is Running");
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Server on port ${PORT}`);
    setInterval(checkSignal, CHECK_INTERVAL_MS);
});
