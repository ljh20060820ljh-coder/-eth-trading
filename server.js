const https = require('https');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🔑 完美密钥配置
// ==========================================
const EMAILJS_SERVICE_ID = "service_op2rg49"; 
const EMAILJS_TEMPLATE_ID = "template_eftwoy6"; 
const EMAILJS_PUBLIC_KEY = "tIZB9DwwpEKr3KQpQ"; 
const EMAILJS_PRIVATE_KEY = "s76zhOvxmYLR_PDbtTxtg"; 

const DEEPSEEK_API_KEY = "sk-9afe367ef974483693b3e829b203dd6b"; 
const NOTIFY_EMAIL = "2183089849@qq.com";

const SYMBOL = "ETHUSDT";
const CHECK_INTERVAL_MS = 5 * 60 * 1000; 

// ==========================================
// 💾 Upstash Redis 云端数据库配置 (永久记忆)
// ==========================================
const KV_REST_API_URL = "https://exact-sparrow-75815.upstash.io"; 
const KV_REST_API_TOKEN = "gQAAAAAAASgnAAIncDIwNDI1YTkzZjJjNzg0YTIwYTI5MGU0OThjMzk4ZDE3ZXAyNzU4MTU";

let currentPosition = null; 
let lastPrice = null;
let reflectedToday = false; 

console.log("🚀 ETH 量化 AI (云数据库记忆版) 已上线...");

// --- 网络请求增强版 (支持数据库请求) ---
function postJSON(url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname, path: urlObj.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(extraHeaders||{}) }
    };
    const req = https.request(options, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${d}`));
        else { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } }
      });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

function fetchJSON(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ETH-Monitor/7.0', ...extraHeaders } }, (res) => {
      let data = ''; res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

// --- 🧠 核心升级：直连 Upstash 云数据库 ---
async function loadLogs() {
  if (!KV_REST_API_URL || KV_REST_API_URL.includes("填入")) return [];
  try {
      const res = await fetchJSON(`${KV_REST_API_URL}/get/trade_logs`, { Authorization: `Bearer ${KV_REST_API_TOKEN}` });
      if (res.result) return typeof res.result === 'string' ? JSON.parse(res.result) : res.result;
  } catch (e) { console.error("读取云数据库失败:", e.message); }
  return [];
}

async function saveLogs(logs) {
  if (!KV_REST_API_URL || KV_REST_API_URL.includes("填入")) return;
  try {
      await postJSON(`${KV_REST_API_URL}/set/trade_logs`, logs, { Authorization: `Bearer ${KV_REST_API_TOKEN}` });
  } catch (e) { console.error("写入云数据库失败:", e.message); }
}

async function addTradeLog(action, style, entryPrice) {
  const logs = await loadLogs();
  logs.push({
    id: Date.now().toString(),
    entryTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    entryTimestamp: Date.now(),
    action: action, style: style, entryPrice: entryPrice,
    exitPrice: null, exitTime: null, holdTime: null, roi: null, status: 'OPEN'
  });
  await saveLogs(logs);
}

// --- 技术指标 ---
function calcMA(data, period) {
  if (data.length < period) return 0;
  return data.slice(-period).reduce((sum, c) => sum + c.close, 0) / period;
}
function calcRSI(data, period = 14) {
  if (data.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = data.length - period; i < data.length; i++) {
    const diff = data[i].close - data[i-1].close;
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + (gains / period) / avgLoss));
}
function calcATR(data, period = 14) {
  if (data.length < period + 1) return 0;
  let sumTR = 0;
  for (let i = data.length - period; i < data.length; i++) {
    const high = data[i].high, low = data[i].low, prevClose = data[i-1].close;
    sumTR += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  return sumTR / period;
}

// --- 发信通道 ---
async function sendSignalEmail(action, messageHtml, price, titleStr) {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  try {
    await postJSON("https://api.emailjs.com/api/v1.0/email/send", {
      service_id: EMAILJS_SERVICE_ID, template_id: EMAILJS_TEMPLATE_ID, user_id: EMAILJS_PUBLIC_KEY, accessToken: EMAILJS_PRIVATE_KEY, 
      template_params: { to_email: NOTIFY_EMAIL, symbol: SYMBOL, interval: titleStr || "15分钟 K线", signal: action, price: price.toString(), message: messageHtml, time: time }
    });
    console.log(`[${time}] 📧 邮件已发出: ${action}`);
  } catch (e) { console.error(`[${time}] ❌ 发信失败: ${e.message}`); }
}

// --- 🧠 AI JSON 策略大脑 ---
async function askAIForDecision(confirmedCandles, livePrice, currentPos) {
  const lastClosed = confirmedCandles[confirmedCandles.length - 1];
  const prevClosed = confirmedCandles[confirmedCandles.length - 2];
  const ma5 = calcMA(confirmedCandles, 5), ma10 = calcMA(confirmedCandles, 10), ma20 = calcMA(confirmedCandles, 20);
  const rsi = calcRSI(confirmedCandles, 14), atr = calcATR(confirmedCandles, 14); 
  const volSurge = lastClosed.volume > (prevClosed.volume * 1.5) ? "⚠️成交量异动" : "平稳";
  const posText = currentPos === 'LONG' ? '多单' : currentPos === 'SHORT' ? '空单' : '空仓';

  const prompt = `你是一个顶级量化交易模型。
【已收盘定型】: MA5=${ma5.toFixed(2)}, RSI=${rsi.toFixed(1)}, ATR=${atr.toFixed(2)}, ${volSurge}。
【当前跳动价格】: ${livePrice}。当前持仓: ${posText}。
【要求】: 必须回复 JSON。
{
  "direction": "WAIT", // LONG, SHORT, 或 WAIT
  "style": "STEADY", // STEADY, 或 AGGRESSIVE
  "win_rate": 0, "sl": 0, "tp1": 0, "tp2": 0, "reason": "分析逻辑"
}`;

  try {
    const res = await postJSON("https://api.deepseek.com/chat/completions", {
      model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.2 
    }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
    return res.choices[0].message.content;
  } catch (e) { return null; }
}

// --- 🧠 AI 每日复盘大脑 ---
async function dailyReflection() {
  const logs = await loadLogs(); // 从云端读取
  const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const todaysTrades = logs.filter(log => log.entryTime.includes(today) && log.status === 'CLOSED');
  
  if (todaysTrades.length === 0) return;

  let tradeSummary = todaysTrades.map(t => `方向: ${t.action}, 风格: ${t.style}, 入场: ${t.entryPrice}, 出场: ${t.exitPrice}, 收益率: ${t.roi}%`).join('\n');
  const prompt = `你是一个不断进化的交易员。今日交易记录：\n${tradeSummary}\n请进行【深夜复盘】：1.总结表现 2.分析盈利单 3.反思亏损单 4.明日策略。`;

  try {
    const res = await postJSON("https://api.deepseek.com/chat/completions", {
      model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.7 
    }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
    await sendSignalEmail("【AI 每日深度复盘报告】", res.choices[0].message.content.replace(/\n/g, '<br>'), "今日结算", "日记簿");
  } catch (e) { console.error("复盘失败", e.message); }
}

// --- 监控主循环 ---
async function runMonitor() {
  const time = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const nowHour = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false });
  const nowMin = new Date().getMinutes();

  if (nowHour === '23' && nowMin >= 50 && !reflectedToday) { await dailyReflection(); reflectedToday = true; }
  if (nowHour === '00' && reflectedToday) reflectedToday = false;

  try {
    const data = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${SYMBOL}&interval=15m&limit=30`);  
    if (!Array.isArray(data)) return;
    const candles = data.map(d => ({ open: +d[1], high: +d[2], low: +d[3], close: +d[4], volume: +d[5] }));
    lastPrice = candles[candles.length - 1].close;
    const confirmedCandles = candles.slice(0, -1); 

    const aiResponse = await askAIForDecision(confirmedCandles, lastPrice, currentPosition);
    if (!aiResponse) return;
    
    let aiObj;
    try {
        const cleanStr = aiResponse.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json/g, '').replace(/```/g, '').trim();
        aiObj = JSON.parse(cleanStr);
    } catch(e) { return; }

    const targetDir = aiObj.direction ? aiObj.direction.toUpperCase() : 'WAIT';
    const isAggressive = aiObj.style ? aiObj.style.toUpperCase() === 'AGGRESSIVE' : false;
    const winRate = parseInt(aiObj.win_rate) || 0;
    let signalToEmail = null;

    if (targetDir === currentPosition) return; 

    if (targetDir === 'WAIT') {
        if (currentPosition !== null) { signalToEmail = `【平仓警报】行情转震荡，请立即平仓！`; currentPosition = null; }
        else return;
    } else {
        if (isAggressive && winRate < 70) return;
        let actionStr = targetDir === 'LONG' ? "做多" : "做空";
        let styleStr = isAggressive ? "激进" : "稳健";
        
        if (currentPosition === null) signalToEmail = `【建仓指令】${styleStr}${actionStr}`;
        else signalToEmail = `【紧急反手】请平掉原仓位，反向${styleStr}${actionStr}`;
        
        currentPosition = targetDir; 
        await addTradeLog(actionStr, styleStr, lastPrice); // 写入云端
    }

    let emailBody = `<b>【操作逻辑】</b><br>${aiObj.reason}<br><br>`;
    if (targetDir !== 'WAIT') {
        emailBody += `<b>【风控点位】</b><br>🛑 止损 (SL): ${aiObj.sl}<br>🎯 止盈 1 (TP1): ${aiObj.tp1}<br>🎯 止盈 2 (TP2): ${aiObj.tp2}<br>📊 预计胜率: ${winRate}%`;
    }
    if (signalToEmail) await sendSignalEmail(signalToEmail, emailBody, lastPrice);
    
  } catch (e) { console.error("循环报错:", e.message); }
}

// --- 🌐 Web 可视化控制台 ---
http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); 
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.url === '/status') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ status: "alive", position: currentPosition, price: lastPrice, enabled: true }));
      return;
  }

  if (req.url === '/api/close' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', async () => {
          const { id, exitPrice } = JSON.parse(body);
          const logs = await loadLogs(); // 云端读取
          const trade = logs.find(t => t.id === id);
          if (trade) {
              trade.exitPrice = parseFloat(exitPrice);
              trade.exitTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
              const mins = Math.round((Date.now() - trade.entryTimestamp) / 60000);
              trade.holdTime = `${Math.floor(mins / 60)}小时${mins % 60}分钟`;
              let roi = 0;
              if (trade.action === '做多') roi = ((trade.exitPrice - trade.entryPrice) / trade.entryPrice) * 100;
              if (trade.action === '做空') roi = ((trade.entryPrice - trade.exitPrice) / trade.entryPrice) * 100;
              trade.roi = roi.toFixed(2);
              trade.status = 'CLOSED';
              await saveLogs(logs); // 存回云端
              res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify({success: true}));
          } else { res.writeHead(400, {'Content-Type': 'application/json'}); res.end(JSON.stringify({error: "Trade not found"})); }
      }); return;
  }
  if (req.url === '/api/logs') {
      const logs = await loadLogs(); // 云端读取
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(logs.reverse())); return;
  }
  res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
  res.end("API Server is running.");
}).listen(process.env.PORT || 3000);

// --- 启动自检 ---
async function startApp() {
    console.log("🚀 系统启动，云端永久记忆数据库挂载完成！");
    setInterval(runMonitor, CHECK_INTERVAL_MS);
    runMonitor();
}

startApp();
