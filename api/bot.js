const express = require('express');
const { MongoClient } = require('mongodb');
const ccxt = require('ccxt');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
// 🚨 Ensure your DB password is correct here.
const MONGO_URI = "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888";
const TARGET_USERNAME = 'webwebwebweb8888'; // Fixed to match your header
const SUPPORTED_CURRENCIES = ['USDT', 'SHIB', 'XRP', 'BCH', 'ZAR'];

// ==================== GLOBALS (Preserved across Vercel Warm Starts) ====================
let mongoClient = null;
let botDb = null;
let dbCollection = null;
let targetUserId = null;
let targetIsPaper = false;
let accounts = [];
let activeBotSettings = {};
let latestDbActions = [];
let marketEvents = [];

let state = {
    startTime: null,         
    startBalance: 0,      
    isInitialized: false,
    currency: 'USDT'
};

const sharedExchange = new ccxt.huobi({ enableRateLimit: false, options: { defaultType: 'linear' } });

// ==================== 1. DATABASE LOADER (ON-DEMAND) ====================
async function ensureDbLoaded() {
    if (accounts.length > 0) return true; // Already loaded

    if (!mongoClient) {
        mongoClient = new MongoClient(MONGO_URI);
        await mongoClient.connect();
        botDb = mongoClient.db("botdb");
        dbCollection = mongoClient.db("HTX_Aggregator").collection("session_growth");
    }

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
                accounts = masterSettings.subAccounts
                    .filter(sub => sub.apiKey && sub.secret)
                    .map((sub, index) => ({
                        id: index + 1,
                        name: sub.name || `Profile ${index + 1}`,
                        apiKey: sub.apiKey,
                        secret: sub.secret,
                        data: { total: 0, free: 0, used: 0, error: null }
                    }));
            }
        }
    }
    return accounts.length > 0;
}

// ==================== 2. HTX DATA FETCHER (ON-DEMAND) ====================
async function fetchAccountData(acc, currency) {
    sharedExchange.apiKey = acc.apiKey;
    sharedExchange.secret = acc.secret;
    
    try {
        let totalEquity = 0;
        let freeCurrency = 0;
        let balSuccess = false;

        // Try to fetch balance
        try {
            const bal = await sharedExchange.fetchBalance({ type: 'swap', marginMode: 'cross' });
            if (bal?.total?.[currency] !== undefined) {
                totalEquity = parseFloat(bal.total[currency] || 0);
                freeCurrency = parseFloat(bal.free[currency] || 0);
                balSuccess = true;
            }
        } catch(e) {}

        if (!balSuccess) throw new Error("Balance Fetch Failed");

        // Try to fetch positions for unrealized PNL
        let totalUnrealizedPnl = 0;
        try {
            const ccxtPos = await sharedExchange.fetchPositions(undefined, { marginMode: 'cross' });
            if (ccxtPos) {
                ccxtPos.forEach(p => { totalUnrealizedPnl += parseFloat(p.unrealizedPnl || 0); });
            }
        } catch(e) {}

        const staticWalletBalance = totalEquity - totalUnrealizedPnl;

        acc.data = {
            total: isNaN(staticWalletBalance) ? 0 : staticWalletBalance,
            free: isNaN(freeCurrency) ? 0 : freeCurrency,
            used: isNaN(totalEquity - freeCurrency) ? 0 : (totalEquity - freeCurrency),
            error: null
        };
        return acc;
    } catch (err) {
        acc.data.error = "API Error";
        return acc;
    }
}

// ==================== 3. VERCEL API ENDPOINTS ====================

// API: Fetch Latest Data (Frontend calls this every 2 seconds)
app.get('/api/data', async (req, res) => {
    const requestedCurrency = req.query.currency || 'USDT';
    
    // Check if currency changed
    if (requestedCurrency !== state.currency) {
        state.currency = requestedCurrency;
        state.isInitialized = false;
    }

    try {
        // 1. Ensure DB & Accounts are loaded
        const hasAccounts = await ensureDbLoaded();
        if (!hasAccounts) {
            return res.json({ error: "No accounts found in database.", combined: { isReady: false } });
        }

        // 2. Fetch HTX data for all accounts simultaneously
        await Promise.all(accounts.map(acc => fetchAccountData(acc, state.currency)));

        // 3. Fetch latest DB trade history
        const offsetColName = targetIsPaper ? "paper_offset_records" : "offset_records";
        latestDbActions = await botDb.collection(offsetColName)
            .find({ userId: targetUserId })
            .sort({ timestamp: -1 })
            .limit(50)
            .toArray();

        // 4. Calculate Totals
        let grandTotal = 0, grandFree = 0, grandUsed = 0, loadedCount = 0;
        accounts.forEach(acc => {
            if (!acc.data.error) {
                grandTotal += acc.data.total;
                grandFree += acc.data.free;
                grandUsed += acc.data.used;
                loadedCount++;
            }
        });

        // 5. Initialize Database Session state if needed
        if (!state.isInitialized && loadedCount > 0 && loadedCount === accounts.length) {
            let doc = await dbCollection.findOne({ currency: state.currency });
            if (doc && doc.startTime && doc.startBalance !== undefined) {
                state.startTime = doc.startTime;
                state.startBalance = doc.startBalance;
            } else {
                state.startTime = Date.now();
                state.startBalance = grandTotal;
                await dbCollection.updateOne(
                    { currency: state.currency },
                    { $set: { startTime: state.startTime, startBalance: state.startBalance } },
                    { upsert: true }
                );
            }
            state.isInitialized = true;
        }

        // 6. Build the payload
        const now = Date.now();
        const secondsElapsed = state.isInitialized ? Math.max(1, (now - state.startTime) / 1000) : 0;
        const growth = state.isInitialized ? (grandTotal - state.startBalance) : 0;
        const avgGrowthPerSec = state.isInitialized ? (growth / secondsElapsed) : 0;

        const payload = {
            combined: {
                currency: state.currency,
                isReady: state.isInitialized,
                loadedCount,
                totalCount: accounts.length,
                total: grandTotal,
                free: grandFree,
                used: grandUsed,
                startBalance: state.startBalance,
                startTime: state.startTime,
                secondsElapsed,
                growth,
                growthPct: state.startBalance > 0 ? (growth / state.startBalance) * 100 : 0,
                avgGrowthPerSec,
                avgGrowthPctPerSec: state.startBalance > 0 ? (avgGrowthPerSec / state.startBalance) * 100 : 0,
                growthPerHour: avgGrowthPerSec * 3600,
                growthPerDay: avgGrowthPerSec * 86400,
                growthPerMonth: avgGrowthPerSec * 2592000,
                growthPerYear: avgGrowthPerSec * 31536000,
                timestamp: new Date().toLocaleTimeString()
            },
            accounts: accounts.map(a => ({ name: a.name, ...a.data, isLoaded: !a.data.error })),
            dbRecords: latestDbActions,
            marketEvents: marketEvents,
            botSettings: activeBotSettings
        };

        // Save progress to DB occasionally
        if (state.isInitialized) {
            await dbCollection.updateOne(
                { currency: state.currency },
                { $set: { currentTotal: grandTotal, growth, updatedAt: new Date() } },
                { upsert: true }
            );
        }

        res.json(payload);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error", combined: { isReady: false } });
    }
});

// API: Reset Stats manually
app.post('/api/reset', async (req, res) => {
    let grandTotal = accounts.reduce((sum, a) => sum + (a.data.total || 0), 0);
    state.startTime = Date.now();
    state.startBalance = grandTotal;
    state.isInitialized = true;
    
    if (dbCollection) {
        await dbCollection.updateOne(
            { currency: state.currency },
            { $set: { startTime: state.startTime, startBalance: state.startBalance } },
            { upsert: true }
        );
    }
    res.json({ success: true });
});

// UI Route
app.get('/', (req, res) => res.send(getHtml()));

// ==================== HTML / FRONTEND (Rewritten for HTTP Fetch) ====================
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
        .nav-link { text-decoration: none; color: var(--text-light); font-weight: 500; font-size: 14px; padding: 10px 0; border-bottom: 2px solid transparent; cursor: pointer; }
        .nav-link.active { color: var(--primary); border-bottom: 2px solid var(--primary); }
        .container { max-width: 900px; margin: 0 auto; padding: 0 20px; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; }
        h1 { font-size: 22px; font-weight: 700; margin: 0; }
        .subtitle { font-size: 13px; color: var(--text-light); margin-top: 4px; }
        .controls { display: flex; align-items: center; gap: 10px; }
        .currency-select { background: #ffffff; border: 1px solid #d1d5db; padding: 6px 10px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; outline: none; }
        .timer-badge { background: #e5e7eb; padding: 6px 14px; border-radius: 20px; font-size: 13px; font-family: 'Roboto Mono'; }
        .btn-reset { background: white; border: 1px solid #d1d5db; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 600; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
        .card { background: var(--card-bg); border-radius: 12px; box-shadow: var(--shadow); padding: 24px; }
        .card-title { font-size: 12px; text-transform: uppercase; color: var(--text-light); margin-bottom: 12px; font-weight: 600; }
        .big-val { font-family: 'Roboto Mono'; font-size: 26px; font-weight: 700; }
        .sub-val { font-family: 'Roboto Mono'; font-size: 13px; color: var(--text-light); margin-top: 6px; }
        .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #f3f4f6; font-size: 14px; }
        .row:last-child { border-bottom: none; }
        .val { font-weight: 500; font-family: 'Roboto Mono'; }
        .green-txt { color: var(--green) !important; } .red-txt { color: var(--red) !important; }
        .table-card { background: var(--card-bg); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; margin-top: 20px;}
        table { width: 100%; border-collapse: collapse; font-size: 14px; }
        th { background: #f9fafb; padding: 16px; text-align: left; border-bottom: 1px solid #e5e7eb; font-size: 12px; text-transform: uppercase; }
        td { padding: 16px; border-bottom: 1px solid #f3f4f6; }
        td.num-col { font-family: 'Roboto Mono'; font-size: 13px; text-align: right;}
        .footer { text-align: center; margin-top: 40px; padding-bottom:20px; color: var(--text-light); font-size: 12px; }
        .dot { height: 8px; width: 8px; background-color: #bbb; border-radius: 50%; display: inline-block; margin-right: 6px; }
        .dot.live { background-color: var(--green); box-shadow: 0 0 4px var(--green); }
    </style>
</head>
<body>

<div class="top-nav">
    <div class="nav-logo">⚡ HTX Master Aggregator</div>
    <div class="nav-links">
        <a class="nav-link active" id="tab-dashboard" onclick="switchTab('dashboard')">Overview Dashboard</a>
        <a class="nav-link" id="tab-accounts" onclick="switchTab('accounts')">Accounts</a>
    </div>
</div>

<div class="container">
    <div class="header">
        <div>
            <h1 id="page-title">Portfolio Overview</h1>
            <div class="subtitle" id="status-text">Connecting to Vercel API...</div>
        </div>
        <div class="controls">
            <select class="currency-select" id="currencySelect" onchange="changeCurrency(this.value)">
                <option value="USDT">USDT</option>
                <option value="SHIB">SHIB</option>
                <option value="XRP">XRP</option>
                <option value="BCH">BCH</option>
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
            </div>
            <div class="card">
                <div class="card-title">Session Balances & Margin</div>
                <div class="row"><span>Starting Wallet</span> <span class="val" id="startWallet">--</span></div>
                <div class="row"><span>Current Wallet</span> <span class="val" id="currentWallet">--</span></div>
                <div class="row"><span>Used Margin</span> <span class="val" id="used">--</span></div>
            </div>
        </div>
    </div>

    <!-- PAGE 2: ACCOUNTS -->
    <div id="page-accounts" style="display: none;">
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
        <span class="dot" id="dot"></span> API Last Synced: <span id="time">--</span>
    </div>
</div>

<script>
    let currentCurrency = 'USDT';

    function switchTab(tabName) {
        document.getElementById('page-dashboard').style.display = tabName === 'dashboard' ? 'block' : 'none';
        document.getElementById('page-accounts').style.display = tabName === 'accounts' ? 'block' : 'none';
        document.getElementById('tab-dashboard').classList.toggle('active', tabName === 'dashboard');
        document.getElementById('tab-accounts').classList.toggle('active', tabName === 'accounts');
        document.getElementById('page-title').innerText = tabName === 'dashboard' ? "Portfolio Overview" : "Accounts & API";
    }

    async function resetSession() { 
        if(confirm('Reset stats to current Wallet Balance?')) {
            await fetch('/api/reset', { method: 'POST' });
            pollData();
        }
    }
    
    function changeCurrency(newCoin) {
        currentCurrency = newCoin;
        document.getElementById('status-text').innerText = 'Switching currencies...';
        document.getElementById('total').innerText = 'Loading...';
        pollData();
    }
    
    const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 });
    const fmtPct = (n) => (n > 0 ? '+' : '') + Number(n).toFixed(6) + '%';
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
        if(colorize) el.className = 'val ' + colorClass(val);
    };

    // VERCEL SPECIFIC: Polling API instead of WebSockets
    async function pollData() {
        try {
            document.getElementById('dot').classList.remove('live');
            const res = await fetch('/api/data?currency=' + currentCurrency);
            const data = await res.json();
            
            if (data.error) {
                document.getElementById('status-text').innerText = data.error;
                return;
            }

            document.getElementById('dot').classList.add('live');
            const c = data.combined;
            
            if (!c.isReady) {
                document.getElementById('status-text').innerText = \`Fetching \${c.currency} Data via Vercel... (\${c.loadedCount}/\${c.totalCount})\`;
                renderTable(data.accounts, c.currency);
                return;
            }

            document.getElementById('status-text').innerText = \`Tracking \${c.currency} via API\`;
            document.getElementById('elapsed').innerText = formatTime(c.secondsElapsed);
            document.getElementById('time').innerText = c.timestamp;

            updateVal('total', c.total, false, false, c.currency);
            updateVal('free', c.free, false, false, c.currency);
            updateVal('growth', c.growth, false, true, c.currency);
            document.getElementById('growthPct').innerHTML = \`<span class="\${colorClass(c.growthPct)}">\${fmtPct(c.growthPct)}</span>\`;

            updateVal('projSec', c.avgGrowthPerSec, false, true, c.currency);
            updateVal('projHour', c.growthPerHour, false, true, c.currency);
            updateVal('projDay', c.growthPerDay, false, true, c.currency);

            updateVal('startWallet', c.startBalance, false, false, c.currency);
            updateVal('currentWallet', c.total, false, false, c.currency);
            updateVal('used', c.used, false, false, c.currency);

            renderTable(data.accounts, c.currency);

        } catch(err) {
            console.error("API Error", err);
            document.getElementById('status-text').innerText = "Disconnected. Retrying...";
        }
    }

    function renderTable(accounts, currency) {
        const tbody = document.getElementById('accBody');
        tbody.innerHTML = '';
        accounts.forEach(acc => {
            const tr = document.createElement('tr');
            let statusHtml = acc.isLoaded ? '<span style="color:var(--green); font-weight:700;">OK</span>' : '<span style="color:var(--red); font-weight:700;">Error</span>';
            tr.innerHTML = \`
                <td>\${acc.name}</td>
                <td class="num-col">\${fmt(acc.total)} \${currency}</td>
                <td class="num-col" style="color:#6b7280;">\${fmt(acc.free)} \${currency}</td>
                <td style="text-align:right;">\${statusHtml}</td>
            \`;
            tbody.appendChild(tr);
        });
    }

    // Call API every 2 seconds
    pollData();
    setInterval(pollData, 2000);
</script>
</body>
</html>
`;
}

module.exports = app;
