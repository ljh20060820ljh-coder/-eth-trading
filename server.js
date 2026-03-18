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
const ALERT_CHECK_INTERVAL = 10 * 1000; // 🔥 报警巡逻间隔：10秒

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY; 
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;
const SERVERCHAN_SENDKEY = process.env.SERVERCHAN_SENDKEY; 

let positions = {}; 
SYMBOLS.forEach(sym => TIMEFRAMES.forEach(tf => positions[`${sym}_${tf}`] = null));
let lastPrices = { BTCUSDT: null, ETHUSDT: null, SOLUSDT: null };
let cachedNews = []; 
let isMonitoringActive = true; 

// 🔥 纯单机内存模式
let inMemoryDB = { trade_logs: [], price_alerts: [] };

console.log("🚀 量化 AI (DeepSeek 完整报警版) 已上线...");

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
    https.get(url, { headers: { 'User-Agent': 'Crypto-Monitor/14.2', ...extraHeaders } }, (res) => {
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

async function addTradeLog(symbol, timeframe, action, style, entryPrice) { const logs = await loadData('trade_logs'); logs.push({ id: Date.now().toString(), symbol: symbol, timeframe: timeframe, entryTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }), entryTimestamp: Date.now(), action: action, style: style, entryPrice: entryPrice, exitPrice: null, exitTime: null, holdTime: null, roi: null, status: 'OPEN' }); await saveData('trade_logs', logs); }

function calcMA(data, period) { if (data.length < period) return 0; return data.slice(-period).reduce((sum, c) => sum + c.close, 0) / period; }
function calcRSI(data, period = 14) { if (data.length < period + 1) return 50; let gains = 0, losses = 0; for (let i = data.length - period; i < data.length; i++) { const diff = data[i].close - data[i-1].close; if (diff > 0) gains += diff; else losses -= diff; } const avgLoss = losses / period; if (avgLoss === 0) return 100; return 100 - (100 / (1 + (gains / period) / avgLoss)); }
function calcATR(data, period = 14) { if (data.length < period + 1) return 0; let sumTR = 0; for (let i = data.length - period; i < data.length; i++) { const high = data[i].high, low = data[i].low, prevClose = data[i-1].close; sumTR += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)); } return sumTR / period; }

async function fetchAndAnalyzeNews() {
    if (!DEEPSEEK_API_KEY) return;
    try {
        const res = await fetchJSON('https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fcointelegraph.com%2Frss');
        if (!res || !res.items) return;
        const topNews = res.items.slice(0, 6);
        const prompt = `你是一名加密货币华尔街分析师。翻译以下新闻并分析【利好】或【利空】，附带概率。严格返回 JSON 数组格式：[{"date":"03-18 15:30", "title":"中文标题", "sentiment":"利好 80%", "type":"bull"}]
1. date：转为北京时间(MM-DD HH:mm)。2. type："bull", "bear", "neutral"。
英文新闻：\n${topNews.map(n => n.pubDate + ' | ' + n.title).join('\n')}`;

        const aiRes = await postJSON("https://api.deepseek.com/chat/completions", {
            model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.3 
        }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
        
        let jsonStr = aiRes.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json/gi, '').replace(/```/g, '').trim();
        cachedNews = JSON.parse(jsonStr).map((item, i) => ({ ...item, link: topNews[i].link }));
    } catch(e) {}
}

async function askAIBatchDecisions(batchData) {
  if (!DEEPSEEK_API_KEY || batchData.length === 0) return [];
  const prompt = `你是顶级量化模型。请一次性分析以下 ${batchData.length} 组加密货币数据。
数据：${JSON.stringify(batchData)}
【战术】: 极速偏离超1.5倍ATR给 "AGGRESSIVE"，否则给 "STEADY" 或 "WAIT"。
严格返回 JSON 数组：[{"symbol": "BTCUSDT", "timeframe": "15m", "direction": "WAIT", "style": "STEADY", "win_rate": 0, "sl": 0, "tp1": 0, "tp2": 0, "reason": "理由简述"}]`;

  try {
    const res = await postJSON("https://api.deepseek.com/chat/completions", {
        model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.2 
    }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
    let jsonStr = res.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(jsonStr);
  } catch (e) { return []; }
}

// 🔥 核心修复：加回每 10 秒巡逻一次的报警引擎！
async function runAlertEngine() {
    try {
        const alerts = await loadData('price_alerts'); 
        if (!alerts || alerts.length === 0) return;
        
        const res = await fetchJSON('https://api.binance.us/api/v3/ticker/price'); 
        if (!Array.isArray(res)) return;
        const priceMap = {}; res.forEach(item => priceMap[item.symbol] = parseFloat(item.price));
        
        let triggered = false; 
        const remainingAlerts = [];
        
        for (const alert of alerts) {
            const currentPrice = priceMap[alert.symbol] || priceMap["ETHUSDT"];
            if (!currentPrice) { remainingAlerts.push(alert); continue; }
            
            if ((alert.dir === 'above' && currentPrice >= alert.price) || (alert.dir === 'below' && currentPrice <= alert.price)) {
                const title = `🚨 【价格提醒】触发！`; 
                const desp = `**币种**: ${alert.symbol || 'ETHUSDT'}\n**当前价格**: ${currentPrice}\n**您的预设**: 价格已${alert.dir === 'above' ? '涨破' : '跌破'} ${alert.price}`;
                
                console.log(`🚨 报警已触发: ${alert.symbol} 到达 ${currentPrice}`);
                await sendWeChatPush(title, desp); 
                await sendSignalEmail("🚨 价格报警", desp.replace(/\n/g, '<br>'), currentPrice, "实时报警", alert.symbol || 'ETHUSDT');
                triggered = true;
            } else {
                remainingAlerts.push(alert);
            }
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
            if (!Array.isArray(data)) continue;
            const candles = data.map(d => ({ open: +d[1], high: +d[2], low: +d[3], close: +d[4] }));
            const livePrice = candles[candles.length - 1].close;
            lastPrices[symbol] = livePrice;
            const confirmedCandles = candles.slice(0, -1); 
            const lastClosed = confirmedCandles[confirmedCandles.length - 1];
            const ma5 = calcMA(confirmedCandles, 5), ma10 = calcMA(confirmedCandles, 10), ma20 = calcMA(confirmedCandles, 20);
            const rsi = calcRSI(confirmedCandles, 14), atr = calcATR(confirmedCandles, 14); 
            const posKey = `${symbol}_${timeframe}`;
            const currentPos = positions[posKey] === 'LONG' ? '多单' : positions[posKey] === 'SHORT' ? '空单' : '空仓';
            const priceDev = livePrice - lastClosed.close;
            const atrThreshold = atr * 1.5;
            const surgeAlert = Math.abs(priceDev) > atrThreshold ? `🚨极速偏离超 1.5倍 ATR` : `正常波动`;

            batchData.push({ symbol, timeframe, livePrice, lastClosedPrice: lastClosed.close, ma5, ma10, ma20, rsi, atr, currentPos, surgeAlert });
          } catch (e) {}
      }
  }

  if (batchData.length > 0) {
      const aiResults = await askAIBatchDecisions(batchData);
      for (const aiObj of aiResults) {
          if (!aiObj || !aiObj.symbol) continue;
          const posKey = `${aiObj.symbol}_${aiObj.timeframe}`;
          const targetDir = aiObj.direction ? aiObj.direction.toUpperCase() : 'WAIT';
          const isAggressive = aiObj.style ? aiObj.style.toUpperCase() === 'AGGRESSIVE' : false;
          const winRate = parseInt(aiObj.win_rate) || 0;
          const price = lastPrices[aiObj.symbol];

          if (targetDir === positions[posKey]) continue; 
          let signalTitle = null; let actionStr = targetDir === 'LONG' ? "做多" : "做空"; let styleStr = isAggressive ? "激进" : "稳健";

          if (targetDir === 'WAIT') {
              if (positions[posKey] !== null) { signalTitle = `【平仓警报】`; positions[posKey] = null; } else continue;
          } else {
              if (isAggressive && winRate < 60) continue; 
              if (positions[posKey] === null) signalTitle = `【DeepSeek 指令】${styleStr}${actionStr}`; 
              else signalTitle = `【DeepSeek 反手】${styleStr}${actionStr}`;
              positions[posKey] = targetDir; 
              await addTradeLog(aiObj.symbol, aiObj.timeframe, actionStr, styleStr, price); 
          }

          let emailBody = `<b>【操作逻辑】(${aiObj.timeframe}级别)</b><br>${aiObj.reason}<br><br>`;
          let wechatText = `分析周期: ${aiObj.timeframe}\n币种: ${aiObj.symbol}\n价格: ${price}\n逻辑: ${aiObj.reason}\n`;
          if (targetDir !== 'WAIT') {
              emailBody += `<b>【风控点位】</b><br>🛑 止损: ${aiObj.sl}<br>🎯 TP1: ${aiObj.tp1}<br>🎯 TP2: ${aiObj.tp2}<br>📊 胜率: ${winRate}%`;
              wechatText += `\n🛑 止损: ${aiObj.sl}\n🎯 止盈: ${aiObj.tp1} / ${aiObj.tp2}\n📊 预计胜率: ${winRate}%`;
          }
          if (signalTitle) {
              await sendSignalEmail(`${signalTitle} [${aiObj.timeframe}]`, emailBody, price, `${aiObj.timeframe} K线`, aiObj.symbol);
              await sendWeChatPush(`${signalTitle} ${aiObj.symbol}(${aiObj.timeframe})`, wechatText);
          }
      }
  }
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  if (req.url === '/status') { res.writeHead(200); res.end(JSON.stringify({ status: "alive", isMonitoringActive })); return; }
  if (req.url === '/api/toggle-monitor' && req.method === 'POST') { isMonitoringActive = !isMonitoringActive; res.writeHead(200); res.end(JSON.stringify({ success: true, isMonitoringActive })); return; }
  if (req.url === '/api/news' && req.method === 'GET') { res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify(cachedNews)); return; }

  // 🧪 测试大喇叭是否畅通的专用接口
  if (req.url === '/api/test-signal') {
      sendWeChatPush("【测试通知】", "微信推送功能正常！");
      sendSignalEmail("🔔 邮件测试", "恭喜你，邮件推送功能配置正确，通信顺畅！", 0, "测试", "系统");
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); res.end("<h2 style='color:green;text-align:center'>✅ 信号已发送！请检查微信和邮箱！</h2>"); return;
  }
  if (req.url === '/api/close' && req.method === 'POST') {
      let body = ''; req.on('data', c => body += c.toString());
      req.on('end', async () => {
          const { id, exitPrice } = JSON.parse(body); const logs = await loadData('trade_logs'); const trade = logs.find(t => t.id === id);
          if (trade) {
              trade.exitPrice = parseFloat(exitPrice); trade.status = 'CLOSED';
              trade.roi = (trade.action === '做多' ? ((trade.exitPrice - trade.entryPrice) / trade.entryPrice) * 100 : ((trade.entryPrice - trade.exitPrice) / trade.entryPrice) * 100).toFixed(2);
              await saveData('trade_logs', logs); res.writeHead(200); res.end(JSON.stringify({success: true}));
          } else { res.writeHead(400); res.end(); }
      }); return;
  }
  if (req.url === '/api/logs') { const logs = await loadData('trade_logs'); res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify(logs.reverse())); return; }
  if (req.url === '/api/alerts' && req.method === 'GET') { const alerts = await loadData('price_alerts'); res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify(alerts)); return; }
  if (req.url === '/api/alerts' && req.method === 'POST') {
      let body = ''; req.on('data', c => body += c.toString());
      req.on('end', async () => {
          const newAlert = JSON.parse(body); const alerts = await loadData('price_alerts');
          alerts.push({ id: Date.now().toString(), symbol: newAlert.symbol || 'ETHUSDT', price: newAlert.price, dir: newAlert.dir });
          await saveData('price_alerts', alerts); res.writeHead(200); res.end(JSON.stringify({success: true}));
      }); return;
  }
  if (req.url === '/api/alerts' && req.method === 'DELETE') {
      let body = ''; req.on('data', c => body += c.toString());
      req.on('end', async () => {
          const { id } = JSON.parse(body); let alerts = await loadData('price_alerts'); alerts = alerts.filter(a => a.id !== id);
          await saveData('price_alerts', alerts); res.writeHead(200); res.end(JSON.stringify({success: true}));
      }); return;
  }
  res.writeHead(200); res.end("API is running");
}).listen(process.env.PORT || 3000);

async function startApp() {
    console.log("🚀 启动！DeepSeek 批处理引擎准备就绪！");
    fetchAndAnalyzeNews(); 
    setInterval(fetchAndAnalyzeNews, 30 * 60 * 1000); 
    setInterval(runMonitor, CHECK_INTERVAL_MS); 
    setInterval(runAlertEngine, ALERT_CHECK_INTERVAL); // 🔥 启动报警巡逻！
    runMonitor();
}
startApp();
