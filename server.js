const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ==========================================
// 🔐 核心配置区 (V14.0 绝地求生·单发狙击版)
// ==========================================
const FEISHU_WEBHOOK_URL = "https://open.feishu.cn/open-apis/bot/v2/hook/6099f609-41c4-4364-b0d8-fdb986b821a2"; 

const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

const SYMBOLS = [
    'SOLUSDT', 'ETHUSDT', 'DOGEUSDT', 'BNBUSDT', 
    'XRPUSDT', 'AVAXUSDT', 'ADAUSDT', 'LINKUSDT', 
    'ORDIUSDT', 'INJUSDT'
]; 
const PRICE_PRECISION = { 'BTCUSDT': 1, 'ETHUSDT': 2, 'SOLUSDT': 3, 'DOGEUSDT': 5, 'BNBUSDT': 2, 'XRPUSDT': 4, 'AVAXUSDT': 3, 'ADAUSDT': 4, 'LINKUSDT': 3, 'ORDIUSDT': 3, 'INJUSDT': 3 }; 
const QTY_PRECISION = { 'BTCUSDT': 3, 'ETHUSDT': 3, 'SOLUSDT': 1, 'DOGEUSDT': 0, 'BNBUSDT': 2, 'XRPUSDT': 1, 'AVAXUSDT': 1, 'ADAUSDT': 0, 'LINKUSDT': 2, 'ORDIUSDT': 1, 'INJUSDT': 1 }; 

const LEVERAGE = 20; 
const POSITION_RISK_PERCENT = 0.5; // 🎯 提高单笔投入比例，应对4U小资金
const MAX_SIMULTANEOUS_POSITIONS = 1; // 🎯 孤注一掷：同一时间只狙击一个标的
const CHECK_INTERVAL_MS = 2 * 60 * 1000; 

let positions = {};
SYMBOLS.forEach(sym => {
    positions[sym] = { status: 'NONE', entryPrice: 0, qty: 0, superTrendLine: 0, maxMfe: 0, dynamicStopPrice: 0, entryTime: 0, tradeType: 'NORMAL', penaltyBoxUntil: 0 };
});

function getBJTime() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }

let initialBalance = null; 
let currentBalance = 0;    
let startTimeBJ = getBJTime();

console.log(`🚀 V14.0 绝地求生启动！[单发狙击模式 | 12H禁闭 | 仅打同频顺势]`);

async function sendFeishu(title, message) {
    if (!FEISHU_WEBHOOK_URL || FEISHU_WEBHOOK_URL.includes("这里填入")) return;
    const content = `【${title}】\n------------------\n${message}\n北京时间: ${getBJTime()}`;
    const data = JSON.stringify({ msg_type: "text", content: { text: content } });
    const url = new URL(FEISHU_WEBHOOK_URL);
    const options = { hostname: url.hostname, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json' } };
    const req = https.request(options); req.write(data); req.end();
}

sendFeishu("🔥 V14.0 背水一战上线", `长官！系统已切换至 4U 绝地狙击模式！\n1. 严禁逆势！只做同频单！\n2. 严禁贪多！并发限制为1！\n3. 12小时重刑禁闭，绝不交连续学费！`);

async function binanceReq(path, params, method = 'POST') {
    params.timestamp = Date.now();
    const query = querystring.stringify(params);
    const sig = crypto.createHmac('sha256', BINANCE_API_SECRET).update(query).digest('hex');
    const data = `${query}&signature=${sig}`;
    const options = {
        hostname: 'fapi.binance.com', path: method === 'GET' ? `${path}?${data}` : path,
        method: method, headers: { 'X-MBX-APIKEY': BINANCE_API_KEY }, timeout: 10000
    };
    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let b = ''; res.on('data', c => b += c);
            res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve(b); } });
        });
        req.on('error', reject); if (method === 'POST') req.write(data); req.end();
    });
}

async function getWallet() {
    try {
        const res = await binanceReq('/fapi/v2/account', {}, 'GET');
        return { available: parseFloat(res.availableBalance), total: parseFloat(res.totalMarginBalance) };
    } catch(e) { return { available: 4, total: 4 }; }
}

function roundQty(symbol, qty) { let prec = QTY_PRECISION[symbol] || 3; return Math.max(parseFloat(parseFloat(qty).toFixed(prec)), Math.pow(10, -prec)); }

async function fetchKlines(symbol, interval = '30m', limit = 100) {
    return new Promise((resolve) => {
        https.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, {timeout: 10000}, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { 
                const data = JSON.parse(d).map(k => ({ o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })); 
                resolve(data);
            } catch(e) { resolve([]); } });
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
        let prevUB = upperBand; let prevLB = lowerBand; let prevClose = klines[i-1].c;

        upperBand = (basicUB < prevUB || prevClose > prevUB) ? basicUB : prevUB;
        lowerBand = (basicLB > prevLB || prevClose < prevLB) ? basicLB : prevLB;

        if (st[i-1] === prevUB && klines[i].c <= upperBand) isUptrend = false;
        else if (st[i-1] === prevUB && klines[i].c >= upperBand) isUptrend = true;
        else if (st[i-1] === prevLB && klines[i].c >= lowerBand) isUptrend = true;
        else if (st[i-1] === prevLB && klines[i].c <= lowerBand) isUptrend = false;

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
        let upMove = h - ph, downMove = pl - l;
        pDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
        nDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }
    const smooth = (arr) => {
        let s = [arr.slice(0, period).reduce((a,b)=>a+b,0)];
        for(let i=period; i<arr.length; i++) s.push(s[s.length-1] - (s[s.length-1]/period) + arr[i]);
        return s;
    };
    let sTR = smooth(tr), sPDM = smooth(pDM), sNDM = smooth(nDM);
    let dx = [];
    for(let i=0; i<sTR.length; i++) {
        let pDI = 100 * (sPDM[i] / sTR[i]), nDI = 100 * (sNDM[i] / sTR[i]);
        let diff = Math.abs(pDI - nDI), sum = pDI + nDI;
        dx.push(sum === 0 ? 0 : 100 * (diff / sum));
    }
    let adx = dx.slice(0, period).reduce((a,b)=>a+b,0) / period;
    for(let i=period; i<dx.length; i++) adx = (adx * 13 + dx[i]) / period;
    return adx; 
}

async function checkPositions() {
    const risk = await binanceReq('/fapi/v2/positionRisk', {}, 'GET');
    if (!Array.isArray(risk)) return;

    for (const symbol of SYMBOLS) {
        let p = positions[symbol];
        const r = risk.find(item => item.symbol === symbol);
        if (!r) continue;
        
        const amt = parseFloat(r.positionAmt);
        if (amt !== 0 && p.status === 'NONE') {
            p.status = amt > 0 ? 'LONG' : 'SHORT'; p.entryPrice = parseFloat(r.entryPrice); p.qty = Math.abs(amt);
            p.entryTime = Date.now(); 
        } else if (amt === 0 && p.status !== 'NONE') {
            // 🛡️ V14.0 铁律：物理防线触碰，直接关押 12 小时！
            console.log(`🚨 [防线崩溃] ${symbol} 已触发硬止损，全军禁闭 12 小时！`);
            p.penaltyBoxUntil = Date.now() + 12 * 60 * 60 * 1000;
            p.status = 'NONE'; p.dynamicStopPrice = 0; p.maxMfe = 0; p.entryTime = 0;
        }
    }
}

async function runMonitor() {
    try {
        await checkPositions();
        const snap = await getWallet();
        if (initialBalance === null) initialBalance = snap.total;
        currentBalance = snap.total;

        let btc4hKlines = await fetchKlines('BTCUSDT', '4h', 50);
        if (!btc4hKlines || btc4hKlines.length < 20) return;
        btc4hKlines = calcSuperTrend(btc4hKlines);
        const btcTrend4H = btc4hKlines[btc4hKlines.length - 1].trend;

        for (const symbol of SYMBOLS) {
            let p = positions[symbol];
            if (Date.now() < p.penaltyBoxUntil) continue;

            let k30m = await fetchKlines(symbol, '30m', 150);
            if (k30m.length < 50) continue;
            k30m = calcSuperTrend(k30m);
            const curWindForce = calcADX(k30m);
            const prevWindForce = calcADX(k30m.slice(0, k30m.length - 1));
            
            const curK = k30m[k30m.length - 1];
            const prevK = k30m[k30m.length - 2];
            const curPrice = curK.c;
            const currentTrend = curK.trend;

            // ==========================================
            // 🛡️ 持仓管理 (V14.0 绝地防守)
            // ==========================================
            if (p.status !== 'NONE') {
                let roe = p.status === 'LONG' ? (curPrice - p.entryPrice)/p.entryPrice*100 * LEVERAGE : (p.entryPrice - curPrice)/p.entryPrice*100 * LEVERAGE;
                if (roe > p.maxMfe) p.maxMfe = roe;

                let shouldClose = false;
                let closeReason = '';

                // 1. 趋势反转斩首
                if (p.status === 'LONG' && currentTrend === 'SHORT') { shouldClose = true; closeReason = '趋势翻红'; }
                if (p.status === 'SHORT' && currentTrend === 'LONG') { shouldClose = true; closeReason = '趋势翻绿'; }

                // 2. 动能衰竭主动逃顶 (ROE > 15%)
                if (!shouldClose && roe >= 15) {
                    if (p.status === 'LONG' && curK.c < curK.o && curWindForce < prevWindForce) { shouldClose = true; closeReason = '动能衰竭逃顶'; }
                    else if (p.status === 'SHORT' && curK.c > curK.o && curWindForce < prevWindForce) { shouldClose = true; closeReason = '动能衰竭逃顶'; }
                }

                // 3. 物理锁润
                if (p.maxMfe >= 20) {
                    let lockRoe = p.maxMfe - 10;
                    let calcStop = p.status === 'LONG' ? p.entryPrice * (1 + (lockRoe/100/LEVERAGE)) : p.entryPrice * (1 - (lockRoe/100/LEVERAGE));
                    if (p.status === 'LONG' && (!p.dynamicStopPrice || calcStop > p.dynamicStopPrice)) p.dynamicStopPrice = calcStop;
                    if (p.status === 'SHORT' && (!p.dynamicStopPrice || calcStop < p.dynamicStopPrice)) p.dynamicStopPrice = calcStop;
                }

                if (!shouldClose && p.dynamicStopPrice) {
                    if (p.status === 'LONG' && curPrice <= p.dynamicStopPrice) { shouldClose = true; closeReason = `锁润线触发`; }
                    if (p.status === 'SHORT' && curPrice >= p.dynamicStopPrice) { shouldClose = true; closeReason = `锁润线触发`; }
                }

                if (shouldClose) {
                    const side = p.status === 'LONG' ? 'SELL' : 'BUY';
                    await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: p.qty });
                    
                    if (roe < 0) {
                        p.penaltyBoxUntil = Date.now() + 12 * 60 * 60 * 1000;
                        sendFeishu(`🩸 狙击失败 [${symbol}]`, `结算: ${roe.toFixed(2)}%\n原因: ${closeReason}\n🚫 惩罚生效：关押 12 小时！`);
                    } else {
                        sendFeishu(`💰 凯旋收网 [${symbol}]`, `结算: ${roe.toFixed(2)}%\n最高浮盈: ${p.maxMfe.toFixed(2)}%`);
                    }
                    p.status = 'NONE'; p.maxMfe = 0; p.dynamicStopPrice = 0;
                }
                continue;
            }

            // ==========================================
            // ⚔️ 狙击扫描 (V14.0 飓风级筛选)
            // ==========================================
            let signal = 'WAIT';
            if (prevK.trend === 'SHORT' && currentTrend === 'LONG') signal = 'LONG';
            else if (prevK.trend === 'LONG' && currentTrend === 'SHORT') signal = 'SHORT';

            if (signal === 'WAIT') continue;

            // 1. 禁令检查：必须与大饼 4H 同向！
            if (signal !== btcTrend4H) continue; 

            // 2. 飓风检查：ADX 必须 > 25！
            if (curWindForce < 25) continue;

            // 3. 量能锁：必须大于近10根均量 1.2 倍！
            let sumVol = 0; for(let i = k30m.length - 11; i < k30m.length - 1; i++) sumVol += k30m[i].v;
            if (curK.v < (sumVol / 10) * 1.2) continue;

            // 4. 并发限制：只打 1 发子弹！
            let activeCount = Object.values(positions).filter(x => x.status !== 'NONE').length;
            if (activeCount >= MAX_SIMULTANEOUS_POSITIONS) continue;

            // 🔫 狙击开火
            let budget = snap.available * POSITION_RISK_PERCENT; 
            let qty = roundQty(symbol, (budget * LEVERAGE) / curPrice);
            if (qty * curPrice < 6.5) qty = roundQty(symbol, 6.5/curPrice); // 强行拉过币安 5U 线

            console.log(`🔥 [${symbol}] 锁定！正在进行背水一战狙击！`);
            const side = signal === 'LONG' ? 'BUY' : 'SELL';
            const res = await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: qty });
            
            if (!res.code) {
                const revSide = signal === 'LONG' ? 'SELL' : 'BUY';
                await binanceReq('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: revSide, type: 'TRAILING_STOP_MARKET', callbackRate: '3.0', quantity: qty, reduceOnly: 'true' });
                sendFeishu(`🎯 狙击手就位`, `标的: ${symbol}\n方向: ${signal === 'LONG'?'🟢多':'🔴空'}\n投入: 约 ${budget.toFixed(2)}U\n这是最后的弹药，祝我们好运！`);
            }
        }
    } catch(e) { console.error("引擎异常:", e.message); }
}

http.createServer((req, res) => {
    let realPnl = initialBalance !== null ? (currentBalance - initialBalance) : 0;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<h1>V14.0 绝地狙击战车</h1><p>剩余本金: ${currentBalance.toFixed(3)} U</p><p>启动至今PNL: ${realPnl.toFixed(3)} U</p>`);
}).listen(process.env.PORT || 3000);

setInterval(runMonitor, CHECK_INTERVAL_MS);
runMonitor();
