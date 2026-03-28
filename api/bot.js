/******************************************************************************************
 * ⚡ HTX (HUOBI) AGGREGATOR - VERCEL SERVERLESS EDITION
 * Optimized for Vercel Serverless Functions (No WebSockets, On-Demand Caching)
 ******************************************************************************************/

const express = require('express');
const ccxt = require('ccxt');
const { MongoClient } = require('mongodb');

// dotenv removed for Vercel compatibility

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
// Set your MONGO_URI in Vercel Environment Variables!
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888";
const TARGET_USERNAME = 'webwebwebweb8888';
const CACHE_TTL_MS = 2000; // Cache exchange data for 2 seconds to prevent Vercel rate-limit bans

// ==================== GLOBAL SERVERLESS CACHE ====================
// Vercel keeps these variables alive ONLY while the container is "warm"
let mongoClient = null;
let botDb = null;
let dbCollection = null;

let targetUserId = null;
let targetIsPaper = false;
let activeBotSettings = {};
let accounts = [];

let latestDbActions = [];
let marketEvents = [];

let state = {
    startTime: null,         
    startBalance: 0,      
    isInitialized: false,
    lastDbSave: 0
};

// Caching exchange fetches so rapid UI polling doesn't spam Huobi
let exchangeCache = {
    lastFetch: 0,
    isFetching: false,
    data: []
};

// ==================== MONGODB INIT (ROBUST "VACUUM" VERSION) ====================
async function initDb() {
    // Check if fully initialized, not just the client
    if (mongoClient && botDb && dbCollection && accounts.length > 0) return; 
    
    try {
        mongoClient = new MongoClient(MONGO_URI);
        await mongoClient.connect();
        
        botDb = mongoClient.db("botdb");
        dbCollection = mongoClient.db("HTX_Aggregator").collection("session_growth");
        
        const usersCol = botDb.collection("users");
        
        // 1. Find the Master User
        const masterUser = await usersCol.findOne({ username: TARGET_USERNAME });
        
        if (!masterUser) {
            throw new Error(`User '${TARGET_USERNAME}' does not exist in the 'users' collection.`);
        }
        
        targetUserId = masterUser._id;
        targetIsPaper = masterUser.isPaper || false;
        
        const settingsColName = targetIsPaper ? "paper_settings" : "settings";
        const settingsCol = botDb.collection(settingsColName);
        
        // 2. Find Settings (Check both ObjectId and String formats for userId)
        activeBotSettings = await settingsCol.findOne({ 
            $or: [
                { userId: targetUserId }, 
                { userId: targetUserId.toString() }
            ] 
        }) || {};
        
        // 3. Hunt for the API profiles (Check all common database naming conventions)
        let rawProfiles = activeBotSettings.subAccounts 
                       || activeBotSettings.accounts 
                       || masterUser.subAccounts 
                       || masterUser.accounts 
                       || [];
        
        if (!rawProfiles || rawProfiles.length === 0) {
            throw new Error(`No API profiles found in DB for '${TARGET_USERNAME}'. Checked settings & user doc.`);
        }

        // 4. Map the profiles into memory
        accounts = rawProfiles
            .filter(sub => sub.apiKey && sub.secret)
            .map((sub, index) => ({
                id: index + 1,
                name: sub.name || `Profile ${index + 1}`,
                apiKey: sub.apiKey,
                secret: sub.secret,
                lastPositions: {},
                hasFetchedPositionsOnce: false
            }));

        if (accounts.length === 0) {
            throw new Error("Profiles were found, but they are missing 'apiKey' or 'secret' fields.");
        }

    } catch (err) {
        // If connection/setup fails, wipe the cache so we can try again cleanly
        mongoClient = null;
        botDb = null;
        dbCollection = null;
        accounts = [];
        throw new Error("Database Init Error: " + err.message);
    }
}

// ==================== ON-DEMAND EXCHANGE FETCHING ====================
async function fetchAccountData(currency) {
    const sharedExchange = new ccxt.huobi({ enableRateLimit: false, options: { defaultType: 'linear' } });
    
    const results = await Promise.all(accounts.map(async (acc) => {
        sharedExchange.apiKey = acc.apiKey;
        sharedExchange.secret = acc.secret;
        
        let totalEquity = 0; let freeCurrency = 0; let balSuccess = false;
        let totalUnrealizedPnl = 0; let currentPosMap = {};
        let error = null;

        try {
            const bal = await sharedExchange.fetchBalance({ type: 'swap', marginMode: 'cross' });
            if (bal?.total?.[currency] !== undefined) {
                totalEquity = parseFloat(bal.total[currency] || 0);
                freeCurrency = parseFloat(bal.free[currency] || 0);
                balSuccess = true;
            }

            const ccxtPos = await sharedExchange.fetchPositions(undefined, { marginMode: 'cross' });
            if (ccxtPos) {
                ccxtPos.forEach(p => { 
                    totalUnrealizedPnl += parseFloat(p.unrealizedPnl || 0); 
                    if (p.contracts > 0) currentPosMap[p.symbol || 'Unknown'] = p.contracts;
                });
            }

            // Market Events Logic
            let now = Date.now();
            if (!acc.hasFetchedPositionsOnce) {
                acc.lastPositions = currentPosMap;
                acc.hasFetchedPositionsOnce = true;
            } else {
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
                acc.lastPositions = currentPosMap;
            }

        } catch (err) {
            error = "Conn Error";
        }

        return {
            name: acc.name,
            total: balSuccess ? (totalEquity - totalUnrealizedPnl) : 0,
            free: freeCurrency,
            used: balSuccess ? (totalEquity - freeCurrency) : 0,
            error: error,
            isLoaded: true
        };
    }));

    return results;
}

// ==================== API ROUTES ====================

app.get('/', (req, res) => res.send(getHtml()));

app.get('/api/data', async (req, res) => {
    try {
        await initDb();
        const targetCurrency = req.query.currency || 'USDT';

        // 1. Check DB Logs
        const offsetCol = botDb.collection(targetIsPaper ? "paper_offset_records" : "offset_records");
        latestDbActions = await offsetCol.find({ userId: targetUserId }).sort({ timestamp: -1 }).limit(100).toArray();

        // 2. Fetch Exchange Data (with Cache for Vercel limits)
        let accData = exchangeCache.data;
        if (Date.now() - exchangeCache.lastFetch > CACHE_TTL_MS) {
            accData = await fetchAccountData(targetCurrency);
            exchangeCache.data = accData;
            exchangeCache.lastFetch = Date.now();
        }

        // 3. Aggregate Data
        let grandTotal = 0; let grandFree = 0; let grandUsed = 0; let loadedCount = 0;
        let allHealthy = true;

        accData.forEach(a => {
            if (!a.error) {
                grandTotal += a.total; grandFree += a.free; grandUsed += a.used; loadedCount++;
            } else {
                allHealthy = false;
            }
        });

        // Initialize Session from DB if needed
        if (!state.isInitialized && loadedCount === accounts.length && allHealthy && accounts.length > 0) {
            let doc = await dbCollection.findOne({ currency: targetCurrency });
            if (doc && doc.startTime) {
                state.startTime = doc.startTime;
                state.startBalance = doc.startBalance;
            } else {
                state.startTime = Date.now();
                state.startBalance = grandTotal;
                await dbCollection.updateOne({ currency: targetCurrency },
                    { $set: { startTime: state.startTime, startBalance: state.startBalance, updatedAt: new Date() } },
                    { upsert: true });
            }
            state.isInitialized = true;
        }

        // Build Response Payload
        const now = Date.now();
        const secondsElapsed = state.isInitialized ? Math.max(1, (now - state.startTime) / 1000) : 0;
        const growth = state.isInitialized ? (grandTotal - state.startBalance) : 0;
        const avgGrowthPerSec = secondsElapsed > 0 ? growth / secondsElapsed : 0;

        // Background DB Save
        if (state.isInitialized && (now - state.lastDbSave) > 10000) {
            state.lastDbSave = now;
            dbCollection.updateOne({ currency: targetCurrency },
                { $set: { currentTotal: grandTotal, growth, secondsElapsed, updatedAt: new Date() } },
                { upsert: true }).catch(()=>{});
        }

        res.json({
            combined: {
                currency: targetCurrency,
                startTime: state.startTime,
                startBalance: state.startBalance,
                total: grandTotal, free: grandFree, used: grandUsed,
                growth, growthPct: state.startBalance > 0 ? (growth / state.startBalance) * 100 : 0,
                avgGrowthPerSec, avgGrowthPctPerSec: state.startBalance > 0 ? (avgGrowthPerSec / state.startBalance) * 100 : 0,
                growthPerHour: avgGrowthPerSec * 3600,
                growthPerDay: avgGrowthPerSec * 86400,
                growthPerMonth: avgGrowthPerSec * 2592000,
                growthPerYear: avgGrowthPerSec * 31536000,
                secondsElapsed, timestamp: new Date().toLocaleTimeString(),
                isReady: state.isInitialized,
                loadedCount, totalCount: accounts.length
            },
            accounts: accData,
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
    } catch (e) {
        // Return a clean 500 error to the frontend if something breaks
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/reset', async (req, res) => {
    try {
        await initDb();
        const targetCurrency = req.body.currency;
        const currentTotal = req.body.total;
        
        state.startTime = Date.now();
        state.startBalance = currentTotal;
        state.isInitialized = true;
        marketEvents = [];

        await dbCollection.updateOne({ currency: targetCurrency },
            { $set: { startTime: state.startTime, startBalance: state.startBalance, currentTotal, growth: 0, secondsElapsed: 0 } },
            { upsert: true });

        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Export Express App for Vercel
module.exports = app;

// ==================== UI TEMPLATE ====================
function getHtml() { 
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>HTX Master Aggregator</title>
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
        .nav-link:hover { color: var(--primary); }
        .nav-link.active { color: var(--primary); border-bottom: 2px solid var(--primary); }
        .container { max-width: 900px; margin: 0 auto; padding: 0 20px; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; }
        h1 { font-size: 22px; font-weight: 700; margin: 0; }
        .subtitle { font-size: 13px; color: var(--text-light); margin-top: 4px; }
        .controls { display: flex; align-items: center; gap: 10px; }
        .currency-select { background: #ffffff; border: 1px solid #d1d5db; padding: 6px 10px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
        .timer-badge { background: #e5e7eb; padding: 6px 14px; border-radius: 20px; font-size: 13px; font-family: 'Roboto Mono'; }
        .btn-reset { background: white; border: 1px solid #d1d5db; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 11px; text-transform: uppercase; font-weight: 600; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
        .card { background: var(--card-bg); border-radius: 12px; box-shadow: var(--shadow); padding: 24px; }
        .card-title { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--text-light); margin-bottom: 12px; font-weight: 600; }
        .big-val { font-family: 'Roboto Mono'; font-size: 26px; font-weight: 700; line-height: 1.1; }
        .sub-val { font-family: 'Roboto Mono'; font-size: 13px; color: var(--text-light); margin-top: 6px; }
        .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #f3f4f6; font-size: 14px; }
        .row:last-child { border-bottom: none; }
        .val { font-weight: 500; font-family: 'Roboto Mono'; }
        .green-txt { color: var(--green) !important; } .red-txt { color: var(--red) !important; }
        .table-card { background: var(--card-bg); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; margin-top: 20px;}
        table { width: 100%; border-collapse: collapse; font-size: 14px; }
        th { background: #f9fafb; padding: 16px; text-align: left; border-bottom: 1px solid #e5e7eb; font-size: 12px; text-transform: uppercase; }
        td { padding: 16px; border-bottom: 1px solid #f3f4f6; }
        td.num-col { font-family: 'Roboto Mono'; font-size: 13px; }
        .footer { text-align: center; margin-top: 40px; padding-bottom:20px; color: var(--text-light); font-size: 12px; }
        .dot { height: 8px; width: 8px; background-color: #bbb; border-radius: 50%; display: inline-block; margin-right: 6px; }
        .dot.live { background-color: var(--green); box-shadow: 0 0 4px var(--green); }
        .analytics-box { background: #f8fafc; border-left: 4px solid var(--primary); padding: 16px 20px; border-radius: 6px; margin-bottom: 20px; box-shadow: var(--shadow); }
        .analytics-title { font-weight: 700; font-size: 14px; margin-bottom: 12px; display: flex; align-items: center; gap: 6px; color: var(--primary); border-bottom: 1px solid #e5e7eb; padding-bottom: 8px;}
        .setting-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 13px; }
        .setting-item { display: flex; justify-content: space-between; background: #fff; padding: 8px 12px; border: 1px solid #e5e7eb; border-radius: 4px; }
        .setting-item strong { color: #4b5563; }
        .history-card { background: var(--card-bg); border-radius: 12px; box-shadow: var(--shadow); padding: 20px; margin-bottom: 20px; max-height: 250px; overflow-y: auto; }
        .history-item { padding: 12px 0; border-bottom: 1px solid #f3f4f6; font-size: 13px; display: flex; gap: 12px; align-items: flex-start; }
        .history-time { color: var(--text-light); font-family: 'Roboto Mono'; white-space: nowrap; font-size: 12px; width: 85px; }
        .history-msg { color: #4b5563; line-height: 1.4; width: 100%; }
        .reason-badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 700; margin-right: 8px; }
        .bg-green { background: #dcfce7; color: #166534; }
        .bg-red { background: #fee2e2; color: #991b1b; }
        .bg-blue { background: #dbeafe; color: #1e40af; }
    </style>
</head>
<body>

<!-- TOP NAVIGATION -->
<div class="top-nav">
    <div class="nav-logo">⚡ HTX Master Aggregator (Serverless Edition)</div>
    <div class="nav-links">
        <a class="nav-link active" id="tab-dashboard" onclick="switchTab('dashboard')">Overview Dashboard</a>
        <a class="nav-link" id="tab-accounts" onclick="switchTab('accounts')">Accounts & Analytics</a>
    </div>
</div>

<div class="container">
    <div class="header">
        <div>
            <h1 id="page-title">Portfolio Overview</h1>
            <div class="subtitle" id="status-text" style="color:var(--primary); font-weight:600;">Connecting to Vercel API...</div>
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
            <button class="btn-reset" onclick="resetSession()">Reset Stats</button>
        </div>
    </div>

    <!-- PAGE 1: DASHBOARD -->
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

    <!-- PAGE 2: ACCOUNTS & ANALYTICS -->
    <div id="page-accounts" style="display: none;">
        <div class="analytics-box" style="border-left-color: var(--green);">
            <div class="analytics-title"><span class="material-symbols-outlined">query_stats</span> Realized Session Growth Drivers</div>
            <div id="realized-drivers-grid" style="display:block;"></div>
        </div>

        <div class="analytics-box">
            <div class="analytics-title"><span class="material-symbols-outlined">settings_applications</span> Active Logic Parameters</div>
            <div class="setting-grid" id="bot-settings-grid"></div>
        </div>

        <div class="history-card" id="history-log-container">
            <div class="card-title" style="margin-bottom: 0; display:flex; justify-content:space-between;">
                <span>Database Trade History Log</span>
            </div>
            <div id="history-log-content"></div>
        </div>

        <div class="table-card">
            <table id="accTable">
                <thead>
                    <tr>
                        <th>Account Profile</th>
                        <th style="text-align:right">Wallet Balance</th>
                        <th style="text-align:right">Available Free</th>
                        <th style="text-align:right">Status</th>
                    </tr>
                </thead>
                <tbody id="accBody"></tbody>
            </table>
        </div>
    </div>

    <div class="footer">
        <span class="dot" id="dot"></span> Updated: <span id="time">--</span>
    </div>
</div>

<script>
    let activeCurrency = 'USDT';
    let currentTotalSnapshot = 0;

    function switchTab(tabName) {
        document.getElementById('page-dashboard').style.display = 'none';
        document.getElementById('page-accounts').style.display = 'none';
        document.getElementById('tab-dashboard').classList.remove('active');
        document.getElementById('tab-accounts').classList.remove('active');
        
        if (tabName === 'dashboard') {
            document.getElementById('page-dashboard').style.display = 'block';
            document.getElementById('tab-dashboard').classList.add('active');
            document.getElementById('page-title').innerText = "Portfolio Overview";
        } else {
            document.getElementById('page-accounts').style.display = 'block';
            document.getElementById('tab-accounts').classList.add('active');
            document.getElementById('page-title').innerText = "Accounts & Analytics";
        }
    }

    function changeCurrency(newCoin) {
        activeCurrency = newCoin;
        document.getElementById('status-text').innerText = 'Switching currencies...';
        document.getElementById('total').innerText = 'Loading...';
        fetchData();
    }

    async function resetSession() { 
        if(confirm('Reset stats to current Wallet Balance?')) {
            await fetch('/api/reset', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currency: activeCurrency, total: currentTotalSnapshot })
            });
            fetchData();
        }
    }

    const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 10, maximumFractionDigits: 10 });
    const fmtPct = (n) => (n > 0 ? '+' : '') + Number(n).toFixed(10) + '%';
    const fmt14 = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 14, maximumFractionDigits: 14 });
    const fmtPct14 = (n) => (n > 0 ? '+' : '') + Number(n).toFixed(14) + '%';
    const colorClass = (n) => n > 0 ? 'green-txt' : (n < 0 ? 'red-txt' : '');
    
    const formatTime = (seconds) => {
        const h = Math.floor(seconds / 3600).toString().padStart(2,'0');
        const m = Math.floor((seconds % 3600) / 60).toString().padStart(2,'0');
        const s = Math.floor(seconds % 60).toString().padStart(2,'0');
        return \`\${h}:\${m}:\${s}\`;
    };

    const updateVal = (id, val, isPct=false, colorize=false, currency='') => {
        const el = document.getElementById(id);
        if(!el) return;
        let txt = isPct ? fmtPct(val) : fmt(val);
        if(colorize && val > 0 && !isPct) txt = '+' + txt;
        if(currency && !isPct) txt = txt + ' ' + currency;
        
        el.innerText = txt;
        if(colorize) {
            el.className = 'val ' + colorClass(val);
            if(id === 'growth') el.classList.add('big-val'); 
        } 
    };

    // Replace Socket with HTTP Polling
    async function fetchData() {
        try {
            const res = await fetch('/api/data?currency=' + activeCurrency);
            
            // If the server returns a crash (500) or not found (404), throw an error so the catch block sees it
            if (!res.ok) {
                const textError = await res.text();
                // Check if it's JSON to print cleaner error
                try {
                    const jsonError = JSON.parse(textError);
                    if(jsonError.error) throw new Error(jsonError.error);
                } catch(e) {
                    if(e.message !== "Unexpected token < in JSON at position 0") {
                        throw new Error(e.message);
                    }
                }
                throw new Error(\`Server returned \${res.status}: \${textError}\`);
            }

            const data = await res.json();
            
            if (data.error) {
                throw new Error(data.error);
            }

            document.getElementById('dot').classList.add('live');
            setTimeout(() => document.getElementById('dot').classList.remove('live'), 500);

            const c = data.combined;
            currentTotalSnapshot = c.total;

            if (!c.isReady) {
                document.getElementById('status-text').innerText = \`Fetching \${c.currency} Data...\`;
                renderTable(data.accounts, c.currency);
                return;
            }

            document.getElementById('status-text').innerText = \`Tracking \${c.currency} Portfolio (\${c.loadedCount} accounts)\`;
            document.getElementById('status-text').style.color = 'var(--text-light)';
            
            document.getElementById('elapsed').innerText = formatTime(c.secondsElapsed);
            document.getElementById('time').innerText = c.timestamp;

            updateVal('total', c.total, false, false, c.currency);
            updateVal('free', c.free, false, false, c.currency);
            updateVal('growth', c.growth, false, true, c.currency);
            document.getElementById('growthPct').innerHTML = \`<span class="\${colorClass(c.growthPct)}">\${fmtPct(c.growthPct)}</span>\`;

            const secEl = document.getElementById('projSec');
            if (secEl) {
                let txtAbs = fmt14(c.avgGrowthPerSec);
                if (c.avgGrowthPerSec > 0) txtAbs = '+' + txtAbs;
                secEl.innerText = txtAbs + ' ' + c.currency + ' (' + fmtPct14(c.avgGrowthPctPerSec) + ')';
                secEl.className = 'val ' + colorClass(c.avgGrowthPerSec);
            }

            updateVal('projHour', c.growthPerHour, false, true, c.currency);
            updateVal('projDay', c.growthPerDay, false, true, c.currency);
            updateVal('projMonth', c.growthPerMonth, false, true, c.currency);
            updateVal('projYear', c.growthPerYear, false, true, c.currency);
            updateVal('startWallet', c.startBalance, false, false, c.currency);
            updateVal('currentWallet', c.total, false, false, c.currency);
            updateVal('used', c.used, false, false, c.currency);

            renderTable(data.accounts, c.currency);
            updatePreciseReasoning(data.dbRecords, data.botSettings, c.startTime, c.growth, data.marketEvents);

        } catch(err) {
            console.error("Fetch Data Error:", err);
            // This will display exactly what broke right below the "Portfolio Overview" title
            document.getElementById('status-text').innerText = 'Connection Error: ' + err.message;
            document.getElementById('status-text').style.color = 'var(--red)';
        }
    }

    function updatePreciseReasoning(records, settings, startTime, actualGrowth, marketEvents) {
        const grid = document.getElementById('bot-settings-grid');
        grid.innerHTML = \`
            <div class="setting-item"><span>Global Target PNL:</span> <strong>$\${(settings.globalTargetPnl||0).toFixed(2)}</strong></div>
            <div class="setting-item"><span>Auto-Dynamic 1-Min:</span> <strong>\${settings.autoDynamic ? '<span class="green-txt">ON</span>' : '<span class="red-txt">OFF</span>'}</strong></div>
            <div class="setting-item"><span>Smart Offset V1 TP:</span> <strong>$\${(settings.smartOffsetNetProfit||0).toFixed(2)}</strong></div>
            <div class="setting-item"><span>Smart Offset V1 SL:</span> <strong>$\${(settings.smartOffsetStopLoss||0).toFixed(2)}</strong></div>
            <div class="setting-item"><span>Smart Offset V2 TP:</span> <strong>$\${(settings.smartOffsetNetProfit2||0).toFixed(2)}</strong></div>
            <div class="setting-item"><span>Smart Offset V2 SL:</span> <strong>$\${(settings.smartOffsetStopLoss2 || 0).toFixed(2)}</strong></div>
        \`;

        const driversEl = document.getElementById('realized-drivers-grid');
        if (startTime && records) {
            const sessionRecords = records.filter(r => new Date(r.timestamp).getTime() > startTime);
            let dbNetProfit = 0; let html = '';

            if (sessionRecords.length === 0) {
                html += '<div style="margin-bottom:12px; color:var(--text-light);">No completed database trades yet this session.</div>';
            } else {
                const breakdown = {};
                sessionRecords.forEach(r => {
                    const reason = r.reason || (r.loserSymbol ? 'Legacy Smart Offset' : 'Trade Event');
                    if (!breakdown[reason]) breakdown[reason] = { count: 0, net: 0 };
                    breakdown[reason].count += 1;
                    breakdown[reason].net += (r.netProfit || 0);
                    dbNetProfit += (r.netProfit || 0);
                });

                html += '<ul style="margin: 0 0 12px 0; padding-left: 20px; font-size: 14px;">';
                for (const [reason, data] of Object.entries(breakdown)) {
                    const netStr = (data.net >= 0 ? '+' : '') + '$' + data.net.toFixed(4);
                    const color = data.net >= 0 ? 'green-txt' : 'red-txt';
                    html += \`<li style="margin-bottom: 6px;"><strong>\${reason}</strong> triggered \${data.count} time(s), realizing <strong class="\${color}">\${netStr}</strong></li>\`;
                }
                html += '</ul>';
            }
            driversEl.innerHTML = html;
        }

        const historyEl = document.getElementById('history-log-content');
        if (!records || records.length === 0) {
            historyEl.innerHTML = '<div class="history-item"><div class="history-msg">No recent trade executions.</div></div>';
            return;
        }

        let hHtml = '';
        records.forEach(r => {
            const timeStr = new Date(r.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});
            const symbol = r.symbol || r.winnerSymbol || 'Unknown';
            const reason = r.reason || (r.loserSymbol ? 'Legacy Smart Offset' : 'Trade Event');
            const net = r.netProfit || 0;
            let badgeClass = net > 0 ? 'bg-green' : (net < 0 ? 'bg-red' : 'bg-blue');
            hHtml += \`
                <div class="history-item">
                    <div class="history-time">[\${timeStr}]</div>
                    <div class="history-msg">
                        <span class="reason-badge \${badgeClass}">\${reason}</span> 
                        <strong>\${symbol}</strong> resulted in a net change of 
                        <strong class="\${net >= 0 ? 'green-txt' : 'red-txt'}">\${(net >= 0 ? '+' : '') + '$' + net.toFixed(4)}</strong>.
                    </div>
                </div>\`;
        });
        historyEl.innerHTML = hHtml;
    }

    function renderTable(accounts, currency) {
        const tbody = document.getElementById('accBody');
        tbody.innerHTML = '';
        if(!accounts) return;
        accounts.forEach(acc => {
            const tr = document.createElement('tr');
            let statusHtml = acc.error ? '<span style="color:var(--red); font-weight:700;">' + acc.error + '</span>' : '<span style="color:var(--green); font-weight:700;">OK</span>';
            tr.innerHTML = \`
                <td>\${acc.name}</td>
                <td class="num-col" style="text-align:right;">\${fmt(acc.total)} \${currency}</td>
                <td class="num-col" style="text-align:right; color:#6b7280;">\${fmt(acc.free)} \${currency}</td>
                <td style="text-align:right;">\${statusHtml}</td>
            \`;
            tbody.appendChild(tr);
        });
    }

    // Start Polling every 2 seconds
    setInterval(fetchData, 2000);
    fetchData(); // Initial load
</script>
</body>
</html>
` 
}
