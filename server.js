const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ==========================================
// 🔐 核心配置区 (V13.0 铁血防爆版)
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
const MAX_SIMULTANEOUS_POSITIONS = 5; 
const CHECK_INTERVAL_MS = 2 * 60 * 1000; 

let positions = {};
SYMBOLS.forEach(sym => {
    // 新增：penaltyBoxUntil (小黑屋解禁时间戳)
    positions[sym] = { status: 'NONE', entryPrice: 0, qty: 0, superTrendLine: 0, maxMfe: 0, dynamicStopPrice: 0, entryTime: 0, tradeType: 'NORMAL', penaltyBoxUntil: 0 };
});

function getBJTime() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }

let initialBalance = null; 
let currentBalance = 0;    
let startTimeBJ = getBJTime();

console.log(`🚀 V13.0 铁血防爆版启动！[已装载: 亏损小黑屋 / 1.2倍量能锁 / 严打追高]`);

async function sendFeishu(title, message) {
    if (!FEISHU_WEBHOOK_URL || FEISHU_WEBHOOK_URL.includes("这里填入")) return;
    const content = `【${title}】\n------------------\n${message}\n北京时间: ${getBJTime()}`;
    const data = JSON.stringify({ msg_type: "text", content: { text: content } });
    const url = new URL(FEISHU_WEBHOOK_URL);
    const options = { hostname: url.hostname, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json' } };
    const req = https.request(options); req.write(data); req.end();
}

sendFeishu("⚡ V13.0 铁血防爆版上线", `长官！系统已升级至 V13.0 铁血防爆版！\n已为战车焊死三大防线：【4小时亏损小黑屋】+【1.2倍真金白银放量锁】+【严禁衰退期半路追高】！震荡市绞肉机休想再赚我们一分钱！`);

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
            p.entryTime = Date.now(); 
            p.tradeType = 'NORMAL'; 
        } else if (amt === 0 && p.status !== 'NONE') {
            // 物理止损防线被触发时的处理：因为无法拿到准确平仓价，安全起见直接关入小黑屋 4 小时
            console.log(`⚠️ [防线被击穿] ${symbol} 物理防弹衣可能已被触发！强制冷却4小时！`);
            p.penaltyBoxUntil = Date.now() + 4 * 60 * 60 * 1000;
            p.status = 'NONE'; p.dynamicStopPrice = 0; p.maxMfe = 0; p.entryTime = 0; p.tradeType = 'NORMAL';
        }
    }
}

async function runMonitor() {
    try {
        await checkPositions();
        const snap = await getWallet();
        
        if (initialBalance === null && snap.total > 0) { initialBalance = snap.total; }
        currentBalance = snap.total;

        // 👑 呼叫大饼哥 4H 统帅
        let btc4hKlines = await fetchKlines('BTCUSDT', '4h', 50);
        if (!btc4hKlines || btc4hKlines.length < 20) {
             console.log(`⚠️ [大盘风控局] 呼叫BTC 4H统帅失败，全军静默！`); return; 
        }
        btc4hKlines = calcSuperTrend(btc4hKlines);
        const btcTrend4H = btc4hKlines[btc4hKlines.length - 1].trend; 
        console.log(`\n👑 [大盘风控局] BTC 4H 宏观大势: ${btcTrend4H === 'LONG' ? '🟢 多头压制' : '🔴 空头压制'}`);

        for (const symbol of SYMBOLS) {
            let p = positions[symbol];
            
            // ⛓️ 小黑屋拦截检查
            if (Date.now() < p.penaltyBoxUntil) {
                // 静默拦截，不打印冗余日志，直到解禁
                continue;
            }

            let k30m = await fetchKlines(symbol, '30m', 150);
            if (k30m.length < 50) continue;

            k30m = calcSuperTrend(k30m);
            const curWindForce = calcADX(k30m); 
            const adx4ago = calcADX(k30m.slice(0, k30m.length - 4)); 
            
            const curK = k30m[k30m.length - 1];
            const prevK = k30m[k30m.length - 2];
            const curPrice = curK.c;
            const currentTrend = curK.trend;

            // 计算 10H(20根) 均量 (加固版防线)
            let sumVol10 = 0; for(let i = k30m.length - 11; i < k30m.length - 1; i++) sumVol10 += k30m[i].v;
            let avgVol10 = sumVol10 / 10;

            // 计算 24H(48根) 均幅 ATR
            let sumAtr = 0; for(let i = k30m.length - 49; i < k30m.length - 1; i++) sumAtr += k30m[i].atr;
            let avgAtr24h = sumAtr / 48;

            // ==========================================
            // 🛡️ 状态一：持仓防守与收网 (正规军 vs 游击队)
            // ==========================================
            if (p.status !== 'NONE') {
                let roe = p.status === 'LONG' ? (curPrice - p.entryPrice)/p.entryPrice*100 * LEVERAGE : (p.entryPrice - curPrice)/p.entryPrice*100 * LEVERAGE;
                if (roe > p.maxMfe) p.maxMfe = roe; 

                let shouldClose = false;
                let closeReason = '';

                // 大趋势反转斩首 (统一铁律)
                if (p.status === 'LONG' && currentTrend === 'SHORT') { shouldClose = true; closeReason = '30m 趋势翻红，彻底斩首！'; }
                if (p.status === 'SHORT' && currentTrend === 'LONG') { shouldClose = true; closeReason = '30m 趋势翻绿，彻底斩首！'; }

                // 🌟 【AI 新机制】：战地原地收编权
                if (p.tradeType === 'FLASH' && p.status === btcTrend4H) {
                    p.tradeType = 'NORMAL'; 
                    console.log(`🎖️ [战地收编] ${symbol} 游击队熬出头，大盘已共振！就地转正为【🟢正规军】！解除时间炸弹！`);
                    sendFeishu(`🎖️ 游击队转正 [${symbol}]`, `4H大部队已到达！方向完美共振！\n已为该部队解除2小时撤离命令，向着20%星辰大海进发！`);
                }

                // 分兵种独立防守逻辑
                if (p.tradeType === 'FLASH') {
                    // ⚡ 游击队：见好就收，ROE>=10%开始锁润
                    if (p.maxMfe >= 10) {
                        let lockRoe = p.maxMfe - 5; 
                        let calcStop = p.status === 'LONG' ? p.entryPrice * (1 + (lockRoe/100/LEVERAGE)) : p.entryPrice * (1 - (lockRoe/100/LEVERAGE));
                        if (p.status === 'LONG' && (!p.dynamicStopPrice || calcStop > p.dynamicStopPrice)) p.dynamicStopPrice = calcStop;
                        if (p.status === 'SHORT' && (!p.dynamicStopPrice || calcStop < p.dynamicStopPrice)) p.dynamicStopPrice = calcStop;
                    }
                    
                    // ⏳ 时间熔断检测 (带盈利豁免权)
                    if (!shouldClose && Date.now() - p.entryTime >= 2 * 60 * 60 * 1000) {
                        if (p.maxMfe >= 10) {
                            console.log(`🌟 [盈利豁免] ${symbol} 游击队已到2小时，但利润达标(当前最高${p.maxMfe.toFixed(1)}%)，激活豁免权，交由锁润线控制！`);
                        } else {
                            shouldClose = true; closeReason = '⏳ 游击队2小时大限已到，且利润未达豁免线，强制撤离！';
                        }
                    }
                } else {
                    // 🟢 正规军：吃大波段，ROE>=20%开始锁润
                    if (p.maxMfe >= 20) {
                        let lockRoe = p.maxMfe - 10; 
                        let calcStop = p.status === 'LONG' ? p.entryPrice * (1 + (lockRoe/100/LEVERAGE)) : p.entryPrice * (1 - (lockRoe/100/LEVERAGE));
                        if (p.status === 'LONG' && (!p.dynamicStopPrice || calcStop > p.dynamicStopPrice)) p.dynamicStopPrice = calcStop;
                        if (p.status === 'SHORT' && (!p.dynamicStopPrice || calcStop < p.dynamicStopPrice)) p.dynamicStopPrice = calcStop;
                    }
                }

                // 物理锁润触发
                if (!shouldClose && p.dynamicStopPrice) {
                    if (p.status === 'LONG' && curPrice <= p.dynamicStopPrice) { shouldClose = true; closeReason = `触发阶梯锁润线！利润落袋！`; }
                    if (p.status === 'SHORT' && curPrice >= p.dynamicStopPrice) { shouldClose = true; closeReason = `触发阶梯锁润线！利润落袋！`; }
                }

                if (shouldClose) {
                    const side = p.status === 'LONG' ? 'SELL' : 'BUY';
                    await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: p.qty });
                    
                    // ⛓️ 结算清算：如果是亏损单，强制关入小黑屋 4 小时！
                    let penaltyAlert = '';
                    if (roe < 0) {
                        p.penaltyBoxUntil = Date.now() + 4 * 60 * 60 * 1000;
                        penaltyAlert = `\n🚫 【处罚生效】该阵地已被定性为高危绞肉机，强制冷却关押 4 小时！`;
                    }

                    sendFeishu(`🩸 收网战报 [${symbol}]`, `兵种: ${p.tradeType==='FLASH'?'⚡游击队':'🟢正规军'}\n平仓原因: ${closeReason}\n最终结算: ${roe.toFixed(2)}%\n最高浮盈: ${p.maxMfe.toFixed(2)}%${penaltyAlert}`);
                    p.status = 'NONE'; p.maxMfe = 0; p.dynamicStopPrice = 0; p.entryTime = 0; p.tradeType = 'NORMAL';
                } else {
                    let lockStr = p.dynamicStopPrice ? ` | 锁润线:${p.dynamicStopPrice.toFixed(PRICE_PRECISION[symbol]||2)}` : '';
                    let timeStr = p.tradeType === 'FLASH' ? ` | 距强平:${((2*3600000 - (Date.now() - p.entryTime))/60000).toFixed(0)}分` : '';
                    console.log(`🛡️ [${symbol}] ${p.tradeType==='FLASH'?'⚡游击':'🟢正规'} | 现价:${curPrice} | ROE:${roe.toFixed(2)}%${lockStr}${timeStr}`);
                }
                continue;
            }

            // ==========================================
            // ⚔️ 状态二：雷达扫描与 V13.0 铁血过滤网
            // ==========================================
            let trendIcon = currentTrend === 'LONG' ? '🟢多' : '🔴空';
            console.log(`💤 扫描 [${symbol}] | 现价:${curPrice} | 趋势:${trendIcon} | 风力(ADX):${curWindForce.toFixed(1)}`);

            let signal = 'WAIT'; let tactic = '';
            if (prevK.trend === 'SHORT' && currentTrend === 'LONG') { signal = 'LONG'; tactic = '底部翻绿(绝地反击)'; }
            else if (prevK.trend === 'LONG' && currentTrend === 'SHORT') { signal = 'SHORT'; tactic = '顶部翻红(高位跳水)'; }
            else if (curWindForce >= 25 && curWindForce <= 45) { signal = currentTrend; tactic = '狂风顺势(半路上车)'; }

            if (signal === 'WAIT') continue;

            console.log(`🎯 [触发意向] ${symbol} 准备执行【${tactic}】！`);

            // 🛑 【防线 1】风力底线
            if (curWindForce < 12) { console.log(`🚫 [拦截] 风力太弱(${curWindForce.toFixed(1)} < 12)。放弃。`); continue; }
            
            // 🛑 【防线 2】严打半路追高！如果是半路上车，严禁衰退！
            if (tactic.includes('半路上车')) {
                if (curWindForce <= adx4ago) {
                    console.log(`🚫 [铁血拦截] 拒绝半路接盘！当前风力(${curWindForce.toFixed(1)}) ≦ 2小时前(${adx4ago.toFixed(1)})，已进入衰退期！`); continue;
                }
            } else {
                // 如果是刚变色的反转单，保持风力豁免权(大风允许微调)
                if (curWindForce < 20 && curWindForce <= adx4ago) { 
                    console.log(`🚫 [拦截] 风力衰弱且未达豁免线(20)！强弩之末！`); continue; 
                }
            }
            
            // 🛑 【防线 3】波动率门槛 60%
            if (curK.atr < avgAtr24h * 0.6) { 
                console.log(`🚫 [拦截] 波动极其萎缩！当前ATR低于均值60%。一潭死水，不碰！`); continue; 
            }
            
            // 🛑 【防线 4】V13.0 重铸 1.2 倍量能锁！
            if (curK.v < avgVol10 * 1.2) { 
                console.log(`🚫 [铁血拦截] 没钱砸盘别想骗我！当前成交量未达到近10周期均量的 1.2倍。坚决不跟！`); continue; 
            }

            // 👑 【阵地满员拦截】
            let activePosCount = Object.values(positions).filter(p => p.status !== 'NONE').length;
            if (activePosCount >= MAX_SIMULTANEOUS_POSITIONS) { console.log(`🚫 [拦截] 阵地已满员(${MAX_SIMULTANEOUS_POSITIONS}只)！自动锁枪！`); continue; }

            // ⚔️ 【大盘双轨制分发】
            let tradeType = 'NORMAL';
            let slRate = '3.0'; 
            if (signal !== btcTrend4H) {
                tradeType = 'FLASH';
                slRate = '1.5'; 
                console.log(`⚠️ [大盘分发] ${symbol} 逆着 BTC 4H大势！启动【⚡逆势游击队】：1.5%物理防线 + 2小时熔断！`);
            } else {
                console.log(`✅ [大盘分发] ${symbol} 方向与 BTC 4H 同频！启动【🟢正规军】模式！`);
            }

            // 🔫 开火执行
            let budget = snap.available * POSITION_RISK_PERCENT; 
            let qty = roundQty(symbol, (budget * LEVERAGE) / curPrice);
            if (qty * curPrice < 6) qty = roundQty(symbol, 6.5/curPrice); 
            let requiredMargin = (qty * curPrice / LEVERAGE);
            if (snap.available < requiredMargin) { console.log(`⚠️ [${symbol}] 弹药枯竭，无法开火！`); continue; }

            console.log(`🔥 [${symbol}] V13.0 铁血安检通过！拔枪开火！`);
            const side = signal === 'LONG' ? 'BUY' : 'SELL';
            const res = await binanceReq('/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: qty });
            
            if (!res.code) {
                p.status = signal; p.entryPrice = curPrice; p.qty = qty; 
                p.entryTime = Date.now(); p.tradeType = tradeType;
                
                const revSide = signal === 'LONG' ? 'SELL' : 'BUY';
                await binanceReq('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: revSide, type: 'TRAILING_STOP_MARKET', callbackRate: slRate, quantity: qty, reduceOnly: 'true' });
                
                sendFeishu(`🎯 战神开火 | V13.0 铁血防爆版`, 
                    `标的: ${symbol}\n方向: ${signal === 'LONG' ? '🟢 做多' : '🔴 做空'}\n战机: ${tactic}\n兵种: ${tradeType==='FLASH'?'⚡游击队 (1.5%物理止损)':'🟢正规军 (3.0%物理止损)'}\n投入: 约 ${requiredMargin.toFixed(2)}U`
                );
            }
        }
    } catch(e) { console.error("🔥 引擎异常:", e.message); }
}

http.createServer((req, res) => {
    let realPnl = initialBalance !== null ? (currentBalance - initialBalance) : 0;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<h1>V13.0 铁血防爆战车</h1><h3>4H小黑屋 | 1.2倍量能锁 | 严禁追高</h3><p>本次开机净利润: ${realPnl.toFixed(3)} U</p><p>启动时间: ${startTimeBJ}</p>`);
}).listen(process.env.PORT || 3000);

setInterval(() => {
    let realPnl = initialBalance !== null ? (currentBalance - initialBalance) : 0;
    let msg = `💰 开机至今净利润: ${realPnl.toFixed(3)} U (已扣手续费)\n🎯 阵地状态:\n`;
    let activePosCount = 0;
    SYMBOLS.forEach(s => { 
        let p = positions[s]; 
        if (p.status !== 'NONE') {
            let timeStr = p.tradeType === 'FLASH' ? `(倒计时${((2*3600000 - (Date.now() - p.entryTime))/60000).toFixed(0)}分)` : '';
            msg += `- ${s}: ${p.status} (${p.tradeType==='FLASH'?'⚡':'🟢'}${timeStr}) | 浮盈最高:${p.maxMfe.toFixed(1)}%\n`; 
            activePosCount++;
        } else if (Date.now() < p.penaltyBoxUntil) {
            msg += `- ${s}: 🚫 关押中 (剩余 ${((p.penaltyBoxUntil - Date.now())/3600000).toFixed(1)} 小时解禁)\n`;
        }
    });
    msg += `\n🛡️ 并发限制: ${activePosCount} / ${MAX_SIMULTANEOUS_POSITIONS}`;
    if (activePosCount === 0) msg += `\n- 全军休眠/猎物追踪中 🐺\n`;
    sendFeishu("📊 V13.0 战区巡航 (每小时播报)", msg);
}, 1 * 60 * 60 * 1000); 

setInterval(runMonitor, CHECK_INTERVAL_MS);
runMonitor();
