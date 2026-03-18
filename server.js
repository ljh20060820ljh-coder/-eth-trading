const https = require('https');
const http = require('http');

const EMAILJS_SERVICE_ID = "service_op2rg49"; 
const EMAILJS_TEMPLATE_ID = "template_eftwoy6"; 
const EMAILJS_PUBLIC_KEY = "tIZB9DwwpEKr3KQpQ"; 
const NOTIFY_EMAIL = "2183089849@qq.com";
const KV_REST_API_URL = "https://exact-sparrow-75815.upstash.io"; 

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const TIMEFRAMES = ["5m", "15m", "1h", "4h"]; 
const CHECK_INTERVAL_MS = 5 * 60 * 1000; 
const ALERT_CHECK_INTERVAL = 10 * 1000; 

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY; 
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;
const SERVERCHAN_SENDKEY = process.env.SERVERCHAN_SENDKEY; 

let positions = {}; 
SYMBOLS.forEach(sym => TIMEFRAMES.forEach(tf => positions[`${sym}_${tf}`] = null));
let lastPrices = { BTCUSDT: null, ETHUSDT: null, SOLUSDT: null };
let cachedNews = []; 
let isMonitoringActive = true; 
let inMemoryDB = { trade_logs: [], price_alerts: [] };

console.log("🛠️ 演习模式：正在启动强行触发测试...");

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
    https.get(url, { headers: { 'User-Agent': 'Crypto-Monitor/15.0', ...extraHeaders } }, (res) => {
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

async function loadData(key) { return inMemoryDB[key] || []; }
async function saveData(key, data) { inMemoryDB[key] = data; }

async function addTradeLog(symbol, timeframe, action, style, entryPrice) { 
    const logs = await loadData('trade_logs'); 
    logs.push({ id: Date.now().toString(), symbol, timeframe, entryTime: new Date().toLocaleString(), action, style, entryPrice, status: 'OPEN' });
    await saveData('trade_logs', logs);
}

// 🔥 演习专用：强行拦截并返回假信号
async function askAIBatchDecisions(batchData) {
  console.log("📢 触发演习指令：正在强行发送模拟做多信号...");
  return [
    { 
      "symbol": "ETHUSDT", 
      "timeframe": "15m", 
      "direction": "LONG", 
      "style": "STEADY", 
      "win_rate": 99, 
      "sl": 3000, 
      "tp1": 3200, 
      "tp2": 3300, 
      "reason": "【实弹演习】测试信号！如果您收到这条，说明推送通道已 100% 畅通！" 
    }
  ];
}

async function runMonitor() {
  if (!isMonitoringActive) return;
  // 演习模式下，只要能获取到价格就触发信号逻辑
  try {
    const data = await fetchJSON(`https://api.binance.us/api/v3/ticker/price?symbol=ETHUSDT`);
    lastPrices["ETHUSDT"] = parseFloat(data.price);
    const aiResults = await askAIBatchDecisions([{symbol: "ETHUSDT"}]);
    
    for (const aiObj of aiResults) {
        await sendSignalEmail(`🎯 演习指令: ${aiObj.direction}`, aiObj.reason, lastPrices["ETHUSDT"], aiObj.timeframe, aiObj.symbol);
        await sendWeChatPush(`演习信号: ${aiObj.symbol}`, `方向: ${aiObj.direction}\n逻辑: ${aiObj.reason}`);
        console.log("✅ 演习信号已发出！请检查手机！");
    }
  } catch (e) { console.log("演习失败，请检查网络:", e.message); }
}

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.writeHead(200); res.end("Testing Mode Running...");
}).listen(process.env.PORT || 3000);

// 启动即触发
runMonitor();
