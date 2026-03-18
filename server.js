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
const LOG_FILE = './trade_log.json'; 

let currentPosition = null; 
let lastPrice = null;
let reflectedToday = false; 

console.log("🚀 ETH 顶级量化 AI (已剥离未来函数 + CORS) 已上线...");

// --- 日志读写系统 ---
function loadLogs() {
  if (fs.existsSync(LOG_FILE)) return JSON.parse(fs.readFileSync(LOG_FILE));
  return [];
}
function saveLogs(logs) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}
function addTradeLog(action, style, entryPrice) {
  const logs = loadLogs();
  logs.push({
    id: Date.now().toString(),
    entryTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    entryTimestamp: Date.now(),
    action: action,   
    style: style,     
    entryPrice: entryPrice,
    exitPrice: null,
    exitTime: null,
    holdTime: null,
    roi: null,
    status: 'OPEN'
  });
  saveLogs(logs);
}

// --- 网络请求 ---
function postJSON(url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname, path: urlObj.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(extraHeaders||{}) }
    };
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(options, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${d}`));
        else { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } }
      });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ETH-Monitor/6.0' } }, (res) => {
      let data = ''; res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
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
      template_params: { 
        to_email: NOTIFY_EMAIL, symbol: SYMBOL, interval: titleStr || "15分钟 K线", 
        signal: action, price: price.toString(), message: messageHtml, time: time 
      }
    });
    console.log(`[${time}] 📧 邮件已发出: ${action}`);
  } catch (e) { console.error(`[${time}] ❌ 发信失败: ${e.message}`); }
}

// --- 🧠 AI JSON 策略大脑 (无未来函数版) ---
async function askAIForDecision(confirmedCandles, livePrice, currentPos) {
  // ⚠️ 核心修复：只看已经收盘的确定的 K 线
  const lastClosed = confirmedCandles[confirmedCandles.length - 1];
  const prevClosed = confirmedCandles[confirmedCandles.length - 2];
  
  const ma5 = calcMA(confirmedCandles, 5);
  const ma10 = calcMA(confirmedCandles, 10);
  const ma20 = calcMA(confirmedCandles, 20);
  const rsi = calcRSI(confirmedCandles, 14);
  const atr = calcATR(confirmedCandles, 14); 
  
  const volSurge = lastClosed.volume > (prevClosed.volume * 1.5) ? "⚠️上一根K线成交量异常放大" : "成交量平稳";
  const posText = currentPos === 'LONG' ? '多单' : currentPos === 'SHORT' ? '空单' : '空仓';

  // 告诉 AI 什么是“已收盘”，什么是“当前跳动”
  const prompt = `你是一个顶级量化交易模型。

【已收盘定型的技术面】(基于上一个15分钟完整K线)：
- 均线状态: MA5=${ma5.toFixed(2)}, MA10=${ma10.toFixed(2)}, MA20=${ma20.toFixed(2)}
- 相对强弱 RSI(14): ${rsi.toFixed(1)}
- 真实波动率 ATR(14): ${atr.toFixed(2)}
- 资金动向: ${volSurge} (收盘价: ${lastClosed.close}, 最高: ${lastClosed.high}, 最低: ${lastClosed.low})

【当前盘口异动】(实时秒级数据)：
- 实时现价: ${livePrice}
- 当前持仓状态: ${posText}

【任务】：结合坚固的收盘指标和当前的盘口价格，判断是否突破或跌破。
【强制要求】：你必须且只能回复一个合法的 JSON 对象，不要输出任何其他解释文字！格式严格如下：
{
  "direction": "WAIT", // 只能填 LONG(做多), SHORT(做空), 或 WAIT(观望)
  "style": "STEADY", // 只能填 STEADY(稳健), 或 AGGRESSIVE(激进)
  "win_rate": 0, // 0 到 100 的纯数字
  "sl": 0, // 止损价 (若为WAIT填0)
  "tp1": 0, // 第一止盈价 
  "tp2": 0, // 第二止盈价 
  "reason": "写出你的详细分析逻辑"
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
  const logs = loadLogs();
  const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const todaysTrades = logs.filter(log => log.entryTime.includes(today) && log.status === 'CLOSED');
  
  if (todaysTrades.length === 0) return;

  let tradeSummary = todaysTrades.map(t => 
      `方向: ${t.action}, 风格: ${t.style}, 入场: ${t.entryPrice}, 出场: ${t.exitPrice}, 收益率: ${t.roi}%, 时长: ${t.holdTime}`
  ).join('\n');

  const prompt = `你是一个不断进化的交易员。今日交易记录：\n${tradeSummary}\n请进行【深夜复盘】：1.总结表现 2.分析盈利单 3.反思亏损单 4.明日策略。`;

  try {
    console.log("🧠 正在进行每日深夜复盘...");
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
    // 拉取 30 根 K 线
    const data = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${SYMBOL}&interval=15m&limit=30`);  
    if (!Array.isArray(data)) return;
    
    const candles = data.map(d => ({ open: +d[1], high: +d[2], low: +d[3], close: +d[4], volume: +d[5] }));
    
    // ⚠️ 终极剥离：提取当前实时价格，并将尚未走完的最后一根K线剔除！
    lastPrice = candles[candles.length - 1].close;
    const confirmedCandles = candles.slice(0, -1); // 丢弃最后一根，保留前面 29 根确定的

    // 传入确定的历史和当前跳动的价格
    const aiResponse = await askAIForDecision(confirmedCandles, lastPrice, currentPosition);
    if (!aiResponse) return;
    
    let aiObj;
    try {
        const cleanStr = aiResponse.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json/g, '').replace(/```/g, '').trim();
        aiObj = JSON.parse(cleanStr);
    } catch(e) {
        console.error(`[${time}] ❌ AI 格式异常，已拦截跳过.`);
        return;
    }

    const targetDir = aiObj.direction ? aiObj.direction.toUpperCase() : 'WAIT';
    const isAggressive = aiObj.style ? aiObj.style.toUpperCase() === 'AGGRESSIVE' : false;
    const winRate = parseInt(aiObj.win_rate) || 0;

    let signalToEmail = null;

    if (targetDir === currentPosition) return; 

    if (targetDir === 'WAIT') {
        if (currentPosition !== null) {
            signalToEmail = `【平仓警报】行情转震荡，请立即平仓！`;
            currentPosition = null; 
        } else return;
    } else {
        if (isAggressive && winRate < 70) return;
        
        let actionStr = targetDir === 'LONG' ? "做多" : "做空";
        let styleStr = isAggressive ? "激进" : "稳健";
        
        if (currentPosition === null) signalToEmail = `【建仓指令】${styleStr}${actionStr}`;
        else signalToEmail = `【紧急反手】请平掉原仓位，反向${styleStr}${actionStr}`;
        
        currentPosition = targetDir; 
        addTradeLog(actionStr, styleStr, lastPrice);
    }

    let emailBody = `<b>【操作逻辑】</b><br>${aiObj.reason}<br><br>`;
    if (targetDir !== 'WAIT') {
        emailBody += `<b>【风控点位】</b><br>`;
        emailBody += `🛑 止损 (SL): ${aiObj.sl}<br>`;
        emailBody += `🎯 止盈 1 (TP1): ${aiObj.tp1}<br>`;
        emailBody += `🎯 止盈 2 (TP2): ${aiObj.tp2}<br>`;
        emailBody += `📊 预计胜率: ${winRate}%`;
    }

    if (signalToEmail) await sendSignalEmail(signalToEmail, emailBody, lastPrice);
    
  } catch (e) { console.error("循环报错:", e.message); }
}

// --- 🌐 Web 可视化控制台 (已开启 CORS 跨域) ---
http.createServer((req, res) => {
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
      req.on('end', () => {
          const { id, exitPrice } = JSON.parse(body);
          const logs = loadLogs();
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
              saveLogs(logs);
              res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify({success: true}));
          } else { res.writeHead(400, {'Content-Type': 'application/json'}); res.end(JSON.stringify({error: "Trade not found"})); }
      }); return;
  }
  if (req.url === '/api/logs') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(loadLogs().reverse())); return;
  }
  res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
  res.end("API Server is running.");
}).listen(process.env.PORT || 3000);

// --- 启动自检 ---
async function startApp() {
    console.log("🚀 系统启动完成，未来函数已剥离。");
    setInterval(runMonitor, CHECK_INTERVAL_MS);
    runMonitor();
}

startApp();
