const https = require('https');
const http = require('http');
const fs = require('fs'); 

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
const LOG_FILE = './trade_log.json'; 

let currentPosition = null; 
let lastPrice = null;
let reflectedToday = false; 

console.log("🚀 ETH 顶级量化 AI (附带精准防误判系统) 已上线...");

// --- 日志读写系统 ---
function loadLogs() {
  if (fs.existsSync(LOG_FILE)) return JSON.parse(fs.readFileSync(LOG_FILE));
  return [];
}
function saveLogs(logs) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}
function addTradeLog(action, style, entryPrice) {
  const logs = loadLogs();
  logs.push({
    id: Date.now().toString(),
    entryTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    entryTimestamp: Date.now(),
    action: action,   
    style: style,     
    entryPrice: entryPrice,
    exitPrice: null,
    exitTime: null,
    holdTime: null,
    roi: null,
    status: 'OPEN'
  });
  saveLogs(logs);
}

// --- 网络请求 ---
function postJSON(url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname, path: urlObj.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(extraHeaders||{}) }
    };
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(options, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${d}`));
        else { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } }
      });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ETH-Monitor/3.1' } }, (res) => {
      let data = ''; res.on('data', chunk => data += chunk);
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
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + (gains / period) / avgLoss));
}
function calcATR(data, period = 14) {
  if (data.length < period + 1) return 0;
  let sumTR = 0;
  for (let i = data.length - period; i < data.length; i++) {
    const high = data[i].high, low = data[i].low, prevClose = data[i-1].close;
    sumTR += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  return sumTR / period;
}

// --- 发信通道 ---
async function sendSignalEmail(action, messageText, price, titleStr) {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const formattedMessage = messageText.replace(/\n/g, '<br>');
  try {
    await postJSON("https://api.emailjs.com/api/v1.0/email/send", {
      service_id: EMAILJS_SERVICE_ID, template_id: EMAILJS_TEMPLATE_ID, user_id: EMAILJS_PUBLIC_KEY, accessToken: EMAILJS_PRIVATE_KEY, 
      template_params: { 
        to_email: NOTIFY_EMAIL, symbol: SYMBOL, interval: titleStr || "15分钟 K线", 
        signal: action, price: price.toString(), message: formattedMessage, time: time 
      }
    });
    console.log(`[${time}] 📧 邮件已发出: ${action}`);
  } catch (e) { console.error(`[${time}] ❌ 发信失败: ${e.message}`); }
}

// --- AI 策略大脑 ---
async function askAIForDecision(candles, currentPos) {
  const last = candles[candles.length - 1], prev = candles[candles.length - 2];
  const ma5 = calcMA(candles, 5), ma10 = calcMA(candles, 10), ma20 = calcMA(candles, 20);
  const rsi = calcRSI(candles, 14), atr = calcATR(candles, 14); 
  const volSurge = last.volume > (prev.volume * 1.5) ? "⚠️成交量异动" : "平稳";
  const posText = currentPos === 'LONG' ? '多单' : currentPos === 'SHORT' ? '空单' : '空仓';

  const prompt = `你是一个顶级量化交易模型。当前数据: 现价${last.close}, MA5=${ma5.toFixed(2)}, RSI=${rsi.toFixed(1)}, ATR=${atr.toFixed(2)}, ${volSurge}。当前持仓: ${posText}。
任务:
【建议方向】：做多 / 做空 / 观望
【信号风格】：稳健 / 激进
【预计胜率】：XX%
(若建议入场，提供 SL, TP1, TP2 点位)
【操作逻辑】：简述理由。`;

  try {
    const res = await postJSON("https://api.deepseek.com/chat/completions", {
      model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.4 
    }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
    return res.choices[0].message.content;
  } catch (e) { return null; }
}

// --- 🧠 AI 每日复盘大脑 ---
async function dailyReflection() {
  const logs = loadLogs();
  const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const todaysTrades = logs.filter(log => log.entryTime.includes(today) && log.status === 'CLOSED');
  
  if (todaysTrades.length === 0) {
      console.log("今日无已平仓交易，跳过复盘。");
      return;
  }

  let tradeSummary = todaysTrades.map(t => 
      `方向: ${t.action}, 风格: ${t.style}, 入场价: ${t.entryPrice}, 出场价: ${t.exitPrice}, 收益率: ${t.roi}%, 持仓时长: ${t.holdTime}`
  ).join('\n');

  const prompt = `你是一个不断进化的 AI 交易员。以下是你今天的交易日志记录：
${tradeSummary}

请进行【每日深夜复盘】：
1. 总结今日的总体表现（胜率、总体盈亏感悟）。
2. 分析盈利单：你做对了什么？指标看准了什么？
3. 反思亏损单：你做错了什么？是被震荡骗了还是格局太小？
4. 明日优化策略：你打算在明天的分析中注意些什么？
回复要专业、深刻，像一个真正的基金经理日记。`;

  try {
    console.log("🧠 正在进行每日深夜复盘...");
    const res = await postJSON("https://api.deepseek.com/chat/completions", {
      model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.7 
    }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
    
    await sendSignalEmail("【AI 每日深度复盘报告】", res.choices[0].message.content, "今日结算", "日记簿");
    console.log("✅ 复盘报告已发送！");
  } catch (e) { console.error("复盘失败", e.message); }
}

// --- 监控主循环 ---
async function runMonitor() {
  const time = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const nowHour = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false });
  const nowMin = new Date().getMinutes();

  if (nowHour === '23' && nowMin >= 50 && !reflectedToday) {
      await dailyReflection();
      reflectedToday = true;
  }
  if (nowHour === '00' && reflectedToday) reflectedToday = false;

  try {
    const data = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${SYMBOL}&interval=15m&limit=30`);  
    if (!Array.isArray(data)) return;
    const candles = data.map(d => ({ open: +d[1], high: +d[2], low: +d[3], close: +d[4], volume: +d[5] }));
    lastPrice = candles[candles.length - 1].close;

    const aiResponse = await askAIForDecision(candles, currentPosition);
    if (!aiResponse) return;
    
    // 🛡️ 终极修复：使用正则精准锁定【建议方向】这一行，绝对不看【操作逻辑】里的字眼
    let targetDir = null;
    const dirMatch = aiResponse.match(/【建议方向】.*?(做多|做空|观望)/);
    if (dirMatch) {
        if (dirMatch[1] === "做多") targetDir = 'LONG';
        else if (dirMatch[1] === "做空") targetDir = 'SHORT';
        else if (dirMatch[1] === "观望") targetDir = 'WAIT';
    }
    
    // 如果连方向都没抓出来，说明AI回答格式彻底乱了，直接跳过
    if (!targetDir) return; 

    // 同理，精准提取风格和胜率
    const styleMatch = aiResponse.match(/【信号风格】.*?(稳健|激进)/);
    const isAggressive = styleMatch ? (styleMatch[1] === "激进") : false;

    const winRateMatch = aiResponse.match(/【预计胜率】[^\d]*(\d+)/);
    const winRate = winRateMatch ? parseInt(winRateMatch[1]) : 0;

    console.log(`[${time}] 🧠 AI决定: 方向=${targetDir}, 风格=${isAggressive?"激进":"稳健"}, 胜率=${winRate}%`);

    let signalToEmail = null;

    if (targetDir === currentPosition) return; 

    if (targetDir === 'WAIT') {
        if (currentPosition !== null) {
            signalToEmail = `【平仓警报】行情走弱，请立即平仓转为观望`;
            currentPosition = null; 
        } else return;
    } else {
        if (isAggressive && winRate < 70) {
            console.log(`[${time}] 🚫 过滤垃圾激进单，胜率仅 ${winRate}%`);
            return;
        }
        
        let actionStr = targetDir === 'LONG' ? "做多" : "做空";
        let styleStr = isAggressive ? "激进" : "稳健";
        
        if (currentPosition === null) signalToEmail = `【建仓指令】${styleStr}${actionStr}`;
        else signalToEmail = `【紧急反手】请平掉原仓位，立刻反向${styleStr}${actionStr}`;
        
        currentPosition = targetDir; 
        addTradeLog(actionStr, styleStr, lastPrice);
    }

    if (signalToEmail) await sendSignalEmail(signalToEmail, aiResponse, lastPrice);
    
  } catch (e) { console.error("循环报错:", e.message); }
}

// --- 🌐 Web 可视化控制台 ---
http.createServer((req, res) => {
  if (req.url === '/api/close' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => {
          const { id, exitPrice } = JSON.parse(body);
          const logs = loadLogs();
          const trade = logs.find(t => t.id === id);
          if (trade) {
              trade.exitPrice = parseFloat(exitPrice);
              trade.exitTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
              const mins = Math.round((Date.now() - trade.entryTimestamp) / 60000);
              trade.holdTime = `${Math.floor(mins / 60)}小时${mins % 60}分钟`;
              let roi = 0;
              if (trade.action === '做多') roi = ((trade.exitPrice - trade.entryPrice) / trade.entryPrice) * 100;
              if (trade.action === '做空') roi = ((trade.entryPrice - trade.exitPrice) / trade.entryPrice) * 100;
              trade.roi = roi.toFixed(2);
              trade.status = 'CLOSED';
              saveLogs(logs);
              res.writeHead(200); res.end(JSON.stringify({success: true}));
          } else {
              res.writeHead(400); res.end(JSON.stringify({error: "Trade not found"}));
          }
      });
      return;
  }
  if (req.url === '/api/logs') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(loadLogs().reverse())); 
      return;
  }
  res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
  res.end(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>ETH 交易控制台</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #121212; color: #fff; margin: 0; padding: 20px; }
            .container { max-width: 1000px; margin: auto; background: #1e1e1e; padding: 20px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
            h2 { color: #00d2ff; border-bottom: 1px solid #333; padding-bottom: 10px; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { padding: 12px; text-align: center; border-bottom: 1px solid #333; }
            th { background: #2d2d2d; color: #aaa; }
            .badge { padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; }
            .bg-green { background: rgba(0, 255, 100, 0.2); color: #00ff64; }
            .bg-red { background: rgba(255, 50, 50, 0.2); color: #ff3232; }
            .bg-blue { background: rgba(0, 150, 255, 0.2); color: #0096ff; }
            input { width: 80px; padding: 6px; background: #333; border: 1px solid #555; color: white; border-radius: 4px; text-align: center; }
            button { padding: 6px 12px; background: #00d2ff; color: #000; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; }
            button:hover { background: #00a8cc; }
        </style>
    </head>
    <body>
        <div class="container">
            <h2>📈 AI 交易日志 & 记账本</h2>
            <p>当前系统状态: <b>运行中</b></p>
            <table>
                <thead>
                    <tr>
                        <th>入场时间</th>
                        <th>方向</th>
                        <th>入场价</th>
                        <th>状态/平仓价</th>
                        <th>持仓时长</th>
                        <th>收益率(ROI)</th>
                        <th>操作</th>
                    </tr>
                </thead>
                <tbody id="logTable"></tbody>
            </table>
        </div>
        <script>
            async function loadData() {
                const res = await fetch('/api/logs');
                const logs = await res.json();
                let html = '';
                logs.forEach(log => {
                    const isLong = log.action === '做多';
                    const dirClass = isLong ? 'bg-green' : 'bg-red';
                    let exitHtml = '', roiHtml = '-', timeHtml = '-', actionHtml = '';
                    if (log.status === 'OPEN') {
                        exitHtml = \`<input type="number" id="exit-\${log.id}" placeholder="输入价格">\`;
                        actionHtml = \`<button onclick="closeTrade('\${log.id}')">保存平仓</button>\`;
                    } else {
                        exitHtml = log.exitPrice;
                        timeHtml = log.holdTime;
                        const isProfit = parseFloat(log.roi) > 0;
                        roiHtml = \`<span class="badge \${isProfit ? 'bg-green' : 'bg-red'}">\${log.roi > 0 ? '+' : ''}\${log.roi}%</span>\`;
                        actionHtml = '<span class="badge bg-blue">已结算</span>';
                    }
                    html += \`<tr>
                        <td>\${log.entryTime.split(' ')[1]}<br><small style="color:#666">\${log.entryTime.split(' ')[0]}</small></td>
                        <td><span class="badge \${dirClass}">\${log.style} \${log.action}</span></td>
                        <td>\${log.entryPrice}</td>
                        <td>\${exitHtml}</td>
                        <td>\${timeHtml}</td>
                        <td>\${roiHtml}</td>
                        <td>\${actionHtml}</td>
                    </tr>\`;
                });
                document.getElementById('logTable').innerHTML = html;
            }
            async function closeTrade(id) {
                const exitPrice = document.getElementById('exit-'+id).value;
                if (!exitPrice) return alert("请输入平仓价！");
                await fetch('/api/close', {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ id, exitPrice })
                });
                loadData();
            }
            loadData();
        </script>
    </body>
    </html>
  `);
}).listen(process.env.PORT || 3000);

// --- 启动自检 ---
async function startApp() {
    console.log("🚀 最新修复补丁已加载...");
    await sendSignalEmail("【系统升级】AI 误判修复完成", "程序已经装上了【正则提取引擎】！<br>现在它会精准读取第一行的建议方向，绝对不会再因为下面一通长篇大论分析解释而误触发了！", 0);
    setInterval(runMonitor, CHECK_INTERVAL_MS);
    runMonitor();
}

startApp();
