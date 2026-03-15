const https = require('https');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');

// ============================================================
// 1. 配置区 (实盘模式)
// ============================================================
const BINANCE_API_KEY = process.env.BINANCE_API_KEY || 'yfVasX0Ajqeb8IrauKvr6Le3jjW2ZoYvcWehSqXP1T5QCymmDZAmWVJUYdDVkmgX';
const BINANCE_SECRET = process.env.BINANCE_SECRET || 'kTS00yZ1TIfHHcWqTvZXd3e7D5PVaCrXIvshCK2bsZ110z7PzMxysUVA074zzBjG';

const SYMBOL = "ETHUSDT";
const CHECK_INTERVAL_MS = 30 * 1000;    
const SIGNAL_COOLDOWN_MS = 15 * 60 * 1000; 

// 状态控制
let PAPER_TRADING = false; // ！！！强制设为 false 开启实盘！！！
let lastSignalTime = 0;
let lastPrice = null;
let currentPosition = null; 
let tradeHistory = [];

// ============================================================
// 2. 币安实盘下单 API 函数
// ============================================================
async function binanceRequest(method, endpoint, params = {}) {
    const timestamp = Date.now();
    const query = Object.entries({ ...params, timestamp })
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const signature = crypto.createHmac('sha256', BINANCE_SECRET).update(query).digest('hex');
    
    const options = {
        hostname: 'fapi.binance.com',
        path: `${endpoint}?${query}&signature=${signature}`,
        method: method,
        headers: { 'X-MBX-APIKEY': BINANCE_API_KEY }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let d = '';
            res.on('data', chunk => d += chunk);
            res.on('end', () => resolve(JSON.parse(d)));
        });
        req.on('error', reject);
        req.end();
    });
}

// ============================================================
// 3. 实时价格流 (WebSocket)
// ============================================================
function initPriceSocket() {
    const ws = new WebSocket(`wss://fstream.binance.com/ws/${SYMBOL.toLowerCase()}@markPrice`);
    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.p) lastPrice = parseFloat(msg.p);
    });
    ws.on('close', () => setTimeout(initPriceSocket, 5000));
}
initPriceSocket();

// ============================================================
// 4. 技术指标计算 (MA, RSI, ATR)
// ============================================================
function calcMA(data, p) { return data.slice(-p).reduce((s, c) => s + c.close, 0) / p; }
function calcATR(data, p = 14) {
    let trSum = 0; const s = data.slice(-p);
    for (let i = 1; i < s.length; i++) {
        trSum += Math.max(s[i].high - s[i].low, Math.abs(s[i].high - s[i-1].close), Math.abs(s[i].low - s[i-1].close));
    }
    return trSum / p;
}

// ============================================================
// 5. 核心交易逻辑 (含实盘下单)
// ============================================================
async function executeTrade(type, price, candles) {
    const atr = calcATR(candles);
    const qty = 0.05; // ！！！这里设置你的固定下单币数 (例如 0.05 ETH) ！！！
    
    console.log(`📡 正在向币安发送实盘订单: ${type} ${qty} ETH...`);
    
    // 1. 市价开仓
    const order = await binanceRequest('POST', '/fapi/v1/order', {
        symbol: SYMBOL,
        side: type === 'LONG' ? 'BUY' : 'SELL',
        type: 'MARKET',
        quantity: qty
    });

    if (order.orderId) {
        const tp = type === 'LONG' ? price + (atr * 3) : price - (atr * 3);
        const sl = type === 'LONG' ? price - (atr * 1.5) : price + (atr * 1.5);
        
        currentPosition = { type, entryPrice: price, qty, tpsl: { tp, sl }, orderId: order.orderId };
        console.log(`✅ 实盘开仓成功！ID: ${order.orderId}`);
    } else {
        console.error("❌ 开仓失败:", order.msg);
    }
}

async function checkSignal() {
    if (Date.now() - lastSignalTime < SIGNAL_COOLDOWN_MS) return;

    try {
        const res = await new Promise(r => https.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL}&interval=1m&limit=50`, res => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => r(JSON.parse(d)));
        }));

        const candles = res.map(d => ({ close: parseFloat(d[4]), high: parseFloat(d[2]), low: parseFloat(d[3]) }));
        const ma5 = calcMA(candles, 5), ma10 = calcMA(candles, 10), ma20 = calcMA(candles, 20);

        if (!currentPosition) {
            // 金叉做多
            if (ma5 > ma10 && ma10 > ma20) await executeTrade('LONG', lastPrice, candles);
            // 死叉做空
            else if (ma5 < ma10 && ma10 < ma20) await executeTrade('SHORT', lastPrice, candles);
        } else {
            // 止盈止损逻辑
            const pos = currentPosition;
            let shouldClose = (pos.type === 'LONG' && (lastPrice >= pos.tpsl.tp || lastPrice <= pos.tpsl.sl)) ||
                             (pos.type === 'SHORT' && (lastPrice <= pos.tpsl.tp || lastPrice >= pos.tpsl.sl));

            if (shouldClose) {
                const closeOrder = await binanceRequest('POST', '/fapi/v1/order', {
                    symbol: SYMBOL,
                    side: pos.type === 'LONG' ? 'SELL' : 'BUY',
                    type: 'MARKET',
                    quantity: pos.qty
                });
                console.log("🏁 实盘已平仓");
                currentPosition = null;
                lastSignalTime = Date.now();
            }
        }
    } catch (e) { console.log("执行错误:", e.message); }
}

// ============================================================
// 6. 监控接口
// ============================================================
http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ bot: "Active", price: lastPrice, mode: "REAL_TRADING", position: currentPosition || "None" }));
    } else {
        res.writeHead(200); res.end("ETH Bot Live");
    }
}).listen(process.env.PORT || 10000, () => {
    setInterval(checkSignal, CHECK_INTERVAL_MS);
});
