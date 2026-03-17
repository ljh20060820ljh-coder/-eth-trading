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
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5分钟盯盘

// 🧠 核心升级：机器人的“仓位记忆大脑”
let currentPosition = null; // 'LONG' (多单) | 'SHORT' (空单) | null (空仓)

let lastPrice = null;

console.log("🚀 ETH 顶级量化 AI (附带胜率过滤与仓位记忆) 已上线...");

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

// --- 技术指标 ---
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

// --- AI 策略大脑 (知道自己现在的持仓状态) ---
async function askAIForDecision(candles, currentPos) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  
  const ma5 = calcMA(candles, 5);
  const ma10 = calcMA(candles, 10);
  const ma20 = calcMA(candles, 20);
  const rsi = calcRSI(candles, 14);
  const atr = calcATR(candles, 14); 
  
  const volSurge = last.volume > (prev.volume * 1.5) ? "⚠️成交量异常放大" : "成交量平稳";
  
  // 翻译机器人的持仓状态给 AI 听
  const posText = currentPos === 'LONG' ? '持有多单 (看涨)' : currentPos === 'SHORT' ? '持有空单 (看跌)' : '空仓观望';

  const prompt = `你是一个顶级加密货币量化交易模型。

【最新盘面数据】（ETH/USDT 15分钟线）：
- 当前价: ${last.close} (本轮最高${last.high}, 最低${last.low})
- 均线状态: MA5=${ma5.toFixed(2)}, MA10=${ma10.toFixed(2)}, MA20=${ma20.toFixed(2)}
- 相对强弱 RSI(14): ${rsi.toFixed(1)}
- 真实波动率 ATR(14): ${atr.toFixed(2)}
- 资金动向: ${volSurge}
- 🚨 目前你的持仓状态: 【${posText}】

【任务要求】（必须严格按以下格式输出）：
【建议方向】：做多 / 做空 / 观望 （三选一。如果目前持仓趋势是对的，请继续输出原方向；如果该平仓避险了，请输出观望；如果趋势反转，输出相反方向）
【信号风格】：稳健 / 激进 （二选一）
【预计胜率】：XX% （必须填入 0 到 100 的纯数字）

（如果建议做多/做空，必须提供以下点位；如果建议观望则不用写）：
【止损价 (SL)】：xxxx 
【第一止盈 (TP1)】：xxxx 
【第二止盈 (TP2)】：xxxx 

【操作逻辑】：简述理由。`;

  try {
    const result = await postJSON("https://api.deepseek.com/chat/completions", {
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4 
    }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });

    if (result.choices && result.choices[0]) return result.choices[0].message.content;
  } catch (e) { console.error("AI 请求失败:", e.message); }
  return "AI 分析暂时不可用";
}

// --- 发信通道 ---
async function sendSignalEmail(action, aiDecisionText, price) {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const formattedMessage = aiDecisionText.replace(/\n/g, '<br>');

  try {
    await postJSON("https://api.emailjs.com/api/v1.0/email/send", {
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY, 
      accessToken: EMAILJS_PRIVATE_KEY, 
      template_params: { 
        to_email: NOTIFY_EMAIL, 
        symbol: SYMBOL,             
        interval: "15分钟 K线",       
        signal: action, // 这里会显示：开仓、反手、或平仓
        price: price.toString(), 
        message: formattedMessage,  
        time: time 
      }
    });
    console.log(`[${time}] 📧 邮件已发出: ${action}`);
  } catch (e) {
    console.error(`[${time}] ❌ 邮件发送失败: ${e.message}`);
  }
}

// --- 监控主循环 (核心风控逻辑) ---
async function runMonitor() {
  const time = new Date().toLocaleTimeString();
  try {
    const data = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${SYMBOL}&interval=15m&limit=30`);  
    if (!Array.isArray(data)) return;

    const candles = data.map(d => ({ open: +d[1], high: +d[2], low: +d[3], close: +d[4], volume: +d[5] }));
    lastPrice = candles[candles.length - 1].close;

    // 告诉 AI 我们现在的仓位，让它做决定
    const aiResponse = await askAIForDecision(candles, currentPosition);
    if (!aiResponse) return;
    
    // 1. 提取 AI 决定的方向
    let targetDirection = null;
    if (aiResponse.includes("做多")) targetDirection = 'LONG';
    else if (aiResponse.includes("做空")) targetDirection = 'SHORT';
    else if (aiResponse.includes("观望")) targetDirection = 'WAIT';

    if (!targetDirection) return; 

    // 2. 提取胜率和风格
    const isAggressive = aiResponse.includes("激进");
    const winRateMatch = aiResponse.match(/预计胜率[^\d]*(\d+)/);
    const winRate = winRateMatch ? parseInt(winRateMatch[1]) : 0;

    console.log(`[${time}] 🧠 AI思考结果: 方向=${targetDirection}, 风格=${isAggressive?"激进":"稳健"}, 胜率=${winRate}%`);

    // ==========================================
    // 🛡️ 拦截器与状态机逻辑开始
    // ==========================================
    let signalToEmail = null;

    // 拦截器 1：完全相同的趋势 -> 拿住不发邮件
    if (targetDirection === currentPosition) {
        console.log(`[${time}] 🛡️ 趋势延续，系统已自动拦截重复信号。当前建议：继续拿住。`);
        return; 
    }

    // 拦截器 2：要求观望
    if (targetDirection === 'WAIT') {
        if (currentPosition !== null) {
            // 原来有仓位，现在要求观望 -> 发送平仓邮件！
            signalToEmail = `【平仓警报】行情走弱，请立即平仓转为观望`;
            currentPosition = null; // 更新状态为空仓
        } else {
            // 原来就是空仓，现在还是观望 -> 不发邮件
            console.log(`[${time}] 🛡️ 震荡行情，继续空仓观望，不发邮件。`);
            return;
        }
    } 
    // 拦截器 3：要求开仓（做多/做空）
    else {
        // 🚨 胜率过滤：激进单且胜率低于70%，直接丢弃！
        if (isAggressive && winRate < 70) {
            console.log(`[${time}] 🚫 垃圾信号过滤：激进单且胜率 (${winRate}%) 低于 70%，放弃入场！`);
            return;
        }

        let actionStr = targetDirection === 'LONG' ? "做多" : "做空";
        let styleStr = isAggressive ? "激进" : "稳健";
        
        if (currentPosition === null) {
            // 原来空仓 -> 正常开仓
            signalToEmail = `【建仓指令】${styleStr}${actionStr}`;
        } else {
            // 原来有多单，现在喊做空 -> 紧急反手
            signalToEmail = `【紧急反手】请平掉原仓位，立刻反向${styleStr}${actionStr}`;
        }
        
        currentPosition = targetDirection; // 更新状态为新的方向
    }

    // 通过了所有层层选拔，才能发邮件给你！
    if (signalToEmail) {
        await sendSignalEmail(signalToEmail, aiResponse, lastPrice);
    }
    
  } catch (e) { console.error("监控循环报错:", e.message); }
}

// --- 存活接口 ---
http.createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ status: "alive", position: currentPosition || "空仓" }));
  } else { res.end("ETH AI Trade Engine is Running"); }
}).listen(process.env.PORT || 3000);

// --- 启动自检 ---
async function startApp() {
    console.log("🚀 终极防骚扰挂机版启动...");
    await sendSignalEmail("【系统升级】防骚扰模块激活", "现在系统已经有了仓位记忆！<br>相同的方向它会叫你【拿住】且不发邮件吵你；如果趋势变了，它会发【平仓】或【反手】邮件。<br>并且，所有胜率低于 70% 的激进单已经被彻底封杀屏蔽！", 0);
    setInterval(runMonitor, CHECK_INTERVAL_MS);
    runMonitor();
}

startApp();
