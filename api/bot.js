const express = require('express');
const ccxt = require('ccxt');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs'); 
const jwt = require('jsonwebtoken');
const path = require('path');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_this_in_production';

// 🚨 ORIGINAL HARDCODED DATABASE URL (PASSWORD MASKED FOR YOUR SECURITY)
const MONGO_URI = 'mongodb+srv://web88888888888888_db_user:YOUR_PASSWORD_HERE@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888';

// ==========================================
// 1. MONGODB DATABASE SETUP (Vercel Serverless Safe)
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
            console.log('✅ Connected to MongoDB successfully (Serverless Cached)!');
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
    
    // 🤖 NEW: AUTONOMOUS AI PILOT TOGGLE
    autonomousAiPilot: { type: Boolean, default: true },

    globalTargetPnl: { type: Number, default: 0 },       
    globalTrailingPnl: { type: Number, default: 0 },     
    smartOffsetNetProfit: { type: Number, default: 0 },
    smartOffsetBottomRowV1: { type: Number, default: 5 }, 
    smartOffsetBottomRowV1StopLoss: { type: Number, default: 0 }, 
    smartOffsetStopLoss: { type: Number, default: 0 },
    smartOffsetNetProfit2: { type: Number, default: 0 }, 
    smartOffsetStopLoss2: { type: Number, default: 0 },
    smartOffsetMaxLossPerMinute: { type: Number, default: 0 }, 
    smartOffsetMaxLossTimeframeSeconds: { type: Number, default: 60 },
    minuteCloseAutoDynamic: { type: Boolean, default: false },
    minuteCloseTpMinPnl: { type: Number, default: 0 }, 
    minuteCloseTpMaxPnl: { type: Number, default: 0 },
    minuteCloseSlMinPnl: { type: Number, default: 0 }, 
    minuteCloseSlMaxPnl: { type: Number, default: 0 },
    walletRecoveryEnabled: { type: Boolean, default: false },
    walletRecoveryMultiplier: { type: Number, default: 1.5 },
    walletRecoveryWindowMinutes: { type: Number, default: 5 },
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
global.globalPnlPeaks = global.globalPnlPeaks || new Map(); 
global.lastStopLossExecutions = global.lastStopLossExecutions || new Map(); 
global.rollingStopLosses = global.rollingStopLosses || new Map(); 
global.autoDynamicExecutions = global.autoDynamicExecutions || new Map(); 
global.walletHistory = global.walletHistory || new Map(); 

const activeBots = global.activeBots;
const globalPnlPeaks = global.globalPnlPeaks;
const lastStopLossExecutions = global.lastStopLossExecutions;
const rollingStopLosses = global.rollingStopLosses;
const autoDynamicExecutions = global.autoDynamicExecutions;
const walletHistory = global.walletHistory;

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
        apiKey: subAccount.apiKey, 
        secret: subAccount.secret, 
        options: { defaultType: 'swap' },
        enableRateLimit: true 
    });
    
    const state = { logs: [], coinStates: {} };
    let isProcessing = false;
    let lastError = '';

    const intervalId = setInterval(async () => {
        if (isProcessing) return; 
        isProcessing = true;

        const botData = activeBots.get(profileId);
        if (!botData) {
            isProcessing = false;
            return;
        }
        
        const currentSettings = botData.settings;
        const activeCoins = currentSettings.coins.filter(c => c.botActive);

        if (activeCoins.length === 0) {
            isProcessing = false;
            return; 
        }

        try {
            // Need global settings to check if AI Pilot is ON
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

                    // OPEN BASE POSITION
                    if (!position) {
                        cState.avgEntry = 0; cState.contracts = 0; cState.currentRoi = 0; cState.unrealizedPnl = 0; cState.margin = 0;
                        cState.peakRoi = -9999; cState.valleyRoi = 9999; cState.lastPrices = []; // Reset AI state

                        const safeBaseQty = Math.max(1, Math.floor(currentSettings.baseQty));
                        
                        logForProfile(profileId, `[${coin.symbol}] 🛒 No position. Opening base position of ${safeBaseQty} contracts (${activeSide}).`);
                        cState.lockUntil = Date.now() + 10000; 
                        await exchange.setLeverage(currentSettings.leverage, coin.symbol, { marginMode: 'cross' }).catch(()=>{});
                        const orderSide = activeSide === 'long' ? 'buy' : 'sell';
                        await exchange.createOrder(coin.symbol, 'market', orderSide, safeBaseQty, undefined, { offset: 'open', lever_rate: currentSettings.leverage });
                        continue; 
                    }

                    // UPDATE STATE MATH
                    cState.avgEntry = position.entryPrice;
                    cState.contracts = position.contracts;
                    
                    const contractSize = position.contractSize || 1;
                    let margin = position.initialMargin !== undefined ? position.initialMargin : (cState.avgEntry * cState.contracts * contractSize) / currentSettings.leverage;
                    let unrealizedPnl = position.unrealizedPnl !== undefined ? position.unrealizedPnl : (activeSide === 'long' 
                        ? (cState.currentPrice - cState.avgEntry) * cState.contracts * contractSize 
                        : (cState.avgEntry - cState.currentPrice) * cState.contracts * contractSize);
                    
                    cState.unrealizedPnl = unrealizedPnl;
                    cState.margin = margin;
                    cState.currentRoi = margin > 0 ? (unrealizedPnl / margin) * 100 : 0;

                    // ====================================================
                    // 🤖 AUTONOMOUS AI PILOT (SINGLE COIN MICRO-SCALP)
                    // ====================================================
                    let executeClose = false;
                    let closeReason = '';

                    if (isAutoPilot) {
                        // Maintain price momentum array (last 10 ticks = 60 seconds)
                        if (!cState.lastPrices) cState.lastPrices = [];
                        cState.lastPrices.push(cState.currentPrice);
                        if (cState.lastPrices.length > 10) cState.lastPrices.shift();

                        cState.peakRoi = Math.max(cState.peakRoi || -9999, cState.currentRoi);
                        cState.valleyRoi = Math.min(cState.valleyRoi || 9999, cState.currentRoi);

                        // 1. Dynamic Trailing Take Profit
                        if (cState.peakRoi > 0.5) { // If it hits decent profit
                            let trailingTolerance = cState.peakRoi > 2.0 ? 0.5 : 0.2; // Tighten the leash on smaller pumps
                            if (cState.peakRoi - cState.currentRoi >= trailingTolerance) {
                                executeClose = true;
                                closeReason = `🤖 AI Trailing Profit Secured (Fell from peak ${cState.peakRoi.toFixed(2)}%)`;
                            }
                        } 
                        // 2. Micro-Scalp Time-Decay (Take pennies if stalled)
                        else if (cState.currentRoi > 0.1 && cState.lastPrices.length === 10) {
                            const startP = cState.lastPrices[0];
                            const endP = cState.lastPrices[9];
                            const isStagnant = activeSide === 'long' ? endP <= startP : endP >= startP;
                            if (isStagnant) {
                                executeClose = true;
                                closeReason = `🤖 AI Micro-Scalp (Momentum dead at ${cState.currentRoi.toFixed(2)}%)`;
                            }
                        }
                        // 3. Smart Loss Mitigation (Dead cat bounce)
                        else if (cState.valleyRoi < -8.0 && cState.currentRoi >= -2.0) {
                            executeClose = true;
                            closeReason = `🤖 AI Smart Cut (Bounced back from massive drop, cutting loose)`;
                        }

                        // DCA execution remains unchanged for safety nets
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
                    } 
                    // ====================================================
                    // ⚙️ LEGACY MANUAL SETTINGS (IF AI IS OFF)
                    // ====================================================
                    else {
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

                    // EXECUTE THE CLOSE IF FLAGGED
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
            if (err.message !== lastError) {
                logForProfile(profileId, `❌ Global API Error (Retrying next cycle): ${err.message}`);
                lastError = err.message;
            }
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
// 4. BACKGROUND TASKS
// =========================================================================

const executeWalletTracker = async () => {
    try {
        await connectDB();
        const usersSettings = await Settings.find({});
        
        for (let userSetting of usersSettings) {
            const dbUserId = String(userSetting.userId);
            let totalGlobalStableBalance = 0;
            let fetchedAny = false;

            for (let [profileId, botData] of activeBots.entries()) {
                if (botData.userId !== dbUserId) continue;
                try {
                    const allMethods = Object.keys(botData.exchange);
                    const v3Bal = allMethods.find(m => m.toLowerCase().includes('v3unifiedaccountinfo'));
                    const v1Bal = allMethods.find(m => m.toLowerCase().includes('v1swapcrossaccountinfo'));

                    let totalEquity = 0;
                    let balSuccess = false;

                    try {
                        const bal = await botData.exchange.fetchBalance({ type: 'swap', marginMode: 'cross' });
                        if (bal?.total?.USDT !== undefined) {
                            totalEquity = parseFloat(bal.total.USDT || 0);
                            balSuccess = true;
                        }
                    } catch(e) {}

                    if (!balSuccess && v3Bal) {
                        try {
                            const rawV3 = await botData.exchange[v3Bal]({ trade_partition: 'USDT' });
                            const d = Array.isArray(rawV3?.data) ? rawV3.data.find(x => x.margin_asset === 'USDT') || rawV3.data[0] : rawV3?.data;
                            if (d) {
                                totalEquity = parseFloat(d.margin_balance || d.cross_margin_balance || 0);
                                balSuccess = true;
                            }
                        } catch(e) {}
                    }

                    if (!balSuccess && v1Bal) {
                        try {
                            const rawCross = await botData.exchange[v1Bal]({ margin_account: 'USDT' });
                            if (rawCross?.data?.[0]) {
                                totalEquity = parseFloat(rawCross.data[0].margin_balance || 0);
                                balSuccess = true;
                            }
                        } catch(e) {}
                    }

                    if (!balSuccess) continue; 

                    let totalUnrealizedPnl = 0;
                    try {
                        const ccxtPos = await botData.exchange.fetchPositions(undefined, { marginMode: 'cross' });
                        if (ccxtPos) {
                            ccxtPos.forEach(p => { totalUnrealizedPnl += parseFloat(p.unrealizedPnl || 0); });
                        }
                    } catch(e) {}

                    const staticWalletBalance = totalEquity - totalUnrealizedPnl;

                    if (!isNaN(staticWalletBalance)) {
                        totalGlobalStableBalance += staticWalletBalance;
                        fetchedAny = true;
                    }
                } catch (err) {}
            }

            if (fetchedAny) {
                let history = walletHistory.get(dbUserId) || [];
                const now = Date.now();
                history.push({ time: now, balance: totalGlobalStableBalance });
                history = history.filter(h => now - h.time <= 60 * 60 * 1000);
                walletHistory.set(dbUserId, history);
            }
        }
    } catch (err) {
        console.error("Wallet Tracker Error:", err);
    }
};

const executeOneMinuteCloser = async () => {
    // Left empty/disabled. Autonomous AI pilot handles 1-min tracking intrinsically now.
};

const executeGlobalProfitMonitor = async () => {
    if (global.isGlobalMonitoring) return;
    global.isGlobalMonitoring = true;

    try {
        await connectDB(); 
        const usersSettings = await Settings.find({});
        
        for (let userSetting of usersSettings) {
            const dbUserId = String(userSetting.userId);
            const isAutoPilot = userSetting.autonomousAiPilot !== false; 
            
            let globalUnrealized = 0;
            let activeCandidates = [];
            let firstProfileId = null; 

            for (let [profileId, botData] of activeBots.entries()) {
                if (botData.userId !== dbUserId) continue;
                if (!firstProfileId) firstProfileId = profileId;
                
                for (let symbol in botData.state.coinStates) {
                    const cState = botData.state.coinStates[symbol];
                    if (cState.status === 'Running' && cState.contracts > 0 && (!cState.lockUntil || Date.now() >= cState.lockUntil)) {
                        const pnl = parseFloat(cState.unrealizedPnl) || 0;
                        globalUnrealized += pnl;
                        
                        const activeSide = botData.settings.coins.find(c => c.symbol === symbol)?.side || botData.settings.side;
                        activeCandidates.push({
                            profileId, symbol, exchange: botData.exchange, unrealizedPnl: pnl,
                            contracts: cState.contracts, side: activeSide, leverage: botData.settings.leverage, subAccount: botData.settings
                        });
                    }
                }
            }

            if (!firstProfileId || activeCandidates.length === 0) continue;

            // ====================================================
            // 🤖 AUTONOMOUS AI PILOT (GLOBAL FAT-TRIMMER)
            // ====================================================
            if (isAutoPilot) {
                let winners = activeCandidates.filter(c => c.unrealizedPnl > 0).sort((a,b) => b.unrealizedPnl - a.unrealizedPnl);
                let losers = activeCandidates.filter(c => c.unrealizedPnl < 0).sort((a,b) => b.unrealizedPnl - a.unrealizedPnl);

                let aiExecutedOffset = false;

                for (let w of winners) {
                    if (w.markedForClose) continue;
                    for (let l of losers) {
                        if (l.markedForClose) continue;
                        
                        let netResult = w.unrealizedPnl + l.unrealizedPnl;
                        
                        // 🤖 AI RULE: If pairing a winner and a loser yields ANY profit over $0.02, chop them instantly.
                        if (netResult >= 0.02) {
                            w.markedForClose = true;
                            l.markedForClose = true;
                            aiExecutedOffset = true;

                            logForProfile(firstProfileId, `🤖 AI Auto-Trimmer: Absorbed Loser [${l.symbol}] using Winner [${w.symbol}]. Secured Net Profit: +$${netResult.toFixed(4)}`);
                            
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
                
                if (aiExecutedOffset) continue;
            }

            // ====================================================
            // ⚙️ LEGACY SMART OFFSETS (RUNS ONLY IF AI IS OFF)
            // ====================================================
            if (!isAutoPilot) {
                const baseSmartOffsetNetProfit = parseFloat(userSetting.smartOffsetNetProfit) || 0;
                let dynamicSmartOffsetNetProfit = baseSmartOffsetNetProfit;

                if (userSetting.walletRecoveryEnabled) {
                    const history = walletHistory.get(dbUserId) || [];
                    const windowMs = (parseInt(userSetting.walletRecoveryWindowMinutes) || 5) * 60 * 1000;
                    const recentHistory = history.filter(h => Date.now() - h.time <= windowMs);
                    if (recentHistory.length > 0) {
                        const maxBalance = Math.max(...recentHistory.map(h => h.balance));
                        const currentBalance = recentHistory[recentHistory.length - 1].balance;
                        if (maxBalance > currentBalance) {
                            dynamicSmartOffsetNetProfit = (maxBalance - currentBalance) * (parseFloat(userSetting.walletRecoveryMultiplier) || 1.5);
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
        console.log("🛠 Bootstrapping Background Loops for Vercel...");
        
        setInterval(executeOneMinuteCloser, 60000);
        setInterval(executeWalletTracker, 60000); 
        setInterval(executeGlobalProfitMonitor, 6000);

        try {
            await connectDB();
            const activeSettings = await Settings.find({});
            activeSettings.forEach(s => {
                if (s.subAccounts) {
                    s.subAccounts.forEach(sub => { if (sub.coins && sub.coins.some(c => c.botActive)) startBot(s.userId.toString(), sub); });
                }
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
    await connectDB(); 
    bootstrapBots(); 
    res.status(200).json({ success: true, message: 'Bot is awake', timestamp: new Date().toISOString() });
});

app.post('/api/register', async (req, res) => {
    await connectDB();
    try {
        const { username, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await User.create({ username, password: hashedPassword });
        await Settings.create({ 
            userId: user._id, subAccounts: [], globalTargetPnl: 0, globalTrailingPnl: 0, autonomousAiPilot: true,
            smartOffsetNetProfit: 0, smartOffsetBottomRowV1: 5, smartOffsetBottomRowV1StopLoss: 0, smartOffsetStopLoss: 0, 
            smartOffsetNetProfit2: 0, smartOffsetStopLoss2: 0, smartOffsetMaxLossPerMinute: 0, smartOffsetMaxLossTimeframeSeconds: 60, 
            minuteCloseAutoDynamic: false, minuteCloseTpMinPnl: 0, minuteCloseTpMaxPnl: 0, minuteCloseSlMinPnl: 0, minuteCloseSlMaxPnl: 0,
            walletRecoveryEnabled: false, walletRecoveryMultiplier: 1.5, walletRecoveryWindowMinutes: 5 
        });
        res.json({ success: true, message: 'Registration successful!' });
    } catch (err) {
        res.status(400).json({ error: 'Username already exists or invalid data.' });
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
    bootstrapBots();
    const { subAccounts, autonomousAiPilot, globalTargetPnl, globalTrailingPnl, smartOffsetNetProfit, smartOffsetBottomRowV1, smartOffsetBottomRowV1StopLoss, smartOffsetStopLoss, smartOffsetNetProfit2, smartOffsetStopLoss2, smartOffsetMaxLossPerMinute, smartOffsetMaxLossTimeframeSeconds, minuteCloseAutoDynamic, minuteCloseTpMinPnl, minuteCloseTpMaxPnl, minuteCloseSlMinPnl, minuteCloseSlMaxPnl, walletRecoveryEnabled, walletRecoveryMultiplier, walletRecoveryWindowMinutes } = req.body;
    
    const existingSettings = await Settings.findOne({ userId: req.userId });
    if (existingSettings && existingSettings.subAccounts) {
        subAccounts.forEach(sub => {
            sub.realizedPnl = 0; 
            if (sub._id) {
                const existingSub = existingSettings.subAccounts.find(s => s._id.toString() === sub._id.toString());
                if (existingSub) sub.realizedPnl = existingSub.realizedPnl || 0;
            }
        });
    }

    subAccounts.forEach(sub => {
        if (sub.triggerRoiPct > 0) sub.triggerRoiPct = -sub.triggerRoiPct;
        if (sub.dcaTargetRoiPct > 0) sub.dcaTargetRoiPct = -sub.dcaTargetRoiPct;
        if (sub.stopLossPct > 0) sub.stopLossPct = -sub.stopLossPct;
    });

    const updated = await Settings.findOneAndUpdate(
        { userId: req.userId }, 
        { 
            subAccounts, 
            autonomousAiPilot: autonomousAiPilot === true,
            globalTargetPnl: parseFloat(globalTargetPnl) || 0, 
            globalTrailingPnl: parseFloat(globalTrailingPnl) || 0,
            smartOffsetNetProfit: parseFloat(smartOffsetNetProfit) || 0,
            smartOffsetBottomRowV1: parseInt(smartOffsetBottomRowV1) || 5,
            smartOffsetBottomRowV1StopLoss: parseFloat(smartOffsetBottomRowV1StopLoss) || 0,
            smartOffsetStopLoss: parseFloat(smartOffsetStopLoss) || 0,
            smartOffsetNetProfit2: parseFloat(smartOffsetNetProfit2) || 0,
            smartOffsetStopLoss2: parseFloat(smartOffsetStopLoss2) || 0,
            smartOffsetMaxLossPerMinute: parseFloat(smartOffsetMaxLossPerMinute) || 0,
            smartOffsetMaxLossTimeframeSeconds: parseInt(smartOffsetMaxLossTimeframeSeconds) || 60,
            minuteCloseAutoDynamic: minuteCloseAutoDynamic === true,
            minuteCloseTpMinPnl: Math.abs(parseFloat(minuteCloseTpMinPnl) || 0),
            minuteCloseTpMaxPnl: Math.abs(parseFloat(minuteCloseTpMaxPnl) || 0),
            minuteCloseSlMinPnl: -Math.abs(parseFloat(minuteCloseSlMinPnl) || 0),
            minuteCloseSlMaxPnl: -Math.abs(parseFloat(minuteCloseSlMaxPnl) || 0),
            walletRecoveryEnabled: walletRecoveryEnabled === true,
            walletRecoveryMultiplier: parseFloat(walletRecoveryMultiplier) || 1.5,
            walletRecoveryWindowMinutes: parseInt(walletRecoveryWindowMinutes) || 5
        }, 
        { returnDocument: 'after' }
    );

    const activeSubIds = [];
    if (updated.subAccounts) {
        updated.subAccounts.forEach(sub => {
            const profileId = sub._id.toString();
            activeSubIds.push(profileId);
            if (sub.coins && sub.coins.some(c => c.botActive)) {
                if (activeBots.has(profileId)) activeBots.get(profileId).settings = sub;
                else startBot(req.userId.toString(), sub);
            } else {
                stopBot(profileId);
            }
        });
    }

    for (let [profileId, botData] of activeBots.entries()) {
        if (botData.userId === req.userId.toString() && !activeSubIds.includes(profileId)) stopBot(profileId);
    }

    res.json({ success: true, settings: updated });
});

app.get('/api/status', authMiddleware, async (req, res) => {
    bootstrapBots(); 
    const settings = await Settings.findOne({ userId: req.userId });
    const userStatuses = {};
    for (let [profileId, botData] of activeBots.entries()) {
        if (botData.userId === req.userId.toString()) userStatuses[profileId] = botData.state;
    }

    const dbUserId = req.userId.toString();
    
    // Stop Loss tracking
    let currentMinuteLoss = 0;
    const timeframeSec = settings ? (settings.smartOffsetMaxLossTimeframeSeconds || 60) : 60;
    if (rollingStopLosses.has(dbUserId)) {
        let arr = rollingStopLosses.get(dbUserId).filter(r => Date.now() - r.time < (timeframeSec * 1000));
        currentMinuteLoss = arr.reduce((sum, r) => sum + r.amount, 0);
        rollingStopLosses.set(dbUserId, arr); 
    }

    const autoDynExec = global.autoDynamicExecutions ? global.autoDynamicExecutions.get(dbUserId) : null;

    // Wallet Recovery Data (Peak Tracking and Strict Target Calculation)
    let walletData = { balance: 0, peak: 0, loss: 0, recoveryTarget: 0, isRecovering: false };
    if (settings && settings.walletRecoveryEnabled) {
        const history = walletHistory.get(dbUserId) || [];
        const windowMs = (settings.walletRecoveryWindowMinutes || 5) * 60 * 1000;
        const recentHistory = history.filter(h => Date.now() - h.time <= windowMs);
        
        if (recentHistory.length > 0) {
            walletData.balance = recentHistory[recentHistory.length - 1].balance;
            const maxBalance = Math.max(...recentHistory.map(h => h.balance));
            walletData.peak = maxBalance; 
            
            if (maxBalance > walletData.balance) {
                walletData.loss = maxBalance - walletData.balance;
                walletData.recoveryTarget = walletData.loss * (settings.walletRecoveryMultiplier || 1.5);
                walletData.isRecovering = true; // Always true if there is a loss, overriding base target
            }
        }
    } else {
        const history = walletHistory.get(dbUserId) || [];
        if (history.length > 0) {
            walletData.balance = history[history.length - 1].balance;
            walletData.peak = Math.max(...history.map(h => h.balance));
        }
    }

    res.json({ 
        states: userStatuses, 
        subAccounts: settings ? settings.subAccounts : [], 
        globalSettings: settings, 
        currentMinuteLoss, 
        autoDynExec,
        walletData 
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
            
            /* AI GLOW EFFECT */
            .ai-glow {
                box-shadow: 0 0 15px rgba(26, 115, 232, 0.4);
                border: 2px solid #1a73e8;
                background: #f0f4fc;
            }
        </style>
    </head>
    <body>

        <!-- AUTHENTICATION VIEW -->
        <div id="auth-view" class="panel">
            <h2 style="border:none; color:#1a73e8; font-size:1.8em; margin-bottom:20px;">Bot Login</h2>
            <div style="text-align: left;">
                <label>Username</label>
                <input type="text" id="username" placeholder="Enter username">
                <label>Password</label>
                <input type="password" id="password" placeholder="Enter password">
            </div>
            <div class="flex-row" style="margin-top: 24px;">
                <button class="btn-blue" style="margin:0; flex:1;" onclick="auth('login')">Login</button>
                <button class="btn-logout" style="margin:0; flex:1; padding: 12px 16px;" onclick="auth('register')">Register</button>
            </div>
            <p id="auth-msg"></p>
        </div>

        <!-- DASHBOARD VIEW -->
        <div id="dashboard-view" class="container">
            <!-- ========================== NEW AI MENU HEADER ========================== -->
            <div class="header">
                <h1>HTX Trading Bot</h1>
                <div style="display:flex; gap:12px;">
                    <button class="btn-blue" style="margin:0; width:auto; padding: 8px 16px;" onclick="switchTab('main')">⚙️ Dashboard</button>
                    <!-- NEW AI PILOT BUTTON -->
                    <button class="btn-blue ai-glow" style="margin:0; width:auto; padding: 8px 16px;" onclick="switchTab('aipilot')">🤖 AI Pilot Live</button>
                    <button class="btn-logout" style="margin:0; width:auto;" onclick="switchTab('offsets')">History</button>
                    <button class="btn-logout" style="margin:0; width:auto;" onclick="logout()">Logout</button>
                </div>
            </div>

            <!-- SMART OFFSETS HISTORY TAB -->
            <div id="offset-tab" style="display:none;">
                <div class="panel">
                    <h2 style="color: #1e8e3e;">Executed Smart Offsets & AI Auto-Trims History</h2>
                    <div id="offsetTableContainer" style="margin-top: 20px;">Loading historical offset data...</div>
                </div>
            </div>

            <!-- ========================== NEW AI PILOT LIVE VIEW TAB ========================== -->
            <div id="aipilot-tab" style="display:none;">
                <div class="panel ai-glow" style="border: 1px solid #1a73e8;">
                    <div class="flex-row" style="justify-content: space-between;">
                        <h2 style="color: #1a73e8; border: none; margin: 0;">🤖 AI Pilot Telemetry & Live Radar</h2>
                        <div id="aiMasterStatus" style="font-weight: bold; padding: 8px 16px; border-radius: 4px;">Loading...</div>
                    </div>
                    <p style="color: #5f6368; font-size: 0.9em;">Visualizing the AI's internal thought process, momentum tracking, and dynamic trimming logic.</p>

                    <!-- FAT TRIMMER RADAR -->
                    <h3 style="color: #202124;">⚖️ AI Auto-Trimmer Radar (Looking for offset pairs...)</h3>
                    <div id="aiTrimmerRadar" style="background: #f8f9fa; padding: 16px; border-radius: 6px; border: 1px dashed #ccc; margin-bottom: 24px;">
                        Waiting for data...
                    </div>

                    <!-- COIN MICRO-SCALP RADAR -->
                    <h3 style="color: #202124;">📡 Micro-Scalp & Momentum Radar</h3>
                    <div id="aiCoinRadarContainer">
                        <!-- Injected by JS -->
                    </div>

                    <!-- AI SPECIFIC LOGS -->
                    <h3 style="color: #202124;">⚡ Live AI Action Feed</h3>
                    <div class="log-box" id="aiSpecificLogs" style="height: 200px; border-color: #1a73e8; color: #64b5f6;">
                        Waiting for AI events...
                    </div>
                </div>
            </div>

            <!-- MAIN DASHBOARD TAB -->
            <div id="main-tab">
                <!-- GLOBAL STATS BANNER -->
                <div class="status-box" style="background:#fff3e0; border-color:#ffe0b2; margin-bottom: 24px;">
                    <div class="flex-row" style="justify-content: space-between;">
                        <div><span class="stat-label">Realized Stable Balance</span><span class="val" id="topGlobalWallet" style="color:#202124;">$0.0000</span></div>
                        <div><span class="stat-label">Tracked Wallet Peak</span><span class="val" id="topWalletPeak" style="color:#1a73e8;">$0.0000</span></div>
                        <div><span class="stat-label">Recovery Target (Loss &times; Multiplier)</span><span class="val" id="topWalletRecovery" style="color:#f29900;">Disabled</span></div>
                        <div><span class="stat-label">Global Unrealized PNL ($)</span><span class="val" id="topGlobalUnrealized">0.0000000000</span></div>
                    </div>
                </div>

                <div class="flex-container">
                    <!-- SETTINGS PANEL -->
                    <div class="panel flex-1">
                        
                        <!-- 🤖 AI PILOT MODULE -->
                        <div class="ai-glow" style="padding: 16px; border-radius: 8px; margin-bottom: 24px;">
                            <h2 style="margin:0 0 8px 0; color:#1a73e8; border:none; display:flex; align-items:center;">
                                🤖 AUTONOMOUS AI PILOT
                                <input type="checkbox" id="autonomousAiPilot" style="width:auto; margin-left:16px; transform: scale(1.5);">
                            </h2>
                            <p style="font-size:0.85em; color:#5f6368; line-height:1.4; margin-top:4px;">
                                <strong>When Enabled:</strong> The bot entirely ignores your manual Take Profit, Stop Loss, and Smart Offset numbers below.<br><br>
                                1. It dynamically trails peak profits.<br>
                                2. It scalps micro-profits if momentum dies.<br>
                                3. It automatically pairs big winners to absorb small losers for guaranteed net profit clearing.
                            </p>
                            <button class="btn-blue" style="margin-top:12px; background:#1a73e8;" onclick="saveGlobalSettings()">Update AI Mode</button>
                        </div>

                        <h2>Legacy Manual Settings (Disabled if AI is ON)</h2>
                        <div style="background: #fafafa; padding: 12px; border-radius: 6px; margin-bottom: 16px; border: 1px solid #dadce0; opacity: 0.7;">
                            
                            <div class="flex-row">
                                <div style="flex:1;">
                                    <label style="margin-top:0;">Portfolio Target Profit To Close ALL ($)</label>
                                    <input type="number" step="0.1" id="globalTargetPnl" placeholder="e.g. 15.00">
                                </div>
                                <div style="flex:1;">
                                    <label style="margin-top:0;">Trailing Drop from Peak ($)</label>
                                    <input type="number" step="0.1" id="globalTrailingPnl" placeholder="e.g. 2.00">
                                </div>
                            </div>
                            
                            <div style="margin-top: 12px;">
                                <label style="margin-top:0;">Manual Offset Net Profit Base Target V1 ($)</label>
                                <input type="number" step="0.1" id="smartOffsetNetProfit" placeholder="e.g. 1.00">
                            </div>

                            <button class="btn-logout" style="margin-top:16px; width:100%;" onclick="saveGlobalSettings()">Save Legacy Settings</button>
                        </div>

                        <h2>Profile Setup</h2>
                        <div style="background: #f8f9fa; padding: 12px; border-radius: 6px; margin-bottom: 16px; border: 1px solid #dadce0;">
                            <div class="flex-row" style="justify-content: space-between; margin-bottom: 8px;">
                                <h4 style="margin: 0; color: #5f6368;">Switch Sub-Account API Keys</h4>
                                <label style="margin: 0; display: flex; align-items: center; cursor: pointer; text-transform: none; font-size: 0.85em; color: #5f6368;"><input type="checkbox" style="width: auto; margin: 0 6px 0 0;" onchange="toggleNewKeys(this)"> Show Keys</label>
                            </div>
                            <div class="flex-row" style="margin-bottom: 8px;">
                                <select id="subAccountSelect" style="margin:0; flex:3;"><option value="">-- Create a Profile --</option></select>
                                <button class="btn-blue" style="margin:0; flex:1; padding: 12px;" onclick="loadSubAccount()">Load</button>
                                <button class="btn-red" style="margin:0; flex:1; padding: 12px;" onclick="removeSubAccount()">Delete</button>
                            </div>
                            <div class="flex-row">
                                <input type="text" id="newSubName" placeholder="Profile Name" style="margin:0; flex:2;">
                                <input type="password" id="newSubKey" placeholder="API Key" style="margin:0; flex:2;">
                                <input type="password" id="newSubSecret" placeholder="Secret Key" style="margin:0; flex:2;">
                                <button class="btn-green" style="margin:0; flex:1; padding: 12px;" onclick="addSubAccount()">Save New</button>
                            </div>
                        </div>

                        <div id="settingsContainer" style="display:none;">
                            <div class="flex-row" style="justify-content: space-between; margin-top: 16px; margin-bottom: 8px;">
                                <label style="margin: 0;">Active Profile API Keys</label>
                                <label style="margin: 0; display: flex; align-items: center; cursor: pointer; text-transform: none; font-size: 0.85em; color: #5f6368;"><input type="checkbox" id="showActiveKeysCheckbox" style="width: auto; margin: 0 6px 0 0;" onchange="toggleActiveKeys(this)"> Show Keys</label>
                            </div>
                            <input type="password" id="apiKey" placeholder="HTX API Key" style="margin-top: 0;">
                            <input type="password" id="secret" placeholder="HTX Secret Key" style="margin-top: 8px;">

                            <div class="flex-row" style="margin-top: 16px; margin-bottom: 16px;">
                                <button class="btn-green" style="flex:1;" onclick="globalToggleBot(true)">▶ Start Bot for Active Profile</button>
                                <button class="btn-red" style="flex:1;" onclick="globalToggleBot(false)">⏹ Stop Bot for Active Profile</button>
                            </div>

                            <div class="flex-row">
                                <div style="flex:1"><label>Default Side</label><select id="side"><option value="long">Long</option><option value="short">Short</option></select></div>
                                <div style="flex:1"><label>Leverage (x)</label><input type="number" id="leverage"></div>
                            </div>
                            
                            <label>Initial Base Contracts Qty</label>
                            <input type="number" id="baseQty">

                            <h3>DCA Math Logic</h3>
                            <div class="flex-row">
                                <div style="flex:1"><label>Trigger DCA (%)</label><input type="number" step="0.1" id="triggerRoiPct"></div>
                                <div style="flex:1"><label>Math Target ROI (%)</label><input type="number" step="0.1" id="dcaTargetRoiPct"></div>
                            </div>
                            <div class="flex-row">
                                <div style="flex:1"><label>Max Safety Contracts</label><input type="number" id="maxContracts"></div>
                            </div>

                            <h3 style="margin-top:30px;">Coins Configuration</h3>
                            <div style="background: #e8f0fe; padding: 16px; border-radius: 6px; margin-bottom: 20px;">
                                <h4 style="margin-top: 0; color: #1a73e8; margin-bottom: 12px;">Bulk Add Predefined Coins</h4>
                                <div class="flex-row" style="margin-bottom: 12px;">
                                    <div style="flex:1;"><label style="margin-top:0;">Initial Status</label><select id="predefStatus"><option value="stopped">Leave All Stopped</option><option value="started">Start All Coins</option></select></div>
                                    <div style="flex:1;"><label style="margin-top:0;">Trading Side</label><select id="predefSide"><option value="oddLong">Odd=Long / Even=Short</option><option value="evenLong">Even=Long / Odd=Short</option><option value="allLong">All Long</option><option value="allShort">All Short</option></select></div>
                                </div>
                                <button class="btn-blue" style="margin-top: 0;" onclick="addPredefinedList()">+ Add All Predefined</button>
                            </div>

                            <h4 style="margin-top: 0; color: #5f6368; margin-bottom: 8px;">Or Add Single Coin Manually:</h4>
                            <div class="flex-row" style="margin-bottom: 12px;">
                                <input type="text" id="newCoinSymbol" placeholder="Coin Pair (e.g. DOGE/USDT:USDT)" style="margin:0; flex:2;">
                                <button class="btn-green" style="flex:1;" onclick="addCoinUI()">+ Add Single</button>
                            </div>

                            <div id="coinsListContainer"></div>
                            <button class="btn-blue" onclick="saveSettings()">Save Profile Settings</button>
                        </div>
                    </div>

                    <!-- DASHBOARD PANEL -->
                    <div class="panel flex-1" style="flex: 1.5;">
                        <h2>Live Profile Dashboard</h2>
                        <div class="status-box" style="background:#e8f0fe; border-color:#d2e3fc;">
                            <div class="flex-row" style="justify-content: space-between;">
                                <div><span class="stat-label">Global Realized PNL</span><span class="val" id="globalPnl">0.00</span></div>
                                <div><span class="stat-label">Current Profile PNL</span><span class="val" id="profilePnl">0.00</span></div>
                            </div>
                        </div>
                        
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
            let myAutonomousAiPilot = true;
            let myGlobalTargetPnl = 0;
            let myGlobalTrailingPnl = 0;
            let mySmartOffsetNetProfit = 0;
            let mySmartOffsetBottomRowV1 = 5;
            let mySmartOffsetBottomRowV1StopLoss = 0; 
            let mySmartOffsetStopLoss = 0;
            let mySmartOffsetNetProfit2 = 0;
            let mySmartOffsetStopLoss2 = 0;
            let mySmartOffsetMaxLossPerMinute = 0;
            let mySmartOffsetMaxLossTimeframeSeconds = 60;
            let myMinuteCloseAutoDynamic = false;
            let myMinuteCloseTpMinPnl = 0;
            let myMinuteCloseTpMaxPnl = 0;
            let myMinuteCloseSlMinPnl = 0;
            let myMinuteCloseSlMaxPnl = 0;
            
            let myWalletRecoveryEnabled = false;
            let myWalletRecoveryMultiplier = 1.5;
            let myWalletRecoveryWindowMinutes = 5;

            let currentProfileIndex = -1;
            let myCoins = [];
            
            const PREDEFINED_COINS = ["TON", "AXS", "APT", "FIL", "ETHFI", "BERA", "MASK", "TIA", "DASH", "GIGGLE", "BSV", "OP", "TAO", "SSV", "YFI"];

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

            // ========================== UPDATED SWITCH TAB ==========================
            function switchTab(tab) {
                document.getElementById('main-tab').style.display = 'none';
                document.getElementById('offset-tab').style.display = 'none';
                document.getElementById('aipilot-tab').style.display = 'none';

                if (tab === 'main') {
                    document.getElementById('main-tab').style.display = 'block';
                } else if (tab === 'offsets') {
                    document.getElementById('offset-tab').style.display = 'block';
                    loadOffsets();
                } else if (tab === 'aipilot') {
                    document.getElementById('aipilot-tab').style.display = 'block';
                }
            }

            async function auth(action) {
                const username = document.getElementById('username').value;
                const password = document.getElementById('password').value;
                document.getElementById('auth-msg').innerText = "Processing...";
                
                const res = await fetch('/api/' + action, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();
                
                if (data.token) {
                    token = data.token;
                    localStorage.setItem('token', token);
                    document.getElementById('auth-msg').innerText = "";
                    checkAuth();
                } else {
                    document.getElementById('auth-msg').innerText = data.error || data.message;
                }
            }

            function logout() { localStorage.removeItem('token'); token = null; checkAuth(); }
            function toggleNewKeys(cb) { const type = cb.checked ? 'text' : 'password'; document.getElementById('newSubKey').type = type; document.getElementById('newSubSecret').type = type; }
            function toggleActiveKeys(cb) { const type = cb.checked ? 'text' : 'password'; document.getElementById('apiKey').type = type; document.getElementById('secret').type = type; }

            async function fetchSettings() {
                const res = await fetch('/api/settings', { headers: { 'Authorization': 'Bearer ' + token } });
                if (res.status === 401 || res.status === 403) return logout();
                const config = await res.json();
                
                myAutonomousAiPilot = config.autonomousAiPilot !== false;
                document.getElementById('autonomousAiPilot').checked = myAutonomousAiPilot;

                myGlobalTargetPnl = config.globalTargetPnl || 0;
                myGlobalTrailingPnl = config.globalTrailingPnl || 0;
                mySmartOffsetNetProfit = config.smartOffsetNetProfit || 0;
                
                document.getElementById('globalTargetPnl').value = myGlobalTargetPnl;
                document.getElementById('globalTrailingPnl').value = myGlobalTrailingPnl;
                document.getElementById('smartOffsetNetProfit').value = mySmartOffsetNetProfit;
                
                mySubAccounts = config.subAccounts || [];
                renderSubAccounts();
                
                if (mySubAccounts.length > 0) {
                    document.getElementById('subAccountSelect').value = 0;
                    loadSubAccount();
                } else {
                    currentProfileIndex = -1;
                    document.getElementById('settingsContainer').style.display = 'none';
                }
            }

            async function saveGlobalSettings() {
                myAutonomousAiPilot = document.getElementById('autonomousAiPilot').checked;
                myGlobalTargetPnl = parseFloat(document.getElementById('globalTargetPnl').value) || 0;
                myGlobalTrailingPnl = parseFloat(document.getElementById('globalTrailingPnl').value) || 0;
                mySmartOffsetNetProfit = parseFloat(document.getElementById('smartOffsetNetProfit').value) || 0;
                
                const data = { 
                    subAccounts: mySubAccounts, 
                    autonomousAiPilot: myAutonomousAiPilot,
                    globalTargetPnl: myGlobalTargetPnl, 
                    globalTrailingPnl: myGlobalTrailingPnl, 
                    smartOffsetNetProfit: mySmartOffsetNetProfit 
                };

                await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(data) });
                alert('Global Settings Updated!');
            }

            function renderSubAccounts() {
                const select = document.getElementById('subAccountSelect');
                select.innerHTML = '';
                if(mySubAccounts.length === 0) select.innerHTML = '<option value="">-- Create a Profile --</option>';
                else mySubAccounts.forEach((sub, i) => select.innerHTML += \`<option value="\${i}">\${sub.name}</option>\`);
            }

            async function addSubAccount() {
                const name = document.getElementById('newSubName').value.trim();
                const key = document.getElementById('newSubKey').value.trim();
                const secret = document.getElementById('newSubSecret').value.trim();
                if(!name || !key || !secret) return alert("Fill all 3 fields!");
                
                mySubAccounts.push({ name, apiKey: key, secret: secret, side: 'long', leverage: 10, baseQty: 1, triggerRoiPct: -15.0, dcaTargetRoiPct: -2.0, maxContracts: 1000, realizedPnl: 0, coins: [] });
                
                const data = { subAccounts: mySubAccounts };
                const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(data) });
                const json = await res.json();
                mySubAccounts = json.settings.subAccounts || [];
                
                document.getElementById('newSubName').value = ''; document.getElementById('newSubKey').value = ''; document.getElementById('newSubSecret').value = '';
                renderSubAccounts();
                document.getElementById('subAccountSelect').value = mySubAccounts.length - 1;
                loadSubAccount();
            }

            function loadSubAccount() {
                const select = document.getElementById('subAccountSelect');
                const index = parseInt(select.value);
                if(!isNaN(index) && index >= 0) {
                    currentProfileIndex = index;
                    const profile = mySubAccounts[index];
                    
                    document.getElementById('settingsContainer').style.display = 'block';
                    document.getElementById('apiKey').value = profile.apiKey || '';
                    document.getElementById('secret').value = profile.secret || '';
                    
                    const cb = document.getElementById('showActiveKeysCheckbox');
                    if(cb) { cb.checked = false; toggleActiveKeys(cb); }

                    document.getElementById('side').value = profile.side || 'long';
                    document.getElementById('leverage').value = profile.leverage || 10;
                    document.getElementById('baseQty').value = profile.baseQty || 1;
                    document.getElementById('triggerRoiPct').value = profile.triggerRoiPct || -15.0;
                    document.getElementById('dcaTargetRoiPct').value = profile.dcaTargetRoiPct || -2.0;
                    document.getElementById('maxContracts').value = profile.maxContracts || 1000;
                    
                    myCoins = profile.coins || [];
                    renderCoinsSettings();
                }
            }

            async function removeSubAccount() {
                const select = document.getElementById('subAccountSelect');
                const index = parseInt(select.value);
                if(!isNaN(index) && index >= 0) {
                    mySubAccounts.splice(index, 1);
                    const data = { subAccounts: mySubAccounts };
                    const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(data) });
                    const json = await res.json();
                    mySubAccounts = json.settings.subAccounts || [];
                    
                    renderSubAccounts();
                    if(mySubAccounts.length > 0) { document.getElementById('subAccountSelect').value = 0; loadSubAccount(); } 
                    else { currentProfileIndex = -1; document.getElementById('settingsContainer').style.display = 'none'; myCoins = []; document.getElementById('dashboardStatusContainer').innerHTML = '<p>No profile loaded.</p>'; document.getElementById('logs').innerHTML = ''; }
                }
            }

            async function globalToggleBot(active) {
                if(currentProfileIndex === -1) return alert("Please load a profile first!");
                if(myCoins.length === 0) return alert("Please add coins first!");
                myCoins.forEach(c => c.botActive = active);
                await saveSettings(false); 
            }

            function addPredefinedList() {
                if(currentProfileIndex === -1) return alert("Please load a profile first!");
                const sideMode = document.getElementById('predefSide').value;
                const startMode = document.getElementById('predefStatus').value === 'started';

                PREDEFINED_COINS.forEach((base, index) => {
                    const symbol = base + '/USDT:USDT';
                    if(myCoins.some(c => c.symbol === symbol)) return; 

                    let coinSide = 'long';
                    if (sideMode === 'allShort') coinSide = 'short';
                    else if (sideMode === 'oddLong') coinSide = (index % 2 === 0) ? 'long' : 'short'; 
                    else if (sideMode === 'evenLong') coinSide = (index % 2 === 0) ? 'short' : 'long'; 

                    myCoins.push({ symbol: symbol, side: coinSide, botActive: startMode });
                });
                renderCoinsSettings();
            }

            function addCoinUI() {
                if(currentProfileIndex === -1) return alert("Please load a profile first!");
                const symbol = document.getElementById('newCoinSymbol').value.toUpperCase().trim();
                const masterSide = document.getElementById('side').value; 
                if(!symbol) return alert("Enter a coin pair first!");
                if(myCoins.some(c => c.symbol === symbol)) return alert("Coin already exists!");

                myCoins.push({ symbol: symbol, side: masterSide, botActive: false });
                document.getElementById('newCoinSymbol').value = '';
                renderCoinsSettings();
            }

            function removeCoinUI(index) { myCoins.splice(index, 1); renderCoinsSettings(); }

            function renderCoinsSettings() {
                const container = document.getElementById('coinsListContainer');
                container.innerHTML = '';
                myCoins.forEach((coin, i) => {
                    const box = document.createElement('div');
                    box.className = 'coin-box flex-row';
                    box.style.justifyContent = 'space-between';
                    const displaySide = coin.side || document.getElementById('side').value;
                    const sideColor = displaySide === 'long' ? '#1e8e3e' : '#d93025';

                    box.innerHTML = \`<span style="font-weight: bold; color: #1a73e8; font-size: 1.1em;">\${coin.symbol} <span style="font-size: 0.75em; color: \${sideColor}; text-transform: uppercase;">(\${displaySide})</span></span><button class="btn-red" style="padding: 6px 12px; font-size: 0.8em; margin: 0; width: auto;" onclick="removeCoinUI(\${i})">Remove</button>\`;
                    container.appendChild(box);
                });
            }

            async function saveSettings(silent = false) {
                if(currentProfileIndex === -1) return alert("Please load a profile first!");

                const profile = mySubAccounts[currentProfileIndex];
                profile.apiKey = document.getElementById('apiKey').value;
                profile.secret = document.getElementById('secret').value;
                profile.side = document.getElementById('side').value;
                profile.leverage = parseInt(document.getElementById('leverage').value);
                profile.baseQty = parseInt(document.getElementById('baseQty').value);
                profile.triggerRoiPct = parseFloat(document.getElementById('triggerRoiPct').value);
                profile.dcaTargetRoiPct = parseFloat(document.getElementById('dcaTargetRoiPct').value);
                profile.maxContracts = parseInt(document.getElementById('maxContracts').value);
                profile.coins = myCoins;

                const data = { subAccounts: mySubAccounts };
                const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(data) });
                const json = await res.json();
                mySubAccounts = json.settings.subAccounts || [];
                
                if (!silent) alert('Profile Settings & Coins Saved Successfully!');
            }

            async function toggleCoinBot(symbol, active) {
                const coin = myCoins.find(c => c.symbol === symbol);
                if(coin) coin.botActive = active;
                await saveSettings(true); 
            }

            async function loadOffsets() {
                const res = await fetch('/api/offsets', { headers: { 'Authorization': 'Bearer ' + token } });
                if (!res.ok) return;
                const records = await res.json();
                
                if (records.length === 0) {
                    const noData = '<p style="color:#5f6368;">No smart offsets executed yet.</p>';
                    document.getElementById('offsetTableContainer').innerHTML = noData;
                    return;
                }

                let ih = '<table style="width:100%; text-align:left; border-collapse:collapse; background:#fff; border-radius:6px; overflow:hidden;">';
                ih += '<tr style="background:#f8f9fa;"><th style="padding:12px; border-bottom:2px solid #dadce0;">Date/Time</th><th style="padding:12px; border-bottom:2px solid #dadce0;">Action/Winner</th><th style="padding:12px; border-bottom:2px solid #dadce0;">Winner PNL</th><th style="padding:12px; border-bottom:2px solid #dadce0;">Absorbed Loser</th><th style="padding:12px; border-bottom:2px solid #dadce0;">Loser PNL</th><th style="padding:12px; border-bottom:2px solid #dadce0;">Net Profit</th></tr>';
                
                records.forEach(r => {
                    const dateObj = new Date(r.timestamp);
                    const wColor = r.winnerPnl >= 0 ? '#1e8e3e' : '#d93025';
                    const lColor = r.loserPnl >= 0 ? '#1e8e3e' : '#d93025';
                    const nColor = r.netProfit >= 0 ? '#1e8e3e' : '#d93025';

                    ih += \`<tr>
                        <td style="padding:12px; border-bottom:1px solid #eee; color:#5f6368;">\${dateObj.toLocaleDateString()} \${dateObj.toLocaleTimeString()}</td>
                        <td style="padding:12px; border-bottom:1px solid #eee; color:#1a73e8; font-weight:500;">\${r.winnerSymbol}</td>
                        <td style="padding:12px; border-bottom:1px solid #eee; color:\${wColor}; font-weight:500;">\${r.winnerPnl >= 0 ? '+' : ''}$\${r.winnerPnl.toFixed(4)}</td>
                        <td style="padding:12px; border-bottom:1px solid #eee; color:#1a73e8; font-weight:500;">\${r.loserSymbol}</td>
                        <td style="padding:12px; border-bottom:1px solid #eee; color:\${lColor}; font-weight:500;">\${r.loserPnl >= 0 ? '+' : ''}$\${r.loserPnl.toFixed(4)}</td>
                        <td style="padding:12px; border-bottom:1px solid #eee; color:\${nColor}; font-weight:700;">\${r.netProfit >= 0 ? '+' : ''}$\${r.netProfit.toFixed(4)}</td>
                    </tr>\`;
                });
                ih += '</table>';
                document.getElementById('offsetTableContainer').innerHTML = ih;
            }

            async function loadStatus() {
                const res = await fetch('/api/status', { headers: { 'Authorization': 'Bearer ' + token } });
                if (res.status === 401 || res.status === 403) return logout();
                
                const data = await res.json();
                const allStatuses = data.states || {};
                const subAccountsUpdated = data.subAccounts || [];
                const globalSet = data.globalSettings || {};
                const walletData = data.walletData || { balance: 0, peak: 0, loss: 0, recoveryTarget: 0, isRecovering: false };

                let globalTotal = 0;
                subAccountsUpdated.forEach(sub => {
                    globalTotal += (sub.realizedPnl || 0);
                    const localSub = mySubAccounts.find(s => s._id === sub._id);
                    if(localSub) localSub.realizedPnl = sub.realizedPnl;
                });

                let globalUnrealized = 0;
                let totalTrading = 0;
                let totalAboveZero = 0;

                for (let pid in allStatuses) {
                    const st = allStatuses[pid];
                    if (st && st.coinStates) {
                        for (let sym in st.coinStates) {
                            const cs = st.coinStates[sym];
                            if (cs.status === 'Running' && cs.contracts > 0 && (!cs.lockUntil || Date.now() >= cs.lockUntil)) {
                                totalTrading++;
                                const pnlNum = parseFloat(cs.unrealizedPnl) || 0;
                                if (cs.currentRoi > 0) totalAboveZero++;
                                globalUnrealized += pnlNum;
                            }
                        }
                    }
                }

                // Update Wallet Banner (Explicit Formulas)
                document.getElementById('topGlobalWallet').innerText = '$' + walletData.balance.toFixed(4);
                document.getElementById('topWalletPeak').innerText = '$' + walletData.peak.toFixed(4);
                
                const recEl = document.getElementById('topWalletRecovery');
                if (globalSet.walletRecoveryEnabled) {
                    if (walletData.loss > 0) {
                        const multi = globalSet.walletRecoveryMultiplier || 1.5;
                        recEl.innerHTML = '<span style="color:#d93025;">$ ' + walletData.loss.toFixed(4) + '</span> &times; ' + multi + ' = <span style="color:#1e8e3e; font-weight:bold;">$ ' + walletData.recoveryTarget.toFixed(4) + '</span>';
                    } else {
                        recEl.innerHTML = '<span style="color:#1e8e3e; font-weight:bold;">No Loss Detected</span>';
                    }
                } else {
                    recEl.innerText = "Disabled";
                    recEl.style.color = "#5f6368";
                }
                
                const topPnlEl = document.getElementById('topGlobalUnrealized');
                topPnlEl.innerText = (globalUnrealized >= 0 ? "+$" : "-$") + Math.abs(globalUnrealized).toFixed(4);
                topPnlEl.className = globalUnrealized >= 0 ? 'val green' : 'val red';

                if(currentProfileIndex === -1) return;

                const globalPnlEl = document.getElementById('globalPnl');
                globalPnlEl.innerText = (globalTotal >= 0 ? "+$" : "-$") + Math.abs(globalTotal).toFixed(4);
                globalPnlEl.className = globalTotal >= 0 ? 'val green' : 'val red';

                const profile = mySubAccounts[currentProfileIndex];
                const profilePnlEl = document.getElementById('profilePnl');
                const pPnl = profile.realizedPnl || 0;
                profilePnlEl.innerText = (pPnl >= 0 ? "+$" : "-$") + Math.abs(pPnl).toFixed(4);
                profilePnlEl.className = pPnl >= 0 ? 'val green' : 'val red';

                const stateData = allStatuses[profile._id] || { coinStates: {}, logs: [] };
                const statusContainer = document.getElementById('dashboardStatusContainer');
                
                if(!myCoins || myCoins.length === 0) {
                    statusContainer.innerHTML = '<p style="color:#5f6368;">No coins added to this profile.</p>';
                } else {
                    let html = '';
                    myCoins.forEach(coin => {
                        const state = stateData.coinStates && stateData.coinStates[coin.symbol] ? stateData.coinStates[coin.symbol] : { status: 'Stopped', currentPrice: 0, avgEntry: 0, contracts: 0, currentRoi: 0, unrealizedPnl: 0, peakRoi: 0 };
                        let statusColor = state.status === 'Running' ? '#1e8e3e' : '#d93025';
                        let roiColorClass = state.currentRoi >= 0 ? 'val green' : 'val red';
                        const displaySide = coin.side || profile.side || 'long';

                        if (state.lockUntil && Date.now() < state.lockUntil) {
                            statusColor = '#f29900';
                            state.status = 'Closing / Locked';
                        }

                        let peakString = state.peakRoi > -9000 ? '(Peak: ' + state.peakRoi.toFixed(2) + '%)' : '';

                        html += \`
                        <div class="status-box">
                            <div class="flex-row" style="justify-content: space-between; border-bottom: 1px solid #dadce0; padding-bottom: 16px; margin-bottom: 16px;">
                                <div style="font-size: 1.1em; font-weight: 500;">
                                    \${coin.symbol} <span style="font-size: 0.8em; color: #5f6368;">(\${displaySide.toUpperCase()})</span> - Status: <span style="font-weight:700; color:\${statusColor};">\${state.status}</span>
                                </div>
                                <div class="flex-row">
                                    <button class="btn-green" onclick="toggleCoinBot('\${coin.symbol}', true)" style="padding: 8px 16px;">▶ Start</button>
                                    <button class="btn-red" onclick="toggleCoinBot('\${coin.symbol}', false)" style="padding: 8px 16px;">⏹ Stop</button>
                                </div>
                            </div>
                            
                            <div class="flex-row" style="justify-content: space-between;">
                                <div><span class="stat-label">Live Price</span><span class="val">\${state.currentPrice || 0}</span></div>
                                <div><span class="stat-label">Avg Entry</span><span class="val">\${state.avgEntry || 0}</span></div>
                                <div><span class="stat-label">Contracts</span><span class="val">\${state.contracts || 0}</span></div>
                                <div><span class="stat-label">Unrealized PNL</span><span class="\${roiColorClass}">\${(state.unrealizedPnl || 0).toFixed(4)}</span></div>
                                <div><span class="stat-label">ROI % \` + peakString + \`</span><span class="\${roiColorClass}">\${(state.currentRoi || 0).toFixed(2)}%</span></div>
                            </div>
                        </div>\`;
                    });
                    statusContainer.innerHTML = html;
                }

                document.getElementById('logs').innerHTML = (stateData.logs || []).join('<br>');

                // ============================================================
                // 🤖 NEW AI PILOT TELEMETRY RENDERER (INJECTED)
                // ============================================================
                if (document.getElementById('aipilot-tab').style.display !== 'none') {
                    const aiStatusEl = document.getElementById('aiMasterStatus');
                    if (globalSet.autonomousAiPilot !== false) {
                        aiStatusEl.innerText = "STATUS: ENGAGED & HUNTING 🟢";
                        aiStatusEl.style.backgroundColor = "#e6f4ea";
                        aiStatusEl.style.color = "#1e8e3e";
                    } else {
                        aiStatusEl.innerText = "STATUS: OFFLINE (Manual Mode) 🔴";
                        aiStatusEl.style.backgroundColor = "#fce8e6";
                        aiStatusEl.style.color = "#d93025";
                    }

                    const aiLogs = (stateData.logs || []).filter(l => l.includes('🤖') || l.includes('AI') || l.includes('Trimmer'));
                    document.getElementById('aiSpecificLogs').innerHTML = aiLogs.length > 0 ? aiLogs.join('<br>') : "<i>No AI actions recorded yet in this session. Tracking the market...</i>";

                    let aiRadarHtml = '';
                    let winners = [];
                    let losers = [];

                    myCoins.forEach(coin => {
                        const state = stateData.coinStates && stateData.coinStates[coin.symbol] ? stateData.coinStates[coin.symbol] : null;
                        if (!state || state.status !== 'Running' || state.contracts === 0) return;

                        if (state.unrealizedPnl > 0) winners.push({ sym: coin.symbol, pnl: state.unrealizedPnl });
                        else losers.push({ sym: coin.symbol, pnl: state.unrealizedPnl });

                        let momentumHtml = '<span style="color:#5f6368;">Gathering data...</span>';
                        if (state.lastPrices && state.lastPrices.length >= 10) {
                            const startP = state.lastPrices[0];
                            const endP = state.lastPrices[state.lastPrices.length - 1];
                            const isLong = (coin.side || profile.side) === 'long';
                            const isStagnant = isLong ? endP <= startP : endP >= startP;
                            
                            if (isStagnant) momentumHtml = \`<span style="color:#f29900; font-weight:bold;">Stalled (Dead Momentum) - AI preparing to cut if ROI > 0.1%</span>\`;
                            else momentumHtml = \`<span style="color:#1e8e3e; font-weight:bold;">Active Momentum (Riding the wave)</span>\`;
                        }

                        let trailingHtml = '';
                        if (state.peakRoi > 0.5) {
                            let limit = state.peakRoi > 2.0 ? 0.5 : 0.2;
                            let currentDrop = state.peakRoi - state.currentRoi;
                            let percentToDrop = ((currentDrop / limit) * 100).toFixed(0);
                            trailingHtml = \`<br><span style="color:#1a73e8; font-size:0.9em;">🎯 Trailing Profit Active: Peak <b>\${state.peakRoi.toFixed(2)}%</b>. Leash tension: <b>\${percentToDrop}%</b> to auto-close.</span>\`;
                        } else if (state.valleyRoi < -8.0 && state.currentRoi >= -2.0) {
                            trailingHtml = \`<br><span style="color:#d93025; font-size:0.9em;">🛡️ Smart Cut Active: Survived massive drop (\${state.valleyRoi.toFixed(2)}%). Will cut loose on next bounce.</span>\`;
                        }

                        aiRadarHtml += \`
                        <div class="coin-box" style="border-left: 4px solid #1a73e8; margin-bottom: 12px;">
                            <div class="flex-row" style="justify-content: space-between;">
                                <strong>\${coin.symbol}</strong>
                                <span>Current ROI: <b class="\${state.currentRoi >= 0 ? 'green' : 'red'}">\${state.currentRoi.toFixed(2)}%</b></span>
                            </div>
                            <div style="font-size: 0.9em; margin-top: 8px;">
                                Trend: \${momentumHtml} \${trailingHtml}
                            </div>
                        </div>\`;
                    });

                    document.getElementById('aiCoinRadarContainer').innerHTML = aiRadarHtml || '<p style="color:#5f6368;">No active positions to analyze.</p>';

                    let trimmerHtml = '';
                    if (winners.length > 0 && losers.length > 0) {
                        winners.sort((a,b) => b.pnl - a.pnl);
                        losers.sort((a,b) => b.pnl - a.pnl);

                        let bestWinner = winners[0];
                        let bestLoser = losers[0];
                        let net = bestWinner.pnl + bestLoser.pnl;
                        
                        let netColor = net >= 0.02 ? '#1e8e3e' : '#5f6368';
                        let netBg = net >= 0.02 ? '#e6f4ea' : '#f1f3f4';
                        let actionMsg = net >= 0.02 ? '⚡ <b>AI WILL EXECUTE THIS CUT ON NEXT TICK!</b> (Net > $0.02)' : 'AI is waiting. Needs $' + (0.02 - net).toFixed(4) + ' more profit from the winner to absorb this loser.';

                        trimmerHtml = \`
                            <div style="display:flex; justify-content: space-between; align-items: center;">
                                <div style="text-align:center; padding: 12px; background: #e6f4ea; border-radius: 6px; width: 30%;">
                                    <div style="font-size: 0.8em; color: #1e8e3e;">Top Winner</div>
                                    <strong>\${bestWinner.sym}</strong><br>+$\${bestWinner.pnl.toFixed(4)}
                                </div>
                                <div style="font-size: 1.5em; color: #5f6368;">+</div>
                                <div style="text-align:center; padding: 12px; background: #fce8e6; border-radius: 6px; width: 30%;">
                                    <div style="font-size: 0.8em; color: #d93025;">Smallest Loser</div>
                                    <strong>\${bestLoser.sym}</strong><br>-$\${Math.abs(bestLoser.pnl).toFixed(4)}
                                </div>
                                <div style="font-size: 1.5em; color: #5f6368;">=</div>
                                <div style="text-align:center; padding: 12px; background: \${netBg}; border-radius: 6px; width: 30%;">
                                    <div style="font-size: 0.8em;">Net Result</div>
                                    <strong style="color: \${netColor};">$\${net.toFixed(4)}</strong>
                                </div>
                            </div>
                            <p style="text-align:center; margin-top:12px; font-size:0.9em; color:#5f6368;">\${actionMsg}</p>
                        \`;
                    } else {
                        trimmerHtml = '<p style="color:#5f6368; margin:0;">Waiting for at least 1 profitable coin and 1 losing coin to calculate pair offsets...</p>';
                    }
                    
                    document.getElementById('aiTrimmerRadar').innerHTML = trimmerHtml;
                }
            }

            checkAuth(); 
        </script>
    </body>
    </html>
    `);
});

// VERCEL EXPORT
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`🚀 Running locally on http://localhost:${PORT}`));
}
module.exports = app;
