const express = require('express');
const ccxt = require('ccxt');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs'); 
const jwt = require('jsonwebtoken');
const path = require('path');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_this_in_production';

// 🚨 ORIGINAL HARDCODED DATABASE URL 
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888';

// ==========================================
// 1. MONGODB DATABASE SETUP
// ==========================================
let cachedDb = global.mongoose;
if (!cachedDb) {
    cachedDb = global.mongoose = { conn: null, promise: null };
}

const connectDB = async () => {
    if (cachedDb.conn) return cachedDb.conn;
    if (!cachedDb.promise) {
        cachedDb.promise = mongoose.connect(MONGO_URI, { 
            bufferCommands: false,
            maxPoolSize: 10 
        }).then((mongoose) => {
            console.log('✅ Connected to MongoDB successfully!');
            return mongoose;
        }).catch(err => {
            console.error('❌ MongoDB Connection Error:', err);
            cachedDb.promise = null; 
        });
    }
    cachedDb.conn = await cachedDb.promise;
    return cachedDb.conn;
};

// ==========================================
// 2. MONGOOSE SCHEMAS
// ==========================================
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }
});
const User = mongoose.models.User || mongoose.model('User', UserSchema);

const CoinSettingSchema = new mongoose.Schema({
    symbol: { type: String, required: true },
    side: { type: String, default: 'long' }, 
    botActive: { type: Boolean, default: false }
});

const SubAccountSchema = new mongoose.Schema({
    name: { type: String, required: true },
    apiKey: { type: String, required: true },
    secret: { type: String, required: true },
    side: { type: String, default: 'long' }, 
    leverage: { type: Number, default: 10 },
    baseQty: { type: Number, default: 1 },
    takeProfitPct: { type: Number, default: 5.0 },
    stopLossPct: { type: Number, default: -25.0 },
    triggerRoiPct: { type: Number, default: -15.0 },
    dcaTargetRoiPct: { type: Number, default: -2.0 },
    maxContracts: { type: Number, default: 1000 },
    realizedPnl: { type: Number, default: 0 },
    coins: [CoinSettingSchema]
});

const SettingsSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    autonomousAiPilot: { type: Boolean, default: true },
    subAccounts: [SubAccountSchema]
});
const Settings = mongoose.models.Settings || mongoose.model('Settings', SettingsSchema);

const OffsetRecordSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    winnerSymbol: { type: String, required: true },
    winnerPnl: { type: Number, required: true },
    loserSymbol: { type: String, required: true },
    loserPnl: { type: Number, required: true },
    netProfit: { type: Number, required: true },
    timestamp: { type: Date, default: Date.now }
});
const OffsetRecord = mongoose.models.OffsetRecord || mongoose.model('OffsetRecord', OffsetRecordSchema);

// ==========================================
// 3. MULTI-PROFILE BOT ENGINE STATE
// ==========================================
global.activeBots = global.activeBots || new Map();
global.globalWinnersPeaks = global.globalWinnersPeaks || new Map(); 

const activeBots = global.activeBots;
const globalWinnersPeaks = global.globalWinnersPeaks;

function logForProfile(profileId, msg) {
    console.log(`[Profile: ${profileId}] ${msg}`);
    const bot = activeBots.get(profileId);
    if (bot) {
        bot.state.logs.unshift(`${new Date().toLocaleTimeString()} - ${msg}`);
        if (bot.state.logs.length > 50) bot.state.logs.pop();
    }
}

function calculateDcaQty(side, P0, Pc, C0, leverage, targetRoiPct) {
    const R = targetRoiPct / 100;
    let Pnew, Cn;
    if (side === 'long') {
        Pnew = Pc / (1 + (R / leverage));
        Cn = C0 * (P0 - Pnew) / (Pnew - Pc);
    } else {
        Pnew = Pc / (1 - (R / leverage));
        Cn = C0 * (Pnew - P0) / (Pc - Pnew);
    }
    if (Cn <= 0 || isNaN(Cn) || !isFinite(Cn)) return 0;
    return Math.ceil(Cn); 
}

function startBot(userId, subAccount) {
    const profileId = subAccount._id.toString();
    if (activeBots.has(profileId)) stopBot(profileId);
    if (!subAccount.apiKey || !subAccount.secret) return;

    const exchange = new ccxt.htx({ 
        apiKey: subAccount.apiKey, secret: subAccount.secret, 
        options: { defaultType: 'swap' }, enableRateLimit: true 
    });
    
    const state = { logs: [], coinStates: {} };
    let isProcessing = false;
    let lastError = '';

    const intervalId = setInterval(async () => {
        if (isProcessing) return; 
        isProcessing = true;

        const botData = activeBots.get(profileId);
        if (!botData) { isProcessing = false; return; }
        
        const currentSettings = botData.settings;
        const activeCoins = currentSettings.coins.filter(c => c.botActive);

        if (activeCoins.length === 0) { isProcessing = false; return; }

        try {
            const globalSet = await Settings.findOne({ userId });
            const isAutoPilot = globalSet ? (globalSet.autonomousAiPilot !== false) : true;

            const symbolsToFetch = activeCoins.map(c => c.symbol);
            const [allTickers, allPositions] = await Promise.all([
                exchange.fetchTickers(symbolsToFetch).catch(e => { throw new Error('Tickers: ' + e.message); }),
                exchange.fetchPositions(symbolsToFetch).catch(e => { throw new Error('Positions: ' + e.message); })
            ]);

            for (let coin of activeCoins) {
                try {
                    if (!state.coinStates[coin.symbol]) {
                        state.coinStates[coin.symbol] = { status: 'Running', currentPrice: 0, avgEntry: 0, contracts: 0, currentRoi: 0, unrealizedPnl: 0, margin: 0, lastDcaTime: 0, lockUntil: 0, peakRoi: -9999, valleyRoi: 9999, lastPrices: [] };
                    }
                    let cState = state.coinStates[coin.symbol];
                    if (cState.lockUntil && Date.now() < cState.lockUntil) continue;
                    cState.status = 'Running';

                    const ticker = allTickers[coin.symbol];
                    if (!ticker || !ticker.last) continue; 
                    
                    cState.currentPrice = ticker.last;
                    const activeSide = coin.side || currentSettings.side;
                    const position = allPositions.find(p => p.symbol === coin.symbol && p.side === activeSide && p.contracts > 0);

                    if (!position) {
                        cState.avgEntry = 0; cState.contracts = 0; cState.currentRoi = 0; cState.unrealizedPnl = 0; cState.margin = 0;
                        cState.peakRoi = -9999; cState.valleyRoi = 9999; cState.lastPrices = []; 
                        const safeBaseQty = Math.max(1, Math.floor(currentSettings.baseQty));
                        logForProfile(profileId, `[${coin.symbol}] 🛒 No position. Opening base position of ${safeBaseQty} contracts (${activeSide}).`);
                        cState.lockUntil = Date.now() + 10000; 
                        await exchange.setLeverage(currentSettings.leverage, coin.symbol, { marginMode: 'cross' }).catch(()=>{});
                        const orderSide = activeSide === 'long' ? 'buy' : 'sell';
                        await exchange.createOrder(coin.symbol, 'market', orderSide, safeBaseQty, undefined, { offset: 'open', lever_rate: currentSettings.leverage });
                        continue; 
                    }

                    cState.avgEntry = position.entryPrice;
                    cState.contracts = position.contracts;
                    const contractSize = position.contractSize || 1;
                    let margin = position.initialMargin !== undefined ? position.initialMargin : (cState.avgEntry * cState.contracts * contractSize) / currentSettings.leverage;
                    let unrealizedPnl = position.unrealizedPnl !== undefined ? position.unrealizedPnl : (activeSide === 'long' ? (cState.currentPrice - cState.avgEntry) * cState.contracts * contractSize : (cState.avgEntry - cState.currentPrice) * cState.contracts * contractSize);
                    
                    cState.unrealizedPnl = unrealizedPnl;
                    cState.margin = margin;
                    cState.currentRoi = margin > 0 ? (unrealizedPnl / margin) * 100 : 0;

                    let executeClose = false;
                    let closeReason = '';

                    if (isAutoPilot) {
                        if (!cState.lastPrices) cState.lastPrices = [];
                        cState.lastPrices.push(cState.currentPrice);
                        if (cState.lastPrices.length > 10) cState.lastPrices.shift();

                        cState.peakRoi = Math.max(cState.peakRoi || -9999, cState.currentRoi);
                        cState.valleyRoi = Math.min(cState.valleyRoi || 9999, cState.currentRoi);

                        if (cState.peakRoi > 0.5) { 
                            let trailingTolerance = cState.peakRoi > 2.0 ? 0.5 : 0.2; 
                            if (cState.peakRoi - cState.currentRoi >= trailingTolerance) {
                                executeClose = true;
                                closeReason = `🤖 AI Trailing Profit Secured (Fell from peak ${cState.peakRoi.toFixed(2)}%)`;
                            }
                        } else if (cState.currentRoi > 0.1 && cState.lastPrices.length === 10) {
                            const startP = cState.lastPrices[0];
                            const endP = cState.lastPrices[9];
                            const isStagnant = activeSide === 'long' ? endP <= startP : endP >= startP;
                            if (isStagnant) {
                                executeClose = true;
                                closeReason = `🤖 AI Micro-Scalp (Momentum dead at ${cState.currentRoi.toFixed(2)}%)`;
                            }
                        } else if (cState.valleyRoi < -8.0 && cState.currentRoi >= -2.0) {
                            executeClose = true;
                            closeReason = `🤖 AI Smart Cut (Bounced back from massive drop, cutting loose)`;
                        }

                        if (!executeClose && cState.currentRoi <= currentSettings.triggerRoiPct && (Date.now() - cState.lastDcaTime > 12000)) {
                            const reqQty = calculateDcaQty(activeSide, cState.avgEntry, cState.currentPrice, cState.contracts, currentSettings.leverage, currentSettings.dcaTargetRoiPct);
                            if (reqQty > 0 && (cState.contracts + reqQty) <= currentSettings.maxContracts) {
                                logForProfile(profileId, `[${coin.symbol}] ⚡ AI Executing DCA: Buying ${reqQty} contracts`);
                                cState.lockUntil = Date.now() + 10000; 
                                const orderSide = activeSide === 'long' ? 'buy' : 'sell';
                                await exchange.createOrder(coin.symbol, 'market', orderSide, reqQty, undefined, { offset: 'open', lever_rate: currentSettings.leverage }).catch(()=>{});
                                cState.lastDcaTime = Date.now(); 
                            }
                        }
                    } else {
                        const isTakeProfit = cState.currentRoi >= currentSettings.takeProfitPct;
                        const isStopLoss = currentSettings.stopLossPct < 0 && cState.currentRoi <= currentSettings.stopLossPct;
                        if (isTakeProfit || isStopLoss) {
                            executeClose = true;
                            closeReason = isTakeProfit ? '🎯 Manual Take Profit' : '🛑 Manual Stop Loss';
                        }
                        if (!executeClose && cState.currentRoi <= currentSettings.triggerRoiPct && (Date.now() - cState.lastDcaTime > 12000)) {
                            const reqQty = calculateDcaQty(activeSide, cState.avgEntry, cState.currentPrice, cState.contracts, currentSettings.leverage, currentSettings.dcaTargetRoiPct);
                            if (reqQty > 0 && (cState.contracts + reqQty) <= currentSettings.maxContracts) {
                                logForProfile(profileId, `[${coin.symbol}] ⚡ Executing DCA: Buying ${reqQty} contracts`);
                                cState.lockUntil = Date.now() + 10000; 
                                const orderSide = activeSide === 'long' ? 'buy' : 'sell';
                                await exchange.createOrder(coin.symbol, 'market', orderSide, reqQty, undefined, { offset: 'open', lever_rate: currentSettings.leverage }).catch(()=>{});
                                cState.lastDcaTime = Date.now(); 
                            }
                        }
                    }

                    if (executeClose) {
                        logForProfile(profileId, `[${coin.symbol}] ${closeReason}! Closing ${cState.contracts} contracts. Net: $${unrealizedPnl.toFixed(4)}`);
                        const contractsToClose = cState.contracts;
                        cState.lockUntil = Date.now() + 10000;
                        cState.contracts = 0; cState.unrealizedPnl = 0; cState.currentRoi = 0;
                        cState.peakRoi = -9999; cState.valleyRoi = 9999; cState.lastPrices = [];

                        const orderSide = activeSide === 'long' ? 'sell' : 'buy';
                        await exchange.createOrder(coin.symbol, 'market', orderSide, contractsToClose, undefined, { offset: 'close', reduceOnly: true, lever_rate: currentSettings.leverage }).catch(()=>{});

                        currentSettings.realizedPnl = (currentSettings.realizedPnl || 0) + unrealizedPnl;
                        Settings.updateOne({ "subAccounts._id": currentSettings._id }, { $set: { "subAccounts.$.realizedPnl": currentSettings.realizedPnl } }).catch(()=>{});
                    }
                } catch (coinErr) {
                    if (coinErr.message !== lastError) logForProfile(profileId, `[${coin.symbol}] ❌ Warning: ${coinErr.message}`);
                }
            } 
            lastError = '';
        } catch (err) {
            if (err.message !== lastError) { logForProfile(profileId, `❌ Global API Error (Retrying next cycle): ${err.message}`); lastError = err.message; }
        } finally {
            isProcessing = false;
        }
    }, 6000);

    activeBots.set(profileId, { userId: String(userId), settings: subAccount, state, exchange, intervalId });
    logForProfile(profileId, `🚀 Engine Started for: ${subAccount.name}`);
}

function stopBot(profileId) {
    if (activeBots.has(profileId)) {
        clearInterval(activeBots.get(profileId).intervalId);
        activeBots.delete(profileId);
        console.log(`[Profile: ${profileId}] ⏹ Bot Stopped.`);
    }
}

// =========================================================================
// 4. BACKGROUND TASKS (AI GROUP LOGIC)
// =========================================================================
const executeGlobalProfitMonitor = async () => {
    if (global.isGlobalMonitoring) return;
    global.isGlobalMonitoring = true;

    try {
        await connectDB(); 
        const usersSettings = await Settings.find({});
        
        for (let userSetting of usersSettings) {
            const dbUserId = String(userSetting.userId);
            const isAutoPilot = userSetting.autonomousAiPilot !== false; 
            
            let profilesData = {};
            for (let [profileId, botData] of activeBots.entries()) {
                if (botData.userId !== dbUserId) continue;
                if (!profilesData[profileId]) profilesData[profileId] = { candidates: [], botData };
                
                for (let symbol in botData.state.coinStates) {
                    const cState = botData.state.coinStates[symbol];
                    if (cState.status === 'Running' && cState.contracts > 0 && (!cState.lockUntil || Date.now() >= cState.lockUntil)) {
                        const pnl = parseFloat(cState.unrealizedPnl) || 0;
                        const activeSide = botData.settings.coins.find(c => c.symbol === symbol)?.side || botData.settings.side;
                        profilesData[profileId].candidates.push({
                            profileId, symbol, exchange: botData.exchange, unrealizedPnl: pnl,
                            contracts: cState.contracts, side: activeSide, leverage: botData.settings.leverage, subAccount: botData.settings
                        });
                    }
                }
            }

            for (let profileId in profilesData) {
                const { candidates: activeCandidates } = profilesData[profileId];
                if (activeCandidates.length === 0) {
                    globalWinnersPeaks.set(profileId, 0);
                    continue;
                }

                // 🏆 1. CALCULATE SUM OF ONLY POSITIVE POSITIONS
                let winners = activeCandidates.filter(c => c.unrealizedPnl > 0);
                let losers = activeCandidates.filter(c => c.unrealizedPnl < 0).sort((a,b) => b.unrealizedPnl - a.unrealizedPnl);
                
                let currentWinnersSum = winners.reduce((sum, w) => sum + w.unrealizedPnl, 0);
                let totalLosersSum = losers.reduce((sum, l) => sum + l.unrealizedPnl, 0);

                let peakW = globalWinnersPeaks.get(profileId) || 0;
                if (currentWinnersSum > peakW) {
                    globalWinnersPeaks.set(profileId, currentWinnersSum);
                    peakW = currentWinnersSum;
                }

                // ====================================================
                // 🤖 AUTONOMOUS AI PILOT (WINNERS GROUP TRAIL & PROFIT)
                // ====================================================
                if (isAutoPilot && currentWinnersSum > 0) {
                    let aiExecutedGroup = false;

                    // A) 🛡️ DYNAMIC WINNERS PEAK TRAILING
                    if (peakW >= 0) {
                        let trailingTolerance = peakW > 10.0 ? peakW * 0.15 : Math.max(peakW * 0.25, 0.01); 
                        
                        // SNAP! Leash Tension limit reached
                        if (peakW - currentWinnersSum >= trailingTolerance) {
                            let totalNet = currentWinnersSum + totalLosersSum;
                            
                            // 🚀 SCENARIO 1: Global Protect / Close (ANY profit > 0)
                            if (totalNet > 0) {
                                logForProfile(profileId, `🤖 AI WINNERS PROTECT: Winners peaked at $${peakW.toFixed(2)} but fading. Closing ALL positions for Guaranteed Net: +$${totalNet.toFixed(4)}`);
                                
                                OffsetRecord.create({ userId: dbUserId, winnerSymbol: `AI Global TP (${winners.length} Winners)`, winnerPnl: currentWinnersSum, loserSymbol: `AI Global Clear (${losers.length} Losers)`, loserPnl: totalLosersSum, netProfit: totalNet }).catch(()=>{});
                                
                                activeCandidates.forEach(pos => pos.markedForClose = true);
                                aiExecutedGroup = true;
                                globalWinnersPeaks.set(profileId, 0);
                            } 
                            // 🚀 SCENARIO 2: Cluster Absorb (Eat small losers for ANY profit > 0)
                            else if (losers.length > 0) {
                                let tempNet = currentWinnersSum;
                                let selectedLosers = [];
                                let selectedLosersPnl = 0;

                                for (let l of losers) {
                                    if (tempNet + l.unrealizedPnl > 0) {
                                        tempNet += l.unrealizedPnl;
                                        selectedLosersPnl += l.unrealizedPnl;
                                        selectedLosers.push(l);
                                    } else {
                                        break; 
                                    }
                                }

                                if (selectedLosers.length > 0) {
                                    logForProfile(profileId, `🤖 AI CLUSTER ABSORB: Fading winners ($${currentWinnersSum.toFixed(2)}) used to absorb ${selectedLosers.length} small losers. Net Profit: +$${tempNet.toFixed(4)}`);
                                    
                                    OffsetRecord.create({ userId: dbUserId, winnerSymbol: `AI Cluster (${winners.length} Winners)`, winnerPnl: currentWinnersSum, loserSymbol: `AI Cluster (${selectedLosers.length} Small Losers)`, loserPnl: selectedLosersPnl, netProfit: tempNet }).catch(()=>{});

                                    winners.forEach(w => w.markedForClose = true);
                                    selectedLosers.forEach(l => l.markedForClose = true);
                                    aiExecutedGroup = true;
                                    globalWinnersPeaks.set(profileId, 0);
                                }
                            }

                            // 🚀 SCENARIO 3: NATIVE GROUP TAKE-PROFIT! (ANY profit > 0)
                            if (!aiExecutedGroup && currentWinnersSum > 0) {
                                logForProfile(profileId, `🤖 AI GROUP TAKE-PROFIT: Positive Peak ($${peakW.toFixed(2)}) snapped tension! Securing remaining group profit: +$${currentWinnersSum.toFixed(4)}`);
                                
                                OffsetRecord.create({ userId: dbUserId, winnerSymbol: `AI Group Take-Profit (${winners.length} Coins)`, winnerPnl: currentWinnersSum, loserSymbol: `None`, loserPnl: 0, netProfit: currentWinnersSum }).catch(()=>{});

                                winners.forEach(w => w.markedForClose = true);
                                aiExecutedGroup = true;
                                globalWinnersPeaks.set(profileId, 0);
                            }
                        }
                    }

                    // EXECUTE ANY GROUP MARKED FOR CLOSE
                    if (aiExecutedGroup) {
                        const toClose = activeCandidates.filter(c => c.markedForClose);
                        toClose.forEach(async pos => {
                            const bState = activeBots.get(pos.profileId).state.coinStates[pos.symbol];
                            if(bState) { bState.lockUntil = Date.now() + 10000; bState.contracts = 0; }
                            const orderSide = pos.side === 'long' ? 'sell' : 'buy';
                            await pos.exchange.createOrder(pos.symbol, 'market', orderSide, pos.contracts, undefined, { offset: 'close', reduceOnly: true, lever_rate: pos.leverage }).catch(()=>{});
                            pos.subAccount.realizedPnl = (pos.subAccount.realizedPnl || 0) + pos.unrealizedPnl;
                            Settings.updateOne({ "subAccounts._id": pos.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": pos.subAccount.realizedPnl } }).catch(()=>{});
                        });
                        continue; 
                    }

                    // B) ⚖️ STANDARD 1-to-1 FAT-TRIMMER (ANY profit > 0)
                    let availableWinners = winners.filter(w => !w.markedForClose).sort((a,b) => b.unrealizedPnl - a.unrealizedPnl);
                    let availableLosers = losers.filter(l => !l.markedForClose); 

                    for (let w of availableWinners) {
                        if (w.markedForClose) continue;
                        for (let l of availableLosers) {
                            if (l.markedForClose) continue;
                            let netResult = w.unrealizedPnl + l.unrealizedPnl;
                            
                            if (netResult > 0) {
                                w.markedForClose = true; l.markedForClose = true;
                                logForProfile(profileId, `🤖 AI 1-to-1 Auto-Trimmer: Absorbed Loser [${l.symbol}] using Winner [${w.symbol}]. Secured Net: +$${netResult.toFixed(4)}`);
                                OffsetRecord.create({ userId: dbUserId, winnerSymbol: `AI Trimmer: ${w.symbol}`, winnerPnl: w.unrealizedPnl, loserSymbol: `AI Trimmer: ${l.symbol}`, loserPnl: l.unrealizedPnl, netProfit: netResult }).catch(()=>{});

                                [w, l].forEach(async pos => {
                                    const bState = activeBots.get(pos.profileId).state.coinStates[pos.symbol];
                                    if(bState) { bState.lockUntil = Date.now() + 10000; bState.contracts = 0; }
                                    const orderSide = pos.side === 'long' ? 'sell' : 'buy';
                                    await pos.exchange.createOrder(pos.symbol, 'market', orderSide, pos.contracts, undefined, { offset: 'close', reduceOnly: true, lever_rate: pos.leverage }).catch(()=>{});
                                    pos.subAccount.realizedPnl = (pos.subAccount.realizedPnl || 0) + pos.unrealizedPnl;
                                    Settings.updateOne({ "subAccounts._id": pos.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": pos.subAccount.realizedPnl } }).catch(()=>{});
                                });
                                break; 
                            }
                        }
                    }
                }
            }
        }
    } catch (err) {
        console.error("Global Profit Monitor Error:", err);
    } finally {
        global.isGlobalMonitoring = false; 
    }
};

const bootstrapBots = async () => {
    if (!global.botLoopsStarted) {
        global.botLoopsStarted = true;
        setInterval(executeGlobalProfitMonitor, 6000);
        try {
            await connectDB();
            const activeSettings = await Settings.find({});
            activeSettings.forEach(s => {
                if (s.subAccounts) { s.subAccounts.forEach(sub => { if (sub.coins && sub.coins.some(c => c.botActive)) startBot(s.userId.toString(), sub); }); }
            });
        } catch(e) {}
    }
};

// ==========================================
// 6. EXPRESS API & AUTHENTICATION
// ==========================================
const app = express();
app.use(express.json());

const authMiddleware = async (req, res, next) => {
    await connectDB();
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.userId = decoded.userId;
        next();
    });
};

app.get('/api/ping', async (req, res) => {
    await connectDB(); bootstrapBots(); 
    res.status(200).json({ success: true, message: 'Bot is awake', timestamp: new Date().toISOString() });
});

app.post('/api/register', async (req, res) => {
    await connectDB();
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await User.create({ username, password: hashedPassword });
        await Settings.create({ userId: user._id, autonomousAiPilot: true, subAccounts: [] });
        const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token });
    } catch (err) {
        res.status(400).json({ error: 'Username already exists or invalid data' });
    }
});

app.post('/api/login', async (req, res) => {
    await connectDB();
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token });
});

app.get('/api/settings', authMiddleware, async (req, res) => { 
    bootstrapBots(); 
    const settings = await Settings.findOne({ userId: req.userId }); 
    res.json(settings); 
});

app.post('/api/settings', authMiddleware, async (req, res) => {
    await connectDB();
    try {
        const updateData = req.body;
        const updated = await Settings.findOneAndUpdate(
            { userId: req.userId },
            { $set: updateData },
            { new: true, upsert: true }
        );
        res.json({ success: true, settings: updated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/status', authMiddleware, async (req, res) => {
    bootstrapBots(); 
    const settings = await Settings.findOne({ userId: req.userId });
    
    const userStatuses = {};
    const userWinnersPeaks = {}; 
    const dbUserId = req.userId.toString();

    for (let [profileId, botData] of activeBots.entries()) {
        if (botData.userId === dbUserId) {
            userStatuses[profileId] = botData.state;
            userWinnersPeaks[profileId] = global.globalWinnersPeaks.get(profileId) || 0; 
        }
    }
    
    res.json({ 
        states: userStatuses, 
        subAccounts: settings ? settings.subAccounts : [], 
        globalSettings: settings, 
        winnersPeaks: userWinnersPeaks 
    });
});

app.get('/api/offsets', authMiddleware, async (req, res) => {
    const records = await OffsetRecord.find({ userId: req.userId }).sort({ timestamp: -1 }).limit(100);
    res.json(records);
});

// ==========================================
// 7. FRONTEND UI
// ==========================================
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>HTX Multi-User Bot</title>
        <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
        <style>
            body { font-family: 'Roboto', sans-serif; background: #f4f6f8; color: #333; margin: 0; padding: 20px; }
            .container { max-width: 1200px; margin: auto; }
            .panel { background: #fff; padding: 24px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 20px; }
            .flex-container { display: flex; gap: 24px; flex-wrap: wrap; align-items: flex-start; }
            .flex-1 { flex: 1; min-width: 350px; }
            .flex-row { display: flex; gap: 12px; align-items: center; }
            h2 { margin-top: 0; color: #202124; border-bottom: 1px solid #eee; padding-bottom: 12px; font-weight: 500; }
            h3 { color: #202124; font-weight: 500; margin-top: 24px; border-bottom: 1px solid #eee; padding-bottom: 8px; font-size: 1.1em; }
            label { display: block; margin-top: 16px; font-size: 0.85em; color: #5f6368; font-weight: 500; text-transform: uppercase; }
            input, select { width: 100%; padding: 12px; margin-top: 8px; background: #fafafa; border: 1px solid #dadce0; color: #333; border-radius: 4px; box-sizing: border-box; }
            button { padding: 12px 16px; border: none; border-radius: 4px; font-weight: 500; cursor: pointer; text-transform: uppercase; transition: all 0.2s; }
            .btn-blue { background: #1a73e8; color: white; width: 100%; margin-top: 24px; }
            .btn-green { background: #1e8e3e; color: white; }
            .btn-red { background: #d93025; color: white; }
            .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
            .header h1 { margin: 0; color: #1a73e8; font-size: 1.8em; }
            .btn-logout { background: #fff; color: #5f6368; border: 1px solid #dadce0; padding: 8px 16px; }
            .coin-box { border: 1px solid #e8eaed; padding: 12px; border-radius: 6px; margin-bottom: 8px; background: #fafafa; }
            .status-box { background: #f8f9fa; padding: 20px; border-radius: 8px; border: 1px solid #e8eaed; margin-bottom: 24px; }
            .stat-label { font-size: 0.85em; color: #5f6368; text-transform: uppercase; }
            .val { display: block; font-weight: 700; color: #202124; font-size: 1.2em; margin-top: 4px; }
            .val.green { color: #1e8e3e; }
            .val.red { color: #d93025; }
            .log-box { background: #1e1e1e; padding: 16px; border-radius: 6px; height: 350px; overflow-y: auto; font-family: 'Courier New', monospace; font-size: 0.85em; color: #4CAF50; border: 1px solid #333; line-height: 1.4; }
            #auth-view { max-width: 400px; margin: 10vh auto; text-align: center; }
            #dashboard-view { display: none; }
            #auth-msg { color: #d93025; font-size: 0.9em; margin-top: 16px; min-height: 20px; }
            .ai-glow { box-shadow: 0 0 15px rgba(26, 115, 232, 0.4); border: 2px solid #1a73e8; background: #f0f4fc; }
        </style>
    </head>
    <body>

        <div id="auth-view" class="panel">
            <h2 style="border:none; color:#1a73e8; font-size:1.8em; margin-bottom:20px;">Bot Login</h2>
            <div style="text-align: left;"><label>Username</label><input type="text" id="username"><label>Password</label><input type="password" id="password"></div>
            <div class="flex-row" style="margin-top: 24px;"><button class="btn-blue" style="margin:0; flex:1;" onclick="auth('login')">Login</button><button class="btn-logout" style="margin:0; flex:1; padding: 12px 16px;" onclick="auth('register')">Register</button></div>
            <p id="auth-msg"></p>
        </div>

        <div id="dashboard-view" class="container">
            <div class="header">
                <h1>HTX Trading Bot</h1>
                <div style="display:flex; gap:12px;">
                    <button class="btn-blue" style="margin:0; width:auto; padding: 8px 16px;" onclick="switchTab('main')">⚙️ Dashboard</button>
                    <button class="btn-blue ai-glow" style="margin:0; width:auto; padding: 8px 16px;" onclick="switchTab('aipilot')">🤖 AI Pilot Live</button>
                    <button class="btn-logout" style="margin:0; width:auto;" onclick="switchTab('offsets')">History</button>
                    <button class="btn-logout" style="margin:0; width:auto;" onclick="logout()">Logout</button>
                </div>
            </div>

            <div id="offset-tab" style="display:none;">
                <div class="panel">
                    <h2 style="color: #1e8e3e;">Executed Smart Offsets & AI Auto-Trims History</h2>
                    <div id="offsetTableContainer" style="margin-top: 20px;">Loading historical offset data...</div>
                </div>
            </div>

            <!-- ========================== AI PILOT LIVE VIEW TAB ========================== -->
            <div id="aipilot-tab" style="display:none;">
                <div class="panel ai-glow" style="border: 1px solid #1a73e8;">
                    <div class="flex-row" style="justify-content: space-between;">
                        <h2 style="color: #1a73e8; border: none; margin: 0;">🤖 AI Pilot Telemetry & Live Radar</h2>
                        <div id="aiMasterStatus" style="font-weight: bold; padding: 8px 16px; border-radius: 4px;">Loading...</div>
                    </div>
                    <p style="color: #5f6368; font-size: 0.9em;">Visualizing the AI's internal thought process, tracking the Positive Positions Peak, and dynamic trimming logic.</p>

                    <h3 style="color: #202124;">🏆 Positive Peak Radar (Dynamic Group Take-Profit & Absorption)</h3>
                    <div id="aiWinnersGroupRadar" style="background: #f8f9fa; padding: 16px; border-radius: 6px; border: 1px dashed #ccc; margin-bottom: 24px;">
                        Waiting for data...
                    </div>

                    <h3 style="color: #202124;">⚖️ AI 1-to-1 Trimmer Radar (Micro Absorption)</h3>
                    <div id="aiTrimmerRadar" style="background: #f8f9fa; padding: 16px; border-radius: 6px; border: 1px dashed #ccc; margin-bottom: 24px;">
                        Waiting for data...
                    </div>

                    <h3 style="color: #202124;">📡 Micro-Scalp & Momentum Radar</h3>
                    <div id="aiCoinRadarContainer"></div>

                    <h3 style="color: #202124;">⚡ Live AI Action Feed</h3>
                    <div class="log-box" id="aiSpecificLogs" style="height: 200px; border-color: #1a73e8; color: #64b5f6;">Waiting for AI events...</div>
                </div>
            </div>

            <div id="main-tab">
                <div class="status-box" style="background:#fff3e0; border-color:#ffe0b2; margin-bottom: 24px;">
                    <div class="flex-row" style="justify-content: space-between;">
                        <div><span class="stat-label">Global Realized PNL</span><span class="val" id="globalPnl">0.00</span></div>
                        <div><span class="stat-label">Current Profile PNL</span><span class="val" id="profilePnl">0.00</span></div>
                        <div><span class="stat-label">Global Unrealized PNL ($)</span><span class="val" id="topGlobalUnrealized">0.0000000000</span></div>
                    </div>
                </div>

                <div class="flex-container">
                    <div class="panel flex-1">
                        <div class="ai-glow" style="padding: 16px; border-radius: 8px; margin-bottom: 24px;">
                            <h2 style="margin:0 0 8px 0; color:#1a73e8; border:none; display:flex; align-items:center;">
                                🤖 AUTONOMOUS AI PILOT
                                <input type="checkbox" id="autonomousAiPilot" style="width:auto; margin-left:16px; transform: scale(1.5);">
                            </h2>
                            <p style="font-size:0.85em; color:#5f6368; line-height:1.4; margin-top:4px;">
                                <strong>When Enabled:</strong> The bot entirely ignores your manual Take Profit, Stop Loss, and Smart Offset numbers below.<br><br>
                                1. It dynamically trails peak profits.<br>
                                2. It scalps micro-profits if momentum dies.<br>
                                3. It groups winning coins together to automatically close for group-profit or to absorb losers!
                            </p>
                            <button class="btn-blue" style="margin-top:12px; background:#1a73e8;" onclick="saveGlobalSettings()">Update AI Mode</button>
                        </div>
                        
                        <h2>Profile Setup</h2>
                        <div style="background: #f8f9fa; padding: 12px; border-radius: 6px; margin-bottom: 16px; border: 1px solid #dadce0;">
                            <div class="flex-row" style="margin-bottom: 8px;">
                                <select id="subAccountSelect" style="margin:0; flex:3;"><option value="">-- Create a Profile --</option></select>
                                <button class="btn-blue" style="margin:0; flex:1; padding: 12px;" onclick="loadSubAccount()">Load</button>
                            </div>
                        </div>

                        <div id="settingsContainer" style="display:none;">
                            <div class="flex-row" style="margin-top: 16px; margin-bottom: 16px;">
                                <button class="btn-green" style="flex:1;" onclick="globalToggleBot(true)">▶ Start Bot</button>
                                <button class="btn-red" style="flex:1;" onclick="globalToggleBot(false)">⏹ Stop Bot</button>
                            </div>
                            <div id="coinsListContainer"></div>
                        </div>
                    </div>

                    <div class="panel flex-1" style="flex: 1.5;">
                        <h2>Live Profile Dashboard</h2>
                        <div id="dashboardStatusContainer"><p style="color:#5f6368;">No profile loaded or no coins active.</p></div>
                        <h2 style="margin-top:30px;">Profile System Logs</h2>
                        <div class="log-box" id="logs">Waiting for logs...</div>
                    </div>
                </div>
            </div>
        </div>

        <script>
            let token = localStorage.getItem('token');
            let statusInterval;
            let mySubAccounts = [];
            let currentProfileIndex = -1;
            let myCoins = [];
            
            function checkAuth() {
                if (token) {
                    document.getElementById('auth-view').style.display = 'none';
                    document.getElementById('dashboard-view').style.display = 'block';
                    fetchSettings();
                    statusInterval = setInterval(loadStatus, 5000);
                } else {
                    document.getElementById('auth-view').style.display = 'block';
                    document.getElementById('dashboard-view').style.display = 'none';
                    clearInterval(statusInterval);
                }
            }

            function switchTab(tab) {
                document.getElementById('main-tab').style.display = 'none';
                document.getElementById('offset-tab').style.display = 'none';
                document.getElementById('aipilot-tab').style.display = 'none';

                if (tab === 'main') document.getElementById('main-tab').style.display = 'block';
                else if (tab === 'offsets') { document.getElementById('offset-tab').style.display = 'block'; loadOffsets(); } 
                else if (tab === 'aipilot') { document.getElementById('aipilot-tab').style.display = 'block'; loadStatus(); } 
            }

            async function auth(action) {
                const username = document.getElementById('username').value;
                const password = document.getElementById('password').value;
                document.getElementById('auth-msg').innerText = "Processing...";
                const res = await fetch('/api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
                const data = await res.json();
                if (data.token) { token = data.token; localStorage.setItem('token', token); document.getElementById('auth-msg').innerText = ""; checkAuth(); } 
                else { document.getElementById('auth-msg').innerText = data.error || data.message; }
            }

            function logout() { localStorage.removeItem('token'); token = null; checkAuth(); }

            async function fetchSettings() {
                const res = await fetch('/api/settings', { headers: { 'Authorization': 'Bearer ' + token } });
                if (res.status === 401 || res.status === 403) return logout();
                const config = await res.json();
                document.getElementById('autonomousAiPilot').checked = config.autonomousAiPilot !== false;
                mySubAccounts = config.subAccounts || [];
                renderSubAccounts();
                if (mySubAccounts.length > 0) { document.getElementById('subAccountSelect').value = 0; loadSubAccount(); }
            }

            async function saveGlobalSettings() {
                const isAutoPilot = document.getElementById('autonomousAiPilot').checked;
                await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ subAccounts: mySubAccounts, autonomousAiPilot: isAutoPilot }) });
                alert('Global Settings Updated!');
            }

            function renderSubAccounts() {
                const select = document.getElementById('subAccountSelect');
                select.innerHTML = '';
                if(mySubAccounts.length === 0) select.innerHTML = '<option value="">-- Create a Profile --</option>';
                else mySubAccounts.forEach((sub, i) => select.innerHTML += '<option value="' + i + '">' + sub.name + '</option>');
            }

            function loadSubAccount() {
                const index = parseInt(document.getElementById('subAccountSelect').value);
                if(!isNaN(index) && index >= 0) {
                    currentProfileIndex = index;
                    const profile = mySubAccounts[index];
                    document.getElementById('settingsContainer').style.display = 'block';
                    myCoins = profile.coins || [];
                    renderCoinsSettings();
                }
            }

            function renderCoinsSettings() {
                const container = document.getElementById('coinsListContainer');
                container.innerHTML = '';
                myCoins.forEach((coin, i) => {
                    const box = document.createElement('div');
                    box.className = 'coin-box flex-row';
                    box.style.justifyContent = 'space-between';
                    const sideColor = coin.side === 'long' ? '#1e8e3e' : '#d93025';
                    box.innerHTML = '<span style="font-weight: bold; color: #1a73e8; font-size: 1.1em;">' + coin.symbol + ' <span style="font-size: 0.75em; color: ' + sideColor + '; text-transform: uppercase;">(' + coin.side + ')</span></span>';
                    container.appendChild(box);
                });
            }

            async function toggleCoinBot(symbol, active) {
                const coin = myCoins.find(c => c.symbol === symbol);
                if(coin) coin.botActive = active;
                await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ subAccounts: mySubAccounts }) });
            }
            async function globalToggleBot(active) {
                myCoins.forEach(c => c.botActive = active);
                await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ subAccounts: mySubAccounts }) });
            }

            async function loadOffsets() {
                const res = await fetch('/api/offsets', { headers: { 'Authorization': 'Bearer ' + token } });
                if (!res.ok) return;
                const records = await res.json();
                if (records.length === 0) { document.getElementById('offsetTableContainer').innerHTML = '<p>No smart offsets executed yet.</p>'; return; }

                let ih = '<table style="width:100%; text-align:left; border-collapse:collapse; background:#fff; border-radius:6px; overflow:hidden;"><tr style="background:#f8f9fa;"><th style="padding:12px;">Date/Time</th><th>Action/Winner</th><th>Winner PNL</th><th>Absorbed Loser</th><th>Loser PNL</th><th>Net Profit</th></tr>';
                records.forEach(r => {
                    const d = new Date(r.timestamp);
                    const wpnl = r.winnerPnl >= 0 ? '+' : '';
                    const lpnl = r.loserPnl >= 0 ? '+' : '';
                    const npnl = r.netProfit >= 0 ? '+' : '';
                    ih += '<tr>' +
                        '<td style="padding:12px; border-bottom:1px solid #eee;">' + d.toLocaleDateString() + ' ' + d.toLocaleTimeString() + '</td>' +
                        '<td style="padding:12px; border-bottom:1px solid #eee; color:#1a73e8;">' + r.winnerSymbol + '</td>' +
                        '<td style="padding:12px; border-bottom:1px solid #eee; color:' + (r.winnerPnl >= 0 ? '#1e8e3e' : '#d93025') + ';">' + wpnl + '$' + r.winnerPnl.toFixed(4) + '</td>' +
                        '<td style="padding:12px; border-bottom:1px solid #eee; color:#1a73e8;">' + r.loserSymbol + '</td>' +
                        '<td style="padding:12px; border-bottom:1px solid #eee; color:' + (r.loserPnl >= 0 ? '#1e8e3e' : '#d93025') + ';">' + lpnl + '$' + r.loserPnl.toFixed(4) + '</td>' +
                        '<td style="padding:12px; border-bottom:1px solid #eee; font-weight:bold; color:' + (r.netProfit >= 0 ? '#1e8e3e' : '#d93025') + ';">' + npnl + '$' + r.netProfit.toFixed(4) + '</td>' +
                    '</tr>';
                });
                document.getElementById('offsetTableContainer').innerHTML = ih + '</table>';
            }

            async function loadStatus() {
                const res = await fetch('/api/status', { headers: { 'Authorization': 'Bearer ' + token } });
                if (res.status === 401 || res.status === 403) return logout();
                
                const data = await res.json();
                const allStatuses = data.states || {};
                const globalSet = data.globalSettings || {};

                let globalTotal = 0; let globalUnrealized = 0;
                (data.subAccounts || []).forEach(sub => globalTotal += (sub.realizedPnl || 0));

                for (let pid in allStatuses) {
                    const st = allStatuses[pid];
                    if (st && st.coinStates) {
                        for (let sym in st.coinStates) {
                            if (st.coinStates[sym].status === 'Running' && st.coinStates[sym].contracts > 0) {
                                globalUnrealized += (parseFloat(st.coinStates[sym].unrealizedPnl) || 0);
                            }
                        }
                    }
                }

                document.getElementById('topGlobalUnrealized').innerText = (globalUnrealized >= 0 ? "+$" : "-$") + Math.abs(globalUnrealized).toFixed(4);
                document.getElementById('topGlobalUnrealized').className = globalUnrealized >= 0 ? 'val green' : 'val red';
                document.getElementById('globalPnl').innerText = (globalTotal >= 0 ? "+$" : "-$") + Math.abs(globalTotal).toFixed(4);

                if(currentProfileIndex === -1) return;
                const profile = mySubAccounts[currentProfileIndex];
                document.getElementById('profilePnl').innerText = "$" + (profile.realizedPnl || 0).toFixed(4);

                const stateData = allStatuses[profile._id] || { coinStates: {}, logs: [] };
                let html = '';
                myCoins.forEach(coin => {
                    const state = stateData.coinStates[coin.symbol] || { status: 'Stopped', currentPrice: 0, avgEntry: 0, contracts: 0, currentRoi: 0, unrealizedPnl: 0 };
                    let statusColor = state.status === 'Running' ? '#1e8e3e' : '#d93025';
                    html += '<div class="status-box">' +
                        '<div class="flex-row" style="justify-content: space-between; border-bottom: 1px solid #dadce0; padding-bottom: 16px; margin-bottom: 16px;">' +
                            '<div style="font-size: 1.1em; font-weight: 500;">' + coin.symbol + ' - <span style="font-weight:700; color:' + statusColor + ';">' + state.status + '</span></div>' +
                            '<div class="flex-row"><button class="btn-green" onclick="toggleCoinBot(\\'' + coin.symbol + '\\', true)">▶ Start</button><button class="btn-red" onclick="toggleCoinBot(\\'' + coin.symbol + '\\', false)">⏹ Stop</button></div>' +
                        '</div>' +
                        '<div class="flex-row" style="justify-content: space-between;">' +
                            '<div><span class="stat-label">Live Price</span><span class="val">' + (state.currentPrice || 0) + '</span></div>' +
                            '<div><span class="stat-label">Contracts</span><span class="val">' + (state.contracts || 0) + '</span></div>' +
                            '<div><span class="stat-label">Unrealized PNL</span><span class="val ' + (state.unrealizedPnl >= 0 ? 'green' : 'red') + '">' + (state.unrealizedPnl || 0).toFixed(4) + '</span></div>' +
                            '<div><span class="stat-label">ROI %</span><span class="val ' + (state.currentRoi >= 0 ? 'green' : 'red') + '">' + (state.currentRoi || 0).toFixed(2) + '%</span></div>' +
                        '</div>' +
                    '</div>';
                });
                document.getElementById('dashboardStatusContainer').innerHTML = html;
                document.getElementById('logs').innerHTML = (stateData.logs || []).join('<br>');

                // ============================================================
                // 🤖 AI PILOT TELEMETRY RENDERER 
                // ============================================================
                if (document.getElementById('aipilot-tab').style.display !== 'none') {
                    
                    if(currentProfileIndex === -1) {
                        document.getElementById('aiMasterStatus').innerText = "NO PROFILE LOADED ⚠️";
                        document.getElementById('aiWinnersGroupRadar').innerHTML = '<p style="color:#d93025; text-align:center; font-weight:bold;">Please go back to the Dashboard tab and click "Load" on a profile first.</p>';
                        return; 
                    }

                    const aiStatusEl = document.getElementById('aiMasterStatus');
                    if (globalSet.autonomousAiPilot !== false) {
                        aiStatusEl.innerText = "STATUS: ENGAGED & HUNTING 🟢"; aiStatusEl.style.backgroundColor = "#e6f4ea"; aiStatusEl.style.color = "#1e8e3e";
                    } else {
                        aiStatusEl.innerText = "STATUS: OFFLINE (Manual Mode) 🔴"; aiStatusEl.style.backgroundColor = "#fce8e6"; aiStatusEl.style.color = "#d93025";
                    }

                    const aiLogs = (stateData.logs || []).filter(l => l.includes('🤖') || l.includes('AI') || l.includes('Trimmer') || l.includes('CLUSTER'));
                    document.getElementById('aiSpecificLogs').innerHTML = aiLogs.length > 0 ? aiLogs.join('<br>') : "<i>No AI actions recorded yet...</i>";

                    // 🏆 1. RENDER WINNERS GROUP PEAK RADAR 🏆
                    const winnersPeaks = data.winnersPeaks || {};
                    const peakW = winnersPeaks[profile._id] || 0;
                    
                    let winners = []; let losers = [];
                    myCoins.forEach(coin => {
                        const state = stateData.coinStates[coin.symbol];
                        if (state && state.status === 'Running' && state.contracts > 0) {
                            if (state.unrealizedPnl > 0) winners.push({ sym: coin.symbol, pnl: parseFloat(state.unrealizedPnl) });
                            else losers.push({ sym: coin.symbol, pnl: parseFloat(state.unrealizedPnl) });
                        }
                    });

                    let currentWinnersSum = winners.reduce((sum, w) => sum + w.pnl, 0);
                    let totalLosersSum = losers.reduce((sum, l) => sum + l.pnl, 0);

                    let peakDrop = peakW - currentWinnersSum;
                    let groupTrailStatus = "Gathering data...";
                    
                    if (peakW > 0) {
                        let peakTolerance = peakW > 10.0 ? peakW * 0.15 : Math.max(peakW * 0.25, 0.01);
                        let pctToDrop = ((peakDrop / peakTolerance) * 100).toFixed(0);
                        
                        let simNet = currentWinnersSum + totalLosersSum;
                        let clusterSimMsg = "";
                        
                        if (simNet > 0) {
                            clusterSimMsg = '<br><span style="color:#1e8e3e; font-weight:bold;">Cluster Simulation: Winners ($' + currentWinnersSum.toFixed(2) + ') > ALL Losers ($' + Math.abs(totalLosersSum).toFixed(2) + '). Will secure Full Portfolio Net: +$' + simNet.toFixed(2) + '</span>';
                        } else {
                            let tempNet = currentWinnersSum; let simLoserCount = 0;
                            let sortedLosers = [...losers].sort((a,b) => b.pnl - a.pnl);
                            for (let l of sortedLosers) {
                                if (tempNet + l.pnl > 0) { tempNet += l.pnl; simLoserCount++; } else break;
                            }
                            if (simLoserCount > 0) {
                                clusterSimMsg = '<br><span style="color:#f29900; font-weight:bold;">Cluster Simulation: AI will absorb ' + simLoserCount + ' small losers for a Net Profit of +$' + tempNet.toFixed(2) + '.</span>';
                            } else if (currentWinnersSum > 0) {
                                clusterSimMsg = '<br><span style="color:#1a73e8; font-weight:bold;">Group Profit Simulation: Winners cannot absorb any losers. AI will secure Group Profit of +$' + currentWinnersSum.toFixed(2) + '.</span>';
                            } else {
                                clusterSimMsg = '<br><span style="color:#d93025;">Cluster Simulation: Waiting for positive movement.</span>';
                            }
                        }

                        groupTrailStatus = '<span style="color:#1a73e8; font-weight:bold;">Tracking Positive Winners Peak ($' + peakW.toFixed(4) + '). Dynamic Drop Tension: ' + Math.max(0, Math.min(pctToDrop, 100)) + '%.</span> ' + clusterSimMsg;
                    } else {
                        groupTrailStatus = '<span style="color:#5f6368;">Waiting for positions to reach profit to engage Dynamic Cluster Trailing.</span>';
                    }

                    document.getElementById('aiWinnersGroupRadar').innerHTML = 
                        '<div class="flex-row" style="justify-content: space-between; margin-bottom: 12px;">' +
                            '<div style="text-align:center; flex:1;">' +
                                '<span style="font-size: 0.85em; color: #5f6368; text-transform: uppercase;">Sum of Winning Positions</span><br>' +
                                '<span style="font-size: 1.5em; font-weight: bold; color: ' + (currentWinnersSum > 0 ? '#1e8e3e' : '#d93025') + ';">+$' + currentWinnersSum.toFixed(4) + '</span>' +
                            '</div>' +
                            '<div style="text-align:center; flex:1; border-left: 1px solid #dadce0; border-right: 1px solid #dadce0;">' +
                                '<span style="font-size: 0.85em; color: #5f6368; text-transform: uppercase;">Highest Positive Peak</span><br>' +
                                '<span style="font-size: 1.5em; font-weight: bold; color: #1e8e3e;">+$' + peakW.toFixed(4) + '</span>' +
                            '</div>' +
                            '<div style="text-align:center; flex:1;">' +
                                '<span style="font-size: 0.85em; color: #5f6368; text-transform: uppercase;">Drawdown from Peak</span><br>' +
                                '<span style="font-size: 1.5em; font-weight: bold; color: #d93025;">-$' + Math.max(0, peakDrop).toFixed(4) + '</span>' +
                            '</div>' +
                        '</div>' +
                        '<div style="background: #e8f0fe; padding: 12px; border-radius: 6px; text-align: center; font-size: 0.9em;">' + groupTrailStatus + '</div>';

                    // ⚖️ 2. RENDER 1-TO-1 TRIMMER
                    let trimmerHtml = '';
                    if (winners.length > 0 && losers.length > 0) {
                        let wSort = [...winners].sort((a,b) => b.pnl - a.pnl);
                        let lSort = [...losers].sort((a,b) => b.pnl - a.pnl);
                        let net = wSort[0].pnl + lSort[0].pnl;
                        let nC = net > 0 ? '#1e8e3e' : '#5f6368';
                        let nBg = net > 0 ? '#e6f4ea' : '#f1f3f4';
                        let aMsg = net > 0 ? '⚡ <b>AI WILL EXECUTE 1-TO-1 MICRO CUT ON NEXT TICK!</b>' : 'Waiting for winner to cover loser...';
                        trimmerHtml = 
                            '<div style="display:flex; justify-content: space-between; align-items: center;">' +
                                '<div style="text-align:center; padding: 12px; background: #e6f4ea; border-radius: 6px; width: 30%;">' +
                                    '<div style="font-size: 0.8em; color: #1e8e3e;">Top Winner</div><strong>' + wSort[0].sym + '</strong><br>+$' + wSort[0].pnl.toFixed(4) +
                                '</div><div style="font-size: 1.5em; color: #5f6368;">+</div>' +
                                '<div style="text-align:center; padding: 12px; background: #fce8e6; border-radius: 6px; width: 30%;">' +
                                    '<div style="font-size: 0.8em; color: #d93025;">Smallest Loser</div><strong>' + lSort[0].sym + '</strong><br>-$' + Math.abs(lSort[0].pnl).toFixed(4) +
                                '</div><div style="font-size: 1.5em; color: #5f6368;">=</div>' +
                                '<div style="text-align:center; padding: 12px; background: ' + nBg + '; border-radius: 6px; width: 30%;">' +
                                    '<div style="font-size: 0.8em;">Net Result</div><strong style="color: ' + nC + ';">$' + net.toFixed(4) + '</strong>' +
                                '</div>' +
                            '</div>' +
                            '<p style="text-align:center; margin-top:12px; font-size:0.9em; color:#5f6368;">' + aMsg + '</p>';
                    } else { trimmerHtml = '<p style="color:#5f6368;">Waiting for at least 1 profitable coin and 1 losing coin...</p>'; }
                    document.getElementById('aiTrimmerRadar').innerHTML = trimmerHtml;

                    // 📡 3. RENDER COIN MOMENTUM RADAR
                    let aiRadarHtml = '';
                    myCoins.forEach(coin => {
                        const state = stateData.coinStates[coin.symbol];
                        if (!state || state.status !== 'Running' || state.contracts === 0) return;
                        
                        let momentumHtml = '<span style="color:#5f6368;">Gathering data...</span>';
                        if (state.lastPrices && state.lastPrices.length >= 10) {
                            const isStagnant = coin.side === 'long' ? state.lastPrices[9] <= state.lastPrices[0] : state.lastPrices[9] >= state.lastPrices[0];
                            momentumHtml = isStagnant ? '<span style="color:#f29900; font-weight:bold;">Stalled (Dead Momentum)</span>' : '<span style="color:#1e8e3e; font-weight:bold;">Active Momentum</span>';
                        }
                        aiRadarHtml += 
                        '<div class="coin-box" style="border-left: 4px solid #1a73e8; margin-bottom: 12px;">' +
                            '<div class="flex-row" style="justify-content: space-between;"><strong>' + coin.symbol + '</strong><span>ROI: <b class="' + (state.currentRoi >= 0 ? 'green' : 'red') + '">' + state.currentRoi.toFixed(2) + '%</b></span></div>' +
                            '<div style="font-size: 0.9em; margin-top: 8px;">Trend: ' + momentumHtml + '</div>' +
                        '</div>';
                    });
                    document.getElementById('aiCoinRadarContainer').innerHTML = aiRadarHtml || '<p style="color:#5f6368;">No active positions to analyze.</p>';
                }
            }

            checkAuth(); 
        </script>
    </body>
    </html>
    `);
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`🚀 Running locally on http://localhost:${PORT}`));
}
module.exports = app;
