const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ==========================================
// 🔐 核心配置区 (V12.1 独立狂暴版)
// ==========================================
const FEISHU_WEBHOOK_URL = "https://open.feishu.cn/open-apis/bot/v2/hook/6099f609-41c4-4364-b0d8-fdb986b821a2"; 

const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

// 🛡️ 战车物理参数 (10 人精锐突击队，已切断大盘连坐)
const SYMBOLS = [
    'SOLUSDT', 'ETHUSDT', 'DOGEUSDT', 'BNBUSDT', 
    'XRPUSDT', 'AVAXUSDT', 'ADAUSDT', 'LINKUSDT', 
    'ORDIUSDT', 'INJUSDT'
]; 
// 精度字典 (保障 API 下单不报错)
const PRICE_PRECISION = { 'BTCUSDT': 1, 'ETHUSDT': 2, 'SOLUSDT': 3, 'DOGEUSDT': 5, 'BNBUSDT': 2, 'XRPUSDT': 4, 'AVAXUSDT': 3, 'ADAUSDT': 4, 'LINKUSDT': 3, 'ORDIUSDT': 3, 'INJUSDT': 3 }; 
const QTY_PRECISION = { 'BTCUSDT': 3, 'ETHUSDT': 3, 'SOLUSDT': 1, 'DOGEUSDT': 0, 'BNBUSDT': 2, 'XRPUSDT': 1, 'AVAXUSDT': 1, 'ADAUSDT': 0, 'LINKUSDT': 2, 'ORDIUSDT': 1, 'INJUSDT': 1 }; 

const LEVERAGE = 20;
const POSITION_RISK_PERCENT = 0.25; // 每次开火抽调 25% 的本金
const CHECK_INTERVAL_MS = 2 * 60 * 1000; // 每 2 分钟巡逻一次

// 🎯 状态管理
let positions = {};
SYMBOLS.forEach(sym => {
    positions[sym] = { status: 'NONE', entryPrice: 0, qty: 0, superTrendLine: 0, maxMfe: 0 };
});
let inMemoryDB = { wins: 0, losses: 0, totalPnl: 0, startTime: new Date().toLocaleString() };

console.log("🚀 V12.1 独立狂暴版启动！[10币并发 + 30m主炮 + ADX(18)微风起飞 + 剔除大盘连坐]！");

// ==========================================
// 📡 飞书军用面板引擎
// ==========================================
async function sendFeishu(title, message) {
    if (!FEISHU_WEBHOOK_URL || FEISHU_WEBHOOK_URL.includes("这里填入")) return;
    const content = `【${title}】\n------------------\n${message}\n时间: ${new Date().toLocaleString()}`;
    const data = JSON.stringify({ msg_type: "text", content: { text: content } });
    const url = new URL(FEISHU_WEBHOOK_URL);
    const options = { hostname: url.hostname, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json' } };
    const req = https.request(options); req.write(data); req.end();
}
sendFeishu("⚡ V12.1 独立狂暴模式点火", "长官！战车已砸碎大饼连坐枷锁！10 大妖币将完全凭借自身风力（ADX>18）独立开火！生死看淡，不服就干！");

// ==========================================
// 💸 币安核心执行模块
// ==========================================
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

// ==========================================
// 🧮 华尔街纯血数学库 (纯净版)
// ==========================================
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

// 👑 引擎一：SuperTrend 超级趋势 (参数 10, 3)
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
        klines[i].stLine = st[i]; // 记录防守底线
    }
    return klines;
}

// 🌪️ 引擎二：ADX 测风仪 (参数 14)
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
    return adx; // 返回当前风力值
}

// ==========================================
// 📊 终极作战指挥中枢
// ==========================================
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
            p.status = 'NONE';
        }
    }
}

async function runMonitor() {
    try {
        await checkPositions();
        const snap = await getWallet();
        
        // 注意：BTC大盘探测器已被彻底拆除，不再浪费API请求！

        for (const symbol of SYMBOLS) {
            let p = positions[symbol];
            // 📡 获取山寨主战标的 30分钟线
            let k30m = await fetchKlines(symbol, '30m', 150);
            if (k30m.length < 50) continue;

            // 计算主战武器指标
            k30m = calcSuperTrend(k30m);
            const curWindForce = calcADX(k30m); // 获取 ADX 风力
            
            const curK = k30m[k30m.length - 1];
            const prevK = k30m[k30m.length - 2];
            const curPrice = curK.c;
            const currentTrend = curK.trend;

            // ==========================================
            // 🛡️ 状态一：持仓防守与收网 (严格执行同轨止损)
            // ==========================================
            if (p.status !== 'NONE') {
                // 实时更新当前 SuperTrend 轨道线作为防守底线
                p.superTrendLine = curK.stLine; 
                let mfe = p.status === 'LONG' ? (curPrice - p.entryPrice)/p.entryPrice*100 : (p.entryPrice - curPrice)/p.entryPrice*100;
                if (mfe > p.maxMfe) p.maxMfe = mfe;

                let shouldClose = false;
                let closeReason = '';

                // 物理斩首线：现价跌破/突破 SuperTrend 轨道
                if (p.status === 'LONG' && curPrice < p.superTrendLine) { shouldClose = true; closeReason = '跌破做多生命线，趋势终结！'; }
                if (p.status === 'SHORT' && curPrice > p.superTrendLine) { shouldClose = true; closeReason = '突破做空生命线，趋势终结！'; }

                if (shouldClose) {
                    const side = p.status === 'LONG' ? 'SELL' : 'BUY';
                    await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: p.qty });
                    let pnl = p.status === 'LONG' ? (curPrice - p.entryPrice)*p.qty : (p.entryPrice - curPrice)*p.qty;
                    inMemoryDB.totalPnl += pnl;
                    pnl > 0 ? inMemoryDB.wins++ : inMemoryDB.losses++;
                    
                    sendFeishu(`🩸 战车收网 [${symbol}]`, `平仓原因: ${closeReason}\n最终现价: ${curPrice}\n最高浮盈曾达: ${p.maxMfe.toFixed(2)}%\n净利润估算: ${pnl > 0 ? '🟢 +'+pnl.toFixed(3) : '🔴 '+pnl.toFixed(3)} U`);
                    p.status = 'NONE'; p.maxMfe = 0;
                } else {
                    console.log(`🛡️ [${symbol}] 持仓中 | 现价:${curPrice} | 生命线:${p.superTrendLine.toFixed(PRICE_PRECISION[symbol]||2)} | 浮盈:${mfe.toFixed(2)}%`);
                }
                continue;
            }

            // ==========================================
            // ⚔️ 状态二：空仓埋伏与开火判定
            // ==========================================
            // 锁一：测风仪 (ADX < 18 绝对静默，防震荡磨损)
            if (curWindForce < 18) {
                console.log(`💤 [${symbol}] 测风仪警报: 风力仅 ${curWindForce.toFixed(1)}。低于18，死水休眠中...`);
                continue;
            }

            // 锁二：寻找趋势翻转瞬间 (30m 通道翻色)
            let signal = 'WAIT';
            if (prevK.trend === 'SHORT' && currentTrend === 'LONG') signal = 'LONG';
            if (prevK.trend === 'LONG' && currentTrend === 'SHORT') signal = 'SHORT';

            if (signal === 'WAIT') {
                console.log(`📡 [${symbol}] 30m 主炮瞄准中... 当前趋势: ${currentTrend} | 风力: ${curWindForce.toFixed(1)}`);
                continue;
            }

            // 【注：原锁三“大都督连坐审核”已被最高指挥官彻底拆除，妖币获得独立开火权！】

            // 🔫 双锁全开！物理级开火！
            let budget = snap.available * POSITION_RISK_PERCENT; // 抽调 25% 兵力
            let qty = roundQty(symbol, (budget * LEVERAGE) / curPrice);
            if (qty * curPrice < 6) qty = roundQty(symbol, 6.5/curPrice); // 守住币安 5U 底线

            let requiredMargin = (qty * curPrice / LEVERAGE);
            if (snap.available < requiredMargin) { console.log(`⚠️ [${symbol}] 弹药枯竭，无法开火！`); continue; }

            console.log(`🔥 [${symbol}] 独立风口确立！执行纯血 ${signal} 斩首！兵力: ${qty}`);
            const side = signal === 'LONG' ? 'BUY' : 'SELL';
            const res = await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: qty });
            
            if (!res.code) {
                p.status = signal; p.entryPrice = curPrice; p.qty = qty; p.superTrendLine = curK.stLine;
                // 追加 1.5% 追踪止盈
                const revSide = signal === 'LONG' ? 'SELL' : 'BUY';
                await binanceReq('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: revSide, type: 'TRAILING_STOP_MARKET', callbackRate: '1.5', quantity: qty, reduceOnly: 'true' });
                
                sendFeishu(`🎯 军神战报 | V12.1 狂暴突击`, 
                    `标的: ${symbol} (30m级别)\n方向: ${signal === 'LONG' ? '🟢 独立暴涨跟进' : '🔴 独立瀑布做空'}\n大盘共振: ⚠️ 已切断大盘连坐，妖币独立开火！\n测风仪: ADX=${curWindForce.toFixed(1)} (微风起飞)\n兵力: 25% 仓位 (约 ${requiredMargin.toFixed(2)}U)\n开仓价: ${curPrice}\n钢铁防线: ${p.superTrendLine.toFixed(PRICE_PRECISION[symbol]||2)} (动态同轨止损)`
                );
            }
        }
    } catch(e) { console.error("🔥 引擎异常:", e.message); }
}

// 🌐 战报网页
http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<h1>V12.1 独立狂暴军神</h1><h3>10币并发 | 30m快枪手 + 移除大盘束缚 + ADX(18)微风起飞</h3><p>今日累计预估盈亏: ${inMemoryDB.totalPnl.toFixed(3)} U</p><p>启动时间: ${inMemoryDB.startTime}</p>`);
}).listen(process.env.PORT || 3000);

// 定时播报
setInterval(() => {
    let msg = `💰 今日累计盈亏: ${inMemoryDB.totalPnl.toFixed(3)} U\n🎯 阵地状态:\n`;
    let activePos = false;
    SYMBOLS.forEach(s => { 
        let p = positions[s]; 
        if (p.status !== 'NONE') {
            msg += `- ${s}: ${p.status} | 防线: ${p.superTrendLine.toFixed(PRICE_PRECISION[s]||2)}\n`; 
            activePos = true;
        }
    });
    if (!activePos) msg += `- 全军休眠/瞄准中 💤\n`;
    sendFeishu("📊 V12.1 战区巡航 (狂暴模式运行中)", msg);
}, 2 * 60 * 60 * 1000); // 每2小时发一次报平安

setInterval(runMonitor, CHECK_INTERVAL_MS);
runMonitor();
