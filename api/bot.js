const express = require('express');
const ccxt = require('ccxt');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs'); 
const jwt = require('jsonwebtoken');
const path = require('path');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_this_in_production';

// ORIGINAL HARDCODED DATABASE URL
const MONGO_URI = 'mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888';

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
    minuteCloseMinPnl: { type: Number, default: 0 },
    minuteCloseMaxPnl: { type: Number, default: 0 },
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
// 3. MULTI-PROFILE BOT ENGINE STATE (Vercel Cached)
// ==========================================
// Attach states to global so Vercel doesn't wipe them on hot-reloads
global.activeBots = global.activeBots || new Map();
global.globalPnlPeaks = global.globalPnlPeaks || new Map(); 
global.lastStopLossExecutions = global.lastStopLossExecutions || new Map(); 
global.rollingStopLosses = global.rollingStopLosses || new Map(); 

const activeBots = global.activeBots;
const globalPnlPeaks = global.globalPnlPeaks;
const lastStopLossExecutions = global.lastStopLossExecutions;
const rollingStopLosses = global.rollingStopLosses;

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
            const symbolsToFetch = activeCoins.map(c => c.symbol);
            const [allTickers, allPositions] = await Promise.all([
                exchange.fetchTickers(symbolsToFetch).catch(e => { throw new Error('Tickers: ' + e.message); }),
                exchange.fetchPositions(symbolsToFetch).catch(e => { throw new Error('Positions: ' + e.message); })
            ]);

            for (let coin of activeCoins) {
                try {
                    if (!state.coinStates[coin.symbol]) {
                        state.coinStates[coin.symbol] = { status: 'Running', currentPrice: 0, avgEntry: 0, contracts: 0, currentRoi: 0, unrealizedPnl: 0, margin: 0, lastDcaTime: 0, lockUntil: 0 };
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
                        const safeBaseQty = Math.max(1, Math.floor(currentSettings.baseQty));
                        
                        logForProfile(profileId, `[${coin.symbol}] 🛒 No position. Opening base position of ${safeBaseQty} contracts (${activeSide}).`);
                        cState.lockUntil = Date.now() + 8000; 
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

                    // TP / SL
                    const isTakeProfit = cState.currentRoi >= currentSettings.takeProfitPct;
                    const isStopLoss = cState.currentRoi <= currentSettings.stopLossPct;

                    if (isTakeProfit || isStopLoss) {
                        const reason = isTakeProfit ? '🎯 Take Profit' : '🛑 Stop Loss';
                        logForProfile(profileId, `[${coin.symbol}] ${reason} hit! (${cState.currentRoi.toFixed(2)}%). Closing ${cState.contracts} contracts.`);
                        
                        const contractsToClose = cState.contracts;
                        cState.lockUntil = Date.now() + 8000;
                        cState.contracts = 0; cState.unrealizedPnl = 0; cState.currentRoi = 0;

                        const orderSide = activeSide === 'long' ? 'sell' : 'buy';
                        await exchange.createOrder(coin.symbol, 'market', orderSide, contractsToClose, undefined, { offset: 'close', reduceOnly: true, lever_rate: currentSettings.leverage }).catch(()=>{});

                        currentSettings.realizedPnl = (currentSettings.realizedPnl || 0) + unrealizedPnl;
                        Settings.updateOne({ "subAccounts._id": currentSettings._id }, { $set: { "subAccounts.$.realizedPnl": currentSettings.realizedPnl } }).catch(()=>{});
                        continue; 
                    }

                    // DCA TRIGGER
                    if (cState.currentRoi <= currentSettings.triggerRoiPct && (Date.now() - cState.lastDcaTime > 10000)) {
                        const reqQty = calculateDcaQty(activeSide, cState.avgEntry, cState.currentPrice, cState.contracts, currentSettings.leverage, currentSettings.dcaTargetRoiPct);

                        if (reqQty <= 0) {
                            cState.lastDcaTime = Date.now();
                        } else if ((cState.contracts + reqQty) > currentSettings.maxContracts) {
                            logForProfile(profileId, `[${coin.symbol}] 🛡️ DCA Safety Triggered. Max contracts reached.`);
                            cState.lastDcaTime = Date.now(); 
                        } else {
                            logForProfile(profileId, `[${coin.symbol}] ⚡ Executing DCA: Buying ${reqQty} contracts at ~${cState.currentPrice}`);
                            cState.lockUntil = Date.now() + 8000; 
                            const orderSide = activeSide === 'long' ? 'buy' : 'sell';
                            await exchange.createOrder(coin.symbol, 'market', orderSide, reqQty, undefined, { offset: 'open', lever_rate: currentSettings.leverage }).catch(()=>{});
                            cState.lastDcaTime = Date.now(); 
                        }
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
    }, 3000);

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
// 4. BACKGROUND TASKS (Protected Singleton for Vercel)
// =========================================================================
const executeOneMinuteCloser = async () => {
    try {
        await connectDB();
        const usersSettings = await Settings.find({});
        for (let userSetting of usersSettings) {
            const dbUserId = String(userSetting.userId);
            let rawMin = parseFloat(userSetting.minuteCloseMinPnl) || 0;
            let rawMax = parseFloat(userSetting.minuteCloseMaxPnl) || 0;
            const autoDynamic = userSetting.minuteCloseAutoDynamic || false;
            
            let activeCandidates = [];
            for (let [profileId, botData] of activeBots.entries()) {
                if (botData.userId !== dbUserId) continue;
                for (let symbol in botData.state.coinStates) {
                    const cState = botData.state.coinStates[symbol];
                    if (cState.status === 'Running' && cState.contracts > 0 && (!cState.lockUntil || Date.now() >= cState.lockUntil)) {
                        activeCandidates.push({
                            profileId, symbol, exchange: botData.exchange,
                            pnl: parseFloat(cState.unrealizedPnl) || 0,
                            contracts: cState.contracts,
                            subAccount: botData.settings,
                            cState: cState
                        });
                    }
                }
            }

            if (autoDynamic && activeCandidates.length >= 2) {
                activeCandidates.sort((a, b) => b.pnl - a.pnl);
                const totalCoins = activeCandidates.length;
                const totalPairs = Math.floor(totalCoins / 2);
                let runningAccumulation = 0;
                let peakAccumulation = 0;
                let peakRowIndex = -1;

                for (let i = 0; i < totalPairs; i++) {
                    const netResult = activeCandidates[i].pnl + activeCandidates[totalCoins - totalPairs + i].pnl;
                    runningAccumulation += netResult;
                    if (runningAccumulation > peakAccumulation) {
                        peakAccumulation = runningAccumulation;
                        peakRowIndex = i;
                    }
                }

                if (peakRowIndex >= 0 && peakRowIndex + 1 < totalPairs) {
                    rawMax = activeCandidates[peakRowIndex].pnl;
                    rawMin = activeCandidates[peakRowIndex + 1].pnl;
                } else {
                    rawMin = 0; rawMax = 0;
                }

                if (rawMin === rawMax) {
                    rawMax = 0.0006;
                    rawMin = 0.0004;
                }
            }

            if (!autoDynamic && rawMin === 0 && rawMax === 0) continue;
            if (autoDynamic && rawMin === 0 && rawMax === 0) continue; 

            const actualMin = Math.min(rawMin, rawMax);
            const actualMax = Math.max(rawMin, rawMax);

            for (let pos of activeCandidates) {
                if (pos.pnl >= actualMin && pos.pnl <= actualMax) {
                    logForProfile(pos.profileId, `[${pos.symbol}] ⏳ 1-Min Range Closer: PNL $${pos.pnl.toFixed(4)} is in boundary. Closing position.`);
                    
                    pos.cState.lockUntil = Date.now() + 8000;
                    const contractsToClose = pos.contracts;
                    pos.cState.contracts = 0;
                    pos.cState.unrealizedPnl = 0;
                    pos.cState.currentRoi = 0;

                    const activeSide = pos.subAccount.coins.find(c => c.symbol === pos.symbol)?.side || pos.subAccount.side;
                    const orderSide = activeSide === 'long' ? 'sell' : 'buy';
                    
                    pos.exchange.createOrder(pos.symbol, 'market', orderSide, contractsToClose, undefined, { offset: 'close', reduceOnly: true, lever_rate: pos.subAccount.leverage }).catch(()=>{});

                    pos.subAccount.realizedPnl = (pos.subAccount.realizedPnl || 0) + pos.pnl;
                    Settings.updateOne({ "subAccounts._id": pos.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": pos.subAccount.realizedPnl } }).catch(()=>{});
                }
            }
        }
    } catch (err) {
        console.error("1-Min Range Closer Error:", err);
    }
};

const executeGlobalProfitMonitor = async () => {
    if (global.isGlobalMonitoring) return;
    global.isGlobalMonitoring = true;

    try {
        await connectDB(); 
        const usersSettings = await Settings.find({});
        
        for (let userSetting of usersSettings) {
            const dbUserId = String(userSetting.userId);
            
            const globalTargetPnl = parseFloat(userSetting.globalTargetPnl) || 0;
            const globalTrailingPnl = parseFloat(userSetting.globalTrailingPnl) || 0;
            const smartOffsetNetProfit = parseFloat(userSetting.smartOffsetNetProfit) || 0;
            const smartOffsetBottomRowV1 = parseInt(userSetting.smartOffsetBottomRowV1) || 5;
            const smartOffsetBottomRowV1StopLoss = parseFloat(userSetting.smartOffsetBottomRowV1StopLoss) || 0; 
            const smartOffsetStopLoss = parseFloat(userSetting.smartOffsetStopLoss) || 0;
            const smartOffsetNetProfit2 = parseFloat(userSetting.smartOffsetNetProfit2) || 0;
            const smartOffsetStopLoss2 = parseFloat(userSetting.smartOffsetStopLoss2) || 0;
            
            const smartOffsetMaxLossPerMinute = parseFloat(userSetting.smartOffsetMaxLossPerMinute) || 0;
            const smartOffsetMaxLossTimeframeSeconds = parseInt(userSetting.smartOffsetMaxLossTimeframeSeconds) || 60;
            const timeframeMs = smartOffsetMaxLossTimeframeSeconds * 1000;
            
            let globalUnrealized = 0;
            let activeCandidates = [];
            let firstProfileId = null; 

            let rollingLossArr = rollingStopLosses.get(dbUserId) || [];
            rollingLossArr = rollingLossArr.filter(record => Date.now() - record.time < timeframeMs);
            rollingStopLosses.set(dbUserId, rollingLossArr);
            let currentMinuteLoss = rollingLossArr.reduce((sum, record) => sum + record.amount, 0);

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

            const totalCoinsTrading = activeCandidates.length;
            const targetV1 = smartOffsetNetProfit > 0 ? smartOffsetNetProfit : 0;
            const stopLossV1 = smartOffsetStopLoss < 0 ? smartOffsetStopLoss : 0;
            const stopLossNth = smartOffsetBottomRowV1StopLoss < 0 ? smartOffsetBottomRowV1StopLoss : 0; 
            const targetV2 = smartOffsetNetProfit2 > 0 ? smartOffsetNetProfit2 : 0;
            const stopLossV2 = smartOffsetStopLoss2 < 0 ? smartOffsetStopLoss2 : 0;

            let offsetExecuted = false;

            // SMART OFFSET V1
            if ((smartOffsetNetProfit > 0 || smartOffsetStopLoss < 0 || smartOffsetBottomRowV1StopLoss < 0) && activeCandidates.length >= 2) {
                activeCandidates.sort((a, b) => b.unrealizedPnl - a.unrealizedPnl); 
                
                const totalCoins = activeCandidates.length;
                const totalPairs = Math.floor(totalCoins / 2);

                let runningAccumulation = 0;
                let peakAccumulation = 0;
                let peakRowIndex = -1;
                let nthBottomAccumulation = 0;

                const targetRefIndex = Math.max(0, totalPairs - smartOffsetBottomRowV1);

                for (let i = 0; i < totalPairs; i++) {
                    const w = activeCandidates[i];
                    const l = activeCandidates[totalCoins - totalPairs + i];
                    const netResult = w.unrealizedPnl + l.unrealizedPnl;
                    
                    runningAccumulation += netResult;

                    if (runningAccumulation > peakAccumulation) {
                        peakAccumulation = runningAccumulation;
                        peakRowIndex = i;
                    }
                    if (i === targetRefIndex) nthBottomAccumulation = runningAccumulation;
                }

                let triggerOffset = false;
                let reason = '';
                let finalPairsToClose = [];
                let finalNetProfit = 0;

                if (smartOffsetNetProfit > 0 && peakAccumulation >= targetV1 && peakAccumulation > 0 && peakRowIndex >= 0) {
                    triggerOffset = true;
                    reason = `TAKE PROFIT (Harvested Peak at Row ${peakRowIndex + 1}, Target: $${targetV1.toFixed(4)})`;
                    finalNetProfit = peakAccumulation;
                    for(let i = 0; i <= peakRowIndex; i++) {
                        finalPairsToClose.push(activeCandidates[i]);
                        finalPairsToClose.push(activeCandidates[totalCoins - totalPairs + i]);
                    }
                } 
                else if ((stopLossNth < 0 && nthBottomAccumulation <= stopLossNth) || (stopLossV1 < 0 && runningAccumulation <= stopLossV1)) {
                    let allowSl = false;
                    let projectedLoss = runningAccumulation;

                    if (smartOffsetMaxLossPerMinute > 0) {
                        if (currentMinuteLoss + Math.abs(projectedLoss) <= smartOffsetMaxLossPerMinute) allowSl = true;
                    } else {
                        if (Date.now() - (lastStopLossExecutions.get(dbUserId) || 0) >= timeframeMs) allowSl = true;
                    }

                    if (allowSl) {
                        triggerOffset = true;
                        if (stopLossNth < 0 && nthBottomAccumulation <= stopLossNth) {
                            reason = `STOP LOSS (Nth Row [${smartOffsetBottomRowV1}] hit limit: $${stopLossNth.toFixed(4)})`;
                        } else {
                            reason = `STOP LOSS (Full Group limit hit: $${stopLossV1.toFixed(4)})`;
                        }

                        finalNetProfit = runningAccumulation; 
                        if(smartOffsetMaxLossPerMinute <= 0) lastStopLossExecutions.set(dbUserId, Date.now());

                        for(let i = 0; i < totalPairs; i++) {
                            finalPairsToClose.push(activeCandidates[i]);
                            finalPairsToClose.push(activeCandidates[totalCoins - totalPairs + i]);
                        }
                    }
                }

                if (triggerOffset) {
                    logForProfile(firstProfileId, `⚖️ SMART OFFSET V1 [${reason}]: Closing ${finalPairsToClose.length} coins total. NET PROFIT: ${finalNetProfit >= 0 ? '+' : ''}$${finalNetProfit.toFixed(4)}`);
                    
                    let totalWinnerPnl = 0;
                    let totalLoserPnl = 0;

                    for (let k = 0; k < finalPairsToClose.length; k++) {
                        const pos = finalPairsToClose[k];
                        const bState = activeBots.get(pos.profileId).state.coinStates[pos.symbol];
                        
                        if (bState) { bState.lockUntil = Date.now() + 8000; bState.contracts = 0; }
                        if (k % 2 === 0) totalWinnerPnl += pos.unrealizedPnl;
                        else totalLoserPnl += pos.unrealizedPnl;

                        try {
                            const orderSide = pos.side === 'long' ? 'sell' : 'buy';
                            await pos.exchange.createOrder(pos.symbol, 'market', orderSide, pos.contracts, undefined, { offset: 'close', reduceOnly: true, lever_rate: pos.leverage }).catch(()=>{});
                            pos.subAccount.realizedPnl = (pos.subAccount.realizedPnl || 0) + pos.unrealizedPnl;
                            await Settings.updateOne({ "subAccounts._id": pos.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": pos.subAccount.realizedPnl } }).catch(()=>{});
                        } catch (e) {}
                    }

                    OffsetRecord.create({
                        userId: dbUserId, winnerSymbol: `Peak of ${finalPairsToClose.length/2} Winners`, winnerPnl: totalWinnerPnl,
                        loserSymbol: `Peak of ${finalPairsToClose.length/2} Losers`, loserPnl: totalLoserPnl, netProfit: finalNetProfit
                    }).catch(()=>{});

                    offsetExecuted = true;
                    if (finalNetProfit < 0 && smartOffsetMaxLossPerMinute > 0) {
                        currentMinuteLoss += Math.abs(finalNetProfit);
                        rollingLossArr.push({ time: Date.now(), amount: Math.abs(finalNetProfit) });
                    }
                    break;
                }
            }

            // SMART OFFSET V2
            if (!offsetExecuted && (smartOffsetNetProfit2 > 0 || smartOffsetStopLoss2 < 0) && activeCandidates.length >= 2) {
                let offsetExecuted2 = false;
                const totalCoins = activeCandidates.length;
                const totalPairs = Math.floor(totalCoins / 2);

                for (let i = 0; i < totalPairs; i++) {
                    const winnerIndex = i; 
                    const loserIndex = totalCoins - 1 - i; 

                    const biggestWinner = activeCandidates[winnerIndex];
                    const biggestLoser = activeCandidates[loserIndex];
                    const netResult = biggestWinner.unrealizedPnl + biggestLoser.unrealizedPnl;
                    
                    let triggerOffset = false;
                    let reason = '';

                    if (smartOffsetNetProfit2 > 0 && netResult >= targetV2) {
                        triggerOffset = true; reason = `TAKE PROFIT V2 (Target: $${targetV2.toFixed(4)})`;
                    } else if (smartOffsetStopLoss2 < 0 && netResult <= stopLossV2) {
                        if (smartOffsetMaxLossPerMinute > 0) {
                            if (currentMinuteLoss + Math.abs(netResult) <= smartOffsetMaxLossPerMinute) {
                                triggerOffset = true; reason = `STOP LOSS V2 (Target: $${stopLossV2.toFixed(4)})`;
                            }
                        } else {
                            if (Date.now() - (lastStopLossExecutions.get(dbUserId) || 0) >= timeframeMs) {
                                triggerOffset = true; reason = `STOP LOSS V2 (Target: $${stopLossV2.toFixed(4)})`;
                                lastStopLossExecutions.set(dbUserId, Date.now());
                            }
                        }
                    }
                    
                    if (triggerOffset) {
                        logForProfile(firstProfileId, `⚖️ SMART OFFSET V2 [${reason}]: Paired Rank ${winnerIndex + 1} & ${loserIndex + 1} - Closing Winner [${biggestWinner.symbol}] & Loser [${biggestLoser.symbol}]. NET: ${netResult >= 0 ? '+' : ''}$${netResult.toFixed(4)}`);
                        
                        OffsetRecord.create({ userId: dbUserId, winnerSymbol: biggestWinner.symbol, winnerPnl: biggestWinner.unrealizedPnl, loserSymbol: biggestLoser.symbol, loserPnl: biggestLoser.unrealizedPnl, netProfit: netResult }).catch(()=>{});

                        const bStateW = activeBots.get(biggestWinner.profileId).state.coinStates[biggestWinner.symbol];
                        if(bStateW) { bStateW.lockUntil = Date.now() + 8000; bStateW.contracts = 0; }
                        
                        const bStateL = activeBots.get(biggestLoser.profileId).state.coinStates[biggestLoser.symbol];
                        if(bStateL) { bStateL.lockUntil = Date.now() + 8000; bStateL.contracts = 0; }

                        const wOrderSide = biggestWinner.side === 'long' ? 'sell' : 'buy';
                        await biggestWinner.exchange.createOrder(biggestWinner.symbol, 'market', wOrderSide, biggestWinner.contracts, undefined, { offset: 'close', reduceOnly: true, lever_rate: biggestWinner.leverage }).catch(()=>{});
                        biggestWinner.subAccount.realizedPnl = (biggestWinner.subAccount.realizedPnl || 0) + biggestWinner.unrealizedPnl;
                        await Settings.updateOne({ "subAccounts._id": biggestWinner.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": biggestWinner.subAccount.realizedPnl } }).catch(()=>{});

                        const lOrderSide = biggestLoser.side === 'long' ? 'sell' : 'buy';
                        await biggestLoser.exchange.createOrder(biggestLoser.symbol, 'market', lOrderSide, biggestLoser.contracts, undefined, { offset: 'close', reduceOnly: true, lever_rate: biggestLoser.leverage }).catch(()=>{});
                        biggestLoser.subAccount.realizedPnl = (biggestLoser.subAccount.realizedPnl || 0) + biggestLoser.unrealizedPnl;
                        await Settings.updateOne({ "subAccounts._id": biggestLoser.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": biggestLoser.subAccount.realizedPnl } }).catch(()=>{});
                        
                        offsetExecuted2 = true;
                        if (netResult < 0 && smartOffsetMaxLossPerMinute > 0) {
                            currentMinuteLoss += Math.abs(netResult);
                            rollingLossArr.push({ time: Date.now(), amount: Math.abs(netResult) });
                        }
                    }
                }
                if (offsetExecuted2) continue; 
            }

            if (offsetExecuted) continue;

            if (globalTargetPnl > 0) {
                let executeGlobalClose = false;

                if (globalUnrealized >= globalTargetPnl) {
                    const currentPeak = globalPnlPeaks.get(dbUserId) || 0;
                    if (globalUnrealized > currentPeak) {
                        globalPnlPeaks.set(dbUserId, globalUnrealized);
                        logForProfile(firstProfileId, `📈 GLOBAL TARGET HIT: Peak Portfolio Profit is $${globalUnrealized.toFixed(2)}. Waiting for a $${globalTrailingPnl} drop to secure profits...`);
                    }
                }
                
                if (globalPnlPeaks.has(dbUserId)) {
                    const peak = globalPnlPeaks.get(dbUserId);
                    if ((peak - globalUnrealized) >= globalTrailingPnl) executeGlobalClose = true;
                }

                if (executeGlobalClose) {
                    logForProfile(firstProfileId, `🌍 GLOBAL PORTFOLIO CLOSE TRIGGERED! Securing Total Portfolio Net Profit: $${globalUnrealized.toFixed(4)}`);
                    globalPnlPeaks.delete(dbUserId); 
                    
                    for (let pos of activeCandidates) {
                        try {
                            const bData = activeBots.get(pos.profileId);
                            if (bData && bData.state.coinStates[pos.symbol]) {
                                bData.state.coinStates[pos.symbol].lockUntil = Date.now() + 8000;
                                bData.state.coinStates[pos.symbol].contracts = 0;
                                bData.state.coinStates[pos.symbol].unrealizedPnl = 0;
                            }
                            const orderSide = pos.side === 'long' ? 'sell' : 'buy';
                            await pos.exchange.createOrder(pos.symbol, 'market', orderSide, pos.contracts, undefined, { offset: 'close', reduceOnly: true, lever_rate: pos.leverage });
                            pos.subAccount.realizedPnl = (pos.subAccount.realizedPnl || 0) + pos.unrealizedPnl;
                            await Settings.updateOne({ "subAccounts._id": pos.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": pos.subAccount.realizedPnl } }).catch(()=>{});
                        } catch(e) {}
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

// Vercel Singleton Initialization
const bootstrapBots = async () => {
    if (!global.botLoopsStarted) {
        global.botLoopsStarted = true;
        console.log("🛠 Bootstrapping Background Loops for Vercel...");
        
        setInterval(executeOneMinuteCloser, 60000);
        setInterval(executeGlobalProfitMonitor, 4000);

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
    bootstrapBots(); // Keep-alive trigger
    res.status(200).json({ success: true, message: 'Bot is awake', timestamp: new Date().toISOString(), activeProfiles: activeBots.size });
});

app.post('/api/register', async (req, res) => {
    await connectDB();
    try {
        const { username, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await User.create({ username, password: hashedPassword });
        await Settings.create({ userId: user._id, subAccounts: [], globalTargetPnl: 0, globalTrailingPnl: 0, smartOffsetNetProfit: 0, smartOffsetBottomRowV1: 5, smartOffsetBottomRowV1StopLoss: 0, smartOffsetStopLoss: 0, smartOffsetNetProfit2: 0, smartOffsetStopLoss2: 0, smartOffsetMaxLossPerMinute: 0, smartOffsetMaxLossTimeframeSeconds: 60, minuteCloseAutoDynamic: false, minuteCloseMinPnl: 0, minuteCloseMaxPnl: 0 });
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
    bootstrapBots(); // Keep-alive trigger
    const settings = await Settings.findOne({ userId: req.userId });
    res.json(settings);
});

app.post('/api/settings', authMiddleware, async (req, res) => {
    bootstrapBots();
    const { subAccounts, globalTargetPnl, globalTrailingPnl, smartOffsetNetProfit, smartOffsetBottomRowV1, smartOffsetBottomRowV1StopLoss, smartOffsetStopLoss, smartOffsetNetProfit2, smartOffsetStopLoss2, smartOffsetMaxLossPerMinute, smartOffsetMaxLossTimeframeSeconds, minuteCloseAutoDynamic, minuteCloseMinPnl, minuteCloseMaxPnl } = req.body;
    
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

    let parsedBottomRowSl = parseFloat(smartOffsetBottomRowV1StopLoss) || 0;
    if (parsedBottomRowSl > 0) parsedBottomRowSl = -parsedBottomRowSl;

    let parsedStopLoss = parseFloat(smartOffsetStopLoss) || 0;
    if (parsedStopLoss > 0) parsedStopLoss = -parsedStopLoss; 

    let parsedStopLoss2 = parseFloat(smartOffsetStopLoss2) || 0;
    if (parsedStopLoss2 > 0) parsedStopLoss2 = -parsedStopLoss2; 

    const updated = await Settings.findOneAndUpdate(
        { userId: req.userId }, 
        { 
            subAccounts, 
            globalTargetPnl: parseFloat(globalTargetPnl) || 0, 
            globalTrailingPnl: parseFloat(globalTrailingPnl) || 0,
            smartOffsetNetProfit: parseFloat(smartOffsetNetProfit) || 0,
            smartOffsetBottomRowV1: parseInt(smartOffsetBottomRowV1) || 5,
            smartOffsetBottomRowV1StopLoss: parsedBottomRowSl,
            smartOffsetStopLoss: parsedStopLoss,
            smartOffsetNetProfit2: parseFloat(smartOffsetNetProfit2) || 0,
            smartOffsetStopLoss2: parsedStopLoss2,
            smartOffsetMaxLossPerMinute: parseFloat(smartOffsetMaxLossPerMinute) || 0,
            smartOffsetMaxLossTimeframeSeconds: parseInt(smartOffsetMaxLossTimeframeSeconds) || 60,
            minuteCloseAutoDynamic: minuteCloseAutoDynamic === true,
            minuteCloseMinPnl: parseFloat(minuteCloseMinPnl) || 0,
            minuteCloseMaxPnl: parseFloat(minuteCloseMaxPnl) || 0
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
    bootstrapBots(); // Keep-alive trigger
    const settings = await Settings.findOne({ userId: req.userId });
    const userStatuses = {};
    for (let [profileId, botData] of activeBots.entries()) {
        if (botData.userId === req.userId.toString()) userStatuses[profileId] = botData.state;
    }

    let currentMinuteLoss = 0;
    const dbUserId = req.userId.toString();
    const timeframeSec = settings ? (settings.smartOffsetMaxLossTimeframeSeconds || 60) : 60;
    if (rollingStopLosses.has(dbUserId)) {
        let arr = rollingStopLosses.get(dbUserId).filter(r => Date.now() - r.time < (timeframeSec * 1000));
        currentMinuteLoss = arr.reduce((sum, r) => sum + r.amount, 0);
        rollingStopLosses.set(dbUserId, arr); 
    }

    res.json({ states: userStatuses, subAccounts: settings ? settings.subAccounts : [], globalSettings: settings, currentMinuteLoss });
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
            <div class="header">
                <h1>HTX Trading Bot</h1>
                <div style="display:flex; gap:12px;">
                    <button class="btn-blue" style="margin:0; width:auto; padding: 8px 16px;" onclick="switchTab('main')">Dashboard</button>
                    <button class="btn-logout" style="margin:0; width:auto;" onclick="switchTab('offsets')">Smart Offsets V1 (Group Accumulation)</button>
                    <button class="btn-logout" style="margin:0; width:auto; border-color: #1a73e8; color: #1a73e8;" onclick="switchTab('offsets2')">Smart Offsets V2 (Ends Sniper)</button>
                    <button class="btn-logout" style="margin:0; width:auto;" onclick="logout()">Logout</button>
                </div>
            </div>

            <!-- SMART OFFSETS HISTORY & LIVE TAB -->
            <div id="offset-tab" style="display:none;">
                <div class="panel">
                    <h2 style="color: #1a73e8;">Live Accumulation Grouping (Dynamic Peak Harvester)</h2>
                    <p style="font-size:0.85em; color:#5f6368; margin-top:-8px; margin-bottom:16px;">This engine scans the "Group Accumulation" column to find the exact row where the profit hits its peak. If that peak reaches your Target, it chops the list right there and closes those profitable pairs.</p>
                    <div id="liveOffsetsContainer">Waiting for live data...</div>
                </div>
                
                <div class="panel">
                    <h2 style="color: #1e8e3e;">Executed Smart Offsets History</h2>
                    <div id="offsetTableContainer" style="margin-top: 20px;">Loading historical offset data...</div>
                </div>
            </div>

            <!-- SMART OFFSETS V2 (ENDS) TAB -->
            <div id="offset2-tab" style="display:none;">
                <div class="panel">
                    <h2>Smart Offsets V2 Settings (Ends Pairing: 1 & N)</h2>
                    <div style="background: #e8f0fe; padding: 12px; border-radius: 6px; margin-bottom: 16px; border: 1px solid #dadce0;">
                        <div style="margin-top: 12px;">
                            <label style="margin-top:0;">Manual Offset Net Profit Target V2 ($)</label>
                            <p style="font-size:0.75em; color:#5f6368; margin-top:2px; line-height:1.4;">Strict 1-to-1 pairings. Pairs Rank 1 (Winner) & Rank N (Loser). Closes ONLY these 2 coins if Net PNL >= this amount.</p>
                            <input type="number" step="0.1" id="smartOffsetNetProfit2" placeholder="e.g. 1.00 (0 = Disabled)">
                        </div>
                        <div style="margin-top: 12px;">
                            <label style="margin-top:0;">Manual Offset Stop Loss V2 ($)</label>
                            <p style="font-size:0.75em; color:#5f6368; margin-top:2px; line-height:1.4;">Always evaluates! If the paired coins' Net PNL drops to or below this negative amount, it closes BOTH.</p>
                            <input type="number" step="0.1" id="smartOffsetStopLoss2" placeholder="e.g. -2.00 (0 = Disabled)">
                        </div>
                        <button class="btn-blue" style="margin-top:16px;" onclick="saveGlobalSettings()">Save Global Offset V2 Settings</button>
                    </div>
                </div>

                <div class="panel">
                    <h2 style="color: #1a73e8;">Live Paired Trades V2 (1-to-1 Sniper)</h2>
                    <p style="font-size:0.85em; color:#5f6368; margin-top:-8px; margin-bottom:16px;">Real-time strict 1-to-1 pairings exactly like this: Rank 1 & 10, 2 & 9, 3 & 8. No accumulation grouping here.</p>
                    <div id="liveOffsetsContainer2">Waiting for live data...</div>
                </div>
                
                <div class="panel">
                    <h2 style="color: #1e8e3e;">Executed Smart Offsets History</h2>
                    <div id="offsetTableContainer2" style="margin-top: 20px;">Loading historical offset data...</div>
                </div>
            </div>

            <!-- MAIN DASHBOARD TAB -->
            <div id="main-tab">
                <!-- GLOBAL STATS BANNER -->
                <div class="status-box" style="background:#fff3e0; border-color:#ffe0b2; margin-bottom: 24px;">
                    <div class="flex-row" style="justify-content: space-between;">
                        <div><span class="stat-label">Winning / Total Coins Trading</span><span class="val" id="globalWinRate" style="color:#e65100;">0 / 0</span></div>
                        <div><span class="stat-label">Global Unrealized PNL ($)</span><span class="val" id="topGlobalUnrealized">0.0000000000</span></div>
                    </div>
                </div>

                <div class="flex-container">
                    <!-- SETTINGS PANEL -->
                    <div class="panel flex-1">
                        <h2>Global User Settings</h2>
                        
                        <div style="background: #e8f0fe; padding: 12px; border-radius: 6px; margin-bottom: 16px; border: 1px solid #dadce0;">
                            <h4 style="margin: 0 0 8px 0; color: #1a73e8;">Smart Net Profit (Guaranteed Profit > Loss)</h4>
                            
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
                                <label style="margin-top:0;">Manual Offset Net Profit Target V1 ($)</label>
                                <p style="font-size:0.75em; color:#5f6368; margin-top:2px; line-height:1.4;">Groups Pair 1 + Pair 2 + Pair 3 etc. Closes the entire bucket of coins if the cumulative Group Net PNL >= this amount.</p>
                                <input type="number" step="0.1" id="smartOffsetNetProfit" placeholder="e.g. 1.00 (0 = Disabled)">
                            </div>
                            <div style="margin-top: 12px;">
                                <label style="margin-top:0;">Nth Bottom Row Reference (V1)</label>
                                <p style="font-size:0.75em; color:#5f6368; margin-top:2px; line-height:1.4;">Defines the row from the bottom used to calculate the Nth Bottom Row Stop Loss below. (Default is 5).</p>
                                <input type="number" step="1" id="smartOffsetBottomRowV1" placeholder="e.g. 5">
                            </div>

                            <div style="margin-top: 12px;">
                                <label style="margin-top:0;">Nth Bottom Row Stop Loss (V1) ($)</label>
                                <p style="font-size:0.75em; color:#5f6368; margin-top:2px; line-height:1.4;">If the accumulation at the Nth Bottom Row specified above drops to or below this negative amount, it closes the entire group.</p>
                                <input type="number" step="0.1" id="smartOffsetBottomRowV1StopLoss" placeholder="e.g. -1.50 (0 = Disabled)">
                            </div>

                            <div style="margin-top: 12px;">
                                <label style="margin-top:0;">Manual Offset Full Group Stop Loss V1 ($)</label>
                                <p style="font-size:0.75em; color:#5f6368; margin-top:2px; line-height:1.4;">Always evaluates! If the cumulative Full Group Net PNL drops to or below this negative amount, it closes the group.</p>
                                <input type="number" step="0.1" id="smartOffsetStopLoss" placeholder="e.g. -2.00 (0 = Disabled)">
                            </div>

                            <div style="margin-top: 12px; border-top: 1px solid #cce0ff; padding-top: 12px;">
                                <label style="margin-top:0;">Stop Loss Execution Limits</label>
                                <p style="font-size:0.75em; color:#5f6368; margin-top:2px; line-height:1.4;">Define how often Stop Losses can occur. If Amount Limit > 0, allows multiple SLs within the timeframe up to the amount. If 0, limits to exactly 1 SL per timeframe.</p>
                                <div class="flex-row">
                                    <div style="flex:1;">
                                        <input type="number" step="0.1" id="smartOffsetMaxLossPerMinute" placeholder="Max Amount Allowed (e.g. 10.00)">
                                    </div>
                                    <div style="flex:1;">
                                        <input type="number" step="1" id="smartOffsetMaxLossTimeframeSeconds" placeholder="Timeframe in Seconds (e.g. 60)">
                                    </div>
                                </div>
                            </div>

                            <div style="margin-top: 12px; border-top: 1px solid #cce0ff; padding-top: 12px;">
                                <label style="margin-top:0; display:flex; align-items:center;">
                                    1-Minute Interval: Close Positions Between PNL ($)
                                    <input type="checkbox" id="minuteCloseAutoDynamic" style="width:auto; margin-left:12px; margin-right:4px;"> Auto-Dynamic
                                </label>
                                <p style="font-size:0.75em; color:#5f6368; margin-top:2px; line-height:1.4;">Checks every 60s. Check Auto-Dynamic to continually intercept the precise Winner PNL where 📈 Part of Peak switches to 📉 Dragging down.</p>
                                <div class="flex-row">
                                    <div style="flex:1;"><input type="number" step="0.0001" id="minuteCloseMinPnl" placeholder="Min PNL (e.g. 0.0001)"></div>
                                    <div style="flex:1;"><input type="number" step="0.0001" id="minuteCloseMaxPnl" placeholder="Max PNL (e.g. 0.0004)"></div>
                                </div>
                            </div>
                            <button class="btn-blue" style="margin-top:16px;" onclick="saveGlobalSettings()">Save Global Settings</button>
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

                            <h3>Single Coin Math Logic</h3>
                            <div class="flex-row">
                                <div style="flex:1"><label>Take Profit Exit (%)</label><input type="number" step="0.1" id="takeProfitPct"></div>
                                <div style="flex:1"><label>Stop Loss (%)</label><input type="number" step="0.1" id="stopLossPct"></div>
                            </div>
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
            let myMinuteCloseMinPnl = 0;
            let myMinuteCloseMaxPnl = 0;
            let currentProfileIndex = -1;
            let myCoins = [];
            
            const PREDEFINED_COINS = ["TON", "AXS", "APT", "FIL", "ETHFI", "BERA", "MASK", "TIA", "DASH", "GIGGLE", "BSV", "OP", "TAO", "SSV", "YFI"];

            function checkAuth() {
                if (token) {
                    document.getElementById('auth-view').style.display = 'none';
                    document.getElementById('dashboard-view').style.display = 'block';
                    fetchSettings();
                    statusInterval = setInterval(loadStatus, 2000);
                } else {
                    document.getElementById('auth-view').style.display = 'block';
                    document.getElementById('dashboard-view').style.display = 'none';
                    clearInterval(statusInterval);
                }
            }

            function switchTab(tab) {
                document.getElementById('main-tab').style.display = 'none';
                document.getElementById('offset-tab').style.display = 'none';
                document.getElementById('offset2-tab').style.display = 'none';

                if (tab === 'main') {
                    document.getElementById('main-tab').style.display = 'block';
                } else if (tab === 'offsets') {
                    document.getElementById('offset-tab').style.display = 'block';
                    loadOffsets();
                } else if (tab === 'offsets2') {
                    document.getElementById('offset2-tab').style.display = 'block';
                    loadOffsets();
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
                
                myGlobalTargetPnl = config.globalTargetPnl || 0;
                myGlobalTrailingPnl = config.globalTrailingPnl || 0;
                mySmartOffsetNetProfit = config.smartOffsetNetProfit || 0;
                mySmartOffsetBottomRowV1 = config.smartOffsetBottomRowV1 !== undefined ? config.smartOffsetBottomRowV1 : 5;
                mySmartOffsetBottomRowV1StopLoss = config.smartOffsetBottomRowV1StopLoss || 0; 
                mySmartOffsetStopLoss = config.smartOffsetStopLoss || 0;
                mySmartOffsetNetProfit2 = config.smartOffsetNetProfit2 || 0;
                mySmartOffsetStopLoss2 = config.smartOffsetStopLoss2 || 0;
                mySmartOffsetMaxLossPerMinute = config.smartOffsetMaxLossPerMinute || 0;
                mySmartOffsetMaxLossTimeframeSeconds = config.smartOffsetMaxLossTimeframeSeconds !== undefined ? config.smartOffsetMaxLossTimeframeSeconds : 60;
                myMinuteCloseAutoDynamic = config.minuteCloseAutoDynamic || false;
                myMinuteCloseMinPnl = config.minuteCloseMinPnl || 0;
                myMinuteCloseMaxPnl = config.minuteCloseMaxPnl || 0;
                
                document.getElementById('globalTargetPnl').value = myGlobalTargetPnl;
                document.getElementById('globalTrailingPnl').value = myGlobalTrailingPnl;
                document.getElementById('smartOffsetNetProfit').value = mySmartOffsetNetProfit;
                document.getElementById('smartOffsetBottomRowV1').value = mySmartOffsetBottomRowV1;
                document.getElementById('smartOffsetBottomRowV1StopLoss').value = mySmartOffsetBottomRowV1StopLoss; 
                document.getElementById('smartOffsetStopLoss').value = mySmartOffsetStopLoss;
                document.getElementById('smartOffsetNetProfit2').value = mySmartOffsetNetProfit2;
                document.getElementById('smartOffsetStopLoss2').value = mySmartOffsetStopLoss2;
                document.getElementById('smartOffsetMaxLossPerMinute').value = mySmartOffsetMaxLossPerMinute;
                document.getElementById('smartOffsetMaxLossTimeframeSeconds').value = mySmartOffsetMaxLossTimeframeSeconds;
                document.getElementById('minuteCloseAutoDynamic').checked = myMinuteCloseAutoDynamic;
                document.getElementById('minuteCloseMinPnl').value = myMinuteCloseMinPnl;
                document.getElementById('minuteCloseMaxPnl').value = myMinuteCloseMaxPnl;

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
                myGlobalTargetPnl = parseFloat(document.getElementById('globalTargetPnl').value) || 0;
                myGlobalTrailingPnl = parseFloat(document.getElementById('globalTrailingPnl').value) || 0;
                mySmartOffsetNetProfit = parseFloat(document.getElementById('smartOffsetNetProfit').value) || 0;
                mySmartOffsetBottomRowV1 = parseInt(document.getElementById('smartOffsetBottomRowV1').value) || 5;
                mySmartOffsetBottomRowV1StopLoss = parseFloat(document.getElementById('smartOffsetBottomRowV1StopLoss').value) || 0; 
                mySmartOffsetStopLoss = parseFloat(document.getElementById('smartOffsetStopLoss').value) || 0;
                mySmartOffsetNetProfit2 = parseFloat(document.getElementById('smartOffsetNetProfit2').value) || 0;
                mySmartOffsetStopLoss2 = parseFloat(document.getElementById('smartOffsetStopLoss2').value) || 0;
                mySmartOffsetMaxLossPerMinute = parseFloat(document.getElementById('smartOffsetMaxLossPerMinute').value) || 0;
                mySmartOffsetMaxLossTimeframeSeconds = parseInt(document.getElementById('smartOffsetMaxLossTimeframeSeconds').value) || 60;
                myMinuteCloseAutoDynamic = document.getElementById('minuteCloseAutoDynamic').checked;
                myMinuteCloseMinPnl = parseFloat(document.getElementById('minuteCloseMinPnl').value) || 0;
                myMinuteCloseMaxPnl = parseFloat(document.getElementById('minuteCloseMaxPnl').value) || 0;
                
                const data = { subAccounts: mySubAccounts, globalTargetPnl: myGlobalTargetPnl, globalTrailingPnl: myGlobalTrailingPnl, smartOffsetNetProfit: mySmartOffsetNetProfit, smartOffsetBottomRowV1: mySmartOffsetBottomRowV1, smartOffsetBottomRowV1StopLoss: mySmartOffsetBottomRowV1StopLoss, smartOffsetStopLoss: mySmartOffsetStopLoss, smartOffsetNetProfit2: mySmartOffsetNetProfit2, smartOffsetStopLoss2: mySmartOffsetStopLoss2, smartOffsetMaxLossPerMinute: mySmartOffsetMaxLossPerMinute, smartOffsetMaxLossTimeframeSeconds: mySmartOffsetMaxLossTimeframeSeconds, minuteCloseAutoDynamic: myMinuteCloseAutoDynamic, minuteCloseMinPnl: myMinuteCloseMinPnl, minuteCloseMaxPnl: myMinuteCloseMaxPnl };
                await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(data) });
                alert('Global Settings Saved Successfully!');
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
                
                mySubAccounts.push({ name, apiKey: key, secret: secret, side: 'long', leverage: 10, baseQty: 1, takeProfitPct: 5.0, stopLossPct: -25.0, triggerRoiPct: -15.0, dcaTargetRoiPct: -2.0, maxContracts: 1000, realizedPnl: 0, coins: [] });
                
                const data = { subAccounts: mySubAccounts, globalTargetPnl: myGlobalTargetPnl, globalTrailingPnl: myGlobalTrailingPnl, smartOffsetNetProfit: mySmartOffsetNetProfit, smartOffsetBottomRowV1: mySmartOffsetBottomRowV1, smartOffsetBottomRowV1StopLoss: mySmartOffsetBottomRowV1StopLoss, smartOffsetStopLoss: mySmartOffsetStopLoss, smartOffsetNetProfit2: mySmartOffsetNetProfit2, smartOffsetStopLoss2: mySmartOffsetStopLoss2, smartOffsetMaxLossPerMinute: mySmartOffsetMaxLossPerMinute, smartOffsetMaxLossTimeframeSeconds: mySmartOffsetMaxLossTimeframeSeconds, minuteCloseAutoDynamic: myMinuteCloseAutoDynamic, minuteCloseMinPnl: myMinuteCloseMinPnl, minuteCloseMaxPnl: myMinuteCloseMaxPnl };
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
                    document.getElementById('takeProfitPct').value = profile.takeProfitPct || 5.0;
                    document.getElementById('stopLossPct').value = profile.stopLossPct || -25.0;
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
                    const data = { subAccounts: mySubAccounts, globalTargetPnl: myGlobalTargetPnl, globalTrailingPnl: myGlobalTrailingPnl, smartOffsetNetProfit: mySmartOffsetNetProfit, smartOffsetBottomRowV1: mySmartOffsetBottomRowV1, smartOffsetBottomRowV1StopLoss: mySmartOffsetBottomRowV1StopLoss, smartOffsetStopLoss: mySmartOffsetStopLoss, smartOffsetNetProfit2: mySmartOffsetNetProfit2, smartOffsetStopLoss2: mySmartOffsetStopLoss2, smartOffsetMaxLossPerMinute: mySmartOffsetMaxLossPerMinute, smartOffsetMaxLossTimeframeSeconds: mySmartOffsetMaxLossTimeframeSeconds, minuteCloseAutoDynamic: myMinuteCloseAutoDynamic, minuteCloseMinPnl: myMinuteCloseMinPnl, minuteCloseMaxPnl: myMinuteCloseMaxPnl };
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
                profile.takeProfitPct = parseFloat(document.getElementById('takeProfitPct').value);
                profile.stopLossPct = parseFloat(document.getElementById('stopLossPct').value);
                profile.triggerRoiPct = parseFloat(document.getElementById('triggerRoiPct').value);
                profile.dcaTargetRoiPct = parseFloat(document.getElementById('dcaTargetRoiPct').value);
                profile.maxContracts = parseInt(document.getElementById('maxContracts').value);
                profile.coins = myCoins;

                const data = { subAccounts: mySubAccounts, globalTargetPnl: myGlobalTargetPnl, globalTrailingPnl: myGlobalTrailingPnl, smartOffsetNetProfit: mySmartOffsetNetProfit, smartOffsetBottomRowV1: mySmartOffsetBottomRowV1, smartOffsetBottomRowV1StopLoss: mySmartOffsetBottomRowV1StopLoss, smartOffsetStopLoss: mySmartOffsetStopLoss, smartOffsetNetProfit2: mySmartOffsetNetProfit2, smartOffsetStopLoss2: mySmartOffsetStopLoss2, smartOffsetMaxLossPerMinute: mySmartOffsetMaxLossPerMinute, smartOffsetMaxLossTimeframeSeconds: mySmartOffsetMaxLossTimeframeSeconds, minuteCloseAutoDynamic: myMinuteCloseAutoDynamic, minuteCloseMinPnl: myMinuteCloseMinPnl, minuteCloseMaxPnl: myMinuteCloseMaxPnl };
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
                    document.getElementById('offsetTableContainer2').innerHTML = noData;
                    return;
                }

                let ih = '<table style="width:100%; text-align:left; border-collapse:collapse; background:#fff; border-radius:6px; overflow:hidden;">';
                ih += '<tr style="background:#f8f9fa;"><th style="padding:12px; border-bottom:2px solid #dadce0;">Date/Time</th><th style="padding:12px; border-bottom:2px solid #dadce0;">Winner Coin</th><th style="padding:12px; border-bottom:2px solid #dadce0;">Winner PNL</th><th style="padding:12px; border-bottom:2px solid #dadce0;">Loser Coin</th><th style="padding:12px; border-bottom:2px solid #dadce0;">Loser PNL</th><th style="padding:12px; border-bottom:2px solid #dadce0;">Net Profit</th></tr>';
                
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
                document.getElementById('offsetTableContainer2').innerHTML = ih;
            }

            async function loadStatus() {
                const res = await fetch('/api/status', { headers: { 'Authorization': 'Bearer ' + token } });
                if (res.status === 401 || res.status === 403) return logout();
                
                const data = await res.json();
                const allStatuses = data.states || {};
                const subAccountsUpdated = data.subAccounts || [];
                const globalSet = data.globalSettings || {};
                const currentMinuteLoss = data.currentMinuteLoss || 0;

                let globalTotal = 0;
                subAccountsUpdated.forEach(sub => {
                    globalTotal += (sub.realizedPnl || 0);
                    const localSub = mySubAccounts.find(s => s._id === sub._id);
                    if(localSub) localSub.realizedPnl = sub.realizedPnl;
                });

                let globalUnrealized = 0;
                let totalTrading = 0;
                let totalAboveZero = 0;
                
                let activeCandidates = [];

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
                                activeCandidates.push({ symbol: sym, pnl: pnlNum });
                            }
                        }
                    }
                }

                const timeframeSec = globalSet.smartOffsetMaxLossTimeframeSeconds || 60;
                const maxLossPerMin = globalSet.smartOffsetMaxLossPerMinute || 0;
                const lossTrackerHtml = maxLossPerMin > 0 
                    ? \`<div style="margin-top: 6px; padding-top: 6px; border-top: 1px dashed #b3d4ff;">⏳ <strong>\${timeframeSec}s Loss Tracker:</strong> $\${currentMinuteLoss.toFixed(2)} / $\${maxLossPerMin.toFixed(2)} Limit</div>\`
                    : \`<div style="margin-top: 6px; padding-top: 6px; border-top: 1px dashed #b3d4ff;">⏳ <strong>\${timeframeSec}s Loss Tracker:</strong> Limited to 1 SL execution per \${timeframeSec}s</div>\`;
                
                let dynamicMax = 0;
                let dynamicMin = 0;
                let hasDynamicBoundary = false;

                if (activeCandidates.length >= 2) {
                    let sortedCands = [...activeCandidates].sort((a, b) => b.pnl - a.pnl);
                    let tCoins = sortedCands.length;
                    let tPairs = Math.floor(tCoins / 2);
                    let rAcc = 0;
                    let pAcc = 0;
                    let pIdx = -1;
                    
                    for (let i = 0; i < tPairs; i++) {
                        let net = sortedCands[i].pnl + sortedCands[tCoins - tPairs + i].pnl;
                        rAcc += net;
                        if (rAcc > pAcc) {
                            pAcc = rAcc;
                            pIdx = i;
                        }
                    }
                    if (pIdx >= 0 && pIdx + 1 < tPairs) {
                        dynamicMax = sortedCands[pIdx].pnl;
                        dynamicMin = sortedCands[pIdx + 1].pnl;
                        hasDynamicBoundary = true;
                    }
                }

                if (!hasDynamicBoundary || dynamicMin === dynamicMax) {
                    dynamicMax = 0.0006;
                    dynamicMin = 0.0004;
                    hasDynamicBoundary = true; 
                }

                const autoDynCheckbox = document.getElementById('minuteCloseAutoDynamic');
                const minInput = document.getElementById('minuteCloseMinPnl');
                const maxInput = document.getElementById('minuteCloseMaxPnl');

                if (autoDynCheckbox && autoDynCheckbox.checked) {
                    minInput.disabled = true;
                    maxInput.disabled = true;
                    minInput.style.backgroundColor = '#e8eaed';
                    maxInput.style.backgroundColor = '#e8eaed';
                    if (hasDynamicBoundary) {
                        minInput.value = Math.min(dynamicMin, dynamicMax).toFixed(4);
                        maxInput.value = Math.max(dynamicMin, dynamicMax).toFixed(4);
                    } else {
                        minInput.value = '';
                        maxInput.value = '';
                    }
                } else if (autoDynCheckbox) {
                    minInput.disabled = false;
                    maxInput.disabled = false;
                    minInput.style.backgroundColor = '#fafafa';
                    maxInput.style.backgroundColor = '#fafafa';
                }

                // --- RENDER LIVE SMART OFFSET TRADES (V1 - GROUP ACCUMULATION) ---
                if (document.getElementById('offset-tab').style.display === 'block') {
                    activeCandidates.sort((a, b) => b.pnl - a.pnl);
                    const totalCoins = activeCandidates.length;
                    const totalPairs = Math.floor(totalCoins / 2);

                    const targetV1 = globalSet.smartOffsetNetProfit || 0;
                    const stopLossV1 = globalSet.smartOffsetStopLoss || 0;
                    const stopLossNth = globalSet.smartOffsetBottomRowV1StopLoss || 0; 
                    const bottomRowN = globalSet.smartOffsetBottomRowV1 !== undefined ? globalSet.smartOffsetBottomRowV1 : 5;

                    if (totalPairs === 0) {
                        document.getElementById('liveOffsetsContainer').innerHTML = '<p style="color:#5f6368;">Not enough active trades to form pairs.</p>';
                    } else {
                        let liveHtml = '<table style="width:100%; text-align:left; border-collapse:collapse; background:#fff; border-radius:6px; overflow:hidden;">';
                        liveHtml += '<tr style="background:#e8f0fe;"><th style="padding:12px; border-bottom:2px solid #dadce0;">Rank Pair</th><th style="padding:12px; border-bottom:2px solid #dadce0;">Winner Coin</th><th style="padding:12px; border-bottom:2px solid #dadce0;">Winner PNL</th><th style="padding:12px; border-bottom:2px solid #dadce0;">Loser Coin</th><th style="padding:12px; border-bottom:2px solid #dadce0;">Loser PNL</th><th style="padding:12px; border-bottom:2px solid #dadce0;">Pair Net</th><th style="padding:12px; border-bottom:2px solid #dadce0; color:#1a73e8;">Group Accumulation</th></tr>';

                        let runningAccumulation = 0;
                        let peakAccumulation = 0;
                        let peakRowIndex = -1;
                        let nthBottomAccumulation = 0;
                        
                        const targetRefIndex = Math.max(0, totalPairs - bottomRowN);

                        for (let i = 0; i < totalPairs; i++) {
                            const w = activeCandidates[i];
                            const l = activeCandidates[totalCoins - totalPairs + i];
                            const net = w.pnl + l.pnl;
                            runningAccumulation += net;
                            
                            if (runningAccumulation > peakAccumulation) {
                                peakAccumulation = runningAccumulation;
                                peakRowIndex = i;
                            }
                            if (i === targetRefIndex) {
                                nthBottomAccumulation = runningAccumulation;
                            }
                        }

                        let topStatusMessage = '';
                        let executingPeak = false;
                        let executingSl = false;
                        
                        const isHitNthSl = (stopLossNth < 0 && nthBottomAccumulation <= stopLossNth);
                        const isHitFullSl = (stopLossV1 < 0 && runningAccumulation <= stopLossV1);

                        if (targetV1 > 0 && peakAccumulation >= targetV1 && peakRowIndex >= 0) {
                            topStatusMessage = \`<span style="color:#1e8e3e; font-weight:bold;">🔥 Target Reached! Slicing at Row \${peakRowIndex + 1} to harvest Peak Profit ($\${peakAccumulation.toFixed(4)})!</span>\`;
                            executingPeak = true;
                        } else if (isHitNthSl || isHitFullSl) {
                            let projectedLoss = runningAccumulation; 
                            let blockedByLimit = false;

                            if (maxLossPerMin > 0 && (currentMinuteLoss + Math.abs(projectedLoss)) > maxLossPerMin) {
                                blockedByLimit = true;
                            }

                            if (blockedByLimit) {
                                topStatusMessage = \`<span style="color:#d93025; font-weight:bold;">🛑 Stop Loss Reached but Blocked by \${timeframeSec}s Limit!</span>\`;
                            } else {
                                executingSl = true;
                                if (isHitNthSl) {
                                    topStatusMessage = \`<span style="color:#d93025; font-weight:bold;">🔥 Stop Loss Hit (Nth Row [\${bottomRowN}] dropped to/below $\${stopLossNth.toFixed(4)})!</span>\`;
                                } else {
                                    topStatusMessage = \`<span style="color:#d93025; font-weight:bold;">🔥 Stop Loss Hit for the full group!</span>\`;
                                }
                            }
                        } else {
                            let pColor = peakAccumulation > 0 ? '#1e8e3e' : '#5f6368';
                            topStatusMessage = \`TP Status: <span style="color:#1a73e8; font-weight:bold;">🔎 Seeking Peak &ge; $\${targetV1.toFixed(4)}</span> | Current Peak: <strong style="color:\${pColor}">+\$\${peakAccumulation.toFixed(4)}</strong>\`;
                        }

                        let displayAccumulation = 0;
                        for (let i = 0; i < totalPairs; i++) {
                            const winnerIndex = i;
                            const loserIndex = totalCoins - totalPairs + i;

                            const w = activeCandidates[winnerIndex];
                            const l = activeCandidates[loserIndex];
                            const net = w.pnl + l.pnl;
                            displayAccumulation += net;
                            
                            let statusIcon = '⏳ Waiting';
                            if (executingPeak) {
                                if (i <= peakRowIndex) statusIcon = '🔥 Harvesting Peak';
                                else statusIcon = '⏸️ Ignored (Past Peak)';
                            } else if (executingSl) {
                                statusIcon = '🔥 Executing (SL)';
                            } else {
                                if (i <= peakRowIndex) statusIcon = '📈 Part of Peak';
                                else statusIcon = '📉 Dragging down';
                            }

                            const wColor = w.pnl >= 0 ? '#1e8e3e' : '#d93025';
                            const lColor = l.pnl >= 0 ? '#1e8e3e' : '#d93025';
                            const nColor = net >= 0 ? '#1e8e3e' : '#d93025';
                            const cColor = displayAccumulation >= 0 ? '#1e8e3e' : '#d93025';

                            let rowStyle = (i === peakRowIndex && peakAccumulation > 0) ? 'border: 2px solid #1e8e3e; background: #e6f4ea;' : '';
                            if (i === targetRefIndex) rowStyle += 'border-left: 4px solid #f29900;'; 

                            liveHtml += \`<tr style="\${rowStyle}">
                                <td style="padding:12px; border-bottom:1px solid #eee; font-weight:500; color:#5f6368;">\${winnerIndex + 1} & \${loserIndex + 1} <br><span style="font-size:0.75em; color:#1a73e8">\${statusIcon}</span></td>
                                <td style="padding:12px; border-bottom:1px solid #eee; font-weight:500;">\${w.symbol}</td>
                                <td style="padding:12px; border-bottom:1px solid #eee; color:\${wColor}; font-weight:700;">\${w.pnl >= 0 ? '+' : ''}$\${w.pnl.toFixed(4)}</td>
                                <td style="padding:12px; border-bottom:1px solid #eee; font-weight:500;">\${l.symbol}</td>
                                <td style="padding:12px; border-bottom:1px solid #eee; color:\${lColor}; font-weight:700;">\${l.pnl >= 0 ? '+' : ''}$\${l.pnl.toFixed(4)}</td>
                                <td style="padding:12px; border-bottom:1px solid #eee; color:\${nColor}; font-weight:700; background: #f8f9fa;">\${net >= 0 ? '+' : ''}$\${net.toFixed(4)}</td>
                                <td style="padding:12px; border-bottom:1px solid #eee; color:\${cColor}; font-weight:700; background: #e8f0fe;">
                                    \${displayAccumulation >= 0 ? '+' : ''}$\${displayAccumulation.toFixed(4)}
                                    \${i === targetRefIndex ? '<br><span style="font-size:0.7em; color:#f29900;">★ Nth Row Ref</span>' : ''}
                                </td>
                            </tr>\`;
                        }
                        liveHtml += '</table>';
                        
                        let dynamicInfoHtml = \`<div style="margin-bottom: 12px; padding: 12px; background: #e8f0fe; border: 1px solid #cce0ff; border-radius: 6px; color: #1a73e8; font-weight: 500;">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                                <div>🎯 Strict Take Profit: $\${targetV1.toFixed(4)}</div>
                                <div>🛑 Full Group Stop: $\${stopLossV1.toFixed(4)}</div>
                                <div>🛑 Row \${bottomRowN} Stop: $\${stopLossNth.toFixed(4)}</div>
                            </div>
                            \${lossTrackerHtml}
                            <div style="margin-top: 10px; padding-top: 10px; border-top: 1px dashed #b3d4ff; font-size: 1.1em;">
                                Live Status: \${topStatusMessage}
                            </div>
                        </div>\`;

                        document.getElementById('liveOffsetsContainer').innerHTML = dynamicInfoHtml + liveHtml;
                    }
                }

                if (document.getElementById('offset2-tab').style.display === 'block') {
                    activeCandidates.sort((a, b) => b.pnl - a.pnl);
                    const totalCoins = activeCandidates.length;
                    const totalPairs = Math.floor(totalCoins / 2);

                    const targetV2 = globalSet.smartOffsetNetProfit2 || 0;
                    const stopLossV2 = globalSet.smartOffsetStopLoss2 || 0;

                    if (totalPairs === 0) {
                        document.getElementById('liveOffsetsContainer2').innerHTML = '<p style="color:#5f6368;">Not enough active trades to form pairs.</p>';
                    } else {
                        let liveHtml = '<table style="width:100%; text-align:left; border-collapse:collapse; background:#fff; border-radius:6px; overflow:hidden;">';
                        liveHtml += '<tr style="background:#e8f0fe;"><th style="padding:12px; border-bottom:2px solid #dadce0;">Rank Pair</th><th style="padding:12px; border-bottom:2px solid #dadce0;">Winner Coin</th><th style="padding:12px; border-bottom:2px solid #dadce0;">Winner PNL</th><th style="padding:12px; border-bottom:2px solid #dadce0;">Loser Coin</th><th style="padding:12px; border-bottom:2px solid #dadce0;">Loser PNL</th><th style="padding:12px; border-bottom:2px solid #dadce0;">Live Net Profit</th></tr>';

                        let topStatusMessage2 = '<span style="color:#f29900;">⏳ Evaluating pairs... Target not reached yet.</span>';

                        for (let i = 0; i < totalPairs; i++) {
                            const winnerIndex = i;
                            const loserIndex = totalCoins - 1 - i;

                            const w = activeCandidates[winnerIndex];
                            const l = activeCandidates[loserIndex];
                            const net = w.pnl + l.pnl;

                            const wColor = w.pnl >= 0 ? '#1e8e3e' : '#d93025';
                            const lColor = l.pnl >= 0 ? '#1e8e3e' : '#d93025';
                            const nColor = net >= 0 ? '#1e8e3e' : '#d93025';
                            
                            const isTargetHit = (targetV2 > 0 && net >= targetV2);
                            const isStopHit = (stopLossV2 < 0 && net <= stopLossV2);
                            
                            let statusIcon = '⏳ Evaluating';
                            if (isTargetHit) {
                                statusIcon = '🔥 Executing (TP)...';
                                topStatusMessage2 = \`<span style="color:#1e8e3e; font-weight:bold;">🔥 Executing Pair \${winnerIndex+1} & \${loserIndex+1} for TP!</span>\`;
                            } else if (isStopHit) {
                                if (maxLossPerMin > 0 && (currentMinuteLoss + Math.abs(net)) > maxLossPerMin) {
                                    statusIcon = '🛑 BLOCKED (Limit)';
                                    topStatusMessage2 = \`<span style="color:#d93025; font-weight:bold;">🛑 Stop Loss reached but Blocked by \${timeframeSec}s Limit!</span>\`;
                                } else {
                                    statusIcon = '🔥 Executing (SL)...';
                                    topStatusMessage2 = \`<span style="color:#d93025; font-weight:bold;">🔥 Stop Loss Hit & Executing!</span>\`;
                                }
                            }

                            liveHtml += \`<tr>
                                <td style="padding:12px; border-bottom:1px solid #eee; font-weight:500; color:#5f6368;">\${winnerIndex + 1} & \${loserIndex + 1} <br><span style="font-size:0.75em; color:#1a73e8">\${statusIcon}</span></td>
                                <td style="padding:12px; border-bottom:1px solid #eee; font-weight:500;">\${w.symbol}</td>
                                <td style="padding:12px; border-bottom:1px solid #eee; color:\${wColor}; font-weight:700;">\${w.pnl >= 0 ? '+' : ''}$\${w.pnl.toFixed(4)}</td>
                                <td style="padding:12px; border-bottom:1px solid #eee; font-weight:500;">\${l.symbol}</td>
                                <td style="padding:12px; border-bottom:1px solid #eee; color:\${lColor}; font-weight:700;">\${l.pnl >= 0 ? '+' : ''}$\${l.pnl.toFixed(4)}</td>
                                <td style="padding:12px; border-bottom:1px solid #eee; color:\${nColor}; font-weight:700; background: #f8f9fa;">\${net >= 0 ? '+' : ''}$\${net.toFixed(4)}</td>
                            </tr>\`;
                        }
                        liveHtml += '</table>';
                        
                        if (totalCoins % 2 !== 0) {
                            const midIndex = totalPairs;
                            const mid = activeCandidates[midIndex];
                            const mColor = mid.pnl >= 0 ? '#1e8e3e' : '#d93025';
                            liveHtml += \`<p style="font-size:0.85em; color:#5f6368; margin-top:12px;">Middle coin (Rank \${midIndex + 1}, Unpaired): <strong>\${mid.symbol}</strong> (<span style="color:\${mColor}">\${mid.pnl >= 0 ? '+' : ''}$\${mid.pnl.toFixed(4)}</span>)</p>\`;
                        }
                        
                        let dynamicInfoHtml2 = \`<div style="margin-bottom: 12px; padding: 12px; background: #e8f0fe; border: 1px solid #cce0ff; border-radius: 6px; color: #1a73e8; font-weight: 500;">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                                <div>🎯 Strict Take Profit V2: $\${targetV2.toFixed(4)}</div>
                                <div>🛑 Strict Stop Loss V2: $\${stopLossV2.toFixed(4)}</div>
                            </div>
                            \${lossTrackerHtml}
                            <div style="margin-top: 10px; padding-top: 10px; border-top: 1px dashed #b3d4ff; font-size: 1.1em;">
                                Live Status: \${topStatusMessage2}
                            </div>
                        </div>\`;

                        document.getElementById('liveOffsetsContainer2').innerHTML = dynamicInfoHtml2 + liveHtml;
                    }
                }

                document.getElementById('globalWinRate').innerText = \`\${totalAboveZero} / \${totalTrading}\`;
                
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
                        const state = stateData.coinStates && stateData.coinStates[coin.symbol] ? stateData.coinStates[coin.symbol] : { status: 'Stopped', currentPrice: 0, avgEntry: 0, contracts: 0, currentRoi: 0, unrealizedPnl: 0 };
                        let statusColor = state.status === 'Running' ? '#1e8e3e' : '#d93025';
                        let roiColorClass = state.currentRoi >= 0 ? 'val green' : 'val red';
                        const displaySide = coin.side || profile.side || 'long';

                        if (state.lockUntil && Date.now() < state.lockUntil) {
                            statusColor = '#f29900';
                            state.status = 'Closing / Locked';
                        }

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
                                <div><span class="stat-label">ROI %</span><span class="\${roiColorClass}">\${(state.currentRoi || 0).toFixed(2)}%</span></div>
                            </div>
                        </div>\`;
                    });
                    statusContainer.innerHTML = html;
                }

                document.getElementById('logs').innerHTML = (stateData.logs || []).join('<br>');
            }

            checkAuth(); // Initialize
        </script>
    </body>
    </html>
    `);
});

// VERCEL EXPORT: Replaces app.listen()
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`🚀 Running locally on http://localhost:${PORT}`));
}
module.exports = app;
