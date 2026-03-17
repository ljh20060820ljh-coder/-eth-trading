const https = require('https');
const http = require('http');

// ==========================================
// 🔑 最终核对：已对齐你网页端成功过的所有密钥
// ==========================================
const EMAILJS_SERVICE_ID = "service_op2rg49"; 
const EMAILJS_TEMPLATE_ID = "b9luvb6";           // 采用后台截图显示的 ID
const EMAILJS_PUBLIC_KEY = "8hV-qEj_65-Yjk1Pn";  // 关键修正：使用验证成功的公钥，解决 404 问题
const DEEPSEEK_API_KEY = "sk-9afe367ef974483693b3e829b203dd6b"; 
const NOTIFY_EMAIL = "2183089849@qq.com";

const SYMBOL = "ETHUSDT";
const CHECK_INTERVAL_MS = 60 * 1000;  // 1分钟分析一次，保护 API 额度
const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000; 

let lastSignalTime = 0;
let lastSignalType = null;
let lastPrice = null;

console.log("🚀 ETH AI-Decision Monitor starting...");

// --- 增强型网络请求 (能抓取 HTTP 错误详情) ---
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
        // 如果不是 200，说明 API 报错了
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

// --- DeepSeek AI 决策逻辑 ---
async function askAIForDecision(candles) {
  const last = candles[candles.length - 1];
  const prompt = `你现在是专业的量化操盘手。分析 ETH/USDT 15分钟K线数据：
当前价: ${last.close}，最高${last.high}，最低${last.low}。

任务要求：
1. 必须根据行情判断是否建议入场。
2. 回复格式开头必须是：【建议入场：做多】或【建议入场：做空】或【建议入场：观望】。
3. 请在后面附带简要理由。`;

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

// --- 发送通知邮件 ---
async function sendSignalEmail(action, aiDecisionText, price) {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const msg = `🤖 AI 决策报告\n------------------\n【AI 动作】${action}\n【当前价格】${price}\n【AI 分析理由】\n${aiDecisionText}\n\n【发送时间】${time}`;

  try {
    // 调用 EmailJS 的接口
    await postJSON("https://api.emailjs.com/api/v1.0/email/send", {
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY, // 这里现在是正确的了！
      template_params: { 
        to_email: NOTIFY_EMAIL, 
        signal: action, 
        price: price.toString(), 
        message: msg, 
        time: time 
      }
    });
    console.log(`[${time}] ✅ 信号已发出: ${action} @ ${price}`);
  } catch (e) {
    console.error(`[${time}] ❌ 邮件发送失败! 具体原因: ${e.message}`);
  }
}

// --- 主循环 ---
async function runMonitor() {
  const time = new Date().toLocaleTimeString();
  try {
    const data = await fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=15m&limit=20`);
    const candles = data.map(d => ({ open: +d[1], high: +d[2], low: +d[3], close: +d[4] }));
    lastPrice = candles[candles.length - 1].close;

    console.log(`[${time}] 🔍 正在调取 AI 分析... 当前价: ${lastPrice}`);
    const aiResponse = await askAIForDecision(candles);
    
    // 只记录第一行结论到日志
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

// --- 存活检测服务器 ---
http.createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ status: "alive", price: lastPrice }));
  } else { res.end("Bot Running"); }
}).listen(process.env.PORT || 3000);

// --- 启动逻辑 ---
async function startApp() {
    console.log("🚀 系统正在进行启动自检...");
    // 强制发一封自检信，验证 Key 是否真的修正了
    await sendSignalEmail("系统自检", "如果你收到了这封邮件，说明 Public Key 已修正，404 错误已消失。接下来 AI 喊入场时你就会收到信号了！", 0);
    setInterval(runMonitor, CHECK_INTERVAL_MS);
    runMonitor();
}

startApp();
