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
const CHECK_INTERVAL_MS = 5 * 60 * 1000; 
const SIGNAL_COOLDOWN_MS = 20 * 60 * 1000; 

let lastSignalTime = 0;
let lastSignalType = null;
let lastPrice = null;

console.log("🚀 ETH 专业 AI 交易员已上线...");

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
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + (gains / period) / avgLoss));
}

function calcATR(data, period = 14) {
  if (data.length < period + 1) return 0;
  let sumTR = 0;
  for (let i = data.length - period; i < data.length; i++) {
    const high = data[i].high;
    const low = data[i].low;
    const prevClose = data[i-1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    sumTR += tr;
  }
  return sumTR / period;
}

// --- AI 策略大脑 (分级风控输出) ---
async function askAIForDecision(candles) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  
  const ma5 = calcMA(candles, 5);
  const ma10 = calcMA(candles, 10);
  const ma20 = calcMA(candles, 20);
  const rsi = calcRSI(candles, 14);
  const atr = calcATR(candles, 14); 
  
  const volSurge = last.volume > (prev.volume * 1.5) ? "⚠️成交量异常放大(异动)" : "成交量平稳";

  const prompt = `你现在是一个【顶级加密货币交易员】。你需要区分稳健机会和激进机会。

盘面数据（ETH/USDT 15分钟线）：
- 当前价: ${last.close} (本轮最高${last.high}, 最低${last.low})
- 均线状态: MA5=${ma5.toFixed(2)}, MA10=${ma10.toFixed(2)}, MA20=${ma20.toFixed(2)}
- 相对强弱 RSI(14): ${rsi.toFixed(1)}
- 真实波动率 ATR(14): ${atr.toFixed(2)}
- 资金动向: ${volSurge} (当前成交量 ${last.volume.toFixed(2)})

任务要求：
1. 回复开头【必须】是以下五种之一：
   【建议入场：稳健做多】
   【建议入场：激进做多】
   【建议入场：稳健做空】
   【建议入场：激进做空】
   【建议入场：观望】
2. 如果是【激进】入场，必须单独写一行：【风险评估】：预计胜率 xx%，风险较高。
3. 只要建议入场，【必须】提供以下格式的点位：
   【止损价 (SL)】：xxxx (建议全仓止损)
   【第一止盈 (TP1)】：xxxx (建议平仓 50%)
   【第二止盈 (TP2)】：xxxx (建议平仓剩余 50%)
4. 【操作逻辑】：简述你判断的理由。`;

  try {
    const result = await postJSON("https://api.deepseek.com/chat/completions", {
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.5 
    }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });

    if (result.choices && result.choices[0]) return result.choices[0].message.content;
  } catch (e) { console.error("AI 请求失败:", e.message); }
  return "AI 分析暂时不可用";
}

// --- 发信通道 (完美修复 EmailJS 瑕疵) ---
async function sendSignalEmail(action, aiDecisionText, price) {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  
  // 将换行符转为 HTML 的 <br>，防止 EmailJS 吞掉排版！
  const formattedMessage = aiDecisionText.replace(/\n/g, '<br>');

  try {
    await postJSON("https://api.emailjs.com/api/v1.0/email/send", {
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY, 
      accessToken: EMAILJS_PRIVATE_KEY, 
      template_params: { 
        to_email: NOTIFY_EMAIL, 
        symbol: SYMBOL,             // 修复交易对象为空
        interval: "15分钟 K线",       // 修复周期为空
        signal: action, 
        price: price.toString(), 
        message: formattedMessage,  // 包含完美排版的 AI 分析 + 止盈止损
        time: time 
      }
    });
    console.log(`[${time}] ✅ 信号已成功发出: ${action}`);
  } catch (e) {
    console.error(`[${time}] ❌ 邮件发送失败: ${e.message}`);
  }
}

// --- 监控主循环 ---
async function runMonitor() {
  const time = new Date().toLocaleTimeString();
  try {
    const data = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${SYMBOL}&interval=15m&limit=30`);  
    
    if (!Array.isArray(data)) {
        console.error(`[${time}] ⚠️ 币安接口异常跳过`);
        return;
    }

    const candles = data.map(d => ({ open: +d[1], high: +d[2], low: +d[3], close: +d[4], volume: +d[5] }));
    lastPrice = candles[candles.length - 1].close;

    const aiResponse = await askAIForDecision(candles);
    const firstLine = aiResponse.split('\n')[0];
    console.log(`[${time}] AI 结论: ${firstLine}`);

    if (aiResponse.includes("做多") || aiResponse.includes("做空")) {
      // 提取操作类型和风格
      let action = aiResponse.includes("做空") ? "做空" : "做多";
      let style = aiResponse.includes("激进") ? "激进" : "稳健";
      let finalAction = `${style}${action}`;

      const now = Date.now();
      if (finalAction !== lastSignalType || (now - lastSignalTime > SIGNAL_COOLDOWN_MS)) {
        await sendSignalEmail(finalAction, aiResponse, lastPrice);
        lastSignalTime = now;
        lastSignalType = finalAction;
      }
    }
  } catch (e) { console.error("监控循环报错:", e.message); }
}

// --- 存活接口 ---
http.createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ status: "alive", price: lastPrice }));
  } else { res.end("ETH AI is Running"); }
}).listen(process.env.PORT || 3000);

// --- 启动自检 ---
async function startApp() {
    console.log("🚀 系统正在进行启动自检...");
    await sendSignalEmail("系统测试", "你的 AI 已升级为【双轨决策系统】！<br><br>以后它会告诉你这是稳健单还是激进单。如果是激进单，会附带胜率评估。并且每单强制附带 TP1、TP2 和止损位！", 0);
    setInterval(runMonitor, CHECK_INTERVAL_MS);
    runMonitor();
}

startApp();
