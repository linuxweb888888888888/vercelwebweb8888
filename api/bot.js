const express = require('express');
const { MongoClient } = require('mongodb');
const ccxt = require('ccxt');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
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
    try {
        let totalEquity = 0; let freeCurrency = 0; let balSuccess = false;
        
        try {
            const bal = await acc.exchange.fetchBalance({ type: 'swap', marginMode: 'cross' });
            if (bal?.total?.[currency] !== undefined) {
                totalEquity = parseFloat(bal.total[currency] || 0);
                freeCurrency = parseFloat(bal.free[currency] || 0);
                balSuccess = true;
            }
        } catch(e) { throw e; }
        
        if (!balSuccess) throw new Error(`Balance Fetch Failed - ${currency} missing from response.`);

        let totalUnrealizedPnl = 0;
        try {
            const ccxtPos = await acc.exchange.fetchPositions(undefined, { marginMode: 'cross' });
            if (ccxtPos) {
                ccxtPos.forEach(p => { totalUnrealizedPnl += parseFloat(p.unrealizedPnl || 0); });
            }
        } catch(e) {
            // Non-fatal, keep going but log internally
        }

        const staticWalletBalance = totalEquity - totalUnrealizedPnl;

        acc.data = {
            total: isNaN(staticWalletBalance) ? 0 : staticWalletBalance,
            free: isNaN(freeCurrency) ? 0 : freeCurrency,
            used: isNaN(totalEquity - freeCurrency) ? 0 : (totalEquity - freeCurrency),
            error: null
        };
    } catch (err) {
        // FULL ERROR DISPLAY - Removed the 40 character truncation
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
        // FULL SERVER ERROR EXPOSURE
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
    <title>HTX Master Aggregator</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&family=Roboto+Mono:wght@400;500;700&display=swap" rel="stylesheet">
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
        td.status-col { max-width: 300px; word-wrap: break-word; white-space: normal; text-align: right; } /* Added text wrapping for long errors */
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
            <div class="subtitle" id="status-text" style="color:var(--red); font-weight:bold;">Connecting to Vercel API...</div>
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
        }
    }
    
    function changeCurrency(newCoin) {
        currentCurrency = newCoin;
        document.getElementById('status-text').innerText = 'Switching currencies...';
        document.getElementById('status-text').style.color = 'var(--text-light)';
        document.getElementById('total').innerText = 'Loading...';
    }
    
    const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 10 });
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

    async function pollData() {
        try {
            document.getElementById('dot').classList.remove('live');
            const res = await fetch('/api/data?currency=' + currentCurrency);
            const data = await res.json();
            
            if (data.error) {
                // EXPOSE API/DATABASE ERRORS ON SCREEN
                document.getElementById('status-text').innerText = "ERROR: " + data.error;
                document.getElementById('status-text').style.color = "var(--red)";
            } else {
                document.getElementById('dot').classList.add('live');
                const c = data.combined;
                
                if (!c.isReady) {
                    document.getElementById('status-text').innerText = \`Fetching \${c.currency} Data via Vercel... (\${c.loadedCount}/\${c.totalCount})\`;
                    document.getElementById('status-text').style.color = "var(--text-light)";
                    renderTable(data.accounts, c.currency);
                } else {
                    document.getElementById('status-text').innerText = \`Tracking \${c.currency} via API\`;
                    document.getElementById('status-text').style.color = "var(--green)";
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
                }
            }
        } catch(err) {
            console.error("API Error", err);
            document.getElementById('status-text').innerText = "Network Error: " + err.message;
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
            
            // FULL CCXT/HTX ERROR DISPLAYED IN TABLE
            let statusHtml = acc.isLoaded 
                ? '<span style="color:var(--green); font-weight:700;">OK</span>' 
                : \`<span style="color:var(--red); font-weight:700; font-size:11px;">\${acc.error}</span>\`;
                
            tr.innerHTML = \`
                <td>\${acc.name}</td>
                <td class="num-col">\${fmt(acc.total)} \${currency}</td>
                <td class="num-col" style="color:#6b7280;">\${fmt(acc.free)} \${currency}</td>
                <td class="status-col">\${statusHtml}</td>
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
