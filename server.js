const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ==========================================
// 🔐 核心配置区 (请填入你的飞书 Webhook)
// ==========================================
const FEISHU_WEBHOOK_URL = "这里填入你的飞书Webhook地址"; 

const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY; 

// 🛡️ 物理参数
const SYMBOLS = ['ETHUSDT', 'BTCUSDT', 'SOLUSDT'];
const PRICE_PRECISION = { 'BTCUSDT': 1, 'ETHUSDT': 2, 'SOLUSDT': 3 }; 
const QTY_PRECISION = { 'BTCUSDT': 3, 'ETHUSDT': 3, 'SOLUSDT': 1 }; 
const LEVERAGE = 20;
const CHECK_INTERVAL_MS = 2 * 60 * 1000; 

// 🎯 状态管理
let positions = {};
SYMBOLS.forEach(sym => {
    positions[sym] = { 
        status: 'NONE', entryPrice: 0, qty: 0, entryTime: 0, strategy: '', 
        lastCloseTime: 0, consecutiveLosses: 0, maxMFEPercent: 0, 
        amnestyNotified: false, inJunjunMode: false, lastKnownPrice: 0 
    };
});

let inMemoryDB = { wins: 0, losses: 0, totalPnl: 0, startTime: new Date().toLocaleString() };

console.log("🚀 V10.1 探照灯版启动！飞书雷达就绪，AI 思考日志已全面开启可视！");

// ==========================================
// 📡 飞书推送引擎
// ==========================================
async function sendFeishu(title, message) {
    if (!FEISHU_WEBHOOK_URL || FEISHU_WEBHOOK_URL.includes("这里填入")) return;
    const content = `【${title}】\n------------------\n${message}\n时间: ${new Date().toLocaleString()}`;
    const data = JSON.stringify({ msg_type: "text", content: { text: content } });
    const url = new URL(FEISHU_WEBHOOK_URL);
    const options = { hostname: url.hostname, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json' } };
    const req = https.request(options); req.write(data); req.end();
}

// 📡 开机自检播报
sendFeishu("📡 战车上线自检", "长官，V10.1 探照灯版已在云端点火！通讯正常，24小时全天候扫描战场！");
// ==========================================
// 💸 币安执行模块
// ==========================================
async function binanceReq(path, params, method = 'POST') {
    params.timestamp = Date.now();
    const query = querystring.stringify(params);
    const sig = crypto.createHmac('sha256', BINANCE_API_SECRET).update(query).digest('hex');
    const data = `${query}&signature=${sig}`;
    const options = {
        hostname: 'fapi.binance.com', path: method === 'GET' ? `${path}?${data}` : path,
        method: method, headers: { 'X-MBX-APIKEY': BINANCE_API_KEY }, timeout: 10000
    };
    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let b = ''; res.on('data', c => b += c);
            res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve(b); } });
        });
        req.on('error', reject); if (method === 'POST') req.write(data); req.end();
    });
}

async function getWallet() {
    try {
        const res = await binanceReq('/fapi/v2/account', {}, 'GET');
        return { available: parseFloat(res.availableBalance), total: parseFloat(res.totalMarginBalance), used: parseFloat(res.totalInitialMargin) };
    } catch(e) { return { available: 10, total: 10, used: 0 }; }
}

// ==========================================
// 📊 财务清算与大赦逻辑
// ==========================================
async function syncPositions() {
    const risk = await binanceReq('/fapi/v2/positionRisk', {}, 'GET');
    if (!Array.isArray(risk)) return;
    for (const symbol of SYMBOLS) {
        const r = risk.find(item => item.symbol === symbol);
        if (!r) continue;
        const amt = parseFloat(r.positionAmt);
        let p = positions[symbol];
        if (amt !== 0) {
            if (p.status === 'NONE') {
                p.status = amt > 0 ? 'LONG' : 'SHORT'; p.entryPrice = parseFloat(r.entryPrice);
                p.qty = Math.abs(amt); p.strategy = '云端接管'; p.entryTime = Date.now();
            }
        } else if (p.status !== 'NONE') {
            let pnl = p.status === 'LONG' ? (p.lastKnownPrice - p.entryPrice) * p.qty : (p.entryPrice - p.lastKnownPrice) * p.qty;
            if (pnl > 0) inMemoryDB.wins++; else inMemoryDB.losses++;
            inMemoryDB.totalPnl += pnl;
            if (p.maxMFEPercent >= 0.6 || pnl > 0) {
                p.consecutiveLosses = 0; p.lastCloseTime = 0;
                sendFeishu("💰 战斗总结", `[${symbol}] 胜利！平仓盈亏: ${pnl.toFixed(3)}U。刑期已豁免归零。`);
            } else {
                if (p.inJunjunMode) p.consecutiveLosses = 5; else p.consecutiveLosses++;
                p.lastCloseTime = Date.now();
                sendFeishu("🩸 战斗总结", `[${symbol}] 战损。盈亏: ${pnl.toFixed(3)}U。连亏计数: ${p.consecutiveLosses}`);
            }
            p.status = 'NONE'; p.maxMFEPercent = 0; p.amnestyNotified = false;
        }
    }
}
// ==========================================
// 🛡️ 核心决策引擎 (全透明呼吸灯)
// ==========================================
async function runMonitor() {
    try {
        await syncPositions();
        const snap = await getWallet();
        const now = Date.now();

        for (const symbol of SYMBOLS) {
            let p = positions[symbol];
            const r15 = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=15m&limit=30`);
            const r4h = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=4h&limit=60`);
            if (!Array.isArray(r15) || !Array.isArray(r4h)) continue;

            const c15 = r15.map(d => ({ o: +d[1], h: +d[2], l: +d[3], c: +d[4] }));
            const curP = c15[c15.length - 1].c;
            p.lastKnownPrice = curP;

            if (p.status !== 'NONE') {
                const mfe = p.status === 'LONG' ? (curP - p.entryPrice)/p.entryPrice*100 : (p.entryPrice - curP)/p.entryPrice*100;
                if (mfe > p.maxMFEPercent) p.maxMFEPercent = mfe;
                if (mfe >= 0.6 && !p.amnestyNotified) {
                    p.amnestyNotified = true;
                    sendFeishu("⭐ 浮盈过线", `[${symbol}] 浮盈达 ${mfe.toFixed(2)}%。已开启大赦保底！`);
                }
                console.log(`🛡️ [${symbol}] 持仓中 | 现价:${curP} | 最高浮盈:${p.maxMFEPercent.toFixed(2)}%`);
                continue;
            }

            const cm = [0, 5, 10, 20, 40, 60][Math.min(p.consecutiveLosses, 5)];
            let remains = (cm * 60 * 1000 - (now - p.lastCloseTime)) / 60000;
            const isLock = p.lastCloseTime > 0 && remains > 0;

            const ai = await askAI(symbol, { curP, rsi: calcRSI(c15) }, { ema50: calcEMA(r4h.map(d=>({c:+d[4]})), 50) });
            
            // 🔥 V10.1 核心恢复：AI 思考探照灯 (每2分钟打印一次，让你清清楚楚！)
            console.log(`🧠 [${symbol}] AI探测: ${ai.direction} | 把握: ${ai.confidence}% | 逻辑: ${ai.reason || '无'}`);

            if (ai.direction === 'WAIT') continue;

            let canGo = false, isJJ = false;
            const ema50_4h = calcEMA(r4h.map(d=>({c:+d[4]})), 50);

            if (ai.confidence >= 95) {
                console.log(`✨ [${symbol}] 触发 95% 圣光信号！无视规则强行开仓。`);
                canGo = true; isJJ = true;
            } else {
                if (isLock) {
                    if (ai.confidence >= 90) { 
                        const prev = c15[c15.length-2];
                        const cond = ai.direction==='LONG'?(curP>calcEMA(c15,9)&&curP>ema50_4h):(curP<calcEMA(c15,9)&&curP<ema50_4h);
                        if (cond) { canGo = true; isJJ = true; }
                    }
                } else if (ai.confidence >= 60) {
                    if ((ai.direction==='LONG'&&curP>ema50_4h)||(ai.direction==='SHORT'&&curP<ema50_4h)) canGo = true;
                }
            }

            if (canGo) {
                let budget = 0;
                const reserve = 0.5 * snap.total; 
                if (ai.confidence >= 90) budget = snap.available * 0.4; 
                else {
                    let commonLeft = reserve - snap.used;
                    if (commonLeft <= 0) continue;
                    budget = Math.min(snap.available * (ai.confidence>=80?0.2:0.1), commonLeft);
                }

                let q = roundQty(symbol, (budget * LEVERAGE) / curP);
                if (q * curP < 5.5) q = roundQty(symbol, 6/curP); 

                if (snap.available >= (q * curP / LEVERAGE)) {
                    const ok = await openOrder(symbol, ai.direction, q, ai.sl, curP, ai.confidence>=95?"圣光刺客":"普通刺客", isJJ);
                    if (ok) sendFeishu("🚀 战地开火", `[${symbol}] 开仓！方向:${ai.direction}\n信心:${ai.confidence}%\n兵力:${q}\n理由:${ai.reason}`);
                }
            }
        }
    } catch(e) { console.error("🔥 引擎波动:", e.message); }
}

// ==========================================
// 📦 工具与网页 
// ==========================================
async function fetchJSON(url) { return new Promise((resolve, reject) => { https.get(url, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); }).on('error', reject); }); }
async function postJSON(url, body, headers) { return new Promise((resolve, reject) => { const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, timeout: 25000 }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } }); }); req.on('error', reject); req.write(JSON.stringify(body)); req.end(); }); }
function calcEMA(data, p) { if (data.length < p) return data[data.length-1].c || data[data.length-1].close; let k = 2/(p+1), ema = data[0].c || data[0].close; for (let i=1; i<data.length; i++) ema = ((data[i].c || data[i].close) - ema) * k + ema; return ema; }
function calcRSI(data, p=14) { let g=0, l=0; for (let i=data.length-p; i<data.length; i++) { const d = data[i].c - data[i-1].c; if (d>0) g+=d; else l-=d; } return l===0 ? 100 : 100-(100/(1+(g/p)/(l/p))); }
function roundQty(symbol, qty) { let prec = QTY_PRECISION[symbol] || 3; return Math.max(parseFloat(parseFloat(qty).toFixed(prec)), Math.pow(10, -prec)); }

async function askAI(symbol, d15, d4) {
    if (!DEEPSEEK_API_KEY) return { direction: 'WAIT' };
    const prompt = `你是最高风控官。战场:[${symbol}]。数据:${JSON.stringify(d15)}。趋势:${JSON.stringify(d4)}。请根据共振分析，严格返回JSON:{"direction":"LONG/SHORT/WAIT","sl":止损价,"confidence":0-100,"reason":"简短理由"}`;
    try {
        const res = await postJSON("https://api.deepseek.com/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.1 }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
        return JSON.parse(res.choices[0].message.content.match(/\{[\s\S]*\}/)[0]);
    } catch (e) { return { direction: 'WAIT', confidence: 0 }; }
}

async function openOrder(symbol, dir, qty, sl, price, strategy, isJunjun) {
    const side = dir === 'LONG' ? 'BUY' : 'SELL', reverse = dir === 'LONG' ? 'SELL' : 'BUY';
    const res = await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: roundQty(symbol, qty) });
    if (res && res.code) return false;
    await binanceReq('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: reverse, type: 'STOP_MARKET', triggerPrice: parseFloat(sl).toFixed(PRICE_PRECISION[symbol]||2), quantity: roundQty(symbol, qty), reduceOnly: 'true' });
    await binanceReq('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: reverse, type: 'TRAILING_STOP_MARKET', callbackRate: '1.0', quantity: roundQty(symbol, qty), reduceOnly: 'true' });
    return true;
}

http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<h1>V10.1 飞书监控版</h1><h3>今日累计盈亏: ${inMemoryDB.totalPnl.toFixed(3)} U</h3><p>系统于 ${inMemoryDB.startTime} 启动</p>`);
}).listen(process.env.PORT || 3000);

// 🔥 V10.1 新增：飞书整点战报 (每小时自动汇报大局)
setInterval(() => {
    let msg = `💰 今日累计盈亏: ${inMemoryDB.totalPnl.toFixed(3)} U\n\n🎯 阵地状态:\n`;
    SYMBOLS.forEach(s => {
        let p = positions[s];
        msg += `- ${s}: ${p.status === 'NONE' ? '空仓💤' : p.status + ' (持仓中)'}\n`;
    });
    sendFeishu("📊 战车整点巡视", msg);
}, 60 * 60 * 1000);

setInterval(runMonitor, CHECK_INTERVAL_MS);
runMonitor();
