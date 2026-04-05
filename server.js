const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ==========================================
// 🛡️ 全局护盾
// ==========================================
process.on('uncaughtException', (err) => { console.error('🔥 [护盾] 拦截致命异常:', err.message); });
process.on('unhandledRejection', (reason) => { console.error('🔥 [护盾] 拦截Promise异常:', reason); });

// ==========================================
// 🔐 V31.0 动态结构防守版 (前低防守 + 1:1.5盈亏比)
// ==========================================
const FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK || "https://open.feishu.cn/open-apis/bot/v2/hook/6099f609-41c4-4364-b0d8-fdb986b821a2"; 
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

const SYMBOLS = ['SOLUSDT', 'DOGEUSDT', 'ORDIUSDT', 'INJUSDT', 'PEPEUSDT', 'WIFUSDT', 'BONKUSDT', '1000SATSUSDT', 'ARBUSDT', 'TIAUSDT']; 
let precisions = {}; 

const LEVERAGE = 10;                
const POSITION_RISK_PERCENT = 0.5;  
const BTC_STORM = 1.2;              

const RSI_BUY_LINE = 30;  
const RSI_SELL_LINE = 70; 
const BOUNCE_CONFIRM = 0.005; // 0.5% 实体反弹

// 🎯 动态防守参数 (Risk:Reward = 1:1.5)
const RR_RATIO = 1.5;         // 盈亏比 1.5 倍
const MIN_SL_PERCENT = 0.008; // 最低止损容忍度 0.8%
const MAX_SL_PERCENT = 0.035; // 最高止损容忍度 3.5% (物理底线)
const EXTREMUM_BUFFER = 0.002; // 前低前高外的缓冲带 0.2%

let isProcessing = false; 
// 🎯 增加了 extremum(极值记录)
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
    console.log("🔄 正在同步币安底层 API 精度...");
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
        sendFeishu("🚀 战车已进化 (V31.0)", "动态结构防线已装载！\n逻辑失效点止损，1:1.5盈亏比放飞利润。");
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

// 🧠 核心：计算动态防线
async function setAlgoSecurity(symbol, status, entry) {
    if(!precisions[symbol]) return false;
    const revSide = status === 'LONG' ? 'SELL' : 'BUY';
    
    let slP, tpP, riskPercent;
    const ext = activePos.extremum;

    // 结构性止损算法
    if (ext) {
        if (status === 'LONG') {
            let sl = ext * (1 - EXTREMUM_BUFFER); // 放在前低下方 0.2%
            riskPercent = (entry - sl) / entry;
            if (riskPercent < MIN_SL_PERCENT) { sl = entry * (1 - MIN_SL_PERCENT); riskPercent = MIN_SL_PERCENT; }
            if (riskPercent > MAX_SL_PERCENT) { sl = entry * (1 - MAX_SL_PERCENT); riskPercent = MAX_SL_PERCENT; }
            
            let tp = entry + (entry - sl) * RR_RATIO;
            slP = sl.toFixed(precisions[symbol].p);
            tpP = tp.toFixed(precisions[symbol].p);
        } else {
            let sl = ext * (1 + EXTREMUM_BUFFER); // 放在前高上方 0.2%
            riskPercent = (sl - entry) / entry;
            if (riskPercent < MIN_SL_PERCENT) { sl = entry * (1 + MIN_SL_PERCENT); riskPercent = MIN_SL_PERCENT; }
            if (riskPercent > MAX_SL_PERCENT) { sl = entry * (1 + MAX_SL_PERCENT); riskPercent = MAX_SL_PERCENT; }
            
            let tp = entry - (sl - entry) * RR_RATIO;
            slP = sl.toFixed(precisions[symbol].p);
            tpP = tp.toFixed(precisions[symbol].p);
        }
    } else {
        // 如果断线重连，缺失极值记忆，采用备用 2% 止损 / 3% 止盈
        slP = (status === 'LONG' ? entry * 0.98 : entry * 1.02).toFixed(precisions[symbol].p);
        tpP = (status === 'LONG' ? entry * 1.03 : entry * 0.97).toFixed(precisions[symbol].p);
        riskPercent = 0.02;
    }
    
    await binanceReq('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol: symbol, side: revSide, type: 'STOP_MARKET', triggerPrice: slP, closePosition: 'true' }, 'POST');
    if(activePos.mode === 'NORMAL') {
        await binanceReq('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol: symbol, side: revSide, type: 'TAKE_PROFIT_MARKET', triggerPrice: tpP, closePosition: 'true' }, 'POST');
    }
    
    sendFeishu("🛡️ 动态防线已焊死", `[${symbol}] ${status}\n开仓: ${entry}\n止损(前低高防守): ${slP} (风险: ${(riskPercent*100).toFixed(2)}%)\n止盈(1.5倍放飞): ${tpP}`);
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
        const btcChange = btcK ? ((btcK[btcK.length-1].c - btcK[btcK.length-2].c) / btcK[btcK.length-2].c) * 100 : 0;
        
        console.log(`${['🛡️','📈','📉','⚙️','⚡'][Math.floor(Math.random()*5)]} [${getBJTime()}] 资产: ${currentBalance.toFixed(3)} U | 状态: ${pos?'🔴 战术激战中':'🟢 阵地扫描中'}`);

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
            sendFeishu("🏁 战斗结束清场", `[${activePos.symbol}] 仓位已平。\n当前资产: ${currentBalance.toFixed(3)} U`);
            activePos = { symbol: 'NONE', startTime: 0, mode: 'NORMAL', extremum: null };
        }

        for(const sym of SYMBOLS) {
            await new Promise(r => setTimeout(r, 300));
            const k = await fetchKlines(sym);
            if(!k) continue;
            const rsi = calcRSI(k);
            
            const liveC = k[k.length-1].c;
            // 抓取包含上一根和这一根的最极值点
            const recentL = Math.min(k[k.length-1].l, k[k.length-2].l); 
            const recentH = Math.max(k[k.length-1].h, k[k.length-2].h); 

            // 🟢 多单反击
            if(rsi < RSI_BUY_LINE && !(Math.abs(btcChange) >= BTC_STORM && btcChange < 0) && liveC >= recentL * (1 + BOUNCE_CONFIRM)) {
                console.log(`\n🏹 [${sym}] RSI=${rsi.toFixed(2)}，触底 ${recentL} 后反弹，开火做多！`);
                await executeTrade(sym, 'BUY', liveC, recentL);
                break;
            }
            // 🔴 空单反击
            if(rsi > RSI_SELL_LINE && !(Math.abs(btcChange) >= BTC_STORM && btcChange > 0) && liveC <= recentH * (1 - BOUNCE_CONFIRM)) {
                console.log(`\n🏹 [${sym}] RSI=${rsi.toFixed(2)}，触顶 ${recentH} 后回落，开火做空！`);
                await executeTrade(sym, 'SELL', liveC, recentH);
                break;
            }
        }
    } finally { isProcessing = false; }
}

// 注意这里多传了一个参数: extremum
async function executeTrade(symbol, side, price, extremum) {
    if(!precisions[symbol]) return;
    await binanceReq('/fapi/v1/leverage', { symbol: symbol, leverage: LEVERAGE }, 'POST');
    
    let notional = currentBalance * POSITION_RISK_PERCENT * LEVERAGE;
    if (notional < 6.5) notional = 6.5; 
    const qty = (notional / price).toFixed(precisions[symbol].q);
    
    console.log(`🚀 发起战术突击 [${symbol}]！方向: ${side} 量能: ${qty}...`);
    const res = await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: qty });
    
    if(res && res.code === undefined) {
        // 把提取到的前低/前高存入内存，留给挂单函数用
        activePos = { symbol, status: side==='BUY'?'LONG':'SHORT', entryPrice: price, qty: parseFloat(qty), extremum: extremum, startTime: Date.now(), mode: 'NORMAL' };
        
        setTimeout(async () => {
            const risk = await binanceReq('/fapi/v2/positionRisk', {symbol: symbol}, 'GET');
            const exactEntry = (Array.isArray(risk) && risk.length > 0) ? parseFloat(risk[0].entryPrice) : price;
            await setAlgoSecurity(symbol, activePos.status, exactEntry);
        }, 2000);
    } else {
        console.error(`❌ 开火受阻: ${res.msg}`);
    }
}

http.createServer((req,res)=>{ 
    res.setHeader('Content-Type','text/html; charset=utf-8'); 
    res.end(`<h1>V31.0 结构性防守版运行中</h1><p>资产状态: ${currentBalance.toFixed(3)} U</p>`); 
}).listen(process.env.PORT||3000);

setInterval(runMonitor, 60000); 
runMonitor();
