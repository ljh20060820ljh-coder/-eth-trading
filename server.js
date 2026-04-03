const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ==========================================
// 🔐 V25.0 火力全开版 (解除火力限制 & 原生保险闭环)
// ==========================================
const FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK || "https://open.feishu.cn/open-apis/bot/v2/hook/6099f609-41c4-4364-b0d8-fdb986b821a2"; 
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

const PRECISION = { 
    'SOLUSDT': {p:3, q:1}, 'DOGEUSDT': {p:5, q:0}, 'ORDIUSDT': {p:3, q:1}, 
    'INJUSDT': {p:3, q:1}, 'PEPEUSDT': {p:8, q:0}, 'WIFUSDT': {p:4, q:1},
    'BONKUSDT': {p:8, q:0}, '1000SATSUSDT': {p:7, q:0}, 'ARBUSDT': {p:4, q:1}, 
    'TIAUSDT': {p:4, q:0} 
};
const SYMBOLS = Object.keys(PRECISION);

// 🚀 火力配置区重构
const LEVERAGE = 10;                // 强制 10 倍杠杆
const POSITION_RISK_PERCENT = 0.5;  // 🎯 动用 50% 的本金作为保证金！(14U 会动用 7U)
const SL_HARD = 3.5;                // 3.5% 硬止损
const TP_FIXED = 1.5;               // 1.5% 常规止盈
const BTC_STORM = 1.2;              // 大饼风控系数

let isProcessing = false; 
let activePos = { symbol: 'NONE', status: 'NONE', entryPrice: 0, qty: 0, maxMfe: 0, startTime: 0, mode: 'NORMAL' };
let currentBalance = 0;

function getBJTime() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }

async function sendFeishu(title, message) {
    try {
        const options = { hostname: 'open.feishu.cn', path: new URL(FEISHU_WEBHOOK_URL).pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } };
        const req = https.request(options); req.write(JSON.stringify({ msg_type: "text", content: { text: `【${title}】\n${message}\n时间: ${getBJTime()}` } })); req.end();
    } catch(e) {}
}

async function binanceReq(path, params, method = 'POST') {
    return new Promise((resolve) => {
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
    });
}

async function fetchKlines(symbol) {
    return new Promise((resolve) => {
        https.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=20`, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { const raw = JSON.parse(d); resolve(Array.isArray(raw) ? raw.map(k => ({ c: +k[4] })) : null); } catch(e) { resolve(null); } });
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

async function setNativeSecurity(symbol, status, entry) {
    const revSide = status === 'LONG' ? 'SELL' : 'BUY';
    const slP = (status === 'LONG' ? entry * (1 - SL_HARD/100) : entry * (1 + SL_HARD/100)).toFixed(PRECISION[symbol].p);
    const tpP = (status === 'LONG' ? entry * (1 + TP_FIXED/100) : entry * (1 - TP_FIXED/100)).toFixed(PRECISION[symbol].p);
    
    const slRes = await binanceReq('/fapi/v1/order', { symbol, side: revSide, type: 'STOP_MARKET', stopPrice: slP, closePosition: 'true' });
    let tpRes = {code: 0};
    if(activePos.mode === 'NORMAL') {
        tpRes = await binanceReq('/fapi/v1/order', { symbol, side: revSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tpP, closePosition: 'true' });
    }
    
    if(slRes.code || tpRes.code) {
        console.error(`❌ [${symbol}] 防线挂载失败! SL:${slRes.msg} TP:${tpRes.msg}`);
        return false;
    }
    console.log(`🛡️ [${symbol}] 原生双保险(止盈+止损)已死死焊在仓位上！`);
    return true;
}

async function runMonitor() {
    if (isProcessing) return; isProcessing = true;
    try {
        const risk = await binanceReq('/fapi/v2/positionRisk', {}, 'GET');
        const wallet = await binanceReq('/fapi/v2/account', {}, 'GET');
        if(!wallet.totalMarginBalance) return;
        currentBalance = parseFloat(wallet.totalMarginBalance);

        const pos = Array.isArray(risk) ? risk.find(x => Math.abs(parseFloat(x.positionAmt)) > 0) : null;
        const btcK = await fetchKlines('BTCUSDT');
        const btcChange = btcK ? ((btcK[btcK.length-1].c - btcK[btcK.length-2].c) / btcK[btcK.length-2].c) * 100 : 0;
        
        console.log(`${['🔥','💥','🧨'][Math.floor(Math.random()*3)]} [${getBJTime()}] 资产:${currentBalance.toFixed(3)}U | 状态:${pos?'⚔️血战中':'🔭雷达扫描中'}`);

        if(pos) {
            activePos.symbol = pos.symbol;
            activePos.status = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
            activePos.qty = Math.abs(parseFloat(pos.positionAmt));
            activePos.entryPrice = parseFloat(pos.entryPrice);
            if(activePos.startTime === 0) activePos.startTime = Date.now();

            const orders = await binanceReq('/fapi/v1/openOrders', { symbol: pos.symbol }, 'GET');
            const hasSL = Array.isArray(orders) && orders.some(o => o.type === 'STOP_MARKET');
            if(!hasSL) {
                console.log(`⚠️ 警报: 发现裸奔仓位！正在强制注入装甲...`);
                await setNativeSecurity(pos.symbol, activePos.status, activePos.entryPrice);
            }
            return;
        } else if(activePos.symbol !== 'NONE') {
            await binanceReq('/fapi/v1/allOpenOrders', { symbol: activePos.symbol }, 'DELETE');
            activePos = { symbol: 'NONE', startTime: 0 };
        }

        for(const sym of SYMBOLS) {
            await new Promise(r => setTimeout(r, 300));
            const k = await fetchKlines(sym);
            if(!k) continue;
            const rsi = calcRSI(k);
            const liveC = k[k.length-1].c;

            if(rsi < 30 && !(Math.abs(btcChange) >= BTC_STORM && btcChange < 0)) {
                await executeTrade(sym, 'BUY', liveC, (Math.abs(btcChange) >= BTC_STORM && btcChange > 0) ? 'TRALLING' : 'NORMAL');
                break;
            }
            if(rsi > 70 && !(Math.abs(btcChange) >= BTC_STORM && btcChange > 0)) {
                await executeTrade(sym, 'SELL', liveC, (Math.abs(btcChange) >= BTC_STORM && btcChange < 0) ? 'TRALLING' : 'NORMAL');
                break;
            }
        }
    } finally { isProcessing = false; }
}

async function executeTrade(symbol, side, price, mode) {
    // 强制锁死 10倍 杠杆
    await binanceReq('/fapi/v1/leverage', { symbol: symbol, leverage: LEVERAGE }, 'POST');
    
    // 🚀 核心修复：真实火力计算！
    // 名义总价值 = 你的总余额 * 动用比例(50%) * 杠杆(10x)
    let notional = currentBalance * POSITION_RISK_PERCENT * LEVERAGE;
    if (notional < 6) notional = 6.5; // 保底兜底，防止因为各种损耗跌破 5U 门槛
    
    const qty = (notional / price).toFixed(PRECISION[symbol].q);
    
    console.log(`🚀 发起重火力突击 [${symbol}]！动用保证金: ~${(notional/LEVERAGE).toFixed(2)} U...`);
    const res = await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: qty });
    
    if(res && res.code === undefined) {
        activePos = { symbol, status: side==='BUY'?'LONG':'SHORT', entryPrice: price, qty: parseFloat(qty), startTime: Date.now(), mode };
        sendFeishu("🔥 重火力开仓成功", `标的: ${symbol}\n方向: ${side}\n投入保证金: ~${(notional/LEVERAGE).toFixed(2)} U\n系统正在绑定原生防线...`);
        
        setTimeout(async () => {
            const risk = await binanceReq('/fapi/v2/positionRisk', {symbol: symbol}, 'GET');
            const exactEntry = (Array.isArray(risk) && risk.length > 0) ? parseFloat(risk[0].entryPrice) : price;
            await setNativeSecurity(symbol, activePos.status, exactEntry);
        }, 2000);
    } else {
        console.error(`❌ 开火阻截: ${res.msg}`);
    }
}

http.createServer((req,res)=>{ 
    res.setHeader('Content-Type','text/html; charset=utf-8'); 
    res.end(`<h1>V25.0 重火力版运行中</h1><p>已解除资金限制</p>`); 
}).listen(process.env.PORT||3000);

setInterval(runMonitor, 60000); 
runMonitor();
