const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ==========================================
// 🔐 核心配置区 (V19.2 深度加固稳健版)
// ==========================================
const FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK || "https://open.feishu.cn/open-apis/bot/v2/hook/6099f609-41c4-4364-b0d8-fdb986b821a2"; 
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

// 🎯 10个精选妖币监控阵列
const SYMBOLS = ['SOLUSDT', 'DOGEUSDT', 'ORDIUSDT', 'INJUSDT', 'PEPEUSDT', 'WIFUSDT', 'BONKUSDT', '1000SATSUSDT', 'ARBUSDT', 'TIAUSDT']; 
const PRECISION = { 
    'SOLUSDT': {p:3, q:1}, 'DOGEUSDT': {p:5, q:0}, 'ORDIUSDT': {p:3, q:1}, 
    'INJUSDT': {p:3, q:1}, 'PEPEUSDT': {p:8, q:0}, 'WIFUSDT': {p:4, q:1},
    'BONKUSDT': {p:8, q:0}, '1000SATSUSDT': {p:7, q:0}, 'ARBUSDT': {p:4, q:1}, 'TIAUSDT': {p:3, q:1}
};

const LEVERAGE = 10; 
const POSITION_RISK_PERCENT = 0.5; // 动用一半资金，预留保证金防插针
const MAX_HOLD_HOURS = 6; 

const TP_FIXED = 1.5;   // 震荡止盈 1.5%
const SL_HARD = 3.5;    // 硬止损 3.5%
const BTC_STORM = 1.2;  // 大饼 15m 波动阀值

let isProcessing = false; 
let activePos = { symbol: 'NONE', status: 'NONE', entryPrice: 0, qty: 0, maxMfe: 0, startTime: 0, mode: 'NORMAL' };
let initialBalance = null, currentBalance = 0;

function getBJTime() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }

// 飞书消息发送器 (带错误处理)
async function sendFeishu(title, message) {
    try {
        if (!FEISHU_WEBHOOK_URL || !FEISHU_WEBHOOK_URL.startsWith("http")) return;
        const content = `【${title}】\n------------------\n${message}\n北京时间: ${getBJTime()}`;
        const options = { hostname: 'open.feishu.cn', path: new URL(FEISHU_WEBHOOK_URL).pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } };
        const req = https.request(options); req.write(JSON.stringify({ msg_type: "text", content: { text: content } })); req.end();
    } catch(e) { console.error("飞书发送失败:", e.message); }
}

// 币安 API 通用请求器
async function binanceReq(path, params, method = 'POST') {
    return new Promise((resolve) => {
        try {
            params.timestamp = Date.now();
            const query = querystring.stringify(params);
            const sig = crypto.createHmac('sha256', BINANCE_API_SECRET).update(query).digest('hex');
            const data = `${query}&signature=${sig}`;
            const options = { 
                hostname: 'fapi.binance.com', 
                path: method === 'GET' ? `${path}?${data}` : path, 
                method: method, 
                headers: { 'X-MBX-APIKEY': BINANCE_API_KEY },
                timeout: 5000 
            };
            const req = https.request(options, res => {
                let b = ''; res.on('data', c => b += c);
                res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve({}); } });
            });
            req.on('error', (e) => { console.error("API请求错误:", e.message); resolve({}); });
            if (method === 'POST') req.write(data);
            req.end();
        } catch(e) { resolve({}); }
    });
}

// K线抓取器 (增加鲁棒性)
async function fetchKlines(symbol, interval = '15m', limit = 20) {
    return new Promise((resolve) => {
        https.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { 
                try { 
                    const raw = JSON.parse(d);
                    if(!Array.isArray(raw) || raw.length === 0) return resolve([]);
                    resolve(raw.map(k => ({ o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))); 
                } catch(e) { resolve([]); } 
            });
        }).on('error', () => resolve([]));
    });
}

// RSI 计算器
function calcRSI(klines) {
    let p=14; if(!klines || klines.length < p+1) return 50;
    try {
        let ag=0, al=0;
        for(let i=1;i<=p;i++){ 
            let diff = klines[i].c - klines[i-1].c;
            if(diff > 0) ag += diff; else al -= diff;
        }
        ag /= p; al /= p;
        let rsi = 100 - (100 / (1 + (ag / (al || 0.001))));
        for(let i=p+1; i<klines.length; i++){
            let diff = klines[i].c - klines[i-1].c, g = diff > 0 ? diff : 0, l = diff < 0 ? -diff : 0;
            ag = (ag * (p-1) + g) / p; al = (al * (p-1) + l) / p;
            rsi = 100 - (100 / (1 + (ag / (al || 0.001))));
        }
        return rsi;
    } catch(e) { return 50; }
}

async function runMonitor() {
    if (isProcessing) return; isProcessing = true;
    try {
        // 1. 获取基础数据
        const risk = await binanceReq('/fapi/v2/positionRisk', {}, 'GET');
        const wallet = await binanceReq('/fapi/v2/account', {}, 'GET');
        if(!wallet || !wallet.totalMarginBalance) { isProcessing=false; return; }
        currentBalance = parseFloat(wallet.totalMarginBalance);
        if(initialBalance === null) initialBalance = currentBalance;

        // 2. 持仓接管与识别
        let currentSymbol = 'NONE';
        if(Array.isArray(risk)) {
            const p = risk.find(x => Math.abs(parseFloat(x.positionAmt)) > 0);
            if(p) {
                currentSymbol = p.symbol;
                if(activePos.symbol === 'NONE') { // 意外中断后恢复
                    activePos = { 
                        symbol: p.symbol, 
                        status: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT', 
                        qty: Math.abs(parseFloat(p.positionAmt)), 
                        entryPrice: parseFloat(p.entryPrice), 
                        maxMfe: 0, startTime: Date.now(), mode: 'NORMAL' 
                    };
                }
            } else if(activePos.symbol !== 'NONE') {
                console.log(`\n🏁 [${activePos.symbol}] 侦测到平仓，重置监控...`);
                await binanceReq('/fapi/v1/allOpenOrders', { symbol: activePos.symbol }, 'DELETE');
                activePos = { symbol: 'NONE', status: 'NONE', entryPrice: 0, qty: 0, maxMfe: 0, startTime: 0, mode: 'NORMAL' };
            }
        }

        // 3. 大饼雷达监测
        const btcK = await fetchKlines('BTCUSDT', '15m', 5);
        if(!btcK || btcK.length < 2) { isProcessing=false; return; }
        const btcChange = ((btcK[btcK.length-1].c - btcK[btcK.length-2].c) / btcK[btcK.length-2].c) * 100;
        const isBtcStorm = Math.abs(btcChange) >= BTC_STORM;
        const btcDir = btcChange > 0 ? 'UP' : 'DOWN';

        // 控制台播报 (Render Console)
        process.stdout.write(`\r[${getBJTime()}] 💰余额:${currentBalance.toFixed(2)} | 大饼风力:${btcChange.toFixed(2)}% | 状态:${activePos.symbol==='NONE'?'🔭巡航':'🛡️持仓:'+activePos.symbol}`);

        // 4. 持仓管理逻辑
        if(currentSymbol !== 'NONE') {
            const tick = await binanceReq('/fapi/v1/ticker/price', { symbol: activePos.symbol }, 'GET');
            if(!tick || !tick.price) { isProcessing=false; return; }
            const curPrice = parseFloat(tick.price);
            let pnl = activePos.status === 'LONG' ? (curPrice - activePos.entryPrice) / activePos.entryPrice * 100 : (activePos.entryPrice - curPrice) / activePos.entryPrice * 100;
            if(pnl > activePos.maxMfe) activePos.maxMfe = pnl;

            // 超时强制清理 (僵尸单)
            const holdHours = (Date.now() - activePos.startTime) / 3600000;
            if(holdHours >= MAX_HOLD_HOURS) {
                console.log(`\n⏰ [${activePos.symbol}] 持仓超时，强制切断！`);
                await binanceReq('/fapi/v1/order', { symbol: activePos.symbol, side: activePos.status==='LONG'?'SELL':'BUY', type: 'MARKET', quantity: activePos.qty });
                sendFeishu("⏰ 僵尸单清理", `${activePos.symbol} 已强制平仓`);
            }

            // 顺风吃肉：追踪止盈 (回撤0.5%平仓)
            if(activePos.mode === 'TRALLING' && activePos.maxMfe > 1.5 && (activePos.maxMfe - pnl) >= 0.5) {
                console.log(`\n🌪️ [${activePos.symbol}] 趋势利润回撤，止盈！最高:${activePos.maxMfe.toFixed(2)}%`);
                await binanceReq('/fapi/v1/order', { symbol: activePos.symbol, side: activePos.status==='LONG'?'SELL':'BUY', type: 'MARKET', quantity: activePos.qty });
            }
            isProcessing = false; return;
        }

        // 5. 轮动扫描：猎杀逻辑
        for(const sym of SYMBOLS) {
            await new Promise(r => setTimeout(r, 600)); // 严格 API 频率保护
            const klines = await fetchKlines(sym, '15m', 30);
            if(!klines || klines.length < 20) continue;
            
            const rsi = calcRSI(klines);
            const liveC = klines[klines.length-1].c;

            // 做多信号
            if(rsi < 30) {
                if(isBtcStorm && btcDir === 'DOWN') continue; // 大饼血崩不接飞刀
                const mode = (isBtcStorm && btcDir === 'UP') ? 'TRALLING' : 'NORMAL';
                await openOrder(sym, 'BUY', liveC, mode);
                break;
            }
            // 做空信号
            if(rsi > 70) {
                if(isBtcStorm && btcDir === 'UP') continue; // 大饼狂飙不摸顶
                const mode = (isBtcStorm && btcDir === 'DOWN') ? 'TRALLING' : 'NORMAL';
                await openOrder(sym, 'SELL', liveC, mode);
                break;
            }
        }
    } catch(e) { console.error("\n🔥 系统异常:", e.message); } finally { isProcessing = false; }
}

async function openOrder(symbol, side, price, mode) {
    // 资金计算：确保名义价值 > 6.0 U (币安门槛5U)
    const budget = currentBalance * POSITION_RISK_PERCENT;
    let qty = ((budget * LEVERAGE) / price).toFixed(PRECISION[symbol].q);
    if (parseFloat(qty) * price < 6.0) {
        qty = (6.5 / price).toFixed(PRECISION[symbol].q);
    }
    
    console.log(`\n🎯 [${symbol}] 触发信号！正在以 ${price} ${side} 入场...`);
    const res = await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: qty });
    
    if(!res.code) {
        activePos = { symbol, status: side==='BUY'?'LONG':'SHORT', entryPrice: price, qty: parseFloat(qty), maxMfe: 0, startTime: Date.now(), mode };
        
        // 延迟2秒，等成交后布置防线
        setTimeout(async () => {
            const entry = activePos.entryPrice;
            const slPrice = side === 'BUY' ? entry * (1 - SL_HARD/100) : entry * (1 + SL_HARD/100);
            const revSide = side === 'BUY' ? 'SELL' : 'BUY';
            
            // 1. 必挂硬止损 (物理防线)
            await binanceReq('/fapi/v1/order', { symbol, side: revSide, type: 'STOP_MARKET', stopPrice: slPrice.toFixed(PRECISION[symbol].p), closePosition: 'true' });
            
            // 2. 如果是 NORMAL 模式，挂 1.5% 止盈单
            if(mode === 'NORMAL') {
                const tpPrice = side === 'BUY' ? entry * (1 + TP_FIXED/100) : entry * (1 - TP_FIXED/100);
                await binanceReq('/fapi/v1/order', { symbol, side: revSide, type: 'LIMIT', price: tpPrice.toFixed(PRECISION[symbol].p), quantity: activePos.qty, timeInForce: 'GTC' });
            }
            
            sendFeishu("🔥 战车出击", `标的: ${symbol}\n方向: ${side}\n模式: ${mode}\n量能: ${qty}\n防线: 已布置`);
        }, 2000);
    } else {
        console.error(`\n❌ 开仓失败: ${res.msg}`);
    }
}

// 飞书平安报 (每小时)
setInterval(() => {
    let statusMsg = activePos.symbol === 'NONE' ? "🔭 正在多币种轮动巡航" : `🛡️ 正在持仓: ${activePos.symbol} (浮盈追踪中)`;
    sendFeishu("📊 平安汇报", `当前余额: ${currentBalance.toFixed(3)} U\n累计盈亏: ${(currentBalance - initialBalance).toFixed(3)} U\n系统状态: ${statusMsg}`);
}, 3600000);

// 健康检查接口
http.createServer((req,res)=>{ 
    res.setHeader('Content-Type','text/html; charset=utf-8'); 
    res.end(`<h1>V19.2 终极加固版</h1><p>大饼风力监测中，系统运行稳健</p><p>当前本金: ${currentBalance.toFixed(3)} U</p>`); 
}).listen(process.env.PORT||3000);

// 核心循环
setInterval(runMonitor, 60000); 
runMonitor();
