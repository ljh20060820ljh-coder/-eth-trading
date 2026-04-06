const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

process.on('uncaughtException', (err) => { console.error('🔥 [护盾] 异常:', err.message); });
process.on('unhandledRejection', (reason) => { console.error('🔥 [护盾] 拒绝:', reason); });

const FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK || "https://open.feishu.cn/open-apis/bot/v2/hook/6099f609-41c4-4364-b0d8-fdb986b821a2"; 
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

const SYMBOLS = ['SOLUSDT', 'DOGEUSDT', 'ORDIUSDT', 'INJUSDT', 'PEPEUSDT', 'WIFUSDT', 'BONKUSDT', '1000SATSUSDT', 'ARBUSDT', 'TIAUSDT']; 
let precisions = {}; 

const LEVERAGE = 10;                
const POSITION_RISK_PERCENT = 0.5;  

const MOMENTUM_CHECK_MINUTES = 30; 
const MOMENTUM_MIN_PROFIT = 0.01;  
const PROTECT_PROFIT_TRIGGER = 0.01; 
const PROTECT_PROFIT_RETRACEMENT = 0.003; 

const MACRO_STORM_UP = 1.2;    
const MACRO_STORM_DOWN = -1.2; 
const RSI_BUY_LINE = 30;  
const RSI_SELL_LINE = 70; 
const BOUNCE_CONFIRM = 0.005; 

const RR_RATIO = 1.5;         
const MIN_SL_PERCENT = 0.008; 
const MAX_SL_PERCENT = 0.035; 
const EXTREMUM_BUFFER = 0.002; 

let isProcessing = false; 
let activePos = { symbol: 'NONE', status: 'NONE', entryPrice: 0, qty: 0, extremum: null, startTime: 0, maxPnl: 0, mode: 'NORMAL' };
let currentBalance = 0;

function getBJTime() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }

async function sendFeishu(title, message) {
    try {
        if (!FEISHU_WEBHOOK_URL || !FEISHU_WEBHOOK_URL.startsWith("http")) return;
        const options = { hostname: 'open.feishu.cn', path: new URL(FEISHU_WEBHOOK_URL).pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } };
        const req = https.request(options); 
        req.write(JSON.stringify({ msg_type: "text", content: { text: `【${title}】\n------------------\n${message}\n时间: ${getBJTime()}` } })); 
        req.end();
    } catch(e) {}
}

async function binanceReq(path, params, method = 'POST') {
    return new Promise((resolve) => {
        params.timestamp = Date.now();
        const query = querystring.stringify(params);
        let data = query;
        let options = { hostname: 'fapi.binance.com', method, headers: { 'X-MBX-APIKEY': BINANCE_API_KEY }, timeout: 10000 };
        
        if (BINANCE_API_SECRET) {
            const sig = crypto.createHmac('sha256', BINANCE_API_SECRET).update(query).digest('hex');
            data = `${query}&signature=${sig}`;
        }
        
        options.path = method === 'GET' ? `${path}?${data}` : path;
        
        const req = https.request(options, res => {
            let b = ''; res.on('data', c => b += c);
            res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve({code:-999, msg: 'JSON解析失败'}); } });
        });
        req.on('error', (e) => resolve({code:-999, msg: e.message})); 
        if (method === 'POST') req.write(data); 
        req.end();
    });
}

async function initPrecisions() {
    console.log("🔄 [排错] 正在向币安总机请求基础精度数据...");
    const data = await binanceReq('/fapi/v1/exchangeInfo', {}, 'GET');
    if(data && Array.isArray(data.symbols)) {
        data.symbols.forEach(s => {
            if(SYMBOLS.includes(s.symbol)) {
                const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');
                const lotFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
                const getDecimals = (str) => { const numStr = parseFloat(str).toString(); return numStr.includes('.') ? numStr.split('.')[1].length : 0; };
                precisions[s.symbol] = { p: getDecimals(priceFilter.tickSize), q: getDecimals(lotFilter.stepSize) };
            }
        });
        console.log("✅ [排错] 精度数据加载成功，允许开火！");
        sendFeishu("🚀 显微镜排错版上线", "底层通讯正在诊断中...");
    } else {
        console.error("❌ [排错致命错误] 无法获取币安精度数据，返回内容:", data);
    }
}

async function fetchKlines(symbol) {
    return new Promise((resolve) => {
        https.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=20`, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { const raw = JSON.parse(d); resolve(Array.isArray(raw) ? raw.map(k => ({ o: +k[1], h: +k[2], l: +k[3], c: +k[4] })) : null); } catch(e) { resolve(null); } });
        }).on('error', () => resolve(null));
    });
}

function calcRSI(klines) {
    if(!klines) return 50;
    let p=14, ag=0, al=0;
    for(let i=1;i<=p;i++){ let diff = klines[i].c - klines[i-1].c; if(diff > 0) ag += diff; else al -= diff; }
    ag /= p; al /= p; let rsi = 100 - (100 / (1 + (ag / (al || 0.001))));
    for(let i=p+1; i<klines.length; i++){
        let diff = klines[i].c - klines[i-1].c, g = diff > 0 ? diff : 0, l = diff < 0 ? -diff : 0;
        ag = (ag * (p-1) + g) / p; al = (al * (p-1) + l) / p; rsi = 100 - (100 / (1 + (ag / (al || 0.001))));
    }
    return rsi;
}

async function runMonitor() {
    if (isProcessing) return; isProcessing = true;
    try {
        if(Object.keys(precisions).length === 0) { 
            await initPrecisions(); 
            if(Object.keys(precisions).length === 0) {
                console.error("⚠️ [排错] 精度未就绪，中止本次巡航。");
                return; 
            }
        }
        
        console.log("🔄 [排错] 正在验证 API 权限和钱包资产...");
        const risk = await binanceReq('/fapi/v2/positionRisk', {}, 'GET');
        const wallet = await binanceReq('/fapi/v2/account', {}, 'GET');
        
        if(!wallet || !wallet.totalMarginBalance) {
            console.error("❌ [排错致命错误] 无法获取钱包资产！可能原因：API Key 没配对、过期，或者被币安拦截。币安返回:", wallet);
            return;
        }
        
        currentBalance = parseFloat(wallet.totalMarginBalance);
        const pos = Array.isArray(risk) ? risk.find(x => Math.abs(parseFloat(x.positionAmt)) > 0) : null;
        
        const btcK = await fetchKlines('BTCUSDT');
        const btcMacro = (btcK && btcK.length >= 5) ? ((btcK[btcK.length-1].c - btcK[btcK.length-5].o) / btcK[btcK.length-5].o) * 100 : 0;

        // 走到这一步，说明通讯全部正常！
        console.log(`✅ [通讯正常] 资产: ${currentBalance.toFixed(3)} | 宏观大饼: ${btcMacro.toFixed(2)}% | 状态: ${pos?'🔴持仓中':'🟢扫描中'}`);

        if(pos) {
            activePos.symbol = pos.symbol;
            activePos.status = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
            activePos.qty = Math.abs(parseFloat(pos.positionAmt));
            activePos.entryPrice = parseFloat(pos.entryPrice);
            if(activePos.startTime === 0) activePos.startTime = Date.now();
            return;
        } else if(activePos.symbol !== 'NONE') {
            activePos = { symbol: 'NONE', startTime: 0, mode: 'NORMAL', extremum: null, maxPnl: 0 };
        }

        // ... 正常的雷达扫描逻辑 ...
    } finally { isProcessing = false; }
}

http.createServer((req,res)=>{ res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(`<h1>V38.1 显微镜排错版</h1>`); }).listen(process.env.PORT||3000);
setInterval(runMonitor, 60000); runMonitor();
