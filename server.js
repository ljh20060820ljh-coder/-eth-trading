const https = require('https');
const http = require('http');

const EMAILJS_SERVICE_ID = "service_op2rg49";
const EMAILJS_TEMPLATE_ID = "template_eftwoy6";
const EMAILJS_PUBLIC_KEY = "8hV-qEj_65-Yjk1Pn";
const DEEPSEEK_API_KEY = "sk-807bdf2c1e164c818519243bacb72a72";
const NOTIFY_EMAIL = "2183089849@qq.com";
const SYMBOL = "ETHUSDT";
const CHECK_INTERVAL_MS = 10 * 1000;
const SIGNAL_COOLDOWN_MS = 15 * 60 * 1000;
const HOLD_REMINDER_MS = 5 * 60 * 1000;

let monitorEnabled = true;
let lastHoldReminderTime = 0;
let holdReminderSent = false;
let lastSignalTime = 0;
let lastSignalType = null;
let lastPrice = null;

console.log("ETH Monitor Server starting...");

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'ETH-Monitor/1.0' } }, (res) => {
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

function calcMA(data, p) {
  if (data.length < p) return null;
  return data.slice(-p).reduce((s, c) => s + c.close, 0) / p;
}

function calcRSI(data, p) {
  p = p || 14;
  if (data.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = data.length - p; i < data.length; i++) {
    const d = data[i].close - data[i-1].close;
    if (d > 0) g += d; else l -= d;
  }
  const ag = g/p, al = l/p;
  return al === 0 ? 100 : 100 - (100 / (1 + ag/al));
}

function calcATR(data, p) {
  p = p || 14;
  if (data.length < p + 1) return 10;
  let sum = 0;
  const slice = data.slice(-p);
  for (let i = 0; i < slice.length; i++) {
    if (i === 0) { sum += slice[i].high - slice[i].low; continue; }
    sum += Math.max(slice[i].high-slice[i].low, Math.abs(slice[i].high-slice[i-1].close), Math.abs(slice[i].low-slice[i-1].close));
  }
  return sum / p;
}

function findSwings(data, lb) {
  lb = lb || 35;
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

function detectSignal(data) {
  if (!data || data.length < 22) return null;
  const last = data.length-1;
  const ma5l = calcMA(data, 5), ma10l = calcMA(data, 10), ma20l = calcMA(data, 20);
  const ma5p = calcMA(data.slice(0,-1), 5), ma10p = calcMA(data.slice(0,-1), 10);
  if (!ma5l||!ma10l||!ma20l) return null;
  const rsi = calcRSI(data);
  const bull = ma5l>ma10l&&ma10l>ma20l&&ma5p<=ma10p&&data[last].close>ma5l;
  const bear = ma5l<ma10l&&ma10l<ma20l&&ma5p>=ma10p&&data[last].close<ma5l;
  if (bull) return { type:'LONG', label:'做多', rsi };
  if (bear) return { type:'SHORT', label:'做空', rsi };
  return null;
}

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

async function getAIAnalysis(data, sig) {
  const price = data[data.length-1].close;
  const rsi = calcRSI(data);
  const ma5=calcMA(data,5), ma10=calcMA(data,10), ma20=calcMA(data,20);
  const atr=calcATR(data,14);
  const lc=data[data.length-1];
  const trend=ma5>ma10&&ma10>ma20?'多头排列':ma5<ma10&&ma10<ma20?'空头排列':'均线纠缠';
  const prompt = `你是专业加密货币技术分析师。用中文分析ETH/USDT 15分钟数据：\n当前价格：${price.toFixed(2)}\nMA5：${(ma5||0).toFixed(2)} MA10：${(ma10||0).toFixed(2)} MA20：${(ma20||0).toFixed(2)}\n均线：${trend}\nRSI：${rsi?rsi.toFixed(1):'--'}\nATR：${atr.toFixed(2)}\n最新K线：${lc.close>lc.open?'阳':'阴'}线 开${lc.open.toFixed(2)} 高${lc.high.toFixed(2)} 低${lc.low.toFixed(2)} 收${lc.close.toFixed(2)}\n信号：${sig.label}\n请给出100字以内的分析和风险提示。`;
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

async function sendEmail(sig, tpsl, aiText) {
  const price = lastPrice ? lastPrice.toFixed(2) : '--';
  const time = new Date().toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'});
  const msg = `【进场信号】${sig.label}\n【时间】${time}\n【入场价】${price}\n【止损位】${tpsl.sl}\n【止盈一】${tpsl.tp1}\n【止盈二】${tpsl.tp2}\n${tpsl.rsi?`【RSI】${tpsl.rsi.toFixed(1)}`:''}\n\n${aiText?`【AI分析】\n${aiText}\n\n`:''}注意风险，请结合自身判断操作`;
  try {
    await postJSON("https://api.emailjs.com/api/v1.0/email/send", {
      service_id:EMAILJS_SERVICE_ID,
      template_id:EMAILJS_TEMPLATE_ID,
      user_id:EMAILJS_PUBLIC_KEY,
      template_params:{to_email:NOTIFY_EMAIL,signal:sig.label,price,symbol:SYMBOL,interval:'15m',time,message:msg}
    });
    console.log(`[${time}] Email sent: ${sig.label} @ ${price}`);
  } catch(e) { console.log("Email error:", e.message); }
}

async function sendHoldEmail(sig, price) {
  const time = new Date().toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'});
  const msg = `【趋势持续提醒】${sig.label}方向持续中\n【当前价格】${price.toFixed(2)}\n【建议】趋势未变，继续持仓\n【时间】${time}`;
  try {
    await postJSON("https://api.emailjs.com/api/v1.0/email/send", {
      service_id:EMAILJS_SERVICE_ID,
      template_id:EMAILJS_TEMPLATE_ID,
      user_id:EMAILJS_PUBLIC_KEY,
      template_params:{to_email:NOTIFY_EMAIL,signal:sig.label+' 持续中',price:price.toFixed(2),symbol:SYMBOL,interval:'15m',time,message:msg}
    });
    console.log(`[${time}] Hold reminder sent`);
  } catch(e) { console.log("Hold email error:", e.message); }
}

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
          console.log(`[${time}] NEW Signal: ${sig.label} @ ${lastPrice}`);
          lastSignalTime = now;
          lastSignalType = sig.type;
          lastHoldReminderTime = now;
          holdReminderSent = false;
          const tpsl = analyzeTPSL(candles, sig.type);
          const aiText = await getAIAnalysis(candles, sig);
          await sendEmail(sig, tpsl, aiText);
        }
      } else {
        if (!holdReminderSent && now - lastHoldReminderTime >= HOLD_REMINDER_MS) {
          lastHoldReminderTime = now;
          holdReminderSent = true;
          await sendHoldEmail(sig, lastPrice);
        } else {
          console.log(`[${time}] ${sig.label} @ ${lastPrice.toFixed(2)}`);
        }
      }
    } else {
      if (lastSignalType) { lastSignalType = null; holdReminderSent = false; }
      console.log(`[${time}] No signal. Price: ${lastPrice.toFixed(2)}`);
    }
  } catch(e) { console.log(`[${time}] Error:`, e.message); }
}

// Keep-alive ping to prevent Render free tier sleep
function keepAlive() {
  const req = http.get(`http://localhost:${PORT}/status`, (res) => {
    res.resume();
  });
  req.on('error', () => {});
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ enabled: monitorEnabled, lastPrice, lastSignal: lastSignalType }));
  } else if (req.method === 'POST' && req.url === '/toggle') {
    monitorEnabled = !monitorEnabled;
    console.log(`Monitor ${monitorEnabled ? 'ENABLED' : 'DISABLED'}`);
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({enabled: monitorEnabled}));
  } else if (req.method === 'POST' && req.url === '/enable') {
    monitorEnabled = true;
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({enabled: true}));
  } else if (req.method === 'POST' && req.url === '/disable') {
    monitorEnabled = false;
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({enabled: false}));
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  checkSignal();
  setInterval(checkSignal, CHECK_INTERVAL_MS);
  setInterval(keepAlive, 14 * 60 * 1000); // ping every 14 min to stay awake
});
