const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ==========================================
// 🔐 核心配置区 (V14.4 终极完全体 - 完整日志版)
// ==========================================
const FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK || "https://open.feishu.cn/open-apis/bot/v2/hook/6099f609-41c4-4364-b0d8-fdb986b821a2"; 

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
const POSITION_RISK_PERCENT = 0.3; // 🎯 4U本金，动用30%防连续吃损
const MAX_SIMULTANEOUS_POSITIONS = 1; // 🎯 绝对单发狙击
const CHECK_INTERVAL_MS = 2 * 60 * 1000; 
const HARD_STOP_LOSS_PERCENT = 3.0; // 🎯 绝对硬止损 3%

let isProcessing = false; // 🎯 并发安全锁

let positions = {};
SYMBOLS.forEach(sym => {
    positions[sym] = { status: 'NONE', entryPrice: 0, qty: 0, superTrendLine: 0, maxMfe: 0, dynamicStopPrice: 0, entryTime: 0, tradeType: 'NORMAL', penaltyBoxUntil: 0 };
});

function getBJTime() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }

let initialBalance = null; 
let currentBalance = 0;    
let startTimeBJ = getBJTime();

console.log(`🚀 V14.4 终极完全体启动！[动态锁润 | 修复重绘 | 大饼ADX过滤 | 清除残渣]`);

async function sendFeishu(title, message) {
    if (!FEISHU_WEBHOOK_URL || FEISHU_WEBHOOK_URL.includes("这里填入")) return;
    const content = `【${title}】\n------------------\n${message}\n北京时间: ${getBJTime()}`;
    const data = JSON.stringify({ msg_type: "text", content: { text: content } });
    const url = new URL(FEISHU_WEBHOOK_URL);
    const options = { hostname: url.hostname, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json' } };
    const req = https.request(options); req.write(data); req.end();
}

sendFeishu("🔥 V14.4 终极战车已挂载", `长官！V14.4 终极版已上线！\n已装载：60%动态锁润、已收盘防重绘系统、BTC统帅ADX测谎仪！\n请安心卸载软件，狙击手接管战场！`);

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
    for(let i=period; i<dx.length; i++) adx = (adx * (period - 1) + dx[i]) / period;
    return adx; 
}

async function runMonitor() {
    if (isProcessing) return;
    isProcessing = true;

    try {
        // 1. 同步币安真实仓位与硬止损状态
        const risk = await binanceReq('/fapi/v2/positionRisk', {}, 'GET');
        if (Array.isArray(risk)) {
            SYMBOLS.forEach(s => {
                const r = risk.find(item => item.symbol === s);
                if (r) {
                    const amt = parseFloat(r.positionAmt);
                    if (amt === 0 && positions[s].status !== 'NONE') {
                        console.log(`🚨 [防线崩溃] ${s} 已触发硬止损，强制关押 6 小时！`);
                        positions[s].penaltyBoxUntil = Date.now() + 6 * 60 * 60 * 1000;
                        positions[s].status = 'NONE'; positions[s].maxMfe = 0;
                    } else if (amt !== 0) {
                        positions[s].status = amt > 0 ? 'LONG' : 'SHORT';
                        positions[s].qty = Math.abs(amt); 
                        positions[s].entryPrice = parseFloat(r.entryPrice);
                    }
                }
            });
        }

        // 2. 获取可用资金
        const wallet = await binanceReq('/fapi/v2/account', {}, 'GET');
        if (!wallet || wallet.availableBalance === undefined) { 
            console.log(`⚠️ 获取钱包失败，跳过本轮扫描以防误操作。`); 
            isProcessing = false; return; 
        }
        currentBalance = parseFloat(wallet.totalMarginBalance);
        if (initialBalance === null && currentBalance > 0) initialBalance = currentBalance;

        // 3. 呼叫大饼统帅 (包含防重绘与 ADX 测谎仪)
        let btc4h = await fetchKlines('BTCUSDT', '4h', 50);
        if (!btc4h || btc4h.length < 20) { isProcessing = false; return; }
        btc4h = calcSuperTrend(btc4h);
        const btcClosedK = btc4h[btc4h.length - 2]; 
        const btcADX = calcADX(btc4h.slice(0, btc4h.length - 1));
        const btcTrend = btcClosedK.trend;

        console.log(`\n👑 [大盘风控局] BTC 4H已收盘趋势: ${btcTrend === 'LONG' ? '🟢多' : '🔴空'} | 大饼风力(ADX): ${btcADX.toFixed(1)}`);

        // 4. 遍历所有兵种
        for (const symbol of SYMBOLS) {
            let p = positions[symbol];
            
            if (Date.now() < p.penaltyBoxUntil) {
                // 静默禁闭中
                continue;
            }

            let k30m = await fetchKlines(symbol, '30m', 150);
            if (k30m.length < 50) continue;
            k30m = calcSuperTrend(k30m);
            
            // 🎯 防重绘：只取已收盘数据判断进出场
            const curClosedK = k30m[k30m.length - 2];   
            const prevClosedK = k30m[k30m.length - 3];  
            const liveK = k30m[k30m.length - 1]; // 仅用于实时计算现价利润
            
            const adx = calcADX(k30m.slice(0, k30m.length - 1));
            const prevAdx = calcADX(k30m.slice(0, k30m.length - 2));

            // 恢复雷达扫描日志
            let syncStr = (curClosedK.trend === btcTrend) ? '同频✅' : '逆势🚫';
            console.log(`💤 瞄准镜 [${symbol}] | 现价:${liveK.c} | 收盘趋势:${curClosedK.trend==='LONG'?'🟢':'🔴'} (${syncStr}) | 风力:${adx.toFixed(1)}`);

            // ==========================================
            // 🛡️ 状态一：持仓防守与收网
            // ==========================================
            if (p.status !== 'NONE') {
                let roe = p.status === 'LONG' ? (liveK.c - p.entryPrice)/p.entryPrice*100 * LEVERAGE : (p.entryPrice - liveK.c)/p.entryPrice*100 * LEVERAGE;
                if (roe > p.maxMfe) p.maxMfe = roe;

                let shouldClose = false;
                let closeReason = '';

                // 1. 已收盘趋势翻转
                if (p.status === 'LONG' && curClosedK.trend === 'SHORT') { shouldClose = true; closeReason = '已收盘趋势翻红'; }
                if (p.status === 'SHORT' && curClosedK.trend === 'LONG') { shouldClose = true; closeReason = '已收盘趋势翻绿'; }

                // 2. 动能衰竭逃顶 (要求利润>15%)
                if (!shouldClose && roe >= 15) {
                    if (p.status === 'LONG' && curClosedK.c < curClosedK.o && adx < prevAdx) { shouldClose = true; closeReason = '动能衰竭，绝不回吐利润！'; }
                    if (p.status === 'SHORT' && curClosedK.c > curClosedK.o && adx < prevAdx) { shouldClose = true; closeReason = '动能衰竭，绝不回吐利润！'; }
                }

                // 3. 🌟 60% 动态追踪锁润雷达 (利润>20%激活)
                if (!shouldClose && p.maxMfe >= 20) {
                    let dynamicLockLine = p.maxMfe * 0.6; 
                    if (roe <= dynamicLockLine) { 
                        shouldClose = true; 
                        closeReason = `动态锁润线触发！成功锁住最高利润的 60% (${dynamicLockLine.toFixed(1)}%)`; 
                    }
                }

                if (shouldClose) {
                    // 🎯 修复残渣：查询精确到小数点后 N 位的真实仓位再卖出
                    const r2 = await binanceReq('/fapi/v2/positionRisk', { symbol }, 'GET');
                    if (r2 && r2[0]) {
                        const realAmt = Math.abs(parseFloat(r2[0].positionAmt));
                        await binanceReq('/fapi/v1/order', { symbol, side: p.status === 'LONG' ? 'SELL' : 'BUY', type: 'MARKET', quantity: realAmt });
                        await binanceReq('/fapi/v1/allOpenOrders', { symbol }, 'DELETE'); // 撤销硬止损挂单
                        
                        if (roe < 0) {
                            p.penaltyBoxUntil = Date.now() + 6 * 60 * 60 * 1000;
                            sendFeishu(`🩸 战略撤退 [${symbol}]`, `最终结算: ${roe.toFixed(2)}%\n平仓原因: ${closeReason}\n🚫 惩罚生效：关押 6 小时！`);
                        } else {
                            sendFeishu(`💰 狙击收网 [${symbol}]`, `最终结算: ${roe.toFixed(2)}%\n平仓原因: ${closeReason}\n最高曾达: ${p.maxMfe.toFixed(2)}%`);
                        }
                    }
                    p.status = 'NONE'; p.maxMfe = 0;
                } else {
                    let lockStr = p.maxMfe >= 20 ? ` | 动态锁润线:${(p.maxMfe * 0.6).toFixed(1)}%` : ` | 安全底线:-3.0%`;
                    console.log(`🛡️ 守卫中 [${symbol}] | 现价:${liveK.c} | 浮盈:${roe.toFixed(2)}% (最高:${p.maxMfe.toFixed(1)}%)${lockStr}`);
                }
                continue;
            }

            // ==========================================
            // ⚔️ 状态二：起跑线狙击扫描
            // ==========================================
            let activeCount = Object.values(positions).filter(x => x.status !== 'NONE').length;
            if (activeCount >= MAX_SIMULTANEOUS_POSITIONS) {
                // 如果手里有单，绝对不再开第二枪
                continue;
            }

            // 1. 判断是否刚出“已收盘”反转信号
            let signal = 'WAIT';
            if (prevClosedK.trend === 'SHORT' && curClosedK.trend === 'LONG') signal = 'LONG';
            else if (prevClosedK.trend === 'LONG' && curClosedK.trend === 'SHORT') signal = 'SHORT';

            if (signal === 'WAIT') continue;

            // 2. 大盘同频测谎仪
            if (signal !== btcTrend) {
                console.log(`🚫 [风控] ${symbol} 违抗大饼指令，拒绝逆势！`); continue; 
            }
            if (btcADX < 15) {
                console.log(`🚫 [风控] ${symbol} 大饼哥风力极度萎缩(${btcADX.toFixed(1)}<15)，警惕假突破！`); continue; 
            }

            // 3. 猎物起跑线拦截 (ADX >= 22)
            if (adx < 22) {
                console.log(`🚫 [风控] ${symbol} 风力未到台风级(${adx.toFixed(1)}<22)，放弃弱势行情！`); continue;
            }

            // 4. 真金白银量能锁 (1.1 倍)
            let sumVol = 0; for(let i = k30m.length - 12; i < k30m.length - 2; i++) sumVol += k30m[i].v;
            if (curClosedK.v < (sumVol / 10) * 1.1) {
                console.log(`🚫 [风控] ${symbol} 量能萎缩，无量画门坚决不跟！`); continue;
            }

            // 🔫 狙击手开火
            let budget = parseFloat(wallet.availableBalance) * POSITION_RISK_PERCENT; 
            let qty = roundQty(symbol, (budget * LEVERAGE) / liveK.c);
            if (qty * liveK.c < 6.5) qty = roundQty(symbol, 7.0 / liveK.c); // 强行拉升至币安最小订单金额之上

            console.log(`🔥 [${symbol}] 完美符合全条件！扣动扳机！`);
            const side = signal === 'LONG' ? 'BUY' : 'SELL';
            const res = await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: qty });
            
            if (!res.code) {
                p.status = signal; p.qty = qty; p.entryTime = Date.now();
                
                // 延迟2秒，获取精准入场价，挂载硬止损
                setTimeout(async () => {
                    const r3 = await binanceReq('/fapi/v2/positionRisk', { symbol }, 'GET');
                    if (r3 && Array.isArray(r3)) {
                        const myPos = r3.find(item => item.symbol === symbol);
                        if (myPos) {
                            p.entryPrice = parseFloat(myPos.entryPrice);
                            const revSide = signal === 'LONG' ? 'SELL' : 'BUY';
                            const slPrice = signal === 'LONG' ? p.entryPrice * (1 - HARD_STOP_LOSS_PERCENT/100) : p.entryPrice * (1 + HARD_STOP_LOSS_PERCENT/100);
                            
                            // 挂载市价绝对止损单
                            await binanceReq('/fapi/v1/order', { 
                                symbol, side: revSide, type: 'STOP_MARKET', 
                                stopPrice: roundPrice(symbol, slPrice), closePosition: 'true', timeInForce: 'GTC' 
                            });
                            
                            sendFeishu(`🎯 绝地狙击手已开火！`, `标的: ${symbol}\n方向: ${signal === 'LONG'?'🟢多':'🔴空'}\n战机: V14.4 起跑线拦截\n开仓价: ${p.entryPrice}\n物理止损: 设于 ${roundPrice(symbol, slPrice)} (-3%)\n这是全村的希望，祝我们好运！`);
                        }
                    }
                }, 2000);
            }
        }
    } catch(e) { 
        console.error("引擎异常:", e.message); 
    } finally {
        isProcessing = false; // 释放并发锁
    }
}

// Web 面板
http.createServer((req, res) => {
    let realPnl = initialBalance !== null ? (currentBalance - initialBalance) : 0;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<h1>V14.4 绝地终极战车</h1><h3>动态追踪 | 起跑线拦截 | 并发防线</h3><p>剩余本金: ${currentBalance.toFixed(3)} U</p><p>启动至今PNL: ${realPnl.toFixed(3)} U</p>`);
}).listen(process.env.PORT || 3000);

// 🌟 恢复：每小时飞书平安心跳播报！
setInterval(() => {
    let msg = `🎯 狙击手隐蔽待命... 🐺\n`;
    let activePosCount = 0;
    SYMBOLS.forEach(s => { 
        let p = positions[s]; 
        if (p.status !== 'NONE') {
            msg += `- ${s}: 正在守卫 ${p.status} | 最高浮盈:${p.maxMfe.toFixed(1)}%\n`; 
            activePosCount++;
        } else if (Date.now() < p.penaltyBoxUntil) {
            msg += `- ${s}: 🚫 禁闭中 (剩 ${((p.penaltyBoxUntil - Date.now())/3600000).toFixed(1)}H)\n`;
        }
    });
    
    if (activePosCount === 0) msg += `\n- 枪膛已发亮，正在死死盯住 1.1倍放量 和 ADX 22 的鱼头瞬间！`;
    msg += `\n\n(V14.4 运行一切正常，请长官安心现实生活！)`;
    
    sendFeishu("📊 V14.4 平安汇报", msg);
}, 1 * 60 * 60 * 1000); 

setInterval(runMonitor, CHECK_INTERVAL_MS);
runMonitor();
