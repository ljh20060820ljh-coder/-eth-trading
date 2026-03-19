const https = require('https');
const http = require('http');

const EMAILJS_SERVICE_ID = "service_op2rg49"; 
const EMAILJS_TEMPLATE_ID = "template_eftwoy6"; 
const EMAILJS_PUBLIC_KEY = "tIZB9DwwpEKr3KQpQ"; 
const NOTIFY_EMAIL = "2183089849@qq.com";
const KV_REST_API_URL = "https://exact-sparrow-75815.upstash.io"; 

const SYMBOLS = ["ETHUSDT"]; // 专注 ETH
const TIMEFRAME = "15m"; 
const TREND_TIMEFRAME = "4h"; 
const CHECK_INTERVAL_MS = 5 * 60 * 1000; 

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY; 
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;
const SERVERCHAN_SENDKEY = process.env.SERVERCHAN_SENDKEY; 

let positions = {}; 
let entryPrices = {}; 
let entryTimes = {}; // 🔥 新增：记录入场时间，防止频繁平仓
SYMBOLS.forEach(sym => { positions[sym] = null; entryPrices[sym] = null; entryTimes[sym] = 0; });
let lastPrices = { ETHUSDT: null };
let cachedNews = []; 
let isMonitoringActive = true; 
let inMemoryDB = { trade_logs: [], price_alerts: [] };

console.log("👑 修复版量化 AI (带持仓时间保护 + 强化做空) 已上线...");

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
    https.get(url, { headers: { 'User-Agent': 'God-Mode-Bot/2.0', ...extraHeaders } }, (res) => {
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
    if (KV_REST_API_URL && KV_REST_API_TOKEN) { try { await postJSON(`${KV_REST_API_URL}/set/${key}`, data, { Authorization: `Bearer ${KV_REST_API_TOKEN}` }); }catch(e){} }
}
async function addTradeLog(symbol, action, style, entryPrice) { 
    const logs = await loadData('trade_logs'); 
    logs.push({ id: Date.now().toString(), symbol, timeframe: TIMEFRAME, entryTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }), action, style, entryPrice, status: 'OPEN' });
    await saveData('trade_logs', logs.slice(-50)); 
}

function calcMA(data, period) { if (data.length < period) return 0; return data.slice(-period).reduce((sum, c) => sum + c.close, 0) / period; }
function calcRSI(data, period = 14) { if (data.length < period + 1) return 50; let gains = 0, losses = 0; for (let i = data.length - period; i < data.length; i++) { const diff = data[i].close - data[i-1].close; if (diff > 0) gains += diff; else losses -= diff; } const avgLoss = losses / period; if (avgLoss === 0) return 100; return 100 - (100 / (1 + (gains / period) / avgLoss)); }
function calcEMA(data, period) {
    if (data.length < period) return data[data.length-1].close;
    let sum = 0; for(let i=0; i<period; i++) sum += data[i].close;
    let ema = sum / period; 
    const k = 2 / (period + 1);
    for (let i = period; i < data.length; i++) { ema = (data[i].close - ema) * k + ema; }
    return ema;
}

// ==========================================
// 🧠 修复：强化做空与 HOLD 机制的 AI Prompt
// ==========================================
async function askAIBatchDecisions(batchData) {
  if (!DEEPSEEK_API_KEY || batchData.length === 0) return [];
  // 🔥 核心重写：强制 AI 认识到做空和持有的选项，取代过去的 WAIT
  const prompt = `你是量化机器人。根据以下数据做出交易决策。
【重要指令】：
1. 如果均线呈空头排列 (如现价低于MA5和MA20)，必须果断输出 SHORT (做空)，不要幻想抄底！
2. 如果当前有持仓且趋势未坏，输出 HOLD (持有)。
3. 只有当趋势反转需要止盈/止损时，才输出 CLOSE (平仓)。
4. 没有持仓且不符合开仓条件时，输出 WAIT。
严格返回 JSON 数组：[{"symbol": "ETHUSDT", "direction": "LONG/SHORT/HOLD/CLOSE/WAIT", "win_rate": 85, "reason": "理由"}]
数据：${JSON.stringify(batchData)}`;
  
  try {
    const res = await postJSON("https://api.deepseek.com/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.1 }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
    let jsonStr = res.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(jsonStr);
  } catch (e) { return []; }
}

async function runMonitor() {
  if (!isMonitoringActive) return;
  let batchData = [];
  
  for (const symbol of SYMBOLS) {
      try {
        const data4h = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${TREND_TIMEFRAME}&limit=250`);
        const ema200_4h = calcEMA(data4h.map(d => ({ close: +d[4] })), 200);
        
        const data15m = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${TIMEFRAME}&limit=50`);
        const candles15m = data15m.map(d => ({ open: +d[1], high: +d[2], low: +d[3], close: +d[4] }));
        const currentPrice = candles15m[candles15m.length - 1].close;
        lastPrices[symbol] = currentPrice;
        
        const ma5 = calcMA(candles15m, 5), ma20 = calcMA(candles15m, 20), rsi = calcRSI(candles15m, 14);
        
        const isBearTrend = currentPrice < ema200_4h;

        // 🛑 硬止损保护保留
        if (positions[symbol] && entryPrices[symbol]) {
            const lossPercent = positions[symbol] === 'LONG' 
                ? ((entryPrices[symbol] - currentPrice) / entryPrices[symbol]) * 100
                : ((currentPrice - entryPrices[symbol]) / entryPrices[symbol]) * 100;

            if (lossPercent >= 5.0) {
                await sendSignalEmail("🩸 强制熔断平仓", `亏损触及 5% 底线，系统已强制越权平仓！`, currentPrice, TIMEFRAME, symbol);
                await sendWeChatPush(`🚨 ${symbol} 强制平仓`, `当前浮亏过大，触发保本协议。`);
                positions[symbol] = null; entryPrices[symbol] = null; entryTimes[symbol] = 0;
                continue; 
            }
        }

        batchData.push({ symbol, currentPrice, ma5, ma20, rsi, isBearTrend, currentPos: positions[symbol] || 'NONE' });
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

          // ⚖️ VETO 系统：拒绝逆势操作
          if (dir === 'LONG' && targetData.isBearTrend) {
              dir = 'WAIT'; res.reason = "【拦截】4H熊市，禁止做多";
          } else if (dir === 'SHORT' && !targetData.isBearTrend) {
              dir = 'WAIT'; res.reason = "【拦截】4H牛市，禁止做空";
          }

          // 🔥 核心修复：HOLD 状态处理 和 持仓时间保护
          if (dir === 'HOLD' || dir === positions[sym]) continue; // 保持现状，直接跳过

          // 只有当 AI 明确发出 CLOSE，或者给出反向交易信号时，才考虑平仓
          if (dir === 'CLOSE' || dir === 'WAIT' || (positions[sym] && dir !== positions[sym])) {
              if (positions[sym]) {
                  // ⏳ 时间保护伞：开仓不足 30 分钟，系统拒绝 AI 的平仓请求（除非打到上面 5% 硬止损）
                  const holdTimeMins = (Date.now() - entryTimes[sym]) / (1000 * 60);
                  if (holdTimeMins < 30) {
                      console.log(`⏳ 时间保护生效：${sym} 开仓仅 ${holdTimeMins.toFixed(1)} 分钟，拒绝提早平仓。`);
                      continue; 
                  }

                  await sendSignalEmail("🏳️ 平仓收网", res.reason, lastPrices[sym], TIMEFRAME, sym);
                  await sendWeChatPush(`平仓: ${sym}`, `持仓时间: ${holdTimeMins.toFixed(0)}分钟\n理由: ${res.reason}`);
                  positions[sym] = null; entryPrices[sym] = null; entryTimes[sym] = 0;
              }
          } 
          
          // 新开仓逻辑
          if ((dir === 'LONG' || dir === 'SHORT') && !positions[sym] && parseInt(res.win_rate || 0) >= 60) {
              positions[sym] = dir;
              entryPrices[sym] = lastPrices[sym]; 
              entryTimes[sym] = Date.now(); // 记录入场时间点
              await sendSignalEmail(`🎯 开仓: ${dir}`, res.reason, lastPrices[sym], TIMEFRAME, sym);
              await sendWeChatPush(`开仓: ${sym} ${dir}`, `胜率: ${res.win_rate}%\n逻辑: ${res.reason}`);
              await addTradeLog(sym, dir, 'STEADY', lastPrices[sym]);
          }
      }
  }
}

// ==========================================
// 🌐 API 接口与启动
// ==========================================
http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/status') { res.end(JSON.stringify({ status: "alive", mode: "God Mode V2", isMonitoringActive })); return; }
  if (req.url === '/api/logs') { const logs = await loadData('trade_logs'); res.end(JSON.stringify(logs.reverse())); return; }
  if (req.url === '/api/toggle-monitor' && req.method === 'POST') { isMonitoringActive = !isMonitoringActive; res.end(JSON.stringify({success:true})); return; }
  res.end("System Running V2");
}).listen(process.env.PORT || 3000);

setInterval(runMonitor, CHECK_INTERVAL_MS); 
runMonitor();
