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
const KV_REST_API_URL = process.env.KV_REST_API_URL || "https://exact-sparrow-75815.upstash.io"; 

const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

const TIMEFRAME = "15m"; 
const CHECK_INTERVAL_MS = 2 * 60 * 1000; 

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY; 
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;

let position = { status: 'NONE', entryPrice: null, sl: null, qty: 0, entryTime: null, strategy: null };
let isMonitoringActive = true; 
let inMemoryDB = { recent_trades: [] }; // 用于每小时和每日财报统计

console.log("👑 V7 终极完全体 (动态兵力+追踪止盈+长期记忆进化) 已上线！");

// ==========================================
// 💸 币安 API 核心执行引擎
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
                if (response.code) console.error(`❌ 下单失败 [${params.type}]:`, response.msg);
                else console.log(`✅ 下单成功: ${params.side} ${params.type} | 数量: ${params.quantity}`);
                resolve(response);
            });
        });
        req.on('error', reject); req.write(data); req.end();
    });
}

// 🔥 V7 终极防弹衣：普通开仓 + 固定止损 + 移动追踪止盈
async function autoTrade(symbol, direction, qty, slPrice) {
    const isLong = direction === 'LONG';
    const entrySide = isLong ? 'BUY' : 'SELL';
    const exitSide = isLong ? 'SELL' : 'BUY';
    
    // 1. 市价开仓
    const entryRes = await executeBinanceOrder('/fapi/v1/order', { symbol, side: entrySide, type: 'MARKET', quantity: qty });
    if (entryRes && entryRes.code) return false; 

    // 2. 挂固定止损单 (保底防爆)
    const sl = parseFloat(slPrice).toFixed(2);
    await executeBinanceOrder('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: exitSide, type: 'STOP_MARKET', triggerPrice: sl, quantity: qty, reduceOnly: 'true' });
    
    // 3. 挂移动追踪止盈单 (核心科技：回撤 1.5% 才平仓，无限咬住利润)
    await executeBinanceOrder('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: exitSide, type: 'TRAILING_STOP_MARKET', callbackRate: '1.5', quantity: qty, reduceOnly: 'true' });
    
    return true;
}

// ==========================================
// 📦 工具与云端记忆函数
// ==========================================
function postJSON(url, body, extraHeaders) { return new Promise((resolve, reject) => { const data = JSON.stringify(body); const urlObj = new URL(url); const options = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(extraHeaders||{}) } }; const req = https.request(options, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } }); }); req.on('error', reject); req.write(data); req.end(); }); }
function fetchJSON(url) { return new Promise((resolve, reject) => { https.get(url, { headers: { 'User-Agent': 'Assassin-Bot/7.0' } }, (res) => { let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } }); }).on('error', reject); }); }
async function sendSignalEmail(titleStr, messageHtml) { const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }); try { await postJSON("https://api.emailjs.com/api/v1.0/email/send", { service_id: EMAILJS_SERVICE_ID, template_id: EMAILJS_TEMPLATE_ID, user_id: EMAILJS_PUBLIC_KEY, accessToken: EMAILJS_PRIVATE_KEY, template_params: { to_email: NOTIFY_EMAIL, symbol: "V7 战报", interval: titleStr, signal: "汇报", price: "N/A", message: messageHtml, time: time }}); } catch (e) {} }

// 🧠 读写云端长期记忆 (错题本)
async function loadMemory() {
    if (!KV_REST_API_TOKEN) return [];
    try { const res = await fetchJSON(`${KV_REST_API_URL}/get/ai_memory`, { Authorization: `Bearer ${KV_REST_API_TOKEN}` }); 
          if (res.result) return typeof res.result === 'string' ? JSON.parse(res.result) : res.result; 
    } catch(e) {} return [];
}
async function saveMemory(data) {
    if (!KV_REST_API_TOKEN) return;
    try { await postJSON(`${KV_REST_API_URL}/set/ai_memory`, data, { Authorization: `Bearer ${KV_REST_API_TOKEN}` }); }catch(e){}
}

// ==========================================
// 🧠 核心：AI 思考与动态兵力分配
// ==========================================
async function askAIForEntry(marketData) {
  if (!DEEPSEEK_API_KEY) return null;
  const prompt = `你是华尔街量化基金的总指挥。当前数据：${JSON.stringify(marketData)}
任务：寻找15分钟级别的突破或反弹信号。
【输出要求】严格返回JSON：
{"direction": "LONG/SHORT/WAIT", "sl": 止损价位, "confidence": 0到100的把握程度, "reason": "开单逻辑"}`;

  try {
    const res = await postJSON("https://api.deepseek.com/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.2 }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
    let jsonStr = res.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, '');
    const match = jsonStr.match(/\{[\s\S]*\}/); 
    if (match) return JSON.parse(match[0]);
    return { direction: 'WAIT' };
  } catch (e) { return { direction: 'WAIT' }; }
}

// ==========================================
// 🛡️ 核心引擎：全自动执行与盯盘
// ==========================================
async function runMonitor() {
  if (!isMonitoringActive) return;
  try {
    const data15m = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=ETHUSDT&interval=${TIMEFRAME}&limit=20`);
    if (!Array.isArray(data15m)) return;
    const currentPrice = parseFloat(data15m[data15m.length - 1][4]);

    // 🔒 状态一：持仓中 (安静等待币安 Algo 单触发平仓)
    if (position.status !== 'NONE') {
        let isClosed = false; let closeReason = "";
        if (position.status === 'LONG' && currentPrice <= position.sl) { isClosed = true; closeReason = "止损出局"; }
        else if (position.status === 'SHORT' && currentPrice >= position.sl) { isClosed = true; closeReason = "止损出局"; }
        // 注：若触发了移动止盈，币安会自动平仓。代码逻辑暂以粗略记录代替，实际盈亏以币安后台为准。
        
        if (isClosed) {
            inMemoryDB.recent_trades.push({ dir: position.status, entry: position.entryPrice, exit: currentPrice, result: closeReason });
            position = { status: 'NONE', entryPrice: null, sl: null, qty: 0, entryTime: null, strategy: null };
        }
        return; 
    }

    // ⚔️ 状态二：空仓寻找机会
    const aiDecision = await askAIForEntry({ currentPrice });
    if (aiDecision && (aiDecision.direction === 'LONG' || aiDecision.direction === 'SHORT')) {
        let dir = aiDecision.direction;
        let conf = parseInt(aiDecision.confidence) || 0;
        
        // ⚖️ 智能兵力分配 (0.01 ~ 0.03)
        let tradeQty = 0;
        if (conf >= 95) tradeQty = 0.03;       
        else if (conf >= 80) tradeQty = 0.02;  
        else if (conf >= 60) tradeQty = 0.01;  
        else return; 

        console.log(`🚀 AI 决定开火! 把握: ${conf}分 -> 自动分配兵力: ${tradeQty} ETH`);
        
        const success = await autoTrade("ETHUSDT", dir, tradeQty, aiDecision.sl);
        if (success) {
            position = { status: dir, entryPrice: currentPrice, sl: parseFloat(aiDecision.sl), qty: tradeQty, entryTime: Date.now(), strategy: "动能刺客" };
            inMemoryDB.recent_trades.push({ dir, entry: currentPrice, exit: "持仓中", result: `开仓(${tradeQty}个)` });
        }
    }
  } catch (e) { console.log("监控异常:", e.message); }
}

// ==========================================
// 📊 老板专属：每小时报表 & 每日 AI 深度复盘(带记忆)
// ==========================================
async function runHourlyReport() {
    console.log("🕒 生成每小时财务报表...");
    const trades = inMemoryDB.recent_trades;
    let msg = `<b>📊 V7 小时级简报</b><br><br>当前持仓: ${position.status === 'NONE' ? '空仓蹲草丛' : `${position.status} (${position.qty} ETH)`}<br><br><b>近期流水:</b><br>`;
    trades.forEach(t => msg += `- ${t.dir} | 进: ${t.entry} | 出: ${t.exit} | 结果: ${t.result}<br>`);
    await sendSignalEmail("小时财报", msg || "本小时无交易，静默观察中。");
}

async function runDailyAIReview() {
    console.log("🧠 开启每日 AI 深度自我进化复盘...");
    const tradesStr = JSON.stringify(inMemoryDB.recent_trades);
    const pastMemory = await loadMemory(); // 🧠 调取历史错题本
    const memoryStr = pastMemory.slice(-7).join(" | "); // 回顾过去7天的教训

    const prompt = `你是本基金首席风控官。
【过去几天的历史教训】：${memoryStr || "暂无历史经验"}
【今天实战流水】：${tradesStr}。
任务：请结合历史教训，复盘今天表现，我们有没有犯同样的错误？明天该怎么优化参数或策略？请以"老板你好，我是V7人工智能..."开头，200字内总结。`;
    
    try {
        const res = await postJSON("https://api.deepseek.com/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: prompt }] }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
        const summary = res.choices[0].message.content;
        
        // 🧠 把今天的教训存入历史错题本
        pastMemory.push(`[${new Date().toLocaleDateString()}] 教训: ${summary.substring(0, 100)}...`);
        await saveMemory(pastMemory.slice(-15)); // 永远只保留最近15天的核心教训，防止撑爆大脑

        await sendSignalEmail("📈 每日 AI 进化报告", summary.replace(/\n/g, '<br>'));
        inMemoryDB.recent_trades = []; // 阅后即焚今日流水
    } catch(e) {}
}

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/status') { res.end(JSON.stringify({ status: "alive", mode: "V7 Evolution Boss Mode", position })); return; }
  res.end("System Running: V7 Auto Trade Mode");
}).listen(process.env.PORT || 3000);

setInterval(runMonitor, CHECK_INTERVAL_MS); 
setInterval(runHourlyReport, 60 * 60 * 1000); // 1小时报表
setInterval(runDailyAIReview, 24 * 60 * 60 * 1000); // 24小时复盘

runMonitor();
