const express = require('express');
const { MongoClient } = require('mongodb');
const ccxt = require('ccxt');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
// 🚨 SECURITY NOTE: In Vercel, put your Mongo string in Settings -> Environment Variables as MONGO_URI
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888";
const TARGET_USERNAME = 'webweb8888';

// ==================== GLOBALS ====================
let mongoClient = null;
let botDb = null;
let dbCollection = null;
let targetUserId = null;
let accounts = [];

let state = {
    startTime: null,         
    startBalance: 0,      
    isInitialized: false,
    currency: 'USDT'
};

// ==================== 1. DATABASE LOADER ====================
async function ensureDbLoaded() {
    if (accounts.length > 0) return { success: true };

    try {
        if (!mongoClient) {
            mongoClient = new MongoClient(MONGO_URI);
            await mongoClient.connect();
            botDb = mongoClient.db("botdb");
            dbCollection = mongoClient.db("HTX_Aggregator").collection("session_growth");
        }

        const usersCol = botDb.collection("users");
        const masterUser = await usersCol.findOne({ username: TARGET_USERNAME });
        
        if (!masterUser) {
            return { success: false, error: `User ${TARGET_USERNAME} not found in DB.` };
        }

        targetUserId = masterUser._id;
        const settingsColName = masterUser.isPaper ? "paper_settings" : "settings";
        const settingsCol = botDb.collection(settingsColName);
        
        let masterSettings = await settingsCol.findOne({ userId: targetUserId });
        if (!masterSettings) {
            masterSettings = await settingsCol.findOne({ userId: targetUserId.toString() }); 
        }
        
        if (!masterSettings || !masterSettings.subAccounts) {
            return { success: false, error: "Settings or subAccounts missing for user." };
        }

        accounts = masterSettings.subAccounts
            .filter(sub => sub.apiKey && sub.secret)
            .map((sub, index) => ({
                id: index + 1,
                name: sub.name || `Profile ${index + 1}`,
                exchange: new ccxt.huobi({
                    apiKey: sub.apiKey,
                    secret: sub.secret,
                    enableRateLimit: false,
                    options: { defaultType: 'linear' }
                }),
                data: { total: 0, free: 0, used: 0, error: null }
            }));

        if (accounts.length === 0) return { success: false, error: "No accounts with API keys found." };
        
        return { success: true };
    } catch (err) {
        console.error("DB Load Error:", err);
        return { success: false, error: `MongoDB Connection Error: ${err.message}` };
    }
}

// ==================== 2. HTX DATA FETCHER ====================
async function fetchAccountData(acc, currency) {
    let totalEquity = 0; 
    let freeCurrency = 0; 
    let staticWalletBalance = 0;
    let balSuccess = false;
    let needsPositionFetch = true;

    try {
        // STEP 1: Try the standard CCXT fetchBalance (works for normal non-unified accounts)
        try {
            const bal = await acc.exchange.fetchBalance({ type: 'swap', marginMode: 'cross' });
            if (bal?.total?.[currency] !== undefined) {
                totalEquity = parseFloat(bal.total[currency] || 0);
                freeCurrency = parseFloat(bal.free[currency] || 0);
                balSuccess = true;
            }
        } catch(e) {
            // STEP 2: If HTX rejects it because the account is Unified (Error 4002)
            if (e.message.includes('v3/unified_account_info') || e.message.includes('4002')) {
                try {
                    // Use CCXT's implicit method to call the exact endpoint HTX is asking for
                    const unifiedRes = await acc.exchange.contractPrivateGetLinearSwapApiV3UnifiedAccountInfo();
                    
                    if (unifiedRes && unifiedRes.data) {
                        // Find the requested currency in the unified data array
                        const assetData = unifiedRes.data.find(d => d.margin_asset.toUpperCase() === currency.toUpperCase());
                        
                        if (assetData) {
                            totalEquity = parseFloat(assetData.margin_balance || 0); // Wallet + PnL
                            freeCurrency = parseFloat(assetData.free || 0);          // Available to trade
                            staticWalletBalance = parseFloat(assetData.margin_static || 0); // Wallet Balance without PnL
                            
                            balSuccess = true;
                            needsPositionFetch = false; // V3 API gives us static margin natively! No need to fetch positions.
                        } else {
                            throw new Error(`Asset ${currency} not found in Unified Account.`);
                        }
                    } else {
                        throw new Error("Invalid response from V3 Unified API.");
                    }
                } catch (v3Err) {
                    throw new Error(`Unified API Error: ${v3Err.message}`);
                }
            } else {
                // If it's a different error (like invalid API keys), throw it normally
                throw e; 
            }
        }
        
        if (!balSuccess) throw new Error(`Balance Fetch Failed - ${currency} missing.`);

        // STEP 3: If we used the old API, we must manually calculate unrealized PnL to find the static wallet balance
        if (needsPositionFetch) {
            let totalUnrealizedPnl = 0;
            try {
                const ccxtPos = await acc.exchange.fetchPositions(undefined, { marginMode: 'cross' });
                if (ccxtPos) {
                    ccxtPos.forEach(p => { totalUnrealizedPnl += parseFloat(p.unrealizedPnl || 0); });
                }
            } catch(e) { /* Ignore position errors */ }
            staticWalletBalance = totalEquity - totalUnrealizedPnl;
        }

        // STEP 4: Store Data
        acc.data = {
            total: isNaN(staticWalletBalance) ? 0 : staticWalletBalance,
            free: isNaN(freeCurrency) ? 0 : freeCurrency,
            used: isNaN(totalEquity - freeCurrency) ? 0 : (totalEquity - freeCurrency),
            error: null
        };

    } catch (err) {
        // FULL ERROR EXPOSURE
        acc.data.error = err.message || err.toString();
    }
}

// ==================== 3. VERCEL API ENDPOINTS ====================
app.get('/api/data', async (req, res) => {
    const requestedCurrency = req.query.currency || 'USDT';
    
    if (requestedCurrency !== state.currency) {
        state.currency = requestedCurrency;
        state.isInitialized = false;
    }

    try {
        const dbStatus = await ensureDbLoaded();
        if (!dbStatus.success) {
            return res.json({ error: dbStatus.error, combined: { isReady: false } });
        }

        for (let i = 0; i < accounts.length; i++) {
            await fetchAccountData(accounts[i], state.currency);
            await new Promise(resolve => setTimeout(resolve, 500)); 
        }

        let grandTotal = 0, grandFree = 0, grandUsed = 0, loadedCount = 0;
        accounts.forEach(acc => {
            if (!acc.data.error) {
                grandTotal += acc.data.total;
                grandFree += acc.data.free;
                grandUsed += acc.data.used;
                loadedCount++;
            }
        });

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
                timestamp: new Date().toLocaleTimeString()
            },
            accounts: accounts.map(a => ({ name: a.name, ...a.data, isLoaded: !a.data.error }))
        };

        if (state.isInitialized) {
            dbCollection.updateOne(
                { currency: state.currency },
                { $set: { currentTotal: grandTotal, growth, updatedAt: new Date() } },
                { upsert: true }
            ).catch(()=>{});
        }

        res.json(payload);

    } catch (err) {
        res.status(500).json({ 
            error: `Server Crash: ${err.message}`, 
            stack: err.stack,
            combined: { isReady: false } 
        });
    }
});

app.post('/api/reset', async (req, res) => {
    await ensureDbLoaded(); 
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

app.get('/', (req, res) => res.send(getHtml()));

// ==================== HTML / FRONTEND ====================
function getHtml() {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Google AdSense</title>
    <link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&family=Roboto:wght@400;500&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0" rel="stylesheet" />
    <style>
        /* Exact Google AdSense Material Design CSS */
        :root {
            --google-blue: #1a73e8;
            --text-main: #202124;
            --text-secondary: #5f6368;
            --border-color: #dadce0;
            --bg-color: #f8f9fa;
            --card-bg: #ffffff;
            --green: #1e8e3e;
            --red: #d93025;
        }
        body { font-family: 'Roboto', arial, sans-serif; background: var(--bg-color); color: var(--text-main); margin: 0; display: flex; height: 100vh; overflow: hidden;}
        h1, h2, h3, .brand { font-family: 'Google Sans', sans-serif; }
        
        /* Topbar */
        .topbar { position: fixed; top: 0; left: 0; right: 0; height: 64px; background: #fff; border-bottom: 1px solid var(--border-color); display: flex; align-items: center; padding: 0 16px; z-index: 100; }
        .menu-icon { color: var(--text-secondary); cursor: pointer; margin-right: 16px; }
        .logo-text { font-family: 'Google Sans', sans-serif; font-size: 22px; color: #5f6368; display: flex; align-items:center; gap: 4px; }
        .logo-text span { color: #202124; font-weight: 500; }
        
        /* Layout */
        .sidebar { width: 256px; background: #fff; border-right: 1px solid var(--border-color); padding-top: 80px; height: 100%; display: flex; flex-direction: column; overflow-y:auto; }
        .nav-item { display: flex; align-items: center; padding: 12px 24px; color: var(--text-secondary); text-decoration: none; font-weight: 500; border-radius: 0 24px 24px 0; margin-right: 16px; cursor: pointer; gap: 16px; font-size: 14px; }
        .nav-item:hover { background: #f1f3f4; }
        .nav-item.active { background: #e8f0fe; color: var(--google-blue); }
        .nav-item.active .material-symbols-outlined { color: var(--google-blue); }
        
        .main-content { flex: 1; padding: 88px 24px 24px 24px; overflow-y: auto; background: var(--bg-color); }
        .header-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
        .page-title { font-size: 24px; font-weight: 400; color: var(--text-main); margin: 0; }
        
        .controls { display: flex; gap: 12px; align-items: center; }
        select.currency-select, button.btn-reset { font-family: 'Google Sans'; background: #fff; border: 1px solid var(--border-color); padding: 8px 16px; border-radius: 4px; font-size: 14px; color: var(--text-main); cursor: pointer; outline: none; font-weight: 500;}
        select.currency-select:hover, button.btn-reset:hover { background: #f8f9fa; }
        .status-badge { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-secondary); background: #fff; padding: 6px 12px; border-radius: 16px; border: 1px solid var(--border-color); }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #ccc; }
        .status-dot.live { background: var(--green); }
        
        /* Cards */
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 24px; margin-bottom: 24px; }
        .card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 20px; box-shadow: none; }
        
        .card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; }
        .card-title { font-family: 'Google Sans'; font-size: 16px; font-weight: 500; color: var(--text-main); margin: 0; }
        .card-icon { color: var(--text-secondary); cursor: pointer; }
        
        .val-main { font-family: 'Google Sans'; font-size: 36px; font-weight: 400; color: var(--text-main); margin-bottom: 4px; }
        
        .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        .val-group { display: flex; flex-direction: column; }
        .val-group .label { font-size: 13px; color: var(--text-secondary); margin-bottom: 4px; display:flex; align-items:center; gap:4px; }
        .val-group .value { font-family: 'Google Sans'; font-size: 24px; font-weight: 400; color: var(--text-main); }
        .val-group .trend { font-size: 12px; margin-top: 4px; }
        .green { color: var(--green); } .red { color: var(--red); }

        .divider { height: 1px; background: var(--border-color); margin: 20px 0; }

        /* Table for Sites */
        .sites-table { width: 100%; border-collapse: collapse; }
        .sites-table th { text-align: left; padding: 12px 8px; border-bottom: 1px solid var(--border-color); font-weight: 500; color: var(--text-secondary); font-size: 13px; }
        .sites-table td { padding: 12px 8px; border-bottom: 1px solid var(--border-color); font-size: 14px; color: var(--text-main); }
        .site-name { display: flex; align-items: center; gap: 8px; color: var(--google-blue); font-weight: 500; }
    </style>
</head>
<body>
    <div class="topbar">
        <span class="material-symbols-outlined menu-icon">menu</span>
        <div class="logo-text">
            <span class="material-symbols-outlined" style="color: #fbbc04; font-size: 32px;">leaderboard</span>
            Google <span>AdSense</span>
        </div>
    </div>
    
    <div class="sidebar">
        <a class="nav-item active" id="nav-home" onclick="switchTab('dashboard')">
            <span class="material-symbols-outlined">home</span> Home
        </a>
        <a class="nav-item">
            <span class="material-symbols-outlined">ads_click</span> Ads
        </a>
        <a class="nav-item" id="nav-sites" onclick="switchTab('accounts')">
            <span class="material-symbols-outlined">web</span> Sites
        </a>
        <a class="nav-item">
            <span class="material-symbols-outlined">verified_user</span> Privacy & messaging
        </a>
        <div class="divider" style="margin: 8px 0;"></div>
        <a class="nav-item">
            <span class="material-symbols-outlined">bar_chart</span> Reports
        </a>
        <a class="nav-item" onclick="resetSession()">
            <span class="material-symbols-outlined">refresh</span> Reset Ad stats
        </a>
    </div>
    
    <div class="main-content">
        <div class="header-bar">
            <h2 class="page-title" id="page-title">Home</h2>
            <div class="controls">
                <div class="status-badge">
                    <div class="status-dot" id="dot"></div>
                    <span id="elapsed">--:--:--</span>
                </div>
                <select class="currency-select" id="currencySelect" onchange="changeCurrency(this.value)">
                    <option value="USDT">USDT</option>
                    <option value="SHIB">SHIB</option>
                    <option value="XRP">XRP</option>
                    <option value="BCH">BCH</option>
                </select>
            </div>
        </div>

        <div id="page-dashboard">
            <div class="grid">
                <!-- Ad Revenue Card -->
                <div class="card" style="grid-column: span 2;">
                    <div class="card-header">
                        <h3 class="card-title">Estimated Ad revenue</h3>
                        <span class="material-symbols-outlined card-icon">more_vert</span>
                    </div>
                    <div class="two-col">
                        <div class="val-group">
                            <span class="label">Total Ad revenue (Today)</span>
                            <span class="value" id="adToday">--</span>
                            <span class="trend" id="growthPct">--</span>
                        </div>
                        <div class="val-group">
                            <span class="label">Ad revenue (Yesterday)</span>
                            <span class="value" id="adYesterday">--</span>
                        </div>
                        <div class="val-group">
                            <span class="label">Ad revenue (Last 7 days)</span>
                            <span class="value" id="adLast7">--</span>
                        </div>
                        <div class="val-group">
                            <span class="label">Ad revenue (This month)</span>
                            <span class="value" id="adMonth">--</span>
                        </div>
                    </div>
                </div>

                <!-- Balance Card -->
                <div class="card">
                    <div class="card-header">
                        <h3 class="card-title">Balance</h3>
                        <span class="material-symbols-outlined card-icon">more_vert</span>
                    </div>
                    <div class="val-group">
                        <span class="value val-main" id="total">--</span>
                        <span class="label" style="margin-bottom: 20px;">Available (Pending Ad revenue): <span id="free" style="margin-left: 4px; color:var(--text-main); font-weight:500;">--</span></span>
                    </div>
                    <div class="divider"></div>
                    <div class="val-group">
                        <span class="label">Last payment</span>
                        <span class="value" style="font-size: 16px;" id="adLastPayment">--</span>
                    </div>
                </div>
            </div>

            <div class="grid">
                <!-- Performance Card -->
                <div class="card" style="grid-column: span 3;">
                    <div class="card-header">
                        <h3 class="card-title">Performance</h3>
                        <span class="material-symbols-outlined card-icon">more_vert</span>
                    </div>
                    <div class="two-col" style="grid-template-columns: repeat(4, 1fr);">
                        <div class="val-group">
                            <span class="label">Page views</span>
                            <span class="value" style="font-size: 20px;" id="adPageViews">--</span>
                        </div>
                        <div class="val-group">
                            <span class="label">Ad impressions</span>
                            <span class="value" style="font-size: 20px;" id="adImpressions">--</span>
                        </div>
                        <div class="val-group">
                            <span class="label">Page RPM</span>
                            <span class="value" style="font-size: 20px;" id="adRpm">--</span>
                        </div>
                        <div class="val-group">
                            <span class="label">Ad requests API syncs</span>
                            <span class="value" style="font-size: 20px;" id="time">--</span>
                        </div>
                        <div class="val-group" style="margin-top: 16px;">
                            <span class="label">Active Ad Sites</span>
                            <span class="value" style="font-size: 16px; color:var(--google-blue);" id="status-text">Connecting...</span>
                        </div>
                        <div class="val-group" style="margin-top: 16px;">
                            <span class="label">Cost per click (CPC)</span>
                            <span class="value" style="font-size: 16px;">$0.00</span>
                        </div>
                        <div class="val-group" style="margin-top: 16px;">
                            <span class="label">Page CTR</span>
                            <span class="value" style="font-size: 16px;">0.00%</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Sites Page -->
        <div id="page-accounts" style="display: none;">
            <div class="card">
                <div class="card-header">
                    <h3 class="card-title">Sites</h3>
                </div>
                <table class="sites-table">
                    <thead>
                        <tr>
                            <th>Site (Account Domain)</th>
                            <th>Ad serving status</th>
                            <th style="text-align: right;">Total Ad Balance (Wallet)</th>
                            <th style="text-align: right;">Unpaid Ad Revenue (Free)</th>
                        </tr>
                    </thead>
                    <tbody id="accBody"></tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        let currentCurrency = 'USDT';

        // Simulation State for Ad Math
        let simState = { 
            initialized: false, 
            dayRatios: [], 
            targetRpm: 0, 
            impressionRatio: 0, 
            currentCurrency: '' 
        };

        function switchTab(tabName) {
            document.getElementById('page-dashboard').style.display = tabName === 'dashboard' ? 'block' : 'none';
            document.getElementById('page-accounts').style.display = tabName === 'accounts' ? 'block' : 'none';
            document.getElementById('nav-home').classList.toggle('active', tabName === 'dashboard');
            document.getElementById('nav-sites').classList.toggle('active', tabName === 'accounts');
            document.getElementById('page-title').innerText = tabName === 'dashboard' ? "Home" : "Sites";
        }

        async function resetSession() { 
            if(confirm('Reset Ad revenue tracking to current balance?')) {
                await fetch('/api/reset', { method: 'POST' });
            }
        }
        
        function changeCurrency(newCoin) {
            currentCurrency = newCoin;
            document.getElementById('status-text').innerText = 'Fetching Ad data...';
            document.getElementById('total').innerText = '...';
        }
        
        const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
        const fmtPct = (n) => (n > 0 ? '↑ ' : (n < 0 ? '↓ ' : '')) + Math.abs(Number(n)).toFixed(4) + '%';
        const colorClass = (n) => n > 0 ? 'green' : (n < 0 ? 'red' : '');
        
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
            if(colorize) el.className = 'value ' + colorClass(val);
        };

        function initSimulation(currency) {
            simState.initialized = true;
            simState.currentCurrency = currency;
            simState.dayRatios = [];
            // Generate random values between 0 and 1 for 30 days history
            for(let i = 0; i < 30; i++) {
                simState.dayRatios.push(Math.random()); 
            }
            // Establish base RPM ($2.50 to $8.00 range)
            simState.targetRpm = 2.5 + (Math.random() * 5.5); 
            // Establish Impressions ratio (1.1x to 2.5x of page views)
            simState.impressionRatio = 1.1 + (Math.random() * 1.4); 
        }

        async function pollData() {
            try {
                document.getElementById('dot').classList.remove('live');
                const res = await fetch('/api/data?currency=' + currentCurrency);
                const data = await res.json();
                
                if (data.error) {
                    document.getElementById('status-text').innerText = "Ad serving disabled";
                    document.getElementById('status-text').style.color = "var(--red)";
                } else {
                    document.getElementById('dot').classList.add('live');
                    const c = data.combined;
                    
                    if (!c.isReady) {
                        document.getElementById('status-text').innerText = \`Analyzing traffic (\${c.loadedCount}/\${c.totalCount})\`;
                        renderTable(data.accounts, c.currency);
                    } else {
                        document.getElementById('status-text').innerText = \`Ready (\${c.loadedCount} sites)\`;
                        document.getElementById('status-text').style.color = "var(--google-blue)";
                        document.getElementById('elapsed').innerText = formatTime(c.secondsElapsed);
                        document.getElementById('time').innerText = c.timestamp;

                        // Balance mappings
                        updateVal('total', c.total, false, false, c.currency);
                        updateVal('free', c.free, false, false, c.currency);
                        
                        // ===== CUSTOM AD MATH =====
                        if (!simState.initialized || simState.currentCurrency !== c.currency) {
                            initSimulation(c.currency);
                        }

                        // Protect against negative growth for display illusion
                        let todaySoFar = Math.max(0, c.growth); 

                        // 1. Yesterday (Random fraction of today)
                        let yesterday = todaySoFar * simState.dayRatios[0];

                        // 2. Last 7 Days (Today + 6 random days)
                        let last7Days = todaySoFar;
                        for(let i=0; i<6; i++) last7Days += (todaySoFar * simState.dayRatios[i]);

                        // 3. This Month (Today + 29 random days)
                        let thisMonth = todaySoFar;
                        for(let i=0; i<29; i++) thisMonth += (todaySoFar * simState.dayRatios[i]);

                        // 4. Last Payment (Matches This Month)
                        let lastPayment = thisMonth;

                        // 5. Page Views (Reverse calculated from today's earnings and target RPM)
                        let pageViews = todaySoFar > 0 ? Math.floor((todaySoFar / simState.targetRpm) * 1000) : 0;
                        
                        // 6. Impressions (Scaled up from Page Views)
                        let impressions = Math.floor(pageViews * simState.impressionRatio);

                        // 7. Exact Display RPM
                        let rpm = pageViews > 0 ? (todaySoFar / pageViews) * 1000 : 0.00;

                        // UPDATE UI
                        updateVal('adToday', todaySoFar, false, true, '');
                        updateVal('adYesterday', yesterday, false, false, '');
                        updateVal('adLast7', last7Days, false, false, '');
                        updateVal('adMonth', thisMonth, false, false, '');
                        updateVal('adLastPayment', lastPayment, false, false, c.currency);

                        // Update Trend percentage for "Today" so it looks active
                        const pctEl = document.getElementById('growthPct');
                        pctEl.innerText = fmtPct(c.growthPct);
                        pctEl.className = 'trend ' + colorClass(c.growthPct);

                        // Traffic metrics mapping
                        document.getElementById('adPageViews').innerText = pageViews.toLocaleString('en-US');
                        document.getElementById('adImpressions').innerText = impressions.toLocaleString('en-US');
                        updateVal('adRpm', rpm, false, false, '');

                        renderTable(data.accounts, c.currency);
                    }
                }
            } catch(err) {
                console.error("API Error", err);
                document.getElementById('status-text').innerText = "Offline";
                document.getElementById('status-text').style.color = "var(--red)";
            } finally {
                setTimeout(pollData, 2000); 
            }
        }

        function renderTable(accounts, currency) {
            const tbody = document.getElementById('accBody');
            tbody.innerHTML = '';
            accounts.forEach(acc => {
                const tr = document.createElement('tr');
                
                let statusHtml = acc.isLoaded 
                    ? '<span style="color:var(--green); font-weight:500;">Ready</span>' 
                    : \`<span style="color:var(--red); font-size:12px;">Needs attention: \${acc.error}</span>\`;
                    
                tr.innerHTML = \`
                    <td><div class="site-name"><span class="material-symbols-outlined" style="font-size:18px;">public</span> \${acc.name}.com</div></td>
                    <td>\${statusHtml}</td>
                    <td style="text-align: right; font-family:'Google Sans', sans-serif;">\${fmt(acc.total)} \${currency}</td>
                    <td style="text-align: right; font-family:'Google Sans', sans-serif; color: var(--text-secondary);">\${fmt(acc.free)} \${currency}</td>
                \`;
                tbody.appendChild(tr);
            });
        }

        pollData();
    </script>
</body>
</html>
`
}

module.exports = app;
