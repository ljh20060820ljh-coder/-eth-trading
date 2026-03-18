const https = require('https');
const http = require('http');

// ==========================================
// 🔐 终极配置 (多币种 + 波动率突破特种兵 + 测试后门)
// ==========================================
const EMAILJS_SERVICE_ID = "service_op2rg49"; 
const EMAILJS_TEMPLATE_ID = "template_eftwoy6"; 
const EMAILJS_PUBLIC_KEY = "tIZB9DwwpEKr3KQpQ"; 
const NOTIFY_EMAIL = "2183089849@qq.com";
const KV_REST_API_URL = "https://exact-sparrow-75815.upstash.io"; 

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
// 🔥 加入 5m 级别高频照妖镜
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
let reflectedToday = false; 

console.log("🚀 量化 AI (特种兵突破矩阵 + 全天候警报 + 测试通道) 已上线...");

// --- 网络请求核心 ---
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
    https.get(url, { headers: { 'User-Agent': 'Crypto-Monitor/11.0', ...extraHeaders } }, (res) => {
      let data = ''; res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

// --- 推送与数据存取 (简写版) ---
async function sendWeChatPush(title, desp) { if(SERVERCHAN_SENDKEY) try { await postJSON(`https://sctapi.ftqq.com/${SERVERCHAN_SENDKEY}.send`, { title, desp }); }catch(e){} }
async function sendSignalEmail(action, messageHtml, price, titleStr, symbol) {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  try { await postJSON("https://api.emailjs.com/api/v1.0/email/send", { service_id: EMAILJS_SERVICE_ID, template_id: EMAILJS_TEMPLATE_ID, user_id: EMAILJS_PUBLIC_KEY, accessToken: EMAILJS_PRIVATE_KEY, template_params: { to_email: NOTIFY_EMAIL, symbol: symbol, interval: titleStr, signal: action, price: price.toString(), message: messageHtml, time: time }}); } catch (e) {}
}
async function loadData(key) { if (!KV_REST_API_URL||!KV_REST_API_TOKEN) return []; try { const res = await fetchJSON(`${KV_REST_API_URL}/get/${key}`, { Authorization: `Bearer ${KV_REST_API_TOKEN}` }); if (res.result) return typeof res.result === 'string' ? JSON.parse(res.result) : res.result; } catch(e) {} return []; }
async function saveData(key, data) { if (KV_REST_API_URL&&KV_REST_API_TOKEN) try { await postJSON(`${KV_REST_API_URL}/set/${key}`, data, { Authorization: `Bearer ${KV_REST_API_TOKEN}` }); }catch(e){} }
async function addTradeLog(symbol, timeframe, action, style, entryPrice) { const logs = await loadData('trade_logs'); logs.push({ id: Date.now().toString(), symbol: symbol, timeframe: timeframe, entryTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }), entryTimestamp: Date.now(), action: action, style: style, entryPrice: entryPrice, exitPrice: null, exitTime: null, holdTime: null, roi: null, status: 'OPEN' }); await saveData('trade_logs', logs); }

// --- 指标计算 ---
function calcMA(data, period) { if (data.length < period) return 0; return data.slice(-period).reduce((sum, c) => sum + c.close, 0) / period; }
function calcRSI(data, period = 14) { if (data.length < period + 1) return 50; let gains = 0, losses = 0; for (let i = data.length - period; i < data.length; i++) { const diff = data[i].close - data[i-1].close; if (diff > 0) gains += diff; else losses -= diff; } const avgLoss = losses / period; if (avgLoss === 0) return 100; return 100 - (100 / (1 + (gains / period) / avgLoss)); }
function calcATR(data, period = 14) { if (data.length < period + 1) return 0; let sumTR = 0; for (let i = data.length - period; i < data.length; i++) { const high = data[i].high, low = data[i].low, prevClose = data[i-1].close; sumTR += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)); } return sumTR / period; }

// --- 🧠 核心重构：AI 大脑 (植入特种突破协议) ---
async function askAIForDecision(symbol, timeframe, confirmedCandles, livePrice, currentPos) {
  if (!DEEPSEEK_API_KEY) return null;
  const lastClosed = confirmedCandles[confirmedCandles.length - 1];
  const ma5 = calcMA(confirmedCandles, 5), ma10 = calcMA(confirmedCandles, 10), ma20 = calcMA(confirmedCandles, 20);
  const rsi = calcRSI(confirmedCandles, 14), atr = calcATR(confirmedCandles, 14); 
  const posText = currentPos === 'LONG' ? '多单' : currentPos === 'SHORT' ? '空单' : '空仓';

  // 🔥 特种雷达逻辑：计算实时偏离度
  const priceDev = livePrice - lastClosed.close;
  const atrThreshold = atr * 1.5;
  const isBreakout = Math.abs(priceDev) > atrThreshold;
  const surgeAlert = isBreakout ? 
      `🚨【极速突破警告】当前现价偏离上一根收盘价 ${priceDev.toFixed(2)}，已超过 1.5 倍 ATR波动率 (${atrThreshold.toFixed(2)})！属于剧烈单边行情！` : 
      `盘口波动正常，未超过 1.5 倍 ATR。`;

  const prompt = `你是顶级量化模型。正在分析: ${symbol} 的 ${timeframe} 级别 K线。
【上一个完整${timeframe}收盘定型】: 收盘价=${lastClosed.close}, MA5=${ma5.toFixed(2)}, RSI=${rsi.toFixed(1)}, ATR=${atr.toFixed(2)}。
【当前秒级跳动价格】: ${livePrice}。当前此周期持仓: ${posText}。
【实时异动雷达】: ${surgeAlert}
【特种作战指令】: 你是一个“稳健的激进进攻手”。如果雷达触发【极速突破警告】，这大概率是瀑布砸盘或暴涨爆拉的开端，你不必死板地等待均线死叉/金叉，可直接给出风格为 "AGGRESSIVE" (激进) 的顺势做多或做空指令，并务必设定严格止损！如果盘口波动正常，请按传统均线+RSI逻辑判断，给出 "STEADY" (稳健) 或 "WAIT" (观望)。
【要求】: 必须且只能回复 JSON。
{"direction": "WAIT", "style": "STEADY", "win_rate": 0, "sl": 0, "tp1": 0, "tp2": 0, "reason": "分析逻辑"}`;

  try {
    const res = await postJSON("https://api.deepseek.com/chat/completions", {
      model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.2 
    }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
    return res.choices[0].message.content;
  } catch (e) { return null; }
}

// --- 独立线程：网页价格提醒 ---
async function runAlertEngine() {
    try {
        const alerts = await loadData('price_alerts'); if (!alerts || alerts.length === 0) return;
        const res = await fetchJSON('https://api.binance.us/api/v3/ticker/price'); if (!Array.isArray(res)) return;
        const priceMap = {}; res.forEach(item => priceMap[item.symbol] = parseFloat(item.price));
        let triggered = false; const remainingAlerts = [];
        for (const alert of alerts) {
            const currentPrice = priceMap[alert.symbol] || priceMap["ETHUSDT"];
            if (!currentPrice) { remainingAlerts.push(alert); continue; }
            if ((alert.dir === 'above' && currentPrice >= alert.price) || (alert.dir === 'below' && currentPrice <= alert.price)) {
                const title = `🚨 【价格提醒】触发！`; const desp = `**币种**: ${alert.symbol || 'ETHUSDT'}\n**当前价格**: ${currentPrice}\n**您的预设**: 价格已${alert.dir === 'above' ? '涨破' : '跌破'} ${alert.price}`;
                await sendWeChatPush(title, desp); await sendSignalEmail(title, desp.replace(/\n/g, '<br>'), currentPrice, "实时报警", alert.symbol || 'ETHUSDT');
                triggered = true;
            } else remainingAlerts.push(alert);
        }
        if (triggered) await saveData('price_alerts', remainingAlerts);
    } catch(e) {}
}

// --- 监控主循环 ---
async function runMonitor() {
  for (const symbol of SYMBOLS) {
      for (const timeframe of TIMEFRAMES) {
          try {
            const data = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${timeframe}&limit=30`);  
            if (!Array.isArray(data)) continue;
            const candles = data.map(d => ({ open: +d[1], high: +d[2], low: +d[3], close: +d[4], volume: +d[5] }));
            lastPrices[symbol] = candles[candles.length - 1].close;
            const confirmedCandles = candles.slice(0, -1); 

            const posKey = `${symbol}_${timeframe}`;
            const aiResponse = await askAIForDecision(symbol, timeframe, confirmedCandles, lastPrices[symbol], positions[posKey]);
            if (!aiResponse) continue;
            
            let aiObj;
            try { aiObj = JSON.parse(aiResponse.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json/g, '').replace(/```/g, '').trim()); } 
            catch(e) { continue; }

            const targetDir = aiObj.direction ? aiObj.direction.toUpperCase() : 'WAIT';
            const isAggressive = aiObj.style ? aiObj.style.toUpperCase() === 'AGGRESSIVE' : false;
            const winRate = parseInt(aiObj.win_rate) || 0;

            if (targetDir === positions[posKey]) continue; 

            let signalTitle = null;
            let actionStr = targetDir === 'LONG' ? "做多" : "做空";
            let styleStr = isAggressive ? "激进" : "稳健";

            if (targetDir === 'WAIT') {
                if (positions[posKey] !== null) { signalTitle = `【平仓警报】`; positions[posKey] = null; } else continue;
            } else {
                if (isAggressive && winRate < 70) continue;
                if (positions[posKey] === null) signalTitle = `【建仓指令】${styleStr}${actionStr}`;
                else signalTitle = `【紧急反手】${styleStr}${actionStr}`;
                positions[posKey] = targetDir; 
                await addTradeLog(symbol, timeframe, actionStr, styleStr, lastPrices[symbol]); 
            }

            let emailBody = `<b>【操作逻辑】(${timeframe}级别)</b><br>${aiObj.reason}<br><br>`;
            let wechatText = `分析周期: ${timeframe}\n币种: ${symbol}\n价格: ${lastPrices[symbol]}\n逻辑: ${aiObj.reason}\n`;

            if (targetDir !== 'WAIT') {
                emailBody += `<b>【风控点位】</b><br>🛑 止损: ${aiObj.sl}<br>🎯 TP1: ${aiObj.tp1}<br>🎯 TP2: ${aiObj.tp2}<br>📊 胜率: ${winRate}%`;
                wechatText += `\n🛑 止损: ${aiObj.sl}\n🎯 止盈: ${aiObj.tp1} / ${aiObj.tp2}\n📊 预计胜率: ${winRate}%`;
            }

            if (signalTitle) {
                console.log(`[发出信号] ${symbol} ${timeframe} ${signalTitle}`);
                await sendSignalEmail(`${signalTitle} [${timeframe}]`, emailBody, lastPrices[symbol], `${timeframe} K线`, symbol);
                await sendWeChatPush(`${signalTitle} ${symbol}(${timeframe})`, wechatText);
            }
          } catch (e) { }
          await new Promise(resolve => setTimeout(resolve, 1500)); // 降速防止封IP
      }
  }
}

// --- Web API ---
http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  
  if (req.url === '/status') { res.writeHead(200); res.end(JSON.stringify({ status: "alive" })); return; }

  // 🟢 隐藏后门：专门用于测试 AI 交易信号推送
  if (req.url === '/api/test-signal') {
      const testHtml = `<b>【操作逻辑】(测试级别)</b><br>收到主人的最高指令，正在进行系统全链路通信测试。特种兵雷达运转正常！<br><br><b>【风控点位】</b><br>🛑 止损: 2000<br>🎯 TP1: 3000<br>🎯 TP2: 3500<br>📊 胜率: 99%`;
      const testWechat = `分析周期: 5m\n币种: ETHUSDT\n价格: 2500.00\n逻辑: 收到主人的最高指令，正在进行系统全链路通信测试。特种兵雷达运转正常！\n\n🛑 止损: 2000\n🎯 止盈: 3000 / 3500\n📊 预计胜率: 99%`;
      
      // 触发发信
      sendSignalEmail("【建仓指令】★ 激进做多 [5m]", testHtml, 2500, "5m K线", "ETHUSDT");
      sendWeChatPush("【建仓指令】★ 激进做多 ETH(5m)", testWechat);
      
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end("<h2 style='color:green; text-align:center; margin-top:50px;'>✅ 发射成功！<br>系统已模拟 AI 交易信号，请立刻检查您的微信和邮箱！</h2>");
      return;
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
    console.log("🚀 启动！特种突破矩阵 + 报警引擎挂载完毕！");
    setInterval(runMonitor, CHECK_INTERVAL_MS); 
    setInterval(runAlertEngine, ALERT_CHECK_INTERVAL); 
    runMonitor();
}
startApp();
