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
let inMemoryDB = { recent_trades: [] }; 

console.log("👑 V7.2 记忆可视化版 (新增 AI 进化错题本网页) 已上线！");

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

async function autoTrade(symbol, direction, qty, slPrice) {
    const isLong = direction === 'LONG';
    const entrySide = isLong ? 'BUY' : 'SELL';
    const exitSide = isLong ? 'SELL' : 'BUY';
    
    const entryRes = await executeBinanceOrder('/fapi/v1/order', { symbol, side: entrySide, type: 'MARKET', quantity: qty });
    if (entryRes && entryRes.code) return false; 

    const sl = parseFloat(slPrice).toFixed(2);
    await executeBinanceOrder('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: exitSide, type: 'STOP_MARKET', triggerPrice: sl, quantity: qty, reduceOnly: 'true' });
    await executeBinanceOrder('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: exitSide, type: 'TRAILING_STOP_MARKET', callbackRate: '1.5', quantity: qty, reduceOnly: 'true' });
    
    return true;
}

// ==========================================
// 📦 工具、指标与云端记忆函数
// ==========================================
function postJSON(url, body, extraHeaders) { return new Promise((resolve, reject) => { const data = JSON.stringify(body); const urlObj = new URL(url); const options = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(extraHeaders||{}) } }; const req = https.request(options, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } }); }); req.on('error', reject); req.write(data); req.end(); }); }
function fetchJSON(url) { return new Promise((resolve, reject) => { https.get(url, { headers: { 'User-Agent': 'Assassin-Bot/7.2' } }, (res) => { let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } }); }).on('error', reject); }); }
async function sendSignalEmail(titleStr, messageHtml) { const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }); try { await postJSON("https://api.emailjs.com/api/v1.0/email/send", { service_id: EMAILJS_SERVICE_ID, template_id: EMAILJS_TEMPLATE_ID, user_id: EMAILJS_PUBLIC_KEY, accessToken: EMAILJS_PRIVATE_KEY, template_params: { to_email: NOTIFY_EMAIL, symbol: "V7 战报", interval: titleStr, signal: "汇报", price: "N/A", message: messageHtml, time: time }}); } catch (e) {} }

function calcRSI(data, p = 14) { if (data.length < p + 1) return 50; let g = 0, l = 0; for (let i = data.length - p; i < data.length; i++) { const diff = data[i].close - data[i-1].close; if (diff > 0) g += diff; else l -= diff; } const avgLoss = l / p; if (avgLoss === 0) return 100; return 100 - (100 / (1 + (g / p) / avgLoss)); }
function calcATR(data, p = 14) { if (data.length < p + 1) return 0; let sumTR = 0; for (let i = data.length - p; i < data.length; i++) { const h = data[i].high, l = data[i].low, pc = data[i-1].close; sumTR += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); } return sumTR / p; }

function determineStrategy(atr, currentPrice, rsi) {
    const volatilityRatio = atr / currentPrice; 
    if (rsi < 28 || rsi > 72) return "马丁接针兵";
    if (volatilityRatio < 0.0015) return "网格撸毛兵";
    return "动能刺客";
}

async function loadMemory() { if (!KV_REST_API_TOKEN) return []; try { const res = await fetchJSON(`${KV_REST_API_URL}/get/ai_memory`, { Authorization: `Bearer ${KV_REST_API_TOKEN}` }); if (res.result) return typeof res.result === 'string' ? JSON.parse(res.result) : res.result; } catch(e) {} return []; }
async function saveMemory(data) { if (!KV_REST_API_TOKEN) return; try { await postJSON(`${KV_REST_API_URL}/set/ai_memory`, data, { Authorization: `Bearer ${KV_REST_API_TOKEN}` }); }catch(e){} }

// ==========================================
// 🧠 核心：AI 思考与动态兵力分配
// ==========================================
async function askAIForEntry(marketData, strategy) {
  if (!DEEPSEEK_API_KEY) return null;
  const prompt = `你是华尔街量化基金总指挥。当前分配兵种：[${strategy}]。数据：${JSON.stringify(marketData)}
任务：寻找开仓信号。
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
    const data15m = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=ETHUSDT&interval=${TIMEFRAME}&limit=50`);
    if (!Array.isArray(data15m) || data15m.length === 0) return;
    const candles15m = data15m.map(d => ({ high: +d[2], low: +d[3], close: +d[4] }));
    const currentPrice = candles15m[candles15m.length - 1].close;

    const atr = calcATR(candles15m, 14), rsi = calcRSI(candles15m, 14);

    if (position.status !== 'NONE') {
        let isClosed = false; let closeReason = "";
        if (position.status === 'LONG' && currentPrice <= position.sl) { isClosed = true; closeReason = "止损出局"; }
        else if (position.status === 'SHORT' && currentPrice >= position.sl) { isClosed = true; closeReason = "止损出局"; }
        
        if (isClosed) {
            inMemoryDB.recent_trades.push({ dir: position.status, entry: position.entryPrice, exit: currentPrice, result: closeReason });
            position = { status: 'NONE', entryPrice: null, sl: null, qty: 0, entryTime: null, strategy: null };
        } else {
            console.log(`🛡️ [${position.strategy}] 持仓中... 现价: ${currentPrice} | 追踪防弹衣生效中`);
        }
        return; 
    }

    const currentStrategy = determineStrategy(atr, currentPrice, rsi);
    console.log(`📡 雷达探测: ATR=${atr.toFixed(2)}, RSI=${rsi.toFixed(2)} 👉 派遣: [${currentStrategy}]`);

    const marketData = { currentPrice, rsi: rsi.toFixed(2), atr: atr.toFixed(2) };
    const aiDecision = await askAIForEntry(marketData, currentStrategy);
    
    if (aiDecision && (aiDecision.direction === 'LONG' || aiDecision.direction === 'SHORT')) {
        let dir = aiDecision.direction;
        let conf = parseInt(aiDecision.confidence) || 0;
        
        let tradeQty = 0;
        if (conf >= 95) tradeQty = 0.03;       
        else if (conf >= 80) tradeQty = 0.02;  
        else if (conf >= 60) tradeQty = 0.01;  
        else return; 

        console.log(`🚀 AI 开火! 把握: ${conf}分 -> 兵力: ${tradeQty} ETH`);
        
        const success = await autoTrade("ETHUSDT", dir, tradeQty, aiDecision.sl);
        if (success) {
            position = { status: dir, entryPrice: currentPrice, sl: parseFloat(aiDecision.sl), qty: tradeQty, entryTime: Date.now(), strategy: currentStrategy };
            inMemoryDB.recent_trades.push({ dir, entry: currentPrice, exit: "持仓中", result: `开仓(${tradeQty}个)` });
        }
    }
  } catch (e) { console.log("监控异常:", e.message); }
}

// ==========================================
// 📊 老板专属：每小时报表 & 每日 AI 深度复盘(带记忆)
// ==========================================
async function runHourlyReport() {
    const trades = inMemoryDB.recent_trades;
    let msg = `<b>📊 小时级简报</b><br><br>当前持仓: ${position.status === 'NONE' ? '空仓' : `${position.status} (${position.qty} ETH)`}<br><br><b>流水:</b><br>`;
    trades.forEach(t => msg += `- ${t.dir} | 进: ${t.entry} | 出: ${t.exit} | 结果: ${t.result}<br>`);
    await sendSignalEmail("小时财报", msg || "本小时无交易。");
}

async function runDailyAIReview() {
    console.log("🧠 开启每日 AI 深度自我进化复盘...");
    const tradesStr = JSON.stringify(inMemoryDB.recent_trades);
    const pastMemory = await loadMemory(); 
    const memoryStr = pastMemory.slice(-7).join(" | "); 

    const prompt = `你是首席风控官。
【历史教训】：${memoryStr || "暂无经验"}
【今天实战】：${tradesStr}。
任务：结合历史教训复盘今天表现，明天怎么优化？以"老板你好..."开头，200字内总结。`;
    
    try {
        const res = await postJSON("https://api.deepseek.com/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: prompt }] }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
        const summary = res.choices[0].message.content;
        
        pastMemory.push(`[${new Date().toLocaleDateString()}] 教训: ${summary.substring(0, 100)}...`);
        await saveMemory(pastMemory.slice(-15)); 
        await sendSignalEmail("📈 每日 AI 进化报告", summary.replace(/\n/g, '<br>'));
        inMemoryDB.recent_trades = []; 
    } catch(e) {}
}

// ==========================================
// 🌐 网页控制台：老板的可视化仪表盘
// ==========================================
http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); // 保证中文不乱码

  // 1. 状态接口 (给 UptimeRobot 用的)
  if (req.url === '/status') { 
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ status: "alive", mode: "V7.2 Boss Mode", position })); 
      return; 
  }

  // 2. 🧠 老板专属：AI 错题本面板
  if (req.url === '/memory') {
      const memory = await loadMemory();
      let html = `
      <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px; background-color: #f9f9f9;">
          <h2 style="color: #333; text-align: center;">🧠 首席风控官 - 进化错题本 (长期记忆库)</h2>
          <hr style="border: 0; border-top: 1px solid #ccc; margin-bottom: 20px;">
      `;
      if(memory.length === 0) {
          html += `<p style="color: #666; font-size: 16px; text-align: center;">📭 目前大脑空空如也。AI 需要积累 24 小时的实战经验后，才会在这里产生第一条记忆记录。</p>`;
      } else {
          html += `<ul style="list-style-type: '👉 ';">`;
          memory.forEach(m => {
              html += `<li style="margin-bottom: 15px; line-height: 1.6; color: #444; font-size: 15px;">${m}</li>`;
          });
          html += `</ul>`;
      }
      html += `<br><div style="text-align: center;"><a href="/" style="text-decoration: none; background: #007bff; color: white; padding: 10px 20px; border-radius: 5px;">返回主页</a></div></div>`;
      res.end(html);
      return;
  }

  // 3. 默认主页
  res.end(`
  <div style="font-family: Arial, sans-serif; text-align: center; margin-top: 50px;">
      <h1>🚀 系统运行中: V7.2 全自动印钞工厂</h1>
      <p style="color: #28a745; font-size: 18px;">正在 24 小时监控大盘并自动交易...</p>
      <br>
      <a href="/memory" style="font-size: 20px; text-decoration: none; background: #28a745; color: white; padding: 15px 30px; border-radius: 8px; display: inline-block;">
          📖 点击查看：AI 进化错题本 (学习记录)
      </a>
  </div>
  `);
}).listen(process.env.PORT || 3000);

setInterval(runMonitor, CHECK_INTERVAL_MS); 
setInterval(runHourlyReport, 60 * 60 * 1000); 
setInterval(runDailyAIReview, 24 * 60 * 60 * 1000); 

runMonitor();
