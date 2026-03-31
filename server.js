const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ==========================================
// 🔐 核心配置区 (V14.4 终极完全体)
// ==========================================
const FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK || "https://open.feishu.cn/open-apis/bot/v2/hook/6099f609-41c4-4364-b0d8-fdb986b821a2"; 
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

const SYMBOLS = ['SOLUSDT', 'ETHUSDT', 'DOGEUSDT', 'BNBUSDT', 'XRPUSDT', 'AVAXUSDT', 'ADAUSDT', 'LINKUSDT', 'ORDIUSDT', 'INJUSDT']; 
const PRICE_PRECISION = { 'BTCUSDT': 1, 'ETHUSDT': 2, 'SOLUSDT': 3, 'DOGEUSDT': 5, 'BNBUSDT': 2, 'XRPUSDT': 4, 'AVAXUSDT': 3, 'ADAUSDT': 4, 'LINKUSDT': 3, 'ORDIUSDT': 3, 'INJUSDT': 3 }; 
const QTY_PRECISION = { 'BTCUSDT': 3, 'ETHUSDT': 3, 'SOLUSDT': 1, 'DOGEUSDT': 0, 'BNBUSDT': 2, 'XRPUSDT': 1, 'AVAXUSDT': 1, 'ADAUSDT': 0, 'LINKUSDT': 2, 'ORDIUSDT': 1, 'INJUSDT': 1 }; 

const LEVERAGE = 20; 
const POSITION_RISK_PERCENT = 0.3; // 🎯 4U本金，每次动用30%保证金
const MAX_SIMULTANEOUS_POSITIONS = 1; // 🎯 绝对单发，持仓时不碰其他币
const CHECK_INTERVAL_MS = 2 * 60 * 1000; 
const HARD_STOP_LOSS_PERCENT = 3.0; 

let isProcessing = false; 
let positions = {};
SYMBOLS.forEach(sym => {
    positions[sym] = { status: 'NONE', entryPrice: 0, qty: 0, maxMfe: 0, dynamicStopPrice: 0, entryTime: 0, penaltyBoxUntil: 0 };
});

function getBJTime() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }
let initialBalance = null; 
let currentBalance = 0;    

async function sendFeishu(title, message) {
    if (!FEISHU_WEBHOOK_URL || FEISHU_WEBHOOK_URL.includes("这里填入")) return;
    const content = `【${title}】\n------------------\n${message}\n北京时间: ${getBJTime()}`;
    const data = JSON.stringify({ msg_type: "text", content: { text: content } });
    const url = new URL(FEISHU_WEBHOOK_URL);
    const options = { hostname: url.hostname, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json' } };
    const req = https.request(options); req.write(data); req.end();
}

async function binanceReq(path, params, method = 'POST') {
    params.timestamp = Date.now();
    const query = querystring.stringify(params);
    const sig = crypto.createHmac('sha256', BINANCE_API_SECRET).update(query).digest('hex');
    const data = `${query}&signature=${sig}`;
    const options = {
        hostname: 'fapi.binance.com', path: method === 'GET' ? `${path}?${data}` : path,
        method: method, headers: { 'X-MBX-APIKEY': BINANCE_API_KEY }, timeout: 10000
    };
    return new Promise((resolve) => {
        const req = https.request(options, res => {
            let b = ''; res.on('data', c => b += c);
            res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve({}); } });
        });
        req.on('error', () => resolve({})); if (method === 'POST') req.write(data); req.end();
    });
}

function roundPrice(symbol, price) { let prec = PRICE_PRECISION[symbol] || 2; return parseFloat(parseFloat(price).toFixed(prec)); }
function roundQty(symbol, qty) { let prec = QTY_PRECISION[symbol] || 3; return Math.max(parseFloat(parseFloat(qty).toFixed(prec)), Math.pow(10, -prec)); }

async function fetchKlines(symbol, interval = '30m', limit = 100) {
    return new Promise((resolve) => {
        https.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d).map(k => ({ o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))); } catch(e) { resolve([]); } });
        }).on('error', () => resolve([]));
    });
}

function calcSuperTrend(klines, period = 10, multiplier = 3.0) {
    if (klines.length < period) return null;
    let trs = [0];
    for (let i = 1; i < klines.length; i++) {
        let h = klines[i].h, l = klines[i].l, pc = klines[i-1].c;
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    let atr = []; let sumTR = 0;
    for(let i=1; i<=period; i++) sumTR += trs[i];
    atr[period] = sumTR / period;
    for(let i=period+1; i<klines.length; i++) atr[i] = (atr[i-1] * (period - 1) + trs[i]) / period;

    let st = []; let isUptrend = true; let upperBand = 0; let lowerBand = 0;
    for (let i = 0; i < klines.length; i++) {
        klines[i].atr = atr[i] || 0; 
        if (i < period) continue;
        let hl2 = (klines[i].h + klines[i].l) / 2;
        let basicUB = hl2 + multiplier * atr[i]; let basicLB = hl2 - multiplier * atr[i];
        upperBand = (basicUB < upperBand || klines[i-1].c > upperBand) ? basicUB : upperBand;
        lowerBand = (basicLB > lowerBand || klines[i-1].c < lowerBand) ? basicLB : lowerBand;
        if (st[i-1] === upperBand && klines[i].c > upperBand) isUptrend = true;
        else if (st[i-1] === lowerBand && klines[i].c < lowerBand) isUptrend = false;
        st[i] = isUptrend ? lowerBand : upperBand;
        klines[i].trend = isUptrend ? 'LONG' : 'SHORT';
    }
    return klines;
}

function calcADX(klines, period = 14) {
    if (klines.length < period * 2) return 0;
    let tr = [], pDM = [], nDM = [];
    for(let i=1; i<klines.length; i++) {
        let h = klines[i].h, l = klines[i].l, ph = klines[i-1].h, pl = klines[i-1].l, pc = klines[i-1].c;
        tr.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
        let up = h-ph, dn = pl-l;
        pDM.push(up > dn && up > 0 ? up : 0); nDM.push(dn > up && dn > 0 ? dn : 0);
    }
    const smooth = (arr) => {
        let s = [arr.slice(0, period).reduce((a,b)=>a+b,0)];
        for(let i=period; i<arr.length; i++) s.push(s[s.length-1] - (s[s.length-1]/period) + arr[i]);
        return s;
    };
    let sTR = smooth(tr), sPDM = smooth(pDM), sNDM = smooth(nDM), dx = [];
    for(let i=0; i<sTR.length; i++) {
        let pDI = 100 * (sPDM[i]/sTR[i]), nDI = 100 * (sNDM[i]/sTR[i]);
        dx.push(pDI+nDI === 0 ? 0 : 100 * Math.abs(pDI-nDI)/(pDI+nDI));
    }
    let adx = dx.slice(0, period).reduce((a,b)=>a+b,0)/period;
    for(let i=period; i<dx.length; i++) adx = (adx * (period-1) + dx[i])/period;
    return adx; 
}

async function runMonitor() {
    if (isProcessing) return; isProcessing = true;
    try {
        const risk = await binanceReq('/fapi/v2/positionRisk', {}, 'GET');
        SYMBOLS.forEach(s => {
            const r = risk.find(item => item.symbol === s);
            if (r) {
                const amt = parseFloat(r.positionAmt);
                if (amt === 0 && positions[s].status !== 'NONE') {
                    positions[s].penaltyBoxUntil = Date.now() + 6 * 60 * 60 * 1000; // 🎯 修正：6小时禁闭
                    positions[s].status = 'NONE';
                } else if (amt !== 0) {
                    positions[s].status = amt > 0 ? 'LONG' : 'SHORT';
                    positions[s].qty = Math.abs(amt); positions[s].entryPrice = parseFloat(r.entryPrice);
                }
            }
        });

        const wallet = await binanceReq('/fapi/v2/account', {}, 'GET');
        if (!wallet.availableBalance) { isProcessing = false; return; }
        currentBalance = parseFloat(wallet.totalMarginBalance);
        if (initialBalance === null) initialBalance = currentBalance;

        let btc4h = await fetchKlines('BTCUSDT', '4h', 50);
        btc4h = calcSuperTrend(btc4h);
        const btcClosed = btc4h[btc4h.length - 2];
        const btcADX = calcADX(btc4h.slice(0, btc4h.length - 1));
        const btcTrend = btcClosed.trend;

        for (const symbol of SYMBOLS) {
            let p = positions[symbol];
            if (Date.now() < p.penaltyBoxUntil) continue;
            let k30m = await fetchKlines(symbol, '30m', 100);
            k30m = calcSuperTrend(k30m);
            const curClosedK = k30m[k30m.length - 2], prevClosedK = k30m[k30m.length - 3], liveK = k30m[k30m.length - 1];
            const adx = calcADX(k30m.slice(0, k30m.length - 1)), prevAdx = calcADX(k30m.slice(0, k30m.length - 2));

            if (p.status !== 'NONE') {
                let roe = p.status === 'LONG' ? (liveK.c - p.entryPrice)/p.entryPrice*100*LEVERAGE : (p.entryPrice - liveK.c)/p.entryPrice*100*LEVERAGE;
                if (roe > p.maxMfe) p.maxMfe = roe;
                let shouldClose = false; let reason = '';
                // 1. 趋势翻转
                if (p.status === 'LONG' && curClosedK.trend === 'SHORT') { shouldClose = true; reason = '趋势翻红'; }
                if (p.status === 'SHORT' && curClosedK.trend === 'LONG') { shouldClose = true; reason = '趋势翻绿'; }
                // 2. 动能衰竭 (ROE > 15%)
                if (!shouldClose && roe >= 15) {
                    if (p.status === 'LONG' && curClosedK.c < curClosedK.o && adx < prevAdx) { shouldClose = true; reason = '动能衰竭逃顶'; }
                    if (p.status === 'SHORT' && curClosedK.c > curClosedK.o && adx < prevAdx) { shouldClose = true; reason = '动能衰竭逃顶'; }
                }
                // 3. 动态 60% 锁润 (ROE > 20% 激活)
                if (!shouldClose && p.maxMfe >= 20) {
                    let lockLine = p.maxMfe * 0.6; // 🎯 修正：锁住最高利润的 60%
                    if (roe <= lockLine) { shouldClose = true; reason = `动态锁润触发(${lockLine.toFixed(1)}%)`; }
                }
                if (shouldClose) {
                    // 🎯 修复1：平仓前询问实时仓位，彻底解决残渣问题
                    const r2 = await binanceReq('/fapi/v2/positionRisk', { symbol }, 'GET');
                    const realAmt = Math.abs(parseFloat(r2[0].positionAmt));
                    await binanceReq('/fapi/v1/order', { symbol, side: p.status==='LONG'?'SELL':'BUY', type:'MARKET', quantity: realAmt });
                    await binanceReq('/fapi/v1/allOpenOrders', { symbol }, 'DELETE');
                    sendFeishu(`💰 狙击收网 [${symbol}]`, `结算: ${roe.toFixed(2)}%\n原因: ${reason}`);
                    p.status = 'NONE'; p.maxMfe = 0;
                }
                continue;
            }

            // ⚔️ 狙击扫描
            if (Object.values(positions).some(x => x.status !== 'NONE')) continue; // 🎯 绝对单发
            if (prevClosedK.trend === curClosedK.trend) continue; 
            if (curClosedK.trend !== btcTrend || btcADX < 15) continue; // 🎯 统帅测谎仪
            if (adx < 22) continue; // 🎯 起跑线拦截

            let sumV = 0; for(let i=k30m.length-12; i<k30m.length-2; i++) sumV += k30m[i].v;
            if (curClosedK.v < (sumV/10)*1.1) continue; // 🎯 1.1倍放量

            let qty = roundQty(symbol, (parseFloat(wallet.availableBalance) * POSITION_RISK_PERCENT * LEVERAGE) / liveK.c);
            if (qty * liveK.c < 6.5) qty = roundQty(symbol, 7 / liveK.c);

            const res = await binanceReq('/fapi/v1/order', { symbol, side: curClosedK.trend==='LONG'?'BUY':'SELL', type: 'MARKET', quantity: qty });
            if (!res.code) {
                setTimeout(async () => {
                    const r3 = await binanceReq('/fapi/v2/positionRisk', { symbol }, 'GET');
                    const ep = parseFloat(r3[0].entryPrice);
                    const sl = curClosedK.trend==='LONG' ? ep*(1-HARD_STOP_LOSS_PERCENT/100) : ep*(1+HARD_STOP_LOSS_PERCENT/100);
                    await binanceReq('/fapi/v1/order', { symbol, side: curClosedK.trend==='LONG'?'SELL':'BUY', type: 'STOP_MARKET', stopPrice: roundPrice(symbol, sl), closePosition: 'true' });
                    sendFeishu(`🎯 狙击开火`, `标的: ${symbol}\n硬止损: ${roundPrice(symbol, sl)}`);
                }, 2000);
            }
        }
    } catch(e) {} finally { isProcessing = false; }
}

http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<h1>V14.4 终极战车</h1><p>净利润: ${(currentBalance-(initialBalance||currentBalance)).toFixed(3)} U</p>`);
}).listen(process.env.PORT || 3000);
setInterval(runMonitor, CHECK_INTERVAL_MS); 
runMonitor();
