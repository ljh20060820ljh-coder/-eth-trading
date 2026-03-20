const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ==========================================
// 🔐 核心与 API 配置
// ==========================================
const EMAILJS_SERVICE_ID = "service_op2rg49"; 
const EMAILJS_TEMPLATE_ID = "template_eftwoy6"; 
const EMAILJS_PUBLIC_KEY = "tIZB9DwwpEKr3KQpQ"; 
const NOTIFY_EMAIL = "2183089849@qq.com";
const KV_REST_API_URL = "https://exact-sparrow-75815.upstash.io"; 

const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

const TRADE_QTY = 0.01; // 试枪锁

const SYMBOLS = ["ETHUSDT"]; 
const TIMEFRAME = "15m"; 
const TREND_TIMEFRAME = "1h"; 
const CHECK_INTERVAL_MS = 2 * 60 * 1000; 
const ALERT_CHECK_INTERVAL = 10 * 1000; 

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY; 
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;
const SERVERCHAN_SENDKEY = process.env.SERVERCHAN_SENDKEY; 

let position = { status: 'NONE', entryPrice: null, sl: null, tp: null, entryTime: null };
let lastPrice = null;
let isMonitoringActive = true; 
let inMemoryDB = { trade_logs: [], price_alerts: [] }; 

console.log("👑 V5.2 疯狗刺客 (Algo专属通道版) 已上线！交易数量锁死在:", TRADE_QTY, "ETH");

// ==========================================
// 💸 币安 API 核心执行引擎 (双通道支持)
// ==========================================
async function executeBinanceOrder(endpointPath, params) {
    if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
        console.log("⚠️ 缺失币安 API Key，无法执行实盘下单！");
        return null;
    }
    params.timestamp = Date.now();
    const queryStr = querystring.stringify(params);
    const signature = crypto.createHmac('sha256', BINANCE_API_SECRET).update(queryStr).digest('hex');
    const data = `${queryStr}&signature=${signature}`;

    const options = {
        hostname: 'fapi.binance.com',
        path: endpointPath,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-MBX-APIKEY': BINANCE_API_KEY }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let body = ''; res.on('data', chunk => body += chunk);
            res.on('end', () => {
                const response = JSON.parse(body);
                if (response.code) console.error(`❌ 币安下单失败 [${endpointPath}]:`, response);
                else console.log(`✅ 币安下单成功: ${params.side} ${params.type} | 返回流水号: ${response.orderId || response.algoId || 'AlgoSuccess'}`);
                resolve(response);
            });
        });
        req.on('error', reject); req.write(data); req.end();
    });
}

// 🔥 V5.2 修复版组合拳：普通通道开仓 + Algo通道挂止盈止损
async function autoTrade(symbol, direction, qty, slPrice, tpPrice) {
    console.log(`🔫 开始执行自动化狙击: ${direction} | 数量: ${qty}`);
    const isLong = direction === 'LONG';
    const entrySide = isLong ? 'BUY' : 'SELL';
    const exitSide = isLong ? 'SELL' : 'BUY';
    
    // 1. 发送市价开仓单 (走基础 /fapi/v1/order 通道)
    const entryRes = await executeBinanceOrder('/fapi/v1/order', { symbol, side: entrySide, type: 'MARKET', quantity: qty });
    if (entryRes && entryRes.code) return false; 

    const sl = parseFloat(slPrice).toFixed(2);
    const tp = parseFloat(tpPrice).toFixed(2);

    // 2. 挂止损单 (走最新的 /fapi/v1/algoOrder 通道，必须带 algoType 和 triggerPrice)
    await executeBinanceOrder('/fapi/v1/algoOrder', { 
        algoType: 'CONDITIONAL', symbol, side: exitSide, type: 'STOP_MARKET', 
        triggerPrice: sl, quantity: qty, reduceOnly: 'true' 
    });
    
    // 3. 挂止盈单 (走最新的 /fapi/v1/algoOrder 通道)
    await executeBinanceOrder('/fapi/v1/algoOrder', { 
        algoType: 'CONDITIONAL', symbol, side: exitSide, type: 'TAKE_PROFIT_MARKET', 
        triggerPrice: tp, quantity: qty, reduceOnly: 'true' 
    });
    
    return true;
}

// ==========================================
// 📦 工具函数 & 指标 
// ==========================================
function postJSON(url, body, extraHeaders) { return new Promise((resolve, reject) => { const data = JSON.stringify(body); const urlObj = new URL(url); const options = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(extraHeaders||{}) } }; const req = https.request(options, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${d}`)); else { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } } }); }); req.on('error', reject); req.write(data); req.end(); }); }
function fetchJSON(url) { return new Promise((resolve, reject) => { https.get(url, { headers: { 'User-Agent': 'Assassin-Bot/5.2' } }, (res) => { let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } }); }).on('error', reject); }); }
async function sendWeChatPush(title, desp) { if(SERVERCHAN_SENDKEY) try { await postJSON(`https://sctapi.ftqq.com/${SERVERCHAN_SENDKEY}.send`, { title, desp }); }catch(e){} }
async function sendSignalEmail(action, messageHtml, price, titleStr, symbol) { const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }); try { await postJSON("https://api.emailjs.com/api/v1.0/email/send", { service_id: EMAILJS_SERVICE_ID, template_id: EMAILJS_TEMPLATE_ID, user_id: EMAILJS_PUBLIC_KEY, accessToken: EMAILJS_PRIVATE_KEY, template_params: { to_email: NOTIFY_EMAIL, symbol: symbol, interval: titleStr, signal: action, price: price.toString(), message: messageHtml, time: time }}); } catch (e) {} }
async function loadData(key) { if (!KV_REST_API_URL || !KV_REST_API_TOKEN) return inMemoryDB[key] || []; try { const res = await fetchJSON(`${KV_REST_API_URL}/get/${key}`, { Authorization: `Bearer ${KV_REST_API_TOKEN}` }); if (res.result) return typeof res.result === 'string' ? JSON.parse(res.result) : res.result; } catch(e) {} return inMemoryDB[key] || []; }
async function saveData(key, data) { inMemoryDB[key] = data; if (KV_REST_API_URL && KV_REST_API_TOKEN) { try { await postJSON(`${KV_REST_API_URL}/set/${key}`, data, { Authorization: `Bearer ${KV_REST_API_TOKEN}` }); }catch(e){} } }
async function addTradeLog(action, entryPrice, sl, tp, reason) { const logs = await loadData('trade_logs'); logs.push({ id: Date.now().toString(), symbol: "ETHUSDT", action, entryPrice, sl, tp, reason, time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }); await saveData('trade_logs', logs.slice(-50)); }
function calcMA(data, p) { if (data.length < p) return 0; return data.slice(-p).reduce((sum, c) => sum + c.close, 0) / p; }
function calcRSI(data, p = 14) { if (data.length < p + 1) return 50; let g = 0, l = 0; for (let i = data.length - p; i < data.length; i++) { const diff = data[i].close - data[i-1].close; if (diff > 0) g += diff; else l -= diff; } const avgLoss = l / p; if (avgLoss === 0) return 100; return 100 - (100 / (1 + (g / p) / avgLoss)); }
function calcATR(data, p = 14) { if (data.length < p + 1) return 0; let sumTR = 0; for (let i = data.length - p; i < data.length; i++) { const h = data[i].high, l = data[i].low, pc = data[i-1].close; sumTR += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); } return sumTR / p; }
function calcEMA(data, p) { if (data.length < p) return data[data.length-1].close; let sum = 0; for(let i=0; i<p; i++) sum += data[i].close; let ema = sum / p; const k = 2 / (p + 1); for (let i = p; i < data.length; i++) { ema = (data[i].close - ema) * k + ema; } return ema; }

// ==========================================
// 🧠 AI 寻找入场点
// ==========================================
async function askAIForEntry(marketData) {
  if (!DEEPSEEK_API_KEY) return null;
  const prompt = `你是极度激进的“15分钟高频短线游资”。你的任务是只要有波动，就必须寻找交易机会！
当前市场数据：${JSON.stringify(marketData)}
【疯狗纪律】：
1. 抛弃长线思维！寻找一切 15 分钟级别的微观机会（突破、超跌反弹、均线乖离）。可以顺势，也可以抢逆势反弹！
2. 极度减少观望！除非盘面完全是一潭死水，否则必须明确给出 LONG 或 SHORT！
3. 风控要求：止损(sl)设在现价的 1% 左右，止盈(tp)设在现价的 1.5%~3% 左右。必须返回精确的数字！
【输出格式】严格返回 JSON，不要任何废话：
{"direction": "LONG/SHORT/WAIT", "sl": 止损数字, "tp": 止盈数字, "reason": "开火逻辑"}`;

  try {
    const res = await postJSON("https://api.deepseek.com/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.2 }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
    let jsonStr = res.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, '');
    const match = jsonStr.match(/\{[\s\S]*\}/); 
    if (match) return JSON.parse(match[0]);
    return { direction: 'WAIT', reason: '解析失败，空仓观望' };
  } catch (e) { return { direction: 'WAIT', reason: 'AI 引擎故障' }; }
}

// ==========================================
// 🛡️ 核心引擎：全自动执行与盯盘
// ==========================================
async function runMonitor() {
  if (!isMonitoringActive) return;

  try {
    const data1h = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=ETHUSDT&interval=${TREND_TIMEFRAME}&limit=250`);
    if (!Array.isArray(data1h) || data1h.length === 0) return;
    const ema200_1h = calcEMA(data1h.map(d => ({ close: +d[4] })), 200);
    
    const data15m = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=ETHUSDT&interval=${TIMEFRAME}&limit=50`);
    if (!Array.isArray(data15m) || data15m.length === 0) return;
    const candles15m = data15m.map(d => ({ open: +d[1], high: +d[2], low: +d[3], close: +d[4] }));
    const currentPrice = candles15m[candles15m.length - 1].close;
    lastPrice = currentPrice;
    
    const ma5 = calcMA(candles15m, 5), atr = calcATR(candles15m, 14), rsi = calcRSI(candles15m, 14);
    const trend1h = currentPrice > ema200_1h ? 'BULL' : 'BEAR'; 

    if (position.status !== 'NONE') {
        let isClosed = false;
        let closeReason = "";

        if (position.status === 'LONG') {
            if (currentPrice <= position.sl) { isClosed = true; closeReason = "🩸 触及极速止损 (币安已自动砍仓)"; }
            else if (currentPrice >= position.tp) { isClosed = true; closeReason = "💰 触及极速止盈 (币安已自动落袋)"; }
        } 
        else if (position.status === 'SHORT') {
            if (currentPrice >= position.sl) { isClosed = true; closeReason = "🩸 触及极速止损 (币安已自动砍仓)"; }
            else if (currentPrice <= position.tp) { isClosed = true; closeReason = "💰 触及极速止盈 (币安已自动落袋)"; }
        }

        if (isClosed) {
            const pnl = position.status === 'LONG' ? ((currentPrice - position.entryPrice)/position.entryPrice)*100 : ((position.entryPrice - currentPrice)/position.entryPrice)*100;
            const closeEmailMsg = `持仓方向: ${position.status}<br>开仓价: ${position.entryPrice}<br>平仓价: ${currentPrice}<br>现货盈亏幅: ${pnl.toFixed(2)}%<br><b>注: 真实平仓操作已由币安引擎完成。</b>`;
            await sendSignalEmail(`🏳️ 刺客收网: ${closeReason}`, closeEmailMsg, currentPrice, TIMEFRAME, "ETHUSDT");
            
            const closeWxMsg = `结果: ${closeReason}\n预估盈亏: ${pnl.toFixed(2)}%`;
            await sendWeChatPush(`🤖 自动平仓提醒`, closeWxMsg);
            
            position = { status: 'NONE', entryPrice: null, sl: null, tp: null, entryTime: null };
        } else {
            console.log(`🛡️ 刺客自动持仓中... 当前价: ${currentPrice} | 止损: ${position.sl} | 止盈: ${position.tp}`);
        }
        return; 
    }

    const marketData = { currentPrice, ma5, rsi, atr, trend1h };
    const aiDecision = await askAIForEntry(marketData);
    console.log(`🧠 AI 思考结果: 方向=${aiDecision?.direction}, 理由=${aiDecision?.reason}`);

    if (aiDecision && (aiDecision.direction === 'LONG' || aiDecision.direction === 'SHORT')) {
        let dir = aiDecision.direction;

        if (!aiDecision.sl || !aiDecision.tp) { console.log("❌ 拦截：未提供明确风控线"); return; }

        const tradeSuccess = await autoTrade("ETHUSDT", dir, TRADE_QTY, aiDecision.sl, aiDecision.tp);
        
        if (tradeSuccess) {
            position.status = dir;
            position.entryPrice = currentPrice;
            position.sl = parseFloat(aiDecision.sl);
            position.tp = parseFloat(aiDecision.tp);
            position.entryTime = Date.now();

            const openEmailMsg = `<b>⚠️ 全自动市价单与 Algo 止损单已发往币安执行！</b><br>入场价: ${currentPrice}<br><b>🛑 挂单止损 (SL): ${position.sl}</b><br><b>💰 挂单止盈 (TP): ${position.tp}</b><br>逻辑: ${aiDecision.reason}`;
            await sendSignalEmail(`🚀 实盘开火: ${dir}`, openEmailMsg, currentPrice, TIMEFRAME, "ETHUSDT");
            
            const openWxMsg = `【自动下单成功】\n方向: ${dir} ${TRADE_QTY}个\n市价: ${currentPrice}\n止损: ${position.sl}\n止盈: ${position.tp}`;
            await sendWeChatPush(`🚀 实盘开火: ${dir}`, openWxMsg);
            
            await addTradeLog(dir, currentPrice, position.sl, position.tp, aiDecision.reason);
        } else {
            console.log("⚠️ 注意：开仓失败或遇到异常。");
        }
    }

  } catch (e) { console.log("监控异常:", e.message); }
}

async function runAlertEngine() {
    try {
        const alerts = await loadData('price_alerts'); if (!alerts || alerts.length === 0) return;
        const res = await fetchJSON('https://api.binance.us/api/v3/ticker/price?symbol=ETHUSDT');
        if(!res || !res.price) return;
        const cur = parseFloat(res.price);
        let triggered = false; const remainingAlerts = [];
        for (const alert of alerts) {
            if ((alert.dir === 'above' && cur >= alert.price) || (alert.dir === 'below' && cur <= alert.price)) {
                await sendWeChatPush(`🚨 价格云端提醒`, `ETHUSDT 到达 ${cur}`);
                triggered = true;
            } else { remainingAlerts.push(alert); }
        }
        if (triggered) await saveData('price_alerts', remainingAlerts);
    } catch(e) {}
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.url === '/status') { res.end(JSON.stringify({ status: "alive", mode: "V5.2 Full Auto", isMonitoringActive, currentPosition: position })); return; }
  if (req.url === '/api/logs') { const logs = await loadData('trade_logs'); res.end(JSON.stringify(logs.reverse())); return; }
  if (req.url === '/api/toggle-monitor' && req.method === 'POST') { isMonitoringActive = !isMonitoringActive; res.end(JSON.stringify({success:true})); return; }
  
  res.end("System Running: V5.2 Auto Trade Mode (Algo Endpoint)");
}).listen(process.env.PORT || 3000);

setInterval(runMonitor, CHECK_INTERVAL_MS); 
setInterval(runAlertEngine, ALERT_CHECK_INTERVAL);
runMonitor();
