const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ==========================================
// 🖥️ 全局雷达日志系统 (脱离 Render 控制台)
// ==========================================
let globalLog = "⏳ 刺客已潜伏，等待首次雷达扫描...";

process.on('uncaughtException', (err) => { globalLog = `🔥 [致命异常] ${err.message}`; });
process.on('unhandledRejection', (reason) => { globalLog = `🔥 [Promise拒绝] ${reason}`; });

function getBJTime() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }

function updateLog(msg) {
    const t = getBJTime();
    console.log(`[${t}] ${msg}`);
    // 保留最近 10 条日志在网页上，防止太长卡顿
    const logs = globalLog.split('<br>');
    if (logs.length > 10) logs.pop(); 
    globalLog = `[${t}] ${msg}<br>` + logs.join('<br>');
}

// ==========================================
// 🔐 V39.1 量价刺客终极版 (宽幅防守 + 独立大屏)
// ==========================================
const FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK || "https://open.feishu.cn/open-apis/bot/v2/hook/6099f609-41c4-4364-b0d8-fdb986b821a2"; 
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

// 🎯 缩小猎物范围：只打流动性好、爱插针的币
const SYMBOLS = ['SOLUSDT', 'DOGEUSDT', 'PEPEUSDT', 'WIFUSDT', 'ARBUSDT']; 
let precisions = {}; 

const LEVERAGE = 10;                
const POSITION_RISK_PERCENT = 0.5;  

// 🗡️ 主力猎杀参数：异常爆量 + 长插针
const VOLUME_SPIKE_MULTIPLIER = 2.0; // 成交量必须是均量的 2 倍以上 (爆天量)
const WICK_BODY_RATIO = 2.0;         // 影线必须是实体的 2 倍以上 (拒收形态)
const MACRO_STORM_LIMIT = 1.5;       // 大饼 1小时 波动风控

// 🛡️ 宽幅防守参数 (空间换胜率)
const RR_RATIO = 2.0;                // 亏1赚2，盈亏比极度拉升
const EXTREMUM_BUFFER = 0.006;       // 🛡️ 缓冲区加宽至 0.6% (防扫损核心)
const MIN_SL_PERCENT = 0.008;        // 🛡️ 最小容忍 0.8% 止损
const MAX_SL_PERCENT = 0.035;        // 🛡️ 极限容忍 3.5% 止损 (预留深踩空间)

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
    updateLog("🔄 战车重装系统：加载宽幅量价刺客算法...");
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
        updateLog("✅ 刺客就位！宽幅防线构建完毕，允许自由开火！");
        sendFeishu("🚀 V39.1 量价刺客完全体", "底层架构刷新完毕！\n已加宽防扫损缓冲区 (0.6%)，并开启独立雷达监控大屏。");
    } else {
        updateLog("❌ API权限错误或网络阻断，无法获取交易精度！");
    }
}

async function fetchKlines(symbol) {
    return new Promise((resolve) => {
        https.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=20`, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { 
                try { 
                    const raw = JSON.parse(d); 
                    // 抓取 O, H, L, C 和 Volume (成交量)
                    resolve(Array.isArray(raw) ? raw.map(k => ({ o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })) : null); 
                } catch(e) { resolve(null); } 
            });
        }).on('error', () => resolve(null));
    });
}

// 🛡️ 宽幅防线设置
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
    sendFeishu("🔥 开仓防护挂载 (V39.1宽幅版)", `标的: ${symbol}\n方向: ${status}\n止损距离: ${slDist}%\n(已预留 0.6% 针尖防守缓冲区，拒绝轻易被扫损)`);
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
            updateLog(`❌ 资产获取异常，可能因为网络断流或API受限。`);
            return;
        }
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
        // 🗡️ 主力猎杀逻辑：寻找异常爆量插针
        // ==========================================
        for(const sym of SYMBOLS) {
            await new Promise(r => setTimeout(r, 300));
            const k = await fetchKlines(sym);
            if(!k || k.length < 15) continue;
            
            let avgVol = 0;
            for(let i = k.length-11; i < k.length-1; i++) { avgVol += k[i].v; }
            avgVol /= 10;
            
            const current = k[k.length-1];
            const body = Math.abs(current.c - current.o) || 0.0001; 
            const upperWick = current.h - Math.max(current.o, current.c);
            const lowerWick = Math.min(current.o, current.c) - current.l;
            
            // 🟢 主力爆量砸盘，下探后拉起 (探底针 -> 抄底做多)
            if (current.v > avgVol * VOLUME_SPIKE_MULTIPLIER && 
                lowerWick > body * WICK_BODY_RATIO && 
                lowerWick > upperWick * 2 &&
                btcMacroChange > -MACRO_STORM_LIMIT) {
                
                updateLog(`🗡️ [${sym}] 监测到主力爆量插针吸筹！跟进做多！`);
                await executeTrade(sym, 'BUY', current.c, current.l); 
                break;
            }

            // 🔴 主力爆量拉升，冲高后被砸 (顶天针 -> 摸顶做空)
            if (current.v > avgVol * VOLUME_SPIKE_MULTIPLIER && 
                upperWick > body * WICK_BODY_RATIO && 
                upperWick > lowerWick * 2 &&
                btcMacroChange < MACRO_STORM_LIMIT) {
                
                updateLog(`🗡️ [${sym}] 监测到主力爆量冲高出货！跟进做空！`);
                await executeTrade(sym, 'SELL', current.c, current.h); 
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
    
    // 资金保护策略
    let notional = Math.max(currentBalance * POSITION_RISK_PERCENT * LEVERAGE, 6.5);
    if (notional > currentBalance * LEVERAGE) notional = currentBalance * LEVERAGE * 0.9; 
    
    const qty = (notional / price).toFixed(precisions[symbol].q);
    const res = await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: qty });
    
    if(res && res.code === undefined) {
        activePos = { symbol, status: side==='BUY'?'LONG':'SHORT', entryPrice: price, qty: parseFloat(qty), extremum: extremum, startTime: Date.now(), mode: 'NORMAL' };
        updateLog(`🚀 刺客成功建仓 [${symbol}]，方向: ${side}`);
        sendFeishu("🔥 主力足迹确认，跟随建仓", `标的: ${symbol}\n方向: ${side}\n极高盈亏比战役开启！`);
        setTimeout(async () => { await setAlgoSecurity(symbol, activePos.status, price); }, 2000);
    } else {
        updateLog(`❌ 开仓受阻: ${res.msg}`);
    }
}

// ==========================================
// 🖥️ 独立可视化雷达大屏 (随时随地用手机查看)
// ==========================================
http.createServer((req, res) => { 
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); 
    res.end(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>V39.1 刺客指挥中心</title>
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
            <h2>🗡️ V39.1 宽幅量价刺客大屏</h2>
            <div class="panel">
                <div>💰 <b>当前兵力:</b> <span class="val">${currentBalance.toFixed(3)} U</span></div>
                <div>📈 <b>宏观环境:</b> <span class="val">${btcMacroChange.toFixed(2)}%</span></div>
                <div>🎯 <b>当前狩猎:</b> <span class="val">${activePos.symbol} (${activePos.status})</span></div>
            </div>
            <h3>📡 暗网雷达战报:</h3>
            <div class="log-box">
                ${globalLog}
            </div>
            <div class="tip">💡 提示：按住屏幕下拉刷新即可获取最新战况。<br>刺客策略注重胜率质量而非数量，请保持耐心。</div>
        </body>
        </html>
    `); 
}).listen(process.env.PORT || 3000);

setInterval(runMonitor, 60000); 
runMonitor();
