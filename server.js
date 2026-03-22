const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ==========================================
// 🔐 核心配置区
// ==========================================
const EMAILJS_SERVICE_ID = "service_op2rg49"; 
const EMAILJS_TEMPLATE_ID = "template_eftwoy6"; 
const EMAILJS_PUBLIC_KEY = "tIZB9DwwpEKr3KQpQ"; 
const NOTIFY_EMAIL = "2183089849@qq.com";
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY; 
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;

// 🛡️ 物理参数 (SOL 已锁定 0.1 兵力精度)
const SYMBOLS = ['ETHUSDT', 'BTCUSDT', 'SOLUSDT'];
const PRICE_PRECISION = { 'BTCUSDT': 1, 'ETHUSDT': 2, 'SOLUSDT': 3 }; 
const QTY_PRECISION = { 'BTCUSDT': 3, 'ETHUSDT': 3, 'SOLUSDT': 1 }; 
const LEVERAGE = 20;
const CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2分钟扫描一次

// 🎯 状态跟踪系统 (加厚初始化)
let positions = {};
SYMBOLS.forEach(sym => {
    positions[sym] = { 
        status: 'NONE', 
        entryPrice: 0, 
        qty: 0, 
        entryTime: 0, 
        strategy: '', 
        lastAICheckTime: 0,
        lastCloseTime: 0, 
        consecutiveLosses: 0, 
        maxMFEPercent: 0, 
        amnestyNotified: false, 
        inJunjunMode: false, 
        lastKnownPrice: 0 
    };
});

// 财务统计
let inMemoryDB = { 
    recent_trades: [], 
    stats: { wins: 0, losses: 0, totalPnl: 0, lastReportTime: Date.now() } 
};

console.log("🚀 V9.9 终极完全体 (重装加厚版) 正在启动核心引擎...");

// ==========================================
// 💸 币安执行引擎 (含超时保护)
// ==========================================
async function binanceReq(path, params, method = 'POST') {
    if (!BINANCE_API_KEY) return null;
    params.timestamp = Date.now();
    const query = querystring.stringify(params);
    const sig = crypto.createHmac('sha256', BINANCE_API_SECRET).update(query).digest('hex');
    const data = `${query}&signature=${sig}`;
    
    const options = {
        hostname: 'fapi.binance.com',
        path: method === 'GET' ? `${path}?${data}` : path,
        method: method,
        headers: { 'X-MBX-APIKEY': BINANCE_API_KEY },
        timeout: 10000
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let b = ''; res.on('data', c => b += c);
            res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve(b); } });
        });
        req.on('error', reject);
        if (method === 'POST') req.write(data);
        req.end();
    });
}

// 查家底雷达
async function getWallet() {
    try {
        const res = await binanceReq('/fapi/v2/account', {}, 'GET');
        return {
            available: parseFloat(res.availableBalance || 0),
            total: parseFloat(res.totalMarginBalance || 0),
            used: parseFloat(res.totalInitialMargin || 0)
        };
    } catch(e) { return { available: 10, total: 10, used: 0 }; }
}

// ==========================================
// 🛡️ 战术执行单元
// ==========================================
function roundQty(symbol, qty) {
    let prec = QTY_PRECISION[symbol] || 3;
    let rounded = parseFloat(parseFloat(qty).toFixed(prec));
    return Math.max(rounded, Math.pow(10, -prec));
}

async function openOrder(symbol, dir, qty, sl, price, strategy, isJunjun) {
    const side = dir === 'LONG' ? 'BUY' : 'SELL';
    const reverse = dir === 'LONG' ? 'SELL' : 'BUY';
    const precP = PRICE_PRECISION[symbol] || 2;

    // 1. 开仓
    const res = await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: roundQty(symbol, qty) });
    if (res && res.code) { console.error(`❌ [${symbol}] 开仓失败:`, res.msg); return false; }

    // 2. 挂止损
    const slP = parseFloat(sl).toFixed(precP);
    await binanceReq('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: reverse, type: 'STOP_MARKET', triggerPrice: slP, quantity: roundQty(symbol, qty), reduceOnly: 'true' });

    // 3. 挂止盈 (网格固定，其他追踪)
    if (strategy === '网格撸毛兵') {
        const tp = (dir === 'LONG' ? price * 1.01 : price * 0.99).toFixed(precP);
        await binanceReq('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: reverse, type: 'TAKE_PROFIT_MARKET', stopPrice: tp, quantity: roundQty(symbol, qty), reduceOnly: 'true' });
        console.log(`🎯 [${symbol}] 网格 1% 固定止盈挂载完毕`);
    } else {
        await binanceReq('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: reverse, type: 'TRAILING_STOP_MARKET', callbackRate: '1.0', quantity: roundQty(symbol, qty), reduceOnly: 'true' });
        console.log(`🚀 [${symbol}] 1.0% 回撤追踪导弹已就位`);
    }

    positions[symbol].inJunjunMode = isJunjun;
    return true;
}
// ==========================================
// 📊 财务清算系统 (逻辑加厚)
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
            // 发现持仓，如果本地是NONE，说明是接管的
            if (p.status === 'NONE') {
                console.log(`🔄 [${symbol}] 监测到云端持仓，系统接管中...`);
                p.status = amt > 0 ? 'LONG' : 'SHORT';
                p.entryPrice = parseFloat(r.entryPrice);
                p.qty = Math.abs(amt);
                p.entryTime = Date.now();
                p.strategy = '云端接管';
            }
        } else if (p.status !== 'NONE') {
            // 发现平仓，开始算账
            console.log(`✅ [${symbol}] 战斗结束，正在清算盈亏...`);
            let pnl = p.status === 'LONG' ? (p.lastKnownPrice - p.entryPrice) * p.qty : (p.entryPrice - p.lastKnownPrice) * p.qty;
            
            if (pnl > 0) inMemoryDB.stats.wins++; else inMemoryDB.stats.losses++;
            inMemoryDB.stats.totalPnl += pnl;

            // 🔥 大赦判定：浮盈过0.6%或直接盈利，清零刑期
            if (p.maxMFEPercent >= 0.6 || pnl > 0) {
                console.log(`💰 [${symbol}] 满足大赦条件，连亏清零！`);
                p.consecutiveLosses = 0; p.lastCloseTime = 0;
            } else {
                if (p.inJunjunMode) {
                    console.log(`💀 [${symbol}] 军令状挑战失败，顶格封禁 60 分钟！`);
                    p.consecutiveLosses = 5; 
                } else {
                    p.consecutiveLosses++;
                    console.log(`🩸 [${symbol}] 纯战损，连亏阶梯加码: ${p.consecutiveLosses}`);
                }
                p.lastCloseTime = Date.now();
            }

            p.status = 'NONE'; p.maxMFEPercent = 0; p.amnestyNotified = false; p.inJunjunMode = false;
        }
    }
}

// ==========================================
// 🛡️ 核心决策引擎 (全逻辑补齐)
// ==========================================
async function runMonitor() {
    try {
        await syncPositions();
        const snap = await getWallet();
        const now = Date.now();

        for (const symbol of SYMBOLS) {
            let p = positions[symbol];
            
            // 1. 获取行情
            const r15 = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=15m&limit=30`);
            const r4h = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=4h&limit=60`);
            if (!Array.isArray(r15) || !Array.isArray(r4h)) continue;

            const c15 = r15.map(d => ({ o: +d[1], h: +d[2], l: +d[3], c: +d[4] }));
            const curP = c15[c15.length - 1].c;
            p.lastKnownPrice = curP;

            const rsi = calcRSI(c15);
            const ema50 = calcEMA(r4h.map(d=>({c:+d[4]})), 50);
            const ema9 = calcEMA(c15.map(d=>({c:d.c})), 9);

            // 2. 持仓监控
            if (p.status !== 'NONE') {
                const mfe = p.status === 'LONG' ? (curP - p.entryPrice)/p.entryPrice*100 : (p.entryPrice - curP)/p.entryPrice*100;
                if (mfe > p.maxMFEPercent) p.maxMFEPercent = mfe;
                if (mfe >= 0.6 && !p.amnestyNotified) {
                    p.amnestyNotified = true;
                    sendEmail(`⭐ [${symbol}] 浮盈过线`, `大赦天下已激活！本单保底利润或刑期豁免已生效。`);
                }
                console.log(`🛡️ [${symbol}] 持仓中 | 现价:${curP} | 最高浮盈:${p.maxMFEPercent.toFixed(2)}%`);
                continue;
            }

            // 3. 冷却与分析
            const cooldowns = [0, 5, 10, 20, 40, 60];
            const cm = cooldowns[Math.min(p.consecutiveLosses, 5)];
            let remains = (cm * 60 * 1000 - (now - p.lastCloseTime)) / 60000;
            const isLock = p.lastCloseTime > 0 && remains > 0;

            const strategy = rsi < 30 || rsi > 70 ? "马丁接针兵" : (calcATR(c15)/curP < 0.0015 ? "网格撸毛兵" : "刺客");
            const ai = await askAI(symbol, { curP, rsi, strategy }, { ema50 });

            console.log(`🧠 [${symbol}] AI建议:${ai.direction} | 信心:${ai.confidence}% | 冷却:${isLock ? remains.toFixed(1)+'分' : '无'}`);

            if (ai.direction === 'WAIT') continue;

            // 4. 越狱与资源调度核心
            let canGo = false, isJJ = false;
            if (isLock) {
                if (ai.confidence >= 90) {
                    const prev = c15[c15.length-2];
                    const physical = ai.direction === 'LONG' ? (prev.c > prev.o && curP > ema9) : (prev.c < prev.o && curP < ema9);
                    if (physical) { canGo = true; isJJ = true; }
                }
            } else if (ai.confidence >= 60) {
                canGo = true;
            }

            if (canGo) {
                // 均线判官
                if ((ai.direction==='LONG' && curP < ema50) || (ai.direction==='SHORT' && curP > ema50)) {
                    console.log(`🛑 [${symbol}] 逆向均线，物理锁死！`);
                    continue;
                }

                // 💸 动态资金分配 (凯利B + 50%预备队)
                let budget = 0;
                const reserve = 0.5 * snap.total; // 50% 红线

                if (ai.confidence >= 90) {
                    // 老大模式：直接动用总可用余额的 40% (突破50%红线)
                    budget = snap.available * 0.4;
                    console.log(`🔥 [${symbol}] 老大降临，开启金库！`);
                } else {
                    // 常规模式：只能在 50% 红线剩余配额内挤海绵
                    let commonLeft = reserve - snap.used;
                    if (commonLeft <= 0) {
                        console.log(`🛑 [${symbol}] 常规额度已耗尽，等待老大或平仓。`);
                        continue;
                    }
                    let want = snap.available * (ai.confidence >= 80 ? 0.2 : 0.1);
                    budget = Math.min(want, commonLeft);
                }

                let q = roundQty(symbol, (budget * LEVERAGE) / curP);
                if (q * curP < 5.5) q = roundQty(symbol, 6/curP); // 5U保底

                if (snap.available >= (q * curP / LEVERAGE)) {
                    const ok = await openOrder(symbol, ai.direction, q, ai.sl, curP, strategy, isJJ);
                    if (ok) console.log(`🚀 [${symbol}] 开仓成功！信心:${ai.confidence}% | 数量:${q}`);
                }
            }
        }
    } catch(e) { console.error("🔥 核心异常:", e.message); }
}
// ==========================================
// 📦 辅助函数 (完整重构)
// ==========================================
async function fetchJSON(url) { return new Promise((resolve, reject) => { https.get(url, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); }).on('error', reject); }); }
async function postJSON(url, body, headers) { return new Promise((resolve, reject) => { const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, timeout: 25000 }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } }); }); req.on('error', reject); req.write(JSON.stringify(body)); req.end(); }); }

function calcEMA(data, p) { if (data.length < p) return data[data.length-1].c; let k = 2/(p+1), ema = data[0].c; for (let i=1; i<data.length; i++) ema = (data[i].c - ema) * k + ema; return ema; }
function calcRSI(data, p=14) { let g=0, l=0; for (let i=data.length-p; i<data.length; i++) { const d = data[i].c - data[i-1].c; if (d>0) g+=d; else l-=d; } return l===0 ? 100 : 100-(100/(1+(g/p)/(l/p))); }
function calcATR(data, p=14) { let s=0; for (let i=data.length-p; i<data.length; i++) s += Math.max(data[i].h-data[i].l, Math.abs(data[i].h-data[i-1].c), Math.abs(data[i].l-data[i-1].c)); return s/p; }

async function askAI(symbol, d15, d4) {
    if (!DEEPSEEK_API_KEY) return { direction: 'WAIT' };
    const prompt = `你是风控官。战场:[${symbol}]。15m指标:${JSON.stringify(d15)}。4H大势:${JSON.stringify(d4)}。请根据共振分析，严格返回JSON:{"direction":"LONG/SHORT/WAIT","sl":止损价,"confidence":0-100,"reason":"理由"}`;
    try {
        const res = await postJSON("https://api.deepseek.com/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.1 }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
        const match = res.choices[0].message.content.match(/\{[\s\S]*\}/);
        return JSON.parse(match[0]);
    } catch (e) { return { direction: 'WAIT', confidence: 0 }; }
}

async function sendEmail(title, html) {
    try {
        await postJSON("https://api.emailjs.com/api/v1.0/email/send", {
            service_id: EMAILJS_SERVICE_ID, template_id: EMAILJS_TEMPLATE_ID, user_id: EMAILJS_PUBLIC_KEY, accessToken: EMAILJS_PRIVATE_KEY,
            template_params: { to_email: NOTIFY_EMAIL, message: html, interval: title }
        });
    } catch (e) {}
}

// ==========================================
// 🌐 监控网页 (加厚可视化)
// ==========================================
http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    let color = inMemoryDB.stats.totalPnl >= 0 ? 'green' : 'red';
    let html = `<html><head><style>body{font-family:sans-serif;text-align:center;padding:20px;} .card{border:1px solid #ccc;padding:15px;margin:10px auto;max-width:400px;border-radius:10px;text-align:left;} .pnl{font-size:24px;font-weight:bold;color:${color};}</style></head><body>`;
    html += `<h1>V9.9 终极全功能版</h1>`;
    html += `<div class="pnl">今日利润: ${inMemoryDB.stats.totalPnl.toFixed(3)} U</div>`;
    html += `<p>胜率: ${inMemoryDB.stats.wins} / ${inMemoryDB.stats.wins+inMemoryDB.stats.losses}</p>`;
    
    SYMBOLS.forEach(s => {
        let p = positions[s];
        html += `<div class="card"><b>${s}</b>: ${p.status} <br> 策略: ${p.strategy} <br> 连亏阶梯: ${p.consecutiveLosses} / 5 <br> MFE: ${p.maxMFEPercent.toFixed(2)}%</div>`;
    });
    
    html += `</body></html>`;
    res.end(html);
}).listen(process.env.PORT || 3000);

setInterval(runMonitor, CHECK_INTERVAL_MS);
runMonitor();
