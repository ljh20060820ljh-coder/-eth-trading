const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ==========================================
// 🔐 核心配置区 (V12.6 大饼独裁终极版)
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
const POSITION_RISK_PERCENT = 0.25; 
const CHECK_INTERVAL_MS = 2 * 60 * 1000; 

let positions = {};
SYMBOLS.forEach(sym => {
    positions[sym] = { status: 'NONE', entryPrice: 0, qty: 0, superTrendLine: 0, maxMfe: 0, dynamicStopPrice: 0 };
});

function getBJTime() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }

let initialBalance = null; 
let currentBalance = 0;    
let startTimeBJ = getBJTime();

console.log(`🚀 V12.6 大饼独裁终极版启动！[已加入BTC大盘共振过滤 + 失联防爆盾]`);

async function sendFeishu(title, message) {
    if (!FEISHU_WEBHOOK_URL || FEISHU_WEBHOOK_URL.includes("这里填入")) return;
    const content = `【${title}】\n------------------\n${message}\n北京时间: ${getBJTime()}`;
    const data = JSON.stringify({ msg_type: "text", content: { text: content } });
    const url = new URL(FEISHU_WEBHOOK_URL);
    const options = { hostname: url.hostname, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json' } };
    const req = https.request(options); req.write(data); req.end();
}

sendFeishu("⚡ V12.6 战车重新部署", "长官！系统已升级至 V12.6 终极版！【BTC趋势共振过滤】及【断网失联预案】已全功率上线，彻底封死逆势画门陷阱！");

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
    } catch(e) { return { available: 10, total: 10 }; }
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
    for (let i = period; i < klines.length; i++) {
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
        klines[i].stLine = st[i]; 
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
        } else if (amt === 0 && p.status !== 'NONE') {
            p.status = 'NONE'; p.dynamicStopPrice = 0; p.maxMfe = 0;
        }
    }
}

async function runMonitor() {
    try {
        await checkPositions();
        const snap = await getWallet();
        
        if (initialBalance === null && snap.total > 0) { initialBalance = snap.total; }
        currentBalance = snap.total;

        // 👑 【最高优先级】请示 BTC 大饼哥的脸色
        let btcKlines = await fetchKlines('BTCUSDT', '30m', 150);
        
        // [断网防线] 如果没联系上大饼哥，或者数据不够，直接全军静默防爆！
        if (!btcKlines || btcKlines.length < 50) {
             console.log(`⚠️ [大盘风控局] 呼叫BTC大哥失败(网络波动)，全军原地静默，暂不执行新开火！`);
             return; 
        }
        
        btcKlines = calcSuperTrend(btcKlines);
        const btcTrend = btcKlines[btcKlines.length - 1].trend; // 获取大饼当前的趋势
        console.log(`\n👑 [大盘风控局] BTC大哥当前脸色: ${btcTrend === 'LONG' ? '🟢 多头主导' : '🔴 空头主导'}`);

        for (const symbol of SYMBOLS) {
            let p = positions[symbol];
            let k30m = await fetchKlines(symbol, '30m', 150);
            if (k30m.length < 50) continue;

            k30m = calcSuperTrend(k30m);
            const curWindForce = calcADX(k30m); 
            
            const curK = k30m[k30m.length - 1];
            const prevK = k30m[k30m.length - 2];
            const curPrice = curK.c;
            const currentTrend = curK.trend;

            // ==========================================
            // 🛡️ 状态一：持仓防守与收网 (平仓逃命不需要问老大)
            // ==========================================
            if (p.status !== 'NONE') {
                let roe = p.status === 'LONG' ? (curPrice - p.entryPrice)/p.entryPrice*100 * LEVERAGE : (p.entryPrice - curPrice)/p.entryPrice*100 * LEVERAGE;
                if (roe > p.maxMfe) p.maxMfe = roe; 

                if (p.maxMfe >= 20) {
                    let lockRoe = p.maxMfe - 10; 
                    if (p.status === 'LONG') {
                        let calcStop = p.entryPrice * (1 + (lockRoe / 100 / LEVERAGE));
                        if (!p.dynamicStopPrice || calcStop > p.dynamicStopPrice) p.dynamicStopPrice = calcStop;
                    } else {
                        let calcStop = p.entryPrice * (1 - (lockRoe / 100 / LEVERAGE));
                        if (!p.dynamicStopPrice || calcStop < p.dynamicStopPrice) p.dynamicStopPrice = calcStop;
                    }
                }

                let shouldClose = false;
                let closeReason = '';

                if (p.status === 'LONG' && currentTrend === 'SHORT') { shouldClose = true; closeReason = '超级趋势翻红，空头反转斩首！'; }
                if (p.status === 'SHORT' && currentTrend === 'LONG') { shouldClose = true; closeReason = '超级趋势翻绿，多头反转斩首！'; }

                if (!shouldClose && p.dynamicStopPrice) {
                    if (p.status === 'LONG' && curPrice <= p.dynamicStopPrice) { shouldClose = true; closeReason = `触发阶梯止损！强行锁定 ${(p.maxMfe - 10).toFixed(1)}% 利润！`; }
                    if (p.status === 'SHORT' && curPrice >= p.dynamicStopPrice) { shouldClose = true; closeReason = `触发阶梯止损！强行锁定 ${(p.maxMfe - 10).toFixed(1)}% 利润！`; }
                }

                if (shouldClose) {
                    const side = p.status === 'LONG' ? 'SELL' : 'BUY';
                    await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: p.qty });
                    sendFeishu(`🩸 战车强制收网 [${symbol}]`, `平仓原因: ${closeReason}\n最高浮盈曾达: ${p.maxMfe.toFixed(2)}%\n请等待1分钟后查看账户真实余额变化！`);
                    p.status = 'NONE'; p.maxMfe = 0; p.dynamicStopPrice = 0;
                } else {
                    let lockStr = p.dynamicStopPrice ? ` | 锁润线:${p.dynamicStopPrice.toFixed(PRICE_PRECISION[symbol]||2)}` : '';
                    console.log(`🛡️ [${symbol}] 持仓中 | 现价:${curPrice} | ROE:${roe.toFixed(2)}%${lockStr}`);
                }
                continue;
            }

            // ==========================================
            // ⚔️ 状态二：空仓埋伏与开火判定
            // ==========================================
            let trendIcon = currentTrend === 'LONG' ? '🟢多' : '🔴空';
            console.log(`💤 雷达扫描 [${symbol}] | 现价:${curPrice} | 趋势:${trendIcon} | 风力(ADX):${curWindForce.toFixed(2)}`);

            if (curWindForce < 18) { continue; }

            let signal = 'WAIT';
            if (prevK.trend === 'SHORT' && currentTrend === 'LONG') signal = 'LONG';
            if (prevK.trend === 'LONG' && currentTrend === 'SHORT') signal = 'SHORT';

            if (signal === 'WAIT') { continue; }

            // 👑 【大盘过滤机制生效区】
            // 如果战车想逆着大饼做单，直接拦下来！(但大饼自己除外)
            if (symbol !== 'BTCUSDT' && signal !== btcTrend) {
                console.log(`🚫 [风控拦截] ${symbol} 想做 ${signal === 'LONG'?'🟢多':'🔴空'}，但大饼哥脸色是 ${btcTrend === 'LONG'?'🟢多':'🔴空'}，逆势单已强制取消！`);
                continue; // 铁血指令：直接跳过，不准开火！
            }

            let budget = snap.available * POSITION_RISK_PERCENT; 
            let qty = roundQty(symbol, (budget * LEVERAGE) / curPrice);
            if (qty * curPrice < 6) qty = roundQty(symbol, 6.5/curPrice); 

            let requiredMargin = (qty * curPrice / LEVERAGE);
            if (snap.available < requiredMargin) { console.log(`⚠️ [${symbol}] 弹药枯竭，无法开火！`); continue; }

            console.log(`🔥 [${symbol}] 大盘共振确立！执行 ${signal}！兵力: ${qty}`);
            const side = signal === 'LONG' ? 'BUY' : 'SELL';
            const res = await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: qty });
            
            if (!res.code) {
                p.status = signal; p.entryPrice = curPrice; p.qty = qty; 
                
                const revSide = signal === 'LONG' ? 'SELL' : 'BUY';
                await binanceReq('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: revSide, type: 'TRAILING_STOP_MARKET', callbackRate: '3.0', quantity: qty, reduceOnly: 'true' });
                
                sendFeishu(`🎯 军神战报 | V12.6 大盘共振开火`, 
                    `标的: ${symbol}\n方向: ${signal === 'LONG' ? '🟢 做多' : '🔴 做空'}\n投入: 约 ${requiredMargin.toFixed(2)}U\n防线: 3.0%止损 + 棘轮锁润 + BTC大盘顺势！`
                );
            }
        }
    } catch(e) { console.error("🔥 引擎异常:", e.message); }
}

http.createServer((req, res) => {
    let realPnl = initialBalance !== null ? (currentBalance - initialBalance) : 0;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<h1>V12.6 大饼独裁终极版战车</h1><h3>10币并发 | 大盘趋势过滤 + 断网防爆盾</h3><p>本次开机净利润: ${realPnl.toFixed(3)} U</p><p>启动时间(北京): ${startTimeBJ}</p>`);
}).listen(process.env.PORT || 3000);

setInterval(() => {
    let realPnl = initialBalance !== null ? (currentBalance - initialBalance) : 0;
    let msg = `💰 开机至今净利润: ${realPnl.toFixed(3)} U (已扣手续费)\n🎯 阵地状态:\n`;
    let activePos = false;
    SYMBOLS.forEach(s => { 
        let p = positions[s]; 
        if (p.status !== 'NONE') {
            msg += `- ${s}: ${p.status} | 浮盈最高:${p.maxMfe.toFixed(1)}% | 锁润线:${p.dynamicStopPrice ? p.dynamicStopPrice.toFixed(PRICE_PRECISION[s]||2) : '未触发'}\n`; 
            activePos = true;
        }
    });
    if (!activePos) msg += `- 全军休眠/瞄准中 💤\n`;
    sendFeishu("📊 V12.6 战区巡航 (每小时播报)", msg);
}, 1 * 60 * 60 * 1000); 

setInterval(runMonitor, CHECK_INTERVAL_MS);
runMonitor();
