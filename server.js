const https = require('https');
const http = require('http');

// ==========================================
// 🔑 终极核对：根据你最新截图完美对齐的密钥
// ==========================================
const EMAILJS_SERVICE_ID = "service_op2rg49"; 
const EMAILJS_TEMPLATE_ID = "template_eftwoy6"; 
const EMAILJS_PUBLIC_KEY = "tlZB9DwwpEKr3KQpQ"; // 修正：首字母小写 t，第二个字母小写 l
const EMAILJS_PRIVATE_KEY = "s76zhOvxmYLR_PDbtTxtg"; // 新增：服务器端发信的终极护身符 (Access Token)

const DEEPSEEK_API_KEY = "sk-9afe367ef974483693b3e829b203dd6b"; 
const NOTIFY_EMAIL = "2183089849@qq.com";

const SYMBOL = "ETHUSDT";
const CHECK_INTERVAL_MS = 60 * 1000;  // 每分钟让 AI 盯盘一次
const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000; // 同一方向信号冷却 30 分钟

let lastSignalTime = 0;
let lastSignalType = null;
let lastPrice = null;

console.log("🚀 ETH AI-Decision Monitor starting...");

// --- 增强型网络请求 ---
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

// --- DeepSeek AI 决策大脑 ---
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

// --- 发送交易信号邮件 ---
async function sendSignalEmail(action, aiDecisionText, price) {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const msg = `🤖 AI 决策报告\n------------------\n【AI 动作】${action}\n【当前价格】${price}\n【AI 分析理由】\n${aiDecisionText}\n\n【发送时间】${time}`;

  try {
    await postJSON("https://api.emailjs.com/api/v1.0/email/send", {
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      accessToken: EMAILJS_PRIVATE_KEY, // 加上了最关键的私钥！再也不会 404 了
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

// --- 后台核心监控循环 ---
async function runMonitor() {
  const time = new Date().toLocaleTimeString();
  try {
    const data = await fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=15m&limit=20`);
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

// --- 存活检测与防休眠接口 ---
http.createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ status: "alive", price: lastPrice }));
  } else { res.end("ETH AI Bot is Running"); }
}).listen(process.env.PORT || 3000);

// --- 启动并执行首次连通性测试 ---
async function startApp() {
    console.log("🚀 系统正在进行启动自检 (发送测试邮件)...");
    // 强制发一封自检邮件，这封信如果到了，这事儿就成了！
    await sendSignalEmail("系统自检", "这封邮件证明私钥配置完美，404 错误彻底解决！现在 AI 已经在云端接管盯盘，当它分析出交易机会时，你会第一时间收到信号。", 0);
    
    setInterval(runMonitor, CHECK_INTERVAL_MS);
    runMonitor();
}

startApp();
