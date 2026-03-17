const https = require('https');
const http = require('http');

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
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5分钟盯盘一次，捕捉波段刚刚好
const SIGNAL_COOLDOWN_MS = 20 * 60 * 1000; // 激进模式下，冷却时间缩短到 20 分钟

let lastSignalTime = 0;
let lastSignalType = null;
let lastPrice = null;

console.log("🚀 ETH 激进型 AI-猎手 启动...");

// --- 网络请求 ---
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
      res.on('end', () => {
        if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${d}`));
        else { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ETH-Monitor/2.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

// --- 技术指标计算引擎 ---
function calcMA(data, period) {
  if (data.length < period) return 0;
  return data.slice(-period).reduce((sum, c) => sum + c.close, 0) / period;
}

function calcRSI(data, period = 14) {
  if (data.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = data.length - period; i < data.length; i++) {
    const diff = data[i].close - data[i-1].close;
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// --- AI 激进大脑 ---
async function askAIForDecision(candles) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  
  // 计算技术指标
  const ma5 = calcMA(candles, 5);
  const ma10 = calcMA(candles, 10);
  const ma20 = calcMA(candles, 20);
  const rsi = calcRSI(candles, 14);
  
  // 捕捉成交量异动 (突发新闻/大资金进场往往伴随放量)
  const volSurge = last.volume > (prev.volume * 1.5) ? "⚠️成交量异常放大(可能有突发消息)" : "成交量平稳";

  // 赋予 AI 激进性格的魔法 Prompt
  const prompt = `你现在是一个【风格激进、嗅觉敏锐的加密货币左侧交易员】。你不喜欢等趋势完全走出来再追高，而是善于通过指标和动量【提前埋伏】爆发点。

盘面数据（ETH/USDT 15分钟线）：
- 当前价: ${last.close} (本轮最高${last.high}, 最低${last.low})
- 均线状态: MA5=${ma5.toFixed(2)}, MA10=${ma10.toFixed(2)}, MA20=${ma20.toFixed(2)}
- 相对强弱 RSI(14): ${rsi.toFixed(1)}
- 资金动向: ${volSurge} (当前成交量 ${last.volume.toFixed(2)})

任务要求：
1. 不要太保守！结合 RSI 的超买超卖、均线是否即将拐头、以及成交量异动，大胆预测接下来 1~2 小时的突破方向。
2. 只要你发现有筑底反弹、破位下跌或资金异动的苗头，果断提示入场。
3. 回复开头必须是：【建议入场：做多】或【建议入场：做空】或【建议入场：观望】。
4. 在理由中给出你预测的逻辑，并给出防守止损位。`;

  try {
    const result = await postJSON("https://api.deepseek.com/chat/completions", {
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.6 // 提高温度值，让 AI 的思维更发散、更大胆
    }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });

    if (result.choices && result.choices[0]) return result.choices[0].message.content;
  } catch (e) { console.error("AI 决策请求失败:", e.message); }
  return "AI 分析暂时不可用";
}

// --- 发信通道 ---
async function sendSignalEmail(action, aiDecisionText, price) {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const msg = `🔥 AI 激进狙击报告\n------------------\n【AI 动作】${action}\n【现价】${price}\n\n【入场逻辑】\n${aiDecisionText}\n\n【发送时间】${time}`;

  try {
    await postJSON("https://api.emailjs.com/api/v1.0/email/send", {
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY, 
      accessToken: EMAILJS_PRIVATE_KEY, 
      template_params: { 
        to_email: NOTIFY_EMAIL, 
        signal: action, 
        price: price.toString(), 
        message: msg, 
        time: time 
      }
    });
    console.log(`[${time}] ✅ 激进信号已发出: ${action} @ ${price}`);
  } catch (e) {
    console.error(`[${time}] ❌ 邮件发送失败! 具体原因: ${e.message}`);
  }
}

// --- 监控主循环 ---
async function runMonitor() {
  const time = new Date().toLocaleTimeString();
  try {
    // 依然使用防封杀的 Binance US 接口
    const data = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${SYMBOL}&interval=15m&limit=30`);  
    
    if (!Array.isArray(data)) {
        console.error(`[${time}] ⚠️ 币安接口异常:`, JSON.stringify(data));
        return;
    }

    // 提取包括 volume(成交量) 在内的数据
    const candles = data.map(d => ({ open: +d[1], high: +d[2], low: +d[3], close: +d[4], volume: +d[5] }));
    lastPrice = candles[candles.length - 1].close;

    console.log(`[${time}] 🔍 猎手正在扫描盘面... 当前价: ${lastPrice}`);
    const aiResponse = await askAIForDecision(candles);
    
    console.log(`[${time}] AI 结论: ${aiResponse.split('\n')[0]}`);

    if (aiResponse.includes("【建议入场：做多】") || aiResponse.includes("【建议入场：做空】")) {
      const action = aiResponse.includes("做多") ? "做多" : "做空";
      const now = Date.now();
      
      if (action !== lastSignalType || (now - lastSignalTime > SIGNAL_COOLDOWN_MS)) {
        await sendSignalEmail(action, aiResponse, lastPrice);
        lastSignalTime = now;
        lastSignalType = action;
      }
    }
  } catch (e) { console.error("监控循环报错:", e.message); }
}

// --- 存活接口 ---
http.createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ status: "alive", price: lastPrice }));
  } else { res.end("ETH AI Hunter is Running"); }
}).listen(process.env.PORT || 3000);

// --- 启动自检 ---
async function startApp() {
    console.log("🚀 激进型 AI 系统启动...");
    await sendSignalEmail("激进猎手上线测试", "你的 AI 已经进化为左侧交易狙击手！引入了 MA均线、RSI 强弱指标和实时成交量异动监控。它现在不仅会顺势而为，更会大胆预测突破方向，提前埋伏！", 0);
    setInterval(runMonitor, CHECK_INTERVAL_MS);
    runMonitor();
}

startApp();
