const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

process.on('uncaughtException', (err) => { console.error('🔥 [护盾] 拦截异常:', err.message); });
process.on('unhandledRejection', (reason) => { console.error('🔥 [护盾] 拦截Promise:', reason); });

// ==========================================
// 🔐 V32.0 宏观天眼版 (1小时大饼趋势拦截 + 结构防守)
// ==========================================
const FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK || "https://open.feishu.cn/open-apis/bot/v2/hook/6099f609-41c4-4364-b0d8-fdb986b821a2"; 
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

const SYMBOLS = ['SOLUSDT', 'DOGEUSDT', 'ORDIUSDT', 'INJUSDT', 'PEPEUSDT', 'WIFUSDT', 'BONKUSDT', '1000SATSUSDT', 'ARBUSDT', 'TIAUSDT']; 
let precisions = {}; 

const LEVERAGE = 10;                
const POSITION_RISK_PERCENT = 0.5;  

// 🎯 全新宏观风控：1小时级别的趋势判断
const MACRO_STORM_UP = 1.2;    // 大饼 1小时 涨超 1.2%，禁止任何做空！
const MACRO_STORM_DOWN = -1.2; // 大饼 1小时 跌超 1.2%，禁止任何做多！

const RSI_BUY_LINE = 30;  
const RSI_SELL_LINE = 70; 
const BOUNCE_CONFIRM = 0.005; 

const RR_RATIO = 1.5;         
const MIN_SL_PERCENT = 0.008; 
const MAX_SL_PERCENT = 0.035; 
const EXTREMUM_BUFFER = 0.002; 

let isProcessing = false; 
let activePos = { symbol: 'NONE', status: 'NONE', entryPrice: 0, qty: 0, extremum: null, startTime: 0, mode: 'NORMAL' };
let currentBalance = 0;

function getBJTime() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }

async function sendFeishu(title, message) {
    try {
        if (!FEISHU_WEBHOOK_URL || !FEISHU_WEBHOOK_URL.startsWith("http")) return;
        const options = { hostname: 'open.feishu.cn', path: new URL(FEISHU_WEBHOOK_URL).pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } };
        const req = https.request(options); 
        req.write(JSON.stringify({ msg_type: "text", content: { text: `【${title}】\n------------------\n${message}\n时间: ${getBJTime()}` } })); 
        req.end();
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

async function initPrecisions() {
    console.log("🔄 正在同步精度...");
    const data = await binanceReq('/fapi/v1/exchangeInfo', {}, 'GET');
    if(data && Array.isArray(data.symbols)) {
        data.symbols.forEach(s => {
            if(SYMBOLS.includes(s.symbol)) {
                const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');
                const lotFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
                const getDecimals = (str) => { const numStr = parseFloat(str).toString(); return numStr.includes('.') ? numStr.split('.')[1].length : 0; };
                precisions[s.symbol] = { p: getDecimals(priceFilter.tickSize), q: getDecimals(lotFilter.stepSize) };
            }
        });
        sendFeishu("🚀 战车已进化 (V32.0)", "宏观天眼已开启！\n从此大涨绝不摸顶，大跌绝不接刀。");
    }
}

async function fetchKlines(symbol) {
    return new Promise((resolve) => {
        https.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=20`, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { const raw = JSON.parse(d); resolve(Array.isArray(raw) ? raw.map(k => ({ o: +k[1], h: +k[2], l: +k[3], c: +k[4] })) : null); } catch(e) { resolve(null); } });
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

async function setAlgoSecurity(symbol, status, entry) {
    if(!precisions[symbol]) return false;
    const revSide = status === 'LONG' ? 'SELL' : 'BUY';
    
    let slP, tpP, riskPercent;
    const ext = activePos.extremum;

    if (ext) {
        if (status === 'LONG') {
            let sl = ext * (1 - EXTREMUM_BUFFER); 
            riskPercent = (entry - sl) / entry;
            if (riskPercent < MIN_SL_PERCENT) { sl = entry * (1 - MIN_SL_PERCENT); riskPercent = MIN_SL_PERCENT; }
            if (riskPercent > MAX_SL_PERCENT) { sl = entry * (1 - MAX_SL_PERCENT); riskPercent = MAX_SL_PERCENT; }
            let tp = entry + (entry - sl) * RR_RATIO;
            slP = sl.toFixed(precisions[symbol].p); tpP = tp.toFixed(precisions[symbol].p);
        } else {
            let sl = ext * (1 + EXTREMUM_BUFFER); 
            riskPercent = (sl - entry) / entry;
            if (riskPercent < MIN_SL_PERCENT) { sl = entry * (1 + MIN_SL_PERCENT); riskPercent = MIN_SL_PERCENT; }
            if (riskPercent > MAX_SL_PERCENT) { sl = entry * (1 + MAX_SL_PERCENT); riskPercent = MAX_SL_PERCENT; }
            let tp = entry - (sl - entry) * RR_RATIO;
            slP = sl.toFixed(precisions[symbol].p); tpP = tp.toFixed(precisions[symbol].p);
        }
    } else {
        slP = (status === 'LONG' ? entry * 0.98 : entry * 1.02).toFixed(precisions[symbol].p);
        tpP = (status === 'LONG' ? entry * 1.03 : entry * 0.97).toFixed(precisions[symbol].p);
        riskPercent = 0.02;
    }
    
    await binanceReq('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol: symbol, side: revSide, type: 'STOP_MARKET', triggerPrice: slP, closePosition: 'true' }, 'POST');
    if(activePos.mode === 'NORMAL') {
        await binanceReq('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol: symbol, side: revSide, type: 'TAKE_PROFIT_MARKET', triggerPrice: tpP, closePosition: 'true' }, 'POST');
    }
    return true;
}

async function runMonitor() {
    if (isProcessing) return; isProcessing = true;
    try {
        if(Object.keys(precisions).length === 0) { await initPrecisions(); if(Object.keys(precisions).length === 0) return; }

        const risk = await binanceReq('/fapi/v2/positionRisk', {}, 'GET');
        const wallet = await binanceReq('/fapi/v2/account', {}, 'GET');
        if(!wallet || !wallet.totalMarginBalance) return;
        currentBalance = parseFloat(wallet.totalMarginBalance);

        const pos = Array.isArray(risk) ? risk.find(x => Math.abs(parseFloat(x.positionAmt)) > 0) : null;
        
        // 🧠 核心改造：抓取大饼过去 1小时 (4根K线) 的累计真实涨跌幅！
        const btcK = await fetchKlines('BTCUSDT');
        const btcMacroChange = (btcK && btcK.length >= 5) 
            ? ((btcK[btcK.length-1].c - btcK[btcK.length-5].o) / btcK[btcK.length-5].o) * 100 
            : 0;
        
        console.log(`${['🦅','👁️','🔭'][Math.floor(Math.random()*3)]} [${getBJTime()}] 资产: ${currentBalance.toFixed(3)} | 宏观大饼: ${btcMacroChange.toFixed(2)}% | 状态: ${pos?'🔴':'🟢'}`);

        if(pos) {
            activePos.symbol = pos.symbol;
            activePos.status = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
            activePos.qty = Math.abs(parseFloat(pos.positionAmt));
            activePos.entryPrice = parseFloat(pos.entryPrice);
            if(activePos.startTime === 0) activePos.startTime = Date.now();

            const algoOrders = await binanceReq('/fapi/v1/openAlgoOrders', { symbol: pos.symbol }, 'GET');
            const hasSL = JSON.stringify(algoOrders).includes('STOP_MARKET');
            if(!hasSL) { await setAlgoSecurity(pos.symbol, activePos.status, activePos.entryPrice); }
            return;
        } else if(activePos.symbol !== 'NONE') {
            await binanceReq('/fapi/v1/allOpenOrders', { symbol: activePos.symbol }, 'DELETE');
            await binanceReq('/fapi/v1/algoOpenOrders', { symbol: activePos.symbol }, 'DELETE'); 
            activePos = { symbol: 'NONE', startTime: 0, mode: 'NORMAL', extremum: null };
        }

        for(const sym of SYMBOLS) {
            await new Promise(r => setTimeout(r, 300));
            const k = await fetchKlines(sym);
            if(!k) continue;
            const rsi = calcRSI(k);
            
            const liveC = k[k.length-1].c;
            const recentL = Math.min(k[k.length-1].l, k[k.length-2].l); 
            const recentH = Math.max(k[k.length-1].h, k[k.length-2].h); 

            // 🟢 做多：宏观大饼不能暴跌 (不能小于 -1.2%)
            if(rsi < RSI_BUY_LINE && btcMacroChange > MACRO_STORM_DOWN && liveC >= recentL * (1 + BOUNCE_CONFIRM)) {
                await executeTrade(sym, 'BUY', liveC, recentL);
                break;
            }
            // 🔴 做空：宏观大饼不能暴涨 (不能大于 1.2%)
            if(rsi > RSI_SELL_LINE && btcMacroChange < MACRO_STORM_UP && liveC <= recentH * (1 - BOUNCE_CONFIRM)) {
                await executeTrade(sym, 'SELL', liveC, recentH);
                break;
            }
        }
    } finally { isProcessing = false; }
}

async function executeTrade(symbol, side, price, extremum) {
    if(!precisions[symbol]) return;
    await binanceReq('/fapi/v1/leverage', { symbol: symbol, leverage: LEVERAGE }, 'POST');
    
    let notional = currentBalance * POSITION_RISK_PERCENT * LEVERAGE;
    if (notional < 6.5) notional = 6.5; 
    const qty = (notional / price).toFixed(precisions[symbol].q);
    
    const res = await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: qty });
    
    if(res && res.code === undefined) {
        activePos = { symbol, status: side==='BUY'?'LONG':'SHORT', entryPrice: price, qty: parseFloat(qty), extremum: extremum, startTime: Date.now(), mode: 'NORMAL' };
        sendFeishu("🔥 顺势开仓", `标的: ${symbol}\n方向: ${side}\n已通过 1小时宏观趋势 过滤！`);
        setTimeout(async () => {
            const risk = await binanceReq('/fapi/v2/positionRisk', {symbol: symbol}, 'GET');
            const exactEntry = (Array.isArray(risk) && risk.length > 0) ? parseFloat(risk[0].entryPrice) : price;
            await setAlgoSecurity(symbol, activePos.status, exactEntry);
        }, 2000);
    }
}

http.createServer((req,res)=>{ res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(`<h1>V32.0 宏观天眼版运行中</h1>`); }).listen(process.env.PORT||3000);
setInterval(runMonitor, 60000); runMonitor();
