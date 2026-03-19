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
const TIMEFRAME = "15m"; 
const TREND_TIMEFRAME = "4h"; 
const CHECK_INTERVAL_MS = 5 * 60 * 1000; 

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY; 
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;
const SERVERCHAN_SENDKEY = process.env.SERVERCHAN_SENDKEY; 

// 🔥 核心重构：引入机械 OCO 订单状态管理
let position = {
    status: 'NONE',   // 'LONG', 'SHORT', 'NONE'
    entryPrice: null, // 开仓价
    sl: null,         // 止损价 (Stop Loss)
    tp: null,         // 止盈价 (Take Profit)
    entryTime: null   // 开仓时间
};

let lastPrice = null;
let isMonitoringActive = true; 
let inMemoryDB = { trade_logs: [] };

console.log("👑 终极波段猎手 (右侧交易 + 机械 OCO 风控) 已上线...");

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
      res.on('end', () => { if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}`)); else { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'God-Mode-Bot/3.0' } }, (res) => {
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

// 数据库操作
async function loadData(key) { if (!KV_REST_API_URL || !KV_REST_API_TOKEN) return inMemoryDB[key] || []; try { const res = await fetchJSON(`${KV_REST_API_URL}/get/${key}`, { Authorization: `Bearer ${KV_REST_API_TOKEN}` }); if (res.result) return typeof res.result === 'string' ? JSON.parse(res.result) : res.result; } catch(e) {} return inMemoryDB[key] || []; }
async function saveData(key, data) { inMemoryDB[key] = data; if (KV_REST_API_URL && KV_REST_API_TOKEN) { try { await postJSON(`${KV_REST_API_URL}/set/${key}`, data, { Authorization: `Bearer ${KV_REST_API_TOKEN}` }); }catch(e){} } }
async function addTradeLog(action, entryPrice, sl, tp, reason) { const logs = await loadData('trade_logs'); logs.push({ id: Date.now().toString(), symbol: "ETHUSDT", action, entryPrice, sl, tp, reason, time: new Date().toLocaleString('zh-CN') }); await saveData('trade_logs', logs.slice(-50)); }

// 指标计算
function calcMA(data, p) { if (data.length < p) return 0; return data.slice(-p).reduce((sum, c) => sum + c.close, 0) / p; }
function calcRSI(data, p = 14) { if (data.length < p + 1) return 50; let g = 0, l = 0; for (let i = data.length - p; i < data.length; i++) { const diff = data[i].close - data[i-1].close; if (diff > 0) g += d; else l -= diff; } const avgLoss = l / p; if (avgLoss === 0) return 100; return 100 - (100 / (1 + (g / p) / avgLoss)); }
function calcATR(data, p = 14) { if (data.length < p + 1) return 0; let sumTR = 0; for (let i = data.length - p; i < data.length; i++) { const h = data[i].high, l = data[i].low, pc = data[i-1].close; sumTR += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); } return sumTR / p; }
function calcEMA(data, p) { if (data.length < p) return data[data.length-1].close; let sum = 0; for(let i=0; i<p; i++) sum += data[i].close; let ema = sum / p; const k = 2 / (p + 1); for (let i = p; i < data.length; i++) { ema = (data[i].close - ema) * k + ema; } return ema; }

// ==========================================
// 🧠 AI 寻找入场点 (专注右侧交易)
// ==========================================
async function askAIForEntry(marketData) {
  if (!DEEPSEEK_API_KEY) return null;
  const prompt = `你是顶级游资量化模型。你的任务是寻找高确定性的“右侧进场点”。
当前市场数据：${JSON.stringify(marketData)}
【交易纪律】：
1. 顺势而为：如果 4H 趋势是 BULL（牛市），只能做 LONG（多）或 WAIT（等待）；如果是 BEAR（熊市），只能做 SHORT（空）或 WAIT。
2. 拒绝接飞刀：如果 15m 还在暴跌（连收阴线），绝不进场！必须等 15m 出现止跌企稳的阳线（重回MA5上方）才允许做多。这叫右侧确认！
3. 风控第一：如果决定开仓，必须基于 ATR 或近期支撑/阻力位，给出明确的止损价 (sl) 和止盈价 (tp)！盈亏比至少 1:1.5。
【输出格式】严格返回 JSON，不要有任何多余文字：
{"direction": "LONG/SHORT/WAIT", "sl": 具体的止损价格数字, "tp": 具体的止盈价格数字, "reason": "你的判断逻辑"}`;

  try {
    const res = await postJSON("https://api.deepseek.com/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.1 }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
    let jsonStr = res.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(jsonStr);
  } catch (e) { return { direction: 'WAIT', reason: 'AI 引擎解析失败' }; }
}

// ==========================================
// 🛡️ 核心引擎：机械哨兵系统
// ==========================================
async function runMonitor() {
  if (!isMonitoringActive) return;

  try {
    // 1. 获取行情数据
    const data4h = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=ETHUSDT&interval=${TREND_TIMEFRAME}&limit=250`);
    const ema200_4h = calcEMA(data4h.map(d => ({ close: +d[4] })), 200);
    
    const data15m = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=ETHUSDT&interval=${TIMEFRAME}&limit=50`);
    const candles15m = data15m.map(d => ({ open: +d[1], high: +d[2], low: +d[3], close: +d[4] }));
    const currentPrice = candles15m[candles15m.length - 1].close;
    lastPrice = currentPrice;
    
    const ma5 = calcMA(candles15m, 5), atr = calcATR(candles15m, 14), rsi = calcRSI(candles15m, 14);
    const trend4h = currentPrice > ema200_4h ? 'BULL' : 'BEAR'; // 判断牛熊大势

    // ==========================================
    // 🤖 状态一：有持仓 -> 机械托管，拒绝 AI 干预
    // ==========================================
    if (position.status !== 'NONE') {
        let isClosed = false;
        let closeReason = "";

        if (position.status === 'LONG') {
            if (currentPrice <= position.sl) { isClosed = true; closeReason = "🩸 触发止损，砍仓保本"; }
            else if (currentPrice >= position.tp) { isClosed = true; closeReason = "💰 触发止盈，落袋为安"; }
        } 
        else if (position.status === 'SHORT') {
            if (currentPrice >= position.sl) { isClosed = true; closeReason = "🩸 触发止损，砍仓保本"; }
            else if (currentPrice <= position.tp) { isClosed = true; closeReason = "💰 触发止盈，落袋为安"; }
        }

        // 执行机械平仓
        if (isClosed) {
            const pnl = position.status === 'LONG' ? ((currentPrice - position.entryPrice)/position.entryPrice)*100 : ((position.entryPrice - currentPrice)/position.entryPrice)*100;
            await sendSignalEmail(`🏳️ 机械平仓: ${closeReason}`, `持仓方向: ${position.status}<br>开仓价: ${position.entryPrice}<br>平仓价: ${currentPrice}<br>现货盈亏幅: ${pnl.toFixed(2)}%`, currentPrice, TIMEFRAME, "ETHUSDT");
            await sendWeChatPush(`机械平仓提醒`, `结果: ${closeReason}\n现货盈亏: ${pnl.toFixed(2)}%`);
            
            // 清空阵地，准备下一次狩猎
            position = { status: 'NONE', entryPrice: null, sl: null, tp: null, entryTime: null };
        } else {
            console.log(`🛡️ 机械哨兵盯盘中... 当前价: ${currentPrice} | 止损: ${position.sl} | 止盈: ${position.tp}`);
        }
        return; // 持仓期间，直接 return，坚决不问 AI
    }

    // ==========================================
    // 🐺 状态二：空仓 -> 呼叫 AI 寻找入场机会
    // ==========================================
    const marketData = { currentPrice, ma5, rsi, atr, trend4h };
    const aiDecision = await askAIForEntry(marketData);

    if (aiDecision && (aiDecision.direction === 'LONG' || aiDecision.direction === 'SHORT')) {
        let dir = aiDecision.direction;

        // ⚖️ 底层军规 VETO：防止 AI 脑抽逆势
        if (dir === 'LONG' && trend4h === 'BEAR') {
            console.log("❌ VETO: 拒绝在 4H 熊市中做多"); return;
        }
        if (dir === 'SHORT' && trend4h === 'BULL') {
            console.log("❌ VETO: 拒绝在 4H 牛市中做空"); return;
        }
        // 确保 AI 给出了合法的止盈止损
        if (!aiDecision.sl || !aiDecision.tp) {
            console.log("❌ VETO: AI 未提供明确止损止盈，拒绝开单"); return;
        }

        // 🎯 执行开单，签下“生死状”
        position.status = dir;
        position.entryPrice = currentPrice;
        position.sl = parseFloat(aiDecision.sl);
        position.tp = parseFloat(aiDecision.tp);
        position.entryTime = Date.now();

        await sendSignalEmail(`🎯 右侧猎手入场: ${dir}`, `入场价: ${currentPrice}<br><b>🛑 铁血止损 (SL): ${position.sl}</b><br><b>💰 目标止盈 (TP): ${position.tp}</b><br>逻辑: ${aiDecision.reason}`, currentPrice, TIMEFRAME, "ETHUSDT");
        await sendWeChatPush(`🎯 猎手入场: ${dir}`, `入场: ${currentPrice}\n止损: ${position.sl}\n止盈: ${position.tp}\n逻辑: ${aiDecision.reason}`);
        await addTradeLog(dir, currentPrice, position.sl, position.tp, aiDecision.reason);
    }

  } catch (e) { console.log("监控异常:", e.message); }
}

// ==========================================
// 🌐 API 接口
// ==========================================
http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/status') { res.end(JSON.stringify({ status: "alive", mode: "Mechanical OCO Hunter", isMonitoringActive, currentPosition: position })); return; }
  if (req.url === '/api/logs') { const logs = await loadData('trade_logs'); res.end(JSON.stringify(logs.reverse())); return; }
  if (req.url === '/api/toggle-monitor' && req.method === 'POST') { isMonitoringActive = !isMonitoringActive; res.end(JSON.stringify({success:true})); return; }
  res.end("System Running: OCO Mode");
}).listen(process.env.PORT || 3000);

setInterval(runMonitor, CHECK_INTERVAL_MS); 
runMonitor();
