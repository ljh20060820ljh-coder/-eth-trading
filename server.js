const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ==========================================
// 🔐 V27.0 Algo 算法通道版 (适配币安 2025-12 强更规则)
// ==========================================
const FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK || "https://open.feishu.cn/open-apis/bot/v2/hook/6099f609-41c4-4364-b0d8-fdb986b821a2"; 
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

const SYMBOLS = ['SOLUSDT', 'DOGEUSDT', 'ORDIUSDT', 'INJUSDT', 'PEPEUSDT', 'WIFUSDT', 'BONKUSDT', '1000SATSUSDT', 'ARBUSDT', 'TIAUSDT']; 
let precisions = {}; 

const LEVERAGE = 10;                
const POSITION_RISK_PERCENT = 0.5;  
const SL_HARD = 3.5;                
const TP_FIXED = 1.5;               
const BTC_STORM = 1.2;              

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
            res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve({code:-999, msg: 'Parse Error'}); } });
        });
        req.on('error', (e) => resolve({code:-999, msg: e.message})); if (method === 'POST') req.write(data); req.end();
    });
}

// 动态精度获取
async function initPrecisions() {
    console.log("🔄 正在向币安总机请求最新精度规则...");
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
        console.log("✅ 精度规则库装载完毕");
        sendFeishu("🔄 战车装填完毕", "已成功同步币安底层 API 精度规则，彻底告别挂单拒收。");
    }
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

// 🎯 核心重写：全面接入币安最新 Algo 算法防线接口
async function setAlgoSecurity(symbol, status, entry) {
    if(!precisions[symbol]) return false;
    const revSide = status === 'LONG' ? 'SELL' : 'BUY';
    const slP = (status === 'LONG' ? entry * (1 - SL_HARD/100) : entry * (1 + SL_HARD/100)).toFixed(precisions[symbol].p);
    const tpP = (status === 'LONG' ? entry * (1 + TP_FIXED/100) : entry * (1 - TP_FIXED/100)).toFixed(precisions[symbol].p);
    
    console.log(`⏳ 正在挂载新版 Algo 防线 -> SL: ${slP}, TP: ${tpP}`);
    
    // 1. Algo 专属止损通道 (注意必须有 algoType 和 triggerPrice)
    const slRes = await binanceReq('/fapi/v1/algoOrder', { 
        algoType: 'CONDITIONAL', symbol: symbol, side: revSide, type: 'STOP_MARKET', triggerPrice: slP, closePosition: 'true' 
    }, 'POST');
    
    // 2. Algo 专属止盈通道
    let tpRes = {code: 0};
    if(activePos.mode === 'NORMAL') {
        tpRes = await binanceReq('/fapi/v1/algoOrder', { 
            algoType: 'CONDITIONAL', symbol: symbol, side: revSide, type: 'TAKE_PROFIT_MARKET', triggerPrice: tpP, closePosition: 'true' 
        }, 'POST');
    }
    
    if(slRes.code || tpRes.code) {
        const errorMsg = `SL Algo报错: ${slRes.msg || '无'} | TP Algo报错: ${tpRes.msg || '无'}`;
        console.error(`❌ [${symbol}] Algo 防线挂载失败: ${errorMsg}`);
        sendFeishu("🚨 致命警告：防线崩塌", `[${symbol}] Algo 算法通道拒收！\n详情: ${errorMsg}\n请立即手动接管！`);
        return false;
    }
    console.log(`🛡️ [${symbol}] Algo 算法双保险已死死焊牢！`);
    sendFeishu("🛡️ 防线加固完毕", `[${symbol}] 止损: ${slP} | 止盈: ${tpP}`);
    return true;
}

async function runMonitor() {
    if (isProcessing) return; isProcessing = true;
    try {
        if(Object.keys(precisions).length === 0) { await initPrecisions(); if(Object.keys(precisions).length === 0) return; }

        const risk = await binanceReq('/fapi/v2/positionRisk', {}, 'GET');
        const wallet = await binanceReq('/fapi/v2/account', {}, 'GET');
        if(!wallet.totalMarginBalance) return;
        currentBalance = parseFloat(wallet.totalMarginBalance);

        const pos = Array.isArray(risk) ? risk.find(x => Math.abs(parseFloat(x.positionAmt)) > 0) : null;
        const btcK = await fetchKlines('BTCUSDT');
        const btcChange = btcK ? ((btcK[btcK.length-1].c - btcK[btcK.length-2].c) / btcK[btcK.length-2].c) * 100 : 0;
        
        console.log(`${['🔥','⚔️','🛡️'][Math.floor(Math.random()*3)]} [${getBJTime()}] 资产:${currentBalance.toFixed(3)}U | 大饼:${btcChange.toFixed(2)}% | 状态:${pos?'🔴血战中':'🟢雷达扫描中'}`);

        if(pos) {
            activePos.symbol = pos.symbol;
            activePos.status = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
            activePos.qty = Math.abs(parseFloat(pos.positionAmt));
            activePos.entryPrice = parseFloat(pos.entryPrice);
            if(activePos.startTime === 0) activePos.startTime = Date.now();

            // 🚨 死循环检查：通过 Algo 接口查询是否有止损 (绝不放过)
            const algoOrders = await binanceReq('/fapi/v1/openAlgoOrders', { symbol: pos.symbol }, 'GET');
            const hasSL = JSON.stringify(algoOrders).includes('STOP_MARKET');
            if(!hasSL) {
                console.log(`⚠️ 警报: 发现裸奔仓位！正在强制注入 Algo 装甲...`);
                await setAlgoSecurity(pos.symbol, activePos.status, activePos.entryPrice);
            }
            return;
        } else if(activePos.symbol !== 'NONE') {
            // 平仓后的深度清场：普通委托和 Algo 委托全部剿灭
            await binanceReq('/fapi/v1/allOpenOrders', { symbol: activePos.symbol }, 'DELETE');
            await binanceReq('/fapi/v1/algoOpenOrders', { symbol: activePos.symbol }, 'DELETE'); 
            activePos = { symbol: 'NONE', startTime: 0, mode: 'NORMAL' };
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
    if(!precisions[symbol]) return;
    await binanceReq('/fapi/v1/leverage', { symbol: symbol, leverage: LEVERAGE }, 'POST');
    
    let notional = currentBalance * POSITION_RISK_PERCENT * LEVERAGE;
    if (notional < 6) notional = 6.5; 
    const qty = (notional / price).toFixed(precisions[symbol].q);
    
    console.log(`🚀 发起突击 [${symbol}]！方向: ${side} 量能: ${qty}...`);
    const res = await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: qty });
    
    if(res && res.code === undefined) {
        activePos = { symbol, status: side==='BUY'?'LONG':'SHORT', entryPrice: price, qty: parseFloat(qty), startTime: Date.now(), mode };
        sendFeishu("🔥 重火力开仓", `标的: ${symbol}\n方向: ${side}\n尝试挂载新版 Algo 算法防线...`);
        
        setTimeout(async () => {
            const risk = await binanceReq('/fapi/v2/positionRisk', {symbol: symbol}, 'GET');
            const exactEntry = (Array.isArray(risk) && risk.length > 0) ? parseFloat(risk[0].entryPrice) : price;
            await setAlgoSecurity(symbol, activePos.status, exactEntry);
        }, 2000);
    } else { console.error(`❌ 开火受阻: ${res.msg}`); }
}

http.createServer((req,res)=>{ res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(`<h1>V27.0 Algo算法通道版 运行中</h1>`); }).listen(process.env.PORT||3000);
setInterval(runMonitor, 60000); runMonitor();
