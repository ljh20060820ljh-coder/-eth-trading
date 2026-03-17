const https = require('https');
const http = require('http');

// ==========================================
// 🔑 你的专属密钥配置区（请把引号里的中文替换成你刚找到的代码）
// ==========================================
const EMAILJS_SERVICE_ID = "service_op2rg49"; 
const EMAILJS_TEMPLATE_ID = "template_eftwoy6"; 
const EMAILJS_PUBLIC_KEY = "tIZB9DwwpEKr3KQpQ"; 
const DEEPSEEK_API_KEY = "sk-9afe367ef974483693b3e829b203dd6b"; 
const NOTIFY_EMAIL = "2183089849@qq.com"; // 接收邮件的邮箱

const SYMBOL = "ETHUSDT";
const CHECK_INTERVAL_MS = 10 * 1000; // 每 10 秒拉取一次数据
const SIGNAL_COOLDOWN_MS = 15 * 60 * 1000; // 同方向信号冷却 15 分钟
const HOLD_REMINDER_MS = 5 * 60 * 1000; // 持续持仓提醒间隔 5 分钟

let monitorEnabled = true;
let lastHoldReminderTime = 0;
let holdReminderSent = false;
let lastSignalTime = 0;
let lastSignalType = null;
let lastPrice = null;

console.log("ETH Monitor Server starting...");

// --- 工具函数：网络请求 ---
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'ETH-Monitor/1.2' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function postJSON(url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(extraHeaders||{}) }
    };
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// --- 工具函数：技术指标计算 ---
function calcMA(data, p) {
  if (data.length < p) return null;
  return data.slice(-p).reduce((s, c) => s + c.close, 0) / p;
}

function calcRSI(data, p = 14) {
  if (data.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = data.length - p; i < data.length; i++) {
    const d = data[i].close - data[i-1].close;
    if (d > 0) g += d; else l -= d;
  }
  const ag = g/p, al = l/p;
  return al === 0 ? 100 : 100 - (100 / (1 + ag/al));
}

function calcATR(data, p = 14) {
  if (data.length < p + 1) return 10;
  let sum = 0;
  const slice = data.slice(-p);
  for (let i = 0; i < slice.length; i++) {
    if (i === 0) { sum += slice[i].high - slice[i].low; continue; }
    sum += Math.max(slice[i].high-slice[i].low, Math.abs(slice[i].high-slice[i-1].close), Math.abs(slice[i].low-slice[i-1].close));
  }
  return sum / p;
}

function findSwings(data, lb = 35) {
  const r = data.slice(-lb), highs = [], lows = [];
  for (let i = 2; i < r.length-2; i++) {
    if (r[i].high>r[i-1].high&&r[i].high>r[i-2].high&&r[i].high>r[i+1].high&&r[i].high>r[i+2].high) highs.push(r[i].high);
    if (r[i].low<r[i-1].low&&r[i].low<r[i-2].low&&r[i].low<r[i+1].low&&r[i].low<r[i+2].low) lows.push(r[i].low);
  }
  return { highs, lows };
}

function psychLevel(price, dir) {
  for (const l of [100,50,25,10]) {
    const r = Math.round(price/l)*l;
    if (dir==='up' && r>price) return r;
    if (dir==='down' && r<price) return r;
  }
  return price;
}

// --- 核心逻辑：信号检测 ---
function detectSignal(data) {
  if (!data || data.length < 22) return null;
  const last = data.length-1;
  const ma5l = calcMA(data, 5), ma10l = calcMA(data, 10), ma20l = calcMA(data, 20);
  const ma5p = calcMA(data.slice(0,-1), 5), ma10p = calcMA(data.slice(0,-1), 10);
  if (!ma5l||!ma10l||!ma20l) return null;
  
  const rsi = calcRSI(data);
  const price = data[last].close;
  const prevPrice = data[last-1].close;

  // 1. 均线金叉做多（要求有价格确认）
  const maBull = ma5l>ma10l && ma10l>ma20l && ma5p<=ma10p && price>ma5l;
  const maBear = ma5l<ma10l && ma10l<ma20l && ma5p>=ma10p && price<ma5l;

  // 2. 突破信号
  const recent20 = data.slice(-20);
  const highest = Math.max(...recent20.slice(0,-1).map(c=>c.high));
  const lowest = Math.min(...recent20.slice(0,-1).map(c=>c.low));
  const breakoutBull = price > highest && data[last].close > data[last].open;
  const breakoutBear = price < lowest && data[last].close < data[last].open;

  // 3. 强势动量信号 (连续2根K线动量突破)
  const isLastBull = data[last].close > data[last].open;
  const isPrevBull = data[last-1].close > data[last-1].open;
  const isLastBear = data[last].close < data[last].open;
  const isPrevBear = data[last-1].close < data[last-1].open;
  
  const trendBull = isLastBull && isPrevBull && price > ma5l && (price - prevPrice > price * 0.0015); 
  const trendBear = isLastBear && isPrevBear && price < ma5l && (prevPrice - price > price * 0.0015);

  const isBull = maBull || breakoutBull || trendBull;
  const isBear = maBear || breakoutBear || trendBear;

  if (isBull) {
    const reason = breakoutBull ? '突破近期高点' : trendBull ? '短线动量追涨' : '均线金叉';
    return { type:'LONG', label:'做多', rsi, reason };
  }
  if (isBear) {
    const reason = breakoutBear ? '跌破近期低点' : trendBear ? '短线动量追空' : '均线死叉';
    return { type:'SHORT', label:'做空', rsi, reason };
  }
  return null;
}

// --- 计算止盈止损 ---
function analyzeTPSL(data, type) {
  const price = data[data.length-1].close;
  const atr = calcATR(data, 14);
  const { highs, lows } = findSwings(data, 35);
  const rsi = calcRSI(data);
  let sl, tp1, tp2;
  if (type === 'LONG') {
    const nearLow = lows.filter(l=>l<price).sort((a,b)=>b-a)[0]||price*0.985;
    sl = Math.min(Math.max(nearLow-atr*0.25, price*0.982), price*0.982);
    const nearHigh = highs.filter(h=>h>price).sort((a,b)=>a-b)[0];
    tp1 = (nearHigh&&nearHigh<price*1.03)?nearHigh*0.998:Math.min(psychLevel(price+atr*2,'up'),price*1.022);
    tp2 = Math.max(tp1+atr*1.5, psychLevel(price*1.035,'up'));
  } else {
    const nearHigh = highs.filter(h=>h>price).sort((a,b)=>a-b)[0]||price*1.015;
    sl = Math.max(Math.min(nearHigh+atr*0.25,price*1.018),price*1.018);
    const nearLow = lows.filter(l=>l<price).sort((a,b)=>b-a)[0];
    tp1 = (nearLow&&nearLow>price*0.97)?nearLow*1.002:Math.max(psychLevel(price-atr*2,'down'),price*0.978);
    tp2 = Math.min(tp1-atr*1.5, psychLevel(price*0.965,'down'));
  }
  return { sl:+sl.toFixed(2), tp1:+tp1.toFixed(2), tp2:+tp2.toFixed(2), rsi };
}

// --- 调用 DeepSeek AI ---
async function getAIAnalysis(data, sig) {
  if (DEEPSEEK_API_KEY.includes("请在这里填入")) {
    return "DeepSeek 密钥未配置，请在代码顶部填写。";
  }
  const price = data[data.length-1].close;
  const rsi = calcRSI(data);
  const ma5=calcMA(data,5), ma10=calcMA(data,10), ma20=calcMA(data,20);
  const atr=calcATR(data,14);
  const lc=data[data.length-1];
  const trend=ma5>ma10&&ma10>ma20?'多头排列':ma5<ma10&&ma10<ma20?'空头排列':'均线纠缠';
  const prompt = `你是专业加密货币技术分析师。用中文分析ETH/USDT 15分钟数据：\n当前价格：${price.toFixed(2)}\nMA5：${(ma5||0).toFixed(2)} MA10：${(ma10||0).toFixed(2)} MA20：${(ma20||0).toFixed(2)}\n均线：${trend}\nRSI：${rsi?rsi.toFixed(1):'--'}\nATR：${atr.toFixed(2)}\n最新K线：${lc.close>lc.open?'阳':'阴'}线 开${lc.open.toFixed(2)} 高${lc.high.toFixed(2)} 低${lc.low.toFixed(2)} 收${lc.close.toFixed(2)}\n程序发出的信号是：${sig.label} (触发原因: ${sig.reason})\n请给出100字以内的分析和风险提示。`;
  
  try {
    const result = await postJSON("https://api.deepseek.com/chat/completions", {
      model:"deepseek-chat",
      messages:[{role:"user",content:prompt}],
      max_tokens:200,
      temperature:0.3
    }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
    if (result.choices&&result.choices[0]) return result.choices[0].message.content;
  } catch(e) { console.log("AI error:", e.message); }
  return null;
}

// --- 发送 Email 通知 ---
async function sendEmail(sig, tpsl, aiText) {
  const price = lastPrice ? lastPrice.toFixed(2) : '--';
  const time = new Date().toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'});
  const msg = `【进场信号】${sig.label}\n【触发原因】${sig.reason||'均线信号'}\n【时间】${time}\n【入场价】${price}\n【止损位】${tpsl.sl}\n【止盈一】${tpsl.tp1}\n【止盈二】${tpsl.tp2}\n${tpsl.rsi?`【RSI】${tpsl.rsi.toFixed(1)}`:''}\n\n${aiText?`【DeepSeek分析】\n${aiText}\n\n`:''}注意风险，请严格执行止损纪律！`;
  
  if (EMAILJS_PUBLIC_KEY.includes("请在这里填入")) {
    console.log(`\n=========================================\n[模拟发信] 检测到未填写真实 EmailJS 密钥！\n原定发送给: ${NOTIFY_EMAIL}\n邮件内容:\n${msg}\n=========================================\n`);
    return;
  }

  try {
    await postJSON("https://api.emailjs.com/api/v1.0/email/send", {
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      template_params: {to_email: NOTIFY_EMAIL, signal: sig.label, price, symbol: SYMBOL, interval: '15m', time, message: msg}
    });
    console.log(`[${time}] ✅ Email successfully sent: ${sig.label} @ ${price}`);
  } catch(e) { console.log("Email error:", e.message); }
}

// --- 发送持仓继续提醒 Email ---
async function sendHoldEmail(sig, price) {
  if (EMAILJS_PUBLIC_KEY.includes("请在这里填入")) return;
  const time = new Date().toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'});
  const msg = `【趋势持续提醒】${sig.label}方向持续中\n【当前价格】${price.toFixed(2)}\n【建议】趋势未变，继续持仓\n【时间】${time}`;
  try {
    await postJSON("https://api.emailjs.com/api/v1.0/email/send", {
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      template_params: {to_email: NOTIFY_EMAIL, signal: sig.label + ' 持续中', price: price.toFixed(2), symbol: SYMBOL, interval: '15m', time, message: msg}
    });
    console.log(`[${time}] ✅ Hold reminder email sent`);
  } catch(e) { console.log("Hold email error:", e.message); }
}

// --- 主循环：行情轮询 ---
async function checkSignal() {
  const time = new Date().toLocaleTimeString();
  if (!monitorEnabled) { console.log(`[${time}] Paused`); return; }
  const now = Date.now();
  try {
    const data = await fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=15m&limit=100`);
    if (!Array.isArray(data)) { console.log(`[${time}] API error:`, JSON.stringify(data).slice(0,100)); return; }
    
    const candles = data.map(d => ({time:d[0],open:+d[1],high:+d[2],low:+d[3],close:+d[4]}));
    lastPrice = candles[candles.length-1].close;
    const sig = detectSignal(candles);

    if (sig) {
      if (sig.type !== lastSignalType) {
        if (now - lastSignalTime >= SIGNAL_COOLDOWN_MS) {
          console.log(`[${time}] ⚡ NEW Signal: ${sig.label} @ ${lastPrice} (原因: ${sig.reason})`);
          lastSignalTime = now;
          lastSignalType = sig.type;
          lastHoldReminderTime = now;
          holdReminderSent = false;
          
          const tpsl = analyzeTPSL(candles, sig.type);
          const aiText = await getAIAnalysis(candles, sig);
          await sendEmail(sig, tpsl, aiText);
        } else {
          console.log(`[${time}] ⏳ 信号冷却中... 忽略 ${sig.label}`);
        }
      } else {
        if (!holdReminderSent && now - lastHoldReminderTime >= HOLD_REMINDER_MS) {
          lastHoldReminderTime = now;
          holdReminderSent = true;
          await sendHoldEmail(sig, lastPrice);
        }
      }
    } else {
      if (lastSignalType) { lastSignalType = null; holdReminderSent = false; }
      console.log(`[${time}] 🔍 行情监控中... 最新价: ${lastPrice.toFixed(2)}`);
    }
  } catch(e) { console.log(`[${time}] ❌ Error:`, e.message); }
}

// --- HTTP 服务器端点 ---
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ 
      status: "alive", 
      enabled: monitorEnabled, 
      lastPrice, 
      lastSignal: lastSignalType,
      time: new Date().toISOString()
    }));
  } else if (req.method === 'POST' && req.url === '/toggle') {
    monitorEnabled = !monitorEnabled;
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({enabled: monitorEnabled}));
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n=================================================`);
  console.log(`🚀 ETH 自动通知服务已启动！运行在端口: ${PORT}`);
  console.log(`⏰ 强烈建议: 部署后使用 cron-job.org 定时访问 /status 接口防止休眠！`);
  console.log(`=================================================\n`);
  
  checkSignal(); // 启动时立即执行一次
  setInterval(checkSignal, CHECK_INTERVAL_MS);
});
