const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ==========================================
// 🔐 核心配置区 (V16.2 混合战舰 - ADX修复版)
// ==========================================
const FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK || "https://open.feishu.cn/open-apis/bot/v2/hook/6099f609-41c4-4364-b0d8-fdb986b821a2"; 
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

const SYMBOLS = ['SOLUSDT', 'ETHUSDT', 'DOGEUSDT', 'BNBUSDT', 'XRPUSDT', 'AVAXUSDT', 'ADAUSDT', 'LINKUSDT', 'ORDIUSDT', 'INJUSDT']; 
const PRICE_PRECISION = { 'BTCUSDT': 1, 'ETHUSDT': 2, 'SOLUSDT': 3, 'DOGEUSDT': 5, 'BNBUSDT': 2, 'XRPUSDT': 4, 'AVAXUSDT': 3, 'ADAUSDT': 4, 'LINKUSDT': 3, 'ORDIUSDT': 3, 'INJUSDT': 3 }; 
const QTY_PRECISION = { 'BTCUSDT': 3, 'ETHUSDT': 3, 'SOLUSDT': 1, 'DOGEUSDT': 0, 'BNBUSDT': 2, 'XRPUSDT': 1, 'AVAXUSDT': 1, 'ADAUSDT': 0, 'LINKUSDT': 2, 'ORDIUSDT': 1, 'INJUSDT': 1 }; 

const LEVERAGE = 20; 
const POSITION_RISK_PERCENT = 0.4; 
const MAX_SIMULTANEOUS_POSITIONS = 1; 
const CHECK_INTERVAL_MS = 2 * 60 * 1000; 
const HARD_STOP_LOSS_PERCENT = 3.0; 

let isProcessing = false; 
let positions = {};
SYMBOLS.forEach(sym => {
    positions[sym] = { status: 'NONE', entryPrice: 0, qty: 0, maxMfe: 0, strategyMode: 'NONE', penaltyBoxUntil: 0 };
});

function getBJTime() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }
let initialBalance = null, currentBalance = 0;

console.log(`🚀 V16.2 混合战舰启动！[修复 ADX 指标 | 双引擎正式启动]`);

async function sendFeishu(title, message) {
    if (!FEISHU_WEBHOOK_URL || FEISHU_WEBHOOK_URL.includes("这里填入")) return;
    const content = `【${title}】\n------------------\n${message}\n北京时间: ${getBJTime()}`;
    const options = { hostname: 'open.feishu.cn', path: new URL(FEISHU_WEBHOOK_URL).pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } };
    const req = https.request(options); req.write(JSON.stringify({ msg_type: "text", content: { text: content } })); req.end();
}

async function binanceReq(path, params, method = 'POST') {
    params.timestamp = Date.now();
    const query = querystring.stringify(params);
    const sig = crypto.createHmac('sha256', BINANCE_API_SECRET).update(query).digest('hex');
    const data = `${query}&signature=${sig}`;
    const options = { hostname: 'fapi.binance.com', path: method === 'GET' ? `${path}?${data}` : path, method: method, headers: { 'X-MBX-APIKEY': BINANCE_API_KEY } };
    return new Promise((resolve) => {
        const req = https.request(options, res => {
            let b = ''; res.on('data', c => b += c);
            res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve({}); } });
        });
        req.on('error', () => resolve({})); if (method === 'POST') req.write(data); req.end();
    });
}

async function fetchKlines(symbol, interval = '30m', limit = 100) {
    return new Promise((resolve) => {
        https.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d).map(k => ({ o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))); } catch(e) { resolve([]); } });
        }).on('error', () => resolve([]));
    });
}

function calcRSI(klines, p=14) {
    if (klines.length < p+1) return klines;
    let ag=0, al=0;
    for(let i=1;i<=p;i++){ let diff=klines[i].c-klines[i-1].c; if(diff>0)ag+=diff; else al-=diff; }
    ag/=p; al/=p; klines[p].rsi = 100-(100/(1+(ag/(al||0.001))));
    for(let i=p+1;i<klines.length;i++){
        let diff=klines[i].c-klines[i-1].c, g=diff>0?diff:0, l=diff<0?-diff:0;
        ag=(ag*(p-1)+g)/p; al=(al*(p-1)+l)/p; klines[i].rsi = 100-(100/(1+(ag/(al||0.001))));
    }
    return klines;
}

function calcBB(klines, p=20, m=2) {
    for(let i=p-1;i<klines.length;i++){
        let slice = klines.slice(i-p+1, i+1).map(x=>x.c);
        let sma = slice.reduce((a,b)=>a+b)/p;
        let std = Math.sqrt(slice.map(x=>Math.pow(x-sma,2)).reduce((a,b)=>a+b)/p);
        klines[i].bbMid=sma; klines[i].bbUpper=sma+m*std; klines[i].bbLower=sma-m*std;
    }
    return klines;
}

function calcSuperTrend(klines, p=10, m=3) {
    let trs = [0]; for(let i=1;i<klines.length;i++) trs.push(Math.max(klines[i].h-klines[i].l, Math.abs(klines[i].h-klines[i-1].c), Math.abs(klines[i].l-klines[i-1].c)));
    let atr = []; let sum=0; for(let i=1;i<=p;i++) sum+=trs[i]; atr[p]=sum/p;
    for(let i=p+1;i<klines.length;i++) atr[i]=(atr[i-1]*(p-1)+trs[i])/p;
    let isUp=true, ub=0, lb=0, st=[];
    for(let i=p;i<klines.length;i++){
        let hl2=(klines[i].h+klines[i].l)/2, bUB=hl2+m*atr[i], bLB=hl2-m*atr[i];
        ub=(bUB<ub || klines[i-1].c>ub)?bUB:ub; lb=(bLB>lb || klines[i-1].c<lb)?bLB:lb;
        if(st[i-1]===ub && klines[i].c>ub) isUp=true; else if(st[i-1]===lb && klines[i].c<lb) isUp=false;
        st[i]=isUp?lb:ub; klines[i].trend=isUp?'LONG':'SHORT';
    }
    return klines;
}

function calcADX(klines, p=14) {
    if (klines.length<p*2) return 0;
    let tr=[], pdm=[], ndm=[];
    for(let i=1;i<klines.length;i++){
        tr.push(Math.max(klines[i].h-klines[i].l, Math.abs(klines[i].h-klines[i-1].c), Math.abs(klines[i].l-klines[i-1].c)));
        // 🎯 V16.2 修复：将 dn 算式从 klines[i-1].l 修正为 klines[i].l
        let up=klines[i].h-klines[i-1].h, dn=klines[i-1].l-klines[i].l;
        pdm.push(up>dn && up>0?up:0); ndm.push(dn>up && dn>0?dn:0);
    }
    const sm = (a) => { let s=[a.slice(0,p).reduce((x,y)=>x+y)/p]; for(let i=p;i<a.length;i++) s.push((s[s.length-1]*(p-1)+a[i])/p); return s; };
    let sTR=sm(tr), sP=sm(pdm), sN=sm(ndm), dx=[];
    for(let i=0;i<sTR.length;i++){
        let pDI=100*sP[i]/sTR[i], nDI=100*sN[i]/sTR[i];
        dx.push(pDI+nDI===0?0:100*Math.abs(pDI-nDI)/(pDI+nDI));
    }
    return dx[dx.length-1];
}

async function runMonitor() {
    if (isProcessing) return; isProcessing = true;
    try {
        const risk = await binanceReq('/fapi/v2/positionRisk', {}, 'GET');
        if(Array.isArray(risk)) SYMBOLS.forEach(s => {
            const r = risk.find(x=>x.symbol===s);
            if(r){
                const amt=parseFloat(r.positionAmt);
                if(amt===0 && positions[s].status!=='NONE'){ 
                    console.log(`🚨 [防线崩溃] ${s} 触发物理硬止损，关押 6 小时防报复！`);
                    positions[s].penaltyBoxUntil=Date.now()+6*3600000; positions[s].status='NONE'; positions[s].maxMfe=0;
                } else if(amt!==0){ 
                    positions[s].status=amt>0?'LONG':'SHORT'; positions[s].qty=Math.abs(amt); positions[s].entryPrice=parseFloat(r.entryPrice); 
                }
            }
        });

        const wallet = await binanceReq('/fapi/v2/account', {}, 'GET');
        if(!wallet.availableBalance){ isProcessing=false; return; }
        currentBalance=parseFloat(wallet.totalMarginBalance);
        if(initialBalance===null && currentBalance > 0) initialBalance=currentBalance;

        let btc4h = await fetchKlines('BTCUSDT', '4h', 50); btc4h=calcSuperTrend(btc4h);
        const btcTrend=btc4h[btc4h.length-2].trend;
        const btcADX = calcADX(btc4h.slice(0, btc4h.length - 1));

        console.log(`\n👑 [大盘统帅] BTC 4H趋势: ${btcTrend === 'LONG' ? '🟢多' : '🔴空'} | 大饼风力: ${btcADX.toFixed(1)}`);

        for(const symbol of SYMBOLS){
            let p=positions[symbol]; 
            if(Date.now()<p.penaltyBoxUntil) continue;

            let k30m=await fetchKlines(symbol, '30m', 150);
            if(k30m.length < 50) continue;
            k30m=calcBB(k30m); k30m=calcRSI(k30m); k30m=calcSuperTrend(k30m);
            const adx=calcADX(k30m.slice(0, k30m.length-1));
            const prevAdx=calcADX(k30m.slice(0, k30m.length-2));
            const curClosedK=k30m[k30m.length-2], prevClosedK=k30m[k30m.length-3], liveK=k30m[k30m.length-1];

            let activeMode = adx < 25 ? '🐒震荡监测' : '🌪️趋势监测';
            let rsiStr = curClosedK.rsi ? curClosedK.rsi.toFixed(1) : '0';
            console.log(`💤 瞄准镜 [${symbol}] | ${activeMode} | 现价:${liveK.c} | ADX:${adx.toFixed(1)} | RSI:${rsiStr} | 趋势:${curClosedK.trend==='LONG'?'🟢':'🔴'}`);

            // ==========================================
            // 🛡️ 持仓管理
            // ==========================================
            if(p.status!=='NONE'){
                let roe = p.status==='LONG'?(liveK.c-p.entryPrice)/p.entryPrice*LEVERAGE*100:(p.entryPrice-liveK.c)/p.entryPrice*LEVERAGE*100;
                if(roe>p.maxMfe) p.maxMfe=roe;
                let shouldClose=false, reason='';

                if(p.strategyMode==='SIDEWAYS'){
                    if(p.status==='LONG' && liveK.c>=curClosedK.bbMid){ shouldClose=true; reason='震荡止盈：吃完下轨反弹，回归中轨落袋！'; }
                    if(p.status==='SHORT' && liveK.c<=curClosedK.bbMid){ shouldClose=true; reason='震荡止盈：狙击摸顶成功，回归中轨落袋！'; }
                } else {
                    if(p.status==='LONG' && curClosedK.trend==='SHORT'){ shouldClose=true; reason='趋势翻红止损'; }
                    if(p.status==='SHORT' && curClosedK.trend==='LONG'){ shouldClose=true; reason='趋势翻绿止损'; }
                    if(!shouldClose && p.maxMfe>=20 && roe<=p.maxMfe*0.6){ shouldClose=true; reason=`动态追踪锁润: 锁住最高利润(${p.maxMfe.toFixed(1)}%)的60%`; }
                }

                if(shouldClose){
                    const r2=await binanceReq('/fapi/v2/positionRisk',{symbol},'GET');
                    if (r2 && r2[0]) {
                        await binanceReq('/fapi/v1/order',{symbol,side:p.status==='LONG'?'SELL':'BUY',type:'MARKET',quantity:Math.abs(parseFloat(r2[0].positionAmt))});
                        await binanceReq('/fapi/v1/allOpenOrders',{symbol},'DELETE');
                        
                        if (roe < 0 && p.strategyMode !== 'SIDEWAYS') {
                            p.penaltyBoxUntil = Date.now() + 6 * 3600000;
                            sendFeishu(`🩸 战舰撤退 [${symbol}]`,`结算: ${roe.toFixed(2)}%\n模式: ${p.strategyMode==='SIDEWAYS'?'🐒震荡':'🌪️趋势'}\n原因: ${reason}\n🚫 惩罚生效：关押6小时`);
                        } else {
                            sendFeishu(`💰 战舰收网 [${symbol}]`,`结算: ${roe.toFixed(2)}%\n模式: ${p.strategyMode==='SIDEWAYS'?'🐒震荡':'🌪️趋势'}\n最高浮盈: ${p.maxMfe.toFixed(1)}%\n原因: ${reason}`);
                        }
                    }
                    p.status='NONE'; p.maxMfe=0; p.strategyMode='NONE';
                } else {
                    console.log(`🛡️ 守卫中 [${symbol}] | 模式:${p.strategyMode==='SIDEWAYS'?'🐒':'🌪️'} | 浮盈:${roe.toFixed(2)}% | 最高:${p.maxMfe.toFixed(1)}%`);
                }
                continue;
            }

            // ==========================================
            // ⚔️ 入场扫描 (单发狙击)
            // ==========================================
            if(Object.values(positions).some(x=>x.status!=='NONE')) continue;
            
            let signal='WAIT', mode='NONE', tactic='';
            
            if(adx < 25){ 
                if(curClosedK.c < curClosedK.bbLower && curClosedK.rsi < 30){ 
                    signal='LONG'; mode='SIDEWAYS'; tactic='跌破下轨+超卖恐慌 (接刀)';
                }
                else if(curClosedK.c > curClosedK.bbUpper && curClosedK.rsi > 70){ 
                    signal='SHORT'; mode='SIDEWAYS'; tactic='突破上轨+超买狂热 (摸顶)';
                }
            } else { 
                if(curClosedK.trend !== btcTrend) continue; 
                
                if(prevClosedK.trend !== curClosedK.trend){ 
                    signal=curClosedK.trend; mode='TRENDING'; tactic='趋势反转鱼头 (ADX>=25)';
                }
                else if(prevAdx < 25 && adx >= 25){ 
                    signal=curClosedK.trend; mode='TRENDING'; tactic='ADX突破25油门踩死 (顺势吃鱼身)';
                }
            }

            if(signal !== 'WAIT'){
                let qtyStr = Math.max(7.0/liveK.c, (currentBalance*POSITION_RISK_PERCENT*LEVERAGE)/liveK.c).toFixed(QTY_PRECISION[symbol] || 3);
                let qty = parseFloat(qtyStr);
                
                console.log(`🔥 [${symbol}] 触发【${tactic}】！准备开火！`);
                const res=await binanceReq('/fapi/v1/order',{symbol,side:signal==='LONG'?'BUY':'SELL',type:'MARKET',quantity:qty});
                
                if(!res.code){
                    p.status=signal; p.strategyMode=mode; p.entryTime=Date.now();
                    setTimeout(async()=>{
                        const r3=await binanceReq('/fapi/v2/positionRisk',{symbol},'GET');
                        if (r3 && r3[0]) {
                            p.entryPrice=parseFloat(r3[0].entryPrice);
                            const sl=signal==='LONG'?p.entryPrice*(1-HARD_STOP_LOSS_PERCENT/100):p.entryPrice*(1+HARD_STOP_LOSS_PERCENT/100);
                            await binanceReq('/fapi/v1/order',{symbol,side:signal==='LONG'?'SELL':'BUY',type:'STOP_MARKET',stopPrice:parseFloat(sl.toFixed(PRICE_PRECISION[symbol] || 2)),closePosition:'true'});
                            sendFeishu(`🎯 战舰已开火！`,`标的: ${symbol}\n方向: ${signal==='LONG'?'🟢做多':'🔴做空'}\n模式: ${mode==='SIDEWAYS'?'🐒震荡模式':'🌪️大趋势模式'}\n战机: ${tactic}\n入场价: ${p.entryPrice}\n物理防爆: ${sl.toFixed(PRICE_PRECISION[symbol] || 2)} (-3%)`);
                        }
                    }, 2000);
                }
            }
        }
    } catch(e){ console.error("🔥 引擎异常:", e.message); } finally { isProcessing=false; }
}

http.createServer((req,res)=>{ 
    let realPnl = initialBalance !== null ? (currentBalance - initialBalance) : 0;
    res.setHeader('Content-Type','text/html; charset=utf-8'); 
    res.end(`<h1>V16.2 混合战舰 (修复版)</h1><h3>震荡/趋势 双引擎自动切换</h3><p>剩余本金: ${currentBalance.toFixed(3)} U</p><p>启动至今PNL: ${realPnl.toFixed(3)} U</p>`); 
}).listen(process.env.PORT||3000);

setInterval(() => {
    let msg = `🎯 战舰自动巡航中... ⚓\n`;
    let activePosCount = 0;
    SYMBOLS.forEach(s => { 
        let p = positions[s]; 
        if (p.status !== 'NONE') {
            msg += `- ${s}: 正在守卫 ${p.status} (${p.strategyMode==='SIDEWAYS'?'🐒':'🌪️'}) | 浮盈:${p.maxMfe.toFixed(1)}%\n`; 
            activePosCount++;
        } else if (Date.now() < p.penaltyBoxUntil) {
            msg += `- ${s}: 🚫 禁闭中 (剩 ${((p.penaltyBoxUntil - Date.now())/3600000).toFixed(1)}H)\n`;
        }
    });
    
    if (activePosCount === 0) msg += `\n- 引擎双速运转：风小打游击，风大抓牛熊！`;
    
    sendFeishu("📊 V16.2 平安汇报", msg);
}, 1 * 60 * 60 * 1000); 

setInterval(runMonitor, CHECK_INTERVAL_MS); 
runMonitor();
