const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ==========================================
// 🔐 核心配置区
// ==========================================
const FEISHU_WEBHOOK_URL = "https://open.feishu.cn/open-apis/bot/v2/hook/6099f609-41c4-4364-b0d8-fdb986b821a2"; 

const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY; 

// 🛡️ 物理参数 (V11.0 纯血量化版)
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const PRICE_PRECISION = { 'BTCUSDT': 1, 'ETHUSDT': 2, 'SOLUSDT': 3 }; 
const QTY_PRECISION = { 'BTCUSDT': 3, 'ETHUSDT': 3, 'SOLUSDT': 1 }; 
const LEVERAGE = 20;
const CHECK_INTERVAL_MS = 2 * 60 * 1000; 

// 🎯 状态管理 (新增时间与保本追踪)
let positions = {};
SYMBOLS.forEach(sym => {
    positions[sym] = { 
        status: 'NONE', entryPrice: 0, qty: 0, entryTime: 0, strategy: '', 
        lastCloseTime: 0, consecutiveLosses: 0, maxMFEPercent: 0, 
        amnestyNotified: false, breakevenSet: false, lastKnownPrice: 0 
    };
});

let inMemoryDB = { wins: 0, losses: 0, totalPnl: 0, startTime: new Date().toLocaleString() };

console.log("🚀 V11.0 纯血量化版启动！三叉戟数学雷达已挂载，AI 政委已上线！");

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
sendFeishu("📡 V11.0 终极点火", "长官，V11.0 已换装完毕！多因子共振开启，ATR动态防御就绪，开始狩猎狗庄！");

// ==========================================
// 💸 币安核心执行模块
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

async function closePosition(symbol) {
    const p = positions[symbol];
    if (p.status === 'NONE') return;
    const side = p.status === 'LONG' ? 'SELL' : 'BUY';
    await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: p.qty });
    await binanceReq('/fapi/v1/allOpenOrders', { symbol }, 'DELETE'); // 撤销之前的止损止盈单
}
// ==========================================
// 🧮 华尔街数学指标库 (三叉戟核心)
// ==========================================
async function fetchJSON(url) { return new Promise((resolve, reject) => { https.get(url, {timeout: 15000}, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); }).on('error', reject); }); }
async function postJSON(url, body, headers) { return new Promise((resolve, reject) => { const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, timeout: 25000 }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } }); }); req.on('error', reject); req.write(JSON.stringify(body)); req.end(); }); }

function calcEMA(data, p) { if (data.length < p) return data[data.length-1].c; let k = 2/(p+1), ema = data[0].c; for (let i=1; i<data.length; i++) ema = (data[i].c - ema) * k + ema; return ema; }
function calcRSI(data, p=14) { let g=0, l=0; for (let i=data.length-p; i<data.length; i++) { const d = data[i].c - data[i-1].c; if (d>0) g+=d; else l-=d; } return l===0 ? 100 : 100-(100/(1+(g/p)/(l/p))); }
function calcATR(data, p=14) { let trs = []; for(let i=1; i<data.length; i++){ let h = data[i].h, l = data[i].l, pc = data[i-1].c; trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc))); } let atr = trs.slice(0, p).reduce((a,b)=>a+b)/p; for(let i=p; i<trs.length; i++) atr = (atr*(p-1)+trs[i])/p; return atr; }
function roundQty(symbol, qty) { let prec = QTY_PRECISION[symbol] || 3; return Math.max(parseFloat(parseFloat(qty).toFixed(prec)), Math.pow(10, -prec)); }

async function getFundingRate(symbol) {
    try { const res = await binanceReq('/fapi/v1/premiumIndex', { symbol }, 'GET'); return parseFloat(res.lastFundingRate); } 
    catch(e) { return 0; }
}

// 🧠 AI 政委终审 (结合数学雷达的判决)
async function askAI(symbol, mathDir, strategyName, d15) {
    if (!DEEPSEEK_API_KEY || mathDir === 'WAIT') return { direction: 'WAIT', confidence: 0, reason: '雷达无信号' };
    const prompt = `你是量化基金政委。底层数学雷达已触发【${strategyName}】信号，建议方向: ${mathDir}。当前标的:${symbol}。最近K线:${JSON.stringify(d15.slice(-5))}。
    请结合宏观形态进行最终审批。严格返回JSON: {"direction":"${mathDir}或WAIT", "confidence":0-100, "reason":"简短理由"}`;
    try {
        const res = await postJSON("https://api.deepseek.com/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.1 }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
        return JSON.parse(res.choices[0].message.content.match(/\{[\s\S]*\}/)[0]);
    } catch (e) { return { direction: 'WAIT', confidence: 0, reason: 'AI网络波动' }; }
}

async function openOrder(symbol, dir, qty, sl, strategy) {
    const side = dir === 'LONG' ? 'BUY' : 'SELL', reverse = dir === 'LONG' ? 'SELL' : 'BUY';
    const res = await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: roundQty(symbol, qty) });
    if (res && res.code) return false;
    await binanceReq('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: reverse, type: 'STOP_MARKET', triggerPrice: parseFloat(sl).toFixed(PRICE_PRECISION[symbol]||2), quantity: roundQty(symbol, qty), reduceOnly: 'true' });
    await binanceReq('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: reverse, type: 'TRAILING_STOP_MARKET', callbackRate: '1.0', quantity: roundQty(symbol, qty), reduceOnly: 'true' });
    return true;
}
// ==========================================
// 📊 V11.0 核心决策与监控循环
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
                p.qty = Math.abs(amt); p.strategy = p.strategy || '云端接管'; p.entryTime = p.entryTime || Date.now();
            }
        } else if (p.status !== 'NONE') {
            let pnl = p.status === 'LONG' ? (p.lastKnownPrice - p.entryPrice) * p.qty : (p.entryPrice - p.lastKnownPrice) * p.qty;
            if (pnl > 0) inMemoryDB.wins++; else inMemoryDB.losses++;
            inMemoryDB.totalPnl += pnl;
            if (p.maxMFEPercent >= 0.6 || pnl > 0) {
                p.consecutiveLosses = 0; p.lastCloseTime = 0;
                sendFeishu("💰 战斗胜利", `[${symbol}] ${p.strategy} 捷报！\n平仓盈亏: +${pnl.toFixed(3)}U\n刑期归零，准备下一次狩猎。`);
            } else {
                p.consecutiveLosses++; p.lastCloseTime = Date.now();
                sendFeishu("🩸 战损割肉", `[${symbol}] ${p.strategy} 撤退。\n平仓盈亏: ${pnl.toFixed(3)}U\n连亏计数: ${p.consecutiveLosses}。已关入小黑屋。`);
            }
            p.status = 'NONE'; p.maxMFEPercent = 0; p.amnestyNotified = false; p.breakevenSet = false;
        }
    }
}

async function runMonitor() {
    try {
        await syncPositions();
        const snap = await getWallet();
        const now = Date.now();
        
        // 抓取 BTC 大盘走势 (大盘连坐判定)
        const btcData = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=50`);
        const btcC15 = btcData.map(d => ({ c: +d[4] }));
        const btcEMA = calcEMA(btcC15, 20);
        const btcTrend = btcC15[btcC15.length-1].c > btcEMA ? 'BULL' : 'BEAR';

        for (const symbol of SYMBOLS) {
            let p = positions[symbol];
            const r15 = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=15m&limit=100`);
            const r4h = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=4h&limit=60`);
            if (!Array.isArray(r15) || !Array.isArray(r4h)) continue;

            const c15 = r15.map(d => ({ o: +d[1], h: +d[2], l: +d[3], c: +d[4], v: +d[5] }));
            const curP = c15[c15.length - 1].c;
            const atr = calcATR(c15, 14);
            p.lastKnownPrice = curP;

            // 🛡️ 持仓监控：护城河与超时撤退
            if (p.status !== 'NONE') {
                const holdTimeMin = Math.floor((now - p.entryTime) / 60000);
                const mfe = p.status === 'LONG' ? (curP - p.entryPrice)/p.entryPrice*100 : (p.entryPrice - curP)/p.entryPrice*100;
                if (mfe > p.maxMFEPercent) p.maxMFEPercent = mfe;
                
                // 12小时僵尸单强平
                if (holdTimeMin > 12 * 60) {
                    sendFeishu("⏱️ 超时强平", `[${symbol}] 持仓超过12小时死水横盘，触发强行撤军释放预备队！`);
                    await closePosition(symbol); continue;
                }
                
                // 1.5% 触发保本护城河 (物理兜底)
                if (mfe >= 1.5 && !p.breakevenSet) {
                    p.breakevenSet = true;
                    sendFeishu("🏰 护城河建立", `[${symbol}] 浮盈达 ${mfe.toFixed(2)}%。已开启无敌保本模式！`);
                }
                if (p.breakevenSet && mfe <= 0.2) {
                    sendFeishu("🛡️ 保本出局", `[${symbol}] 狗庄反扑，护城河生效，零亏损离场！`);
                    await closePosition(symbol); continue;
                }

                console.log(`🛡️ [${symbol}] ${p.strategy} 持仓 | 时长:${holdTimeMin}分 | 现价:${curP} | 最高浮盈:${p.maxMFEPercent.toFixed(2)}% | 护城河:${p.breakevenSet?'开':'关'}`);
                continue;
            }

            // ⛓️ 小黑屋逻辑
            const cm = [0, 5, 10, 20, 40, 60][Math.min(p.consecutiveLosses, 5)];
            let remains = (cm * 60 * 1000 - (now - p.lastCloseTime)) / 60000;
            if (p.lastCloseTime > 0 && remains > 0) {
                console.log(`⛓️ [${symbol}] 禁闭中，剩余 ${remains.toFixed(1)} 分钟`); continue;
            }

            // 🛑 死水行情免战牌
            const avgAtr = c15.slice(-50).reduce((sum, k) => sum + (k.h-k.l), 0) / 50;
            if (atr < avgAtr * 0.4) { console.log(`💤 [${symbol}] 波动率干涸，免战牌挂起`); continue; }

            // 🔱 三叉戟数学雷达
            let mathDir = 'WAIT', stratName = '';
            const cur = c15[c15.length-1], prev = c15[c15.length-2];
            const rsi = calcRSI(c15);
            
            // 策略A：背离狙击手 (简化版逻辑)
            if (rsi < 30 && cur.c < c15[c15.length-10].l) { mathDir = 'LONG'; stratName = '背离狙击手'; }
            else if (rsi > 70 && cur.c > c15[c15.length-10].h) { mathDir = 'SHORT'; stratName = '背离狙击手'; }
            
            // 策略B：猎杀突击队 (SMC 假突破针)
            const pinbarLong = (prev.c - prev.l)/(prev.h - prev.l || 1) > 0.65 && cur.c > prev.c;
            const pinbarShort = (prev.h - prev.c)/(prev.h - prev.l || 1) > 0.65 && cur.c < prev.c;
            if (pinbarLong) { mathDir = 'LONG'; stratName = '猎杀突击队'; }
            else if (pinbarShort) { mathDir = 'SHORT'; stratName = '猎杀突击队'; }

            // 策略C：放量冲锋营
            const avgVol = c15.slice(-20).reduce((a,b)=>a+b.v,0)/20;
            if (cur.c > c15[c15.length-5].h && cur.v > avgVol * 3) { mathDir = 'LONG'; stratName = '放量冲锋营'; }
            else if (cur.c < c15[c15.length-5].l && cur.v > avgVol * 3) { mathDir = 'SHORT'; stratName = '放量冲锋营'; }

            // 📉 过滤层：资金费率与大盘连坐与 4H 顺势
            if (mathDir !== 'WAIT') {
                const ema4h = calcEMA(r4h.map(d=>({c:+d[4]})), 50);
                if ((mathDir === 'LONG' && curP < ema4h) || (mathDir === 'SHORT' && curP > ema4h)) {
                    console.log(`⛔ [${symbol}] 雷达探测到 ${mathDir}，但逆 4H 大势，一票否决！`); mathDir = 'WAIT';
                }
                if (symbol !== 'BTCUSDT') {
                    if ((mathDir === 'LONG' && btcTrend === 'BEAR') || (mathDir === 'SHORT' && btcTrend === 'BULL')) {
                        console.log(`⛔ [${symbol}] 雷达逆 BTC 大盘情绪，一票否决！`); mathDir = 'WAIT';
                    }
                }
                const fr = await getFundingRate(symbol);
                if ((mathDir === 'LONG' && fr > 0.0005) || (mathDir === 'SHORT' && fr < -0.0005)) {
                    console.log(`⛔ [${symbol}] 资金费率极端 (${fr})，谨防杀散户陷阱，一票否决！`); mathDir = 'WAIT';
                }
            }

            if (mathDir === 'WAIT') {
                console.log(`📡 [${symbol}] 三叉戟静默扫描中...`); continue;
            }

            // 🧠 AI 政委终审
            console.log(`⚠️ [${symbol}] 雷达锁定目标: ${mathDir}，提交 AI 政委审批...`);
            const ai = await askAI(symbol, mathDir, stratName, c15);
            console.log(`🧠 [${symbol}] 政委裁决: ${ai.direction} | 信心: ${ai.confidence}% | 理由: ${ai.reason}`);

            if (ai.direction === mathDir && ai.confidence >= 70) {
                // 🧮 凯利资金分配与 ATR 止损
                let budget = snap.available * (ai.confidence >= 90 ? 0.3 : 0.15);
                if (snap.total * 0.5 - snap.used < budget) budget = Math.max(0, snap.total * 0.5 - snap.used);
                
                let q = roundQty(symbol, (budget * LEVERAGE) / curP);
                if (q * curP < 6) q = roundQty(symbol, 6.5/curP); // 满足币安最低 5U 要求
                
                let slPrice = mathDir === 'LONG' ? curP - (1.5 * atr) : curP + (1.5 * atr);

                if (snap.available >= (q * curP / LEVERAGE)) {
                    const ok = await openOrder(symbol, mathDir, q, slPrice, stratName);
                    if (ok) {
                        p.strategy = stratName; p.entryTime = now;
                        sendFeishu(`🚀 ${stratName} 出击`, `[${symbol}] 已开仓！\n方向: ${mathDir}\n信心: ${ai.confidence}%\n兵力: ${q}\n动态止损: ${slPrice.toFixed(PRICE_PRECISION[symbol]||2)}\n政委批示: ${ai.reason}`);
                    }
                }
            }
        }
    } catch(e) { console.error("🔥 引擎波动:", e.message); }
}

http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<h1>V11.0 纯血量化版</h1><h3>今日累计盈亏: ${inMemoryDB.totalPnl.toFixed(3)} U</h3><p>三叉戟雷达与AI政委运作中</p><p>系统启动于 ${inMemoryDB.startTime}</p>`);
}).listen(process.env.PORT || 3000);

// 🔥 整点战报 (每小时自动汇报大局)
setInterval(() => {
    let msg = `💰 今日累计盈亏: ${inMemoryDB.totalPnl.toFixed(3)} U\n\n🎯 阵地状态:\n`;
    SYMBOLS.forEach(s => { let p = positions[s]; msg += `- ${s}: ${p.status === 'NONE' ? '空仓💤' : p.status + ' ('+p.strategy+')'}\n`; });
    sendFeishu("📊 V11.0 军情总览", msg);
}, 60 * 60 * 1000);

setInterval(runMonitor, CHECK_INTERVAL_MS);
runMonitor();
