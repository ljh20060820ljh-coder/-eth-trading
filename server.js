const https = require('https');
const http = require('http');

// ==========================================
// 🔐 核心配置
// ==========================================
const EMAILJS_SERVICE_ID = "service_op2rg49"; 
const EMAILJS_TEMPLATE_ID = "template_eftwoy6"; 
const EMAILJS_PUBLIC_KEY = "tIZB9DwwpEKr3KQpQ"; 
const NOTIFY_EMAIL = "2183089849@qq.com";
const KV_REST_API_URL = "https://exact-sparrow-75815.upstash.io"; 

const SYMBOLS = ["ETHUSDT"]; // 专注以太坊
const TIMEFRAME = "15m"; // 主力作战周期
const TREND_TIMEFRAME = "1h"; // 大局观：1 小时
const CHECK_INTERVAL_MS = 2 * 60 * 1000; // 巡逻频率：2 分钟一次
const ALERT_CHECK_INTERVAL = 10 * 1000; 

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY; 
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;
const SERVERCHAN_SENDKEY = process.env.SERVERCHAN_SENDKEY; 

// 机械 OCO 订单状态管理
let position = {
    status: 'NONE',   // 'LONG', 'SHORT', 'NONE'
    entryPrice: null, // 开仓价
    sl: null,         // 止损价 (Stop Loss)
    tp: null,         // 止盈价 (Take Profit)
    entryTime: null   // 开仓时间
};

let lastPrice = null;
let isMonitoringActive = true; 
let inMemoryDB = { trade_logs: [], price_alerts: [] }; 

console.log("🔫 15分钟短线刺客版 (完美修复防报错版) 已上线...");

// ==========================================
// 📦 工具函数
// ==========================================
function postJSON(url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(extraHeaders||{}) } };
    const req = https.request(options, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${d}`)); else { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Assassin-Bot/4.1' } }, (res) => {
      let data = ''; res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

async function sendWeChatPush(title, desp) { if(SERVERCHAN_SENDKEY) try { await postJSON(`https://sctapi.ftqq.com/${SERVERCHAN_SENDKEY}.send`, { title, desp }); }catch(e){} }
async function sendSignalEmail(action, messageHtml, price, titleStr, symbol) {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  try { await postJSON("https://api.emailjs.com/api/v1.0/email/send", { service_id: EMAILJS_SERVICE_ID, template_id: EMAILJS_TEMPLATE_ID, user_id: EMAILJS_PUBLIC_KEY, accessToken: EMAILJS_PRIVATE_KEY, template_params: { to_email: NOTIFY_EMAIL, symbol: symbol, interval: titleStr, signal: action, price: price.toString(), message: messageHtml, time: time }}); } catch (e) {}
}

async function loadData(key) { if (!KV_REST_API_URL || !KV_REST_API_TOKEN) return inMemoryDB[key] || []; try { const res = await fetchJSON(`${KV_REST_API_URL}/get/${key}`, { Authorization: `Bearer ${KV_REST_API_TOKEN}` }); if (res.result) return typeof res.result === 'string' ? JSON.parse(res.result) : res.result; } catch(e) {} return inMemoryDB[key] || []; }
async function saveData(key, data) { inMemoryDB[key] = data; if (KV_REST_API_URL && KV_REST_API_TOKEN) { try { await postJSON(`${KV_REST_API_URL}/set/${key}`, data, { Authorization: `Bearer ${KV_REST_API_TOKEN}` }); }catch(e){} } }
async function addTradeLog(action, entryPrice, sl, tp, reason) { const logs = await loadData('trade_logs'); logs.push({ id: Date.now().toString(), symbol: "ETHUSDT", action, entryPrice, sl, tp, reason, time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }); await saveData('trade_logs', logs.slice(-50)); }

function calcMA(data, p) { if (data.length < p) return 0; return data.slice(-p).reduce((sum, c) => sum + c.close, 0) / p; }
function calcRSI(data, p = 14) { 
    if (data.length < p + 1) return 50; 
    let g = 0, l = 0; 
    for (let i = data.length - p; i < data.length; i++) { 
        const diff = data[i].close - data[i-1].close; 
        if (diff > 0) g += diff; else l -= diff; 
    } 
    const avgLoss = l / p; 
    if (avgLoss === 0) return 100; 
    return 100 - (100 / (1 + (g / p) / avgLoss)); 
}
function calcATR(data, p = 14) { if (data.length < p + 1) return 0; let sumTR = 0; for (let i = data.length - p; i < data.length; i++) { const h = data[i].high, l = data[i].low, pc = data[i-1].close; sumTR += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); } return sumTR / p; }
function calcEMA(data, p) { if (data.length < p) return data[data.length-1].close; let sum = 0; for(let i=0; i<p; i++) sum += data[i].close; let ema = sum / p; const k = 2 / (p + 1); for (let i = p; i < data.length; i++) { ema = (data[i].close - ema) * k + ema; } return ema; }

// ==========================================
// 🧠 AI 寻找入场点 (专注 15 分钟波段)
// ==========================================
async function askAIForEntry(marketData) {
  if (!DEEPSEEK_API_KEY) return null;
  const prompt = `你是币圈极其敏锐的“15分钟级短线刺客”（Day Trader）。你的任务是寻找15分钟K线级别的突破或快速反弹机会。
当前市场数据：${JSON.stringify(marketData)}
【短线刺客纪律】：
1. 顺 1H 小趋势，做 15m 进场。1H是牛(BULL)就伺机做多(LONG)，1H是熊(BEAR)就伺机做空(SHORT)。绝不逆势！
2. 天下武功唯快不破：你的持仓时间预期只有几十分钟到几个小时。不要看太远！
3. 风控第一：止损 (sl) 必须极其严密（比如前高/前低点外侧一点），止盈 (tp) 放在最近的压力/支撑位。我们要的是快进快出，吃 1%~2% 的现货波动即可。盈亏比尽量大于 1:1.5。
【输出格式】严格返回 JSON，不要任何废话或换行符：
{"direction": "LONG/SHORT/WAIT", "sl": 止损数字, "tp": 止盈数字, "reason": "短线开火逻辑"}`;

  try {
    const res = await postJSON("https://api.deepseek.com/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.1 }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
    let jsonStr = res.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, '');
    const match = jsonStr.match(/\{[\s\S]*\}/); 
    if (match) return JSON.parse(match[0]);
    return { direction: 'WAIT', reason: '解析失败，空仓观望' };
  } catch (e) { return { direction: 'WAIT', reason: 'AI 引擎故障，安全观望' }; }
}

// ==========================================
// 🛡️ 核心引擎：机械哨兵系统
// ==========================================
async function runMonitor() {
  if (!isMonitoringActive) return;

  try {
    // 获取 1H 数据作为大局观过滤
    const data1h = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=ETHUSDT&interval=${TREND_TIMEFRAME}&limit=250`);
    if (!Array.isArray(data1h) || data1h.length === 0) return;
    const ema200_1h = calcEMA(data1h.map(d => ({ close: +d[4] })), 200);
    
    // 获取 15m 作战数据
    const data15m = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=ETHUSDT&interval=${TIMEFRAME}&limit=50`);
    if (!Array.isArray(data15m) || data15m.length === 0) return;
    const candles15m = data15m.map(d => ({ open: +d[1], high: +d[2], low: +d[3], close: +d[4] }));
    const currentPrice = candles15m[candles15m.length - 1].close;
    lastPrice = currentPrice;
    
    const ma5 = calcMA(candles15m, 5), atr = calcATR(candles15m, 14), rsi = calcRSI(candles15m, 14);
    const trend1h = currentPrice > ema200_1h ? 'BULL' : 'BEAR'; 

    // ==========================================
    // 🤖 状态一：有持仓 -> 机械托管，拒绝 AI 干预
    // ==========================================
    if (position.status !== 'NONE') {
        let isClosed = false;
        let closeReason = "";

        if (position.status === 'LONG') {
            if (currentPrice <= position.sl) { isClosed = true; closeReason = "🩸 触发极速止损，砍仓出局"; }
            else if (currentPrice >= position.tp) { isClosed = true; closeReason = "💰 触发极速止盈，落袋为安"; }
        } 
        else if (position.status === 'SHORT') {
            if (currentPrice >= position.sl) { isClosed = true; closeReason = "🩸 触发极速止损，砍仓出局"; }
            else if (currentPrice <= position.tp) { isClosed = true; closeReason = "💰 触发极速止盈，落袋为安"; }
        }

        if (isClosed) {
            const pnl = position.status === 'LONG' ? ((currentPrice - position.entryPrice)/position.entryPrice)*100 : ((position.entryPrice - currentPrice)/position.entryPrice)*100;
            
            // ✅ 修复：将超长字符串拆成变量，防止复制断行报错
            const closeEmailMsg = `持仓方向: ${position.status}<br>开仓价: ${position.entryPrice}<br>平仓价: ${currentPrice}<br>现货盈亏幅: ${pnl.toFixed(2)}%`;
            await sendSignalEmail(`🏳️ 刺客收网: ${closeReason}`, closeEmailMsg, currentPrice, TIMEFRAME, "ETHUSDT");
            
            const closeWxMsg = `结果: ${closeReason}\n现货盈亏: ${pnl.toFixed(2)}%`;
            await sendWeChatPush(`短线平仓提醒`, closeWxMsg);
            
            position = { status: 'NONE', entryPrice: null, sl: null, tp: null, entryTime: null };
        } else {
            console.log(`🛡️ 刺客盯盘中... 当前价: ${currentPrice} | 止损: ${position.sl} | 止盈: ${position.tp}`);
        }
        return; 
    }

    // ==========================================
    // 🐺 状态二：空仓 -> 呼叫 AI 寻找入场机会
    // ==========================================
    const marketData = { currentPrice, ma5, rsi, atr, trend1h };
    const aiDecision = await askAIForEntry(marketData);

    if (aiDecision && (aiDecision.direction === 'LONG' || aiDecision.direction === 'SHORT')) {
        let dir = aiDecision.direction;

        // ⚖️ VETO 拦截
        if (dir === 'LONG' && trend1h === 'BEAR') { console.log("❌ 拦截：拒绝 1H 熊市做多"); return; }
        if (dir === 'SHORT' && trend1h === 'BULL') { console.log("❌ 拦截：拒绝 1H 牛市做空"); return; }
        if (!aiDecision.sl || !aiDecision.tp) { console.log("❌ 拦截：未提供明确风控线"); return; }

        // 🎯 执行开单
        position.status = dir;
        position.entryPrice = currentPrice;
        position.sl = parseFloat(aiDecision.sl);
        position.tp = parseFloat(aiDecision.tp);
        position.entryTime = Date.now();

        // ✅ 修复：将超长字符串拆成变量，防止复制断行报错
        const openEmailMsg = `入场价: ${currentPrice}<br><b>🛑 极速止损 (SL): ${position.sl}</b><br><b>💰 目标止盈 (TP): ${position.tp}</b><br>逻辑: ${aiDecision.reason}`;
        await sendSignalEmail(`🎯 刺客入场: ${dir}`, openEmailMsg, currentPrice, TIMEFRAME, "ETHUSDT");
        
        const openWxMsg = `入场: ${currentPrice}\n止损: ${position.sl}\n止盈: ${position.tp}\n逻辑: ${aiDecision.reason}`;
        await sendWeChatPush(`🎯 刺客入场: ${dir}`, openWxMsg);
        
        await addTradeLog(dir, currentPrice, position.sl, position.tp, aiDecision.reason);
    }

  } catch (e) { console.log("监控异常:", e.message); }
}

// ==========================================
// ☁️ 独立云端价格提醒引擎
// ==========================================
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

// ==========================================
// 🌐 API 接口
// ==========================================
http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.url === '/status') { res.end(JSON.stringify({ status: "alive", mode: "15m Scalping Assassin", isMonitoringActive, currentPosition: position })); return; }
  if (req.url === '/api/logs') { const logs = await loadData('trade_logs'); res.end(JSON.stringify(logs.reverse())); return; }
  if (req.url === '/api/toggle-monitor' && req.method === 'POST') { isMonitoringActive = !isMonitoringActive; res.end(JSON.stringify({success:true})); return; }
  
  if (req.url === '/api/alerts' && req.method === 'GET') { const alerts = await loadData('price_alerts'); res.end(JSON.stringify(alerts)); return; }
  if (req.url === '/api/alerts' && req.method === 'POST') {
      let body = ''; req.on('data', c => body += c.toString());
      req.on('end', async () => { try { const newAlert = JSON.parse(body); const alerts = await loadData('price_alerts'); alerts.push({ id: Date.now().toString(), symbol: newAlert.symbol, price: newAlert.price, dir: newAlert.dir }); await saveData('price_alerts', alerts); res.end(JSON.stringify({success: true})); } catch(e) { res.end(JSON.stringify({success: false})); }}); return;
  }
  if (req.url === '/api/alerts' && req.method === 'DELETE') {
      let body = ''; req.on('data', c => body += c.toString());
      req.on('end', async () => { try { const { id } = JSON.parse(body); let alerts = await loadData('price_alerts'); alerts = alerts.filter(a => a.id !== id); await saveData('price_alerts', alerts); res.end(JSON.stringify({success: true})); } catch(e) { res.end(JSON.stringify({success: false})); }}); return;
  }
  
  res.end("System Running: 15m Assassin Mode");
}).listen(process.env.PORT || 3000);

// 循环点火
setInterval(runMonitor, CHECK_INTERVAL_MS); 
setInterval(runAlertEngine, ALERT_CHECK_INTERVAL);
runMonitor();
