const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ==========================================
// 🔐 核心配置区 (V15.0 震荡收割机 RSI+布林带版)
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
const POSITION_RISK_PERCENT = 0.4; // 🎯 小资金应对，使用40%资金确保过币安5U门槛
const MAX_SIMULTANEOUS_POSITIONS = 1; 
const CHECK_INTERVAL_MS = 2 * 60 * 1000; 
const HARD_STOP_LOSS_PERCENT = 3.0; // 硬止损兜底

let isProcessing = false; 

let positions = {};
SYMBOLS.forEach(sym => {
    positions[sym] = { status: 'NONE', entryPrice: 0, qty: 0, maxMfe: 0, entryTime: 0, penaltyBoxUntil: 0 };
});

function getBJTime() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }

let initialBalance = null; 
let currentBalance = 0;    

console.log(`🚀 V15.0 震荡收割机启动！[RSI超买超卖 + 布林带反弹 + 均值回归出场]`);

async function sendFeishu(title, message) {
    if (!FEISHU_WEBHOOK_URL || FEISHU_WEBHOOK_URL.includes("这里填入")) return;
    const content = `【${title}】\n------------------\n${message}\n北京时间: ${getBJTime()}`;
    const data = JSON.stringify({ msg_type: "text", content: { text: content } });
    const url = new URL(FEISHU_WEBHOOK_URL);
    const options = { hostname: url.hostname, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json' } };
    const req = https.request(options); req.write(data); req.end();
}

sendFeishu("🔥 V15.0 震荡收割模式上线", `长官！已全面弃用趋势策略，更换为【RSI+布林带】震荡收割战车！\n专接暴跌带血筹码，专空狂热追高大军！吃完反弹中轨立刻跑！`);

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

// 🎯 新增武器：计算 RSI (相对强弱指数)
function calcRSI(klines, period = 14) {
    if (klines.length < period + 1) return klines;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        let change = klines[i].c - klines[i-1].c;
        if (change > 0) gains += change; else losses -= change;
    }
    let avgGain = gains / period; let avgLoss = losses / period;
    klines[period].rsi = 100 - (100 / (1 + (avgGain / (avgLoss === 0 ? 0.0001 : avgLoss))));

    for (let i = period + 1; i < klines.length; i++) {
        let change = klines[i].c - klines[i-1].c;
        let gain = change > 0 ? change : 0; let loss = change < 0 ? -change : 0;
        avgGain = ((avgGain * (period - 1)) + gain) / period;
        avgLoss = ((avgLoss * (period - 1)) + loss) / period;
        klines[i].rsi = 100 - (100 / (1 + (avgGain / (avgLoss === 0 ? 0.0001 : avgLoss))));
    }
    return klines;
}

// 🎯 新增武器：计算 Bollinger Bands (布林带)
function calcBollingerBands(klines, period = 20, multiplier = 2) {
    for(let i = 0; i < klines.length; i++) {
        if(i < period - 1) { klines[i].bbUpper = null; klines[i].bbMid = null; klines[i].bbLower = null; continue; }
        let sum = 0;
        for(let j = 0; j < period; j++) sum += klines[i-j].c;
        let sma = sum / period;
        
        let sqSum = 0;
        for(let j = 0; j < period; j++) sqSum += Math.pow(klines[i-j].c - sma, 2);
        let stdDev = Math.sqrt(sqSum / period);
        
        klines[i].bbUpper = sma + multiplier * stdDev;
        klines[i].bbMid = sma;
        klines[i].bbLower = sma - multiplier * stdDev;
    }
    return klines;
}

// 依然保留 ADX 用于过滤单边趋势
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
        const risk = await binanceReq('/fapi/v2/positionRisk', {}, 'GET');
        if (Array.isArray(risk)) {
            SYMBOLS.forEach(s => {
                const r = risk.find(item => item.symbol === s);
                if (r) {
                    const amt = parseFloat(r.positionAmt);
                    if (amt === 0 && positions[s].status !== 'NONE') {
                        console.log(`🚨 [防线崩溃] ${s} 触发物理止损，关押 6 小时防报复！`);
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

        const wallet = await binanceReq('/fapi/v2/account', {}, 'GET');
        if (!wallet || wallet.availableBalance === undefined) { 
            isProcessing = false; return; 
        }
        currentBalance = parseFloat(wallet.totalMarginBalance);
        if (initialBalance === null && currentBalance > 0) initialBalance = currentBalance;

        for (const symbol of SYMBOLS) {
            let p = positions[symbol];
            
            if (Date.now() < p.penaltyBoxUntil) continue;

            let k30m = await fetchKlines(symbol, '30m', 150);
            if (k30m.length < 50) continue;
            
            // 装载指标
            k30m = calcBollingerBands(k30m);
            k30m = calcRSI(k30m);
            const adx = calcADX(k30m.slice(0, k30m.length - 1));
            
            // 依然坚持防重绘，使用已收盘 K 线判断入场
            const curClosedK = k30m[k30m.length - 2];   
            const liveK = k30m[k30m.length - 1]; 

            if (!curClosedK.bbMid || !curClosedK.rsi) continue;

            console.log(`💤 瞄准镜 [${symbol}] | 现价:${liveK.c} | RSI:${curClosedK.rsi.toFixed(1)} | ADX风力:${adx.toFixed(1)}`);

            // ==========================================
            // 🛡️ 状态一：持仓防守与均值回归出场
            // ==========================================
            if (p.status !== 'NONE') {
                let roe = p.status === 'LONG' ? (liveK.c - p.entryPrice)/p.entryPrice*100 * LEVERAGE : (p.entryPrice - liveK.c)/p.entryPrice*100 * LEVERAGE;
                if (roe > p.maxMfe) p.maxMfe = roe;

                let shouldClose = false;
                let closeReason = '';

                // 🎯 核心出场：价格回归中轨（Mean Reversion）
                // 用活K线判断，一旦触碰立刻落袋！
                if (p.status === 'LONG' && liveK.c >= curClosedK.bbMid) {
                    shouldClose = true; closeReason = '均值回归：触碰布林带中轨止盈！';
                }
                if (p.status === 'SHORT' && liveK.c <= curClosedK.bbMid) {
                    shouldClose = true; closeReason = '均值回归：触碰布林带中轨止盈！';
                }

                if (shouldClose) {
                    const r2 = await binanceReq('/fapi/v2/positionRisk', { symbol }, 'GET');
                    if (r2 && r2[0]) {
                        const realAmt = Math.abs(parseFloat(r2[0].positionAmt));
                        await binanceReq('/fapi/v1/order', { symbol, side: p.status === 'LONG' ? 'SELL' : 'BUY', type: 'MARKET', quantity: realAmt });
                        await binanceReq('/fapi/v1/allOpenOrders', { symbol }, 'DELETE'); 
                        
                        sendFeishu(`💰 震荡收割 [${symbol}]`, `最终结算: ${roe.toFixed(2)}%\n平仓原因: ${closeReason}`);
                    }
                    p.status = 'NONE'; p.maxMfe = 0;
                } else {
                    console.log(`🛡️ 守卫中 [${symbol}] | 现价:${liveK.c} | 中轨目标:${curClosedK.bbMid.toFixed(PRICE_PRECISION[symbol]||2)} | 浮盈:${roe.toFixed(2)}%`);
                }
                continue;
            }

            // ==========================================
            // ⚔️ 状态二：超买超卖狙击扫描
            // ==========================================
            let activeCount = Object.values(positions).filter(x => x.status !== 'NONE').length;
            if (activeCount >= MAX_SIMULTANEOUS_POSITIONS) continue; 

            // 🌪️ 风控：震荡策略最怕单边，ADX > 25 绝对不开枪！
            if (adx >= 25) {
                console.log(`🚫 [风控拦截] ${symbol} 风力过大(${adx.toFixed(1)})，疑似单边行情，拒绝接飞刀！`);
                continue;
            }

            let signal = 'WAIT';
            let tactic = '';

            // 🟢 极度恐慌：跌破下轨 + RSI超卖 (<30)
            if (curClosedK.c < curClosedK.bbLower && curClosedK.rsi < 30) {
                signal = 'LONG'; tactic = '超卖抄底 (接血筹码)';
            }
            // 🔴 极度狂热：突破上轨 + RSI超买 (>70)
            else if (curClosedK.c > curClosedK.bbUpper && curClosedK.rsi > 70) {
                signal = 'SHORT'; tactic = '超买摸顶 (狙击狂热)';
            }

            if (signal === 'WAIT') continue;

            // 🔫 狙击手开火
            let budget = parseFloat(wallet.availableBalance) * POSITION_RISK_PERCENT; 
            let qty = roundQty(symbol, (budget * LEVERAGE) / liveK.c);
            if (qty * liveK.c < 6.5) qty = roundQty(symbol, 7.0 / liveK.c); 

            console.log(`🔥 [${symbol}] 触发【${tactic}】！果断出击！`);
            const side = signal === 'LONG' ? 'BUY' : 'SELL';
            const res = await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: qty });
            
            if (!res.code) {
                p.status = signal; p.qty = qty; p.entryTime = Date.now();
                
                setTimeout(async () => {
                    const r3 = await binanceReq('/fapi/v2/positionRisk', { symbol }, 'GET');
                    if (r3 && Array.isArray(r3)) {
                        const myPos = r3.find(item => item.symbol === symbol);
                        if (myPos) {
                            p.entryPrice = parseFloat(myPos.entryPrice);
                            const revSide = signal === 'LONG' ? 'SELL' : 'BUY';
                            const slPrice = signal === 'LONG' ? p.entryPrice * (1 - HARD_STOP_LOSS_PERCENT/100) : p.entryPrice * (1 + HARD_STOP_LOSS_PERCENT/100);
                            
                            await binanceReq('/fapi/v1/order', { 
                                symbol, side: revSide, type: 'STOP_MARKET', 
                                stopPrice: roundPrice(symbol, slPrice), closePosition: 'true', timeInForce: 'GTC' 
                            });
                            
                            sendFeishu(`🎯 震荡狙击已开火！`, `标的: ${symbol}\n方向: ${signal === 'LONG'?'🟢做多(接刀)':'🔴做空(摸顶)'}\n战机: ${tactic}\nRSI: ${curClosedK.rsi.toFixed(1)}\n开仓价: ${p.entryPrice}\n目标中轨: ${curClosedK.bbMid.toFixed(PRICE_PRECISION[symbol]||2)}\n硬止损: ${roundPrice(symbol, slPrice)} (-3%)`);
                        }
                    }
                }, 2000);
            }
        }
    } catch(e) { 
        console.error("引擎异常:", e.message); 
    } finally {
        isProcessing = false; 
    }
}

// Web 面板
http.createServer((req, res) => {
    let realPnl = initialBalance !== null ? (currentBalance - initialBalance) : 0;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<h1>V15.0 震荡收割机</h1><h3>RSI超卖 | 布林反弹 | 均值回归</h3><p>剩余本金: ${currentBalance.toFixed(3)} U</p><p>启动至今PNL: ${realPnl.toFixed(3)} U</p>`);
}).listen(process.env.PORT || 3000);

// 每小时心跳
setInterval(() => {
    let msg = `🎯 震荡收割机巡航中... 🐒\n`;
    let activePosCount = 0;
    SYMBOLS.forEach(s => { 
        let p = positions[s]; 
        if (p.status !== 'NONE') {
            msg += `- ${s}: 正在守卫 ${p.status} | 浮盈:${p.maxMfe.toFixed(1)}%\n`; 
            activePosCount++;
        } else if (Date.now() < p.penaltyBoxUntil) {
            msg += `- ${s}: 🚫 禁闭中 (剩 ${((p.penaltyBoxUntil - Date.now())/3600000).toFixed(1)}H)\n`;
        }
    });
    
    if (activePosCount === 0) msg += `\n- 正在盯着猴市的极端恐慌与狂热，准备随时割韭菜！`;
    
    sendFeishu("📊 V15.0 平安汇报", msg);
}, 1 * 60 * 60 * 1000); 

setInterval(runMonitor, CHECK_INTERVAL_MS);
runMonitor();
