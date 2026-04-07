const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

let globalLog = "⏳ 刺客已潜伏，等待主力爆量插针...";

process.on('uncaughtException', (err) => { globalLog = `🔥 [致命异常] ${err.message}`; });
process.on('unhandledRejection', (reason) => { globalLog = `🔥 [Promise拒绝] ${reason}`; });

const FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK || "https://open.feishu.cn/open-apis/bot/v2/hook/6099f609-41c4-4364-b0d8-fdb986b821a2"; 
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

// 缩小猎物范围：只打流动性最好、主力最喜欢插针的币
const SYMBOLS = ['SOLUSDT', 'DOGEUSDT', 'PEPEUSDT', 'WIFUSDT', 'ARBUSDT']; 
let precisions = {}; 

const LEVERAGE = 10;                
const POSITION_RISK_PERCENT = 0.5;  

// 🎯 核心定制战法：量价插针参数
const VOLUME_SPIKE_MULTIPLIER = 2.0; // 成交量必须是均量的 2 倍以上 (爆天量)
const WICK_BODY_RATIO = 2.0;         // 影线必须是实体的 2 倍以上 (拒收形态)
const MACRO_STORM_LIMIT = 1.5;       // 大饼 1小时 波动风控

// 🎯 极高盈亏比风控 (用针尖做防守)
const RR_RATIO = 2.0;                // 亏 1 块钱，必须赚 2 块钱才走
const EXTREMUM_BUFFER = 0.002;       // 止损设在针尖外 0.2%
const MIN_SL_PERCENT = 0.005;        // 极限防插针，最小容忍 0.5% 止损
const MAX_SL_PERCENT = 0.025;        // 保命底线，单次止损绝不超过 2.5%

let isProcessing = false; 
let activePos = { symbol: 'NONE', status: 'NONE', entryPrice: 0, qty: 0, extremum: null, startTime: 0, mode: 'NORMAL' };
let currentBalance = 0;
let btcMacroChange = 0;

function getBJTime() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }

function updateLog(msg) {
    const t = getBJTime();
    console.log(`[${t}] ${msg}`);
    globalLog = `[${t}]<br>${msg}`;
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
            res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve({code:-999}); } });
        });
        req.on('error', (e) => resolve({code:-999})); 
        if (method === 'POST') req.write(data); req.end();
    });
}

async function initPrecisions() {
    updateLog("🔄 战车重装系统：加载量价刺客算法...");
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
        updateLog("✅ 刺客就位！抛弃传统指标，只狩猎异常量能！");
        sendFeishu("🚀 资深量价刺客版 (V39.0)", "老套路已废弃！\n系统现在只寻找【异常爆量+长插针】的主力吸筹/派发信号。\n盈亏比拉升至 1:2。");
    }
}

async function fetchKlines(symbol) {
    return new Promise((resolve) => {
        https.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=20`, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { 
                try { 
                    const raw = JSON.parse(d); 
                    // 抓取 O, H, L, C 和 Volume (成交量, 第6个元素)
                    resolve(Array.isArray(raw) ? raw.map(k => ({ o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })) : null); 
                } catch(e) { resolve(null); } 
            });
        }).on('error', () => resolve(null));
    });
}

async function setAlgoSecurity(symbol, status, entry) {
    if(!precisions[symbol]) return false;
    const revSide = status === 'LONG' ? 'SELL' : 'BUY';
    let slP, tpP;
    const ext = activePos.extremum; 
    
    // 🧠 刺客级风控：把止损绝对挂在主力插针的针尖外围！
    if (ext) {
        if (status === 'LONG') {
            let sl = Math.max(ext * (1 - EXTREMUM_BUFFER), entry * (1 - MAX_SL_PERCENT));
            // 确保止损不要太近被随便扫掉
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
        btcMacroChange = (btcK && btcK.length >= 5) ? ((btcK[btcK.length-1].c - btcK[btcK.length-5].o) / btcK[btcK.length-5].o) * 100 : 0;

        updateLog(`✅ 刺客雷达运行中 | 状态: ${pos?'🔴搏杀中':'🟢隐蔽蹲守'}`);

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
        // 🗡️ 主力猎杀逻辑：量价形态识别
        // ==========================================
        for(const sym of SYMBOLS) {
            await new Promise(r => setTimeout(r, 300));
            const k = await fetchKlines(sym);
            if(!k || k.length < 15) continue;
            
            // 计算过去 10 根 K 线的平均成交量
            let avgVol = 0;
            for(let i = k.length-11; i < k.length-1; i++) { avgVol += k[i].v; }
            avgVol /= 10;
            
            // 提取当前（或刚刚收盘的）K线特征
            const current = k[k.length-1];
            const body = Math.abs(current.c - current.o) || 0.0001; // 防止除以0
            const upperWick = current.h - Math.max(current.o, current.c);
            const lowerWick = Math.min(current.o, current.c) - current.l;
            
            // 🟢 主力爆量砸盘，下探后拉起 (探底针 -> 抄底做多)
            // 必须满足：成交量爆倍 + 下影线比实体大2倍以上 + 下影线明显长于上影线
            if (current.v > avgVol * VOLUME_SPIKE_MULTIPLIER && 
                lowerWick > body * WICK_BODY_RATIO && 
                lowerWick > upperWick * 2 &&
                btcMacroChange > -MACRO_STORM_LIMIT) {
                
                updateLog(`🗡️ [${sym}] 监测到主力爆量插针吸筹！均量 ${avgVol.toFixed(0)} 爆至 ${current.v.toFixed(0)}！跟进做多！`);
                await executeTrade(sym, 'BUY', current.c, current.l); // 把最低点(针尖)传给风控做止损
                break;
            }

            // 🔴 主力爆量拉升，冲高后被砸 (顶天针 -> 摸顶做空)
            // 必须满足：成交量爆倍 + 上影线比实体大2倍以上 + 上影线明显长于下影线
            if (current.v > avgVol * VOLUME_SPIKE_MULTIPLIER && 
                upperWick > body * WICK_BODY_RATIO && 
                upperWick > lowerWick * 2 &&
                btcMacroChange < MACRO_STORM_LIMIT) {
                
                updateLog(`🗡️ [${sym}] 监测到主力爆量冲高出货！均量 ${avgVol.toFixed(0)} 爆至 ${current.v.toFixed(0)}！跟进做空！`);
                await executeTrade(sym, 'SELL', current.c, current.h); // 把最高点(针尖)传给风控做止损
                break;
            }
        }
    } catch (err) {
        updateLog(`❌ 报错: ${err.message}`);
    } finally { isProcessing = false; }
}

async function executeTrade(symbol, side, price, extremum) {
    if(!precisions[symbol]) return;
    await binanceReq('/fapi/v1/leverage', { symbol: symbol, leverage: LEVERAGE }, 'POST');
    
    // 8U 资金保护：只动用 50%，保底 6.5U
    let notional = Math.max(currentBalance * POSITION_RISK_PERCENT * LEVERAGE, 6.5);
    if (notional > currentBalance * LEVERAGE) notional = currentBalance * LEVERAGE * 0.9; // 防止超可用余额
    
    const qty = (notional / price).toFixed(precisions[symbol].q);
    const res = await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: qty });
    
    if(res && res.code === undefined) {
        activePos = { symbol, status: side==='BUY'?'LONG':'SHORT', entryPrice: price, qty: parseFloat(qty), extremum: extremum, startTime: Date.now(), mode: 'NORMAL' };
        updateLog(`🚀 刺客开火 [${symbol}]，方向: ${side}`);
        sendFeishu("🔥 主力足迹确认，跟随开仓！", `标的: ${symbol}\n方向: ${side}\n已检测到爆量极值插针，贴近主力成本建仓！`);
        setTimeout(async () => { await setAlgoSecurity(symbol, activePos.status, price); }, 2000);
    } else {
        updateLog(`❌ 开仓失败: ${res.msg}`);
    }
}

http.createServer((req, res) => { 
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); 
    res.end(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>V39.0 刺客监控</title>
            <style>
                body { font-family: -apple-system, sans-serif; background: #0b0c10; color: #c5c6c7; padding: 20px; }
                h2 { color: #66fcf1; border-bottom: 1px solid #1f2833; padding-bottom: 10px; }
                .panel { background: #1f2833; padding: 15px; border-radius: 8px; margin-bottom: 15px; }
                .val { font-size: 1.2em; font-weight: bold; color: #45a29e; }
                .log-box { background: #000; color: #66fcf1; font-family: monospace; padding: 12px; border-radius: 5px; word-wrap: break-word;}
                .tip { color: #888; font-size: 0.85em; margin-top: 20px; text-align: center;}
            </style>
        </head>
        <body>
            <h2>🗡️ V39.0 量价刺客系统 (资深定制版)</h2>
            <div class="panel">
                <div>💰 <b>当前兵力:</b> <span class="val">${currentBalance.toFixed(3)} U</span></div>
                <div>📈 <b>宏观环境:</b> <span class="val">${btcMacroChange.toFixed(2)}%</span></div>
                <div>🎯 <b>当前狩猎:</b> <span class="val">${activePos.symbol} (${activePos.status})</span></div>
            </div>
            <h3>📡 暗网雷达战报:</h3>
            <div class="log-box">> ${globalLog}</div>
            <div class="tip">💡 提示：本策略仅捕捉极限爆量插针形态，开单频率极低，请耐心蹲守。下拉刷新数据。</div>
        </body>
        </html>
    `); 
}).listen(process.env.PORT || 3000);

setInterval(runMonitor, 60000); 
runMonitor();
