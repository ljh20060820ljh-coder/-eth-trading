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

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const TIMEFRAME = "15m"; // 主力作战周期
const TREND_TIMEFRAME = "4h"; // 大局观周期
const CHECK_INTERVAL_MS = 5 * 60 * 1000; 
const ALERT_CHECK_INTERVAL = 10 * 1000; 

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY; 
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;
const SERVERCHAN_SENDKEY = process.env.SERVERCHAN_SENDKEY; 

let positions = {}; 
let entryPrices = {}; // 记录入场价，用于硬止损
SYMBOLS.forEach(sym => { positions[sym] = null; entryPrices[sym] = null; });
let lastPrices = { BTCUSDT: null, ETHUSDT: null, SOLUSDT: null };
let cachedNews = []; 
let isMonitoringActive = true; 
let inMemoryDB = { trade_logs: [], price_alerts: [] };

console.log("👑 量化 AI (神级三维防御版) 已上线...");

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

function fetchJSON(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'God-Mode-Bot/1.0', ...extraHeaders } }, (res) => {
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

async function loadData(key) { 
    if (!KV_REST_API_URL || !KV_REST_API_TOKEN) return inMemoryDB[key] || []; 
    try { const res = await fetchJSON(`${KV_REST_API_URL}/get/${key}`, { Authorization: `Bearer ${KV_REST_API_TOKEN}` }); if (res.result) return typeof res.result === 'string' ? JSON.parse(res.result) : res.result; } catch(e) {} 
    return inMemoryDB[key] || []; 
}
async function saveData(key, data) { 
    inMemoryDB[key] = data;
    if (KV_REST_API_URL && KV_REST_API_TOKEN) {
        try { await postJSON(`${KV_REST_API_URL}/set/${key}`, data, { Authorization: `Bearer ${KV_REST_API_TOKEN}` }); }catch(e){} 
    }
}
async function addTradeLog(symbol, action, style, entryPrice) { 
    const logs = await loadData('trade_logs'); 
    logs.push({ id: Date.now().toString(), symbol, timeframe: TIMEFRAME, entryTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }), action, style, entryPrice, status: 'OPEN' });
    await saveData('trade_logs', logs.slice(-50)); 
}

// ==========================================
// 📊 神级数学指标库
// ==========================================
function calcMA(data, period) { if (data.length < period) return 0; return data.slice(-period).reduce((sum, c) => sum + c.close, 0) / period; }
function calcRSI(data, period = 14) { if (data.length < period + 1) return 50; let gains = 0, losses = 0; for (let i = data.length - period; i < data.length; i++) { const diff = data[i].close - data[i-1].close; if (diff > 0) gains += diff; else losses -= diff; } const avgLoss = losses / period; if (avgLoss === 0) return 100; return 100 - (100 / (1 + (gains / period) / avgLoss)); }
function calcATR(data, period = 14) { if (data.length < period + 1) return 0; let sumTR = 0; for (let i = data.length - period; i < data.length; i++) { const high = data[i].high, low = data[i].low, prevClose = data[i-1].close; sumTR += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)); } return sumTR / period; }
// 🔥 新增：指数移动平均线 (用于判断 4H 长期牛熊)
function calcEMA(data, period) {
    if (data.length < period) return data[data.length-1].close;
    let sum = 0; for(let i=0; i<period; i++) sum += data[i].close;
    let ema = sum / period; 
    const k = 2 / (period + 1);
    for (let i = period; i < data.length; i++) { ema = (data[i].close - ema) * k + ema; }
    return ema;
}

// ==========================================
// 🧠 AI 决策层
// ==========================================
async function fetchAndAnalyzeNews() {
    if (!DEEPSEEK_API_KEY) return;
    try {
        const res = await fetchJSON('https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fcointelegraph.com%2Frss');
        if (!res || !res.items) return;
        const topNews = res.items.slice(0, 5);
        const prompt = `分析加密新闻利好利空。严格返回 JSON 数组格式，不要有思考过程：[{"date":"MM-DD HH:mm", "title":"中文标题", "sentiment":"利好 80%", "type":"bull"}]新闻：\n${topNews.map(n => n.title).join('\n')}`;
        const aiRes = await postJSON("https://api.deepseek.com/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.3 }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
        let jsonStr = aiRes.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json/gi, '').replace(/```/g, '').trim();
        cachedNews = JSON.parse(jsonStr).map((item, i) => ({ ...item, link: topNews[i].link }));
    } catch(e) { cachedNews = [{date: "系统", title: "新闻引擎维护中...", sentiment: "中性", type: "neutral", link: "#"}]; }
}

async function askAIBatchDecisions(batchData) {
  if (!DEEPSEEK_API_KEY || batchData.length === 0) return [];
  const prompt = `你是华尔街量化之神。根据数据给出决策。严格返回 JSON 数组：[{"symbol": "BTCUSDT", "direction": "LONG/SHORT/WAIT", "style": "STEADY", "win_rate": 85, "sl": 0, "tp1": 0, "reason": "理由"}]\n数据：${JSON.stringify(batchData)}`;
  try {
    const res = await postJSON("https://api.deepseek.com/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.2 }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
    let jsonStr = res.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(jsonStr);
  } catch (e) { return []; }
}

// ==========================================
// 🛡️ 核心防御与运行引擎
// ==========================================
async function runMonitor() {
  if (!isMonitoringActive) return;
  let batchData = [];
  
  for (const symbol of SYMBOLS) {
      try {
        // 1. 获取 4小时级别数据 (大局观)
        const data4h = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${TREND_TIMEFRAME}&limit=250`);
        const candles4h = data4h.map(d => ({ close: +d[4] }));
        const ema200_4h = calcEMA(candles4h, 200);
        
        // 2. 获取 15分钟级别数据 (作战级)
        const data15m = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${TIMEFRAME}&limit=50`);
        const candles15m = data15m.map(d => ({ open: +d[1], high: +d[2], low: +d[3], close: +d[4] }));
        const currentPrice = candles15m[candles15m.length - 1].close;
        lastPrices[symbol] = currentPrice;
        
        const ma5 = calcMA(candles15m, 5), ma10 = calcMA(candles15m, 10);
        const rsi = calcRSI(candles15m, 14);
        
        // 🛑 军规 1：瀑布探测器 (如果最后一根 15m K线跌幅超过 1.5%，判定为瀑布)
        const lastCandle = candles15m[candles15m.length - 1];
        const dropPercent = ((lastCandle.open - lastCandle.close) / lastCandle.open) * 100;
        const isWaterfall = dropPercent > 1.5;

        // 🛑 军规 2：大趋势判定 (价格在 4H EMA200 下方视为熊市)
        const isBearTrend = currentPrice < ema200_4h;

        // 🛑 军规 3：5% 铁血硬止损 (越权管理)
        if (positions[symbol] === 'LONG' && entryPrices[symbol]) {
            const lossPercent = ((entryPrices[symbol] - currentPrice) / entryPrices[symbol]) * 100;
            if (lossPercent >= 5.0 || isWaterfall) {
                await sendSignalEmail("🩸 强制熔断平仓", `亏损触及 5% 底线或遭遇极端瀑布，系统已强制越权平仓！`, currentPrice, TIMEFRAME, symbol);
                await sendWeChatPush(`🚨 ${symbol} 强制平仓`, `当前跌幅过大，已触发底层保本协议。`);
                positions[symbol] = null;
                entryPrices[symbol] = null;
                continue; // 跳过 AI 决策，直接跑路
            }
        }

        batchData.push({ symbol, currentPrice, ma5, ma10, rsi, ema200_4h, isWaterfall, isBearTrend, currentPos: positions[symbol] });
      } catch (e) {}
  }

  if (batchData.length > 0) {
      const results = await askAIBatchDecisions(batchData);
      if (!Array.isArray(results)) return;

      for (const res of results) {
          if (!res || !res.symbol || !res.direction) continue; 
          const sym = res.symbol;
          let dir = res.direction.toUpperCase();
          const targetData = batchData.find(b => b.symbol === sym);

          // ⚖️ 【神级否决权 (Veto System)】：底层代码纠正 AI 的错误判断
          if (dir === 'LONG') {
              if (targetData.isWaterfall) {
                  console.log(`❌ VETO: 拒绝在瀑布中做多 ${sym}`);
                  dir = 'WAIT';
                  res.reason = "【底层拦截】遭遇超 1.5% 极端瀑布砸盘，禁止接飞刀！";
              } else if (targetData.isBearTrend) {
                  console.log(`❌ VETO: 拒绝在 4H 熊市做多 ${sym}`);
                  dir = 'WAIT';
                  res.reason = "【底层拦截】大级别 (4H) 处于 EMA200 熊市区间，顺势为王，禁止逆势开多！";
              }
          }

          if (dir === positions[sym]) continue;
          
          if (dir === 'WAIT') {
              if (positions[sym]) {
                  await sendSignalEmail("🏳️ 平仓收网", res.reason, lastPrices[sym], TIMEFRAME, sym);
                  await sendWeChatPush(`平仓提醒: ${sym}`, `理由: ${res.reason}`);
                  positions[sym] = null;
                  entryPrices[sym] = null;
              }
          } else if (parseInt(res.win_rate || 0) >= 60) {
              positions[sym] = dir;
              entryPrices[sym] = lastPrices[sym]; // 记录入场价用于硬止损
              await sendSignalEmail(`🎯 神级开仓: ${dir}`, res.reason, lastPrices[sym], TIMEFRAME, sym);
              await sendWeChatPush(`开仓: ${sym} ${dir}`, `胜率: ${res.win_rate}%\n逻辑: ${res.reason}\n(已开启 5% 硬止损保护)`);
              await addTradeLog(sym, dir, res.style || 'GOD_MODE', lastPrices[sym]);
          }
      }
  }
}

// 独立的云端价格提醒引擎
async function runAlertEngine() {
    try {
        const alerts = await loadData('price_alerts'); if (!alerts || alerts.length === 0) return;
        const res = await fetchJSON('https://api.binance.us/api/v3/ticker/price');
        const priceMap = {}; res.forEach(item => priceMap[item.symbol] = parseFloat(item.price));
        let triggered = false; const remainingAlerts = [];
        for (const alert of alerts) {
            const cur = priceMap[alert.symbol];
            if (!cur) { remainingAlerts.push(alert); continue; }
            if ((alert.dir === 'above' && cur >= alert.price) || (alert.dir === 'below' && cur <= alert.price)) {
                await sendWeChatPush(`🚨 价格云端提醒`, `${alert.symbol} 到达 ${cur}`);
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

  if (req.url === '/status') { res.end(JSON.stringify({ status: "alive", mode: "God Mode", isMonitoringActive })); return; }
  if (req.url === '/api/news') { res.end(JSON.stringify(cachedNews)); return; }
  if (req.url === '/api/logs') { const logs = await loadData('trade_logs'); res.end(JSON.stringify(logs.reverse())); return; }
  if (req.url === '/api/toggle-monitor' && req.method === 'POST') { isMonitoringActive = !isMonitoringActive; res.end(JSON.stringify({success:true})); return; }
  if (req.url === '/api/test-signal') {
      await sendWeChatPush("👑 神级终端测试", "通信网络完全正常，底层防御系统已激活！");
      res.end("Test Sent"); return;
  }
  
  // 简化的价格提醒接口
  if (req.url === '/api/alerts' && req.method === 'GET') { const alerts = await loadData('price_alerts'); res.end(JSON.stringify(alerts)); return; }
  if (req.url === '/api/alerts' && req.method === 'POST') {
      let body = ''; req.on('data', c => body += c.toString());
      req.on('end', async () => { try { const newAlert = JSON.parse(body); const alerts = await loadData('price_alerts'); alerts.push({ id: Date.now().toString(), symbol: newAlert.symbol, price: newAlert.price, dir: newAlert.dir }); await saveData('price_alerts', alerts); res.end(JSON.stringify({success: true})); } catch(e) { res.end(JSON.stringify({success: false})); }}); return;
  }
  if (req.url === '/api/alerts' && req.method === 'DELETE') {
      let body = ''; req.on('data', c => body += c.toString());
      req.on('end', async () => { try { const { id } = JSON.parse(body); let alerts = await loadData('price_alerts'); alerts = alerts.filter(a => a.id !== id); await saveData('price_alerts', alerts); res.end(JSON.stringify({success: true})); } catch(e) { res.end(JSON.stringify({success: false})); }}); return;
  }
  res.end("System Running");
}).listen(process.env.PORT || 3000);

// ==========================================
// 🚀 循环点火
// ==========================================
setInterval(fetchAndAnalyzeNews, 30 * 60 * 1000); 
setInterval(runMonitor, CHECK_INTERVAL_MS); 
setInterval(runAlertEngine, ALERT_CHECK_INTERVAL);
fetchAndAnalyzeNews(); runMonitor();
