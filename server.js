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

const CHECK_INTERVAL_MS = 2 * 60 * 1000; 
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY; 
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;

let position = { status: 'NONE', entryPrice: null, sl: null, qty: 0, entryTime: null, strategy: null, lastAICheckTime: null };
let isMonitoringActive = true; 
let inMemoryDB = { recent_trades: [] }; 

console.log("👑 V8.1 精细化兵权版 (动态专属回撤率 + 多周期共振 + 限价防滑点) 震撼上线！");

// ==========================================
// 💸 币安 API 核心执行引擎
// ==========================================
async function executeBinanceOrder(endpointPath, params, method = 'POST') {
    if (!BINANCE_API_KEY || !BINANCE_API_SECRET) return null;
    params.timestamp = Date.now();
    const queryStr = querystring.stringify(params);
    const signature = crypto.createHmac('sha256', BINANCE_API_SECRET).update(queryStr).digest('hex');
    const data = `${queryStr}&signature=${signature}`;

    let path = endpointPath;
    if (method === 'GET' || method === 'DELETE') path = `${endpointPath}?${data}`;

    const options = { 
        hostname: 'fapi.binance.com', path: path, method: method, 
        headers: { 'X-MBX-APIKEY': BINANCE_API_KEY } 
    };
    if (method === 'POST' || method === 'PUT') options.headers['Content-Type'] = 'application/x-www-form-urlencoded';

    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let body = ''; res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const response = JSON.parse(body);
                    if (response.code) console.error(`❌ API失败 [${method}]:`, response.msg);
                    resolve(response);
                } catch(e) { resolve(body); }
            });
        });
        req.on('error', reject); 
        if (method === 'POST') req.write(data); 
        req.end();
    });
}

// 🔥 V8.1 核心升级：根据兵种分配专属【追踪止盈回撤率】
async function autoTrade(symbol, direction, qty, slPrice, currentPrice, strategy) {
    const isLong = direction === 'LONG';
    const entrySide = isLong ? 'BUY' : 'SELL';
    const exitSide = isLong ? 'SELL' : 'BUY';

    // 🎯 动态兵种回撤率分配核心逻辑
    let cbRate = '1.5'; 
    if (strategy === '网格撸毛兵') cbRate = '0.6';      // 快进快出，回撤0.6%就跑
    else if (strategy === '马丁接针兵') cbRate = '1.0'; // 抄底吃反弹，回撤1.0%落袋
    else if (strategy === '动能刺客') cbRate = '1.5';   // 抓大暴涨大暴跌，给足空间吃大肉
    
    // 1. 限价开仓
    const entryPriceFixed = parseFloat(currentPrice).toFixed(2);
    const entryRes = await executeBinanceOrder('/fapi/v1/order', { symbol, side: entrySide, type: 'LIMIT', timeInForce: 'GTC', price: entryPriceFixed, quantity: qty });
    if (entryRes && entryRes.code) return false; 

    const sl = parseFloat(slPrice).toFixed(2);
    // 2. 挂固定止损防爆
    await executeBinanceOrder('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: exitSide, type: 'STOP_MARKET', triggerPrice: sl, quantity: qty, reduceOnly: 'true' });
    // 3. 挂专属追踪止盈
    console.log(`🛡️ 军备发放：为 [${strategy}] 装备回撤率为 ${cbRate}% 的追踪止盈导弹！`);
    await executeBinanceOrder('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: exitSide, type: 'TRAILING_STOP_MARKET', callbackRate: cbRate, quantity: qty, reduceOnly: 'true' });
    
    return true;
}

async function closePositionAndCancelOrders(symbol, direction, qty) {
    await executeBinanceOrder('/fapi/v1/allOpenOrders', { symbol }, 'DELETE'); 
    const exitSide = direction === 'LONG' ? 'SELL' : 'BUY';
    await executeBinanceOrder('/fapi/v1/order', { symbol, side: exitSide, type: 'MARKET', quantity: qty, reduceOnly: 'true' });
    return true;
}

async function syncRealPosition() {
    const riskRes = await executeBinanceOrder('/fapi/v2/positionRisk', { symbol: 'ETHUSDT' }, 'GET');
    if (Array.isArray(riskRes)) {
        const pos = riskRes[0];
        const amt = parseFloat(pos.positionAmt);
        const entryP = parseFloat(pos.entryPrice);
        
        if (amt !== 0) {
            const realDir = amt > 0 ? 'LONG' : 'SHORT';
            if (position.status === 'NONE') {
                console.log(`🔄 [失忆恢复] 检测到真实持仓: ${realDir} ${Math.abs(amt)} ETH！已接管！`);
                position = { status: realDir, entryPrice: entryP, sl: null, qty: Math.abs(amt), entryTime: Date.now(), strategy: '失忆接管兵', lastAICheckTime: Date.now() };
            }
        } else {
            if (position.status !== 'NONE') {
                position = { status: 'NONE', entryPrice: null, sl: null, qty: 0, entryTime: null, strategy: null, lastAICheckTime: null };
            }
        }
    }
}

// ==========================================
// 📦 工具与计算函数
// ==========================================
function postJSON(url, body, extraHeaders) { return new Promise((resolve, reject) => { const data = JSON.stringify(body); const urlObj = new URL(url); const options = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(extraHeaders||{}) } }; const req = https.request(options, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } }); }); req.on('error', reject); req.write(data); req.end(); }); }
function fetchJSON(url) { return new Promise((resolve, reject) => { https.get(url, { headers: { 'User-Agent': 'Assassin-Bot/8.1' } }, (res) => { let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } }); }).on('error', reject); }); }
async function sendSignalEmail(titleStr, messageHtml) { const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }); try { await postJSON("https://api.emailjs.com/api/v1.0/email/send", { service_id: EMAILJS_SERVICE_ID, template_id: EMAILJS_TEMPLATE_ID, user_id: EMAILJS_PUBLIC_KEY, accessToken: EMAILJS_PRIVATE_KEY, template_params: { to_email: NOTIFY_EMAIL, symbol: "V8.1 战报", interval: titleStr, signal: "汇报", price: "N/A", message: messageHtml, time: time }}); } catch (e) {} }

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

async function askAIForEntry(data15m, data4h, strategy) {
  if (!DEEPSEEK_API_KEY) return null;
  const prompt = `你是华尔街量化风控官。当前兵种：[${strategy}]。
【15分钟级别数据 (战术找买点)】：${JSON.stringify(data15m)}
【4小时级别数据 (战略看大势)】：${JSON.stringify(data4h)}
任务：结合大周期趋势和小周期波动，寻找绝对共振开仓信号。
【输出要求】严格返回JSON：{"direction": "LONG/SHORT/WAIT", "sl": 止损价位, "confidence": 0到100, "reason": "多周期分析逻辑"}`;
  try {
    const res = await postJSON("https://api.deepseek.com/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.2 }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
    let jsonStr = res.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, '');
    const match = jsonStr.match(/\{[\s\S]*\}/); 
    if (match) return JSON.parse(match[0]);
    return { direction: 'WAIT', confidence: 0, reason: '未找到合适信号' };
  } catch (e) { return { direction: 'WAIT', confidence: 0, reason: 'AI 通信异常' }; }
}

// ==========================================
// 🛡️ 核心引擎：全自动执行与盯盘
// ==========================================
async function runMonitor() {
  if (!isMonitoringActive) return;
  try {
    await syncRealPosition();
    const now = Date.now();
    
    const raw15m = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=ETHUSDT&interval=15m&limit=50`);
    const raw4h = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=ETHUSDT&interval=4h&limit=50`);
    if (!Array.isArray(raw15m) || !Array.isArray(raw4h)) return;

    const candles15m = raw15m.map(d => ({ high: +d[2], low: +d[3], close: +d[4] }));
    const candles4h = raw4h.map(d => ({ high: +d[2], low: +d[3], close: +d[4] }));
    
    const currentPrice = candles15m[candles15m.length - 1].close;
    
    const atr15m = calcATR(candles15m, 14), rsi15m = calcRSI(candles15m, 14);
    const atr4h = calcATR(candles4h, 14), rsi4h = calcRSI(candles4h, 14);

    const marketData15m = { currentPrice, rsi: rsi15m.toFixed(2), atr: atr15m.toFixed(2) };
    const marketData4h = { rsi: rsi4h.toFixed(2), atr: atr4h.toFixed(2) };

    // 🔒 状态一：持仓中
    if (position.status !== 'NONE') {
        const holdingHours = (now - position.entryTime) / (1000 * 60 * 60);
        let maxHours = 24, checkIntervalMins = 30; 
        if (position.strategy === '网格撸毛兵') { maxHours = 3; checkIntervalMins = 15; }
        else if (position.strategy === '动能刺客') { maxHours = 6; checkIntervalMins = 30; }
        else if (position.strategy === '马丁接针兵') { maxHours = 12; checkIntervalMins = 60; }

        let isClosed = false; let closeReason = "";

        if (holdingHours >= maxHours) {
            console.log(`⏰ [${position.strategy}] 存活 ${holdingHours.toFixed(1)}H 超时！执行斩仓！`);
            await closePositionAndCancelOrders("ETHUSDT", position.status, position.qty);
            isClosed = true; closeReason = "超时主动撤退";
        }

        if (!isClosed) {
            const timeSinceLastCheck = now - (position.lastAICheckTime || position.entryTime);
            if (timeSinceLastCheck >= checkIntervalMins * 60 * 1000) {
                console.log(`👀 [多周期破势侦察] 唤醒 AI 复查盘面...`);
                position.lastAICheckTime = now; 
                
                const currentStrategy = determineStrategy(atr15m, currentPrice, rsi15m);
                const aiDecision = await askAIForEntry(marketData15m, marketData4h, currentStrategy);
                
                const isReversalLong = position.status === 'LONG' && aiDecision.direction === 'SHORT' && aiDecision.confidence >= 70;
                const isReversalShort = position.status === 'SHORT' && aiDecision.direction === 'LONG' && aiDecision.confidence >= 70;
                
                if (isReversalLong || isReversalShort) {
                    console.log(`🚨 破势触发！持仓 [${position.status}]，AI 看 [${aiDecision.direction}]！提前逃命！`);
                    await closePositionAndCancelOrders("ETHUSDT", position.status, position.qty);
                    isClosed = true; closeReason = "破势提前逃命";
                }
            }
        }

        if (isClosed) {
            inMemoryDB.recent_trades.push({ dir: position.status, entry: position.entryPrice, exit: currentPrice, result: closeReason });
            position = { status: 'NONE', entryPrice: null, sl: null, qty: 0, entryTime: null, strategy: null, lastAICheckTime: null };
        } else {
            console.log(`🛡️ [${position.strategy}] 持仓中... 已存活 ${holdingHours.toFixed(1)}/${maxHours}H | 现价: ${currentPrice}`);
        }
        return; 
    }

    // ⚔️ 状态二：空仓寻找机会
    const currentStrategy = determineStrategy(atr15m, currentPrice, rsi15m);
    const aiDecision = await askAIForEntry(marketData15m, marketData4h, currentStrategy);
    
    if (aiDecision) console.log(`🧠 [多周期雷达 - ${currentStrategy}] 汇报: 方向=${aiDecision.direction}, 把握=${aiDecision.confidence||0}分, 理由=${aiDecision.reason||'无'}`);

    if (aiDecision && (aiDecision.direction === 'LONG' || aiDecision.direction === 'SHORT')) {
        let dir = aiDecision.direction;
        let conf = parseInt(aiDecision.confidence) || 0;
        
        let tradeQty = 0;
        if (conf >= 95) tradeQty = 0.03;       
        else if (conf >= 80) tradeQty = 0.02;  
        else if (conf >= 60) tradeQty = 0.01;  
        else return; 

        console.log(`🚀 AI 开火! 把握: ${conf}分 -> 发送限价单兵力: ${tradeQty} ETH，价格: ${currentPrice}`);
        
        // 🔥 这里把 strategy 传给了 autoTrade 函数！
        const success = await autoTrade("ETHUSDT", dir, tradeQty, aiDecision.sl, currentPrice, currentStrategy);
        if (success) {
            position = { status: dir, entryPrice: currentPrice, sl: parseFloat(aiDecision.sl), qty: tradeQty, entryTime: now, strategy: currentStrategy, lastAICheckTime: now };
            inMemoryDB.recent_trades.push({ dir, entry: currentPrice, exit: "持仓中", result: `LIMIT开仓(${tradeQty}个)` });
        }
    }
  } catch (e) { console.log("监控异常:", e.message); }
}

// ==========================================
// 📊 老板专属报表 & 网页控制台
// ==========================================
async function runHourlyReport() { 
    const trades = inMemoryDB.recent_trades; 
    let msg = `<b>📊 V8.1 小时级简报</b><br><br>当前持仓: ${position.status === 'NONE' ? '空仓' : `${position.status} (${position.qty} ETH)`}<br><br><b>近期流水:</b><br>`; 
    trades.forEach(t => msg += `- ${t.dir} | 进: ${t.entry} | 出: ${t.exit} | 结果: ${t.result}<br>`); 
    await sendSignalEmail("小时财报", msg || "本小时无交易。"); 
}

async function runDailyAIReview() { 
    const tradesStr = JSON.stringify(inMemoryDB.recent_trades); 
    const pastMemory = await loadMemory(); 
    const memoryStr = pastMemory.slice(-7).join(" | "); 
    const prompt = `你是本基金首席风控官。\n【历史教训】：${memoryStr || "无"}\n【今天流水】：${tradesStr}。\n结合历史教训复盘，给出优化建议。200字内总结。`; 
    try { 
        const res = await postJSON("https://api.deepseek.com/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: prompt }] }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` }); 
        const summary = res.choices[0].message.content; 
        pastMemory.push(`[${new Date().toLocaleDateString()}] 教训: ${summary.substring(0, 100)}...`); 
        await saveMemory(pastMemory.slice(-15)); 
        await sendSignalEmail("📈 每日 AI 进化报告", summary.replace(/\n/g, '<br>')); 
        inMemoryDB.recent_trades = []; 
    } catch(e) {} 
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/status') { res.end(JSON.stringify({ status: "alive", mode: "V8.1 Dynamic Callback", position })); return; }
  if (req.url === '/memory') {
      const memory = await loadMemory();
      let html = `<div style="max-width: 800px; margin: 40px auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px; background-color: #f9f9f9;">
          <h2 style="text-align: center;">🧠 首席风控官 - 进化错题本</h2><hr>`;
      if(memory.length === 0) html += `<p style="text-align: center;">📭 大脑空空如也，满 24 小时后生成首条记忆。</p>`;
      else { html += `<ul>`; memory.forEach(m => html += `<li style="margin-bottom: 15px;">${m}</li>`); html += `</ul>`; }
      html += `<br><div style="text-align: center;"><a href="/" style="text-decoration: none; background: #007bff; color: white; padding: 10px 20px; border-radius: 5px;">返回主页</a></div></div>`;
      res.end(html); return;
  }
  res.end(`<div style="text-align: center; margin-top: 50px;">
      <h1>🚀 系统运行中: V8.1 精细化兵权版</h1>
      <p style="color: #28a745; font-size: 18px;">具备分兵种动态回撤率，利润锁死率大幅提升！</p><br>
      <a href="/memory" style="text-decoration: none; background: #28a745; color: white; padding: 15px 30px; border-radius: 8px; display: inline-block;">📖 点击查看：AI 进化错题本</a>
  </div>`);
}).listen(process.env.PORT || 3000);

setInterval(runMonitor, CHECK_INTERVAL_MS); 
setInterval(runHourlyReport, 60 * 60 * 1000); 
setInterval(runDailyAIReview, 24 * 60 * 60 * 1000); 
runMonitor();
