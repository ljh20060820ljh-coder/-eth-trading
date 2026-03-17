const https = require('https');
const http = require('http');

// ==========================================
// 🔑 终极完美版密钥（已全部对齐，私钥已加）
// ==========================================
const EMAILJS_SERVICE_ID = "service_op2rg49"; 
const EMAILJS_TEMPLATE_ID = "template_eftwoy6"; 
const EMAILJS_PUBLIC_KEY = "tIZB9DwwpEKr3KQpQ"; // 大写的 I，完全正确！
const EMAILJS_PRIVATE_KEY = "s76zhOvxmYLR_PDbtTxtg"; // 服务器端必备护身符

const DEEPSEEK_API_KEY = "sk-9afe367ef974483693b3e829b203dd6b"; 
const NOTIFY_EMAIL = "2183089849@qq.com";

const SYMBOL = "ETHUSDT";
const CHECK_INTERVAL_MS = 60 * 1000; 
const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000;

let lastSignalTime = 0;
let lastSignalType = null;
let lastPrice = null;

console.log("🚀 ETH AI-Decision Monitor starting...");

// --- 增强版网络请求 ---
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

// --- DeepSeek AI 大脑 ---
async function askAIForDecision(candles) {
  const last = candles[candles.length - 1];
  const prompt = `你现在是专业的量化操盘手。分析 ETH/USDT 15分钟K线数据：
当前价: ${last.close}，最高${last.high}，最低${last.low}。

任务要求：
1. 判断是否建议入场。
2. 回复开头必须是：【建议入场：做多】或【建议入场：做空】或【建议入场：观望】。
3. 请附带简短理由。`;

  try {
    const result = await postJSON("https://api.deepseek.com/chat/completions", {
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3
    }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });

    if (result.choices && result.choices[0]) return result.choices[0].message.content;
  } catch (e) { console.error("AI 决策请求失败:", e.message); }
  return "AI 分析暂时不可用";
}

// --- 发信通道 ---
async function sendSignalEmail(action, aiDecisionText, price) {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const msg = `🤖 AI 决策报告\n------------------\n【AI 动作】${action}\n【当前价格】${price}\n【AI 分析理由】\n${aiDecisionText}\n\n【发送时间】${time}`;

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
    console.log(`[${time}] ✅ 信号已成功发出: ${action} @ ${price}`);
  } catch (e) {
    console.error(`[${time}] ❌ 邮件发送失败! 具体原因: ${e.message}`);
  }
}

// --- 监控主循环 ---
async function runMonitor() {
  const time = new Date().toLocaleTimeString();
  try {
    // ✅ 替换成这行新的（换成 Binance 官方的数据专线接口）：

  const data = await fetchJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${SYMBOL}&interval=15m&limit=20`);  
    // 🛡️ 终极防御伞：防止币安接口抽风导致报错崩溃
    if (!Array.isArray(data)) {
        console.error(`[${time}] ⚠️ 币安接口返回异常或被限流，跳过本次分析`);
        return;
    }

    const candles = data.map(d => ({ open: +d[1], high: +d[2], low: +d[3], close: +d[4] }));
    lastPrice = candles[candles.length - 1].close;

    console.log(`[${time}] 🔍 正在调取 AI 分析... 当前价: ${lastPrice}`);
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
  } else { res.end("ETH AI Bot is Running"); }
}).listen(process.env.PORT || 3000);

// --- 启动自检 ---
async function startApp() {
    console.log("🚀 系统正在进行启动自检 (发送测试邮件)...");
    await sendSignalEmail("系统自检", "历经千辛万苦，九九八十一难！403 和 404 错误已全面剿灭！当你收到这封信，证明云端发信通道已经彻彻底底打通。接下来就交给 AI 去帮你赚钱吧！", 0);
    setInterval(runMonitor, CHECK_INTERVAL_MS);
    runMonitor();
}

startApp();
