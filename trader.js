const https = require('https');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws'); // 需要安装 ws 库

// ============================================================
// 配置区 - 建议在 Render 环境变量中设置，这里作为备选
// ============================================================
const BINANCE_API_KEY = process.env.BINANCE_API_KEY || 'yfVasX0Ajqeb8IrauKvr6Le3jjW2ZoYvcWehSqXP1T5QCymmDZAmWVJUYdDVkmgX';
const BINANCE_SECRET = process.env.BINANCE_SECRET || 'kTS00yZ1TIfHHcWqTvZXd3e7D5PVaCrXIvshCK2bsZ110z7PzMxysUVA074zzBjG';

const EMAILJS_SERVICE_ID = "service_op2rg49";
const EMAILJS_TEMPLATE_ID = "template_eftwoy6";
const EMAILJS_PUBLIC_KEY = "8hV-qEj_65-Yjk1Pn";
const NOTIFY_EMAIL = "2183089849@qq.com";
const SYMBOL = "ETHUSDT";
const CHECK_INTERVAL_MS = 30 * 1000; // 调至 30 秒，保护 IP
const SIGNAL_COOLDOWN_MS = 15 * 60 * 1000;

// ============================================================
// 全局状态
// ============================================================
let PAPER_TRADING = true; 
let monitorEnabled = true;
let lastSignalTime = 0;
let lastSignalType = null;
let lastPrice = null;
let currentPosition = null;
let dailyPnL = 0;
let dailyStartBalance = 0;
let tradeHistory = [];
let consecutiveLosses = 0;

// ============================================================
// WebSocket 行情实时更新逻辑 (新增)
// ============================================================
function initPriceSocket() {
    const wsUrl = `wss://fstream.binance.com/ws/${SYMBOL.toLowerCase()}@markPrice`;
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => console.log(`[WS] Connected to Binance for ${SYMBOL} real-time price`));
    
    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.p) {
            lastPrice = parseFloat(msg.p); // 实时更新全局最新价格
        }
    });

    ws.on('error', (e) => console.log('[WS] Error:', e.message));
    
    ws.on('close', () => {
        console.log('[WS] Disconnected. Reconnecting in 5s...');
        setTimeout(initPriceSocket, 5000);
    });
}

// 启动 WebSocket
initPriceSocket();

// ============================================================
// 工具函数 (保持不变)
// ============================================================
function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        mod.get(url, { headers: { 'User-Agent': 'ETH-Trader/1.0' } }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
        }).on('error', reject);
    });
}

function postJSON(url, body, headers) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const urlObj = new URL(url);
        const opts = {
            hostname: urlObj.hostname, path: urlObj.pathname, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(headers||{}) }
        };
        const mod = url.startsWith('https') ? https : http;
        const req = mod.request(opts, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
        });
        req.on('error', reject);
        req.write(data); req.end();
    });
}

function signQuery(params) {
    const query = Object.entries(params).map(([k,v]) => `${k}=${v}`).join('&');
    return query + '&signature=' + crypto.createHmac('sha256', BINANCE_SECRET).update(query).digest('hex');
}

function binanceRequest(method, path, params) {
    return new Promise((resolve, reject) => {
        params.timestamp = Date.now();
        params.recvWindow = 5000;
        const query = signQuery(params);
        const options = {
            hostname: 'fapi.binance.com',
            path: path + (method === 'GET' ? '?' + query : ''),
            method,
            headers: { 'X-MBX-APIKEY': BINANCE_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }
        };
        const req = https.request(options, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
        });
        req.on('error', reject);
        if (method !== 'GET') req.write(query);
        req.end();
    });
}

// ============================================================
// 核心逻辑 (技术分析 & 风控 - 保持不变)
// ============================================================
function calcMA(data, p) { if (data.length < p) return null; return data.slice(-p).reduce((s,c) => s+c.close, 0) / p; }
function calcRSI(data, p=14) {
    if (data.length < p+1) return null;
    let g=0, l=0;
    for (let i=data.length-p; i<data.length; i++) {
        const d = data[i].close - data[i-1].close;
        if (d>0) g+=d; else l-=d;
    }
    return l===0 ? 100 : 100-(100/(1+ (g/p)/(l/p)));
}
function calcATR(data, p=14) {
    if (data.length < p+1) return 10;
    let sum=0; const slice = data.slice(-p);
    for (let i=0; i<slice.length; i++) {
        if (i===0) { sum+=slice[i].high-slice[i].low; continue; }
        sum += Math.max(slice[i].high-slice[i].low, Math.abs(slice[i].high-slice[i-1].close), Math.abs(slice[i].low-slice[i-1].close));
    }
    return sum/p;
}

function detectSignal(data) {
    if (!data||data.length<22) return null;
    const last=data.length-1;
    const ma5=calcMA(data,5), ma10=calcMA(data,10), ma20=calcMA(data,20);
    const ma5p=calcMA(data.slice(0,-1),5), ma10p=calcMA(data.slice(0,-1),10);
    if (!ma5||!ma10||!ma20) return null;
    const bull=ma5>ma10 && ma10>ma20 && ma5p<=ma10p && data[last].close>ma5;
    const bear=ma5<ma10 && ma10<ma20 && ma5p>=ma10p && data[last].close<ma5;
    if (bull) return {type:'LONG', label:'做多', rsi:calcRSI(data), atr:calcATR(data)};
    if (bear) return {type:'SHORT', label:'做空', rsi:calcRSI(data), atr:calcATR(data)};
    return null;
}

// (此处省略 calcDynamicParams, calcTPSL, getBalance, openPosition, closePosition 等中间件函数，保持你原来的逻辑即可)
// 【重要】：请保留你代码中这些函数的原样，或者直接使用你之前完整脚本中的对应部分。

// ============================================================
// 主检测循环 (修改处：降低对 K线的拉取频率)
// ============================================================
async function checkSignal() {
    if (!monitorEnabled) return;
    try {
        // 获取K线依然需要REST，但通过长连接获取Price，我们可以把这里的限制放宽
        const data = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL}&interval=1m&limit=100`);
        if (!Array.isArray(data)) { 
            console.log(`[API Error] 触发频率限制或IP被封。当前价格: ${lastPrice || '未知'}`);
            return; 
        }
        const candles = data.map(d => ({time:d[0],open:+d[1],high:+d[2],low:+d[3],close:+d[4]}));
        
        if (currentPosition) {
            await checkPosition(candles);
            return;
        }

        const sig = detectSignal(candles);
        if (sig && sig.type !== lastSignalType) {
            const balance = await getBalance();
            const params = calcDynamicParams(sig, balance); // 需确保此函数存在
            if (!params) return;
            const tpsl = calcTPSL(candles, sig.type); // 需确保此函数存在
            await openPosition(sig, params, tpsl, lastPrice);
            lastSignalType = sig.type;
        }
    } catch(e) { console.log("CheckSignal Error:", e.message); }
}

// ============================================================
// 服务器启动
// ============================================================
const server = http.createServer((req, res) => {
    res.writeHead(200); res.end("Trader is Running");
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    setInterval(checkSignal, CHECK_INTERVAL_MS);
});

// 为了节省篇幅，请确保将你原代码中的 calcDynamicParams, calcTPSL, getBalance, 
// openPosition, closePosition, checkPosition, sendTradeEmail 函数原封不动贴回此脚本。
