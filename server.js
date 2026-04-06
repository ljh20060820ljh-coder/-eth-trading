const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

process.on('uncaughtException', (err) => { console.error('🔥 [护盾] 异常:', err.message); });
process.on('unhandledRejection', (reason) => { console.error('🔥 [护盾] 拒绝:', reason); });

// ==========================================
// 🔐 V38.0 绝对反指之王 (原汁原味触发，100%反向开仓)
// ==========================================
const FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK || "https://open.feishu.cn/open-apis/bot/v2/hook/6099f609-41c4-4364-b0d8-fdb986b821a2"; 
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

const SYMBOLS = ['SOLUSDT', 'DOGEUSDT', 'ORDIUSDT', 'INJUSDT', 'PEPEUSDT', 'WIFUSDT', 'BONKUSDT', '1000SATSUSDT', 'ARBUSDT', 'TIAUSDT']; 
let precisions = {}; 

const LEVERAGE = 10;                
const POSITION_RISK_PERCENT = 0.5;  

const MOMENTUM_CHECK_MINUTES = 30; 
const MOMENTUM_MIN_PROFIT = 0.01;  
const PROTECT_PROFIT_TRIGGER = 0.01; 
const PROTECT_PROFIT_RETRACEMENT = 0.003; 

const MACRO_STORM_UP = 1.2;    
const MACRO_STORM_DOWN = -1.2; 
const RSI_BUY_LINE = 30;  
const RSI_SELL_LINE = 70; 
const BOUNCE_CONFIRM = 0.005; // 经典的 0.5% 反弹确认

const RR_RATIO = 1.5;         
const MIN_SL_PERCENT = 0.008; 
const MAX_SL_PERCENT = 0.035; 
const EXTREMUM_BUFFER = 0.002; 

let isProcessing = false; 
let activePos = { symbol: 'NONE', status: 'NONE', entryPrice: 0, qty: 0, extremum: null, startTime: 0, maxPnl: 0, mode: 'NORMAL' };
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
        sendFeishu("🚀 终极反指系统上线 (V38.0)", "既然这套算法稳定亏损，那它就是神！\n系统已恢复经典亏损触发条件，并在下单瞬间强制 100% 镜像反向开仓！");
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
    let slP, tpP;
    const ext = activePos.extremum;
    
    // 防线自动适配反向订单
    if (ext) {
        if (status === 'LONG') {
            let sl = Math.max(ext * (1 - EXTREMUM_BUFFER), entry * (1 - MAX_SL_PERCENT));
            let tp = entry + (entry - sl) * RR_RATIO;
            slP = sl.toFixed(precisions[symbol].p); tpP = tp.toFixed(precisions[symbol].p);
        } else {
            let sl = Math.min(ext * (1 + EXTREMUM_BUFFER), entry * (1 + MAX_SL_PERCENT));
            let tp = entry - (sl - entry) * RR_RATIO;
            slP = sl.toFixed(precisions[symbol].p); tpP = tp.toFixed(precisions[symbol].p);
        }
    } else {
        slP = (status === 'LONG' ? entry * 0.98 : entry * 1.02).toFixed(precisions[symbol].p);
        tpP = (status === 'LONG' ? entry * 1.03 : entry * 0.97).toFixed(precisions[symbol].p);
    }
    await binanceReq('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol: symbol, side: revSide, type: 'STOP_MARKET', triggerPrice: slP, closePosition: 'true' }, 'POST');
    await binanceReq('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol: symbol, side: revSide, type: 'TAKE_PROFIT_MARKET', triggerPrice: tpP, closePosition: 'true' }, 'POST');
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
        
        const btcK = await fetchKlines('BTCUSDT');
        const btcMacro = (btcK && btcK.length >= 5) ? ((btcK[btcK.length-1].c - btcK[btcK.length-5].o) / btcK[btcK.length-5].o) * 100 : 0;

        if(pos) {
            activePos.symbol = pos.symbol;
            activePos.status = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
            activePos.qty = Math.abs(parseFloat(pos.positionAmt));
            activePos.entryPrice = parseFloat(pos.entryPrice);
            if(activePos.startTime === 0) activePos.startTime = Date.now();

            const minutesElapsed = (Date.now() - activePos.startTime) / 60000;
            const currentPrice = parseFloat(pos.markPrice);
            const pnlPercent = activePos.status === 'LONG' 
                ? (currentPrice - activePos.entryPrice) / activePos.entryPrice 
                : (activePos.entryPrice - currentPrice) / activePos.entryPrice;

            if (!activePos.maxPnl) activePos.maxPnl = 0;
            if (pnlPercent > activePos.maxPnl) activePos.maxPnl = pnlPercent;

            if (activePos.maxPnl >= PROTECT_PROFIT_TRIGGER) {
                if (pnlPercent <= PROTECT_PROFIT_RETRACEMENT) {
                    sendFeishu("🛡️ 反指系统止盈", `[${pos.symbol}] 果然反向操作就是神！浮盈已达标回落，成功落袋！`);
                    await binanceReq('/fapi/v1/order', { symbol: pos.symbol, side: activePos.status === 'LONG' ? 'SELL' : 'BUY', type: 'MARKET', quantity: activePos.qty });
                    return;
                }
            } else {
                if (minutesElapsed >= MOMENTUM_CHECK_MINUTES && pnlPercent < MOMENTUM_MIN_PROFIT) {
                    sendFeishu("⚡ 反指系统撤军", `[${pos.symbol}] 反向操作也未能起飞，平仓撤退保底！`);
                    await binanceReq('/fapi/v1/order', { symbol: pos.symbol, side: activePos.status === 'LONG' ? 'SELL' : 'BUY', type: 'MARKET', quantity: activePos.qty });
                    return;
                }
            }

            const algoOrders = await binanceReq('/fapi/v1/openAlgoOrders', { symbol: pos.symbol }, 'GET');
            if(!JSON.stringify(algoOrders).includes('STOP_MARKET')) { await setAlgoSecurity(pos.symbol, activePos.status, activePos.entryPrice); }
            return;
        } else if(activePos.symbol !== 'NONE') {
            await binanceReq('/fapi/v1/allOpenOrders', { symbol: activePos.symbol }, 'DELETE');
            await binanceReq('/fapi/v1/algoOpenOrders', { symbol: activePos.symbol }, 'DELETE'); 
            activePos = { symbol: 'NONE', startTime: 0, mode: 'NORMAL', extremum: null, maxPnl: 0 };
        }

        for(const sym of SYMBOLS) {
            await new Promise(r => setTimeout(r, 300));
            const k = await fetchKlines(sym);
            if(!k) continue;
            const rsi = calcRSI(k);
            const liveC = k[k.length-1].c, recentL = Math.min(k[k.length-1].l, k[k.length-2].l), recentH = Math.max(k[k.length-1].h, k[k.length-2].h); 

            // ============================================
            // 😈 核心：原汁原味的亏损触发条件，执行 100% 镜像反向！
            // ============================================
            
            // 曾经的“去抄底必亏”形态：RSI跌破30，且价格刚刚比最低点反弹了 0.5% (自以为跌到底了)
            // 现在的反转执行：它觉得跌到底了，老子偏觉得这是“假反弹”，直接做空 (SELL)！
            if(rsi < RSI_BUY_LINE && btcMacro > MACRO_STORM_DOWN && liveC >= recentL * (1 + BOUNCE_CONFIRM)) {
                console.log(`\n😈 [${sym}] RSI=${rsi.toFixed(2)}，经典假反弹出现！按原计划该去抄底送死了，咱们直接反转做空！`);
                // 传 recentH 进去，因为做空止损要挂在上面
                await executeTrade(sym, 'SELL', liveC, recentH); 
                break;
            }
            
            // 曾经的“去摸顶必亏”形态：RSI冲破70，且价格刚刚比最高点回落了 0.5% (自以为涨到头了)
            // 现在的反转执行：它觉得涨到头了，老子偏觉得这是“假回落洗盘”，直接做多 (BUY)！
            if(rsi > RSI_SELL_LINE && btcMacro < MACRO_STORM_UP && liveC <= recentH * (1 - BOUNCE_CONFIRM)) {
                console.log(`\n😈 [${sym}] RSI=${rsi.toFixed(2)}，经典洗盘出现！按原计划该去摸顶被拉爆了，咱们直接反转做多！`);
                // 传 recentL 进去，因为做多止损要挂在下面
                await executeTrade(sym, 'BUY', liveC, recentL); 
                break;
            }
        }
    } finally { isProcessing = false; }
}

async function executeTrade(symbol, side, price, extremum) {
    if(!precisions[symbol]) return;
    await binanceReq('/fapi/v1/leverage', { symbol: symbol, leverage: LEVERAGE }, 'POST');
    let notional = Math.max(currentBalance * POSITION_RISK_PERCENT * LEVERAGE, 6.5);
    const qty = (notional / price).toFixed(precisions[symbol].q);
    const res = await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: qty });
    if(res && res.code === undefined) {
        activePos = { symbol, status: side==='BUY'?'LONG':'SHORT', entryPrice: price, qty: parseFloat(qty), extremum: extremum, startTime: Date.now(), maxPnl: 0, mode: 'NORMAL' };
        sendFeishu("🔥 反指之王已开仓", `标的: ${symbol}\n方向: ${side}\n系统触发了原版的死亡抄底/摸顶逻辑，咱们已完美反向操作！`);
        setTimeout(async () => { await setAlgoSecurity(symbol, activePos.status, price); }, 2000);
    }
}

http.createServer((req,res)=>{ res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(`<h1>V38.0 绝对反指之王</h1>`); }).listen(process.env.PORT||3000);
setInterval(runMonitor, 60000); runMonitor();
