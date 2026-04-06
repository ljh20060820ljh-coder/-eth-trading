const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

let globalLog = "⏳ 系统初始化中，请等待首次雷达扫描...";

process.on('uncaughtException', (err) => { globalLog = `🔥 [致命异常] ${err.message}`; });
process.on('unhandledRejection', (reason) => { globalLog = `🔥 [Promise拒绝] ${reason}`; });

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
const BOUNCE_CONFIRM = 0.005; 

const RR_RATIO = 1.5;         
const MIN_SL_PERCENT = 0.008; 
const MAX_SL_PERCENT = 0.035; 
const EXTREMUM_BUFFER = 0.002; 

let isProcessing = false; 
let activePos = { symbol: 'NONE', status: 'NONE', entryPrice: 0, qty: 0, extremum: null, startTime: 0, maxPnl: 0, mode: 'NORMAL' };
let currentBalance = 0;
let btcMacroChange = 0;

function getBJTime() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }

function updateLog(msg) {
    const t = getBJTime();
    console.log(`[${t}] ${msg}`);
    globalLog = `[${t}]<br>${msg}`; // 将日志同步到网页端
}

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
        let data = query;
        let options = { hostname: 'fapi.binance.com', method, headers: { 'X-MBX-APIKEY': BINANCE_API_KEY }, timeout: 10000 };
        
        if (BINANCE_API_SECRET) {
            const sig = crypto.createHmac('sha256', BINANCE_API_SECRET).update(query).digest('hex');
            data = `${query}&signature=${sig}`;
        }
        
        options.path = method === 'GET' ? `${path}?${data}` : path;
        
        const req = https.request(options, res => {
            let b = ''; res.on('data', c => b += c);
            res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve({code:-999, msg: 'JSON解析失败'}); } });
        });
        req.on('error', (e) => resolve({code:-999, msg: e.message})); 
        if (method === 'POST') req.write(data); 
        req.end();
    });
}

async function initPrecisions() {
    updateLog("🔄 正在连接币安总机同步精度...");
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
        updateLog("✅ 精度数据加载成功，允许开火！");
        sendFeishu("🚀 独立网页监控版上线 (V38.2)", "反指逻辑继续执行，请直接刷新网页查看最新战况！");
    } else {
        updateLog(`❌ 致命错误：获取精度失败，API Key 是否正确？详细返回: ${JSON.stringify(data).substring(0, 100)}`);
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
        
        if(!wallet || !wallet.totalMarginBalance) {
            updateLog(`❌ 无法获取资产！API是否过期？返回信息: ${JSON.stringify(wallet).substring(0, 100)}`);
            return;
        }
        
        currentBalance = parseFloat(wallet.totalMarginBalance);
        const pos = Array.isArray(risk) ? risk.find(x => Math.abs(parseFloat(x.positionAmt)) > 0) : null;
        
        const btcK = await fetchKlines('BTCUSDT');
        btcMacroChange = (btcK && btcK.length >= 5) ? ((btcK[btcK.length-1].c - btcK[btcK.length-5].o) / btcK[btcK.length-5].o) * 100 : 0;

        updateLog(`✅ 雷达扫描正常 | 状态: ${pos?'🔴持仓中':'🟢雷达静默探测中'}`);

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
                    updateLog(`🛡️ [${pos.symbol}] 利润护盾触发，强制落袋！`);
                    sendFeishu("🛡️ 反指系统止盈", `[${pos.symbol}] 成功落袋！`);
                    await binanceReq('/fapi/v1/order', { symbol: pos.symbol, side: activePos.status === 'LONG' ? 'SELL' : 'BUY', type: 'MARKET', quantity: activePos.qty });
                    return;
                }
            } else {
                if (minutesElapsed >= MOMENTUM_CHECK_MINUTES && pnlPercent < MOMENTUM_MIN_PROFIT) {
                    updateLog(`⚡ [${pos.symbol}] 动能不足，撤军保本！`);
                    sendFeishu("⚡ 反指系统撤军", `[${pos.symbol}] 未起飞，平仓！`);
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

            if(rsi < RSI_BUY_LINE && btcMacroChange > MACRO_STORM_DOWN && liveC >= recentL * (1 + BOUNCE_CONFIRM)) {
                updateLog(`😈 [${sym}] RSI=${rsi.toFixed(2)} 经典假底，【反指追空】！`);
                await executeTrade(sym, 'SELL', liveC, recentH); 
                break;
            }
            if(rsi > RSI_SELL_LINE && btcMacroChange < MACRO_STORM_UP && liveC <= recentH * (1 - BOUNCE_CONFIRM)) {
                updateLog(`😈 [${sym}] RSI=${rsi.toFixed(2)} 经典假顶，【反指追多】！`);
                await executeTrade(sym, 'BUY', liveC, recentL); 
                break;
            }
        }
    } catch (err) {
        updateLog(`❌ 运行出现报错: ${err.message}`);
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
        updateLog(`🚀 成功反指开仓 [${symbol}]，方向: ${side}`);
        sendFeishu("🔥 反指之王已开仓", `标的: ${symbol}\n方向: ${side}`);
        setTimeout(async () => { await setAlgoSecurity(symbol, activePos.status, price); }, 2000);
    } else {
        updateLog(`❌ 开仓失败: ${res.msg}`);
    }
}

// ==========================================
// 🖥️ 独立可视化雷达大屏！抛弃 Render 控制台！
// ==========================================
http.createServer((req, res) => { 
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); 
    res.end(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>V38.2 战术雷达</title>
            <style>
                body { font-family: -apple-system, sans-serif; background: #121212; color: #E0E0E0; padding: 20px; line-height: 1.6; }
                h2 { color: #4CAF50; border-bottom: 1px solid #333; padding-bottom: 10px; }
                .panel { background: #1E1E1E; padding: 15px; border-radius: 8px; margin-bottom: 15px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
                .val { font-size: 1.2em; font-weight: bold; color: #FF9800; }
                .log-box { background: #000; color: #0f0; font-family: monospace; padding: 12px; border-radius: 5px; word-wrap: break-word; border: 1px solid #333;}
                .tip { color: #888; font-size: 0.85em; margin-top: 20px; text-align: center;}
            </style>
        </head>
        <body>
            <h2>🚀 V38.2 独立战术监控大屏</h2>
            <div class="panel">
                <div>💰 <b>当前兵力 (可用U):</b> <span class="val">${currentBalance.toFixed(3)} U</span></div>
                <div>📈 <b>宏观大饼 (1H涨跌):</b> <span class="val">${btcMacroChange.toFixed(2)}%</span></div>
                <div>🎯 <b>当前开火阵地:</b> <span class="val">${activePos.symbol} (${activePos.status})</span></div>
            </div>
            
            <h3>📡 最新战况播报 (取代控制台):</h3>
            <div class="log-box">
                > ${globalLog}
            </div>

            <div class="tip">💡 提示：按住屏幕下拉刷新，即可获取最新数据。彻底告别 Render 黑屏瞎猜！</div>
        </body>
        </html>
    `); 
}).listen(process.env.PORT || 3000);

setInterval(runMonitor, 60000); 
runMonitor();
