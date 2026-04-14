const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ==========================================
// 🖥️ 全局雷达日志系统 (脱离 Render 控制台)
// ==========================================
let globalLog = "⏳ 刺客 V40.0 已潜伏，等待首次雷达扫描...";

process.on('uncaughtException', (err) => { globalLog = `🔥 [致命异常] ${err.message}`; });
process.on('unhandledRejection', (reason) => { globalLog = `🔥 [Promise拒绝] ${reason}`; });

function getBJTime() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }

function updateLog(msg) {
    const t = getBJTime();
    console.log(`[${t}] ${msg}`);
    const logs = globalLog.split('<br>');
    if (logs.length > 10) logs.pop(); 
    globalLog = `[${t}] ${msg}<br>` + logs.join('<br>');
}

// ==========================================
// 🔐 V40.0 刺客终极版 (双级别共振 + 趋势过滤)
// ==========================================
const FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK || "https://open.feishu.cn/open-apis/bot/v2/hook/6099f609-41c4-4364-b0d8-fdb986b821a2"; 
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

const SYMBOLS = ['SOLUSDT', 'DOGEUSDT', 'PEPEUSDT', 'WIFUSDT', 'ARBUSDT']; 
let precisions = {}; 
let lastTradedCandleTime = {}; // 🛑 新增：防重复开仓锁

const LEVERAGE = 10;                
const POSITION_RISK_PERCENT = 0.5;  

// 🗡️ 主力猎杀参数
const VOLUME_SPIKE_MULTIPLIER = 2.0; 
const WICK_BODY_RATIO = 2.0;         
const MACRO_STORM_LIMIT = 1.5;       

// 🛡️ 防线参数 
const RR_RATIO = 2.0;                
const EXTREMUM_BUFFER = 0.006;       
const MIN_SL_PERCENT = 0.008;        
const MAX_SL_PERCENT = 0.035;        

let isProcessing = false; 
let activePos = { symbol: 'NONE', status: 'NONE', entryPrice: 0, qty: 0, extremum: null, startTime: 0, mode: 'NORMAL' };
let currentBalance = 0;
let btcMacroChange = 0;

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
            res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve({code:-999}); } });
        });
        req.on('error', () => resolve({code:-999})); 
        if (method === 'POST') req.write(data); req.end();
    });
}

async function initPrecisions() {
    updateLog("🔄 战车重装系统：加载 V40.0 双级别共振算法...");
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
        updateLog("✅ 刺客就位！顺势防线构建完毕，允许自由开火！");
        sendFeishu("🚀 V40.0 刺客完全体", "底层架构刷新完毕！\n已引入 1H EMA20 趋势过滤与收盘确认机制。");
    } else {
        updateLog("❌ API权限错误或网络阻断，无法获取交易精度！");
    }
}

// 📈 核心修改：支持动态传参 interval，获取开盘时间 t
async function fetchKlines(symbol, interval = '15m') {
    return new Promise((resolve) => {
        https.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=25`, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { 
                try { 
                    const raw = JSON.parse(d); 
                    resolve(Array.isArray(raw) ? raw.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })) : null); 
                } catch(e) { resolve(null); } 
            });
        }).on('error', () => resolve(null));
    });
}

// 📈 核心计算：EMA (指数移动平均线)
function calculateEMA(closes, period) {
    let ema = [closes[0]];
    const multiplier = 2 / (period + 1);
    for (let i = 1; i < closes.length; i++) {
        ema.push((closes[i] - ema[i - 1]) * multiplier + ema[i - 1]);
    }
    return ema;
}

async function setAlgoSecurity(symbol, status, entry) {
    if(!precisions[symbol]) return false;
    const revSide = status === 'LONG' ? 'SELL' : 'BUY';
    let slP, tpP;
    const ext = activePos.extremum; 
    
    if (ext) {
        if (status === 'LONG') {
            let sl = Math.max(ext * (1 - EXTREMUM_BUFFER), entry * (1 - MAX_SL_PERCENT));
            if ((entry - sl)/entry < MIN_SL_PERCENT) sl = entry * (1 - MIN_SL_PERCENT);
            let tp = entry + (entry - sl) * RR_RATIO;
            slP = sl.toFixed(precisions[symbol].p); tpP = tp.toFixed(precisions[symbol].p);
        } else {
            let sl = Math.min(ext * (1 + EXTREMUM_BUFFER), entry * (1 + MAX_SL_PERCENT));
            if ((sl - entry)/entry < MIN_SL_PERCENT) sl = entry * (1 + MIN_SL_PERCENT);
            let tp = entry - (sl - entry) * RR_RATIO;
            slP = sl.toFixed(precisions[symbol].p); tpP = tp.toFixed(precisions[symbol].p);
        }
    } else {
        slP = (status === 'LONG' ? entry * 0.98 : entry * 1.02).toFixed(precisions[symbol].p);
        tpP = (status === 'LONG' ? entry * 1.03 : entry * 0.97).toFixed(precisions[symbol].p);
    }
    
    await binanceReq('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol: symbol, side: revSide, type: 'STOP_MARKET', triggerPrice: slP, closePosition: 'true' }, 'POST');
    await binanceReq('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol: symbol, side: revSide, type: 'TAKE_PROFIT_MARKET', triggerPrice: tpP, closePosition: 'true' }, 'POST');
    
    const slDist = (Math.abs(parseFloat(slP) - entry) / entry * 100).toFixed(2);
    updateLog(`🛡️ [${symbol}] 宽幅防线已布防，止损空间: ${slDist}%`);
    sendFeishu("🔥 开仓防护挂载 (V40.0版)", `标的: ${symbol}\n方向: ${status}\n止损距离: ${slDist}%`);
    return true;
}

// 📡 核心雷达扫描
async function runMonitor() {
    if (isProcessing) return; isProcessing = true;
    try {
        if(Object.keys(precisions).length === 0) { await initPrecisions(); if(Object.keys(precisions).length === 0) return; }
        
        const risk = await binanceReq('/fapi/v2/positionRisk', {}, 'GET');
        const wallet = await binanceReq('/fapi/v2/account', {}, 'GET');
        
        if(!wallet || !wallet.totalMarginBalance) {
            updateLog(`❌ 资产获取异常，可能因API受限。`);
            return;
        }
        currentBalance = parseFloat(wallet.totalMarginBalance);
        const pos = Array.isArray(risk) ? risk.find(x => Math.abs(parseFloat(x.positionAmt)) > 0) : null;
        
        const btcK = await fetchKlines('BTCUSDT', '15m');
        btcMacroChange = (btcK && btcK.length >= 5) ? ((btcK[btcK.length-1].c - btcK[btcK.length-5].o) / btcK[btcK.length-5].o) * 100 : 0;

        updateLog(`✅ V40.0 雷达运行中 | 状态: ${pos?'🔴搏杀中':'🟢隐蔽蹲守'}`);

        if(pos) {
            activePos.symbol = pos.symbol;
            activePos.status = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
            activePos.qty = Math.abs(parseFloat(pos.positionAmt));
            activePos.entryPrice = parseFloat(pos.entryPrice);
            if(activePos.startTime === 0) activePos.startTime = Date.now();

            const algoOrders = await binanceReq('/fapi/v1/openAlgoOrders', { symbol: pos.symbol }, 'GET');
            if(!JSON.stringify(algoOrders).includes('STOP_MARKET')) { await setAlgoSecurity(pos.symbol, activePos.status, activePos.entryPrice); }
            return;
        } else if(activePos.symbol !== 'NONE') {
            await binanceReq('/fapi/v1/allOpenOrders', { symbol: activePos.symbol }, 'DELETE');
            await binanceReq('/fapi/v1/algoOpenOrders', { symbol: activePos.symbol }, 'DELETE'); 
            activePos = { symbol: 'NONE', startTime: 0, mode: 'NORMAL', extremum: null };
        }

        // ==========================================
        // 🗡️ V40.0 主力猎杀逻辑：收盘确认 + 趋势共振
        // ==========================================
        for(const sym of SYMBOLS) {
            await new Promise(r => setTimeout(r, 300));
            const k15 = await fetchKlines(sym, '15m');
            const k1H = await fetchKlines(sym, '1h');
            
            if(!k15 || k15.length < 20 || !k1H || k1H.length < 25) continue;
            
            // 获取已完全收盘的倒数第二根 15m K线
            const closedCandle15 = k15[k15.length-2]; 
            
            // 🛡️ 防御锁：避免同一根 K 线重复开单
            if(lastTradedCandleTime[sym] === closedCandle15.t) continue;
            
            // 🛡️ 计算 1H 级别的 EMA20 作为趋势判别标准
            const closes1H = k1H.map(k => k.c);
            const ema20_1H = calculateEMA(closes1H, 20);
            const currentTrend1H = ema20_1H[ema20_1H.length - 1]; 
            
            let avgVol = 0;
            for(let i = k15.length-12; i < k15.length-2; i++) { avgVol += k15[i].v; }
            avgVol /= 10;
            
            const body = Math.abs(closedCandle15.c - closedCandle15.o) || 0.0001; 
            const upperWick = closedCandle15.h - Math.max(closedCandle15.o, closedCandle15.c);
            const lowerWick = Math.min(closedCandle15.o, closedCandle15.c) - closedCandle15.l;
            
            // 🟢 顺势抄底：15分钟爆量探底 + 1小时大趋势向上
            if (closedCandle15.v > avgVol * VOLUME_SPIKE_MULTIPLIER && 
                lowerWick > body * WICK_BODY_RATIO && 
                lowerWick > upperWick * 2 &&
                closedCandle15.c > currentTrend1H &&
                btcMacroChange > -MACRO_STORM_LIMIT) {
                
                updateLog(`🛡️ [${sym}] 1H顺势 + 15m探底共振确认！刺客做多！`);
                await executeTrade(sym, 'BUY', closedCandle15.c, closedCandle15.l); 
                lastTradedCandleTime[sym] = closedCandle15.t;
                break;
            }

            // 🔴 顺势摸顶：15分钟爆量冲高 + 1小时大趋势向下
            if (closedCandle15.v > avgVol * VOLUME_SPIKE_MULTIPLIER && 
                upperWick > body * WICK_BODY_RATIO && 
                upperWick > lowerWick * 2 &&
                closedCandle15.c < currentTrend1H &&
                btcMacroChange < MACRO_STORM_LIMIT) {
                
                updateLog(`🛡️ [${sym}] 1H空头压制 + 15m摸顶共振确认！刺客做空！`);
                await executeTrade(sym, 'SELL', closedCandle15.c, closedCandle15.h); 
                lastTradedCandleTime[sym] = closedCandle15.t;
                break;
            }
        }
    } catch (err) {
        updateLog(`❌ 系统报错: ${err.message}`);
    } finally { isProcessing = false; }
}

async function executeTrade(symbol, side, price, extremum) {
    if(!precisions[symbol]) return;
    await binanceReq('/fapi/v1/leverage', { symbol: symbol, leverage: LEVERAGE }, 'POST');
    
    let notional = Math.max(currentBalance * POSITION_RISK_PERCENT * LEVERAGE, 6.5);
    if (notional > currentBalance * LEVERAGE) notional = currentBalance * LEVERAGE * 0.9; 
    
    const qty = (notional / price).toFixed(precisions[symbol].q);
    const res = await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: qty });
    
    if(res && res.code === undefined) {
        activePos = { symbol, status: side==='BUY'?'LONG':'SHORT', entryPrice: price, qty: parseFloat(qty), extremum: extremum, startTime: Date.now(), mode: 'NORMAL' };
        updateLog(`🚀 成功建仓 [${symbol}]，方向: ${side}`);
        sendFeishu("🔥 主力顺势足迹确认", `标的: ${symbol}\n方向: ${side}\n极高盈亏比战役开启！`);
        setTimeout(async () => { await setAlgoSecurity(symbol, activePos.status, price); }, 2000);
    } else {
        updateLog(`❌ 开仓受阻: ${res.msg}`);
    }
}

// ==========================================
// 🖥️ 独立可视化雷达大屏
// ==========================================
http.createServer((req, res) => { 
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); 
    res.end(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>V40.0 刺客指挥中心</title>
            <style>
                body { font-family: -apple-system, sans-serif; background: #0b0c10; color: #c5c6c7; padding: 20px; line-height: 1.5; }
                h2 { color: #66fcf1; border-bottom: 1px solid #1f2833; padding-bottom: 10px; }
                .panel { background: #1f2833; padding: 15px; border-radius: 8px; margin-bottom: 15px; box-shadow: 0 4px 6px rgba(0,0,0,0.5); }
                .val { font-size: 1.2em; font-weight: bold; color: #45a29e; }
                .log-box { background: #000; color: #66fcf1; font-family: monospace; padding: 12px; border-radius: 5px; word-wrap: break-word; border: 1px solid #45a29e;}
                .tip { color: #888; font-size: 0.85em; margin-top: 20px; text-align: center;}
            </style>
        </head>
        <body>
            <h2>🗡️ V40.0 量价刺客 (顺势版)</h2>
            <div class="panel">
                <div>💰 <b>当前兵力:</b> <span class="val">${currentBalance.toFixed(3)} U</span></div>
                <div>📈 <b>宏观环境:</b> <span class="val">${btcMacroChange.toFixed(2)}%</span></div>
                <div>🎯 <b>当前狩猎:</b> <span class="val">${activePos.symbol} (${activePos.status})</span></div>
            </div>
            <h3>📡 暗网雷达战报:</h3>
            <div class="log-box">
                ${globalLog}
            </div>
            <div class="tip">💡 提示：按住屏幕下拉刷新即可获取最新战况。<br>宁可踏空，绝不逆势。此版本开单频率大幅降低，请保持耐心。</div>
        </body>
        </html>
    `); 
}).listen(process.env.PORT || 3000);

setInterval(runMonitor, 60000); 
runMonitor();
