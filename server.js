const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ==========================================
// 🔐 核心与 API 配置
// ==========================================
const EMAILJS_SERVICE_ID = "service_op2rg49"; 
const EMAILJS_TEMPLATE_ID = "template_eftwoy6"; 
const EMAILJS_PUBLIC_KEY = "tIZB9DwwpEKr3KQpQ"; 
const NOTIFY_EMAIL = "2183089849@qq.com";
const KV_REST_API_URL = process.env.KV_REST_API_URL || "https://exact-sparrow-75815.upstash.io"; 

const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

const CHECK_INTERVAL_MS = 2 * 60 * 1000; 
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY; 
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;

// 🛡️ V9.4 极简版阵列配置 (SOL 恢复 0.1 个完美兵力)
const SYMBOLS = ['ETHUSDT', 'BTCUSDT', 'SOLUSDT'];
const QTY_MAP = { 
    'ETHUSDT': 0.01,   // 占用保证金约 1.5U
    'BTCUSDT': 0.001,  // 占用保证金约 3.25U
    'SOLUSDT': 0.1     // 占用保证金约 0.75U (10U军费完美适配)
};
const PRICE_PRECISION = { 'BTCUSDT': 1, 'ETHUSDT': 2, 'SOLUSDT': 3 }; 
const QTY_PRECISION = { 'BTCUSDT': 3, 'ETHUSDT': 3, 'SOLUSDT': 1 }; // 👈 精度恢复为 1位小数

let positions = {};
SYMBOLS.forEach(sym => {
    positions[sym] = { 
        status: 'NONE', entryPrice: null, sl: null, qty: 0, entryTime: null, strategy: null, 
        lastAICheckTime: null, lastCloseTime: 0, 
        consecutiveLosses: 0, 
        maxMFEPercent: 0, 
        amnestyNotified: false, 
        inJunjunMode: false,
        lastKnownPrice: null
    };
});

let isMonitoringActive = true; 
// 🔥 V9.4 新增：极简财务记账本
let inMemoryDB = { 
    recent_trades: [], // 仅存闭环订单供AI复盘，不再发给老板
    stats: { wins: 0, losses: 0, totalPnl: 0 } // 老板看这个就行
}; 

console.log("👑 V9.4 极简指挥官版 (SOL 0.1修复 + 极简财务报表) 清爽上线！🚀");

// ==========================================
// 💸 币安 API 核心执行引擎
// ==========================================
async function executeBinanceOrder(endpointPath, params, method = 'POST') {
    if (!BINANCE_API_KEY || !BINANCE_API_SECRET) return null;
    params.timestamp = Date.now();
    const queryStr = querystring.stringify(params);
    const signature = crypto.createHmac('sha256', BINANCE_API_SECRET).update(queryStr).digest('hex');
    const data = `${queryStr}&signature=${signature}`;

    let path = endpointPath;
    if (method === 'GET' || method === 'DELETE') path = `${endpointPath}?${data}`;

    const options = { 
        hostname: 'fapi.binance.com', path: path, method: method, 
        headers: { 'X-MBX-APIKEY': BINANCE_API_KEY } 
    };
    if (method === 'POST' || method === 'PUT') options.headers['Content-Type'] = 'application/x-www-form-urlencoded';

    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let body = ''; res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const response = JSON.parse(body);
                    if (response.code) console.error(`❌ API失败 [${method} ${endpointPath}]:`, response.msg);
                    resolve(response);
                } catch(e) { resolve(body); }
            });
        });
        req.on('error', reject); 
        if (method === 'POST') req.write(data); 
        req.end();
    });
}

function roundPrice(symbol, price) { return parseFloat(parseFloat(price).toFixed(PRICE_PRECISION[symbol] || 2)); }
function roundQty(symbol, qty) { return parseFloat(parseFloat(qty).toFixed(QTY_PRECISION[symbol] || 3)); }

async function autoTrade(symbol, direction, qty, slPrice, currentPrice, strategy, inJunjun = false) {
    const isLong = direction === 'LONG';
    const entrySide = isLong ? 'BUY' : 'SELL';
    const exitSide = isLong ? 'SELL' : 'BUY';

    const entryRes = await executeBinanceOrder('/fapi/v1/order', { symbol, side: entrySide, type: 'MARKET', quantity: roundQty(symbol, qty) });
    if (entryRes && entryRes.code) return false; 

    const sl = roundPrice(symbol, slPrice);
    await executeBinanceOrder('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: exitSide, type: 'STOP_MARKET', triggerPrice: sl, quantity: roundQty(symbol, qty), reduceOnly: 'true' });
    
    if (strategy === '网格撸毛兵') {
        const targetPrice = isLong ? currentPrice * 1.01 : currentPrice * 0.99;
        const tpPriceFixed = roundPrice(symbol, targetPrice);
        console.log(`🛡️ [${symbol}] [网格兵] 挂载 1.0% 固定止盈单 -> ${tpPriceFixed}`);
        await executeBinanceOrder('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: exitSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPriceFixed, quantity: roundQty(symbol, qty), reduceOnly: 'true' });
    } else {
        console.log(`🛡️ [${symbol}] [${strategy}] 挂载 1.0% 回撤追踪止盈导弹！`);
        await executeBinanceOrder('/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side: exitSide, type: 'TRAILING_STOP_MARKET', callbackRate: '1.0', quantity: roundQty(symbol, qty), reduceOnly: 'true' });
    }
    
    if (inJunjun) positions[symbol].inJunjunMode = true;
    return true;
}

async function closePositionAndCancelOrders(symbol, direction, qty) {
    await executeBinanceOrder('/fapi/v1/allOpenOrders', { symbol }, 'DELETE'); 
    const exitSide = direction === 'LONG' ? 'SELL' : 'BUY';
    await executeBinanceOrder('/fapi/v1/order', { symbol, side: exitSide, type: 'MARKET', quantity: roundQty(symbol, qty), reduceOnly: 'true' });
    return true;
}

// 批量状态同步：触发风控 + 财务记账
async function syncRealPositions() {
    const riskRes = await executeBinanceOrder('/fapi/v2/positionRisk', {}, 'GET');
    if (Array.isArray(riskRes)) {
        SYMBOLS.forEach(symbol => {
            const posRisk = riskRes.find(p => p.symbol === symbol);
            if (posRisk) {
                const amt = parseFloat(posRisk.positionAmt);
                const entryP = parseFloat(posRisk.entryPrice);
                let p = positions[symbol];
                
                if (amt !== 0) {
                    const realDir = amt > 0 ? 'LONG' : 'SHORT';
                    if (p.status === 'NONE') {
                        console.log(`🔄 [接管] ${symbol} 真实持仓: ${realDir}！系统已接管！`);
                        positions[symbol] = { status: realDir, entryPrice: entryP, sl: null, qty: Math.abs(amt), entryTime: Date.now(), strategy: '失忆接管兵', lastAICheckTime: Date.now(), lastCloseTime: 0, consecutiveLosses: 0, maxMFEPercent: 0, amnestyNotified: false, inJunjunMode: false, lastKnownPrice: null };
                    }
                } else {
                    if (p.status !== 'NONE') {
                        console.log(`✅ [云端平仓] ${symbol} 开始战后算账...`);
                        
                        // 🔥 财务记账：计算预估盈亏金额 (U)
                        let realizedPnl = 0;
                        if (p.lastKnownPrice && p.entryPrice) {
                            realizedPnl = p.status === 'LONG' ? (p.lastKnownPrice - p.entryPrice) * p.qty : (p.entryPrice - p.lastKnownPrice) * p.qty;
                        }
                        
                        if (realizedPnl > 0) inMemoryDB.stats.wins++;
                        else inMemoryDB.stats.losses++;
                        inMemoryDB.stats.totalPnl += realizedPnl;

                        // 风控大赦结算
                        let isWinOrMFEWin = false;
                        if (p.maxMFEPercent >= 0.6) isWinOrMFEWin = true; 
                        else if (realizedPnl > 0) isWinOrMFEWin = true;

                        if (isWinOrMFEWin) {
                            p.consecutiveLosses = 0; 
                            p.lastCloseTime = 0; 
                        } else {
                            if (p.inJunjunMode) p.consecutiveLosses = 5; 
                            else p.consecutiveLosses++; 
                            p.lastCloseTime = Date.now(); 
                        }
                        
                        // 仅供AI复盘使用，不在邮件展示
                        inMemoryDB.recent_trades.push({ symbol: symbol, dir: p.status, entry: p.entryPrice, exit: p.lastKnownPrice, pnl: realizedPnl.toFixed(3), result: "云端触发止盈/止损" });

                        positions[symbol] = { status: 'NONE', entryPrice: null, sl: null, qty: 0, entryTime: null, strategy: null, lastAICheckTime: null, lastCloseTime: p.lastCloseTime, consecutiveLosses: p.consecutiveLosses, maxMFEPercent: 0, amnestyNotified: false, inJunjunMode: false, lastKnownPrice: null };
                    }
                }
            }
        });
    }
}

// ==========================================
// 📦 工具与计算函数
// ==========================================
function postJSON(url, body, extraHeaders) { return new Promise((resolve, reject) => { const data = JSON.stringify(body); const urlObj = new URL(url); const options = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(extraHeaders||{}) } }; const req = https.request(options, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } }); }); req.on('error', reject); req.write(data); req.end(); }); }
function fetchJSON(url) { return new Promise((resolve, reject) => { https.get(url, { headers: { 'User-Agent': 'Assassin-Bot/9.4' } }, (res) => { let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } }); }).on('error', reject); }); }
async function sendSignalEmail(titleStr, messageHtml) { const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }); try { await postJSON("https://api.emailjs.com/api/v1.0/email/send", { service_id: EMAILJS_SERVICE_ID, template_id: EMAILJS_TEMPLATE_ID, user_id: EMAILJS_PUBLIC_KEY, accessToken: EMAILJS_PRIVATE_KEY, template_params: { to_email: NOTIFY_EMAIL, symbol: "战报", interval: titleStr, signal: "简报", price: "N/A", message: messageHtml, time: time }}); } catch (e) {} }

function calcRSI(data, p = 14) { if (data.length < p + 1) return 50; let g = 0, l = 0; for (let i = data.length - p; i < data.length; i++) { const diff = data[i].close - data[i-1].close; if (diff > 0) g += diff; else l -= diff; } const avgLoss = l / p; if (avgLoss === 0) return 100; return 100 - (100 / (1 + (g / p) / avgLoss)); }
function calcATR(data, p = 14) { if (data.length < p + 1) return 0; let sumTR = 0; for (let i = data.length - p; i < data.length; i++) { const h = data[i].high, l = data[i].low, pc = data[i-1].close; sumTR += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); } return sumTR / p; }
function calcEMA(data, period) { if (data.length < period) return data[data.length - 1].close; let k = 2 / (period + 1); let ema = data[0].close; for (let i = 1; i < data.length; i++) { ema = (data[i].close - ema) * k + ema; } return ema; }

function determineStrategy(atr, currentPrice, rsi) {
    const volatilityRatio = atr / currentPrice; 
    if (rsi < 28 || rsi > 72) return "马丁接针兵";
    if (volatilityRatio < 0.0015) return "网格撸毛兵";
    return "動能刺客";
}

function getCooldownTimeMins(consecutiveLosses) {
    if (consecutiveLosses === 0) return 0;
    if (consecutiveLosses === 1) return 5;
    if (consecutiveLosses === 2) return 10;
    if (consecutiveLosses === 3) return 20;
    if (consecutiveLosses === 4) return 40;
    if (consecutiveLosses >= 5) return 60; 
    return 0;
}

async function loadMemory() { if (!KV_REST_API_TOKEN) return []; try { const res = await fetchJSON(`${KV_REST_API_URL}/get/ai_memory`, { Authorization: `Bearer ${KV_REST_API_TOKEN}` }); if (res.result) return typeof res.result === 'string' ? JSON.parse(res.result) : res.result; } catch(e) {} return []; }
async function saveMemory(data) { if (!KV_REST_API_TOKEN) return; try { await postJSON(`${KV_REST_API_URL}/set/ai_memory`, data, { Authorization: `Bearer ${KV_REST_API_TOKEN}` }); }catch(e){} }

async function askAIForEntry(symbol, data15m, data4h, strategy) {
  if (!DEEPSEEK_API_KEY) return null;
  const prompt = `你是风控官。战场：[${symbol}]，兵种：[${strategy}]。
【15m 数据(战术)】：${JSON.stringify(data15m)}
【4H 数据(战略)】：${JSON.stringify(data4h)}
任务：寻找共振信号。严格返回JSON：{"direction": "LONG/SHORT/WAIT", "sl": 止损价位, "confidence": 0到100, "reason": "逻辑"}`;
  try {
    const res = await postJSON("https://api.deepseek.com/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.1 }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` });
    let jsonStr = res.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, '');
    const match = jsonStr.match(/\{[\s\S]*\}/); 
    if (match) return JSON.parse(match[0]);
    return { direction: 'WAIT', confidence: 0, reason: '混乱' };
  } catch (e) { return { direction: 'WAIT', confidence: 0, reason: 'AI 通信异常' }; }
}

// ==========================================
// 🛡️ 核心引擎：多战区立体监控
// ==========================================
async function runMonitor() {
  if (!isMonitoringActive) return;
  try {
    await syncRealPositions();
    const now = Date.now();
    
    for (const symbol of SYMBOLS) {
        let pos = positions[symbol];

        const raw15m = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=15m&limit=50`);
        const raw4h = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=4h&limit=100`);
        if (!Array.isArray(raw15m) || !Array.isArray(raw4h) || raw15m.length < 5) continue;

        const candles15m = raw15m.map(d => ({ high: +d[2], low: +d[3], close: +d[4], open: +d[1] }));
        const candles4h = raw4h.map(d => ({ high: +d[2], low: +d[3], close: +d[4] }));
        
        const currentPrice = candles15m[candles15m.length - 1].close;
        positions[symbol].lastKnownPrice = currentPrice; 
        
        const atr15m = calcATR(candles15m, 14), rsi15m = calcRSI(candles15m, 14);
        const ema9_15m = calcEMA(candles15m, 9);
        const ema50_4h = calcEMA(candles4h, 50);

        const marketData15m = { currentPrice, rsi: rsi15m.toFixed(2), atr: atr15m.toFixed(2) };
        const marketData4h = { ema50: ema50_4h.toFixed(2) }; 

        // 🔒 状态一：交火中
        if (pos.status !== 'NONE') {
            const currentFloatProfit = pos.status === 'LONG' ? (currentPrice - pos.entryPrice) / pos.entryPrice * 100 : (pos.entryPrice - currentPrice) / pos.entryPrice * 100;
            if (currentFloatProfit > positions[symbol].maxMFEPercent) positions[symbol].maxMFEPercent = currentFloatProfit;

            if (positions[symbol].maxMFEPercent >= 0.6 && !positions[symbol].amnestyNotified) {
                console.log(`🚨 ⭐ [大赦] ${symbol} 利润突破 0.6%！“大赦天下”已触发，刑期归零保障就绪！`);
                positions[symbol].amnestyNotified = true; 
                sendSignalEmail(`⭐ 利润起飞 [${symbol}]`, `当前利润已破 0.6%！追踪防弹衣已激活，最差保本！刑满释放免责机制已生效！`);
            }

            const holdingHours = (now - pos.entryTime) / (1000 * 60 * 60);
            let maxHours = 24, checkIntervalMins = 30; 
            if (pos.strategy === '网格撸毛兵') { maxHours = 3; checkIntervalMins = 15; }
            else if (pos.strategy === '動能刺客') { maxHours = 6; checkIntervalMins = 30; }
            else if (pos.strategy === '马丁接针兵') { maxHours = 12; checkIntervalMins = 60; }
            else { maxHours = 6; checkIntervalMins = 30; } 

            let isClosed = false; let closeReason = "";

            if (holdingHours >= maxHours) {
                console.log(`⏰ [${symbol}] 超时斩仓！`);
                await closePositionAndCancelOrders(symbol, pos.status, pos.qty);
                isClosed = true; closeReason = "超时撤退";
            }

            if (!isClosed) {
                const timeSinceLastCheck = now - (pos.lastAICheckTime || pos.entryTime);
                if (timeSinceLastCheck >= checkIntervalMins * 60 * 1000) {
                    positions[symbol].lastAICheckTime = now; 
                    const currentStrategy = determineStrategy(atr15m, currentPrice, rsi15m);
                    const aiDecision = await askAIForEntry(symbol, marketData15m, marketData4h, currentStrategy);
                    
                    const isReversalLong = pos.status === 'LONG' && aiDecision.direction === 'SHORT' && aiDecision.confidence >= 70;
                    const isReversalShort = pos.status === 'SHORT' && aiDecision.direction === 'LONG' && aiDecision.confidence >= 70;
                    
                    if (isReversalLong || isReversalShort) {
                        console.log(`🚨 [${symbol}] 破势割肉！`);
                        await closePositionAndCancelOrders(symbol, pos.status, pos.qty);
                        isClosed = true; closeReason = "破势逃命";
                    }
                }
            }

            if (isClosed) {
                // 🔥 财务记账：本地主动平仓也结算盈亏
                let realizedPnl = pos.status === 'LONG' ? (currentPrice - pos.entryPrice) * pos.qty : (pos.entryPrice - currentPrice) * pos.qty;
                if (realizedPnl > 0) inMemoryDB.stats.wins++;
                else inMemoryDB.stats.losses++;
                inMemoryDB.stats.totalPnl += realizedPnl;

                inMemoryDB.recent_trades.push({ symbol: symbol, dir: pos.status, entry: pos.entryPrice, exit: currentPrice, pnl: realizedPnl.toFixed(3), result: closeReason });
            } else {
                console.log(`🛡️ [${symbol}] 持仓中 | 现价: ${currentPrice} | 浮盈最高: ${positions[symbol].maxMFEPercent.toFixed(2)}%`);
            }
            continue; 
        }

        // ⚔️ 状态二：空仓待命
        const cooldownMinsMax = getCooldownTimeMins(pos.consecutiveLosses);
        const cooldownMS = cooldownMinsMax * 60 * 1000;
        let remainsCooldownMins = (cooldownMS - (now - pos.lastCloseTime)) / (60 * 1000);
        let isLockdown = pos.lastCloseTime > 0 && remainsCooldownMins > 0;

        const currentStrategy = determineStrategy(atr15m, currentPrice, rsi15m);
        const aiDecision = await askAIForEntry(symbol, marketData15m, marketData4h, currentStrategy);
        
        if (aiDecision && (aiDecision.direction === 'LONG' || aiDecision.direction === 'SHORT')) {
            let dir = aiDecision.direction;
            let conf = parseInt(aiDecision.confidence) || 0;
            let currentPhysicalConditionMet = false;

            if (isLockdown) {
                if (conf >= 90) {
                    const prevCandle15m = candles15m[candles15m.length - 2];
                    const prevIsGood = dir === 'LONG' ? (prevCandle15m.close > prevCandle15m.open) : (prevCandle15m.close < prevCandle15m.open);
                    const currentPriceIsOnEMA = dir === 'LONG' ? currentPrice > ema9_15m : currentPrice < ema9_15m;

                    if (prevIsGood && currentPriceIsOnEMA) {
                        currentPhysicalConditionMet = true;
                        console.log(`🛑 🔥 [立誓越狱] ${symbol} 满物理反转确认！已签军令状(把握: ${conf}%)越狱开仓！`);
                    } else continue;
                } else continue; 
            }

            if (dir === 'LONG' && currentPrice < ema50_4h) continue;
            if (dir === 'SHORT' && currentPrice > ema50_4h) continue;

            let multiplier = 0;
            if (conf >= 95) multiplier = 3;       ions[symbol].consecutiveLosses, maxMFEPercent: 0, amnestyNotified: false, inJunjunMode: currentPhysicalConditionMet, lastKnownPrice: currentPrice };
                    // 🔥 重点：不再往 recent_trades 里塞“MARKET开仓”的垃圾日志！
                }
            }
        }
    } 
  } catch (e) { console.log("监控异常:", e.message); }
}

// ==========================================
// 📊 老板专属报表 & 网页控制台 (极简风)
// ==========================================
async function runHourlyReport() { 
    // 🔥 极简财报设计
    let msg = `<b>📊 V9.4 极简指挥官财报</b><br><br><b>🎯 当前阵地状态:</b><br>`; 
    SYMBOLS.forEach(sym => {
        let p = positions[sym];
        const cooldownMinsMax = getCooldownTimeMins(p.consecutiveLosses);
        const remainsCooldownMins = Math.max(0, (cooldownMinsMax * 60 * 1000 - (Date.now() - p.lastCloseTime)) / (60 * 1000));

        let statusStr = "";
        if (p.status === 'NONE') {
            statusStr = cooldownMinsMax > 0 && remainsCooldownMins > 0 ? `<span style="color:#dc3545">🛑 刑期冷却中 (${remainsCooldownMins.toFixed(1)}分)</span>` : '空仓巡视 💤';
        } else {
            statusStr = `<span style="color:green">💥 ${p.status}</span> (${p.qty}个 | 浮盈最高: ${p.maxMFEPercent.toFixed(2)}%)`;
        }
        msg += `- <b>${sym}</b>: ${statusStr}<br>`;
    });

    // 重点：展示盈亏数据，彻底抛弃详细流水！
    const pnlColor = inMemoryDB.stats.totalPnl >= 0 ? 'green' : 'red';
    const pnlPrefix = inMemoryDB.stats.totalPnl > 0 ? '+' : '';
    
    msg += `<br><b>💰 阶段战果统计 (自程序重启):</b><br>`; 
    msg += `- 🏆 盈利单数: <b>${inMemoryDB.stats.wins} 单</b><br>`;
    msg += `- 🩸 亏损单数: <b>${inMemoryDB.stats.losses} 单</b><br>`;
    msg += `- 💵 预估净盈亏: <b><span style="color:${pnlColor}; font-size: 16px;">${pnlPrefix}${inMemoryDB.stats.totalPnl.toFixed(3)} U</span></b><br>`;
    
    msg += `<br><small style="color:gray;">*为保持清爽，冗长的开平仓流水已隐藏。详细金额明细请以币安APP实际账单为准。</small>`;
    
    await sendSignalEmail("整点财报", msg); 
}

async function runDailyAIReview() { 
    const tradesStr = JSON.stringify(inMemoryDB.recent_trades); 
    const pastMemory = await loadMemory(); 
    const memoryStr = pastMemory.slice(-7).join(" | "); 
    const prompt = `你是首席风控官。\n【历史教训】：${memoryStr || "无"}\n【今天闭环流水】：${tradesStr}。\n任务：复盘今天盈亏表现，给出优化建议。200字总结。`; 
    try { 
        const res = await postJSON("https://api.deepseek.com/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.1 }, { "Authorization": `Bearer ${DEEPSEEK_API_KEY}` }); 
        const summary = res.choices[0].message.content; 
        pastMemory.push(`[${new Date().toLocaleDateString()}] 教训: ${summary.substring(0, 100)}...`); 
        await saveMemory(pastMemory.slice(-15)); 
        await sendSignalEmail("📈 每日 AI 进化报告", summary.replace(/\n/g, '<br>')); 
        inMemoryDB.recent_trades = []; // 清空流水供明天使用
        inMemoryDB.stats = { wins: 0, losses: 0, totalPnl: 0 }; // 每天重置总盈亏
    } catch(e) {} 
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/status') { res.end(JSON.stringify({ status: "alive", mode: "V9.4 Minimalist Commander", positions })); return; }
  
  let htmlStatus = "";
  SYMBOLS.forEach(sym => {
      let p = positions[sym];
      const cooldownMinsMax = getCooldownTimeMins(p.consecutiveLosses);
      const remainsCooldownMins = Math.max(0, (cooldownMinsMax * 60 * 1000 - (Date.now() - p.lastCloseTime)) / (60 * 1000));
      let isLockdown = cooldownMinsMax > 0 && remainsCooldownMins > 0;

      let color = p.status === 'NONE' ? (isLockdown ? '#dc3545' : '#666') : (p.status === 'LONG' ? '#28a745' : '#dc3545');
      let statusStr = p.status === 'NONE' ? (isLockdown ? `🛑 冷却刑期中 (距释放 ${remainsCooldownMins.toFixed(1)}分)` : `空仓待命 💤`) : p.status;
      
      htmlStatus += `<div style="margin: 10px 0; padding: 10px; border: 1px solid #ccc; border-radius: 5px;">
        <strong>${sym}</strong>: <span style="color: ${color}; font-weight: bold;">${statusStr}</span> 
        ${p.status !== 'NONE' ? `<br><small>数量: ${p.qty} | max浮盈触及: ${p.maxMFEPercent.toFixed(2)}% </small>` : ''}
      </div>`;
  });

  res.end(`<div style="text-align: center; margin-top: 50px; font-family: Arial;">
      <h1>🚀 V9.4 极简指挥官版</h1>
      <p style="color: #007bff; font-size: 18px;">净利润自动计算已开启！反人类长串流水已被消灭！</p>
      <div style="max-width: 400px; margin: 0 auto; text-align: left;">
          <h3 style="text-align:center;">💰 阶段总盈亏: <span style="color:${inMemoryDB.stats.totalPnl >= 0 ? 'green' : 'red'};">${inMemoryDB.stats.totalPnl > 0 ? '+' : ''}${inMemoryDB.stats.totalPnl.toFixed(3)} U</span></h3>
          <p style="text-align:center; color: gray;">(胜 ${inMemoryDB.stats.wins} / 负 ${inMemoryDB.stats.losses})</p>
          ${htmlStatus}
      </div>
  </div>`);
}).listen(process.env.PORT || 3000);

setInterval(runMonitor, CHECK_INTERVAL_MS); 
setInterval(runHourlyReport, 60 * 60 * 1000); 
setInterval(runDailyAIReview, 24 * 60 * 60 * 1000); 
runMonitor();
            else if (conf >= 80) multiplier = 2;  
            else if (conf >= 60) multiplier = 1;  
            
            if (multiplier > 0) {
                let tradeQty = parseFloat((QTY_MAP[symbol] * multiplier).toFixed(3));
                console.log(`🚀 [${symbol}] 获准开火 -> 方向: ${dir}, 兵力: ${tradeQty}`);
                
                const success = await autoTrade(symbol, dir, tradeQty, aiDecision.sl, currentPrice, currentStrategy, currentPhysicalConditionMet);
                if (success) {
                    positions[symbol] = { status: dir, entryPrice: currentPrice, sl: parseFloat(aiDecision.sl), qty: tradeQty, entryTime: now, strategy: currentStrategy, lastAICheckTime: now, lastCloseTime: positions[symbol].lastCloseTime, consecutiveLosses: posit
