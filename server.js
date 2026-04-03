const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ==========================================
// 🔐 核心配置区 (V19.0 终极轮动战车)
// ==========================================
const FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK || "https://open.feishu.cn/open-apis/bot/v2/hook/6099f609-41c4-4364-b0d8-fdb986b821a2"; 
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

// 🎯 雷达阵列：精选10个最妖币种 (轮动扫描)
const SYMBOLS = ['SOLUSDT', 'DOGEUSDT', 'ORDIUSDT', 'INJUSDT', 'PEPEUSDT', 'WIFUSDT', 'BONKUSDT', '1000SATSUSDT', 'ARBUSDT', 'TIAUSDT']; 
const PRECISION = { 
    'SOLUSDT': {p:3, q:1}, 'DOGEUSDT': {p:5, q:0}, 'ORDIUSDT': {p:3, q:1}, 
    'INJUSDT': {p:3, q:1}, 'PEPEUSDT': {p:8, q:0}, 'WIFUSDT': {p:4, q:1},
    'BONKUSDT': {p:8, q:0}, '1000SATSUSDT': {p:7, q:0}, 'ARBUSDT': {p:4, q:1}, 'TIAUSDT': {p:3, q:1}
};

const LEVERAGE = 10; 
const POSITION_RISK_PERCENT = 0.5; // 14U每次动用约7U
const MAX_HOLD_HOURS = 6; // 僵尸单清理器

// 关键参数
const TP_FIXED = 1.5;   // 常规止盈
const SL_HARD = 3.5;    // 硬止损
const BTC_STORM = 1.2;  // 大饼风暴定义 (15m波动)

let isProcessing = false; 
let activePos = { symbol: 'NONE', status: 'NONE', entryPrice: 0, qty: 0, maxMfe: 0, startTime: 0, mode: 'NORMAL' };
let initialBalance = null, currentBalance = 0;

function getBJTime() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }

async function sendFeishu(title, message) {
    if (!FEISHU_WEBHOOK_URL || FEISHU_WEBHOOK_URL.includes("这里填入")) return;
    const content = `【${title}】\n------------------\n${message}\n北京时间: ${getBJTime()}`;
    const options = { hostname: 'open.feishu.cn', path: new URL(FEISHU_WEBHOOK_URL).pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } };
    const req = https.request(options); req.write(JSON.stringify({ msg_type: "text", content: { text: content } })); req.end();
}

console.log(`🚀 V19.0 终极战车启动！[多雷达/大盘统帅/动态止盈]`);

async function binanceReq(path, params, method = 'POST') {
    params.timestamp = Date.now();
    const query = querystring.stringify(params);
    const sig = crypto.createHmac('sha256', BINANCE_API_SECRET).update(query).digest('hex');
    const data = `${query}&signature=${sig}`;
    const options = { hostname: 'fapi.binance.com', path: method === 'GET' ? `${path}?${data}` : path, method: method, headers: { 'X-MBX-APIKEY': BINANCE_API_KEY } };
    return new Promise((resolve) => {
        const req = https.request(options, res => {
            let b = ''; res.on('data', c => b += c);
            res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve({}); } });
        });
        req.on('error', () => resolve({})); if (method === 'POST') req.write(data); req.end();
    });
}

async function fetchKlines(symbol, interval = '15m', limit = 20) {
    return new Promise((resolve) => {
        https.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d).map(k => ({ o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))); } catch(e) { resolve([]); } });
        }).on('error', () => resolve([]));
    });
}

function calcRSI(klines) {
    let p=14; if(klines.length < p+1) return 50;
    let ag=0, al=0;
    for(let i=1;i<=p;i++){ let diff=klines[i].c-klines[i-1].c; if(diff>0)ag+=diff; else al-=diff; }
    ag/=p; al/=p; let rsi = 100-(100/(1+(ag/(al||0.001))));
    for(let i=p+1;i<klines.length;i++){
        let diff=klines[i].c-klines[i-1].c, g=diff>0?diff:0, l=diff<0?-diff:0;
        ag=(ag*(p-1)+g)/p; al=(al*(p-1)+l)/p; rsi = 100-(100/(1+(ag/(al||0.001))));
    }
    return rsi;
}

async function runMonitor() {
    if (isProcessing) return; isProcessing = true;
    try {
        // 1. 同步账户与仓位
        const risk = await binanceReq('/fapi/v2/positionRisk', {}, 'GET');
        const wallet = await binanceReq('/fapi/v2/account', {}, 'GET');
        currentBalance = parseFloat(wallet.totalMarginBalance);
        if(initialBalance === null) initialBalance = currentBalance;

        let hasPosition = false;
        if(Array.isArray(risk)) {
            const p = risk.find(x => Math.abs(parseFloat(x.positionAmt)) > 0);
            if(p) {
                hasPosition = true;
                activePos.symbol = p.symbol;
                activePos.status = parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT';
                activePos.qty = Math.abs(parseFloat(p.positionAmt));
                activePos.entryPrice = parseFloat(p.entryPrice);
                if(activePos.startTime === 0) activePos.startTime = Date.now();
            } else {
                if(activePos.symbol !== 'NONE') {
                    console.log(`🏁 [${activePos.symbol}] 仓位已平，清理战场...`);
                    await binanceReq('/fapi/v1/allOpenOrders', { symbol: activePos.symbol }, 'DELETE');
                    activePos = { symbol: 'NONE', status: 'NONE', entryPrice: 0, qty: 0, maxMfe: 0, startTime: 0, mode: 'NORMAL' };
                }
            }
        }

        // 2. 大饼统帅心情监测 (BTC Filter)
        const btcK = await fetchKlines('BTCUSDT', '15m', 5);
        const btcChange = ((btcK[btcK.length-1].c - btcK[btcK.length-2].c) / btcK[btcK.length-2].c) * 100;
        const isBtcStorm = Math.abs(btcChange) >= BTC_STORM;
        const btcDir = btcChange > 0 ? 'UP' : 'DOWN';

        // 3. 渲染播报细节 (Render Console)
        process.stdout.write(`\r[${getBJTime()}] 💰余额:${currentBalance.toFixed(2)} | 大饼风力:${btcChange.toFixed(2)}% | 状态:${activePos.symbol==='NONE'?'🔭巡航':'🛡️持仓:'+activePos.symbol}`);

        // 4. 持仓逻辑：动态止盈与超时清理
        if(hasPosition) {
            const tick = await binanceReq('/fapi/v1/ticker/price', { symbol: activePos.symbol }, 'GET');
            const curPrice = parseFloat(tick.price);
            let pnl = activePos.status === 'LONG' ? (curPrice - activePos.entryPrice) / activePos.entryPrice * 100 : (activePos.entryPrice - curPrice) / activePos.entryPrice * 100;
            let pnlU = pnl * LEVERAGE * (currentBalance * POSITION_RISK_PERCENT) / 100;
            
            if(pnl > activePos.maxMfe) activePos.maxMfe = pnl;

            // 僵尸单清理器
            const holdHours = (Date.now() - activePos.startTime) / 3600000;
            if(holdHours >= MAX_HOLD_HOURS) {
                console.log(`\n⏰ [${activePos.symbol}] 达到${MAX_HOLD_HOURS}小时时限，强制清仓！`);
                await binanceReq('/fapi/v1/order', { symbol: activePos.symbol, side: activePos.status==='LONG'?'SELL':'BUY', type: 'MARKET', quantity: activePos.qty });
                sendFeishu("⏰ 僵尸单强制清理", `${activePos.symbol} 持仓超时，已市价强制平仓。PNL: ${pnl.toFixed(2)}%`);
            }

            // 动态止盈模式 (顺风吃肉)
            if(activePos.mode === 'TRALLING') {
                if(activePos.maxMfe > 1.5 && (activePos.maxMfe - pnl) >= 0.5) {
                    console.log(`\n🍱 [${activePos.symbol}] 顺风肉吃完，回撤平仓！最高:${activePos.maxMfe.toFixed(2)}%, 当前:${pnl.toFixed(2)}%`);
                    await binanceReq('/fapi/v1/order', { symbol: activePos.symbol, side: activePos.status==='LONG'?'SELL':'BUY', type: 'MARKET', quantity: activePos.qty });
                }
            }
            isProcessing = false; return;
        }

        // 5. 轮动扫描猎杀逻辑 (先到先得)
        for(const sym of SYMBOLS) {
            // 每次扫一个币停0.5秒，保护API权重
            await new Promise(r => setTimeout(r, 500));
            const klines = await fetchKlines(sym, '15m', 30);
            const rsi = calcRSI(klines);
            const liveC = klines[klines.length-1].c;

            // 做多信号：低吸
            if(rsi < 30) {
                if(isBtcStorm && btcDir === 'DOWN') {
                    console.log(`\n🚫 [${sym}] 符合低吸，但大饼正在血崩，拦截接飞刀单！`);
                    continue;
                }
                await openOrder(sym, 'BUY', liveC, isBtcStorm && btcDir === 'UP' ? 'TRALLING' : 'NORMAL');
                break; // 只开一单，开完即撤
            }
            // 做空信号：摸顶
            if(rsi > 70) {
                if(isBtcStorm && btcDir === 'UP') {
                    console.log(`\n🚫 [${sym}] 符合摸顶，但大饼正在狂飙，拦截送头单！`);
                    continue;
                }
                await openOrder(sym, 'SELL', liveC, isBtcStorm && btcDir === 'DOWN' ? 'TRALLING' : 'NORMAL');
                break;
            }
        }
    } catch(e) { console.error("\n🔥 系统异常:", e.message); } finally { isProcessing = false; }
}

async function openOrder(symbol, side, price, mode) {
    const qty = Math.max(6.5 / price, (currentBalance * POSITION_RISK_PERCENT * LEVERAGE) / price).toFixed(PRECISION[symbol].q);
    const res = await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: qty });
    if(!res.code) {
        activePos = { symbol, status: side==='BUY'?'LONG':'SHORT', entryPrice: price, qty: parseFloat(qty), maxMfe: 0, startTime: Date.now(), mode };
        console.log(`\n🎯 [${symbol}] 镰刀挥出！模式:${mode==='TRALLING'?'顺风吃肉🌪️':'正常网格🐒'}`);
        
        setTimeout(async () => {
            const entry = activePos.entryPrice;
            const slPrice = side === 'BUY' ? entry * (1 - SL_HARD/100) : entry * (1 + SL_HARD/100);
            const revSide = side === 'BUY' ? 'SELL' : 'BUY';
            
            // 1. 必挂止损
            await binanceReq('/fapi/v1/order', { symbol, side: revSide, type: 'STOP_MARKET', stopPrice: slPrice.toFixed(PRECISION[symbol].p), closePosition: 'true' });
            
            // 2. 若非顺风模式，挂限价止盈
            if(mode === 'NORMAL') {
                const tpPrice = side === 'BUY' ? entry * (1 + TP_FIXED/100) : entry * (1 - TP_FIXED/100);
                await binanceReq('/fapi/v1/order', { symbol, side: revSide, type: 'LIMIT', price: tpPrice.toFixed(PRECISION[symbol].p), quantity: qty, timeInForce: 'GTC' });
            }
            
            sendFeishu("🎯 战车开火", `标的: ${symbol}\n方向: ${side}\n模式: ${mode}\n本金动用: ${currentBalance.toFixed(2)}U\n止损已挂: ${SL_HARD}%`);
        }, 2000);
    }
}

// 飞书整点战报
setInterval(() => {
    let msg = activePos.symbol === 'NONE' ? "🔭 正在多雷达静默扫描..." : `🛡️ 正在监视: ${activePos.symbol} (${activePos.status})\n⏳ 已持仓: ${((Date.now()-activePos.startTime)/3600000).toFixed(1)}小时`;
    sendFeishu("📊 每小时平安汇总", `当前净资产: ${currentBalance.toFixed(3)} U\n启动至今: ${(currentBalance - initialBalance).toFixed(3)} U\n状态: ${msg}`);
}, 3600000);

http.createServer((req,res)=>{ 
    res.setHeader('Content-Type','text/html; charset=utf-8'); 
    res.end(`<h1>V19.0 终极战车</h1><p>资产: ${currentBalance.toFixed(3)} U</p><p>战绩: ${(currentBalance - (initialBalance||0)).toFixed(3)} U</p><p>监控: ${SYMBOLS.length}币种轮动</p>`); 
}).listen(process.env.PORT||3000);

setInterval(runMonitor, 60000); 
runMonitor();
