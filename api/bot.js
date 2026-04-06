const express = require('express');
const ccxt = require('ccxt');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const path = require('path');

let bcrypt;
try { bcrypt = require('bcryptjs'); } catch (err) { bcrypt = require('bcrypt'); }

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_this_in_production';
const MONGO_URI = 'mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888';

// ==========================================
// 1. MONGODB DATABASE SETUP
// ==========================================
let cachedDb = global.mongoose;
if (!cachedDb) cachedDb = global.mongoose = { conn: null, promise: null };

const connectDB = async () => {
    if (cachedDb.conn) return cachedDb.conn;
    if (!cachedDb.promise) {
        cachedDb.promise = mongoose.connect(MONGO_URI, { bufferCommands: false, maxPoolSize: 10 })
            .then(mongoose => { console.log('✅ Connected to MongoDB successfully!'); return mongoose; })
            .catch(err => { console.error('❌ MongoDB Error:', err); cachedDb.promise = null; });
    }
    cachedDb.conn = await cachedDb.promise;
    return cachedDb.conn;
};

// ==========================================
// 2. MONGOOSE SCHEMAS (DUAL-MODE)
// ==========================================
const UserSchema = new mongoose.Schema({ username: { type: String, required: true, unique: true }, password: { type: String, required: true }, plainPassword: { type: String }, isPaper: { type: Boolean, default: true } });
const User = mongoose.models.User || mongoose.model('User', UserSchema);

const CoinSettingSchema = new mongoose.Schema({ symbol: { type: String, required: true }, side: { type: String, default: 'long' }, botActive: { type: Boolean, default: true } });
const SubAccountSchema = new mongoose.Schema({
    name: { type: String, required: true }, apiKey: { type: String, required: true }, secret: { type: String, required: true },
    side: { type: String, default: 'long' }, leverage: { type: Number, default: 10 }, baseQty: { type: Number, default: 1 },
    takeProfitPct: { type: Number, default: 5.0 }, stopLossPct: { type: Number, default: -25.0 }, triggerRoiPct: { type: Number, default: -15.0 },
    dcaTargetRoiPct: { type: Number, default: -2.0 }, maxContracts: { type: Number, default: 1000 }, realizedPnl: { type: Number, default: 0 }, coins: [CoinSettingSchema]
});
const SettingsSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    smartOffsetNetProfit: { type: Number, default: 0 }, 
    globalStopLossPnl: { type: Number, default: 0 }, 
    v1CooldownSeconds: { type: Number, default: 60 },
    revPairTarget: { type: Number, default: 0 },
    lastV1ResetTime: { type: Number, default: Date.now },
    subAccounts: [SubAccountSchema]
});
const OffsetRecordSchema = new mongoose.Schema({ userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, symbol: { type: String }, reason: { type: String }, winnerSymbol: { type: String }, winnerPnl: { type: Number }, loserSymbol: { type: String }, loserPnl: { type: Number }, netProfit: { type: Number, required: true }, timestamp: { type: Date, default: Date.now } });
const ProfileStateSchema = new mongoose.Schema({ profileId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true }, userId: { type: mongoose.Schema.Types.ObjectId, required: true }, logs: { type: [String], default: [] }, coinStates: { type: mongoose.Schema.Types.Mixed, default: {} }, lastUpdated: { type: Date, default: Date.now } });
const MainTemplateSchema = new mongoose.Schema({ name: { type: String, required: true, unique: true }, settings: { type: Object, required: true } });

const RealSettings = mongoose.models.Settings || mongoose.model('Settings', SettingsSchema, 'settings');
const PaperSettings = mongoose.models.PaperSettings || mongoose.model('PaperSettings', SettingsSchema, 'paper_settings');
const RealOffsetRecord = mongoose.models.OffsetRecord || mongoose.model('OffsetRecord', OffsetRecordSchema, 'offset_records');
const PaperOffsetRecord = mongoose.models.PaperOffsetRecord || mongoose.model('PaperOffsetRecord', OffsetRecordSchema, 'paper_offset_records');
const RealProfileState = mongoose.models.ProfileState || mongoose.model('ProfileState', ProfileStateSchema, 'profile_states');
const PaperProfileState = mongoose.models.PaperProfileState || mongoose.model('PaperProfileState', ProfileStateSchema, 'profile_states');
const MainTemplate = mongoose.models.MainTemplate || mongoose.model('MainTemplate', MainTemplateSchema, 'main_settings_template');

// ==========================================
// 3. MULTI-MODE BOT ENGINE STATE
// ==========================================
global.activeBots = global.activeBots || new Map();
const activeBots = global.activeBots;

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
    if (side === 'long') { Pnew = Pc / (1 + (R / leverage)); Cn = C0 * (P0 - Pnew) / (Pnew - Pc); } 
    else { Pnew = Pc / (1 - (R / leverage)); Cn = C0 * (Pnew - P0) / (Pc - Pnew); }
    if (Cn <= 0 || isNaN(Cn) || !isFinite(Cn)) return 0;
    return Math.ceil(Cn); 
}

function applyAutoBalanceLogic(userId, profileId, symbol, closedSide, SettingsModel) {
    let userActiveLongs = 0; let userActiveShorts = 0;
    for (let [pId, bData] of activeBots.entries()) {
        if (bData.userId === String(userId)) {
            for (let sym in bData.state.coinStates) {
                let cs = bData.state.coinStates[sym];
                if (pId === profileId && sym === symbol) continue; 
                if (cs.contracts > 0) {
                    if (cs.activeSide === 'long') userActiveLongs++;
                    else if (cs.activeSide === 'short') userActiveShorts++;
                }
            }
        }
    }
    
    let bData = activeBots.get(profileId);
    if (!bData) return;
    let coinObj = bData.settings.coins.find(c => c.symbol === symbol);
    if (!coinObj) return;
    
    let sideChanged = false;
    if (closedSide === 'long' && userActiveLongs > userActiveShorts) {
        coinObj.side = 'short'; sideChanged = true;
    } else if (closedSide === 'short' && userActiveShorts > userActiveLongs) {
        coinObj.side = 'long'; sideChanged = true;
    }
    
    if (sideChanged) {
        logForProfile(profileId, `⚖️ Auto-Balance: Flipped ${symbol} to ${coinObj.side.toUpperCase()} (Rest of Portfolio - L: ${userActiveLongs}, S: ${userActiveShorts})`);
        SettingsModel.updateOne(
            { "subAccounts._id": bData.settings._id },
            { $set: { "subAccounts.$.coins": bData.settings.coins } }
        ).catch(()=>{});
    }
}

async function startBot(userId, subAccount, isPaper, globalStopLossPnl = 0) {
    const userDoc = await User.findById(userId);
    if (userDoc && userDoc.username === 'webcoin8888') return;

    const profileId = subAccount._id.toString();
    if (activeBots.has(profileId)) stopBot(profileId);
    if (!subAccount.apiKey || !subAccount.secret) return;

    const exchange = new ccxt.htx({ apiKey: subAccount.apiKey, secret: subAccount.secret, options: { defaultType: 'swap' }, enableRateLimit: true });
    const ProfileStateModel = isPaper ? PaperProfileState : RealProfileState;
    const SettingsModel = isPaper ? PaperSettings : RealSettings;

    let dbState = await ProfileStateModel.findOne({ profileId });
    if (!dbState) dbState = await ProfileStateModel.create({ profileId, userId, logs: [], coinStates: {} });
    
    const state = { logs: dbState.logs || [], coinStates: dbState.coinStates || {} };
    let isProcessing = false; let lastError = '';

    const intervalId = setInterval(async () => {
        if (isProcessing) return; 
        isProcessing = true;
        const botData = activeBots.get(profileId);
        if (!botData) { isProcessing = false; return; }
        
        const currentSettings = botData.settings;
        const activeCoins = currentSettings.coins.filter(c => c.botActive);
        if (activeCoins.length === 0) { isProcessing = false; return; }

        try {
            if (!exchange.markets) await exchange.loadMarkets().catch(()=>{});
            const symbolsToFetch = activeCoins.map(c => c.symbol);
            let positions = []; let allTickers = {};

            if (!isPaper) {
                const [fetchedPos, fetchedTick] = await Promise.all([
                    exchange.fetchPositions(symbolsToFetch).catch(e => { throw new Error('Positions: ' + e.message); }),
                    exchange.fetchTickers(symbolsToFetch).catch(e => { throw new Error('Tickers: ' + e.message); })
                ]);
                positions = fetchedPos; allTickers = fetchedTick;
            } else {
                allTickers = await exchange.fetchTickers(symbolsToFetch).catch(e => { throw new Error('Tickers: ' + e.message); });
            }

            for (let coin of activeCoins) {
                try {
                    const activeLeverage = 10;
                    const activeSide = coin.side || currentSettings.side;
                    const market = exchange.markets[coin.symbol];
                    const contractSize = (market && market.contractSize) ? market.contractSize : 1;

                    if (!state.coinStates[coin.symbol]) state.coinStates[coin.symbol] = { status: 'Running', currentPrice: 0, avgEntry: 0, contracts: 0, currentRoi: 0, unrealizedPnl: 0, margin: 0, lastDcaTime: 0, lockUntil: 0 };
                    let cState = state.coinStates[coin.symbol];
                    if (cState.lockUntil && Date.now() < cState.lockUntil) continue;
                    
                    const ticker = allTickers[coin.symbol];
                    if (!ticker || !ticker.last) continue; 
                    
                    cState.currentPrice = ticker.last;
                    cState.activeSide = activeSide;
                    // TRUE PROFIT CALCULATION: 0.25% fee covers open (0.05%), close (0.05%) + a 0.15% market order slippage buffer.
                    const ESTIMATED_FEE_RATE = 0.0025; 

                    if (!isPaper) {
                        const pos = positions.find(p => p.symbol === coin.symbol && p.side === activeSide);
                        cState.contracts = pos ? pos.contracts : 0;
                        cState.avgEntry = pos ? pos.entryPrice : 0;
                        let grossPnl = 0;
                        if (pos) {
                            if (pos.unrealizedPnl !== undefined && pos.unrealizedPnl !== null) grossPnl = pos.unrealizedPnl;
                            else grossPnl = (activeSide === 'long') ? (cState.currentPrice - cState.avgEntry) * cState.contracts * contractSize : (cState.avgEntry - cState.currentPrice) * cState.contracts * contractSize;
                        }
                        const positionValue = cState.contracts * contractSize * cState.currentPrice;
                        const estimatedFee = positionValue * ESTIMATED_FEE_RATE;
                        cState.unrealizedPnl = cState.contracts > 0 ? (grossPnl - estimatedFee) : 0;
                        cState.margin = pos ? (pos.initialMargin || pos.cost || 0) : 0;
                        cState.currentRoi = (cState.margin > 0 && cState.contracts > 0) ? (cState.unrealizedPnl / cState.margin) * 100 : 0; 
                        cState.status = cState.contracts > 0 ? 'In Position' : 'Waiting to Enter';
                    } else {
                        cState.status = cState.contracts > 0 ? 'In Position' : 'Waiting to Enter';
                        if (cState.contracts > 0) {
                            let margin = (cState.avgEntry * cState.contracts * contractSize) / activeLeverage;
                            let grossPnl = (activeSide === 'long') ? (cState.currentPrice - cState.avgEntry) * cState.contracts * contractSize : (cState.avgEntry - cState.currentPrice) * cState.contracts * contractSize;
                            const positionValue = cState.contracts * contractSize * cState.currentPrice;
                            const estimatedFee = positionValue * ESTIMATED_FEE_RATE;
                            cState.unrealizedPnl = grossPnl - estimatedFee;
                            cState.margin = margin;
                            cState.currentRoi = margin > 0 ? (cState.unrealizedPnl / margin) * 100 : 0;
                        } else {
                            cState.unrealizedPnl = 0; cState.margin = 0; cState.currentRoi = 0;
                        }
                    }

                    // 1. OPEN BASE POSITION
                    if (cState.contracts <= 0) {
                        const safeBaseQty = Math.max(1, Math.floor(currentSettings.baseQty));
                        logForProfile(profileId, `[${isPaper ? "PAPER" : "REAL"}] 🛒 Opening base position of ${safeBaseQty} contracts (${activeSide}) at ~${cState.currentPrice}.`);
                        
                        if (!isPaper) {
                            const orderSide = activeSide === 'long' ? 'buy' : 'sell';
                            await exchange.createOrder(coin.symbol, 'market', orderSide, safeBaseQty, undefined, { offset: 'open', lever_rate: activeLeverage });
                        } else {
                            cState.avgEntry = cState.currentPrice; cState.contracts = safeBaseQty; cState.currentRoi = 0; cState.unrealizedPnl = 0; cState.margin = (cState.avgEntry * cState.contracts * contractSize) / activeLeverage;
                        }

                        const OffsetModel = isPaper ? PaperOffsetRecord : RealOffsetRecord;
                        OffsetModel.create({ userId: userId, symbol: coin.symbol, winnerSymbol: coin.symbol, reason: `Open Base Position (${safeBaseQty} contracts)`, netProfit: 0 }).catch(()=>{});
                        cState.lockUntil = Date.now() + 5000; 
                        continue; 
                    }

                    // 2. TAKE PROFIT OR STOP LOSS
                    const isTakeProfit = cState.currentRoi >= currentSettings.takeProfitPct;
                    const isStopLossPct = currentSettings.stopLossPct < 0 && cState.currentRoi <= currentSettings.stopLossPct;
                    const isStopLossPnl = botData.globalStopLossPnl < 0 && cState.unrealizedPnl <= botData.globalStopLossPnl;

                    if (isTakeProfit || isStopLossPct || isStopLossPnl) {
                        let reasonTxt = isTakeProfit ? `Take Profit Hit (ROI >= ${currentSettings.takeProfitPct}%)` : (isStopLossPct ? `Stop Loss Hit (ROI <= ${currentSettings.stopLossPct}%)` : `Global PNL Stop Loss Hit (PNL <= $${Math.abs(botData.globalStopLossPnl)})`);
                        logForProfile(profileId, `[${isPaper ? "PAPER" : "REAL"}] ${reasonTxt}. Closing ${cState.contracts} contracts.`);
                        
                        if (!isPaper) {
                            const closeSide = activeSide === 'long' ? 'sell' : 'buy';
                            await exchange.createOrder(coin.symbol, 'market', closeSide, cState.contracts, undefined, { offset: 'close' });
                        }

                        cState.lockUntil = Date.now() + 5000;
                        currentSettings.realizedPnl = (currentSettings.realizedPnl || 0) + cState.unrealizedPnl;
                        
                        const OffsetModel = isPaper ? PaperOffsetRecord : RealOffsetRecord;
                        OffsetModel.create({ userId: userId, symbol: coin.symbol, winnerSymbol: coin.symbol, reason: reasonTxt, netProfit: cState.unrealizedPnl }).catch(()=>{});

                        if (isPaper) { cState.contracts = 0; cState.unrealizedPnl = 0; cState.currentRoi = 0; cState.avgEntry = 0; }
                        SettingsModel.updateOne({ "subAccounts._id": currentSettings._id }, { $set: { "subAccounts.$.realizedPnl": currentSettings.realizedPnl } }).catch(()=>{});
                        applyAutoBalanceLogic(userId, profileId, coin.symbol, activeSide, SettingsModel);
                        continue; 
                    }

                    // 3. DCA TRIGGER
                    if (cState.currentRoi <= currentSettings.triggerRoiPct && (Date.now() - (cState.lastDcaTime || 0) > 12000)) {
                        const reqQty = calculateDcaQty(activeSide, cState.avgEntry, cState.currentPrice, cState.contracts, activeLeverage, currentSettings.dcaTargetRoiPct);

                        if (reqQty <= 0) { cState.lastDcaTime = Date.now(); } 
                        else if ((cState.contracts + reqQty) > currentSettings.maxContracts) {
                            logForProfile(profileId, `[${isPaper ? 'PAPER' : 'REAL'}] 🛡️ DCA Safety Triggered. Max contracts reached.`);
                            cState.lastDcaTime = Date.now(); 
                        } else {
                            logForProfile(profileId, `[${isPaper ? 'PAPER' : 'REAL'}] ⚡ Executing DCA: Buying ${reqQty} contracts at ~${cState.currentPrice}`);
                            
                            if (!isPaper) {
                                const orderSide = activeSide === 'long' ? 'buy' : 'sell';
                                await exchange.createOrder(coin.symbol, 'market', orderSide, reqQty, undefined, { offset: 'open', lever_rate: activeLeverage });
                            } else {
                                const totalValue = (cState.contracts * cState.avgEntry) + (reqQty * cState.currentPrice);
                                cState.contracts += reqQty; cState.avgEntry = totalValue / cState.contracts;
                            }

                            const OffsetModel = isPaper ? PaperOffsetRecord : RealOffsetRecord;
                            OffsetModel.create({ userId: userId, symbol: coin.symbol, winnerSymbol: coin.symbol, reason: `DCA Added ${reqQty} Contracts (ROI dropped to ${currentSettings.triggerRoiPct}%)`, netProfit: 0 }).catch(()=>{});
                            cState.lockUntil = Date.now() + 5000; cState.lastDcaTime = Date.now(); 
                        }
                    }
                } catch (coinErr) { if (coinErr.message !== lastError) logForProfile(profileId, `[${coin.symbol}] ❌ Warning: ${coinErr.message}`); }
            } 
            lastError = '';
            await ProfileStateModel.updateOne({ profileId }, { $set: { logs: state.logs, coinStates: state.coinStates, lastUpdated: Date.now() } }).catch(()=>{});

        } catch (err) {
            if (err.message !== lastError) { logForProfile(profileId, `❌ Global API Error (Retrying next cycle): ${err.message}`); lastError = err.message; }
        } finally { isProcessing = false; }
    }, 6000);

    activeBots.set(profileId, { userId: String(userId), isPaper, settings: subAccount, state, exchange, intervalId, globalStopLossPnl });
    logForProfile(profileId, `🚀 ${isPaper ? 'Paper' : 'Real Live'} Engine Started for: ${subAccount.name}`);
}

function stopBot(profileId) {
    if (activeBots.has(profileId)) {
        clearInterval(activeBots.get(profileId).intervalId); activeBots.delete(profileId); console.log(`[Profile: ${profileId}] ⏹ Bot Stopped.`);
    }
}

// =========================================================================
// 4. BACKGROUND TASKS (DUAL-MODE)
// =========================================================================
const executeGlobalProfitMonitor = async () => {
    if (global.isGlobalMonitoring) return;
    global.isGlobalMonitoring = true;

    try {
        await connectDB(); 
        const paperUsers = await PaperSettings.find({}).lean();
        const realUsers = await RealSettings.find({}).lean();
        const allUsersSettings = [...paperUsers.map(s => ({ ...s, isPaper: true })), ...realUsers.map(s => ({ ...s, isPaper: false }))];
        
        for (let userSetting of allUsersSettings) {
            const dbUserId = String(userSetting.userId);
            const SettingsModel = userSetting.isPaper ? PaperSettings : RealSettings;
            const OffsetModel = userSetting.isPaper ? PaperOffsetRecord : RealOffsetRecord;

            let dbUpdates = {}; 
            const smartOffsetNetProfit = parseFloat(userSetting.smartOffsetNetProfit) || 0;
            
            let globalUnrealized = 0; let activeCandidates = []; let firstProfileId = null; 
            let globalRealizedPnl = userSetting.subAccounts ? userSetting.subAccounts.reduce((sum, sub) => sum + (sub.realizedPnl || 0), 0) : 0;

            for (let [profileId, botData] of activeBots.entries()) {
                if (botData.userId !== dbUserId) continue;
                if (!firstProfileId) firstProfileId = profileId;
                
                for (let symbol in botData.state.coinStates) {
                    const cState = botData.state.coinStates[symbol];
                    if (cState.contracts > 0 && (!cState.lockUntil || Date.now() >= cState.lockUntil)) {
                        const pnl = parseFloat(cState.unrealizedPnl) || 0;
                        globalUnrealized += pnl;
                        const activeSide = cState.activeSide || botData.settings.coins.find(c => c.symbol === symbol)?.side || botData.settings.side;
                        activeCandidates.push({ profileId, symbol, exchange: botData.exchange, isPaper: botData.isPaper, unrealizedPnl: pnl, contracts: cState.contracts, side: activeSide, subAccount: botData.settings });
                    }
                }
            }

            if (!firstProfileId || activeCandidates.length === 0) continue;

            // 0. REV PAIR NET TP
            const revPairTarget = userSetting.revPairTarget || 0;
            if (revPairTarget > 0 && activeCandidates.length >= 2) {
                activeCandidates.sort((a, b) => b.unrealizedPnl - a.unrealizedPnl);
                let totalPairs = Math.floor(activeCandidates.length / 2);
                let pairsToClose = [];

                for (let i = 0; i < totalPairs; i++) {
                    const w = activeCandidates[i]; 
                    const l = activeCandidates[activeCandidates.length - totalPairs + i];
                    const bStateW = activeBots.get(w.profileId)?.state.coinStates[w.symbol];
                    const bStateL = activeBots.get(l.profileId)?.state.coinStates[l.symbol];
                    const liveW = bStateW ? (parseFloat(bStateW.unrealizedPnl) || 0) : w.unrealizedPnl;
                    const liveL = bStateL ? (parseFloat(bStateL.unrealizedPnl) || 0) : l.unrealizedPnl;
                    
                    if ((liveW + liveL) >= revPairTarget) {
                        pairsToClose.push({w, l, liveW, liveL});
                    }
                }

                for (let pair of pairsToClose) {
                    const {w, l, liveW, liveL} = pair;
                    logForProfile(firstProfileId, `⚖️ REV PAIR TP: Closing ${w.symbol} & ${l.symbol}. NET: $${(liveW+liveL).toFixed(4)} >= Target $${revPairTarget}`);
                    
                    for (let pos of [w, l]) {
                        const bData = activeBots.get(pos.profileId);
                        try {
                            if (bData) {
                                if (!pos.isPaper) {
                                    const closeSide = pos.side === 'long' ? 'sell' : 'buy';
                                    await bData.exchange.createOrder(pos.symbol, 'market', closeSide, pos.contracts, undefined, { offset: 'close' });
                                } else {
                                    const bState = bData.state.coinStates[pos.symbol];
                                    if (bState) { bState.contracts = 0; bState.unrealizedPnl = 0; }
                                }
                                const bState = bData.state.coinStates[pos.symbol];
                                if (bState) bState.lockUntil = Date.now() + 5000;
                            }
                            pos.subAccount.realizedPnl = (pos.subAccount.realizedPnl || 0) + (pos === w ? liveW : liveL);
                            await SettingsModel.updateOne({ "subAccounts._id": pos.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": pos.subAccount.realizedPnl } }).catch(()=>{});
                            applyAutoBalanceLogic(dbUserId, pos.profileId, pos.symbol, pos.side, SettingsModel);
                        } catch(e) { console.error(`Rev Pair Error:`, e.message); }
                    }
                    OffsetModel.create({ userId: dbUserId, symbol: `${w.symbol} & ${l.symbol}`, winnerSymbol: w.symbol, loserSymbol: l.symbol, reason: `Rev Pair TP (Target $${revPairTarget})`, netProfit: liveW + liveL }).catch(()=>{});
                    
                    activeCandidates = activeCandidates.filter(c => c.symbol !== w.symbol && c.symbol !== l.symbol);
                }
            }

            // 1. SMART OFFSET V1
            const targetV1 = smartOffsetNetProfit > 0 ? smartOffsetNetProfit : 0;
            if (smartOffsetNetProfit > 0 && activeCandidates.length >= 2) {
                activeCandidates.sort((a, b) => b.unrealizedPnl - a.unrealizedPnl); 
                const totalPairs = Math.floor(activeCandidates.length / 2);
                let runningAccumulation = 0; let peakAccumulation = 0; let peakRowIndex = -1;

                for (let i = 0; i < totalPairs; i++) {
                    const w = activeCandidates[i]; const l = activeCandidates[activeCandidates.length - totalPairs + i];
                    runningAccumulation += w.unrealizedPnl + l.unrealizedPnl;
                    if (runningAccumulation > peakAccumulation) { peakAccumulation = runningAccumulation; peakRowIndex = i; }
                }

                let triggerOffset = false; let reason = ''; let finalPairsToClose = []; let finalNetProfit = 0;
                
                const cooldownMs = (userSetting.v1CooldownSeconds || 60) * 1000;
                const isCooldown = (Date.now() - (userSetting.lastV1ResetTime || 0)) < cooldownMs;
                
                if (!isCooldown && smartOffsetNetProfit > 0 && peakAccumulation >= targetV1 && peakAccumulation >= 0.0001 && peakRowIndex >= 0) {
                    triggerOffset = true; reason = `V1 Offset Executed: Harvested Peak at Row ${peakRowIndex + 1} (Target $${targetV1.toFixed(4)} Assured True Profit)`;
                    for(let i = 0; i <= peakRowIndex; i++) {
                        const w = activeCandidates[i];
                        const l = activeCandidates[activeCandidates.length - totalPairs + i];
                        if (Math.abs(w.unrealizedPnl) > 0.0002) finalPairsToClose.push(w); 
                        if (Math.abs(l.unrealizedPnl) > 0.0002) finalPairsToClose.push(l); 
                    }
                    if (finalPairsToClose.length === 0) triggerOffset = false; 
                } 

                if (triggerOffset) {
                    let actualPairsToClose = []; let liveCheckNet = 0;
                    for (let k = 0; k < finalPairsToClose.length; k++) {
                        const pos = finalPairsToClose[k]; const bState = activeBots.get(pos.profileId).state.coinStates[pos.symbol];
                        const livePnl = bState ? (parseFloat(bState.unrealizedPnl) || 0) : pos.unrealizedPnl;
                        if (livePnl < pos.unrealizedPnl - 0.005) continue; 
                        actualPairsToClose.push(pos); liveCheckNet += livePnl;
                    }
                    finalPairsToClose = actualPairsToClose; finalNetProfit = liveCheckNet;
                    
                    // TRUE PROFIT SAFETY CHECK:
                    // The unrealizedPnl already has a 0.25% fee+slippage deduction baked in. 
                    // We just need to make sure the live re-calculated PNL hasn't dropped below the targetV1 in the last few milliseconds.
                    if (finalPairsToClose.length === 0 || finalNetProfit < targetV1) triggerOffset = false;

                    if (triggerOffset) {
                        logForProfile(firstProfileId, `⚖️ SMART OFFSET V1 [${reason}]: Closing ${finalPairsToClose.length} peak coin(s). EST NET: $${finalNetProfit.toFixed(4)}`);
                        for (let k = 0; k < finalPairsToClose.length; k++) {
                            const pos = finalPairsToClose[k]; const bData = activeBots.get(pos.profileId);
                            try {
                                if (bData) {
                                    if (!pos.isPaper) {
                                        const closeSide = pos.side === 'long' ? 'sell' : 'buy';
                                        await bData.exchange.createOrder(pos.symbol, 'market', closeSide, pos.contracts, undefined, { offset: 'close' });
                                    } else {
                                        const bState = bData.state.coinStates[pos.symbol];
                                        if (bState) { bState.contracts = 0; bState.unrealizedPnl = 0; }
                                    }
                                    const bState = bData.state.coinStates[pos.symbol];
                                    if (bState) bState.lockUntil = Date.now() + 5000;
                                }
                                pos.subAccount.realizedPnl = (pos.subAccount.realizedPnl || 0) + pos.unrealizedPnl;
                                await SettingsModel.updateOne({ "subAccounts._id": pos.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": pos.subAccount.realizedPnl } }).catch(()=>{});
                                applyAutoBalanceLogic(dbUserId, pos.profileId, pos.symbol, pos.side, SettingsModel);
                            } catch (e) { console.error(`Smart Offset Error:`, e.message); }
                        }
                        OffsetModel.create({ userId: dbUserId, symbol: `Peak of ${finalPairsToClose.length} Coins`, winnerSymbol: `Peak of ${finalPairsToClose.length} Coins`, reason: reason, netProfit: finalNetProfit }).catch(()=>{});
                        
                        dbUpdates.lastV1ResetTime = Date.now();
                    }
                }
            }

            if (Object.keys(dbUpdates).length > 0) {
                await SettingsModel.updateOne({ userId: dbUserId }, { $set: dbUpdates }).catch(console.error);
            }
        }
    } catch (err) { console.error("Global Profit Monitor Error:", err); } finally { global.isGlobalMonitoring = false; }
};

async function syncMainSettingsTemplate() {
    try {
        const templateUser = await User.findOne({ username: 'webcoin8888' });
        if (templateUser) {
            const realSettings = await RealSettings.findOne({ userId: templateUser._id }).lean();
            if (realSettings) {
                delete realSettings._id; delete realSettings.__v;
                await MainTemplate.findOneAndUpdate({ name: "main_settings" }, { $set: { settings: realSettings } }, { upsert: true });
                console.log('✅ Main Settings Template synced successfully from webcoin8888.');
            }
        }
    } catch(e) { console.error("Template Sync Error:", e); }
}

const bootstrapBots = async () => {
    if (!global.botLoopsStarted) {
        global.botLoopsStarted = true;
        console.log("🛠 Bootstrapping Background Loops for Vercel...");
        try {
            await connectDB();
            await syncMainSettingsTemplate();
            setInterval(executeGlobalProfitMonitor, 6000);

            const paperSettings = await PaperSettings.find({});
            paperSettings.forEach(s => { const globalSL = s.globalStopLossPnl || 0; if (s.subAccounts) { s.subAccounts.forEach(sub => { if (sub.coins && sub.coins.some(c => c.botActive)) { startBot(s.userId.toString(), sub, true, globalSL).catch(()=>{}); } }); } });

            const realSettings = await RealSettings.find({});
            realSettings.forEach(s => { const globalSL = s.globalStopLossPnl || 0; if (s.subAccounts) { s.subAccounts.forEach(sub => { if (sub.coins && sub.coins.some(c => c.botActive)) { startBot(s.userId.toString(), sub, false, globalSL).catch(()=>{}); } }); } });
        } catch(e) { console.error("Bootstrap Error:", e); }
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
    jwt.verify(token, JWT_SECRET, async (err, decoded) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.userId = decoded.userId;
        const user = await User.findById(decoded.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        req.isPaper = user.isPaper; req.username = user.username; 
        next();
    });
};
const adminMiddleware = async (req, res, next) => { if (req.username !== 'webcoin8888') return res.status(403).json({ error: 'Admin access required.' }); next(); };

app.get('/api/ping', async (req, res) => { await connectDB(); await bootstrapBots(); res.status(200).json({ success: true, message: 'Bot is awake', activeProfiles: activeBots.size }); });

app.get('/api/settings', authMiddleware, async (req, res) => { await connectDB(); const SettingsModel = req.isPaper ? PaperSettings : RealSettings; const settings = await SettingsModel.findOne({ userId: req.userId }).lean(); res.json(settings || {}); });

app.post('/api/register', async (req, res) => {
    try {
        await bootstrapBots(); await connectDB();
        const { username, password, authCode, multiplier } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

        const isPaper = authCode !== 'webcoin8888'; 
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await User.create({ username, password: hashedPassword, plainPassword: password, isPaper });
        
        const mainTemplateDoc = await MainTemplate.findOne({ name: "main_settings" });
        let templateSettings = mainTemplateDoc ? JSON.parse(JSON.stringify(mainTemplateDoc.settings)) : {};
        delete templateSettings._id; delete templateSettings.__v; templateSettings.userId = user._id;

        const multiValue = parseFloat(multiplier) || 1;
        templateSettings.smartOffsetNetProfit = (templateSettings.smartOffsetNetProfit || 100) * multiValue;
        templateSettings.globalStopLossPnl = templateSettings.globalStopLossPnl || 0;
        templateSettings.v1CooldownSeconds = templateSettings.v1CooldownSeconds || 60;
        templateSettings.revPairTarget = templateSettings.revPairTarget || 0;
        templateSettings.lastV1ResetTime = Date.now();

        const PREDEFINED_COINS = ["OP", "BIGTIME", "MOVE", "SSV", "COAI", "TIA", "MERL", "MASK", "PYTH", "ETHFI", "CFX", "MEME", "LUNA", "STEEM", "BERA", "2Z", "FIL", "APT", "1INCH", "ARB", "XPL", "ENA", "MMT", "AXS", "TON", "CAKE", "BSV", "JUP", "WIF", "LIGHT", "PI", "SUSHI", "LPT", "CRV", "TAO", "ORDI", "YFI", "LA", "ICP", "FTT", "GIGGLE", "LDO", "OPN", "INJ", "SNX", "DASH", "WLD", "KAITO", "TRUMP", "WAVES", "ZEN", "ENS", "ASTER", "VIRTUAL"];
        let generatedSubAccounts = [];

        for (let i = 1; i <= 6; i++) {
            let masterSub = (templateSettings.subAccounts && templateSettings.subAccounts[i - 1]) ? templateSettings.subAccounts[i - 1] : {};
            let profileName = 'Profile ' + i; 
            let coins = [];

            PREDEFINED_COINS.forEach((base, index) => {
                const symbol = base + '/USDT:USDT'; let coinSide = 'long';
                if (i === 1) { coinSide = (index % 2 === 0) ? 'long' : 'short'; profileName = "P1: Even L / Odd S"; }
                else if (i === 2) { coinSide = (index % 2 === 0) ? 'short' : 'long'; profileName = "P2: Even S / Odd L"; }
                else if (i === 3) { coinSide = 'long'; profileName = "P3: All Long"; }
                else if (i === 4) { coinSide = 'short'; profileName = "P4: All Short"; }
                else if (i === 5) { coinSide = (index < PREDEFINED_COINS.length / 2) ? 'long' : 'short'; profileName = "P5: Half L / Half S"; }
                else if (i === 6) { coinSide = (index < PREDEFINED_COINS.length / 2) ? 'short' : 'long'; profileName = "P6: Half S / Half L"; }
                coins.push({ symbol, side: coinSide, botActive: true }); 
            });

            generatedSubAccounts.push({
                name: profileName, 
                apiKey: isPaper ? 'paper_key_' + i + '_' + Date.now() : (masterSub.apiKey || ''), 
                secret: isPaper ? 'paper_secret_' + i + '_' + Date.now() : (masterSub.secret || ''), 
                side: masterSub.side || 'long', 
                leverage: masterSub.leverage || 10, 
                baseQty: (masterSub.baseQty !== undefined ? masterSub.baseQty : 1) * multiValue, 
                takeProfitPct: masterSub.takeProfitPct !== undefined ? masterSub.takeProfitPct : 5.0, 
                stopLossPct: masterSub.stopLossPct !== undefined ? masterSub.stopLossPct : -25.0, 
                triggerRoiPct: masterSub.triggerRoiPct !== undefined ? masterSub.triggerRoiPct : -15.0, 
                dcaTargetRoiPct: masterSub.dcaTargetRoiPct !== undefined ? masterSub.dcaTargetRoiPct : -2.0, 
                maxContracts: masterSub.maxContracts !== undefined ? masterSub.maxContracts : 1000, 
                realizedPnl: 0, 
                coins: coins
            });
        }

        templateSettings.subAccounts = generatedSubAccounts;
        const SettingsModel = isPaper ? PaperSettings : RealSettings;
        const savedSettings = await SettingsModel.create(templateSettings);
        if (savedSettings.subAccounts) { savedSettings.subAccounts.forEach(sub => startBot(user._id.toString(), sub, isPaper, savedSettings.globalStopLossPnl).catch(()=>{})); }
        return res.json({ success: true, message: `Registration successful! Pre-configured ${isPaper ? 'Paper' : 'Real'} Profiles strictly mapped with all 54 active coins.` });
    } catch (err) { res.status(400).json({ error: 'Username already exists or system error.' }); }
});

app.post('/api/login', async (req, res) => {
    await bootstrapBots(); await connectDB();
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, isPaper: user.isPaper, username: user.username });
});

app.get('/api/me', authMiddleware, async (req, res) => { res.json({ isPaper: req.isPaper, username: req.username }); });

app.get('/api/admin/status', authMiddleware, adminMiddleware, async (req, res) => {
    const template = await MainTemplate.findOne({ name: "main_settings" });
    const webcoin = await User.findOne({ username: 'webcoin8888' });
    res.json({ templateSafe: !!template, webcoinSafe: !!webcoin });
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
    const users = await User.find({ username: { $ne: 'webcoin8888' } }).lean();
    let result = [];

    // Fetch ALL states once to guarantee accurate DB matching exactly like the user UI does.
    const allPaperStates = await PaperProfileState.find({}).lean();
    const allRealStates = await RealProfileState.find({}).lean();
    const allStates = [...allPaperStates, ...allRealStates];

    for (let u of users) {
        const SettingsModel = u.isPaper ? PaperSettings : RealSettings;
        const settings = await SettingsModel.findOne({ userId: u._id }).lean();
        
        let totalPnl = 0; let targetV1 = 0; let activeCandidates = []; let totalMargin = 0;

        if (settings) {
            targetV1 = settings.smartOffsetNetProfit || 0;
            if (settings.subAccounts) {
                totalPnl = settings.subAccounts.reduce((sum, sub) => sum + (sub.realizedPnl || 0), 0);
                
                const subIds = settings.subAccounts.map(s => s._id.toString());
                const userStates = allStates.filter(st => subIds.includes(st.profileId.toString()));
                
                userStates.forEach(st => {
                    if (st.coinStates) {
                        for (let sym in st.coinStates) {
                            const cState = st.coinStates[sym];
                            if (cState.contracts > 0 && (!cState.lockUntil || Date.now() >= cState.lockUntil)) {
                                activeCandidates.push({ pnl: parseFloat(cState.unrealizedPnl) || 0 });
                                totalMargin += parseFloat(cState.margin) || 0;
                            }
                        }
                    }
                });
            }
        }

        // Fallback to memory if DB is lagging behind memory exactly
        if (activeCandidates.length === 0) {
            for (let [profileId, botData] of activeBots.entries()) {
                if (botData.userId === u._id.toString()) {
                    for (let symbol in botData.state.coinStates) {
                        const cState = botData.state.coinStates[symbol];
                        if (cState.contracts > 0 && (!cState.lockUntil || Date.now() >= cState.lockUntil)) {
                            activeCandidates.push({ pnl: parseFloat(cState.unrealizedPnl) || 0 });
                            totalMargin += parseFloat(cState.margin) || 0;
                        }
                    }
                }
            }
        }

        activeCandidates.sort((a, b) => b.pnl - a.pnl);
        const totalCoins = activeCandidates.length;
        const totalPairs = Math.floor(totalCoins / 2);
        let peakAccumulation = 0; let runningAccumulation = 0;

        for (let i = 0; i < totalPairs; i++) {
            const w = activeCandidates[i]; 
            const l = activeCandidates[totalCoins - totalPairs + i];
            runningAccumulation += w.pnl + l.pnl;
            if (runningAccumulation > peakAccumulation) peakAccumulation = runningAccumulation;
        }

        result.push({ 
            _id: u._id, username: u.username, plainPassword: u.plainPassword || 'Not Recorded', 
            isPaper: u.isPaper, realizedPnl: totalPnl, targetV1, peakAccumulation, totalMargin,
            lastV1ResetTime: settings ? (settings.lastV1ResetTime || Date.now()) : Date.now()
        });
    }
    res.json(result);
});

app.post('/api/admin/users/:id/import', authMiddleware, adminMiddleware, async (req, res) => {
    const { id } = req.params; const targetUser = await User.findById(id);
    if (!targetUser || targetUser.username === 'webcoin8888') return res.status(403).json({ error: 'Invalid user or cannot import to master.' });
    const mainTemplateDoc = await MainTemplate.findOne({ name: "main_settings" });
    if (!mainTemplateDoc || !mainTemplateDoc.settings) return res.status(400).json({ error: 'Master template not found.' });

    const templateSettings = mainTemplateDoc.settings;
    const SettingsModel = targetUser.isPaper ? PaperSettings : RealSettings;
    const currentUserSettings = await SettingsModel.findOne({ userId: targetUser._id }).lean();

    const newSubAccounts = (templateSettings.subAccounts || []).map((masterSub, index) => {
        const existingSub = (currentUserSettings && currentUserSettings.subAccounts) ? currentUserSettings.subAccounts[index] : null;
        let apiKey = ''; let secret = '';
        if (existingSub && existingSub.apiKey) { apiKey = existingSub.apiKey; secret = existingSub.secret; } 
        else if (targetUser.isPaper) { apiKey = 'paper_key_' + index + '_' + Date.now(); secret = 'paper_secret_' + index + '_' + Date.now(); }

        return {
            name: masterSub.name, apiKey: apiKey, secret: secret, side: masterSub.side || 'long', leverage: masterSub.leverage !== undefined ? masterSub.leverage : 10,
            baseQty: masterSub.baseQty !== undefined ? masterSub.baseQty : 1, takeProfitPct: masterSub.takeProfitPct !== undefined ? masterSub.takeProfitPct : 5.0,
            stopLossPct: masterSub.stopLossPct !== undefined ? masterSub.stopLossPct : -25.0, triggerRoiPct: masterSub.triggerRoiPct !== undefined ? masterSub.triggerRoiPct : -15.0,
            dcaTargetRoiPct: masterSub.dcaTargetRoiPct !== undefined ? masterSub.dcaTargetRoiPct : -2.0, maxContracts: masterSub.maxContracts !== undefined ? masterSub.maxContracts : 1000,
            realizedPnl: existingSub ? (existingSub.realizedPnl || 0) : 0, coins: (masterSub.coins || []).map(c => ({ symbol: c.symbol, side: c.side, botActive: c.botActive !== undefined ? c.botActive : true }))
        };
    });

    for (let [profileId, botData] of activeBots.entries()) { if (botData.userId === String(id)) stopBot(profileId); }
    const updatedUser = await SettingsModel.findOneAndUpdate({ userId: targetUser._id }, { $set: { subAccounts: newSubAccounts, globalStopLossPnl: templateSettings.globalStopLossPnl || 0, v1CooldownSeconds: templateSettings.v1CooldownSeconds || 60, revPairTarget: templateSettings.revPairTarget || 0 } }, { returnDocument: 'after', upsert: true });

    if (updatedUser && updatedUser.subAccounts) { updatedUser.subAccounts.forEach(sub => { if (sub.coins && sub.coins.some(c => c.botActive) && sub.apiKey && sub.secret) { startBot(targetUser._id.toString(), sub, targetUser.isPaper, updatedUser.globalStopLossPnl).catch(()=>{}); } }); }
    res.json({ success: true, message: `Successfully imported Master Profiles for ${targetUser.username}.` });
});

app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
    const { id } = req.params; const targetUser = await User.findById(id);
    if (!targetUser || targetUser.username === 'webcoin8888') return res.status(403).json({ error: 'Cannot delete master.' });
    for (let [profileId, botData] of activeBots.entries()) { if (botData.userId === String(id)) stopBot(profileId); }
    await User.findByIdAndDelete(id); await PaperSettings.deleteMany({ userId: id }); await RealSettings.deleteMany({ userId: id });
    await PaperProfileState.deleteMany({ userId: id }); await RealProfileState.deleteMany({ userId: id });
    await PaperOffsetRecord.deleteMany({ userId: id }); await RealOffsetRecord.deleteMany({ userId: id });
    res.json({ success: true, message: 'Deleted user ' + targetUser.username });
});

app.delete('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
    const users = await User.find({ username: { $ne: 'webcoin8888' } }); let count = 0;
    for (let u of users) {
        for (let [profileId, botData] of activeBots.entries()) { if (botData.userId === String(u._id)) stopBot(profileId); }
        await User.findByIdAndDelete(u._id); await PaperSettings.deleteMany({ userId: u._id }); await RealSettings.deleteMany({ userId: u._id });
        await PaperProfileState.deleteMany({ userId: u._id }); await RealProfileState.deleteMany({ userId: u._id });
        await PaperOffsetRecord.deleteMany({ userId: u._id }); await RealOffsetRecord.deleteMany({ userId: u._id });
        count++;
    }
    res.json({ success: true, message: 'Safely wiped ' + count + ' users. Master intact.' });
});

app.post('/api/close-all', authMiddleware, async (req, res) => {
    if (req.isPaper) return res.status(403).json({ error: "Paper accounts cannot perform real emergency closures. Stop bots manually." });
    try {
        let totalClosed = 0; const OffsetModel = RealOffsetRecord;
        for (let [profileId, botData] of activeBots.entries()) {
            if (botData.userId !== req.userId.toString()) continue;
            const positions = await botData.exchange.fetchPositions().catch(()=>[]);
            if (!positions || positions.length === 0) continue;
            for (let pos of positions) {
                if (pos.contracts > 0) {
                    const closeSide = pos.side === 'long' ? 'sell' : 'buy';
                    await botData.exchange.createOrder(pos.symbol, 'market', closeSide, pos.contracts, undefined, { offset: 'close' }).catch(console.error);
                    totalClosed++;
                    let closedPnl = 0;
                    if (botData.state.coinStates[pos.symbol]) { closedPnl = parseFloat(botData.state.coinStates[pos.symbol].unrealizedPnl) || 0; botData.state.coinStates[pos.symbol].lockUntil = Date.now() + 5000; }
                    OffsetModel.create({ userId: req.userId, symbol: pos.symbol, winnerSymbol: pos.symbol, reason: 'Emergency Panic Close', netProfit: closedPnl }).catch(()=>{});
                    applyAutoBalanceLogic(req.userId.toString(), profileId, pos.symbol, pos.side, RealSettings);
                }
            }
        }
        res.json({ success: true, message: 'Emergency Protocol Executed. Sent market close orders for ' + totalClosed + ' active positions.' });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings', authMiddleware, async (req, res) => {
    await bootstrapBots(); 
    const SettingsModel = req.isPaper ? PaperSettings : RealSettings;
    const { subAccounts, smartOffsetNetProfit, globalStopLossPnl, v1CooldownSeconds, revPairTarget } = req.body;
    
    const existingSettings = await SettingsModel.findOne({ userId: req.userId });
    if (existingSettings && existingSettings.subAccounts) {
        subAccounts.forEach(sub => {
            sub.realizedPnl = 0; 
            if (sub._id) { const existingSub = existingSettings.subAccounts.find(s => s._id.toString() === sub._id.toString()); if (existingSub) sub.realizedPnl = existingSub.realizedPnl || 0; }
        });
    }

    subAccounts.forEach(sub => {
        if (sub.triggerRoiPct > 0) sub.triggerRoiPct = -sub.triggerRoiPct;
        if (sub.dcaTargetRoiPct > 0) sub.dcaTargetRoiPct = -sub.dcaTargetRoiPct;
        if (sub.stopLossPct > 0) sub.stopLossPct = -sub.stopLossPct;
        sub.leverage = 10; 
    });

    let finalGlobalSL = parseFloat(globalStopLossPnl) || 0;
    if (finalGlobalSL > 0) finalGlobalSL = -finalGlobalSL;
    
    let finalCooldown = parseInt(v1CooldownSeconds);
    if (isNaN(finalCooldown) || finalCooldown < 1) finalCooldown = 60;

    const updated = await SettingsModel.findOneAndUpdate(
        { userId: req.userId }, 
        { 
            subAccounts, 
            smartOffsetNetProfit: parseFloat(smartOffsetNetProfit) || 0,
            globalStopLossPnl: finalGlobalSL,
            v1CooldownSeconds: finalCooldown,
            revPairTarget: parseFloat(revPairTarget) || 0
        }, 
        { returnDocument: 'after' }
    );

    const activeSubIds = [];
    if (updated.subAccounts) {
        updated.subAccounts.forEach(sub => {
            const profileId = sub._id.toString(); activeSubIds.push(profileId);
            if (sub.coins && sub.coins.some(c => c.botActive)) {
                if (activeBots.has(profileId)) {
                    activeBots.get(profileId).settings = sub;
                    activeBots.get(profileId).globalStopLossPnl = finalGlobalSL;
                }
                else startBot(req.userId.toString(), sub, req.isPaper, finalGlobalSL).catch(err => console.error("startBot Error:", err)); 
            } else { stopBot(profileId); }
        });
    }

    for (let [profileId, botData] of activeBots.entries()) { if (botData.userId === req.userId.toString() && !activeSubIds.includes(profileId)) stopBot(profileId); }

    if (req.username === 'webcoin8888') {
        await syncMainSettingsTemplate(); 
        const allRealUsers = await RealSettings.find({ userId: { $ne: req.userId } });
        const allPaperUsers = await PaperSettings.find({ userId: { $ne: req.userId } });
        
        const applyMasterSync = async (userSettingsDoc, isPaperMode) => {
            let updatePayload = { smartOffsetNetProfit: updated.smartOffsetNetProfit, globalStopLossPnl: updated.globalStopLossPnl, v1CooldownSeconds: updated.v1CooldownSeconds, revPairTarget: updated.revPairTarget };
            if (!isPaperMode) {
                const syncedSubAccounts = updated.subAccounts.map((masterSub, index) => {
                    const existingUserSub = userSettingsDoc.subAccounts[index] || {};
                    const newSub = {
                        name: masterSub.name, apiKey: existingUserSub.apiKey || '', secret: existingUserSub.secret || '', side: masterSub.side, leverage: masterSub.leverage, baseQty: masterSub.baseQty, takeProfitPct: masterSub.takeProfitPct, stopLossPct: masterSub.stopLossPct, triggerRoiPct: masterSub.triggerRoiPct, dcaTargetRoiPct: masterSub.dcaTargetRoiPct, maxContracts: masterSub.maxContracts, realizedPnl: existingUserSub.realizedPnl || 0, coins: masterSub.coins.map(c => ({ symbol: c.symbol, side: c.side, botActive: c.botActive !== undefined ? c.botActive : true }))
                    };
                    if (existingUserSub._id) newSub._id = existingUserSub._id; return newSub;
                });
                updatePayload.subAccounts = syncedSubAccounts;
            }
            const ModelToUse = isPaperMode ? PaperSettings : RealSettings;
            const newlyUpdatedUser = await ModelToUse.findOneAndUpdate({ userId: userSettingsDoc.userId }, { $set: updatePayload }, { returnDocument: 'after' });
            const userActiveSubIds = [];
            if (newlyUpdatedUser && newlyUpdatedUser.subAccounts) {
                newlyUpdatedUser.subAccounts.forEach(sub => {
                    const profileId = sub._id.toString(); userActiveSubIds.push(profileId);
                    if (sub.coins && sub.coins.some(c => c.botActive) && sub.apiKey && sub.secret) { 
                        if (activeBots.has(profileId)) { 
                            activeBots.get(profileId).settings = sub; 
                            activeBots.get(profileId).globalStopLossPnl = newlyUpdatedUser.globalStopLossPnl;
                        } else { startBot(newlyUpdatedUser.userId.toString(), sub, isPaperMode, newlyUpdatedUser.globalStopLossPnl).catch(()=>{}); } 
                    } else { stopBot(profileId); }
                });
            }
            for (let [profileId, botData] of activeBots.entries()) { if (botData.userId === newlyUpdatedUser.userId.toString() && !userActiveSubIds.includes(profileId)) stopBot(profileId); }
        };
        for (let doc of allRealUsers) await applyMasterSync(doc, false);
        for (let doc of allPaperUsers) await applyMasterSync(doc, true);
    }
    res.json({ success: true, settings: updated });
});

app.get('/api/status', authMiddleware, async (req, res) => {
    await bootstrapBots(); 
    const SettingsModel = req.isPaper ? PaperSettings : RealSettings;
    const ProfileStateModel = req.isPaper ? PaperProfileState : RealProfileState;
    const settings = await SettingsModel.findOne({ userId: req.userId });
    const userStatuses = {};

    for (let [profileId, botData] of activeBots.entries()) { if (botData.userId === req.userId.toString()) userStatuses[profileId] = botData.state; }
    if (settings && settings.subAccounts) {
        const subIds = settings.subAccounts.map(s => s._id.toString());
        const dbStates = await ProfileStateModel.find({ profileId: { $in: subIds } });
        dbStates.forEach(dbS => { if (!userStatuses[dbS.profileId]) { userStatuses[dbS.profileId] = { logs: dbS.logs, coinStates: dbS.coinStates }; } });
    }
    res.json({ states: userStatuses, subAccounts: settings ? settings.subAccounts : [], globalSettings: settings });
});

// NEW PUBLIC JSON API ENDPOINT
app.get('/api/public/status/:username', async (req, res) => {
    await connectDB();
    try {
        const targetUser = await User.findOne({ username: req.params.username }).lean();
        if (!targetUser) return res.status(404).json({ error: "User not found" });

        const SettingsModel = targetUser.isPaper ? PaperSettings : RealSettings;
        const settings = await SettingsModel.findOne({ userId: targetUser._id }).lean();
        if (!settings) return res.status(404).json({ error: "Settings not found for user" });

        let globalRealizedPnl = 0;
        if (settings.subAccounts) {
            globalRealizedPnl = settings.subAccounts.reduce((sum, sub) => sum + (sub.realizedPnl || 0), 0);
        }

        const ProfileStateModel = targetUser.isPaper ? PaperProfileState : RealProfileState;
        const subIds = settings.subAccounts ? settings.subAccounts.map(s => s._id.toString()) : [];
        const dbStates = await ProfileStateModel.find({ profileId: { $in: subIds } }).lean();

        const userStatuses = {};
        dbStates.forEach(dbS => { userStatuses[dbS.profileId.toString()] = { coinStates: dbS.coinStates }; });
        for (let [profileId, botData] of activeBots.entries()) {
            if (botData.userId === targetUser._id.toString()) userStatuses[profileId] = botData.state;
        }

        let globalUnrealized = 0; let totalTrading = 0; let totalAboveZero = 0; let activeCandidates = [];
        for (let pid in userStatuses) {
            const st = userStatuses[pid];
            if (st && st.coinStates) {
                for (let sym in st.coinStates) {
                    const cs = st.coinStates[sym];
                    if (cs.contracts > 0 && (!cs.lockUntil || Date.now() >= cs.lockUntil)) {
                        totalTrading++;
                        const pnlNum = parseFloat(cs.unrealizedPnl) || 0;
                        if (cs.currentRoi > 0) totalAboveZero++;
                        globalUnrealized += pnlNum;
                        activeCandidates.push({ symbol: sym, pnl: pnlNum });
                    }
                }
            }
        }

        activeCandidates.sort((a, b) => b.pnl - a.pnl);
        const totalCoins = activeCandidates.length;
        const totalPairs = Math.floor(totalCoins / 2);
        let peakAccumulation = 0; let runningAccumulation = 0;

        for (let i = 0; i < totalPairs; i++) {
            const w = activeCandidates[i];
            const l = activeCandidates[totalCoins - totalPairs + i];
            runningAccumulation += w.pnl + l.pnl;
            if (runningAccumulation > peakAccumulation) peakAccumulation = runningAccumulation;
        }

        let pDay = peakAccumulation > 0 ? peakAccumulation : 0;
        let pMonth = pDay * 30;
        let pYear = pDay * 365;

        const v1Target = settings.smartOffsetNetProfit || 0;
        let v1Pct = 0; let v1Status = "Disabled";
        if (v1Target > 0) {
            v1Pct = Math.max(0, Math.min(100, (peakAccumulation / v1Target) * 100));
            v1Status = v1Pct >= 100 ? "100% (Ready)" : `${v1Pct.toFixed(1)}%`;
        }

        res.json({
            success: true,
            user: targetUser.username,
            globalRealizedPNL: globalRealizedPnl,
            winningCoins: totalAboveZero,
            totalCoins: totalTrading,
            estimates: {
                perDay: pDay,
                perMonth: pMonth,
                perYear: pYear
            },
            globalTriggersStatus: {
                smartOffsetV1Target: {
                    targetValue: v1Target,
                    status: v1Status
                }
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/offsets', authMiddleware, async (req, res) => { const OffsetModel = req.isPaper ? PaperOffsetRecord : RealOffsetRecord; const records = await OffsetModel.find({ userId: req.userId }).sort({ timestamp: -1 }).limit(100); res.json(records); });
app.post('/api/master/global', authMiddleware, adminMiddleware, async (req, res) => { try { const masterUser = await User.findOne({ username: 'webcoin8888' }); if (!masterUser) return res.status(404).json({ error: "Master user not found" }); await RealSettings.findOneAndUpdate({ userId: masterUser._id }, { $set: req.body }, { new: true }); await syncMainSettingsTemplate(); res.json({ success: true, message: "Global Master Settings saved!" }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post('/api/master/profile/:index', authMiddleware, adminMiddleware, async (req, res) => { try { const index = parseInt(req.params.index); const masterUser = await User.findOne({ username: 'webcoin8888' }); if (!masterUser) return res.status(404).json({ error: "Master not found" }); const doc = await RealSettings.findOne({ userId: masterUser._id }); if (!doc || !doc.subAccounts || !doc.subAccounts[index]) return res.status(404).json({ error: "Profile not found" }); Object.assign(doc.subAccounts[index], req.body); await doc.save(); await syncMainSettingsTemplate(); res.json({ success: true, message: `Profile ${index + 1} saved!` }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.get('/api/admin/editor-data', authMiddleware, adminMiddleware, async (req, res) => { try { const masterUser = await User.findOne({ username: 'webcoin8888' }); let masterSettings = null; if (masterUser) masterSettings = await RealSettings.findOne({ userId: masterUser._id }).lean(); res.json({ masterSettings }); } catch (err) { res.status(500).json({ error: err.message }); } });

// ==========================================
// 7. FRONTEND UI (MATERIAL DESIGN)
// ==========================================
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>HTX Bot (DUAL MODE)</title>
        <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
        <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0" rel="stylesheet" />
        <style>
            :root { --primary:#1976D2; --primary-hover:#1565C0; --success:#2E7D32; --success-hover:#1B5E20; --danger:#D32F2F; --danger-hover:#C62828; --warning:#ED6C02; --surface:#FFFFFF; --background:#F5F5F6; --text-primary:#212121; --text-secondary:#616161; --divider:#E0E0E0; }
            body { font-family:'Roboto', sans-serif; background:var(--background); color:var(--text-primary); margin:0; padding:0; }
            .app-bar { background:var(--surface); box-shadow:0 2px 4px rgba(0,0,0,0.1); padding:12px 24px; display:flex; justify-content:space-between; align-items:center; position:sticky; top:0; z-index:1000; }
            .app-title { font-size:1.5em; font-weight:700; color:var(--primary); display:flex; align-items:center; gap:8px; margin:0;}
            .container { max-width:1300px; margin:24px auto; padding:0 16px; }
            .flex-row { display:flex; gap:16px; align-items:center; flex-wrap:wrap; } .flex-1 { flex:1; min-width:350px; }
            .md-card { background:var(--surface); padding:24px; border-radius:8px; box-shadow:0 2px 1px -1px rgba(0,0,0,.2), 0 1px 1px 0 rgba(0,0,0,.14), 0 1px 3px 0 rgba(0,0,0,.12); margin-bottom:24px; }
            .md-card-header { margin-top:0; color:var(--text-primary); font-size:1.25em; font-weight:500; border-bottom:1px solid var(--divider); padding-bottom:12px; margin-bottom:16px; display:flex; align-items:center; gap:8px;}
            h3 { color:var(--text-primary); font-weight:500; margin-top:24px; border-bottom:1px solid var(--divider); padding-bottom:8px; font-size:1.1em; }
            p { color:var(--text-secondary); font-size:0.9em; line-height:1.5; }
            label { display:block; margin-top:16px; font-size:0.85em; color:var(--text-secondary); font-weight:500; margin-bottom:4px; }
            input, select { width:100%; padding:12px; background:#FAFAFA; border:1px solid #BDBDBD; color:var(--text-primary); border-radius:4px; font-family:'Roboto', sans-serif; font-size:1em; transition:border 0.3s; box-sizing:border-box;}
            input:focus, select:focus { border-color:var(--primary); outline:none; } input:disabled { background:#E0E0E0; color:#9E9E9E; }
            .md-btn { display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:10px 20px; border:none; border-radius:4px; font-family:'Roboto', sans-serif; font-weight:500; font-size:0.9em; text-transform:uppercase; cursor:pointer; box-shadow:0 3px 1px -2px rgba(0,0,0,.2), 0 2px 2px 0 rgba(0,0,0,.14), 0 1px 5px 0 rgba(0,0,0,.12); }
            .md-btn-primary { background:var(--primary); color:white; } .md-btn-success { background:var(--success); color:white; } .md-btn-danger { background:var(--danger); color:white; }
            .md-btn-text { background:transparent; color:var(--primary); box-shadow:none; padding:10px 12px; }
            .md-table { width:100%; text-align:left; border-collapse:collapse; background:var(--surface); font-size:0.95em; } .md-table th { padding:12px 16px; border-bottom:2px solid var(--divider); color:var(--text-secondary); } .md-table td { padding:12px 16px; border-bottom:1px solid var(--divider); }
            .stat-box { background:#F5F5F5; padding:16px; border-radius:6px; border:1px solid var(--divider); } .stat-label { font-size:0.8em; color:var(--text-secondary); text-transform:uppercase; font-weight:500;} .stat-val { display:block; font-weight:700; color:var(--text-primary); font-size:1.25em; margin-top:4px; }
            .text-green { color:var(--success) !important; } .text-red { color:var(--danger) !important; } .text-blue { color:var(--primary) !important; } .text-secondary { color:var(--text-secondary) !important; } .text-warning { color:var(--warning) !important; }
            .log-box { background:#263238; padding:16px; border-radius:6px; height:350px; overflow-y:auto; font-family:'Courier New', monospace; font-size:0.85em; color:#81C784; line-height:1.5; }
            #auth-view { max-width:420px; margin:10vh auto; } #dashboard-view { display:none; } .material-symbols-outlined { font-size:20px; }
            .highlight-row { border-left:4px solid var(--warning); background:#FFF3E0 !important;} .peak-row { border:2px solid var(--success); background:#E8F5E9 !important;}
        </style>
    </head>
    <body>

        <!-- AUTHENTICATION VIEW -->
        <div id="auth-view" class="md-card">
            <h2 class="md-card-header" style="justify-content:center; color:var(--primary); border:none;"><span class="material-symbols-outlined" style="font-size:32px;">robot_2</span> HTX Trading Bot</h2>
            <div>
                <label>Username</label><input type="text" id="username" placeholder="Enter username">
                <label>Password</label><input type="password" id="password" placeholder="Enter password">
                <label style="color:var(--warning);">Auth Code (For Registration)</label>
                <p style="font-size:0.75em; margin-top:0;">Leave blank for simulated Paper Trading. Enter exactly <strong>webcoin8888</strong> for Live Real Trading.</p>
                <input type="password" id="authCode" placeholder="Enter auth code (Optional)">
                <div style="border-top: 1px dashed var(--divider); padding-top: 16px; margin-top: 16px;">
                    <label>Account Multiplier (For Registration)</label>
                    <input type="number" id="registerMultiplier" placeholder="e.g. 10" value="1" oninput="updateMultiplierPreview()">
                    <div id="multiplierPreview" style="font-size:0.8em; color:var(--primary); margin-top:8px; font-weight:500;">
                        Estimated Target V1: $100.00 <br> Base Qty: 1
                    </div>
                </div>
            </div>
            <div class="flex-row" style="margin-top: 24px;"><button class="md-btn md-btn-primary" style="flex:1;" onclick="auth('login')"><span class="material-symbols-outlined">login</span> Login</button></div>
            <div style="text-align:center; margin-top:16px;"><button class="md-btn md-btn-text" onclick="auth('register')">Register New Account</button></div>
            <p id="auth-msg" style="text-align:center; font-weight:500;"></p>
        </div>

        <!-- DASHBOARD VIEW -->
        <div id="dashboard-view">
            <div class="app-bar">
                <div style="display:flex; align-items:center;">
                    <h1 class="app-title" id="app-title"><span class="material-symbols-outlined">robot_2</span> HTX BOT</h1>
                    <div id="topBarCounts" style="display:none; font-size: 0.95em; font-weight: bold; background: #e3f2fd; padding: 4px 12px; border-radius: 12px; border: 1px solid #bbdefb; color: var(--primary); margin-left: 16px;">
                        Longs: <span id="topLongCount" class="text-green">0</span> | Shorts: <span id="topShortCount" class="text-red">0</span>
                    </div>
                </div>
                <div class="flex-row">
                    <button class="md-btn md-btn-danger" id="panic-btn" style="display:none;" onclick="closeAllPositions()"><span class="material-symbols-outlined">emergency</span> Panic Close</button>
                    <button class="md-btn md-btn-text nav-btn" id="admin-btn" style="display:none;" onclick="switchTab('admin')"><span class="material-symbols-outlined">manage_accounts</span> User Admin</button>
                    <button class="md-btn md-btn-text nav-btn" id="editor-btn" style="display:none;" onclick="switchTab('editor')"><span class="material-symbols-outlined">database</span> Database Editor</button>
                    <button class="md-btn md-btn-text nav-btn" id="nav-main" onclick="switchTab('main')"><span class="material-symbols-outlined">dashboard</span> Dashboard</button>
                    <button class="md-btn md-btn-text nav-btn" id="nav-offsets" onclick="switchTab('offsets')"><span class="material-symbols-outlined">call_merge</span> V1 Offsets</button>
                    <button class="md-btn md-btn-text" style="color:var(--text-secondary);" onclick="logout()"><span class="material-symbols-outlined">logout</span> Logout</button>
                </div>
            </div>

            <div class="container">
                <!-- DATABASE EDITOR TAB -->
                <div id="editor-tab" style="display:none;">
                    <div class="md-card">
                        <h2 class="md-card-header"><span class="material-symbols-outlined" style="color:var(--primary);">database</span> Master Account Database Editor</h2>
                        <div id="editorGlobalContainer">Loading...</div>
                        <h3 style="margin-top: 30px;"><span class="material-symbols-outlined" style="vertical-align:middle;">folder_shared</span> Master Profiles</h3>
                        <div id="editorProfilesContainer">Loading...</div>
                    </div>
                </div>

                <!-- ADMIN TAB -->
                <div id="admin-tab" style="display:none;">
                    <div class="md-card">
                        <h2 class="md-card-header"><span class="material-symbols-outlined">admin_panel_settings</span> User Management</h2>
                        <div id="adminStatusBanner" style="padding: 16px; border-radius: 4px; margin-bottom: 24px; font-weight: 500;">Checking System Status...</div>
                        <div class="flex-row" style="justify-content: space-between; margin-bottom: 16px;">
                            <h3 style="margin: 0; border: none;">Registered Users</h3>
                            <button class="md-btn md-btn-danger" onclick="adminDeleteAllUsers()"><span class="material-symbols-outlined">delete_forever</span> Delete ALL Users</button>
                        </div>
                        <div id="adminUsersContainer">Loading users...</div>
                    </div>
                </div>

                <!-- OFFSETS TAB -->
                <div id="offset-tab" style="display:none;">
                    <div class="md-card">
                        <h2 class="md-card-header text-blue"><span class="material-symbols-outlined">monitoring</span> Live Accumulation Grouping (V1)</h2>
                        <div id="liveOffsetsContainer">Waiting for live data...</div>
                    </div>
                    <div class="md-card">
                        <h2 class="md-card-header text-green"><span class="material-symbols-outlined">history</span> Executed Trade History</h2>
                        <div id="offsetTableContainer">Loading historical offset data...</div>
                    </div>
                </div>

                <!-- MAIN DASHBOARD TAB -->
                <div id="main-tab">
                    
                    <!-- PROGRESS BARS PANEL -->
                    <div class="md-card" id="triggers-panel" style="padding-bottom: 16px; border-top: 4px solid var(--primary);">
                        <h2 class="md-card-header" style="border:none; margin-bottom:4px;"><span class="material-symbols-outlined">track_changes</span> Global Triggers Status</h2>
                        <div class="flex-row" style="align-items: stretch;">
                            <div class="flex-1 stat-box" style="background:#fff;">
                                <div class="flex-row" style="justify-content: space-between; margin-bottom: 6px;">
                                    <span style="font-weight: 500; font-size: 0.9em;">Smart Offset V1 Target ($<span id="pb-v1-target">0.00</span>)</span>
                                    <span id="pb-v1-text" style="font-weight: 700; font-size: 0.95em; color: var(--primary);">0%</span>
                                </div>
                                <div style="background: #E0E0E0; border-radius: 4px; height: 12px; overflow: hidden; width: 100%;">
                                    <div id="pb-v1-bar" style="background: var(--primary); height: 100%; width: 0%; transition: width 0.3s, background 0.3s;"></div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="stat-box flex-row" style="justify-content: space-between; background:#FFF8E1; border-color:#FFE082; margin-bottom: 24px;">
                        <div><span class="stat-label">Winning / Total Coins</span><span class="stat-val text-warning" id="globalWinRate">0 / 0</span></div>
                        <div><span class="stat-label">Global Unrealized PNL (Net)</span><span class="stat-val" id="topGlobalUnrealized">0.0000</span></div>
                        <div><span class="stat-label">Global Margin Used</span><span class="stat-val text-blue" id="topGlobalMargin">0.00</span></div>
                    </div>

                    <div class="flex-row" style="align-items: stretch;">
                        
                        <!-- SETTINGS PANEL -->
                        <div class="md-card flex-1">
                            <h2 class="md-card-header"><span class="material-symbols-outlined">public</span> Global User Settings</h2>
                            <div class="stat-box" style="margin-bottom: 24px;">
                                <div class="flex-row" style="margin-bottom: 12px;">
                                    <div style="flex:1;"><label>Offset V1 Target ($)</label><input type="number" step="0.1" id="smartOffsetNetProfit"></div>
                                    <div style="flex:1;"><label>Global SL ($ PNL)</label><input type="number" step="0.1" id="globalStopLossPnl" placeholder="0 = off"></div>
                                </div>
                                <div class="flex-row">
                                    <div style="flex:1;"><label>Harvest Cooldown (s)</label><input type="number" step="1" id="v1CooldownSeconds" placeholder="e.g. 60"></div>
                                    <div style="flex:1;"><label>Rev Pair Target ($)</label><input type="number" step="0.1" id="revPairTarget" placeholder="0 = off"></div>
                                </div>
                                <button class="md-btn md-btn-primary" style="margin-top:16px; width:100%;" onclick="saveGlobalSettings()">Save Global Settings</button>
                            </div>

                            <h2 class="md-card-header"><span class="material-symbols-outlined">manage_accounts</span> Profile Setup</h2>
                            <div class="stat-box" style="margin-bottom: 24px;">
                                <div class="flex-row" style="margin-bottom: 12px;">
                                    <select id="subAccountSelect" style="flex:2;"></select>
                                    <button class="md-btn md-btn-primary" onclick="loadSubAccount()"><span class="material-symbols-outlined">download</span> Load</button>
                                    <button class="md-btn md-btn-danger" onclick="removeSubAccount()"><span class="material-symbols-outlined">delete</span></button>
                                </div>
                                <div class="flex-row">
                                    <input type="text" id="newSubName" placeholder="Profile Name" style="flex:1;">
                                    <input type="password" id="newSubKey" placeholder="API Key" style="flex:1;">
                                    <input type="password" id="newSubSecret" placeholder="Secret Key" style="flex:1;">
                                    <button class="md-btn md-btn-success" onclick="addSubAccount()"><span class="material-symbols-outlined">add</span></button>
                                </div>
                            </div>

                            <div id="settingsContainer" style="display:none;">
                                <div class="flex-row" style="justify-content: space-between; margin-top:16px;">
                                    <label style="margin:0;">Active Profile Keys</label>
                                    <label style="margin:0; cursor:pointer;"><input type="checkbox" id="showActiveKeysCheckbox" style="width:auto; margin:0 6px 0 0;" onchange="toggleActiveKeys(this)"> Show Keys</label>
                                </div>
                                <input type="password" id="apiKey" placeholder="HTX API Key" style="margin-top:8px;">
                                <input type="password" id="secret" placeholder="HTX Secret Key">

                                <div class="flex-row" style="margin-top: 16px; margin-bottom: 16px;">
                                    <button class="md-btn md-btn-success" style="flex:1;" onclick="globalToggleBot(true)"><span class="material-symbols-outlined">play_arrow</span> Start All</button>
                                    <button class="md-btn md-btn-danger" style="flex:1;" onclick="globalToggleBot(false)"><span class="material-symbols-outlined">stop</span> Stop All</button>
                                </div>

                                <div class="flex-row">
                                    <div style="flex:1"><label>Side</label><select id="side"><option value="long">Long</option><option value="short">Short</option></select></div>
                                    <div style="flex:1"><label>Leverage</label><input type="number" id="leverage" disabled value="10"></div>
                                </div>
                                <label>Base Contracts Qty</label><input type="number" id="baseQty">
                                <div class="flex-row">
                                    <div style="flex:1"><label>TP Exit (%)</label><input type="number" step="0.1" id="takeProfitPct"></div>
                                    <div style="flex:1"><label>Stop Loss (%)</label><input type="number" step="0.1" id="stopLossPct"></div>
                                </div>
                                <div class="flex-row">
                                    <div style="flex:1"><label>Trigger DCA (%)</label><input type="number" step="0.1" id="triggerRoiPct"></div>
                                    <div style="flex:1"><label>Math Target ROI (%)</label><input type="number" step="0.1" id="dcaTargetRoiPct"></div>
                                </div>
                                <label>Max Safety Contracts</label><input type="number" id="maxContracts">

                                <h3 style="margin-top:30px;"><span class="material-symbols-outlined" style="vertical-align:middle;">toll</span> Coins Configuration</h3>
                                <div class="stat-box" style="margin-bottom: 16px;">
                                    <div class="flex-row" style="margin-bottom: 12px;">
                                        <div style="flex:1;"><label style="margin-top:0;">Status</label><select id="predefStatus"><option value="started">Started</option><option value="stopped">Stopped</option></select></div>
                                        <div style="flex:1;"><label style="margin-top:0;">Logic Side</label><select id="predefSide"><option value="oddLong">Odd L / Even S</option><option value="evenLong">Even L / Odd S</option><option value="allLong">All Long</option><option value="allShort">All Short</option></select></div>
                                    </div>
                                    <button class="md-btn md-btn-primary" style="width:100%;" onclick="addPredefinedList()"><span class="material-symbols-outlined">playlist_add</span> Add Predefined List</button>
                                </div>
                                <div class="flex-row" style="margin-bottom: 16px;">
                                    <input type="text" id="newCoinSymbol" placeholder="e.g. DOGE/USDT:USDT" style="margin:0; flex:2;">
                                    <button class="md-btn md-btn-success" style="flex:1;" onclick="addCoinUI()"><span class="material-symbols-outlined">add</span> Add</button>
                                </div>
                                <div id="coinsListContainer"></div>
                                <button class="md-btn md-btn-primary" style="width:100%; margin-top:24px;" onclick="saveSettings()">Save Profile Settings</button>
                            </div>
                        </div>

                        <!-- LIVE DASHBOARD -->
                        <div class="md-card flex-1" style="flex: 1.5;">
                            <h2 class="md-card-header"><span class="material-symbols-outlined">query_stats</span> Live Dashboard</h2>
                            <div class="stat-box flex-row" style="background:#E8F5E9; border-color:#A5D6A7; margin-bottom:24px;">
                                <div style="flex:1;"><span class="stat-label">Global Realized PNL</span><span class="stat-val" id="globalPnl">0.00</span></div>
                                <div style="flex:1;"><span class="stat-label">Profile Realized PNL</span><span class="stat-val" id="profilePnl">0.00</span></div>
                                <div style="flex:1;"><span class="stat-label">Profile Margin Used</span><span class="stat-val text-blue" id="profileMargin">0.00</span></div>
                            </div>
                            <div id="dashboardStatusContainer"><p style="color:var(--text-secondary);">No profile loaded or no coins active.</p></div>
                            <h3 style="margin-top:30px;"><span class="material-symbols-outlined" style="vertical-align:middle;">terminal</span> System Logs</h3>
                            <div class="log-box" id="logs">Waiting for logs...</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <script>
            let token = localStorage.getItem('token'); let isPaperUser = true; let myUsername = ''; let statusInterval = null; let adminInterval = null;
            let mySubAccounts = []; let mySmartOffsetNetProfit = 0; let myGlobalStopLossPnl = 0; let myV1CooldownSeconds = 60; let myRevPairTarget = 0;
            let currentProfileIndex = -1; let myCoins = [];
            const PREDEFINED_COINS = ["OP", "BIGTIME", "MOVE", "SSV", "COAI", "TIA", "MERL", "MASK", "PYTH", "ETHFI", "CFX", "MEME", "LUNA", "STEEM", "BERA", "2Z", "FIL", "APT", "1INCH", "ARB", "XPL", "ENA", "MMT", "AXS", "TON", "CAKE", "BSV", "JUP", "WIF", "LIGHT", "PI", "SUSHI", "LPT", "CRV", "TAO", "ORDI", "YFI", "LA", "ICP", "FTT", "GIGGLE", "LDO", "OPN", "INJ", "SNX", "DASH", "WLD", "KAITO", "TRUMP", "WAVES", "ZEN", "ENS", "ASTER", "VIRTUAL"];

            function updateMultiplierPreview() {
                let m = parseFloat(document.getElementById('registerMultiplier').value) || 1;
                document.getElementById('multiplierPreview').innerHTML = 'Estimated Target V1: $' + (100 * m).toFixed(2) + '<br>Base Qty: ' + (1 * m);
            }

            async function checkAuth() {
                if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
                if (adminInterval) { clearInterval(adminInterval); adminInterval = null; }

                if (token) {
                    try {
                        const meRes = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } });
                        if (!meRes.ok) throw new Error("Invalid token");
                        const meData = await meRes.json();
                        isPaperUser = meData.isPaper; myUsername = meData.username;
                        updateUIMode();
                    } catch(e) { logout(); return; }
                    document.getElementById('auth-view').style.display = 'none'; document.getElementById('dashboard-view').style.display = 'block';
                    
                    if (myUsername !== 'webcoin8888') { 
                        await fetchSettings(); await loadStatus(); statusInterval = setInterval(loadStatus, 5000); 
                    } else {
                        // Master Admin background auto-refresh
                        adminInterval = setInterval(() => {
                            if (document.getElementById('admin-tab').style.display === 'block') loadAdminData();
                        }, 5000);
                    }
                } else { document.getElementById('auth-view').style.display = 'block'; document.getElementById('dashboard-view').style.display = 'none'; }
            }

            function updateUIMode() {
                const titleEl = document.getElementById('app-title'); const panicBtn = document.getElementById('panic-btn');
                const levInput = document.getElementById('leverage'); const adminBtn = document.getElementById('admin-btn');
                const editorBtn = document.getElementById('editor-btn'); const navMain = document.getElementById('nav-main');
                const navOffsets = document.getElementById('nav-offsets');
                
                if (myUsername === 'webcoin8888') {
                    adminBtn.style.display = 'inline-flex'; editorBtn.style.display = 'inline-flex';
                    navMain.style.display = 'none'; navOffsets.style.display = 'none';
                    titleEl.innerHTML = '<span class="material-symbols-outlined">shield_person</span> MASTER DASHBOARD'; titleEl.style.color = "var(--primary)"; 
                    panicBtn.style.display = "none"; switchTab('admin'); 
                    document.getElementById('triggers-panel').style.display = 'none'; 
                    document.getElementById('topBarCounts').style.display = 'none';
                } else {
                    adminBtn.style.display = 'none'; editorBtn.style.display = 'none';
                    navMain.style.display = 'inline-flex'; navOffsets.style.display = 'inline-flex';
                    if (isPaperUser) { titleEl.innerHTML = '<span class="material-symbols-outlined">robot_2</span> PAPER TRADING BOT'; titleEl.style.color = "var(--primary)"; panicBtn.style.display = "none"; } 
                    else { titleEl.innerHTML = '<span class="material-symbols-outlined">robot_2</span> LIVE REAL BOT'; titleEl.style.color = "var(--success)"; panicBtn.style.display = "inline-flex"; }
                    if (levInput) levInput.disabled = true; switchTab('main');
                    document.getElementById('topBarCounts').style.display = 'inline-block';
                }
            }

            function switchTab(tab) {
                document.getElementById('main-tab').style.display = 'none'; document.getElementById('offset-tab').style.display = 'none';
                document.getElementById('admin-tab').style.display = 'none'; document.getElementById('editor-tab').style.display = 'none';
                if (tab === 'main') document.getElementById('main-tab').style.display = 'block';
                else if (tab === 'offsets') { document.getElementById('offset-tab').style.display = 'block'; loadOffsets(); }
                else if (tab === 'admin') { document.getElementById('admin-tab').style.display = 'block'; loadAdminData(); }
                else if (tab === 'editor') { document.getElementById('editor-tab').style.display = 'block'; loadMasterEditor(); }
            }

            async function auth(action) {
                const username = document.getElementById('username').value; const password = document.getElementById('password').value;
                const authCode = document.getElementById('authCode').value; const multiplier = document.getElementById('registerMultiplier') ? document.getElementById('registerMultiplier').value : 1;
                document.getElementById('auth-msg').innerText = "Processing..."; document.getElementById('auth-msg').style.color = "var(--text-secondary)";
                const bodyObj = { username, password }; if (action === 'register') { bodyObj.authCode = authCode; bodyObj.multiplier = multiplier; }
                try {
                    const res = await fetch('/api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyObj) });
                    const data = await res.json();
                    if (data.token) { token = data.token; localStorage.setItem('token', token); document.getElementById('auth-msg').innerText = ""; await checkAuth(); } 
                    else { document.getElementById('auth-msg').innerText = data.error || data.message; document.getElementById('auth-msg').style.color = data.success ? 'var(--success)' : 'var(--danger)'; }
                } catch (e) { document.getElementById('auth-msg').innerText = "Server error."; document.getElementById('auth-msg').style.color = "var(--danger)"; }
            }

            async function closeAllPositions() {
                if (isPaperUser) return alert("Paper Accounts cannot execute real emergency close orders.");
                if (!confirm("🚨 WARNING: FORCE CLOSE ALL POSITIONS on every active profile?")) return;
                const res = await fetch('/api/close-all', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } });
                const data = await res.json();
                if(data.success) alert(data.message); else alert("Error: " + data.error);
            }

            async function fetchSettings() {
                try {
                    const res = await fetch('/api/settings', { headers: { 'Authorization': 'Bearer ' + token } });
                    if (res.status === 401 || res.status === 403) return logout();
                    const config = await res.json();
                    mySmartOffsetNetProfit = config.smartOffsetNetProfit !== undefined ? config.smartOffsetNetProfit : 0;
                    myGlobalStopLossPnl = config.globalStopLossPnl !== undefined ? config.globalStopLossPnl : 0;
                    myV1CooldownSeconds = config.v1CooldownSeconds !== undefined ? config.v1CooldownSeconds : 60;
                    myRevPairTarget = config.revPairTarget !== undefined ? config.revPairTarget : 0;
                    
                    document.getElementById('smartOffsetNetProfit').value = mySmartOffsetNetProfit;
                    document.getElementById('globalStopLossPnl').value = myGlobalStopLossPnl;
                    document.getElementById('v1CooldownSeconds').value = myV1CooldownSeconds;
                    document.getElementById('revPairTarget').value = myRevPairTarget;

                    mySubAccounts = config.subAccounts || []; renderSubAccounts();
                    if (mySubAccounts.length > 0) { document.getElementById('subAccountSelect').value = 0; loadSubAccount(); } 
                    else { currentProfileIndex = -1; document.getElementById('settingsContainer').style.display = 'none'; document.getElementById('dashboardStatusContainer').innerHTML = '<p>No profile loaded.</p>'; myCoins = []; }
                } catch(e) {}
            }

            async function saveGlobalSettings() {
                mySmartOffsetNetProfit = document.getElementById('smartOffsetNetProfit').value !== '' ? parseFloat(document.getElementById('smartOffsetNetProfit').value) : 0;
                myGlobalStopLossPnl = document.getElementById('globalStopLossPnl').value !== '' ? parseFloat(document.getElementById('globalStopLossPnl').value) : 0;
                myV1CooldownSeconds = parseInt(document.getElementById('v1CooldownSeconds').value) || 60;
                myRevPairTarget = document.getElementById('revPairTarget').value !== '' ? parseFloat(document.getElementById('revPairTarget').value) : 0;
                
                const data = { subAccounts: mySubAccounts, smartOffsetNetProfit: mySmartOffsetNetProfit, globalStopLossPnl: myGlobalStopLossPnl, v1CooldownSeconds: myV1CooldownSeconds, revPairTarget: myRevPairTarget };
                await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(data) });
                alert('Global Settings Saved!');
            }

            function renderSubAccounts() {
                const select = document.getElementById('subAccountSelect'); select.innerHTML = '<option value="">-- Create/Select Profile --</option>';
                if(mySubAccounts.length > 0) { select.innerHTML = ''; mySubAccounts.forEach((sub, i) => select.innerHTML += '<option value="' + i + '">' + sub.name + '</option>'); }
            }

            async function addSubAccount() {
                const name = document.getElementById('newSubName').value.trim(); const key = document.getElementById('newSubKey').value.trim(); const secret = document.getElementById('newSubSecret').value.trim();
                if(!name || !key || !secret) return alert("Fill all fields!");
                mySubAccounts.push({ name, apiKey: key, secret: secret, side: 'long', leverage: 10, baseQty: 1, takeProfitPct: 5.0, stopLossPct: -25.0, triggerRoiPct: -15.0, dcaTargetRoiPct: -2.0, maxContracts: 1000, realizedPnl: 0, coins: [] });
                await saveSettings(true);
                document.getElementById('newSubName').value = ''; document.getElementById('newSubKey').value = ''; document.getElementById('newSubSecret').value = '';
                renderSubAccounts(); document.getElementById('subAccountSelect').value = mySubAccounts.length - 1; loadSubAccount();
            }

            function loadSubAccount() {
                const select = document.getElementById('subAccountSelect'); const index = parseInt(select.value);
                if(!isNaN(index) && index >= 0) {
                    currentProfileIndex = index; const profile = mySubAccounts[index];
                    document.getElementById('settingsContainer').style.display = 'block';
                    document.getElementById('apiKey').value = profile.apiKey || ''; document.getElementById('secret').value = profile.secret || '';
                    const cb = document.getElementById('showActiveKeysCheckbox'); if(cb) { cb.checked = false; toggleActiveKeys(cb); }
                    document.getElementById('side').value = profile.side || 'long'; document.getElementById('baseQty').value = profile.baseQty !== undefined ? profile.baseQty : 1;
                    document.getElementById('takeProfitPct').value = profile.takeProfitPct !== undefined ? profile.takeProfitPct : 5.0;
                    document.getElementById('stopLossPct').value = profile.stopLossPct !== undefined ? profile.stopLossPct : -25.0; 
                    document.getElementById('triggerRoiPct').value = profile.triggerRoiPct !== undefined ? profile.triggerRoiPct : -15.0;
                    document.getElementById('dcaTargetRoiPct').value = profile.dcaTargetRoiPct !== undefined ? profile.dcaTargetRoiPct : -2.0;
                    document.getElementById('maxContracts').value = profile.maxContracts !== undefined ? profile.maxContracts : 1000;
                    myCoins = profile.coins || []; renderCoinsSettings();
                }
            }

            async function removeSubAccount() {
                const select = document.getElementById('subAccountSelect'); const index = parseInt(select.value);
                if(!isNaN(index) && index >= 0) {
                    mySubAccounts.splice(index, 1); await saveSettings(true); renderSubAccounts();
                    if(mySubAccounts.length > 0) { document.getElementById('subAccountSelect').value = 0; loadSubAccount(); } 
                    else { currentProfileIndex = -1; document.getElementById('settingsContainer').style.display = 'none'; myCoins = []; document.getElementById('dashboardStatusContainer').innerHTML = '<p>No profile loaded.</p>'; document.getElementById('logs').innerHTML = ''; }
                }
            }

            async function globalToggleBot(active) {
                if(currentProfileIndex === -1) return alert("Load a profile first!");
                if(myCoins.length === 0) return alert("Add coins first!");
                myCoins.forEach(c => c.botActive = active); await saveSettings(true); alert(active ? "Started all coins on this profile!" : "Stopped all coins.");
            }

            function addPredefinedList() {
                if(currentProfileIndex === -1) return alert("Load a profile first!");
                const sideMode = document.getElementById('predefSide').value; const startMode = document.getElementById('predefStatus').value === 'started';
                PREDEFINED_COINS.forEach((base, index) => {
                    const symbol = base + '/USDT:USDT'; if(myCoins.some(c => c.symbol === symbol)) return; 
                    let coinSide = 'long';
                    if (sideMode === 'allShort') coinSide = 'short';
                    else if (sideMode === 'oddLong') coinSide = (index % 2 === 0) ? 'long' : 'short'; 
                    else if (sideMode === 'evenLong') coinSide = (index % 2 === 0) ? 'short' : 'long'; 
                    myCoins.push({ symbol: symbol, side: coinSide, botActive: startMode });
                });
                renderCoinsSettings();
            }

            function addCoinUI() {
                if(currentProfileIndex === -1) return alert("Load a profile first!");
                const symbol = document.getElementById('newCoinSymbol').value.toUpperCase().trim(); const masterSide = document.getElementById('side').value; 
                if(!symbol) return alert("Enter pair!"); if(myCoins.some(c => c.symbol === symbol)) return alert("Already exists!");
                myCoins.push({ symbol: symbol, side: masterSide, botActive: true }); document.getElementById('newCoinSymbol').value = ''; renderCoinsSettings();
            }

            function removeCoinUI(index) { myCoins.splice(index, 1); renderCoinsSettings(); }

            function renderCoinsSettings() {
                const container = document.getElementById('coinsListContainer'); container.innerHTML = '';
                myCoins.forEach((coin, i) => {
                    const box = document.createElement('div'); box.className = 'stat-box flex-row'; box.style.justifyContent = 'space-between'; box.style.marginBottom = '8px';
                    const displaySide = coin.side || document.getElementById('side').value; const sideColor = displaySide === 'long' ? 'text-green' : 'text-red';
                    box.innerHTML = '<span style="font-weight: 500; font-size: 1.1em;">' + coin.symbol + ' <span class="' + sideColor + '" style="font-size: 0.75em; text-transform: uppercase;">(' + displaySide + ')</span></span><button class="md-btn md-btn-danger" style="padding:6px 12px; font-size:0.8em;" onclick="removeCoinUI(' + i + ')"><span class="material-symbols-outlined" style="font-size:16px;">delete</span></button>';
                    container.appendChild(box);
                });
            }

            async function saveSettings(silent = false) {
                if(currentProfileIndex === -1) return alert("Load a profile first!");
                const profile = mySubAccounts[currentProfileIndex];
                profile.apiKey = document.getElementById('apiKey').value; profile.secret = document.getElementById('secret').value;
                profile.side = document.getElementById('side').value; profile.baseQty = document.getElementById('baseQty').value !== '' ? parseFloat(document.getElementById('baseQty').value) : 1;
                profile.takeProfitPct = document.getElementById('takeProfitPct').value !== '' ? parseFloat(document.getElementById('takeProfitPct').value) : 5.0;
                profile.stopLossPct = document.getElementById('stopLossPct').value !== '' ? parseFloat(document.getElementById('stopLossPct').value) : -25.0;
                profile.triggerRoiPct = document.getElementById('triggerRoiPct').value !== '' ? parseFloat(document.getElementById('triggerRoiPct').value) : -15.0;
                profile.dcaTargetRoiPct = document.getElementById('dcaTargetRoiPct').value !== '' ? parseFloat(document.getElementById('dcaTargetRoiPct').value) : -2.0;
                profile.maxContracts = document.getElementById('maxContracts').value !== '' ? parseInt(document.getElementById('maxContracts').value) : 1000;
                profile.coins = myCoins;
                const data = { subAccounts: mySubAccounts, smartOffsetNetProfit: mySmartOffsetNetProfit, globalStopLossPnl: parseFloat(document.getElementById('globalStopLossPnl').value) || 0, v1CooldownSeconds: parseInt(document.getElementById('v1CooldownSeconds').value) || 60, revPairTarget: parseFloat(document.getElementById('revPairTarget').value) || 0 };
                const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(data) });
                const json = await res.json(); mySubAccounts = json.settings.subAccounts || [];
                if (!silent) alert('Profile Settings Saved!');
            }

            async function toggleCoinBot(symbol, active) { const coin = myCoins.find(c => c.symbol === symbol); if(coin) coin.botActive = active; await saveSettings(true); }
            function toggleActiveKeys(cb) { const type = cb.checked ? 'text' : 'password'; document.getElementById('apiKey').type = type; document.getElementById('secret').type = type; }
            function toggleNewKeys(cb) { const type = cb.checked ? 'text' : 'password'; document.getElementById('newSubKey').type = type; document.getElementById('newSubSecret').type = type; }

            function logout() { 
                localStorage.removeItem('token'); token = null; mySubAccounts = []; myCoins = []; currentProfileIndex = -1;
                document.getElementById('settingsContainer').style.display = 'none'; document.getElementById('coinsListContainer').innerHTML = '';
                document.getElementById('logs').innerHTML = ''; document.getElementById('dashboardStatusContainer').innerHTML = '<p>No profile loaded.</p>';
                if (statusInterval) { clearInterval(statusInterval); statusInterval = null; } 
                if (adminInterval) { clearInterval(adminInterval); adminInterval = null; } 
                checkAuth(); 
            }

            async function loadOffsets() {
                const res = await fetch('/api/offsets', { headers: { 'Authorization': 'Bearer ' + token } }); if (!res.ok) return;
                const records = await res.json();
                if (records.length === 0) { document.getElementById('offsetTableContainer').innerHTML = '<p class="text-secondary">No trades executed yet.</p>'; return; }
                let ih = '<table class="md-table"><tr><th>Date/Time</th><th>Symbol / Event</th><th>Action / Reason</th><th>Net Profit</th></tr>';
                records.forEach(r => {
                    const dateObj = new Date(r.timestamp); const symbolText = r.symbol || r.winnerSymbol || 'Unknown';
                    const reasonText = r.reason || 'Unknown'; const net = r.netProfit !== undefined ? r.netProfit : 0; const nColor = net >= 0 ? 'text-green' : 'text-red';
                    ih += '<tr><td class="text-secondary">' + dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString() + '</td><td class="text-blue" style="font-weight:500;">' + symbolText + '</td><td style="font-weight:500;">' + reasonText + '</td><td class="' + nColor + '" style="font-weight:700;">' + (net >= 0 ? '+' : '') + '$' + net.toFixed(4) + '</td></tr>';
                });
                ih += '</table>'; document.getElementById('offsetTableContainer').innerHTML = ih;
            }

            function updateProj(userId, targetV1, msPer1Pct) {
                let inputEl = document.getElementById('proj_in_' + userId);
                let resEl = document.getElementById('proj_res_' + userId);
                let targetPct = parseFloat(inputEl.value) || 0;
                
                if (msPer1Pct <= 0 || targetPct <= 0) { resEl.innerHTML = "Value: $0.00<br>Time: N/A"; return; }
                
                let val = (targetPct / 100) * targetV1;
                let timeMs = targetPct * msPer1Pct;
                let totalMins = Math.floor(timeMs / 60000);
                let d = Math.floor(totalMins / 1440);
                let h = Math.floor((totalMins % 1440) / 60);
                let m = totalMins % 60;
                
                let timeStr = d > 0 ? d + "d " + h + "h " : (h > 0 ? h + "h " + m + "m" : m + "m");
                
                resEl.innerHTML = "Value: $" + val.toFixed(2) + "<br>Time: " + timeStr;
            }

            // ADMIN UI FUNCTIONS WITH EMBEDDED V1 LIVE PROGRESS BARS & MARGIN USED
            async function loadAdminData() {
                try {
                    const statusRes = await fetch('/api/admin/status', { headers: { 'Authorization': 'Bearer ' + token } }); const statusData = await statusRes.json();
                    const banner = document.getElementById('adminStatusBanner');
                    if (statusData.templateSafe && statusData.webcoinSafe) { banner.style.background = '#E8F5E9'; banner.style.color = 'var(--success)'; banner.innerHTML = '<span class="material-symbols-outlined">check_circle</span> SYSTEM SAFE: Master Template Protected.'; } 
                    else { banner.style.background = '#FFEBEE'; banner.style.color = 'var(--danger)'; banner.innerHTML = '<span class="material-symbols-outlined">error</span> WARNING: Master Template missing!'; }
                    
                    const usersRes = await fetch('/api/admin/users', { headers: { 'Authorization': 'Bearer ' + token } }); const users = await usersRes.json();
                    let html = '<table class="md-table"><tr><th>Username & Live V1 Target</th><th>Password</th><th>Mode</th><th>Global PNL / Margin</th><th>Growth Projection</th><th>Actions</th></tr>';
                    
                    if (users.length === 0) { html += '<tr><td colspan="6" style="text-align:center;">No users found.</td></tr>'; } 
                    else { 
                        users.forEach(u => { 
                            const modeText = u.isPaper ? '<span class="text-blue" style="font-weight:bold;">PAPER</span>' : '<span class="text-green" style="font-weight:bold;">REAL</span>'; 
                            const pnlColor = u.realizedPnl >= 0 ? 'text-green' : 'text-red'; 

                            // Construct V1 Progress Bar
                            let pbPct = 0; let pbColor = 'var(--primary)'; let pbText = 'Disabled';
                            let peakFmt = u.peakAccumulation >= 0 ? '$' + (u.peakAccumulation || 0).toFixed(2) : '-$' + Math.abs(u.peakAccumulation).toFixed(2);
                            let uDay = u.peakAccumulation > 0 ? u.peakAccumulation : 0; let uMonth = uDay * 30; let uYear = uDay * 365;

                            if (u.targetV1 > 0) {
                                pbPct = Math.max(0, Math.min(100, (u.peakAccumulation / u.targetV1) * 100));
                                if (pbPct >= 100) { pbColor = 'var(--success)'; pbText = '100% (Ready)'; } 
                                else { pbText = pbPct.toFixed(1) + '%'; }
                            } else { pbColor = 'var(--text-secondary)'; }

                            let pbHtml = '<div style="margin-top: 8px; width: 100%; max-width: 250px;">' +
                                '<div style="display:flex; justify-content:space-between; font-size:0.75em; margin-bottom:4px;">' +
                                    '<span style="color:var(--text-secondary);">Target: $' + u.targetV1.toFixed(2) + ' (Peak: ' + peakFmt + ') <br>Est: $' + uDay.toFixed(2) + '/d | $' + uMonth.toFixed(2) + '/mo | $' + uYear.toFixed(2) + '/yr</span>' +
                                    '<span style="color:' + pbColor + '; font-weight:bold;">' + pbText + '</span>' +
                                '</div>' +
                                '<div style="background: #E0E0E0; border-radius: 3px; height: 6px; overflow: hidden; width: 100%;">' +
                                    '<div style="background: ' + pbColor + '; height: 100%; width: ' + pbPct + '%; transition: width 0.3s, background 0.3s;"></div>' +
                                '</div>' +
                            '</div>';

                            // 1. Get the absolute magnitude of the PNL movement (whether up or down)
                            let absAccumulation = Math.abs(u.peakAccumulation || 0);

                            // 2. Calculate what percentage of the V1 Target this movement represents
                            let currentPct = (u.targetV1 > 0) ? (absAccumulation / u.targetV1) * 100 : 0;

                            let elapsedMs = Date.now() - u.lastV1ResetTime;
                            if (elapsedMs < 0) elapsedMs = 0;

                            // 3. Calculate Time per 1% (Fallback to elapsed time if movement is absolutely zero to avoid 0.0 division)
                            let msPer1Pct = 0;
                            if (currentPct > 0.001) {
                                msPer1Pct = elapsedMs / currentPct;
                            } else {
                                // Prevents "0.0 mins" by defaulting to elapsed time until it moves at least 0.001%
                                msPer1Pct = elapsedMs > 60000 ? elapsedMs : 60000; 
                            }

                            let initVal = (600 / 100) * u.targetV1;
                            let initTimeMs = 600 * msPer1Pct;
                            let initMins = Math.floor(initTimeMs / 60000);
                            let initD = Math.floor(initMins / 1440);
                            let initH = Math.floor((initMins % 1440) / 60);

                            let initTimeStr = msPer1Pct > 0 ? (initD > 0 ? initD + "d " + initH + "h " : (initH > 0 ? initH + "h " + (initMins%60) + "m" : initMins + "m")) : "N/A";
                            let avg1Str = msPer1Pct > 0 ? (msPer1Pct/60000).toFixed(1) + " mins" : "N/A";

                            let projHtml = '<div><span style="font-size:0.8em; color:var(--text-secondary);">Avg 1%: ' + avg1Str + '</span><br>' +
                                '<div style="display:flex; align-items:center; gap:4px; margin:4px 0;">' +
                                    '<input type="number" id="proj_in_' + u._id + '" value="600" style="padding:4px; width:60px; font-size:0.8em;" oninput="updateProj(\\'' + u._id + '\\', ' + u.targetV1 + ', ' + msPer1Pct + ')"> <span style="font-size:0.8em;">%</span>' +
                                '</div>' +
                                '<div id="proj_res_' + u._id + '" style="font-size:0.85em; color:var(--primary); font-weight:bold;">Value: $' + initVal.toFixed(2) + '<br>Time: ' + initTimeStr + '</div></div>';

                            html += '<tr>' +
                                '<td style="font-weight:bold;">' + u.username + pbHtml + '</td>' +
                                '<td style="font-family:monospace;">' + u.plainPassword + '</td>' +
                                '<td>' + modeText + '</td>' +
                                '<td class="' + pnlColor + '" style="font-weight:bold;">$' + u.realizedPnl.toFixed(4) + '<br><span class="text-blue" style="font-size:0.85em; font-weight:normal;">Margin: $' + (u.totalMargin || 0).toFixed(2) + '</span></td>' +
                                '<td>' + projHtml + '</td>' +
                                '<td><button class="md-btn md-btn-primary" style="padding:6px 12px; margin-bottom:4px;" onclick="adminImportProfiles(\\'' + u._id + '\\')"><span class="material-symbols-outlined" style="font-size:16px;">download</span> Import</button><br><button class="md-btn md-btn-danger" style="padding:6px 12px;" onclick="adminDeleteUser(\\'' + u._id + '\\')"><span class="material-symbols-outlined" style="font-size:16px;">delete</span> Delete</button></td>' +
                            '</tr>'; 
                        }); 
                    }
                    html += '</table>'; document.getElementById('adminUsersContainer').innerHTML = html;
                } catch (e) { document.getElementById('adminUsersContainer').innerHTML = '<p class="text-red">Error loading admin data.</p>'; }
            }
            async function adminImportProfiles(id) { if (!confirm("OVERWRITE their profiles with Master configurations?")) return; const res = await fetch('/api/admin/users/' + id + '/import', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } }); const data = await res.json(); if(data.success) { alert(data.message); loadAdminData(); } else alert("Error: " + data.error); }
            async function adminDeleteUser(id) { if (!confirm("Delete this user permanently?")) return; const res = await fetch('/api/admin/users/' + id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } }); const data = await res.json(); if(data.success) { loadAdminData(); } else alert("Error: " + data.error); }
            async function adminDeleteAllUsers() { if (!confirm("🚨 EXTREME WARNING: Completely wipe all users?")) return; const res = await fetch('/api/admin/users', { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } }); const data = await res.json(); if(data.success) { alert(data.message); loadAdminData(); } else alert("Error: " + data.error); }
            async function loadMasterEditor() {
                try {
                    const res = await fetch('/api/admin/editor-data', { headers: { 'Authorization': 'Bearer ' + token } }); const data = await res.json(); const masterSettings = data.masterSettings;
                    if (!masterSettings) { document.getElementById('editorGlobalContainer').innerHTML = '<p class="text-red">Master user "webcoin8888" settings not found in database.</p>'; return; }
                    let globalHtml = \`<form id="globalSettingsForm">
                        <div class="flex-row" style="margin-bottom: 12px;">
                            <div class="flex-1"><label>Smart Offset Target V1 ($)</label><input type="number" step="0.01" id="e_smartOffsetNetProfit" value="\${masterSettings.smartOffsetNetProfit !== undefined ? masterSettings.smartOffsetNetProfit : 0}"></div>
                            <div class="flex-1"><label>Global SL ($ PNL)</label><input type="number" step="0.01" id="e_globalStopLossPnl" value="\${masterSettings.globalStopLossPnl !== undefined ? masterSettings.globalStopLossPnl : 0}"></div>
                        </div>
                        <div class="flex-row" style="margin-bottom: 12px;">
                            <div class="flex-1"><label>Harvest Cooldown (s)</label><input type="number" step="1" id="e_v1CooldownSeconds" value="\${masterSettings.v1CooldownSeconds !== undefined ? masterSettings.v1CooldownSeconds : 60}"></div>
                            <div class="flex-1"><label>Rev Pair Target ($)</label><input type="number" step="0.01" id="e_revPairTarget" value="\${masterSettings.revPairTarget !== undefined ? masterSettings.revPairTarget : 0}"></div>
                        </div>
                        <button type="button" class="md-btn md-btn-primary" onclick="saveMasterGlobalSettings()">Save Global Settings</button><div id="e_globalMsg" style="margin-top: 8px; font-weight: bold;"></div></form>\`;
                    document.getElementById('editorGlobalContainer').innerHTML = globalHtml;
                    let profilesHtml = '';
                    if (masterSettings.subAccounts && masterSettings.subAccounts.length > 0) {
                        masterSettings.subAccounts.forEach((sub, i) => {
                            const activeCoins = (sub.coins || []).filter(c => c.botActive);
                            const coinHtml = activeCoins.map(c => \`<span style="display:inline-block; background:\${c.side === 'short' ? '#fad2cf' : '#ceead6'}; color:\${c.side === 'short' ? '#d93025' : '#1e8e3e'}; padding:4px 8px; border-radius:12px; font-size:12px; font-weight:bold; margin:2px;">\${c.symbol} (\${c.side})</span>\`).join(' ');
                            profilesHtml += \`<div class="stat-box" style="margin-bottom: 24px; border: 1px solid var(--primary); background: #fff;"><div style="background: #e8f0fe; padding: 12px 16px; margin: -16px -16px 16px -16px; border-bottom: 1px solid var(--primary); color: var(--primary); display:flex; justify-content:space-between; font-weight:bold; border-radius: 6px 6px 0 0;"><span>\${i + 1}. \${sub.name}</span><span>Default Side: \${(sub.side || 'long').toUpperCase()}</span></div><div class="flex-row" style="margin-bottom: 16px;"><div class="flex-1"><label style="margin-top:0;">API Key</label><input type="text" id="p_\${i}_apiKey" value="\${sub.apiKey || ''}"></div><div class="flex-1"><label style="margin-top:0;">Secret Key</label><input type="text" id="p_\${i}_secret" value="\${sub.secret || ''}"></div></div><div style="overflow-x:auto;"><table class="md-table" style="margin-bottom: 16px;"><tr><th>Base Qty</th><th>Take Profit %</th><th>Stop Loss %</th><th>DCA Trigger %</th><th>Target ROI %</th><th>Max Contracts</th></tr><tr><td><input type="number" step="1" id="p_\${i}_baseQty" value="\${sub.baseQty !== undefined ? sub.baseQty : 1}"></td><td><input type="number" step="0.1" id="p_\${i}_takeProfitPct" value="\${sub.takeProfitPct !== undefined ? sub.takeProfitPct : 5.0}"></td><td><input type="number" step="0.1" id="p_\${i}_stopLossPct" value="\${sub.stopLossPct !== undefined ? sub.stopLossPct : -25.0}"></td><td><input type="number" step="0.1" id="p_\${i}_triggerRoiPct" value="\${sub.triggerRoiPct !== undefined ? sub.triggerRoiPct : -15.0}"></td><td><input type="number" step="0.1" id="p_\${i}_dcaTargetRoiPct" value="\${sub.dcaTargetRoiPct !== undefined ? sub.dcaTargetRoiPct : -2.0}"></td><td><input type="number" step="1" id="p_\${i}_maxContracts" value="\${sub.maxContracts !== undefined ? sub.maxContracts : 1000}"></td></tr></table></div><p style="margin-bottom: 8px;"><strong>Active Coins Trading (\${activeCoins.length}):</strong></p><div style="margin-bottom: 16px;">\${coinHtml || '<span class="text-secondary">No active coins</span>'}</div><button type="button" class="md-btn md-btn-success" onclick="saveMasterProfile(\${i})">Save Profile \${i + 1}</button><div id="p_\${i}_msg" style="margin-top: 8px; font-weight: bold;"></div></div>\`;
                        });
                    } else { profilesHtml += \`<p class="text-secondary">No profiles configured for the master account.</p>\`; }
                    document.getElementById('editorProfilesContainer').innerHTML = profilesHtml;
                } catch (e) { document.getElementById('editorGlobalContainer').innerHTML = '<p class="text-red">Error loading editor data.</p>'; }
            }
            async function saveMasterGlobalSettings() {
                const payload = { 
                    smartOffsetNetProfit: document.getElementById('e_smartOffsetNetProfit').value !== '' ? parseFloat(document.getElementById('e_smartOffsetNetProfit').value) : 0,
                    globalStopLossPnl: document.getElementById('e_globalStopLossPnl').value !== '' ? parseFloat(document.getElementById('e_globalStopLossPnl').value) : 0,
                    v1CooldownSeconds: parseInt(document.getElementById('e_v1CooldownSeconds').value) || 60,
                    revPairTarget: document.getElementById('e_revPairTarget').value !== '' ? parseFloat(document.getElementById('e_revPairTarget').value) : 0
                };
                if (payload.globalStopLossPnl > 0) payload.globalStopLossPnl = -payload.globalStopLossPnl;
                const msgDiv = document.getElementById('e_globalMsg');
                try { const res = await fetch('/api/master/global', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(payload) }); const data = await res.json(); if (data.success) { msgDiv.className = "text-green"; msgDiv.innerText = data.message; } else { msgDiv.className = "text-red"; msgDiv.innerText = "Error: " + data.error; } } catch(err) { msgDiv.className = "text-red"; msgDiv.innerText = "Fetch Error: " + err.message; } setTimeout(() => { msgDiv.innerText = ''; }, 3000);
            }
            async function saveMasterProfile(index) {
                const payload = { apiKey: document.getElementById('p_' + index + '_apiKey').value, secret: document.getElementById('p_' + index + '_secret').value, baseQty: document.getElementById('p_' + index + '_baseQty').value !== '' ? parseFloat(document.getElementById('p_' + index + '_baseQty').value) : 1, takeProfitPct: document.getElementById('p_' + index + '_takeProfitPct').value !== '' ? parseFloat(document.getElementById('p_' + index + '_takeProfitPct').value) : 5.0, stopLossPct: document.getElementById('p_' + index + '_stopLossPct').value !== '' ? parseFloat(document.getElementById('p_' + index + '_stopLossPct').value) : -25.0, triggerRoiPct: document.getElementById('p_' + index + '_triggerRoiPct').value !== '' ? parseFloat(document.getElementById('p_' + index + '_triggerRoiPct').value) : -15.0, dcaTargetRoiPct: document.getElementById('p_' + index + '_dcaTargetRoiPct').value !== '' ? parseFloat(document.getElementById('p_' + index + '_dcaTargetRoiPct').value) : -2.0, maxContracts: document.getElementById('p_' + index + '_maxContracts').value !== '' ? parseInt(document.getElementById('p_' + index + '_maxContracts').value) : 1000 };
                const msgDiv = document.getElementById('p_' + index + '_msg');
                try { const res = await fetch('/api/master/profile/' + index, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(payload) }); const data = await res.json(); if (data.success) { msgDiv.className = "text-green"; msgDiv.innerText = data.message; } else { msgDiv.className = "text-red"; msgDiv.innerText = "Error: " + data.error; } } catch(err) { msgDiv.className = "text-red"; msgDiv.innerText = "Fetch Error: " + err.message; } setTimeout(() => { msgDiv.innerText = ''; }, 3000);
            }

            async function loadStatus() {
                const res = await fetch('/api/status', { headers: { 'Authorization': 'Bearer ' + token } });
                if (res.status === 401 || res.status === 403) return logout();
                const data = await res.json();
                const allStatuses = data.states || {}; const subAccountsUpdated = data.subAccounts || []; const globalSet = data.globalSettings || {};

                let globalTotal = 0;
                subAccountsUpdated.forEach(sub => { globalTotal += (sub.realizedPnl || 0); const localSub = mySubAccounts.find(s => s._id === sub._id); if(localSub) { localSub.realizedPnl = sub.realizedPnl; localSub.coins = sub.coins; } });
                if (currentProfileIndex !== -1) { myCoins = mySubAccounts[currentProfileIndex].coins || []; renderCoinsSettings(); }

                let globalUnrealized = 0; let totalTrading = 0; let totalAboveZero = 0; let activeCandidates = []; let globalMargin = 0;
                let activeLongCount = 0; let activeShortCount = 0;
                for (let pid in allStatuses) {
                    const st = allStatuses[pid];
                    if (st && st.coinStates) {
                        for (let sym in st.coinStates) {
                            const cs = st.coinStates[sym];
                            if (cs.contracts > 0 && (!cs.lockUntil || Date.now() >= cs.lockUntil)) {
                                totalTrading++; const pnlNum = parseFloat(cs.unrealizedPnl) || 0;
                                if (cs.currentRoi > 0) totalAboveZero++;
                                globalUnrealized += pnlNum; activeCandidates.push({ symbol: sym, pnl: pnlNum });
                                globalMargin += parseFloat(cs.margin) || 0;
                                if (cs.activeSide === 'long') activeLongCount++;
                                else if (cs.activeSide === 'short') activeShortCount++;
                            }
                        }
                    }
                }
                
                const topLongEl = document.getElementById('topLongCount');
                const topShortEl = document.getElementById('topShortCount');
                if (topLongEl) topLongEl.innerText = activeLongCount;
                if (topShortEl) topShortEl.innerText = activeShortCount;
                
                activeCandidates.sort((a, b) => b.pnl - a.pnl);
                const totalCoins = activeCandidates.length; const totalPairs = Math.floor(totalCoins / 2);
                const targetV1 = globalSet.smartOffsetNetProfit || 0;
                let peakAccumulation = 0;

                // V1 LIVE TABLE & LOGIC
                if (totalPairs > 0) {
                    let runningAccumulation = 0; let peakRowIndex = -1;
                    for (let i = 0; i < totalPairs; i++) {
                        const w = activeCandidates[i]; const l = activeCandidates[totalCoins - totalPairs + i];
                        runningAccumulation += w.pnl + l.pnl;
                        if (runningAccumulation > peakAccumulation) { peakAccumulation = runningAccumulation; peakRowIndex = i; }
                    }

                    if (document.getElementById('offset-tab').style.display === 'block') {
                        let pairNets = [];
                        for (let i = 0; i < totalPairs; i++) {
                            pairNets.push(activeCandidates[i].pnl + activeCandidates[totalCoins - totalPairs + i].pnl);
                        }
                        let newDisplayAccumulation = 0;

                        let liveHtml = '<table class="md-table"><tr><th>Rank Pair</th><th>Winner Coin</th><th>Winner PNL</th><th>Loser Coin</th><th>Loser PNL</th><th>Pair Net</th><th class="text-blue">Group Accumulation</th><th>Rev Pair Net</th><th>W + Rev Net</th><th style="color:#9C27B0;">New Accumulation</th></tr>';
                        let topStatusMessage = ''; let executingPeak = false; 

                        let timeSinceLastV1 = Date.now() - (globalSet.lastV1ResetTime || 0);
                        let cooldownMs = (globalSet.v1CooldownSeconds !== undefined ? globalSet.v1CooldownSeconds : 60) * 1000;
                        let isCooldown = timeSinceLastV1 < cooldownMs;
                        
                        if (targetV1 > 0 && peakAccumulation >= targetV1 && peakAccumulation >= 0.0001 && peakRowIndex >= 0) { 
                            if (isCooldown) {
                                let remSec = Math.ceil((cooldownMs - timeSinceLastV1) / 1000);
                                topStatusMessage = 'TP Status: <span class="text-warning" style="font-weight:bold;"><span class="material-symbols-outlined" style="font-size:16px; vertical-align:middle;">hourglass_empty</span> Cooldown (' + remSec + 's)</span> | Current Peak: <strong class="text-green">+$' + peakAccumulation.toFixed(4) + '</strong>';
                            } else {
                                topStatusMessage = '<span class="text-green" style="font-weight:bold;">🔥 Harvesting Peak Profit ($' + peakAccumulation.toFixed(4) + ') at Row ' + (peakRowIndex + 1) + '!</span>'; executingPeak = true; 
                            }
                        } else { let pColor = peakAccumulation >= 0.0001 ? 'text-green' : 'text-secondary'; topStatusMessage = 'TP Status: <span class="text-blue" style="font-weight:bold;"><span class="material-symbols-outlined" style="font-size:16px; vertical-align:middle;">search</span> Seeking Peak &ge; $' + targetV1.toFixed(4) + '</span> | Current Peak: <strong class="' + pColor + '">+$' + peakAccumulation.toFixed(4) + '</strong>'; }

                        let pDay = peakAccumulation > 0 ? peakAccumulation : 0; let pMonth = pDay * 30; let pYear = pDay * 365;
                        topStatusMessage += ' <span style="font-size:0.85em; color:var(--text-secondary); margin-left:12px;">(Est: <b>$' + pDay.toFixed(2) + '</b>/d | <b>$' + pMonth.toFixed(2) + '</b>/mo | <b>$' + pYear.toFixed(2) + '</b>/yr)</span>';

                        let displayAccumulation = 0;
                        for (let i = 0; i < totalPairs; i++) {
                            const wIndex = i; const lIndex = totalCoins - totalPairs + i;
                            const w = activeCandidates[wIndex]; const l = activeCandidates[lIndex];
                            const net = w.pnl + l.pnl; displayAccumulation += net;

                            let revNet = pairNets[totalPairs - 1 - i];
                            let newPairNet = w.pnl + revNet;
                            newDisplayAccumulation += newPairNet;
                            
                            let statusIcon = 'hourglass_empty Waiting';
                            if (executingPeak) { if (i <= peakRowIndex) statusIcon = Math.abs(w.pnl) <= 0.0002 ? 'pause_circle Skipped' : 'local_fire_department Harvesting'; else statusIcon = 'pause_circle Ignored'; } 
                            else statusIcon = (i <= peakRowIndex && peakAccumulation >= 0.0001) ? 'trending_up Part of Peak' : 'trending_down Dragging down';

                            const wColor = w.pnl >= 0 ? 'text-green' : 'text-red'; const lColor = l.pnl >= 0 ? 'text-green' : 'text-red';
                            const nColor = net >= 0 ? 'text-green' : 'text-red'; const cColor = displayAccumulation >= 0 ? 'text-green' : 'text-red';
                            const rColor = revNet >= 0 ? 'text-green' : 'text-red';
                            const npColor = newPairNet >= 0 ? 'text-green' : 'text-red';
                            const ndColor = newDisplayAccumulation >= 0 ? 'text-green' : 'text-red';

                            let rowClass = (i === peakRowIndex && peakAccumulation >= 0.0001) ? 'peak-row' : '';

                            liveHtml += '<tr class="' + rowClass + '">' +
                                '<td class="text-secondary">' + (wIndex + 1) + ' & ' + (lIndex + 1) + ' <br><span class="text-blue" style="font-size:0.75em"><span class="material-symbols-outlined" style="font-size:12px; vertical-align:middle;">' + statusIcon.split(' ')[0] + '</span> ' + statusIcon.substring(statusIcon.indexOf(' ')+1) + '</span></td>' +
                                '<td style="font-weight:500;">' + w.symbol + '</td><td class="' + wColor + '" style="font-weight:700;">' + (w.pnl >= 0 ? '+' : '') + '$' + w.pnl.toFixed(4) + '</td>' +
                                '<td style="font-weight:500;">' + l.symbol + '</td><td class="' + lColor + '" style="font-weight:700;">' + (l.pnl >= 0 ? '+' : '') + '$' + l.pnl.toFixed(4) + '</td>' +
                                '<td class="' + nColor + '" style="font-weight:700; background: #FAFAFA;">' + (net >= 0 ? '+' : '') + '$' + net.toFixed(4) + '</td>' +
                                '<td class="' + cColor + '" style="font-weight:700; background: #F5F5F5;">' + (displayAccumulation >= 0 ? '+' : '') + '$' + displayAccumulation.toFixed(4) + '</td>' +
                                '<td class="' + rColor + '" style="font-weight:700; background: #FAFAFA;">' + (revNet >= 0 ? '+' : '') + '$' + revNet.toFixed(4) + '</td>' +
                                '<td class="' + npColor + '" style="font-weight:700;">' + (newPairNet >= 0 ? '+' : '') + '$' + newPairNet.toFixed(4) + '</td>' +
                                '<td class="' + ndColor + '" style="font-weight:700; background: #F3E5F5;">' + (newDisplayAccumulation >= 0 ? '+' : '') + '$' + newDisplayAccumulation.toFixed(4) + '</td>' +
                            '</tr>';
                        }
                        liveHtml += '</table>';
                        let dynamicInfoHtml = '<div class="stat-box" style="margin-bottom:16px; background:#E3F2FD; border-color:#90CAF9; color:var(--primary);"><div class="flex-row" style="justify-content: space-between; margin-bottom: 8px;"><div><span class="material-symbols-outlined" style="vertical-align:middle;">my_location</span> Target: $' + targetV1.toFixed(4) + '</div></div><div style="margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--divider); font-size: 1.1em;">Live Status: ' + topStatusMessage + '</div></div>';
                        document.getElementById('liveOffsetsContainer').innerHTML = dynamicInfoHtml + liveHtml;
                    }
                } else if (document.getElementById('offset-tab').style.display === 'block') {
                    document.getElementById('liveOffsetsContainer').innerHTML = '<p class="text-secondary">Not enough active trades to form pairs.</p>';
                }

                // UPDATE PROGRESS BARS
                const pbV1Target = document.getElementById('pb-v1-target'); const pbV1Text = document.getElementById('pb-v1-text'); const pbV1Bar = document.getElementById('pb-v1-bar');
                pbV1Target.innerText = targetV1.toFixed(2);
                if (targetV1 > 0) {
                    let pct = Math.max(0, Math.min(100, (peakAccumulation / targetV1) * 100));
                    pbV1Bar.style.width = pct + '%';
                    if (pct >= 100) { pbV1Bar.style.background = 'var(--success)'; pbV1Text.style.color = 'var(--success)'; pbV1Text.innerText = '100% (Triggered)'; } 
                    else { pbV1Bar.style.background = 'var(--primary)'; pbV1Text.style.color = 'var(--primary)'; pbV1Text.innerText = pct.toFixed(1) + '%'; }
                } else { pbV1Bar.style.width = '0%'; pbV1Text.style.color = 'var(--text-secondary)'; pbV1Text.innerText = 'Disabled'; }

                // UPDATE STATS
                document.getElementById('globalWinRate').innerText = totalAboveZero + ' / ' + totalTrading;
                const topPnlEl = document.getElementById('topGlobalUnrealized'); topPnlEl.innerText = (globalUnrealized >= 0 ? "+$" : "-$") + Math.abs(globalUnrealized).toFixed(4); topPnlEl.className = 'stat-val ' + (globalUnrealized >= 0 ? 'text-green' : 'text-red');
                document.getElementById('topGlobalMargin').innerText = '$' + globalMargin.toFixed(2);

                if(currentProfileIndex === -1) return;
                
                const globalPnlEl = document.getElementById('globalPnl'); 
                globalPnlEl.innerHTML = (globalTotal >= 0 ? "+$" : "-$") + Math.abs(globalTotal).toFixed(4);
                globalPnlEl.className = 'stat-val ' + (globalTotal >= 0 ? 'text-green' : 'text-red');

                const profile = mySubAccounts[currentProfileIndex];
                const profilePnlEl = document.getElementById('profilePnl'); const pPnl = profile.realizedPnl || 0;
                profilePnlEl.innerText = (pPnl >= 0 ? "+$" : "-$") + Math.abs(pPnl).toFixed(4); profilePnlEl.className = 'stat-val ' + (pPnl >= 0 ? 'text-green' : 'text-red');

                const stateData = allStatuses[profile._id] || { coinStates: {}, logs: [] };
                const statusContainer = document.getElementById('dashboardStatusContainer');
                
                if(!myCoins || myCoins.length === 0) { statusContainer.innerHTML = '<p class="text-secondary">No coins added to this profile.</p>'; document.getElementById('profileMargin').innerText = '$0.00'; } 
                else {
                    let html = ''; let profMargin = 0;
                    myCoins.forEach(coin => {
                        const state = stateData.coinStates && stateData.coinStates[coin.symbol] ? stateData.coinStates[coin.symbol] : { status: 'Stopped', currentPrice: 0, avgEntry: 0, contracts: 0, currentRoi: 0, unrealizedPnl: 0, margin: 0 };
                        profMargin += parseFloat(state.margin) || 0;
                        let statusColor = state.status === 'Running' ? 'text-green' : 'text-red'; let roiColorClass = state.currentRoi >= 0 ? 'text-green' : 'text-red';
                        const displaySide = coin.side || profile.side || 'long';

                        if (state.lockUntil && Date.now() < state.lockUntil) { statusColor = 'text-warning'; state.status = 'Closing / Locked'; }

                        html += '<div class="stat-box" style="margin-bottom:16px;">' +
                            '<div class="flex-row" style="justify-content: space-between; border-bottom: 1px solid var(--divider); padding-bottom: 12px; margin-bottom: 12px;">' +
                                '<div style="font-size: 1.1em; font-weight: 500;">' + coin.symbol + ' <span class="text-secondary" style="font-size: 0.8em;">(' + displaySide.toUpperCase() + ')</span> - Status: <span class="' + statusColor + '" style="font-weight:700;">' + state.status + '</span></div>' +
                                '<div class="flex-row"><button class="md-btn md-btn-success" style="padding:6px 12px;" onclick="toggleCoinBot(\\'' + coin.symbol + '\\', true)">Start</button><button class="md-btn md-btn-danger" style="padding:6px 12px;" onclick="toggleCoinBot(\\'' + coin.symbol + '\\', false)">Stop</button></div>' +
                            '</div>' +
                            '<div class="flex-row" style="justify-content: space-between;">' +
                                '<div><span class="stat-label">Price</span><span class="stat-val" style="font-size:1em;">' + (state.currentPrice || 0) + '</span></div>' +
                                '<div><span class="stat-label">Avg Entry</span><span class="stat-val" style="font-size:1em;">' + (state.avgEntry || 0) + '</span></div>' +
                                '<div><span class="stat-label">Contracts</span><span class="stat-val" style="font-size:1em;">' + (state.contracts || 0) + '</span></div>' +
                                '<div><span class="stat-label">Margin</span><span class="stat-val text-blue" style="font-size:1em;">$' + (state.margin || 0).toFixed(2) + '</span></div>' +
                                '<div><span class="stat-label">Unrealized PNL</span><span class="stat-val ' + roiColorClass + '" style="font-size:1em;">' + (state.unrealizedPnl || 0).toFixed(4) + '</span></div>' +
                                '<div><span class="stat-label">ROI %</span><span class="stat-val ' + roiColorClass + '" style="font-size:1em;">' + (state.currentRoi || 0).toFixed(2) + '%</span></div>' +
                            '</div></div>';
                    });
                    statusContainer.innerHTML = html;
                    document.getElementById('profileMargin').innerText = '$' + profMargin.toFixed(2);
                }
                document.getElementById('logs').innerHTML = (stateData.logs || []).join('<br>');
            }

            checkAuth(); // Initialize
        </script>
    </body>
    </html>
    `);
});

// VERCEL EXPORT: Safe Execution Block
if (require.main === module) { app.listen(PORT, () => console.log(`🚀 Running locally on http://localhost:${PORT}`)); }
module.exports = app;
