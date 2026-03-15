const https = require('https');
const http = require('http');
const crypto = require('crypto');

// ============================================================
// 配置区 - 填入你的币安API Key
// ============================================================
const BINANCE_API_KEY = 'yfVasX0Ajqeb8IrauKvr6Le3jjW2ZoYvcWehSqXP1T5QCymmDZAmWVJUYdDVkmgX';      // 填入你的API Key
const BINANCE_SECRET = 'kTS00yZ1TIfHHcWqTvZXd3e7D5PVaCrXIvshCK2bsZ110z7PzMxysUVA074zzBjG';    // 填入你的Secret Key

const EMAILJS_SERVICE_ID = "service_op2rg49";
const EMAILJS_TEMPLATE_ID = "template_eftwoy6";
const EMAILJS_PUBLIC_KEY = "8hV-qEj_65-Yjk1Pn";
const DEEPSEEK_API_KEY = "sk-807bdf2c1e164c818519243bacb72a72";
const NOTIFY_EMAIL = "2183089849@qq.com";
const SYMBOL = "ETHUSDT";
const CHECK_INTERVAL_MS = 10 * 1000;
const SIGNAL_COOLDOWN_MS = 15 * 60 * 1000;
const HOLD_REMINDER_MS = 5 * 60 * 1000;

// ============================================================
// 模式控制
// ============================================================
let PAPER_TRADING = true;  // true=模拟模式 false=实盘模式
let monitorEnabled = true;
let lastSignalTime = 0;
let lastSignalType = null;
let lastHoldReminderTime = 0;
let holdReminderSent = false;
let lastPrice = null;
let currentPosition = null; // 当前持仓
let dailyPnL = 0;           // 今日盈亏
let dailyStartBalance = 0;  // 今日开始余额
let tradeHistory = [];      // 交易历史
let consecutiveLosses = 0;  // 连续亏损次数

console.log("ETH Auto Trader starting...");
console.log("Mode:", PAPER_TRADING ? "PAPER TRADING (模拟)" : "LIVE TRADING (实盘)");

// ============================================================
// 工具函数
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
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
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

// ============================================================
// 币安签名请求
// ============================================================
function signQuery(params) {
  const query = Object.entries(params).map(([k,v]) => `${k}=${v}`).join('&');
  const sig = crypto.createHmac('sha256', BINANCE_SECRET).update(query).digest('hex');
  return query + '&signature=' + sig;
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
// 技术分析
// ============================================================
function calcMA(data, p) {
  if (data.length < p) return null;
  return data.slice(-p).reduce((s,c) => s+c.close, 0) / p;
}

function calcRSI(data, p) {
  p = p || 14;
  if (data.length < p+1) return null;
  let g=0, l=0;
  for (let i=data.length-p; i<data.length; i++) {
    const d = data[i].close - data[i-1].close;
    if (d>0) g+=d; else l-=d;
  }
  const ag=g/p, al=l/p;
  return al===0 ? 100 : 100-(100/(1+ag/al));
}

function calcATR(data, p) {
  p = p || 14;
  if (data.length < p+1) return 10;
  let sum=0;
  const slice = data.slice(-p);
  for (let i=0; i<slice.length; i++) {
    if (i===0) { sum+=slice[i].high-slice[i].low; continue; }
    sum += Math.max(slice[i].high-slice[i].low, Math.abs(slice[i].high-slice[i-1].close), Math.abs(slice[i].low-slice[i-1].close));
  }
  return sum/p;
}

function findSwings(data, lb) {
  lb = lb||35;
  const r=data.slice(-lb), highs=[], lows=[];
  for (let i=2; i<r.length-2; i++) {
    if (r[i].high>r[i-1].high&&r[i].high>r[i-2].high&&r[i].high>r[i+1].high&&r[i].high>r[i+2].high) highs.push(r[i].high);
    if (r[i].low<r[i-1].low&&r[i].low<r[i-2].low&&r[i].low<r[i+1].low&&r[i].low<r[i+2].low) lows.push(r[i].low);
  }
  return {highs, lows};
}

function detectSignal(data) {
  if (!data||data.length<22) return null;
  const last=data.length-1;
  const ma5=calcMA(data,5), ma10=calcMA(data,10), ma20=calcMA(data,20);
  const ma5p=calcMA(data.slice(0,-1),5), ma10p=calcMA(data.slice(0,-1),10);
  if (!ma5||!ma10||!ma20) return null;
  const rsi=calcRSI(data);
  const atr=calcATR(data);
  const bull=ma5>ma10&&ma10>ma20&&ma5p<=ma10p&&data[last].close>ma5;
  const bear=ma5<ma10&&ma10<ma20&&ma5p>=ma10p&&data[last].close<ma5;
  if (bull) return {type:'LONG', label:'做多', rsi, atr, ma5, ma10, ma20};
  if (bear) return {type:'SHORT', label:'做空', rsi, atr, ma5, ma10, ma20};
  return null;
}

// ============================================================
// 动态风控 - AI自动决定仓位和杠杆
// ============================================================
function calcDynamicParams(sig, balance) {
  const rsi = sig.rsi || 50;
  const atr = sig.atr || 10;
  const atrPct = (atr / lastPrice) * 100; // ATR占价格百分比

  // 信号强度评分 (0-100)
  let signalStrength = 50;
  if (sig.type==='LONG') {
    if (rsi>45&&rsi<65) signalStrength += 20; // RSI在最优区间
    if (rsi<40) signalStrength -= 20; // RSI偏弱
    if (rsi>70) signalStrength -= 30; // RSI超买
  } else {
    if (rsi>35&&rsi<55) signalStrength += 20;
    if (rsi>60) signalStrength -= 20;
    if (rsi<30) signalStrength -= 30;
  }

  // 波动性调整
  if (atrPct > 0.5) signalStrength -= 15; // 波动太大
  if (atrPct < 0.2) signalStrength -= 10; // 波动太小

  // 连续亏损调整
  if (consecutiveLosses >= 3) { signalStrength = 0; } // 暂停
  else if (consecutiveLosses === 2) signalStrength -= 40;
  else if (consecutiveLosses === 1) signalStrength -= 20;

  // 胜率调整
  const recent = tradeHistory.slice(-10);
  if (recent.length >= 5) {
    const winRate = recent.filter(t=>t.pnl>0).length / recent.length;
    if (winRate > 0.6) signalStrength += 15;
    if (winRate < 0.4) signalStrength -= 20;
  }

  // 根据信号强度决定参数
  let investPct, leverage, maxLossPct;
  if (signalStrength <= 0) {
    return null; // 暂停交易
  } else if (signalStrength >= 70) {
    investPct = 0.30; leverage = 10; maxLossPct = 0.20;
  } else if (signalStrength >= 50) {
    investPct = 0.20; leverage = 5; maxLossPct = 0.15;
  } else if (signalStrength >= 30) {
    investPct = 0.10; leverage = 3; maxLossPct = 0.10;
  } else {
    investPct = 0.05; leverage = 2; maxLossPct = 0.05;
  }

  const investAmount = balance * investPct;
  const positionSize = investAmount * leverage;

  return {
    signalStrength: Math.round(signalStrength),
    investPct: Math.round(investPct*100),
    leverage,
    investAmount: +investAmount.toFixed(2),
    positionSize: +positionSize.toFixed(2),
    maxLossPct: Math.round(maxLossPct*100)
  };
}

// ============================================================
// 止盈止损计算
// ============================================================
function calcTPSL(data, type) {
  const price = data[data.length-1].close;
  const atr = calcATR(data);
  const {highs, lows} = findSwings(data);
  let sl, tp1, tp2;
  if (type==='LONG') {
    const nearLow = lows.filter(l=>l<price).sort((a,b)=>b-a)[0]||price*0.985;
    sl = Math.min(Math.max(nearLow-atr*0.25, price*0.982), price*0.982);
    const nearHigh = highs.filter(h=>h>price).sort((a,b)=>a-b)[0];
    tp1 = nearHigh&&nearHigh<price*1.03 ? nearHigh*0.998 : Math.min(price+atr*2, price*1.022);
    tp2 = Math.max(tp1+atr*1.5, price*1.035);
  } else {
    const nearHigh = highs.filter(h=>h>price).sort((a,b)=>a-b)[0]||price*1.015;
    sl = Math.max(Math.min(nearHigh+atr*0.25,price*1.018),price*1.018);
    const nearLow = lows.filter(l=>l<price).sort((a,b)=>b-a)[0];
    tp1 = nearLow&&nearLow>price*0.97 ? nearLow*1.002 : Math.max(price-atr*2, price*0.978);
    tp2 = Math.min(tp1-atr*1.5, price*0.965);
  }
  return {sl:+sl.toFixed(2), tp1:+tp1.toFixed(2), tp2:+tp2.toFixed(2)};
}

// ============================================================
// 获取账户余额
// ============================================================
async function getBalance() {
  if (PAPER_TRADING) {
    // 模拟余额 - 读取或初始化
    if (!global.paperBalance) global.paperBalance = 100; // 模拟100U
    return global.paperBalance;
  }
  try {
    const data = await binanceRequest('GET', '/fapi/v2/balance', {});
    const usdt = data.find(b => b.asset === 'USDT');
    return usdt ? +usdt.availableBalance : 0;
  } catch(e) {
    console.log("Balance error:", e.message);
    return 0;
  }
}

// ============================================================
// 设置杠杆
// ============================================================
async function setLeverage(leverage) {
  if (PAPER_TRADING) return {leverage};
  try {
    return await binanceRequest('POST', '/fapi/v1/leverage', {symbol:SYMBOL, leverage});
  } catch(e) {
    console.log("Leverage error:", e.message);
    return null;
  }
}

// ============================================================
// 开仓
// ============================================================
async function openPosition(sig, params, tpsl, price) {
  const side = sig.type==='LONG' ? 'BUY' : 'SELL';
  const qty = Math.max(0.001, +(params.positionSize / price).toFixed(3));
  const time = new Date().toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'});

  if (PAPER_TRADING) {
    currentPosition = {
      type: sig.type,
      entryPrice: price,
      qty,
      positionSize: params.positionSize,
      leverage: params.leverage,
      tpsl,
      openTime: Date.now(),
      params
    };
    global.paperBalance -= params.investAmount;
    console.log(`[PAPER] OPEN ${sig.type} ${qty} ETH @ ${price} | SL:${tpsl.sl} TP1:${tpsl.tp1} TP2:${tpsl.tp2}`);
    return {status:'FILLED', orderId:'PAPER_'+Date.now()};
  }

  try {
    await setLeverage(params.leverage);
    // Market order
    const order = await binanceRequest('POST', '/fapi/v1/order', {
      symbol: SYMBOL,
      side,
      type: 'MARKET',
      quantity: qty
    });
    // Set stop loss
    await binanceRequest('POST', '/fapi/v1/order', {
      symbol: SYMBOL,
      side: sig.type==='LONG' ? 'SELL' : 'BUY',
      type: 'STOP_MARKET',
      stopPrice: tpsl.sl,
      closePosition: 'true'
    });
    // Set take profit 1
    await binanceRequest('POST', '/fapi/v1/order', {
      symbol: SYMBOL,
      side: sig.type==='LONG' ? 'SELL' : 'BUY',
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: tpsl.tp1,
      closePosition: 'true'
    });
    currentPosition = {
      type: sig.type, entryPrice: price, qty,
      positionSize: params.positionSize, leverage: params.leverage,
      tpsl, openTime: Date.now(), params,
      orderId: order.orderId
    };
    return order;
  } catch(e) {
    console.log("Open position error:", e.message);
    return null;
  }
}

// ============================================================
// 平仓
// ============================================================
async function closePosition(reason, currentPrice) {
  if (!currentPosition) return;
  const pos = currentPosition;
  const pnl = pos.type==='LONG'
    ? (currentPrice - pos.entryPrice) * pos.qty * pos.leverage
    : (pos.entryPrice - currentPrice) * pos.qty * pos.leverage;
  const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice * 100 * (pos.type==='LONG'?1:-1)).toFixed(2);

  if (PAPER_TRADING) {
    global.paperBalance += pos.investAmount + pnl;
    console.log(`[PAPER] CLOSE ${pos.type} @ ${currentPrice} | PnL: ${pnl>0?'+':''}${pnl.toFixed(2)}U (${pnlPct}%) | Reason: ${reason}`);
  } else {
    try {
      await binanceRequest('POST', '/fapi/v1/order', {
        symbol: SYMBOL,
        side: pos.type==='LONG' ? 'SELL' : 'BUY',
        type: 'MARKET',
        quantity: pos.qty
      });
    } catch(e) { console.log("Close error:", e.message); }
  }

  // 更新统计
  dailyPnL += pnl;
  if (pnl > 0) consecutiveLosses = 0;
  else consecutiveLosses++;

  tradeHistory.push({
    type: pos.type,
    entryPrice: pos.entryPrice,
    exitPrice: currentPrice,
    qty: pos.qty,
    leverage: pos.leverage,
    pnl: +pnl.toFixed(2),
    pnlPct: +pnlPct,
    reason,
    duration: Math.round((Date.now()-pos.openTime)/60000),
    time: new Date().toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'})
  });

  await sendTradeEmail('close', pos, currentPrice, pnl, pnlPct, reason);
  currentPosition = null;
}

// ============================================================
// 检查持仓是否需要平仓
// ============================================================
async function checkPosition(data) {
  if (!currentPosition) return;
  const price = data[data.length-1].close;
  const pos = currentPosition;
  const tpsl = pos.tpsl;

  // 检查止盈止损
  if (pos.type==='LONG') {
    if (price <= tpsl.sl) { await closePosition('止损触发', price); return; }
    if (price >= tpsl.tp2) { await closePosition('止盈二触发', price); return; }
    if (price >= tpsl.tp1) { await closePosition('止盈一触发', price); return; }
  } else {
    if (price >= tpsl.sl) { await closePosition('止损触发', price); return; }
    if (price <= tpsl.tp2) { await closePosition('止盈二触发', price); return; }
    if (price <= tpsl.tp1) { await closePosition('止盈一触发', price); return; }
  }

  // 检查趋势反转
  const sig = detectSignal(data);
  if (sig && sig.type !== pos.type) {
    await closePosition('趋势反转，主动平仓', price);
    return;
  }

  // 超时平仓（4小时）
  const hoursOpen = (Date.now() - pos.openTime) / (1000*60*60);
  if (hoursOpen >= 4) { await closePosition('持仓超时4小时', price); return; }

  const pnl = pos.type==='LONG'
    ? (price-pos.entryPrice)*pos.qty*pos.leverage
    : (pos.entryPrice-price)*pos.qty*pos.leverage;
  console.log(`[POS] ${pos.type} @ ${pos.entryPrice} | Now: ${price} | PnL: ${pnl>0?'+':''}${pnl.toFixed(2)}U`);
}

// ============================================================
// 邮件通知
// ============================================================
async function sendTradeEmail(type, pos, price, pnl, pnlPct, reason) {
  const time = new Date().toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'});
  let msg, signal;
  if (type==='open') {
    signal = pos.type==='LONG' ? '开多 📈' : '开空 📉';
    msg = `【自动${signal}】\n时间：${time}\n入场价：${price.toFixed(2)}\n数量：${pos.qty} ETH\n杠杆：${pos.leverage}倍\n仓位：${pos.positionSize}U\n止损：${pos.tpsl.sl}\n止盈一：${pos.tpsl.tp1}\n止盈二：${pos.tpsl.tp2}\n信号强度：${pos.params.signalStrength}/100\n模式：${PAPER_TRADING?'模拟':'实盘'}`;
  } else {
    signal = pnl>0 ? '平仓盈利 ✅' : '平仓亏损 ❌';
    msg = `【${signal}】\n时间：${time}\n方向：${pos.type}\n入场价：${pos.entryPrice}\n出场价：${price.toFixed(2)}\n盈亏：${pnl>0?'+':''}${pnl.toFixed(2)}U (${pnlPct}%)\n原因：${reason}\n持仓时长：${Math.round((Date.now()-pos.openTime)/60000)}分钟\n今日累计：${dailyPnL>0?'+':''}${dailyPnL.toFixed(2)}U\n连续亏损：${consecutiveLosses}次\n模式：${PAPER_TRADING?'模拟':'实盘'}`;
  }
  try {
    await postJSON("https://api.emailjs.com/api/v1.0/email/send", {
      service_id:EMAILJS_SERVICE_ID, template_id:EMAILJS_TEMPLATE_ID, user_id:EMAILJS_PUBLIC_KEY,
      template_params:{to_email:NOTIFY_EMAIL, signal, price:price.toFixed(2), symbol:SYMBOL, interval:'1m', time, message:msg}
    });
  } catch(e) { console.log("Trade email error:", e.message); }
}

// ============================================================
// 主检测循环
// ============================================================
async function checkSignal() {
  const time = new Date().toLocaleTimeString();
  if (!monitorEnabled) { console.log(`[${time}] Paused`); return; }

  try {
    const data = await fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=100`);
    const candles = data.map(d => ({time:d[0],open:+d[1],high:+d[2],low:+d[3],close:+d[4]}));
    lastPrice = candles[candles.length-1].close;

    // 先检查当前持仓
    if (currentPosition) {
      await checkPosition(candles);
      return;
    }

    // 检查单日亏损限制
    const balance = await getBalance();
    if (dailyStartBalance === 0) dailyStartBalance = balance;
    const dailyLossPct = (dailyPnL / dailyStartBalance) * 100;
    if (dailyLossPct <= -20) {
      console.log(`[${time}] Daily loss limit reached: ${dailyLossPct.toFixed(1)}%`);
      return;
    }

    // 检测信号
    const now = Date.now();
    if (now - lastSignalTime < SIGNAL_COOLDOWN_MS) return;
    const sig = detectSignal(candles);

    if (sig && sig.type !== lastSignalType) {
      // 计算动态参数
      const params = calcDynamicParams(sig, balance);
      if (!params) {
        console.log(`[${time}] Signal blocked - ${consecutiveLosses} consecutive losses`);
        return;
      }

      // 最小仓位检查
      if (params.investAmount < 1) {
        console.log(`[${time}] Balance too low: ${balance.toFixed(2)}U`);
        return;
      }

      console.log(`[${time}] Signal: ${sig.label} | Strength:${params.signalStrength} | Invest:${params.investAmount}U | Leverage:${params.leverage}x`);
      lastSignalTime = now;
      lastSignalType = sig.type;

      const tpsl = calcTPSL(candles, sig.type);
      const result = await openPosition(sig, params, tpsl, lastPrice);
      if (result) await sendTradeEmail('open', currentPosition, lastPrice, 0, 0, '');

    } else if (!sig) {
      lastSignalType = null;
    }

  } catch(e) { console.log(`[${time}] Error:`, e.message); }
}

// 每天重置统计
function resetDaily() {
  const now = new Date();
  if (now.getHours()===0 && now.getMinutes()===0) {
    dailyPnL = 0;
    dailyStartBalance = 0;
    console.log("Daily stats reset");
  }
}

// ============================================================
// HTTP 控制服务器
// ============================================================
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method==='OPTIONS') { res.writeHead(200); res.end(); return; }

  const wins = tradeHistory.filter(t=>t.pnl>0).length;
  const losses = tradeHistory.filter(t=>t.pnl<=0).length;
  const totalPnL = tradeHistory.reduce((s,t)=>s+t.pnl, 0);

  if (req.method==='GET' && req.url==='/status') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({
      enabled: monitorEnabled,
      paperTrading: PAPER_TRADING,
      lastPrice,
      currentPosition: currentPosition ? {
        type: currentPosition.type,
        entryPrice: currentPosition.entryPrice,
        pnl: currentPosition.type==='LONG'
          ? +((lastPrice-currentPosition.entryPrice)*currentPosition.qty*currentPosition.leverage).toFixed(2)
          : +((currentPosition.entryPrice-lastPrice)*currentPosition.qty*currentPosition.leverage).toFixed(2)
      } : null,
      dailyPnL: +dailyPnL.toFixed(2),
      totalPnL: +totalPnL.toFixed(2),
      wins, losses,
      winRate: (wins+losses)>0 ? Math.round(wins/(wins+losses)*100) : 0,
      consecutiveLosses,
      tradeCount: tradeHistory.length,
      recentTrades: tradeHistory.slice(-5)
    }));
  } else if (req.method==='POST' && req.url==='/toggle') {
    monitorEnabled = !monitorEnabled;
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({enabled: monitorEnabled}));
  } else if (req.method==='POST' && req.url==='/enable') {
    monitorEnabled = true;
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({enabled: true}));
  } else if (req.method==='POST' && req.url==='/disable') {
    monitorEnabled = false;
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({enabled: false}));
  } else if (req.method==='POST' && req.url==='/paper') {
    PAPER_TRADING = true;
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({mode: 'paper'}));
  } else if (req.method==='POST' && req.url==='/live') {
    PAPER_TRADING = false;
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({mode: 'live'}));
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  console.log(`Paper balance: ${global.paperBalance || 100}U`);
  checkSignal();
  setInterval(checkSignal, CHECK_INTERVAL_MS);
  setInterval(resetDaily, 60000);
});
