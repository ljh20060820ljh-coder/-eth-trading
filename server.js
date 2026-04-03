const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ==========================================
// 🔐 核心配置区 (V19.3 工业级抗震版)
// ==========================================
const FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK || "https://open.feishu.cn/open-apis/bot/v2/hook/6099f609-41c4-4364-b0d8-fdb986b821a2"; 
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

// 🎯 10个精选妖币监控阵列 (精度已根据最新接口校准)
const SYMBOLS = ['SOLUSDT', 'DOGEUSDT', 'ORDIUSDT', 'INJUSDT', 'PEPEUSDT', 'WIFUSDT', 'BONKUSDT', '1000SATSUSDT', 'ARBUSDT', 'TIAUSDT']; 
const PRECISION = { 
    'SOLUSDT': {p:3, q:1}, 'DOGEUSDT': {p:5, q:0}, 'ORDIUSDT': {p:3, q:1}, 
    'INJUSDT': {p:3, q:1}, 'PEPEUSDT': {p:8, q:0}, 'WIFUSDT': {p:4, q:1},
    'BONKUSDT': {p:8, q:0}, '1000SATSUSDT': {p:7, q:0}, 'ARBUSDT': {p:4, q:1}, 'TIAUSDT': {p:4, q:0} // 🎯 修正 TIA 精度
};

const LEVERAGE = 10; 
const POSITION_RISK_PERCENT = 0.45; // 针对14U，动用约6.3U，留足保证金
const MAX_HOLD_HOURS = 6; 

const TP_FIXED = 1.5;   
const SL_HARD = 3.5;    
const BTC_STORM = 1.2;  

let isProcessing = false; 
let activePos = { symbol: 'NONE', status: 'NONE', entryPrice: 0, qty: 0, maxMfe: 0, startTime: 0, mode: 'NORMAL' };
let initialBalance = null, currentBalance = 0;

function getBJTime() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }

async function sendFeishu(title, message) {
    try {
        if (!FEISHU_WEBHOOK_URL || !FEISHU_WEBHOOK_URL.startsWith("http")) return;
        const content = `【${title}】\n------------------\n${message}\n时间: ${getBJTime()}`;
        const options = { hostname: 'open.feishu.cn', path: new URL(FEISHU_WEBHOOK_URL).pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } };
        const req = https.request(options); req.write(JSON.stringify({ msg_type: "text", content: { text: content } })); req.end();
    } catch(e) {}
}

async function binanceReq(path, params, method = 'POST') {
    return new Promise((resolve) => {
        try {
            params.timestamp = Date.now();
            const query = querystring.stringify(params);
            const sig = crypto.createHmac('sha256', BINANCE_API_SECRET).update(query).digest('hex');
            const data = `${query}&signature=${sig}`;
            const options = { 
                hostname: 'fapi.binance.com', path: method === 'GET' ? `${path}?${data}` : path, method,
                headers: { 'X-MBX-APIKEY': BINANCE_API_KEY }, timeout: 8000 
            };
            const req = https.request(options, res => {
                let b = ''; res.on('data', c => b += c);
                res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve({}); } });
            });
            req.on('error', () => resolve({})); if (method === 'POST') req.write(data); req.end();
        } catch(e) { resolve({}); }
    });
}

async function fetchKlines(symbol, interval = '15m', limit = 20) {
    return new Promise((resolve) => {
        const options = { hostname: 'fapi.binance.com', path: `/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, timeout: 8000 };
        https.get(options, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { 
                try { 
                    const raw = JSON.parse(d);
                    if(!Array.isArray(raw) || raw.length === 0) return resolve([]);
                    resolve(raw.map(k => ({ c: +k[4] }))); 
                } catch(e) { resolve([]); } 
            });
        }).on('error', () => resolve([]));
    });
}

function calcRSI(klines) {
    let p=14; if(!klines || klines.length < p+1) return 50;
    try {
        let ag=0, al=0;
        for(let i=1;i<=p;i++){ let diff = klines[i].c - klines[i-1].c; if(diff > 0) ag += diff; else al -= diff; }
        ag /= p; al /= p; let rsi = 100 - (100 / (1 + (ag / (al || 0.001))));
        for(let i=p+1; i<klines.length; i++){
            let diff = klines[i].c - klines[i-1].c, g = diff > 0 ? diff : 0, l = diff < 0 ? -diff : 0;
            ag = (ag * (p-1) + g) / p; al = (al * (p-1) + l) / p; rsi = 100 - (100 / (1 + (ag / (al || 0.001))));
        }
        return rsi;
    } catch(e) { return 50; }
}

async function runMonitor() {
    if (isProcessing) return; isProcessing = true;
    try {
        const risk = await binanceReq('/fapi/v2/positionRisk', {}, 'GET');
        const wallet = await binanceReq('/fapi/v2/account', {}, 'GET');
        if(!wallet || !wallet.totalMarginBalance) { isProcessing=false; return; }
        currentBalance = parseFloat(wallet.totalMarginBalance);
        if(initialBalance === null) initialBalance = currentBalance;

        let curSymbol = 'NONE';
        if(Array.isArray(risk)) {
            const p = risk.find(x => Math.abs(parseFloat(x.positionAmt)) > 0);
            if(p) {
                curSymbol = p.symbol;
                if(activePos.symbol === 'NONE') {
                    activePos = { symbol: p.symbol, status: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT', qty: Math.abs(parseFloat(p.positionAmt)), entryPrice: parseFloat(p.entryPrice), maxMfe: 0, startTime: Date.now(), mode: 'NORMAL' };
                }
            } else if(activePos.symbol !== 'NONE') {
                await binanceReq('/fapi/v1/allOpenOrders', { symbol: activePos.symbol }, 'DELETE');
                activePos = { symbol: 'NONE', status: 'NONE', entryPrice: 0, qty: 0, maxMfe: 0, startTime: 0, mode: 'NORMAL' };
            }
        }

        // 🛡️ 修复点：深度防空检查，解决 reading 'c' 报错
        const btcK = await fetchKlines('BTCUSDT', '15m', 5);
        if(!btcK || btcK.length < 2) { isProcessing=false; return; }
        const btcChange = ((btcK[btcK.length-1].c - btcK[btcK.length-2].c) / btcK[btcK.length-2].c) * 100;
        const isBtcStorm = Math.abs(btcChange) >= BTC_STORM;

        process.stdout.write(`\r[${getBJTime()}] 💰余额:${currentBalance.toFixed(2)} | 大饼风力:${btcChange.toFixed(2)}% | 状态:${activePos.symbol==='NONE'?'🔭巡航':'🛡️持仓'}`);

        if(curSymbol !== 'NONE') {
            const tick = await binanceReq('/fapi/v1/ticker/price', { symbol: activePos.symbol }, 'GET');
            if(!tick || !tick.price) { isProcessing=false; return; }
            const curP = parseFloat(tick.price);
            let pnl = activePos.status === 'LONG' ? (curP - activePos.entryPrice) / activePos.entryPrice * 100 : (activePos.entryPrice - curP) / activePos.entryPrice * 100;
            if(pnl > activePos.maxMfe) activePos.maxMfe = pnl;

            if((Date.now() - activePos.startTime) / 3600000 >= MAX_HOLD_HOURS) {
                await binanceReq('/fapi/v1/order', { symbol: activePos.symbol, side: activePos.status==='LONG'?'SELL':'BUY', type: 'MARKET', quantity: activePos.qty });
                sendFeishu("⏰ 僵尸单清理", `${activePos.symbol} 超时平仓`);
            }
            if(activePos.mode === 'TRALLING' && activePos.maxMfe > 1.5 && (activePos.maxMfe - pnl) >= 0.5) {
                await binanceReq('/fapi/v1/order', { symbol: activePos.symbol, side: activePos.status==='LONG'?'SELL':'BUY', type: 'MARKET', quantity: activePos.qty });
            }
            isProcessing = false; return;
        }

        for(const sym of SYMBOLS) {
            await new Promise(r => setTimeout(r, 600));
            const klines = await fetchKlines(sym, '15m', 30);
            if(!klines || klines.length < 20) continue;
            const rsi = calcRSI(klines);
            const liveC = klines[klines.length-1].c;

            if(rsi < 30 && !(isBtcStorm && btcChange < 0)) {
                await openOrder(sym, 'BUY', liveC, (isBtcStorm && btcChange > 0) ? 'TRALLING' : 'NORMAL');
                break;
            }
            if(rsi > 70 && !(isBtcStorm && btcChange > 0)) {
                await openOrder(sym, 'SELL', liveC, (isBtcStorm && btcChange < 0) ? 'TRALLING' : 'NORMAL');
                break;
            }
        }
    } catch(e) { console.error("\n🔥 捕获异常:", e.message); } finally { isProcessing = false; }
}

async function openOrder(symbol, side, price, mode) {
    // 🎯 针对 14U 的保底下单逻辑
    let budget = currentBalance * POSITION_RISK_PERCENT;
    let qty = ((budget * LEVERAGE) / price).toFixed(PRECISION[symbol].q);
    if (parseFloat(qty) * price < 5.5) qty = (6.1 / price).toFixed(PRECISION[symbol].q);
    
    console.log(`\n🎯 [${symbol}] 正在入场... 价格:${price} 数量:${qty}`);
    const res = await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: qty });
    
    if(!res.code) {
        activePos = { symbol, status: side==='BUY'?'LONG':'SHORT', entryPrice: price, qty: parseFloat(qty), maxMfe: 0, startTime: Date.now(), mode };
        setTimeout(async () => {
            const entry = activePos.entryPrice;
            const slP = side === 'BUY' ? entry * (1 - SL_HARD/100) : entry * (1 + SL_HARD/100);
            const revS = side === 'BUY' ? 'SELL' : 'BUY';
            await binanceReq('/fapi/v1/order', { symbol, side: revS, type: 'STOP_MARKET', stopPrice: slP.toFixed(PRECISION[symbol].p), closePosition: 'true' });
            if(mode === 'NORMAL') {
                const tpP = side === 'BUY' ? entry * (1 + TP_FIXED/100) : entry * (1 - TP_FIXED/100);
                await binanceReq('/fapi/v1/order', { symbol, side: revS, type: 'LIMIT', price: tpP.toFixed(PRECISION[symbol].p), quantity: activePos.qty, timeInForce: 'GTC' });
            }
            sendFeishu("🔥 战车开火", `${symbol} | ${side} | 止损已挂`);
        }, 2000);
    } else {
        console.error(`\n❌ 开仓失败 [${symbol}]: ${res.msg}`);
    }
}

setInterval(() => {
    let stat = activePos.symbol === 'NONE' ? "🔭 巡航中" : `🛡️ 持仓: ${activePos.symbol}`;
    sendFeishu("📊 平安汇报", `余额: ${currentBalance.toFixed(2)} | PNL: ${(currentBalance-initialBalance).toFixed(2)} | ${stat}`);
}, 3600000);

http.createServer((req,res)=>{ 
    res.setHeader('Content-Type','text/html; charset=utf-8'); 
    res.end(`<h1>V19.3 工业修复版</h1><p>资产: ${currentBalance.toFixed(3)} U</p>`); 
}).listen(process.env.PORT||3000);

setInterval(runMonitor, 60000); 
runMonitor();
