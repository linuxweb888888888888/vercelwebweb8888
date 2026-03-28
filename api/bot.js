/******************************************************************************************
 * ⚡ HTX (HUOBI) AGGREGATOR - VERCEL SERVERLESS EDITION
 * Refactored for Stateless Execution, HTTP Polling, and Parallel Data Fetching
 ******************************************************************************************/

const express = require('express');
const ccxt = require('ccxt');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
// 🚨 Replace 'YOUR_PASSWORD_HERE' with your real DB password. 
// Best practice: Store this in Vercel Project Settings -> Environment Variables as MONGO_URI
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://web88888888888888_db_user:YOUR_PASSWORD_HERE@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888";

const TARGET_USERNAME = 'webwebwebweb8888';
const SUPPORTED_CURRENCIES = ['USDT', 'SHIB', 'XRP', 'BCH', 'ZAR'];

// ==================== GLOBAL CACHE (SURVIVES WARM STARTS) ====================
let mongoClient = null;
let botDb = null;
let dbCollection = null;

let targetUserId = null;
let targetIsPaper = false;
let activeBotSettings = {};
let latestDbActions = [];
let marketEvents = [];

let accountsCache = [];
let isDbInitialized = false;

// Shared Exchange Instance
const sharedExchange = new ccxt.huobi({
    enableRateLimit: false,
    options: { defaultType: 'linear' }
});

// ==================== DB INITIALIZATION ====================
async function initDB() {
    if (isDbInitialized) return;

    if (!mongoClient) {
        mongoClient = new MongoClient(MONGO_URI, { maxPoolSize: 10 });
        await mongoClient.connect();
    }

    botDb = mongoClient.db("botdb");
    dbCollection = mongoClient.db("HTX_Aggregator").collection("session_growth");
    
    const usersCol = botDb.collection("users");
    const masterUser = await usersCol.findOne({ username: TARGET_USERNAME });
    
    if (masterUser) {
        targetUserId = masterUser._id;
        targetIsPaper = masterUser.isPaper || false;
        
        const settingsColName = targetIsPaper ? "paper_settings" : "settings";
        const settingsCol = botDb.collection(settingsColName);
        const masterSettings = await settingsCol.findOne({ userId: targetUserId });
        
        if (masterSettings) {
            activeBotSettings = masterSettings;
            if (masterSettings.subAccounts) {
                accountsCache = masterSettings.subAccounts
                    .filter(sub => sub.apiKey && sub.secret)
                    .map((sub, idx) => ({
                        id: idx + 1,
                        name: sub.name || `Profile ${idx + 1}`,
                        apiKey: sub.apiKey,
                        secret: sub.secret,
                        lastPositions: {},
                        hasFetchedPositionsOnce: false
                    }));
            }
        }
    }
    isDbInitialized = true;
}

// ==================== SERVERLESS API ENDPOINTS ====================

// GET: Fetch the current state of all accounts and DB history
app.get('/api/data', async (req, res) => {
    try {
        await initDB();
        
        const targetCurrency = req.query.currency || 'USDT';
        
        // 1. Fetch DB History Limits
        const offsetColName = targetIsPaper ? "paper_offset_records" : "offset_records";
        const offsetCol = botDb.collection(offsetColName);
        latestDbActions = await offsetCol.find({ userId: targetUserId }).sort({ timestamp: -1 }).limit(50).toArray();

        // 2. Fetch HTX Data in Parallel to fit within Vercel's 10-second Serverless limit
        let grandTotal = 0;
        let grandFree = 0;
        let grandUsed = 0;
        let loadedCount = 0;
        const mappedAccounts = [];

        const fetchPromises = accountsCache.map(async (acc) => {
            let accTotal = 0;
            let accFree = 0;
            let accUsed = 0;
            let accError = null;

            try {
                sharedExchange.apiKey = acc.apiKey;
                sharedExchange.secret = acc.secret;
                
                // Optimized Parallel Fetching
                const [bal, ccxtPos] = await Promise.allSettled([
                    sharedExchange.fetchBalance({ type: 'swap', marginMode: 'cross' }),
                    sharedExchange.fetchPositions(undefined, { marginMode: 'cross' })
                ]);

                let totalEquity = 0;
                let freeCurrency = 0;
                let totalUnrealizedPnl = 0;
                let currentPosMap = {};

                if (bal.status === 'fulfilled' && bal.value?.total?.[targetCurrency] !== undefined) {
                    totalEquity = parseFloat(bal.value.total[targetCurrency] || 0);
                    freeCurrency = parseFloat(bal.value.free[targetCurrency] || 0);
                } else {
                    throw new Error("Balance API Failed");
                }

                if (ccxtPos.status === 'fulfilled' && ccxtPos.value) {
                    ccxtPos.value.forEach(p => {
                        totalUnrealizedPnl += parseFloat(p.unrealizedPnl || 0);
                        if (p.contracts > 0) currentPosMap[p.symbol || 'Unknown'] = p.contracts;
                    });
                }

                // Event tracker for Micro-Fluctuations (Kept in Warm-Start memory)
                let now = Date.now();
                if (acc.hasFetchedPositionsOnce) {
                    for (let sym in currentPosMap) {
                        let currQty = currentPosMap[sym];
                        let prevQty = acc.lastPositions[sym] || 0;
                        if (currQty > prevQty && prevQty === 0) marketEvents.unshift({ time: now, msg: `Opened new position on ${sym}`});
                        else if (currQty > prevQty) marketEvents.unshift({ time: now, msg: `Added contracts (DCA) to ${sym}`});
                        else if (currQty < prevQty) marketEvents.unshift({ time: now, msg: `Reduced contracts on ${sym}`});
                    }
                    for (let sym in acc.lastPositions) {
                        if (!currentPosMap[sym]) marketEvents.unshift({ time: now, msg: `Fully closed position on ${sym}`});
                    }
                    if (marketEvents.length > 20) marketEvents = marketEvents.slice(0, 20);
                }
                
                acc.lastPositions = currentPosMap;
                acc.hasFetchedPositionsOnce = true;

                const staticWalletBalance = totalEquity - totalUnrealizedPnl;
                accTotal = staticWalletBalance;
                accFree = freeCurrency;
                accUsed = totalEquity - freeCurrency;
                loadedCount++;

            } catch (err) {
                accError = "Conn Error";
            }

            grandTotal += accTotal;
            grandFree += accFree;
            grandUsed += accUsed;

            mappedAccounts.push({
                name: acc.name,
                total: accTotal,
                free: accFree,
                used: accUsed,
                error: accError,
                isLoaded: !accError
            });
        });

        await Promise.all(fetchPromises);

        // 3. Sync with DB Aggregator Stats
        let dbSession = await dbCollection.findOne({ currency: targetCurrency });
        if (!dbSession && loadedCount > 0) {
            dbSession = { startTime: Date.now(), startBalance: grandTotal, currency: targetCurrency };
            await dbCollection.updateOne(
                { currency: targetCurrency },
                { $set: dbSession },
                { upsert: true }
            );
        }

        let growth = 0;
        let growthPct = 0;
        let secondsElapsed = 0;
        let avgGrowthPerSec = 0;

        if (dbSession && dbSession.startBalance !== undefined) {
            secondsElapsed = Math.max(1, (Date.now() - dbSession.startTime) / 1000);
            growth = grandTotal - dbSession.startBalance;
            growthPct = dbSession.startBalance > 0 ? (growth / dbSession.startBalance) * 100 : 0;
            avgGrowthPerSec = growth / secondsElapsed;
            
            // Background DB Update
            dbCollection.updateOne(
                { currency: targetCurrency },
                { $set: { currentTotal: grandTotal, growth, growthPct, secondsElapsed, updatedAt: new Date() } }
            ).catch(() => {});
        }

        // Return Payload
        res.json({
            combined: {
                currency: targetCurrency,
                startTime: dbSession?.startTime || null,
                startBalance: dbSession?.startBalance || 0,
                total: grandTotal, free: grandFree, used: grandUsed,
                growth, growthPct, secondsElapsed,
                avgGrowthPerSec,
                avgGrowthPctPerSec: dbSession?.startBalance > 0 ? (avgGrowthPerSec / dbSession.startBalance) * 100 : 0,
                growthPerHour: avgGrowthPerSec * 3600,
                growthPerDay: avgGrowthPerSec * 86400,
                growthPerMonth: avgGrowthPerSec * 2592000,
                growthPerYear: avgGrowthPerSec * 31536000,
                timestamp: new Date().toLocaleTimeString(),
                isReady: !!dbSession,
                loadedCount, totalCount: accountsCache.length
            },
            accounts: mappedAccounts,
            dbRecords: latestDbActions,
            marketEvents: marketEvents,
            botSettings: {
                globalTargetPnl: activeBotSettings.globalTargetPnl || 0,
                smartOffsetNetProfit: activeBotSettings.smartOffsetNetProfit || 0,
                smartOffsetStopLoss: activeBotSettings.smartOffsetStopLoss || 0,
                smartOffsetNetProfit2: activeBotSettings.smartOffsetNetProfit2 || 0,
                autoDynamic: activeBotSettings.minuteCloseAutoDynamic || false
            }
        });

    } catch (err) {
        console.error("API Error:", err);
        res.status(500).json({ error: 'Server Error' });
    }
});

// POST: Trigger DB Resets
app.post('/api/action', express.json(), async (req, res) => {
    try {
        await initDB();
        if (req.body.action === 'reset' && req.body.currency && req.body.total) {
            const newState = {
                startTime: Date.now(),
                startBalance: parseFloat(req.body.total),
                currentTotal: parseFloat(req.body.total),
                growth: 0, growthPct: 0, secondsElapsed: 0, updatedAt: new Date()
            };
            marketEvents = [];
            await dbCollection.updateOne(
                { currency: req.body.currency },
                { $set: newState },
                { upsert: true }
            );
            res.json({ success: true });
        } else {
            res.status(400).json({ error: 'Invalid Action' });
        }
    } catch(err) {
        res.status(500).json({ error: 'Action Failed' });
    }
});

// SERVE FRONTEND (Replaces WebSockets with HTTP Fetch Polling)
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>HTX Master Aggregator (Vercel Edition)</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&family=Roboto+Mono:wght@400;500;700&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0" rel="stylesheet" />
    <style>
        :root { --primary: #3f51b5; --bg: #f0f2f5; --card-bg: #ffffff; --text-main: #1f2937; --text-light: #6b7280; --green: #10b981; --red: #ef4444; --shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
        body { background: var(--bg); color: var(--text-main); font-family: 'Roboto', sans-serif; margin: 0; padding: 0; }
        .top-nav { background: #ffffff; padding: 0 20px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #e5e7eb; box-shadow: 0 1px 3px rgba(0,0,0,0.05); height: 60px; margin-bottom: 25px; }
        .nav-logo { font-size: 18px; font-weight: 700; color: var(--primary); }
        .nav-links { display: flex; gap: 20px; }
        .nav-link { text-decoration: none; color: var(--text-light); font-weight: 500; font-size: 14px; padding: 10px 0; border-bottom: 2px solid transparent; transition: all 0.2s; cursor: pointer; }
        .nav-link:hover, .nav-link.active { color: var(--primary); border-bottom-color: var(--primary); }
        .container { max-width: 900px; margin: 0 auto; padding: 0 20px; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; }
        h1 { font-size: 22px; font-weight: 700; margin: 0; }
        .subtitle { font-size: 13px; color: var(--text-light); margin-top: 4px; }
        .controls { display: flex; align-items: center; gap: 10px; }
        .currency-select { background: #ffffff; border: 1px solid #d1d5db; padding: 6px 10px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; outline: none; box-shadow: var(--shadow); }
        .timer-badge { background: #e5e7eb; padding: 6px 14px; border-radius: 20px; font-size: 13px; font-family: 'Roboto Mono'; box-shadow: var(--shadow); }
        .btn-reset { background: white; border: 1px solid #d1d5db; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 11px; text-transform: uppercase; font-weight: 600; box-shadow: var(--shadow); }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
        .card { background: var(--card-bg); border-radius: 12px; box-shadow: var(--shadow); padding: 24px; }
        .card-title { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--text-light); margin-bottom: 12px; font-weight: 600; }
        .big-val { font-family: 'Roboto Mono'; font-size: 26px; font-weight: 700; line-height: 1.1; }
        .sub-val { font-family: 'Roboto Mono'; font-size: 13px; color: var(--text-light); margin-top: 6px; }
        .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #f3f4f6; font-size: 14px; }
        .val { font-weight: 500; font-family: 'Roboto Mono'; }
        .green-txt { color: var(--green) !important; } .red-txt { color: var(--red) !important; }
        .table-card { background: var(--card-bg); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; margin-top: 20px;}
        table { width: 100%; border-collapse: collapse; font-size: 14px; }
        th { background: #f9fafb; padding: 16px; text-align: left; border-bottom: 1px solid #e5e7eb; font-size: 12px; text-transform: uppercase; }
        td { padding: 16px; border-bottom: 1px solid #f3f4f6; font-family: 'Roboto Mono'; font-size: 13px;}
        .footer { text-align: center; margin-top: 40px; padding-bottom:20px; color: var(--text-light); font-size: 12px; }
        .dot { height: 8px; width: 8px; background-color: #bbb; border-radius: 50%; display: inline-block; margin-right: 6px; }
        .dot.live { background-color: var(--green); box-shadow: 0 0 4px var(--green); }
        .analytics-box { background: #f8fafc; border-left: 4px solid var(--primary); padding: 16px 20px; border-radius: 6px; margin-bottom: 20px; box-shadow: var(--shadow); }
        .analytics-title { font-weight: 700; font-size: 14px; margin-bottom: 12px; display: flex; align-items: center; gap: 6px; color: var(--primary); border-bottom: 1px solid #e5e7eb; padding-bottom: 8px;}
        .setting-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 13px; }
        .setting-item { display: flex; justify-content: space-between; background: #fff; padding: 8px 12px; border: 1px solid #e5e7eb; border-radius: 4px; }
        .history-card { background: var(--card-bg); border-radius: 12px; box-shadow: var(--shadow); padding: 20px; margin-bottom: 20px; max-height: 250px; overflow-y: auto; }
        .history-item { padding: 12px 0; border-bottom: 1px solid #f3f4f6; font-size: 13px; display: flex; gap: 12px; align-items: flex-start; }
        .history-time { color: var(--text-light); font-family: 'Roboto Mono'; font-size: 12px; width: 85px; }
        .reason-badge { padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 700; margin-right: 8px; }
        .bg-green { background: #dcfce7; color: #166534; } .bg-red { background: #fee2e2; color: #991b1b; } .bg-blue { background: #dbeafe; color: #1e40af; }
    </style>
</head>
<body>

<div class="top-nav">
    <div class="nav-logo">⚡ HTX Aggregator (Vercel Node)</div>
    <div class="nav-links">
        <a class="nav-link active" id="tab-dashboard" onclick="switchTab('dashboard')">Overview Dashboard</a>
        <a class="nav-link" id="tab-accounts" onclick="switchTab('accounts')">Accounts & Analytics</a>
    </div>
</div>

<div class="container">
    <div class="header">
        <div>
            <h1 id="page-title">Portfolio Overview</h1>
            <div class="subtitle" id="status-text">Connecting to Serverless Backend...</div>
        </div>
        <div class="controls">
            <select class="currency-select" id="currencySelect" onchange="changeCurrency(this.value)">
                <option value="USDT">USDT</option>
                <option value="SHIB">SHIB</option>
                <option value="XRP">XRP</option>
                <option value="BCH">BCH</option>
                <option value="ZAR">ZAR</option>
            </select>
            <div class="timer-badge" id="elapsed">--:--:--</div>
            <button class="btn-reset" onclick="requestReset()">Reset Stats</button>
        </div>
    </div>

    <div id="page-dashboard">
        <div class="grid">
            <div class="card">
                <div class="card-title">Live Wallet</div>
                <div class="big-val" id="total">Loading...</div>
                <div class="sub-val">Available: <span id="free">--</span></div>
            </div>
            <div class="card">
                <div class="card-title">Realized Session Growth</div>
                <div class="big-val" id="growth">--</div>
                <div class="sub-val" id="growthPct">--%</div>
            </div>
        </div>

        <div class="grid">
            <div class="card">
                <div class="card-title">Realized Projections (Avg)</div>
                <div class="row"><span>Est. Second</span> <span class="val" id="projSec">--</span></div>
                <div class="row"><span>Est. Hour</span> <span class="val" id="projHour">--</span></div>
                <div class="row"><span>Est. Day</span> <span class="val" id="projDay">--</span></div>
                <div class="row"><span>Est. Month</span> <span class="val" id="projMonth">--</span></div>
                <div class="row"><span>Est. Year</span> <span class="val" id="projYear">--</span></div>
            </div>
            <div class="card">
                <div class="card-title">Session Balances & Margin</div>
                <div class="row"><span>Starting Wallet</span> <span class="val" id="startWallet">--</span></div>
                <div class="row"><span>Current Wallet</span> <span class="val" id="currentWallet">--</span></div>
                <div class="row"><span>Used Margin</span> <span class="val" id="used">--</span></div>
            </div>
        </div>
    </div>

    <div id="page-accounts" style="display: none;">
        <div class="analytics-box" style="border-left-color: var(--green);">
            <div class="analytics-title"><span class="material-symbols-outlined">query_stats</span> Realized Session Growth Drivers</div>
            <div id="realized-drivers-grid"><div class="setting-item"><span>Analyzing database history...</span></div></div>
        </div>

        <div class="analytics-box">
            <div class="analytics-title"><span class="material-symbols-outlined">settings_applications</span> Active Logic Parameters</div>
            <div class="setting-grid" id="bot-settings-grid"><div class="setting-item"><span>Fetching...</span></div></div>
        </div>

        <div class="history-card" id="history-log-container">
            <div class="card-title" style="margin-bottom: 0;">Database Trade History Log</div>
            <div id="history-log-content">Syncing...</div>
        </div>

        <div class="table-card">
            <table id="accTable">
                <thead><tr><th>Account Profile</th><th style="text-align:right">Wallet</th><th style="text-align:right">Free</th><th style="text-align:right">Status</th></tr></thead>
                <tbody id="accBody"></tbody>
            </table>
        </div>
    </div>

    <div class="footer"><span class="dot" id="dot"></span> Updated: <span id="time">--</span></div>
</div>

<script>
    let currentCurrency = 'USDT';
    let lastTotal = 0;

    function switchTab(t) {
        document.getElementById('page-dashboard').style.display = t==='dashboard'?'block':'none';
        document.getElementById('page-accounts').style.display = t==='accounts'?'block':'none';
        document.getElementById('tab-dashboard').classList.toggle('active', t==='dashboard');
        document.getElementById('tab-accounts').classList.toggle('active', t==='accounts');
        document.getElementById('page-title').innerText = t==='dashboard'?"Portfolio Overview":"Accounts & Analytics";
    }

    function changeCurrency(val) {
        currentCurrency = val;
        document.getElementById('status-text').innerText = 'Switching...';
        document.getElementById('total').innerText = 'Loading...';
        fetchData();
    }

    async function requestReset() {
        if(confirm('Reset stats to current Wallet Balance?')) {
            await fetch('/api/action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'reset', currency: currentCurrency, total: lastTotal })
            });
            fetchData();
        }
    }

    const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 10, maximumFractionDigits: 10 });
    const fmt14 = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 14, maximumFractionDigits: 14 });
    const colorClass = (n) => n > 0 ? 'green-txt' : (n < 0 ? 'red-txt' : '');

    const updateVal = (id, val, isPct=false, col=false, curr='') => {
        const el = document.getElementById(id);
        if(!el) return;
        let txt = isPct ? (val>0?'+':'') + Number(val).toFixed(10)+'%' : fmt(val);
        if(col && val>0 && !isPct) txt = '+' + txt;
        if(curr && !isPct) txt += ' ' + curr;
        el.innerText = txt;
        if(col) el.className = 'val ' + colorClass(val);
    };

    async function fetchData() {
        try {
            const res = await fetch('/api/data?currency=' + currentCurrency);
            const data = await res.json();
            
            document.getElementById('dot').classList.add('live');
            setTimeout(() => document.getElementById('dot').classList.remove('live'), 500);

            const c = data.combined;
            lastTotal = c.total;
            
            document.getElementById('status-text').innerText = \`Tracking \${c.currency} Portfolio (\${c.loadedCount}/\${c.totalCount} APIs Ready)\`;
            
            const h = Math.floor(c.secondsElapsed / 3600).toString().padStart(2,'0');
            const m = Math.floor((c.secondsElapsed % 3600) / 60).toString().padStart(2,'0');
            const s = Math.floor(c.secondsElapsed % 60).toString().padStart(2,'0');
            document.getElementById('elapsed').innerText = \`\${h}:\${m}:\${s}\`;
            document.getElementById('time').innerText = c.timestamp;

            updateVal('total', c.total, false, false, c.currency);
            updateVal('free', c.free, false, false, c.currency);
            updateVal('growth', c.growth, false, true, c.currency);
            document.getElementById('growthPct').innerHTML = \`<span class="\${colorClass(c.growthPct)}">\${(c.growthPct>0?'+':'') + Number(c.growthPct).toFixed(10)}%</span>\`;

            let secAbs = (c.avgGrowthPerSec > 0 ? '+' : '') + fmt14(c.avgGrowthPerSec);
            let secPct = (c.avgGrowthPctPerSec > 0 ? '+' : '') + Number(c.avgGrowthPctPerSec).toFixed(14) + '%';
            document.getElementById('projSec').innerText = \`\${secAbs} \${c.currency} (\${secPct})\`;
            document.getElementById('projSec').className = 'val ' + colorClass(c.avgGrowthPerSec);

            updateVal('projHour', c.growthPerHour, false, true, c.currency);
            updateVal('projDay', c.growthPerDay, false, true, c.currency);
            updateVal('projMonth', c.growthPerMonth, false, true, c.currency);
            updateVal('projYear', c.growthPerYear, false, true, c.currency);
            updateVal('startWallet', c.startBalance, false, false, c.currency);
            updateVal('currentWallet', c.total, false, false, c.currency);
            updateVal('used', c.used, false, false, c.currency);

            // Accounts Table
            const tbody = document.getElementById('accBody');
            tbody.innerHTML = '';
            data.accounts.forEach(acc => {
                const stat = acc.isLoaded ? '<span style="color:var(--green);font-weight:700;">OK</span>' : '<span style="color:var(--red);font-weight:700;">Error</span>';
                tbody.innerHTML += \`<tr><td>\${acc.name}</td><td style="text-align:right;">\${fmt(acc.total)}</td><td style="text-align:right;color:#6b7280;">\${fmt(acc.free)}</td><td style="text-align:right;">\${stat}</td></tr>\`;
            });

            // Settings & History
            const s = data.botSettings;
            document.getElementById('bot-settings-grid').innerHTML = \`
                <div class="setting-item"><span>Global Target:</span> <strong>$\${s.globalTargetPnl.toFixed(2)}</strong></div>
                <div class="setting-item"><span>Auto-Dynamic:</span> <strong>\${s.autoDynamic?'<span class="green-txt">ON</span>':'<span class="red-txt">OFF</span>'}</strong></div>
                <div class="setting-item"><span>Smart Offset V1 TP/SL:</span> <strong>$\${s.smartOffsetNetProfit.toFixed(2)} / $\${s.smartOffsetStopLoss.toFixed(2)}</strong></div>
            \`;

            let histHtml = '';
            data.dbRecords.forEach(r => {
                const time = new Date(r.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
                const net = r.netProfit || 0;
                const netStr = (net>=0?'+':'') + '$' + net.toFixed(4);
                histHtml += \`<div class="history-item"><div class="history-time">[\${time}]</div><div><span class="reason-badge \${net>0?'bg-green':'bg-red'}">\${r.reason||'Trade Event'}</span> <strong>\${r.symbol||'Unknown'}</strong> resulting in <strong class="\${net>=0?'green-txt':'red-txt'}">\${netStr}</strong></div></div>\`;
            });
            document.getElementById('history-log-content').innerHTML = histHtml || '<div style="padding:10px; color:#6b7280;">No records found.</div>';

        } catch(e) { console.error("Poll Error:", e); }
    }

    // Serverless HTTP Polling replaces Socket.io
    fetchData(); // Initial load
    setInterval(fetchData, 2500); // Refreshes every 2.5 seconds

</script>
</body>
</html>
    `);
});

// For local testing (Vercel ignores this)
if (process.env.NODE_ENV !== 'production') {
    app.listen(3000, () => console.log('Local Serverless Emulation on port 3000'));
}

module.exports = app;
