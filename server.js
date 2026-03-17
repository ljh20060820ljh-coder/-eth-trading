const https = require('https');
const http = require('http');

// ==========================================
// 🔑 最终核对后的正确配置（已根据你的截图修正）
// ==========================================
const EMAILJS_SERVICE_ID = "service_op2rg49"; 
const EMAILJS_TEMPLATE_ID = "b9luvb6"; // 修正：根据截图 image_4b03a0.png，这是你的真实模板ID
const EMAILJS_PUBLIC_KEY = "8hV-qEj_65-Yjk1Pn"; // 修正：使用你网页端测试成功的那个公钥
const DEEPSEEK_API_KEY = "sk-9afe367ef974483693b3e829b203dd6b"; 
const NOTIFY_EMAIL = "2183089849@qq.com";

const SYMBOL = "ETHUSDT";
const CHECK_INTERVAL_MS = 30 * 1000; // 每 30 秒询问一次 AI
const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000; 

let lastSignalTime = 0;
let lastSignalType = null;
let lastPrice = null;

console.log("🚀 ETH AI-Decision Monitor starting...");

// --- 网络请求函数 ---
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

// --- DeepSeek AI 决策逻辑 ---
async function askAIForDecision(candles) {
  const last = candles[candles.length - 1];
  const prompt = `你现在是专业的量化操盘手。分析 ETH/USDT 15分钟K线：
当前价: ${last.close}，最高${last.high}，最低${last.low}。

任务：
1. 判断目前是否是高胜率入场时机。
2. 回复格式必须严格按照以下：
如果是做多机会，开头必须是：【建议入场：做多】
如果是做空机会，开头必须是：【建议入场：做空】
如果没有机会，开头必须是：【建议入场：观望】
3. 请给出简洁的理由和风险提示。`;

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

// --- 发送信号邮件 ---
async function sendSignalEmail(action, aiDecisionText, price) {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const msg = `🤖 AI 决策报告\n------------------\n【AI 动作】${action}\n【当前价格】${price}\n【分析理由】\n${aiDecisionText}`;

  try {
    await postJSON("https://api.emailjs.com/api/v1.0/email/send", {
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      template_params: { 
        to_email: NOTIFY_EMAIL, 
        signal: action, 
        price: price.toString(), 
        message: msg,
        time: time
      }
    });
    console.log(`[${time}] ✅ AI 信号邮件已送达: ${action} @ ${price}`);
  } catch (e) {
    console.error(`[${time}] ❌ 邮件发送失败: ${e.message}`);
  }
}

// --- 主循环 ---
async function runMonitor() {
  const time = new Date().toLocaleTimeString();
  try {
    const data = await fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=15m&limit=20`);
    const candles = data.map(d => ({ open: +d[1], high: +d[2], low: +d[3], close: +d[4] }));
    lastPrice = candles[candles.length - 1].close;

    const aiResponse = await askAIForDecision(candles);
    console.log(`[${time}] AI 结论: ${aiResponse.slice(0, 50)}...`);
    
    if (aiResponse.includes("【建议入场：做多】") || aiResponse.includes("【建议入场：做空】")) {
      const action = aiResponse.includes("做多") ? "做多" : "做空";
      const now = Date.now();
      if (action !== lastSignalType || (now - lastSignalTime > SIGNAL_COOLDOWN_MS)) {
        await sendSignalEmail(action, aiResponse, lastPrice);
        lastSignalTime = now;
        lastSignalType = action;
      }
    }
  } catch (e) { console.error("运行出错:", e.message); }
}

// --- HTTP 接口 ---
http.createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ status: "alive", price: lastPrice }));
  } else { res.end("Bot Running"); }
}).listen(process.env.PORT || 3000);

setInterval(runMonitor, CHECK_INTERVAL_MS);
runMonitor();
