const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ==========================================
// 🔐 V21.0 逻辑闭环版 (彻底杜绝幽灵单 & 精准校对)
// ==========================================
const FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK || "https://open.feishu.cn/open-apis/bot/v2/hook/6099f609-41c4-4364-b0d8-fdb986b821a2"; 
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

const PRECISION = { 
    'SOLUSDT': {p:3, q:1}, 'DOGEUSDT': {p:5, q:0}, 'ORDIUSDT': {p:3, q:1}, 
    'INJUSDT': {p:3, q:1}, 'PEPEUSDT': {p:8, q:0}, 'WIFUSDT': {p:4, q:1},
    'BONKUSDT': {p:8, q:0}, '1000SATSUSDT': {p:7, q:0}, 'ARBUSDT': {p:4, q:1}, 
    'TIAUSDT': {p:3, q:1} // 🎯 确定的 TIA 精度：3位价，1位量
};
const SYMBOLS = Object.keys(PRECISION);

const LEVERAGE = 10; 
const POSITION_RISK_PERCENT = 0.45; 
const MAX_HOLD_HOURS = 6; 
const TP_FIXED = 1.5;   
const SL_HARD = 3.5;    
const BTC_STORM = 1.2;  

let isProcessing = false; 
let activePos = { symbol: 'NONE', status: 'NONE', entryPrice: 0, qty: 0, maxMfe: 0, startTime: 0, mode: 'NORMAL' };
let initialBalance = null, currentBalance = 0;

function getBJTime() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }

async function binanceReq(path, params, method = 'POST') {
    return new Promise((resolve) => {
        try {
            params.timestamp = Date.now();
            const query = querystring.stringify(params);
            const sig = crypto.createHmac('sha256', BINANCE_API_SECRET).update(query).digest('hex');
            const data = `${query}&signature=${sig}`;
            const options = { hostname: 'fapi.binance.com', path: method === 'GET' ? `${path}?${data}` : path, method, headers: { 'X-MBX-APIKEY': BINANCE_API_KEY }, timeout: 10000 };
            const req = https.request(options, res => {
                let b = ''; res.on('data', c => b += c);
                res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve({code:-999}); } });
            });
            req.on('error', () => resolve({code:-999})); if (method === 'POST') req.write(data); req.end();
        } catch(e) { resolve({code:-999}); }
    });
}

async function fetchKlines(symbol, interval = '15m', limit = 20) {
    return new Promise((resolve) => {
        const options = { hostname: 'fapi.binance.com', path: `/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, timeout: 8000 };
        https.get(options, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { const raw = JSON.parse(d); resolve(Array.isArray(raw) && raw.length >= limit ? raw.map(k => ({ c: +k[4] })) : null); } catch(e) { resolve(null); } });
        }).on('error', () => resolve(null));
    });
}

function calcRSI(klines) {
    if(!klines) return 50;
    let p=14, ag=0, al=0;
    for(let i=1;i<=p;i++){ let diff = klines[i].c - klines[i-1].c; if(diff > 0) ag += diff; else al -= diff; }
    ag /= p; al /= p; let rsi = 100 - (100 / (1 + (ag / (al || 0.001))));
    for(let i=p+1; i<klines.length; i++){
        let diff = klines[i].c - klines[i-1].c, g = diff > 0 ? diff : 0, l = diff < 0 ? -diff : 0;
        ag = (ag * (p-1) + g) / p; al = (al * (p-1) + l) / p; rsi = 100 - (100 / (1 + (ag / (al || 0.001))));
    }
    return rsi;
}

async function runMonitor() {
    if (isProcessing) return; isProcessing = true;
    try {
        const risk = await binanceReq('/fapi/v2/positionRisk', {}, 'GET');
        const wallet = await binanceReq('/fapi/v2/account', {}, 'GET');
        if(!wallet || !wallet.totalMarginBalance) return;
        currentBalance = parseFloat(wallet.totalMarginBalance);
        if(initialBalance === null) initialBalance = currentBalance;

        let hasLivePos = false;
        if(Array.isArray(risk)) {
            const p = risk.find(x => Math.abs(parseFloat(x.positionAmt)) > 0);
            if(p) {
                hasLivePos = true;
                activePos.symbol = p.symbol;
                activePos.status = parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT';
                activePos.qty = Math.abs(parseFloat(p.positionAmt));
                activePos.entryPrice = parseFloat(p.entryPrice);
                if(activePos.startTime === 0) activePos.startTime = Date.now();
            } else if(activePos.symbol !== 'NONE') {
                await binanceReq('/fapi/v1/allOpenOrders', { symbol: activePos.symbol }, 'DELETE');
                activePos = { symbol: 'NONE', status: 'NONE', entryPrice: 0, qty: 0, maxMfe: 0, startTime: 0, mode: 'NORMAL' };
            }
        }

        const btcK = await fetchKlines('BTCUSDT', '15m', 5);
        if(!btcK) return;
        const btcChange = ((btcK[btcK.length-1].c - btcK[btcK.length-2].c) / btcK[btcK.length-2].c) * 100;
        process.stdout.write(`\r[${getBJTime()}] 💰余额:${currentBalance.toFixed(2)} | 大饼:${btcChange.toFixed(2)}% | 状态:${activePos.symbol==='NONE'?'🔭巡航':'🛡️持仓'}`);

        if(hasLivePos) {
            const tick = await binanceReq('/fapi/v1/ticker/price', { symbol: activePos.symbol }, 'GET');
            if(!tick.price) return;
            let pnl = activePos.status === 'LONG' ? (tick.price - activePos.entryPrice) / activePos.entryPrice * 100 : (activePos.entryPrice - tick.price) / activePos.entryPrice * 100;
            if(pnl > activePos.maxMfe) activePos.maxMfe = pnl;
            if((Date.now() - activePos.startTime) / 3600000 >= MAX_HOLD_HOURS) {
                await binanceReq('/fapi/v1/order', { symbol: activePos.symbol, side: activePos.status==='LONG'?'SELL':'BUY', type: 'MARKET', quantity: activePos.qty });
            }
            if(activePos.mode === 'TRALLING' && activePos.maxMfe > 1.5 && (activePos.maxMfe - pnl) >= 0.5) {
                await binanceReq('/fapi/v1/order', { symbol: activePos.symbol, side: activePos.status==='LONG'?'SELL':'BUY', type: 'MARKET', quantity: activePos.qty });
            }
            return;
        }

        for(const sym of SYMBOLS) {
            await new Promise(r => setTimeout(r, 600));
            const klines = await fetchKlines(sym, '15m', 30);
            if(!klines) continue;
            const rsi = calcRSI(klines);
            const liveC = klines[klines.length-1].c;

            if(rsi < 30 && !(Math.abs(btcChange) >= BTC_STORM && btcChange < 0)) {
                await openOrder(sym, 'BUY', liveC, (Math.abs(btcChange) >= BTC_STORM && btcChange > 0) ? 'TRALLING' : 'NORMAL');
                break;
            }
            if(rsi > 70 && !(Math.abs(btcChange) >= BTC_STORM && btcChange > 0)) {
                await openOrder(sym, 'SELL', liveC, (Math.abs(btcChange) >= BTC_STORM && btcChange < 0) ? 'TRALLING' : 'NORMAL');
                break;
            }
        }
    } catch(e) {} finally { isProcessing = false; }
}

async function openOrder(symbol, side, price, mode) {
    let budget = currentBalance * POSITION_RISK_PERCENT;
    let qty = ((budget * LEVERAGE) / price).toFixed(PRECISION[symbol].q);
    if (parseFloat(qty) * price < 5.5) qty = (6.1 / price).toFixed(PRECISION[symbol].q);
    
    console.log(`\n🎯 [${symbol}] 尝试开仓... 价格:${price.toFixed(PRECISION[symbol].p)} 数量:${qty}`);
    const res = await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: qty });
    
    // 🎯 核心逻辑：只有 Market 单成交了（没有 res.code），才准许挂后面的单子！
    if(res && !res.code) {
        console.log(`✅ [${symbol}] 开仓成功，开始布置防线...`);
        activePos = { symbol, status: side==='BUY'?'LONG':'SHORT', entryPrice: price, qty: parseFloat(qty), maxMfe: 0, startTime: Date.now(), mode };
        setTimeout(async () => {
            const entry = activePos.entryPrice;
            const slP = (side === 'BUY' ? entry * (1 - SL_HARD/100) : entry * (1 + SL_HARD/100)).toFixed(PRECISION[symbol].p);
            const revS = side === 'BUY' ? 'SELL' : 'BUY';
            // 挂硬止损
            await binanceReq('/fapi/v1/order', { symbol, side: revS, type: 'STOP_MARKET', stopPrice: slP, closePosition: 'true' });
            // 挂止盈
            if(mode === 'NORMAL') {
                const tpP = (side === 'BUY' ? entry * (1 + TP_FIXED/100) : entry * (1 - TP_FIXED/100)).toFixed(PRECISION[symbol].p);
                await binanceReq('/fapi/v1/order', { symbol, side: revS, type: 'LIMIT', price: tpP, quantity: activePos.qty, timeInForce: 'GTC' });
            }
        }, 2000);
    } else {
        // 🚨 如果 Market 单报错（比如精度问题），这里会直接拦截，不会再去挂幽灵止盈单！
        console.error(`\n❌ [${symbol}] 开仓失败，已自动拦截幽灵挂单！原因: ${res.msg || '未知错误'}`);
    }
}

http.createServer((req,res)=>{ 
    res.setHeader('Content-Type','text/html; charset=utf-8'); 
    res.end(`<h1>V21.0 闭环版</h1><p>资产: ${currentBalance.toFixed(2)} U</p>`); 
}).listen(process.env.PORT||3000);

setInterval(runMonitor, 60000); 
runMonitor();
