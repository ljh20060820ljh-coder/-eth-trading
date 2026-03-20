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

let position = { status: 'NONE', entryPrice: null, sl: null, tp: null, entryTime: null, strategy: null };
let lastPrice = null;
let isMonitoringActive = true; 
let inMemoryDB = { trade_logs: [], price_alerts: [] }; 

console.log("👑 V6.0 多策略联合指挥中心 已上线！当前兵力配置: 0.01 ETH");

// ==========================================
// 💸 币安 API 核心执行引擎 (双通道支持)
// ==========================================
async function executeBinanceOrder(endpointPath, params) {
    if (!BINANCE_API_KEY || !BINANCE_API_SECRET) return null;
    params.timestamp = Date.now();
    const queryStr = querystring.stringify(params);
    const signature = crypto.createHmac('sha256', BINANCE_API_SECRET).update(queryStr).digest('hex');
    const data = `${queryStr}&signature=${signature}`;

    const options = { hostname: 'fapi.binance.com', path: endpointPath, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-MBX-APIKEY': BINANCE_API_KEY } };
    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let body = ''; res.on('data', chunk => body += chunk);
            res.on('end', () => {
                const response = JSON.parse(body);
                if (response.code) console.error(`❌ 币安下单失败 [${endpointPath}]:`, response);
                else console.log(`✅ 币安下单成功: ${params.side} ${params.type}`);
                resolve(response);
            });
        });
        req.on('error', reject); req.write(data); req.end();
    });
}

async function autoTrade(symbol, direction, qty, slPrice, tpPrice) {
    const isLong = direction === 'LONG';
    const entrySide = isLong ? 'BUY' : 'SELL';
    const exitSide = isLong ? 'SELL' : 'BUY';
    
    const entryRes = await executeBinanceOrder('/fapi/v1/order', { symbol, side: entrySide, type: 'MARKET', quantity: qty });
    if (entryRes && entryRes.code) return false; 

    const sl = parseFloat(slPrice).toFixed(2);
    const tp = parseFloat(tpPrice).toFixed(2);

    await executeBinanceOrder('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: exitSide, type: 'STOP_MARKET', triggerPrice: sl, quantity: qty, reduceOnly: 'true' });
    await executeBinanceOrder('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: exitSide, type: 'TAKE_PROFIT_MARKET', triggerPrice: tp, quantity: qty, reduceOnly: 'true' });
    return true;
}

// ==========================================
// 📦 工具函数 & 指标 
// ==========================================
function postJSON(url, body, extraHeaders) { return new Promise((resolve, reject) => { const data = JSON.stringify(body); const urlObj = new URL(url); const options = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(extraHeaders||{}) } }; const req = https.request(options, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${d}`)); else { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } } }); }); req.on('error', reject); req.write(data); req.end(); }); }
function fetchJSON(url) { return new Promise((resolve, reject) => { https.get(url, { headers: { 'User-Agent': 'Assassin-Bot/6.0' } }, (res) => { let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } }); }).on('error', reject); }); }
async function sendWeChatPush(title, desp) { if(SERVERCHAN_SENDKEY) try { await postJSON(`https://sctapi.ftqq.com/${SERVERCHAN_SENDKEY}.send`, { title, desp }); }catch(e){} }
async function sendSignalEmail(action, messageHtml, price, titleStr, symbol) { const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }); try { await postJSON("https://api.emailjs.com/api/v1.0/email/send", { service_id: EMAILJS_SERVICE_ID, template_id: EMAILJS_TEMPLATE_ID, user_id: EMAILJS_PUBLIC_KEY, accessToken: EMAILJS_PRIVATE_KEY, template_params: { to_email: NOTIFY_EMAIL, symbol: symbol, interval: titleStr, signal: action, price: price.toString(), message: messageHtml, time: time }}); } catch (e) {} }
async function loadData(key) { if (!KV_REST_API_URL || !KV_REST_API_TOKEN) return inMemoryDB[key] || []; try { const res = await fetchJSON(`${KV_REST_API_URL}/get/${key}`, { Authorization: `Bearer ${KV_REST_API_TOKEN}` }); if (res.result) return typeof res.result === 'string' ? JSON.parse(res.result) : res.result; } catch(e) {} return inMemoryDB[key] || []; }
async function saveData(key, data) { inMemoryDB[key] = data; if (KV_REST_API_URL && KV_REST_API_TOKEN) { try { await postJSON(`${KV_REST_API_URL}/set/${key}`, data, { Authorization: `Bearer ${KV_REST_API_TOKEN}` }); }catch(e){} } }
async function addTradeLog(action, entryPrice, sl, tp, reason, strategy) { const logs = await loadData('trade_logs'); logs.push({ id: Date.now().toString(), symbol: "ETHUSDT", action, entryPrice, sl, tp, reason, strategy, time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }); await saveData('trade_logs', logs.slice(-50)); }
function calcMA(data, p) { if (data.length < p) return 0; return data.slice(-p).reduce((sum, c) => sum + c.close, 0) / p; }
function calcRSI(data, p = 14) { if (data.length < p + 1) return 50; let g = 0, l = 0; for (let i = data.length - p; i < data.length; i++) { const diff = data[i].close - data[i-1].close; if (diff > 0) g += diff; else l -= diff; } const avgLoss = l / p; if (avgLoss === 0) return 100; return 100 - (100 / (1 + (g / p) / avgLoss)); }
function calcATR(data, p = 14) { if (data.length < p + 1) return 0; let sumTR = 0; for (let i = data.length - p; i < data.length; i++) { const h = data[i].high, l = data[i].low, pc = data[i-1].close; sumTR += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); } return sumTR / p; }

// ==========================================
// 🧠 核心：多策略智能路由系统
// ==========================================
function determineStrategy(atr, currentPrice, rsi) {
    const volatilityRatio = atr / currentPrice; 
    
    // 🩸 马丁抄底兵：极端超买/超卖情况
    if (rsi < 28 || rsi > 72) return "MARTINGALE";
    
    // 🕸️ 网格撸毛兵：波动率极小，横盘死水
    if (volatilityRatio < 0.0015) return "GRID";
    
    // 🗡️ 动能刺客：常态趋势跟随
    return "ASSASSIN";
}

async function askAIForEntry(marketData, strategyType) {
  if (!DEEPSEEK_API_KEY) return null;
  
  // 🎭 根据总指挥官的路由，给 AI 戴上不同的面具
  let strategyPrompt = "";
  if (strategyType === "GRID") {
      strategyPrompt = `【🕸️ 网格撸毛模式】：当前大盘波动极小，处于死水震荡。你的任务是在区间内高抛低吸。寻找微小的支撑/阻力位。止盈极小(0.5%)，止损较宽(1.5%)。有差价就赚！`;
  } else if (strategyType === "MARTINGALE") {
      strategyPrompt = `【🩸 极限反弹模式】：当前大盘出现极端情绪（超买或超卖）。你的任务是抓拐点抢反弹！如果暴跌就做多，暴涨就做空。止盈放在均线回归处，止损必须极其严密！`;
  } else {
      strategyPrompt = `【🗡️ 动能刺客模式】：大盘正在健康波动。寻找 15 分钟级别的带量突破顺势开单。绝不逆势。止损 1%，止盈 2%~3%。`;
  }

  const prompt = `你是华尔街量化基金的 AI 交易核心。你现在被分配的兵种是：${strategyType}。
当前市场数据：${JSON.stringify(marketData)}
${strategyPrompt}
【输出格式】严格返回 JSON，不要任何废话：
{"direction": "LONG/SHORT/WAIT", "sl": 止损数字, "tp": 止盈数字, "reason": "你的开火逻辑"}`;

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
    const data15m = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=ETHUSDT&interval=${TIMEFRAME}&limit=50`);
    if (!Array.isArray(data15m) || data15m.length === 0) return;
    const candles15m = data15m.map(d => ({ open: +d[1], high: +d[2], low: +d[3], close: +d[4] }));
    const currentPrice = candles15m[candles15m.length - 1].close;
    lastPrice = currentPrice;
    
    const ma5 = calcMA(candles15m, 5), atr = calcATR(candles15m, 14), rsi = calcRSI(candles15m, 14);

    // ==========================================
    // 🔒 状态一：有持仓，全军静默，交由币安接管
    // ==========================================
    if (position.status !== 'NONE') {
        let isClosed = false; let closeReason = "";
        if (position.status === 'LONG') {
            if (currentPrice <= position.sl) { isClosed = true; closeReason = "🩸 止损出局"; }
            else if (currentPrice >= position.tp) { isClosed = true; closeReason = "💰 止盈落袋"; }
        } 
        else if (position.status === 'SHORT') {
            if (currentPrice >= position.sl) { isClosed = true; closeReason = "🩸 止损出局"; }
            else if (currentPrice <= position.tp) { isClosed = true; closeReason = "💰 止盈落袋"; }
        }

        if (isClosed) {
            const pnl = position.status === 'LONG' ? ((currentPrice - position.entryPrice)/position.entryPrice)*100 : ((position.entryPrice - currentPrice)/position.entryPrice)*100;
            const closeEmailMsg = `兵种: ${position.strategy}<br>开仓价: ${position.entryPrice}<br>平仓价: ${currentPrice}<br>现货盈亏: ${pnl.toFixed(2)}%`;
            await sendSignalEmail(`🏳️ 收网: ${closeReason}`, closeEmailMsg, currentPrice, TIMEFRAME, "ETHUSDT");
            await sendWeChatPush(`🤖 自动平仓`, `兵种: ${position.strategy}\n结果: ${closeReason}\n盈亏: ${pnl.toFixed(2)}%`);
            position = { status: 'NONE', entryPrice: null, sl: null, tp: null, entryTime: null, strategy: null };
        } else {
            console.log(`🛡️ [${position.strategy}] 持仓中... 现价: ${currentPrice} | 止损: ${position.sl} | 止盈: ${position.tp}`);
        }
        return; 
    }

    // ==========================================
    // ⚔️ 状态二：空仓，总指挥官开始路由派兵
    // ==========================================
    const currentStrategy = determineStrategy(atr, currentPrice, rsi);
    console.log(`📡 总指挥官雷达探测: ATR=${atr.toFixed(2)}, RSI=${rsi.toFixed(2)} 👉 决定派遣兵种: [${currentStrategy}]`);

    const marketData = { currentPrice, ma5, rsi, atr };
    const aiDecision = await askAIForEntry(marketData, currentStrategy);
    console.log(`🧠 [${currentStrategy}] 汇报: 方向=${aiDecision?.direction}, 理由=${aiDecision?.reason}`);

    if (aiDecision && (aiDecision.direction === 'LONG' || aiDecision.direction === 'SHORT')) {
        let dir = aiDecision.direction;
        if (!aiDecision.sl || !aiDecision.tp) return;

        console.log(`🚀 总攻开始！出击兵种：[${currentStrategy}]`);
        const tradeSuccess = await autoTrade("ETHUSDT", dir, TRADE_QTY, aiDecision.sl, aiDecision.tp);
        
        if (tradeSuccess) {
            position.status = dir;
            position.entryPrice = currentPrice;
            position.sl = parseFloat(aiDecision.sl);
            position.tp = parseFloat(aiDecision.tp);
            position.entryTime = Date.now();
            position.strategy = currentStrategy;

            const openWxMsg = `【发兵成功 - ${currentStrategy}】\n方向: ${dir}\n市价: ${currentPrice}\n止损: ${position.sl}\n止盈: ${position.tp}\n逻辑: ${aiDecision.reason}`;
            await sendWeChatPush(`🚀 出击: ${currentStrategy}`, openWxMsg);
            await addTradeLog(dir, currentPrice, position.sl, position.tp, aiDecision.reason, currentStrategy);
        }
    }

  } catch (e) { console.log("监控异常:", e.message); }
}

async function runAlertEngine() { /* 云端警报省略，保持不变 */ }

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.url === '/status') { res.end(JSON.stringify({ status: "alive", mode: "V6 Multi-Strategy Commander", isMonitoringActive, currentPosition: position })); return; }
  
  res.end("System Running: V6 Multi-Strategy Auto Trade Mode");
}).listen(process.env.PORT || 3000);

setInterval(runMonitor, CHECK_INTERVAL_MS); 
runMonitor();
