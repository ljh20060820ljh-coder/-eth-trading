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

console.log("🚀 量化 AI (DeepSeek 正常挂机版) 已上线...");

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
    https.get(url, { headers: { 'User-Agent': 'Crypto-Monitor/15.1', ...extraHeaders } }, (res) => {
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
    return []; 
}
async function saveData(key, data) { 
    if (!KV_REST_API_URL || !KV_REST_API_TOKEN) { inMemoryDB[key] = data; return; } 
    try { await postJSON(`${KV_REST_API_URL}/set/${key}`, data, { Authorization: `Bearer ${KV_REST_API_TOKEN}` }); }catch(e){} 
}

function calcMA(data, period) { if (data.length < period) return 0; return data.slice(-period).reduce((sum, c) => sum + c.close, 0) / period; }
function calcRSI(data, period = 14) { if (data.length < period + 1) return 50; let gains = 0, losses = 0; for (let i = data.length - period; i < data.length; i++) { const diff = data[i].close - data[i-1].close; if (diff > 0) gains += diff; else losses -= diff; } const avgLoss = losses / period; if (avgLoss === 0) return 100; return 100 - (100 / (1 + (gains / period) / avgLoss)); }
function calcATR(data, period = 14) { if (data.length < period + 1) return 0; let sumTR = 0; for (let i = data.length - period; i < data.length; i++) { const high = data[i].high, low = data[i].low, prevClose = data[i-1].close; sumTR += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)); } return sumTR / period; }

async function fetchAndAnalyzeNews() {
    if (!DEEPSEEK_API_KEY) return;
    try {
        const res = await fetchJSON('https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fcointelegraph.com%2Frss');
        if (!res || !res.items) return;
        const topNews = res.items.slice(0, 6);
        const prompt = `分析加密新闻利好利空并翻译。返回 JSON 数组格式。\n英文新闻：\n${topNews.map(n => n.title).join('\n')}`;
        const aiRes = await postJSON("https://api.deepseek.com/chat/completions", {
            model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.3 
        }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
        let jsonStr = aiRes.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json/gi, '').replace(/```/g, '').trim();
        cachedNews = JSON.parse(jsonStr).map((item, i) => ({ ...item, link: topNews[i].link }));
    } catch(e) { cachedNews = [{date: "实时", title: "API繁忙，正在重试新闻...", sentiment: "中性", type: "neutral", link: "#"}]; }
}

async function askAIBatchDecisions(batchData) {
  if (!DEEPSEEK_API_KEY || batchData.length === 0) return [];
  const prompt = `你是一个量化模型。分析数据并返回 JSON 数组格式决策。\n数据：${JSON.stringify(batchData)}`;
  try {
    const res = await postJSON("https://api.deepseek.com/chat/completions", {
        model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.2 
    }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
    let jsonStr = res.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(jsonStr);
  } catch (e) { return []; }
}

async function runAlertEngine() {
    try {
        const alerts = await loadData('price_alerts'); if (!alerts || alerts.length === 0) return;
        const res = await fetchJSON('https://api.binance.us/api/v3/ticker/price');
        const priceMap = {}; res.forEach(item => priceMap[item.symbol] = parseFloat(item.price));
        let triggered = false; const remainingAlerts = [];
        for (const alert of alerts) {
            const cur = priceMap[alert.symbol];
            if ((alert.dir === 'above' && cur >= alert.price) || (alert.dir === 'below' && cur <= alert.price)) {
                await sendWeChatPush(`🚨 价格提醒`, `${alert.symbol} 到达 ${cur}`);
                await sendSignalEmail("🚨 价格报警", `${alert.symbol} 触发 ${alert.price}`, cur, "实时", alert.symbol);
                triggered = true;
            } else { remainingAlerts.push(alert); }
        }
        if (triggered) await saveData('price_alerts', remainingAlerts);
    } catch(e) {}
}

async function runMonitor() {
  if (!isMonitoringActive) return;
  let batchData = [];
  for (const symbol of SYMBOLS) {
      for (const timeframe of TIMEFRAMES) {
          try {
            const data = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${timeframe}&limit=30`);
            const candles = data.map(d => ({ close: +d[4] }));
            lastPrices[symbol] = candles[candles.length - 1].close;
            const ma5 = calcMA(candles, 5), ma10 = calcMA(candles, 10), rsi = calcRSI(candles, 14);
            batchData.push({ symbol, timeframe, price: lastPrices[symbol], ma5, ma10, rsi });
          } catch (e) {}
      }
  }
  if (batchData.length > 0) {
      const results = await askAIBatchDecisions(batchData);
      for (const res of results) {
          const key = `${res.symbol}_${res.timeframe}`;
          if (res.direction.toUpperCase() === positions[key]) continue;
          if (res.direction.toUpperCase() !== 'WAIT' && res.win_rate >= 60) {
              positions[key] = res.direction.toUpperCase();
              await sendSignalEmail(`🎯 AI: ${res.direction}`, res.reason, lastPrices[res.symbol], res.timeframe, res.symbol);
              await sendWeChatPush(`AI 信号`, `${res.symbol} ${res.direction}`);
          }
      }
  }
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/status') { res.end(JSON.stringify({ status: "alive", isMonitoringActive })); return; }
  if (req.url === '/api/news') { res.end(JSON.stringify(cachedNews)); return; }
  if (req.url === '/api/toggle-monitor' && req.method === 'POST') { isMonitoringActive = !isMonitoringActive; res.end(JSON.stringify({success:true})); return; }
  res.end("Running");
}).listen(process.env.PORT || 3000);

setInterval(fetchAndAnalyzeNews, 30 * 60 * 1000); 
setInterval(runMonitor, CHECK_INTERVAL_MS); 
setInterval(runAlertEngine, ALERT_CHECK_INTERVAL);
fetchAndAnalyzeNews(); runMonitor();
