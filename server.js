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

// 🔥 V9.0：舰队阵列配置 (ETH, BTC, SOL)
const SYMBOLS = ['ETHUSDT', 'BTCUSDT', 'SOLUSDT'];
const QTY_MAP = {
    'ETHUSDT': 0.01,   // 基础兵力
    'BTCUSDT': 0.001,  // 基础兵力
    'SOLUSDT': 0.1     // 基础兵力
};

// 状态阵列化：每个币种拥有独立状态
let positions = {};
SYMBOLS.forEach(sym => {
    positions[sym] = { status: 'NONE', entryPrice: null, sl: null, qty: 0, entryTime: null, strategy: null, lastAICheckTime: null };
});

let isMonitoringActive = true; 
let inMemoryDB = { recent_trades: [] }; 

console.log("👑 V9.0 三叉戟舰队版 (多币种并发+防失忆+多周期+瞬发市价) 终极上线！");

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
                    if (response.code) console.error(`❌ API失败 [${method} ${endpointPath}]:`, response.msg);
                    resolve(response);
                } catch(e) { resolve(body); }
            });
        });
        req.on('error', reject); 
        if (method === 'POST') req.write(data); 
        req.end();
    });
}

// 交易连招：市价进场 + 挂专属防弹衣
async function autoTrade(symbol, direction, qty, slPrice, currentPrice, strategy) {
    const isLong = direction === 'LONG';
    const entrySide = isLong ? 'BUY' : 'SELL';
    const exitSide = isLong ? 'SELL' : 'BUY';

    let cbRate = '1.5'; 
    if (strategy === '网格撸毛兵') cbRate = '0.6';      
    else if (strategy === '马丁接针兵') cbRate = '1.0'; 
    else if (strategy === '动能刺客') cbRate = '1.5';   
    
    // 1. 市价开仓瞬间进场
    const entryRes = await executeBinanceOrder('/fapi/v1/order', { symbol, side: entrySide, type: 'MARKET', quantity: qty });
    if (entryRes && entryRes.code) return false; 

    const sl = parseFloat(slPrice).toFixed(2); // 根据实际币种价格精度，这里保留两位基本够用，BTC可能需要无小数，但API兼容
    
    // 2. 挂固定止损
    await executeBinanceOrder('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: exitSide, type: 'STOP_MARKET', triggerPrice: sl, quantity: qty, reduceOnly: 'true' });
    // 3. 挂追踪止盈
    console.log(`🛡️ [${symbol}] 军备发放：为 [${strategy}] 装备回撤率为 ${cbRate}% 的追踪导弹！`);
    await executeBinanceOrder('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: exitSide, type: 'TRAILING_STOP_MARKET', callbackRate: cbRate, quantity: qty, reduceOnly: 'true' });
    
    return true;
}

// 主动撤退连招 (精准撤销指定币种的单子，绝不误伤友军)
async function closePositionAndCancelOrders(symbol, direction, qty) {
    await executeBinanceOrder('/fapi/v1/allOpenOrders', { symbol }, 'DELETE'); 
    const exitSide = direction === 'LONG' ? 'SELL' : 'BUY';
    await executeBinanceOrder('/fapi/v1/order', { symbol, side: exitSide, type: 'MARKET', quantity: qty, reduceOnly: 'true' });
    return true;
}

// 批量状态同步：同时查询三个战场的真实持仓
async function syncRealPositions() {
    const riskRes = await executeBinanceOrder('/fapi/v2/positionRisk', {}, 'GET');
    if (Array.isArray(riskRes)) {
        SYMBOLS.forEach(symbol => {
            const pos = riskRes.find(p => p.symbol === symbol);
            if (pos) {
                const amt = parseFloat(pos.positionAmt);
                const entryP = parseFloat(pos.entryPrice);
                
                if (amt !== 0) {
                    const realDir = amt > 0 ? 'LONG' : 'SHORT';
                    if (positions[symbol].status === 'NONE') {
                        console.log(`🔄 [失忆恢复] ${symbol} 真实持仓: ${realDir} ${Math.abs(amt)}！系统已接管！`);
                        positions[symbol] = { status: realDir, entryPrice: entryP, sl: null, qty: Math.abs(amt), entryTime: Date.now(), strategy: '失忆接管兵', lastAICheckTime: Date.now() };
                    }
                } else {
                    if (positions[symbol].status !== 'NONE') {
                        console.log(`✅ [状态同步] ${symbol} 已在云端平仓，本地兵营重置。`);
                        positions[symbol] = { status: 'NONE', entryPrice: null, sl: null, qty: 0, entryTime: null, strategy: null, lastAICheckTime: null };
                    }
                }
            }
        });
    }
}

// ==========================================
// 📦 工具与计算函数
// ==========================================
function postJSON(url, body, extraHeaders) { return new Promise((resolve, reject) => { const data = JSON.stringify(body); const urlObj = new URL(url); const options = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(extraHeaders||{}) } }; const req = https.request(options, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } }); }); req.on('error', reject); req.write(data); req.end(); }); }
function fetchJSON(url) { return new Promise((resolve, reject) => { https.get(url, { headers: { 'User-Agent': 'Assassin-Bot/9.0' } }, (res) => { let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } }); }).on('error', reject); }); }
async function sendSignalEmail(titleStr, messageHtml) { const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }); try { await postJSON("https://api.emailjs.com/api/v1.0/email/send", { service_id: EMAILJS_SERVICE_ID, template_id: EMAILJS_TEMPLATE_ID, user_id: EMAILJS_PUBLIC_KEY, accessToken: EMAILJS_PRIVATE_KEY, template_params: { to_email: NOTIFY_EMAIL, symbol: "V9.0 战报", interval: titleStr, signal: "汇报", price: "N/A", message: messageHtml, time: time }}); } catch (e) {} }

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

// AI 思考：明确告知当前正在看哪个币
async function askAIForEntry(symbol, data15m, data4h, strategy) {
  if (!DEEPSEEK_API_KEY) return null;
  const prompt = `你是风控官。当前侦察战场：[${symbol}]，兵种：[${strategy}]。
【15m 数据(战术)】：${JSON.stringify(data15m)}
【4H 数据(战略)】：${JSON.stringify(data4h)}
任务：结合双周期数据，寻找该币种的共振开仓/反转信号。
【输出要求】严格返回JSON：{"direction": "LONG/SHORT/WAIT", "sl": 止损价位, "confidence": 0到100, "reason": "逻辑"}`;
  try {
    const res = await postJSON("https://api.deepseek.com/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.2 }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
    let jsonStr = res.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, '');
    const match = jsonStr.match(/\{[\s\S]*\}/); 
    if (match) return JSON.parse(match[0]);
    return { direction: 'WAIT', confidence: 0, reason: '未找到合适信号' };
  } catch (e) { return { direction: 'WAIT', confidence: 0, reason: 'AI 通信异常' }; }
}

// ==========================================
// 🛡️ 核心引擎：多战区循环巡视
// ==========================================
async function runMonitor() {
  if (!isMonitoringActive) return;
  try {
    // 1. 同步全市场持仓防失忆
    await syncRealPositions();
    const now = Date.now();
    
    // 2. 依次巡视三大战场 (ETH, BTC, SOL)
    for (const symbol of SYMBOLS) {
        let pos = positions[symbol];

        const raw15m = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=15m&limit=50`);
        const raw4h = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=4h&limit=50`);
        if (!Array.isArray(raw15m) || !Array.isArray(raw4h)) continue;

        const candles15m = raw15m.map(d => ({ high: +d[2], low: +d[3], close: +d[4] }));
        const candles4h = raw4h.map(d => ({ high: +d[2], low: +d[3], close: +d[4] }));
        
        const currentPrice = candles15m[candles15m.length - 1].close;
        const atr15m = calcATR(candles15m, 14), rsi15m = calcRSI(candles15m, 14);
        const atr4h = calcATR(candles4h, 14), rsi4h = calcRSI(candles4h, 14);

        const marketData15m = { currentPrice, rsi: rsi15m.toFixed(2), atr: atr15m.toFixed(2) };
        const marketData4h = { rsi: rsi4h.toFixed(2), atr: atr4h.toFixed(2) };

        // 🔒 状态一：该战场正在交火 (持仓中)
        if (pos.status !== 'NONE') {
            const holdingHours = (now - pos.entryTime) / (1000 * 60 * 60);
            let maxHours = 24, checkIntervalMins = 30; 
            if (pos.strategy === '网格撸毛兵') { maxHours = 3; checkIntervalMins = 15; }
            else if (pos.strategy === '动能刺客') { maxHours = 6; checkIntervalMins = 30; }
            else if (pos.strategy === '马丁接针兵') { maxHours = 12; checkIntervalMins = 60; }
            else { maxHours = 6; checkIntervalMins = 30; } // 兼容接管兵

            let isClosed = false; let closeReason = "";

            if (holdingHours >= maxHours) {
                console.log(`⏰ [${symbol}-${pos.strategy}] 存活 ${holdingHours.toFixed(1)}H 超时！执行斩仓！`);
                await closePositionAndCancelOrders(symbol, pos.status, pos.qty);
                isClosed = true; closeReason = "超时主动撤退";
            }

            if (!isClosed) {
                const timeSinceLastCheck = now - (pos.lastAICheckTime || pos.entryTime);
                if (timeSinceLastCheck >= checkIntervalMins * 60 * 1000) {
                    console.log(`👀 [${symbol} 破势侦察] 唤醒 AI 复查盘面...`);
                    positions[symbol].lastAICheckTime = now; 
                    
                    const currentStrategy = determineStrategy(atr15m, currentPrice, rsi15m);
                    const aiDecision = await askAIForEntry(symbol, marketData15m, marketData4h, currentStrategy);
                    
                    const isReversalLong = pos.status === 'LONG' && aiDecision.direction === 'SHORT' && aiDecision.confidence >= 70;
                    const isReversalShort = pos.status === 'SHORT' && aiDecision.direction === 'LONG' && aiDecision.confidence >= 70;
                    
                    if (isReversalLong || isReversalShort) {
                        console.log(`🚨 [${symbol}] 破势触发！持仓 [${pos.status}]，AI 看 [${aiDecision.direction}]！提前逃命！`);
                        await closePositionAndCancelOrders(symbol, pos.status, pos.qty);
                        isClosed = true; closeReason = "破势提前逃命";
                    }
                }
            }

            if (isClosed) {
                inMemoryDB.recent_trades.push({ symbol: symbol, dir: pos.status, entry: pos.entryPrice, exit: currentPrice, result: closeReason });
                positions[symbol] = { status: 'NONE', entryPrice: null, sl: null, qty: 0, entryTime: null, strategy: null, lastAICheckTime: null };
            } else {
                console.log(`🛡️ [${symbol}-${pos.strategy}] 持仓中... 已存活 ${holdingHours.toFixed(1)}/${maxHours}H | 现价: ${currentPrice}`);
            }
            
            continue; // 该币种正在交火，绝对排他，不执行下面的开单逻辑，直接去巡视下一个币种！
        }

        // ⚔️ 状态二：该战场目前空仓，寻找开火机会
        const currentStrategy = determineStrategy(atr15m, currentPrice, rsi15m);
        const aiDecision = await askAIForEntry(symbol, marketData15m, marketData4h, currentStrategy);
        
        if (aiDecision) console.log(`🧠 [${symbol}雷达 - ${currentStrategy}] 汇报: 方向=${aiDecision.direction}, 把握=${aiDecision.confidence||0}分, 理由=${aiDecision.reason||'无'}`);

        if (aiDecision && (aiDecision.direction === 'LONG' || aiDecision.direction === 'SHORT')) {
            let dir = aiDecision.direction;
            let conf = parseInt(aiDecision.confidence) || 0;
            
            let multiplier = 0;
            if (conf >= 95) multiplier = 3;       
            else if (conf >= 80) multiplier = 2;  
            else if (conf >= 60) multiplier = 1;  
            
            if (multiplier > 0) {
                // 根据该币种的“基础兵力”分配弹药，绝不多拿
                let tradeQty = parseFloat((QTY_MAP[symbol] * multiplier).toFixed(3));
                
                console.log(`🚀 [${symbol}] AI 开火! 把握: ${conf}分 -> 发送市价单兵力: ${tradeQty} 个，瞬发价: ${currentPrice}`);
                
                const success = await autoTrade(symbol, dir, tradeQty, aiDecision.sl, currentPrice, currentStrategy);
                if (success) {
                    positions[symbol] = { status: dir, entryPrice: currentPrice, sl: parseFloat(aiDecision.sl), qty: tradeQty, entryTime: now, strategy: currentStrategy, lastAICheckTime: now };
                    inMemoryDB.recent_trades.push({ symbol: symbol, dir: dir, entry: currentPrice, exit: "持仓中", result: `MARKET开仓(${tradeQty}个)` });
                }
            }
        }
    } // 结束当前循环，继续巡视下一个币种
  } catch (e) { console.log("监控异常:", e.message); }
}

// ==========================================
// 📊 老板专属报表 & 网页控制台
// ==========================================
async function runHourlyReport() { 
    const trades = inMemoryDB.recent_trades; 
    let msg = `<b>📊 V9.0 三叉戟舰队 简报</b><br><br><b>当前各战区状态:</b><br>`; 
    SYMBOLS.forEach(sym => {
        let p = positions[sym];
        msg += `- <b>${sym}</b>: ${p.status === 'NONE' ? '空仓待命 💤' : `<span style="color:green">${p.status}</span> (${p.qty} 个, 策略: ${p.strategy})`}<br>`;
    });
    msg += `<br><b>近期流水:</b><br>`; 
    if(trades.length === 0) msg += "无近期交易记录。<br>";
    trades.forEach(t => msg += `- [${t.symbol}] ${t.dir} | 进: ${t.entry} | 出: ${t.exit} | 结果: ${t.result}<br>`); 
    
    await sendSignalEmail("小时财报", msg); 
}

async function runDailyAIReview() { 
    const tradesStr = JSON.stringify(inMemoryDB.recent_trades); 
    const pastMemory = await loadMemory(); 
    const memoryStr = pastMemory.slice(-7).join(" | "); 
    const prompt = `你是本基金首席风控官。\n【历史教训】：${memoryStr || "无"}\n【今天三战区流水】：${tradesStr}。\n任务：结合历史复盘今天多币种表现，给出优化建议。200字内总结。`; 
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
  if (req.url === '/status') { res.end(JSON.stringify({ status: "alive", mode: "V9.0 Trident Fleet", positions })); return; }
  if (req.url === '/memory') {
      const memory = await loadMemory();
      let html = `<div style="max-width: 800px; margin: 40px auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px; background-color: #f9f9f9;">
          <h2 style="text-align: center;">🧠 首席风控官 - 进化错题本</h2><hr>`;
      if(memory.length === 0) html += `<p style="text-align: center;">📭 大脑空空如也，满 24 小时后生成首条记忆。</p>`;
      else { html += `<ul>`; memory.forEach(m => html += `<li style="margin-bottom: 15px;">${m}</li>`); html += `</ul>`; }
      html += `<br><div style="text-align: center;"><a href="/" style="text-decoration: none; background: #007bff; color: white; padding: 10px 20px; border-radius: 5px;">返回主页</a></div></div>`;
      res.end(html); return;
  }
  
  let htmlStatus = "";
  SYMBOLS.forEach(sym => {
      let p = positions[sym];
      let color = p.status === 'NONE' ? '#666' : (p.status === 'LONG' ? '#28a745' : '#dc3545');
      htmlStatus += `<div style="margin: 10px 0; padding: 10px; border: 1px solid #ccc; border-radius: 5px;">
        <strong>${sym}</strong>: <span style="color: ${color}; font-weight: bold;">${p.status}</span> 
        ${p.status !== 'NONE' ? `(数量: ${p.qty}, 策略: ${p.strategy})` : ''}
      </div>`;
  });

  res.end(`<div style="text-align: center; margin-top: 50px; font-family: Arial;">
      <h1>🚀 系统运行中: V9.0 三叉戟舰队版</h1>
      <p style="color: #007bff; font-size: 18px;">ETH、BTC、SOL 三大战场已完成火力覆盖！</p>
      <div style="max-width: 400px; margin: 0 auto; text-align: left;">${htmlStatus}</div>
      <br>
      <a href="/memory" style="text-decoration: none; background: #28a745; color: white; padding: 15px 30px; border-radius: 8px; display: inline-block;">📖 点击查看：AI 进化错题本</a>
  </div>`);
}).listen(process.env.PORT || 3000);

setInterval(runMonitor, CHECK_INTERVAL_MS); 
setInterval(runHourlyReport, 60 * 60 * 1000); 
setInterval(runDailyAIReview, 24 * 60 * 60 * 1000); 
runMonitor();
