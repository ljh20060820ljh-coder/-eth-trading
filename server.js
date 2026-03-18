const https = require('https');
const http = require('http');
const fs = require('fs');

// ==========================================
// 🔐 终极配置 (多币种 + 微信推送)
// ==========================================
const EMAILJS_SERVICE_ID = "service_op2rg49"; 
const EMAILJS_TEMPLATE_ID = "template_eftwoy6"; 
const EMAILJS_PUBLIC_KEY = "tIZB9DwwpEKr3KQpQ"; 
const NOTIFY_EMAIL = "2183089849@qq.com";
const KV_REST_API_URL = "https://exact-sparrow-75815.upstash.io"; 

// 💎 钻石级强化：多币种雷达阵列
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const CHECK_INTERVAL_MS = 5 * 60 * 1000; 

// 🚨 环境变量密码
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY; 
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;
const SERVERCHAN_SENDKEY = process.env.SERVERCHAN_SENDKEY; // 新增：微信推送Key

// 仓位记忆升级为对象，分别记忆三个币种
let positions = { BTCUSDT: null, ETHUSDT: null, SOLUSDT: null }; 
let lastPrices = { BTCUSDT: null, ETHUSDT: null, SOLUSDT: null };
let reflectedToday = false; 

console.log("🚀 量化 AI (多币种雷达 + 微信秒推 + 资金曲线版) 已上线...");

function postJSON(url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = { hostname: urlObj.hostname, path: urlObj.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(extraHeaders||{}) } };
    const req = https.request(options, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${d}`)); else { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

function fetchJSON(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Crypto-Monitor/9.0', ...extraHeaders } }, (res) => {
      let data = ''; res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

// 🥈 白银级强化：微信推送通道
async function sendWeChatPush(title, desp) {
    if (!SERVERCHAN_SENDKEY) return;
    try {
        await postJSON(`https://sctapi.ftqq.com/${SERVERCHAN_SENDKEY}.send`, { title: title, desp: desp });
        console.log(`💬 微信推送已发出: ${title}`);
    } catch (e) { console.error("微信推送失败:", e.message); }
}

async function sendSignalEmail(action, messageHtml, price, titleStr, symbol) {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  try {
    await postJSON("https://api.emailjs.com/api/v1.0/email/send", {
      service_id: EMAILJS_SERVICE_ID, template_id: EMAILJS_TEMPLATE_ID, user_id: EMAILJS_PUBLIC_KEY, accessToken: EMAILJS_PRIVATE_KEY, 
      template_params: { to_email: NOTIFY_EMAIL, symbol: symbol, interval: titleStr || "15分钟 K线", signal: action, price: price.toString(), message: messageHtml, time: time }
    });
    console.log(`[${time}] 📧 ${symbol} 邮件已发出: ${action}`);
  } catch (e) { console.error(`[${time}] ❌ 发信失败: ${e.message}`); }
}

// 云数据库
async function loadLogs() {
  if (!KV_REST_API_URL || !KV_REST_API_TOKEN) return [];
  try {
      const res = await fetchJSON(`${KV_REST_API_URL}/get/trade_logs`, { Authorization: `Bearer ${KV_REST_API_TOKEN}` });
      if (res.result) return typeof res.result === 'string' ? JSON.parse(res.result) : res.result;
  } catch (e) { console.error("读取云数据库失败:", e.message); }
  return [];
}

async function saveLogs(logs) {
  if (!KV_REST_API_URL || !KV_REST_API_TOKEN) return;
  try { await postJSON(`${KV_REST_API_URL}/set/trade_logs`, logs, { Authorization: `Bearer ${KV_REST_API_TOKEN}` }); } catch (e) {}
}

async function addTradeLog(symbol, action, style, entryPrice) {
  const logs = await loadLogs();
  logs.push({
    id: Date.now().toString(), symbol: symbol, entryTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    entryTimestamp: Date.now(), action: action, style: style, entryPrice: entryPrice,
    exitPrice: null, exitTime: null, holdTime: null, roi: null, status: 'OPEN'
  });
  await saveLogs(logs);
}

// 指标计算
function calcMA(data, period) { if (data.length < period) return 0; return data.slice(-period).reduce((sum, c) => sum + c.close, 0) / period; }
function calcRSI(data, period = 14) {
  if (data.length < period + 1) return 50; let gains = 0, losses = 0;
  for (let i = data.length - period; i < data.length; i++) { const diff = data[i].close - data[i-1].close; if (diff > 0) gains += diff; else losses -= diff; }
  const avgLoss = losses / period; if (avgLoss === 0) return 100; return 100 - (100 / (1 + (gains / period) / avgLoss));
}
function calcATR(data, period = 14) {
  if (data.length < period + 1) return 0; let sumTR = 0;
  for (let i = data.length - period; i < data.length; i++) {
    const high = data[i].high, low = data[i].low, prevClose = data[i-1].close;
    sumTR += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  return sumTR / period;
}

// AI 分析
async function askAIForDecision(symbol, confirmedCandles, livePrice, currentPos) {
  if (!DEEPSEEK_API_KEY) return null;
  const lastClosed = confirmedCandles[confirmedCandles.length - 1];
  const prevClosed = confirmedCandles[confirmedCandles.length - 2];
  const ma5 = calcMA(confirmedCandles, 5), ma10 = calcMA(confirmedCandles, 10), ma20 = calcMA(confirmedCandles, 20);
  const rsi = calcRSI(confirmedCandles, 14), atr = calcATR(confirmedCandles, 14); 
  const volSurge = lastClosed.volume > (prevClosed.volume * 1.5) ? "⚠️成交量异动" : "平稳";
  const posText = currentPos === 'LONG' ? '多单' : currentPos === 'SHORT' ? '空单' : '空仓';

  const prompt = `你是顶级量化交易模型。交易对: ${symbol}。
【已收盘定型】: MA5=${ma5.toFixed(2)}, RSI=${rsi.toFixed(1)}, ATR=${atr.toFixed(2)}, ${volSurge}。
【当前跳动价格】: ${livePrice}。当前持仓: ${posText}。
【要求】: 必须回复 JSON。
{"direction": "WAIT", "style": "STEADY", "win_rate": 0, "sl": 0, "tp1": 0, "tp2": 0, "reason": "分析逻辑"}`;

  try {
    const res = await postJSON("https://api.deepseek.com/chat/completions", {
      model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.2 
    }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
    return res.choices[0].message.content;
  } catch (e) { return null; }
}

// 每日复盘
async function dailyReflection() {
  const logs = await loadLogs(); 
  const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const todaysTrades = logs.filter(log => log.entryTime.includes(today) && log.status === 'CLOSED');
  if (todaysTrades.length === 0) return;

  let tradeSummary = todaysTrades.map(t => `${t.symbol} | 方向: ${t.action}, 风格: ${t.style}, 收益率: ${t.roi}%`).join('\n');
  const prompt = `你是一个交易员。今日战绩：\n${tradeSummary}\n请进行【深夜复盘】：1.总结多币种表现 2.分析对错 3.明日策略。`;

  try {
    const res = await postJSON("https://api.deepseek.com/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.7 }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
    const content = res.choices[0].message.content;
    await sendSignalEmail("【AI 每日深度复盘报告】", content.replace(/\n/g, '<br>'), "今日结算", "日记簿", "全量化阵列");
    await sendWeChatPush("📈 AI 深夜复盘已生成", content); // 微信推复盘
  } catch (e) {}
}

// 监控主循环 (多币种轮询)
async function runMonitor() {
  const time = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const nowHour = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false });
  const nowMin = new Date().getMinutes();

  if (nowHour === '23' && nowMin >= 50 && !reflectedToday) { await dailyReflection(); reflectedToday = true; }
  if (nowHour === '00' && reflectedToday) reflectedToday = false;

  for (const symbol of SYMBOLS) {
      try {
        const data = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=15m&limit=30`);  
        if (!Array.isArray(data)) continue;
        const candles = data.map(d => ({ open: +d[1], high: +d[2], low: +d[3], close: +d[4], volume: +d[5] }));
        lastPrices[symbol] = candles[candles.length - 1].close;
        const confirmedCandles = candles.slice(0, -1); 

        const aiResponse = await askAIForDecision(symbol, confirmedCandles, lastPrices[symbol], positions[symbol]);
        if (!aiResponse) continue;
        
        let aiObj;
        try { aiObj = JSON.parse(aiResponse.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json/g, '').replace(/```/g, '').trim()); } 
        catch(e) { continue; }

        const targetDir = aiObj.direction ? aiObj.direction.toUpperCase() : 'WAIT';
        const isAggressive = aiObj.style ? aiObj.style.toUpperCase() === 'AGGRESSIVE' : false;
        const winRate = parseInt(aiObj.win_rate) || 0;

        if (targetDir === positions[symbol]) continue; 

        let signalTitle = null;
        let actionStr = targetDir === 'LONG' ? "做多" : "做空";
        let styleStr = isAggressive ? "激进" : "稳健";

        if (targetDir === 'WAIT') {
            if (positions[symbol] !== null) { signalTitle = `【平仓警报】`; positions[symbol] = null; }
            else continue;
        } else {
            if (isAggressive && winRate < 70) continue;
            if (positions[symbol] === null) signalTitle = `【建仓指令】${styleStr}${actionStr}`;
            else signalTitle = `【紧急反手】${styleStr}${actionStr}`;
            
            positions[symbol] = targetDir; 
            await addTradeLog(symbol, actionStr, styleStr, lastPrices[symbol]); 
        }

        let emailBody = `<b>【操作逻辑】</b><br>${aiObj.reason}<br><br>`;
        let wechatText = `币种: ${symbol}\n价格: ${lastPrices[symbol]}\n分析逻辑: ${aiObj.reason}\n`;

        if (targetDir !== 'WAIT') {
            emailBody += `<b>【风控点位】</b><br>🛑 止损: ${aiObj.sl}<br>🎯 TP1: ${aiObj.tp1}<br>🎯 TP2: ${aiObj.tp2}<br>📊 胜率: ${winRate}%`;
            wechatText += `\n🛑 止损: ${aiObj.sl}\n🎯 止盈: ${aiObj.tp1} / ${aiObj.tp2}\n📊 预计胜率: ${winRate}%`;
        }

        if (signalTitle) {
            await sendSignalEmail(signalTitle, emailBody, lastPrices[symbol], "15分钟", symbol);
            await sendWeChatPush(`${signalTitle} ${symbol}`, wechatText); // 微信推送！
        }
        
      } catch (e) { console.error(`[${symbol}] 报错:`, e.message); }
      
      // 防止 API 频率限制，每看一个币休息 2 秒
      await new Promise(resolve => setTimeout(resolve, 2000)); 
  }
}

// Web 控制台
http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); 
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.url === '/status') { res.writeHead(200); res.end(JSON.stringify({ status: "alive" })); return; }

  if (req.url === '/api/close' && req.method === 'POST') {
      let body = ''; req.on('data', c => body += c.toString());
      req.on('end', async () => {
          const { id, exitPrice } = JSON.parse(body);
          const logs = await loadLogs();
          const trade = logs.find(t => t.id === id);
          if (trade) {
              trade.exitPrice = parseFloat(exitPrice);
              trade.exitTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
              trade.holdTime = `${Math.round((Date.now() - trade.entryTimestamp) / 60000)}分钟`;
              let roi = trade.action === '做多' ? ((trade.exitPrice - trade.entryPrice) / trade.entryPrice) * 100 : ((trade.entryPrice - trade.exitPrice) / trade.entryPrice) * 100;
              trade.roi = roi.toFixed(2); trade.status = 'CLOSED';
              await saveLogs(logs); 
              res.writeHead(200); res.end(JSON.stringify({success: true}));
          } else { res.writeHead(400); res.end(); }
      }); return;
  }
  if (req.url === '/api/logs') {
      const logs = await loadLogs(); 
      res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify(logs.reverse())); return;
  }
  res.writeHead(200); res.end("API is running");
}).listen(process.env.PORT || 3000);

async function startApp() {
    console.log("🚀 启动完成！多币种+微信推送已就绪。");
    setInterval(runMonitor, CHECK_INTERVAL_MS);
    runMonitor();
}
startApp();
