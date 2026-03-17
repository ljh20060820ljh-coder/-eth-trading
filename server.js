const https = require('https');
const http = require('http');

// ==========================================
// 🔑 核心配置区（请再次核对以下 ID）
// ==========================================
const EMAILJS_SERVICE_ID = "service_op2rg49"; 
// 注意：如果 template_eftwoy6 不发，请尝试换成截图里的 "b9luvb6"
const EMAILJS_TEMPLATE_ID = "template_eftwoy6"; 
const EMAILJS_PUBLIC_KEY = "tIZB9DwwpEKr3KQpQ"; 
const DEEPSEEK_API_KEY = "sk-9afe367ef974483693b3e829b203dd6b"; 
const NOTIFY_EMAIL = "2183089849@qq.com";

const SYMBOL = "ETHUSDT";
const CHECK_INTERVAL_MS = 30 * 1000; // AI 决策模式下建议 30-60秒一次，节省 API 额度
const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000; // 信号冷却 30 分钟

let lastSignalTime = 0;
let lastSignalType = null;
let lastPrice = null;

console.log("🚀 ETH AI-Decision Monitor starting...");

// --- 增强版：网络请求函数（能精准捕获错误） ---
function postJSON(url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Content-Length': Buffer.byteLength(data), 
        ...(extraHeaders||{}) 
      }
    };
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        // 如果状态码不是 200，说明邮件提供商拒绝了请求
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${d}`));
        } else {
          try { resolve(JSON.parse(d)); } catch(e) { resolve(d); }
        }
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

// --- 核心逻辑：DeepSeek AI 决策 ---
async function askAIForDecision(candles) {
  const last = candles[candles.length - 1];
  const rsi = calcRSI(candles);
  const ma5 = calcMA(candles, 5);
  const ma10 = calcMA(candles, 10);
  
  // 构造给 AI 的分析数据
  const prompt = `你现在是专业的量化操盘手。分析 ETH/USDT 15分钟K线：
当前价: ${last.close}
MA5: ${ma5.toFixed(2)}, MA10: ${ma10.toFixed(2)}
RSI: ${rsi ? rsi.toFixed(1) : 'N/A'}
最新K线: ${last.close > last.open ? '阳线' : '阴线'}，最高${last.high}，最低${last.low}

任务：
1. 判断目前是否是高胜率入场时机（做多/做空）。
2. 如果建议入场，请分析理由并给出止损和止盈。
3. 如果不建议，请回复观望。

回复格式必须包含：【建议入场：做多/做空/观望】+ 详细理由 + 止损价 + 止盈价。`;

  try {
    const result = await postJSON("https://api.deepseek.com/chat/completions", {
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3
    }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });

    if (result.choices && result.choices[0]) {
      return result.choices[0].message.content;
    }
  } catch (e) {
    console.error("AI 决策请求失败:", e.message);
  }
  return "AI 分析暂时不可用";
}

// --- 发送交易信号邮件 ---
async function sendSignalEmail(action, aiDecisionText, price) {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const msg = `🤖 AI 决策报告\n------------------\n【AI 动作】${action}\n【入场价格】${price}\n【时间】${time}\n\n【详细分析与风控建议】\n${aiDecisionText}`;

  try {
    await postJSON("https://api.emailjs.com/api/v1.0/email/send", {
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      template_params: { 
        to_email: NOTIFY_EMAIL, 
        signal: `AI 信号: ${action}`, 
        price: price.toString(), 
        message: msg,
        time: time
      }
    });
    console.log(`[${time}] ✅ AI 信号邮件已送达: ${action} @ ${price}`);
  } catch (e) {
    console.error(`[${time}] ❌ 邮件发送失败! 错误原因: ${e.message}`);
  }
}

// --- 指标计算辅助 ---
function calcMA(data, p) { return data.slice(-p).reduce((s, c) => s + c.close, 0) / p; }
function calcRSI(data, p = 14) {
  if (data.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = data.length - p; i < data.length; i++) {
    const d = data[i].close - data[i-1].close;
    if (d > 0) g += d; else l -= d;
  }
  return 100 - (100 / (1 + (g/p)/(l/p)));
}

// --- 主循环 ---
async function runMonitor() {
  const time = new Date().toLocaleTimeString();
  try {
    const data = await fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=15m&limit=50`);
    const candles = data.map(d => ({ open: +d[1], high: +d[2], low: +d[3], close: +d[4] }));
    lastPrice = candles[candles.length - 1].close;

    console.log(`[${time}] 🔍 正在请求 AI 分析盘面... 当前价: ${lastPrice}`);

    // 让 AI 决定
    const aiResponse = await askAIForDecision(candles);
    
    if (aiResponse.includes("【建议入场：做多】") || aiResponse.includes("【建议入场：做空】")) {
      const action = aiResponse.includes("做多") ? "LONG" : "SHORT";
      const now = Date.now();

      // 冷却检查
      if (action !== lastSignalType || (now - lastSignalTime > SIGNAL_COOLDOWN_MS)) {
        console.log(`[${time}] ⚡ AI 发出指令: ${action}! 正在发送邮件...`);
        await sendSignalEmail(action, aiResponse, lastPrice);
        lastSignalTime = now;
        lastSignalType = action;
      } else {
        console.log(`[${time}] ⏳ AI 建议入场，但处于冷却期，已忽略。`);
      }
    } else {
      console.log(`[${time}] 🧘 AI 建议观望。分析理由: ${aiResponse.slice(0, 30)}...`);
    }
  } catch (e) {
    console.error(`[${time}] 运行出错:`, e.message);
  }
}

// --- HTTP 状态接口 ---
http.createServer((req, res) => {
  if (req.url === '/status') {
    res.end(JSON.stringify({ status: "alive", price: lastPrice, lastSignal: lastSignalType }));
  } else {
    res.end("Bot is running");
  }
}).listen(process.env.PORT || 3000);

// 启动执行
setInterval(runMonitor, CHECK_INTERVAL_MS);
runMonitor();
