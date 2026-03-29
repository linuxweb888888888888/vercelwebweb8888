Here is the complete, fully updated Node.js file with the read-only strategy display cards integrated. 

You can replace your entire existing file with this code.

```javascript
const express = require('express');
const ccxt = require('ccxt');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const path = require('path');
const https = require('https');

// Safe Bcrypt Fallback for Vercel
let bcrypt;
try {
    bcrypt = require('bcryptjs');
} catch (err) {
    bcrypt = require('bcrypt');
}

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_this_in_production';

// DATABASE URL
const MONGO_URI = 'mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888';

// NEW MASTER COIN LIST (54 Coins)
const PREDEFINED_COINS = ["OP", "BIGTIME", "MOVE", "SSV", "COAI", "TIA", "MERL", "MASK", "PYTH", "ETHFI", "CFX", "MEME", "LUNA", "STEEM", "BERA", "2Z", "FIL", "APT", "1INCH", "ARB", "XPL", "ENA", "MMT", "AXS", "TON", "CAKE", "BSV", "JUP", "WIF", "LIGHT", "PI", "SUSHI", "LPT", "CRV", "TAO", "ORDI", "YFI", "LA", "ICP", "FTT", "GIGGLE", "LDO", "OPN", "INJ", "SNX", "DASH", "WLD", "KAITO", "TRUMP", "WAVES", "ZEN", "ENS", "ASTER", "VIRTUAL"];

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
// 2. MONGOOSE SCHEMAS (DUAL-MODE)
// ==========================================
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    plainPassword: { type: String }, 
    isPaper: { type: Boolean, default: true } 
});
const User = mongoose.models.User || mongoose.model('User', UserSchema);

const CoinSettingSchema = new mongoose.Schema({
    symbol: { type: String, required: true },
    side: { type: String, default: 'long' }, 
    botActive: { type: Boolean, default: true } 
});

const SubAccountSchema = new mongoose.Schema({
    name: { type: String, required: true },
    apiKey: { type: String, required: true },
    secret: { type: String, required: true },
    side: { type: String, default: 'long' }, 
    leverage: { type: Number, default: 10 },
    baseQty: { type: Number, default: 1 },
    takeProfitPct: { type: Number, default: 5.0 },
    takeProfitPnl: { type: Number, default: 0 },
    stopLossPct: { type: Number, default: -25.0 },
    triggerRoiPct: { type: Number, default: -15.0 },
    dcaTargetRoiPct: { type: Number, default: -2.0 },
    triggerDcaPnl: { type: Number, default: -2.0 }, 
    maxContracts: { type: Number, default: 1000 },
    realizedPnl: { type: Number, default: 0 },
    coins: [CoinSettingSchema]
});

const SettingsSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    qtyMultiplier: { type: Number, default: 1 },
    globalTargetPnl: { type: Number, default: 0 },       
    globalTrailingPnl: { type: Number, default: 0 },   
    globalSingleCoinTpPnl: { type: Number, default: 0 }, 
    globalSingleCoinSlPnl: { type: Number, default: 0 }, 
    globalTriggerDcaPnl: { type: Number, default: 0 }, 
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
    noPeakSlTimeframeSeconds: { type: Number, default: 1800 }, 
    noPeakSlGatePnl: { type: Number, default: 0 }, 
    subAccounts: [SubAccountSchema],
    
    currentGlobalPeak: { type: Number, default: 0 },
    lastStopLossTime: { type: Number, default: 0 },
    lastNoPeakSlTime: { type: Number, default: 0 },
    rollingStopLosses: { type: Array, default: [] },
    autoDynamicLastExecution: { type: Object, default: null }
});

// UNIVERSAL HISTORY SCHEMA
const OffsetRecordSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    symbol: { type: String }, 
    reason: { type: String }, 
    winnerSymbol: { type: String },
    winnerPnl: { type: Number },
    loserSymbol: { type: String },
    loserPnl: { type: Number },
    netProfit: { type: Number, required: true },
    timestamp: { type: Date, default: Date.now }
});

const ProfileStateSchema = new mongoose.Schema({
    profileId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    logs: { type: [String], default: [] },
    coinStates: { type: mongoose.Schema.Types.Mixed, default: {} },
    lastUpdated: { type: Date, default: Date.now }
});

const MainTemplateSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    settings: { type: Object, required: true }
});

// MULTI-MODE DB COLLECTIONS
const RealSettings = mongoose.models.Settings || mongoose.model('Settings', SettingsSchema, 'settings');
const PaperSettings = mongoose.models.PaperSettings || mongoose.model('PaperSettings', SettingsSchema, 'paper_settings');
const RealOffsetRecord = mongoose.models.OffsetRecord || mongoose.model('OffsetRecord', OffsetRecordSchema, 'offset_records');
const PaperOffsetRecord = mongoose.models.PaperOffsetRecord || mongoose.model('PaperOffsetRecord', OffsetRecordSchema, 'paper_offset_records');
const RealProfileState = mongoose.models.ProfileState || mongoose.model('ProfileState', ProfileStateSchema, 'profile_states');
const PaperProfileState = mongoose.models.PaperProfileState || mongoose.model('PaperProfileState', ProfileStateSchema, 'paper_profile_states');
const MainTemplate = mongoose.models.MainTemplate || mongoose.model('MainTemplate', MainTemplateSchema, 'main_settings_template');


// ==========================================
// CUSTOM LIVE LEVERAGE CHECK ORACLE
// ==========================================
global.customMaxLeverages = {};

function fetchCustomMaxLeveragesPromise() {
    return new Promise((resolve) => {
        console.log("🔍 Fetching Custom Max Leverages from HTX Public API...");
        const req = https.get('https://api.hbdm.com/linear-swap-api/v1/swap_cross_adjustfactor', (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    if (parsed && parsed.data) {
                        parsed.data.forEach(item => {
                            const symbol = item.contract_code.replace('-', '/') + ':USDT';
                            let maxL = 1;
                            if (item.list && item.list.length > 0) {
                                item.list.forEach(tier => {
                                    if (tier.lever_rate && tier.lever_rate > maxL) {
                                        maxL = tier.lever_rate;
                                    }
                                });
                            }
                            global.customMaxLeverages[symbol] = maxL;
                        });
                        console.log(`✅ Custom Max Leverages Synced! (Loaded ${Object.keys(global.customMaxLeverages).length} coins directly from HTX API)`);
                    }
                } catch (e) { 
                    console.error("Leverage Parse Error:", e.message); 
                }
                resolve();
            });
        });
        
        req.on('error', (e) => {
            console.error("Leverage Req Error:", e.message);
            resolve(); 
        });
        
        req.setTimeout(10000, () => {
            req.destroy();
            resolve();
        });
    });
}

function getLeverageForCoin(symbol) {
    if (global.customMaxLeverages && global.customMaxLeverages[symbol]) {
        return global.customMaxLeverages[symbol];
    }
    if (symbol.includes('BTC')) return 125;
    if (symbol.includes('ETH')) return 100;
    return 20; 
}

// ==========================================
// GLOBAL PRICE ORACLE (BINANCE + HTX)
// ==========================================
global.livePrices = global.livePrices || {};
let isBinanceFetching = false;
let isHtxFetching = false;

const binanceOracle = new ccxt.binance({ options: { defaultType: 'swap' }, enableRateLimit: true, timeout: 20000 });
const htxOracle = new ccxt.htx({ options: { defaultType: 'swap' }, enableRateLimit: true, timeout: 30000 });

function startPriceOracle() {
    console.log("🔮 Starting Global Price Oracle (Binance + HTX)...");
    
    setInterval(async () => {
        if (isBinanceFetching) return;
        isBinanceFetching = true;
        try {
            const tickers = await binanceOracle.fetchTickers();
            for (let sym in tickers) {
                if (tickers[sym] && tickers[sym].last) global.livePrices[sym] = tickers[sym].last;
            }
        } catch(e) { } finally { isBinanceFetching = false; }
    }, 3000);

    setInterval(async () => {
        if (isHtxFetching) return;
        isHtxFetching = true;
        try {
            const tickers = await htxOracle.fetchTickers();
            for (let sym in tickers) {
                if (tickers[sym] && tickers[sym].last) global.livePrices[sym] = tickers[sym].last; 
            }
        } catch(e) { } finally { isHtxFetching = false; }
    }, 5000);

    setInterval(() => {
        fetchCustomMaxLeveragesPromise();
    }, 3600000);
}


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

function calculateDcaQtyToHalveGap(currentContracts) {
    return currentContracts > 0 ? currentContracts : 1;
}

async function startBot(userId, subAccount, isPaper) {
    const userDoc = await User.findById(userId);
    if (userDoc && userDoc.username === 'webcoin8888') {
        console.log(`[Profile: ${subAccount._id}] 🛑 Engine Disabled: Master account (webcoin8888) is for database template editing only.`);
        return;
    }

    const profileId = subAccount._id.toString();
    if (activeBots.has(profileId)) stopBot(profileId);

    if (!subAccount.apiKey || !subAccount.secret) return;

    const exchange = new ccxt.htx({ 
        apiKey: subAccount.apiKey, 
        secret: subAccount.secret, 
        options: { defaultType: 'swap' },
        enableRateLimit: true,
        timeout: 30000 
    });
    
    const ProfileStateModel = isPaper ? PaperProfileState : RealProfileState;
    const SettingsModel = isPaper ? PaperSettings : RealSettings;

    let dbState = await ProfileStateModel.findOne({ profileId });
    if (!dbState) {
        dbState = await ProfileStateModel.create({ profileId, userId, logs: [], coinStates: {} });
    }
    
    const globalSettings = await SettingsModel.findOne({ userId });
    const state = { logs: dbState.logs || [], coinStates: dbState.coinStates || {} };
    let isProcessing = false;
    let lastError = '';

    const intervalId = setInterval(async () => {
        if (isProcessing) return; 
        isProcessing = true;

        const botData = activeBots.get(profileId);
        if (!botData) { isProcessing = false; return; }
        
        const currentSettings = botData.settings;
        
        let forcedStart = false;
        currentSettings.coins.forEach(c => {
            if (!c.botActive) {
                c.botActive = true;
                forcedStart = true;
            }
        });
        
        if (forcedStart) {
            logForProfile(profileId, `🔄 Auto-Healed: Restarted stopped coins to keep them active always.`);
            SettingsModel.updateOne(
                { "subAccounts._id": currentSettings._id },
                { $set: { "subAccounts.$.coins": currentSettings.coins } }
            ).catch(()=>{});
        }
        
        const activeCoins = currentSettings.coins;

        if (activeCoins.length === 0) { isProcessing = false; return; }

        try {
            if (!exchange.markets || Object.keys(exchange.markets).length === 0) {
                await exchange.loadMarkets().catch(()=>{});
            }
            
            let positions = [];
            if (!isPaper) {
                positions = await exchange.fetchPositions().catch(e => { throw new Error('Positions: ' + e.message); });
            }

            for (let coin of activeCoins) {
                try {
                    const activeLeverage = getLeverageForCoin(coin.symbol);
                    const activeSide = coin.side || currentSettings.side;
                    const market = exchange.markets ? exchange.markets[coin.symbol] : null;
                    const contractSize = (market && market.contractSize) ? market.contractSize : 1;

                    if (!state.coinStates[coin.symbol]) {
                        state.coinStates[coin.symbol] = { status: 'Running', currentPrice: 0, avgEntry: 0, contracts: 0, currentRoi: 0, unrealizedPnl: 0, margin: 0, lastDcaTime: 0, lockUntil: 0, dcaCount: 0 };
                    }

                    let cState = state.coinStates[coin.symbol];
                    if (cState.lockUntil && Date.now() < cState.lockUntil) continue;
                    
                    const currentPrice = global.livePrices[coin.symbol];
                    if (!currentPrice) continue; 
                    
                    cState.currentPrice = currentPrice;
                    cState.activeSide = activeSide;

                    const ESTIMATED_FEE_RATE = 0.001; 

                    if (!isPaper) {
                        const leveragePos = positions.find(p => p.symbol === coin.symbol);
                        let liveLeverage = activeLeverage;
                        if (leveragePos) {
                            if (leveragePos.info && leveragePos.info.lever_rate) {
                                liveLeverage = parseInt(leveragePos.info.lever_rate);
                            } else if (leveragePos.leverage) {
                                liveLeverage = parseInt(leveragePos.leverage);
                            }
                        }
                        cState.actualLeverage = liveLeverage;

                        const pos = positions.find(p => p.symbol === coin.symbol && p.side === activeSide && parseFloat(p.contracts || p.info?.volume || 0) > 0);

                        cState.contracts = pos ? parseFloat(pos.contracts || pos.info?.volume || 0) : 0;
                        cState.avgEntry = pos ? parseFloat(pos.entryPrice || 0) : 0;
                        if (cState.contracts === 0) cState.dcaCount = 0; 
                        
                        let grossPnl = 0;
                        if (pos) {
                            if (pos.unrealizedPnl !== undefined && pos.unrealizedPnl !== null) {
                                grossPnl = parseFloat(pos.unrealizedPnl);
                            } else {
                                grossPnl = (activeSide === 'long') 
                                    ? (cState.currentPrice - cState.avgEntry) * cState.contracts * contractSize 
                                    : (cState.avgEntry - cState.currentPrice) * cState.contracts * contractSize;
                            }
                        }

                        const positionValue = cState.contracts * contractSize * cState.currentPrice;
                        const estimatedFee = positionValue * ESTIMATED_FEE_RATE;

                        cState.unrealizedPnl = cState.contracts > 0 ? (grossPnl - estimatedFee) : 0;
                        
                        cState.margin = pos ? (parseFloat(pos.initialMargin) || parseFloat(pos.collateral) || 0) : 0;
                        if (cState.margin === 0 && cState.contracts > 0) {
                            cState.margin = (cState.contracts * contractSize * cState.avgEntry) / cState.actualLeverage;
                        }

                        cState.currentRoi = (cState.margin > 0 && cState.contracts > 0) ? (cState.unrealizedPnl / cState.margin) * 100 : 0; 
                        cState.status = cState.contracts > 0 ? 'In Position' : 'Waiting to Enter';
                    } else {
                        cState.actualLeverage = activeLeverage;
                        if (cState.contracts === 0) cState.dcaCount = 0; 
                        cState.status = cState.contracts > 0 ? 'In Position' : 'Waiting to Enter';
                        if (cState.contracts > 0) {
                            let margin = (cState.avgEntry * cState.contracts * contractSize) / activeLeverage;
                            let grossPnl = (activeSide === 'long') 
                                ? (cState.currentPrice - cState.avgEntry) * cState.contracts * contractSize 
                                : (cState.avgEntry - cState.currentPrice) * cState.contracts * contractSize;
                            
                            const positionValue = cState.contracts * contractSize * cState.currentPrice;
                            const estimatedFee = positionValue * ESTIMATED_FEE_RATE;

                            cState.unrealizedPnl = grossPnl - estimatedFee;
                            cState.margin = margin;
                            cState.currentRoi = margin > 0 ? (cState.unrealizedPnl / margin) * 100 : 0;
                        } else {
                            cState.unrealizedPnl = 0;
                            cState.margin = 0;
                            cState.currentRoi = 0;
                        }
                    }

                    // 1. OPEN BASE POSITION
                    if (cState.contracts <= 0) {
                        const safeBaseQty = Math.max(1, Math.floor(currentSettings.baseQty));
                        const modeTxt = isPaper ? "PAPER" : "REAL";
                        logForProfile(profileId, `[${modeTxt}] 🛒 Opening base position of ${safeBaseQty} contracts (${activeSide}) at ~${cState.currentPrice} using ${cState.actualLeverage}x Leverage.`);
                        
                        if (!isPaper) {
                            const orderSide = activeSide === 'long' ? 'buy' : 'sell';
                            await exchange.createOrder(coin.symbol, 'market', orderSide, safeBaseQty, undefined, { offset: 'open', lever_rate: cState.actualLeverage });
                        } else {
                            cState.avgEntry = cState.currentPrice; 
                            cState.contracts = safeBaseQty; 
                            cState.currentRoi = 0; 
                            cState.unrealizedPnl = 0; 
                            cState.margin = (cState.avgEntry * cState.contracts * contractSize) / activeLeverage;
                        }

                        const OffsetModel = isPaper ? PaperOffsetRecord : RealOffsetRecord;
                        OffsetModel.create({
                            userId: userId,
                            symbol: coin.symbol,
                            winnerSymbol: coin.symbol, 
                            reason: `Open Base Position (${safeBaseQty} contracts)`,
                            netProfit: 0
                        }).catch(()=>{});
                        
                        cState.lockUntil = Date.now() + 5000; 
                        continue; 
                    }

                    // 2. TAKE PROFIT OR STOP LOSS
                    let isTakeProfit = false;
                    let tpReasonTxt = '';
                    let isStopLoss = false;
                    let slReasonTxt = '';
                    
                    const globalTpPnlTarget = parseFloat(botData.globalSettings?.globalSingleCoinTpPnl) || 0;
                    const profileTpPnlTarget = parseFloat(currentSettings.takeProfitPnl) || 0;
                    const tpPnlTarget = globalTpPnlTarget > 0 ? globalTpPnlTarget : profileTpPnlTarget;
                    
                    const globalSlPnlTarget = parseFloat(botData.globalSettings?.globalSingleCoinSlPnl) || 0; 
                    
                    const tpPctTarget = parseFloat(currentSettings.takeProfitPct) || 0;
                    const currentPnl = parseFloat(cState.unrealizedPnl) || 0;
                    const currentRoi = parseFloat(cState.currentRoi) || 0;
                    const slPctTarget = parseFloat(currentSettings.stopLossPct) || -25.0;

                    if (tpPnlTarget > 0 && currentPnl >= tpPnlTarget) {
                        isTakeProfit = true;
                        tpReasonTxt = `Take Profit Hit (PNL $${currentPnl.toFixed(4)} >= $${tpPnlTarget.toFixed(4)})`;
                    } else if (tpPctTarget > 0 && currentRoi >= tpPctTarget) {
                        isTakeProfit = true;
                        tpReasonTxt = `Take Profit Hit (ROI ${currentRoi.toFixed(2)}% >= ${tpPctTarget}%)`;
                    }
                    
                    if (globalSlPnlTarget < 0 && currentPnl <= globalSlPnlTarget) {
                        isStopLoss = true;
                        slReasonTxt = `Stop Loss Hit (PNL $${currentPnl.toFixed(4)} <= $${globalSlPnlTarget.toFixed(4)})`;
                    } else if (slPctTarget < 0 && currentRoi <= slPctTarget) {
                        isStopLoss = true;
                        slReasonTxt = `Stop Loss Hit (ROI ${currentRoi.toFixed(2)}% <= ${slPctTarget}%)`;
                    }

                    if (isTakeProfit || isStopLoss) {
                        const reasonTxt = isTakeProfit ? tpReasonTxt : slReasonTxt;
                        const modeTxt = isPaper ? "PAPER" : "REAL";
                        
                        logForProfile(profileId, `[${modeTxt}] [${coin.symbol}] ⚡ Triggered: ${reasonTxt}. Attempting to close ${cState.contracts} contracts.`);
                        
                        try {
                            if (!isPaper) {
                                const closeSide = activeSide === 'long' ? 'sell' : 'buy';
                                await exchange.createOrder(coin.symbol, 'market', closeSide, cState.contracts, undefined, { 
                                    offset: 'close', 
                                    reduceOnly: true, 
                                    lever_rate: cState.actualLeverage 
                                });
                            }

                            cState.lockUntil = Date.now() + 5000;
                            cState.dcaCount = 0; 
                            currentSettings.realizedPnl = (currentSettings.realizedPnl || 0) + currentPnl;
                            
                            const OffsetModel = isPaper ? PaperOffsetRecord : RealOffsetRecord;
                            OffsetModel.create({
                                userId: userId,
                                symbol: coin.symbol,
                                winnerSymbol: coin.symbol,
                                reason: reasonTxt,
                                netProfit: currentPnl
                            }).catch(()=>{});

                            if (isPaper) {
                                cState.contracts = 0; cState.unrealizedPnl = 0; cState.currentRoi = 0; cState.avgEntry = 0;
                            }

                            SettingsModel.updateOne({ "subAccounts._id": currentSettings._id }, { $set: { "subAccounts.$.realizedPnl": currentSettings.realizedPnl } }).catch(()=>{});
                            continue; 
                        } catch (closeErr) {
                            logForProfile(profileId, `[${modeTxt}] ❌ CLOSE ERROR [${coin.symbol}]: ${closeErr.message}`);
                            continue;
                        }
                    }

                    // 3. DCA PNL STEP GRID TRIGGER
                    const globalTriggerDcaTarget = parseFloat(botData.globalSettings?.globalTriggerDcaPnl) || 0;
                    const profileTriggerDcaTarget = parseFloat(currentSettings.triggerDcaPnl) || -2.0;
                    const baseTriggerPnl = globalTriggerDcaTarget < 0 ? globalTriggerDcaTarget : profileTriggerDcaTarget;
                    
                    const currentDcaStep = cState.dcaCount || 0;
                    const activeTriggerPnl = baseTriggerPnl * (currentDcaStep + 1);

                    if (baseTriggerPnl < 0 && cState.unrealizedPnl <= activeTriggerPnl && (Date.now() - (cState.lastDcaTime || 0) > 12000)) {
                        
                        const targetPnlForDca = activeTriggerPnl / 2;
                        const reqQty = calculateDcaQtyToHalveGap(cState.contracts);

                        if (reqQty <= 0) {
                            cState.lastDcaTime = Date.now();
                        } else if ((cState.contracts + reqQty) > currentSettings.maxContracts) {
                            logForProfile(profileId, `[${isPaper ? 'PAPER' : 'REAL'}] 🛡️ DCA Safety Triggered. Max contracts reached.`);
                            cState.lastDcaTime = Date.now(); 
                        } else {
                            const nextTarget = baseTriggerPnl * (currentDcaStep + 2);
                            logForProfile(profileId, `[${isPaper ? 'PAPER' : 'REAL'}] ⚡ DCA Step ${currentDcaStep + 1}: Buying ${reqQty} contracts (Targeting $${targetPnlForDca.toFixed(2)} recovery) at ${cState.actualLeverage}x. Next trigger scaled to $${nextTarget.toFixed(2)}.`);
                            
                            if (!isPaper) {
                                const orderSide = activeSide === 'long' ? 'buy' : 'sell';
                                await exchange.createOrder(coin.symbol, 'market', orderSide, reqQty, undefined, { offset: 'open', lever_rate: cState.actualLeverage });
                            } else {
                                const totalValue = (cState.contracts * cState.avgEntry) + (reqQty * cState.currentPrice);
                                cState.contracts += reqQty;
                                cState.avgEntry = totalValue / cState.contracts;
                            }

                            const OffsetModel = isPaper ? PaperOffsetRecord : RealOffsetRecord;
                            OffsetModel.create({
                                userId: userId,
                                symbol: coin.symbol,
                                winnerSymbol: coin.symbol,
                                reason: `DCA Step ${currentDcaStep + 1}: Added ${reqQty} Contracts (Targeting $${targetPnlForDca.toFixed(2)})`,
                                netProfit: 0
                            }).catch(()=>{});

                            cState.dcaCount = currentDcaStep + 1; 
                            cState.lockUntil = Date.now() + 5000; 
                            cState.lastDcaTime = Date.now(); 
                        }
                    }
                } catch (coinErr) {
                    if (coinErr.message !== lastError) logForProfile(profileId, `[${coin.symbol}] ❌ Warning: ${coinErr.message}`);
                }
            } 
            lastError = '';

            await ProfileStateModel.updateOne(
                { profileId },
                { $set: { logs: state.logs, coinStates: state.coinStates, lastUpdated: Date.now() } }
            ).catch(()=>{});

        } catch (err) {
            if (err.message !== lastError) {
                logForProfile(profileId, `❌ Global API Error (Retrying next cycle): ${err.message}`);
                lastError = err.message;
            }
        } finally {
            isProcessing = false;
        }
    }, 6000);

    activeBots.set(profileId, { userId: String(userId), isPaper, settings: subAccount, globalSettings, state, exchange, intervalId });
    logForProfile(profileId, `🚀 ${isPaper ? 'Paper' : 'Real Live'} Engine Started for: ${subAccount.name}`);
}

function stopBot(profileId) {
    if (activeBots.has(profileId)) {
        clearInterval(activeBots.get(profileId).intervalId);
        activeBots.delete(profileId);
        console.log(`[Profile: ${profileId}] ⏹ Bot Stopped.`);
    }
}

// =========================================================================
// 4. BACKGROUND TASKS (DUAL-MODE)
// =========================================================================
const executeOneMinuteCloser = async () => {
    try {
        await connectDB();
        const paperUsers = await PaperSettings.find({}).lean();
        const realUsers = await RealSettings.find({}).lean();
        
        const allUsersSettings = [
            ...paperUsers.map(s => ({ ...s, isPaper: true })),
            ...realUsers.map(s => ({ ...s, isPaper: false }))
        ];

        for (let userSetting of allUsersSettings) {
            const dbUserId = String(userSetting.userId);
            const SettingsModel = userSetting.isPaper ? PaperSettings : RealSettings;
            
            let rawTpMin = Math.abs(parseFloat(userSetting.minuteCloseTpMinPnl) || 0);
            let rawTpMax = Math.abs(parseFloat(userSetting.minuteCloseTpMaxPnl) || 0);
            let rawSlMin = -Math.abs(parseFloat(userSetting.minuteCloseSlMinPnl) || 0);
            let rawSlMax = -Math.abs(parseFloat(userSetting.minuteCloseSlMaxPnl) || 0);
            const autoDynamic = userSetting.minuteCloseAutoDynamic || false;
            
            let activeCandidates = [];
            for (let [profileId, botData] of activeBots.entries()) {
                if (botData.userId !== dbUserId) continue;
                for (let symbol in botData.state.coinStates) {
                    const cState = botData.state.coinStates[symbol];
                    if (cState.contracts > 0 && (!cState.lockUntil || Date.now() >= cState.lockUntil)) {
                        activeCandidates.push({
                            profileId, symbol, exchange: botData.exchange, isPaper: botData.isPaper,
                            pnl: parseFloat(cState.unrealizedPnl) || 0,
                            contracts: cState.contracts,
                            side: cState.activeSide || botData.settings.coins.find(c => c.symbol === symbol)?.side || botData.settings.side,
                            subAccount: botData.settings,
                            cState: cState,
                            actualLeverage: cState.actualLeverage || getLeverageForCoin(symbol)
                        });
                    }
                }
            }

            activeCandidates.sort((a, b) => b.pnl - a.pnl);
            const totalCoins = activeCandidates.length;
            const totalPairs = Math.floor(totalCoins / 2);

            if (totalPairs === 0) continue;

            if (autoDynamic) {
                let runningAccumulation = 0;
                let peakAccumulation = 0;

                for (let i = 0; i < totalPairs; i++) {
                    const netResult = activeCandidates[i].pnl + activeCandidates[totalCoins - totalPairs + i].pnl;
                    runningAccumulation += netResult;
                    if (runningAccumulation > peakAccumulation) { peakAccumulation = runningAccumulation; }
                }

                if (peakAccumulation > 0) { 
                    rawTpMin = peakAccumulation * 0.8; rawTpMax = peakAccumulation * 1.2;
                    rawSlMin = -(peakAccumulation * 5.0); rawSlMax = -(peakAccumulation * 0.5); 
                } else {
                    rawTpMin = 0; rawTpMax = 0; rawSlMin = 0; rawSlMax = 0;
                }

                const multiplier = userSetting.qtyMultiplier || 1;
                if (Math.abs(rawTpMax - rawTpMin) <= 0.000101 * multiplier) {
                    rawTpMin = 0; rawTpMax = 0; rawSlMin = 0; rawSlMax = 0;
                }
            }

            const tpMin = Math.min(rawTpMin, rawTpMax); const tpMax = Math.max(rawTpMin, rawTpMax);
            const slMin = Math.min(rawSlMin, rawSlMax); const slMax = Math.max(rawSlMax, rawSlMin); 

            if (tpMax === 0 && slMax === 0) continue; 

            let runningAccumulation = 0;
            let executedGroup = false;

            for (let i = 0; i < totalPairs; i++) {
                const w = activeCandidates[i];
                const l = activeCandidates[totalCoins - totalPairs + i];
                runningAccumulation += (w.pnl + l.pnl);

                const isPositiveMatch = (tpMax > 0 && runningAccumulation > 0 && runningAccumulation >= tpMin && runningAccumulation <= tpMax);
                const isNegativeMatch = (slMin < 0 && runningAccumulation < 0 && runningAccumulation >= slMin && runningAccumulation <= slMax);

                if (!executedGroup && (isPositiveMatch || isNegativeMatch)) {
                    const executionType = isPositiveMatch ? "Group Take Profit" : "Group Stop Loss";
                    logForProfile(activeCandidates[0].profileId, `⏳ 1-Min Group Closer: Group Accumulation $${runningAccumulation.toFixed(4)} matches boundary. Closing ${i + 1} WINNERS ONLY. [${userSetting.isPaper ? 'PAPER' : 'REAL'}]`);

                    let successCount = 0;

                    for (let k = 0; k <= i; k++) {
                        const cw = activeCandidates[k];
                        try {
                            if (!cw.isPaper) {
                                const closeSide = cw.side === 'long' ? 'sell' : 'buy';
                                await cw.exchange.createOrder(cw.symbol, 'market', closeSide, cw.contracts, undefined, { 
                                    offset: 'close', 
                                    reduceOnly: true, 
                                    lever_rate: cw.actualLeverage 
                                });
                            } else {
                                cw.cState.contracts = 0; cw.cState.unrealizedPnl = 0; cw.cState.currentRoi = 0; cw.cState.avgEntry = 0; cw.cState.dcaCount = 0;
                            }
                            
                            cw.cState.lockUntil = Date.now() + 5000;
                            cw.cState.dcaCount = 0;
                            cw.subAccount.realizedPnl = (cw.subAccount.realizedPnl || 0) + cw.pnl;
                            SettingsModel.updateOne({ "subAccounts._id": cw.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": cw.subAccount.realizedPnl } }).catch(()=>{});
                            successCount++;
                        } catch (e) {
                            console.error(`Group Close Error [${cw.symbol}]:`, e.message);
                            logForProfile(cw.profileId, `❌ CLOSE ERROR [${cw.symbol}]: ${e.message}`);
                        }
                    }

                    if (successCount > 0) {
                        const autoDynData = { time: Date.now(), type: executionType, symbol: `Group up to Row ${i + 1} (WINNERS ONLY)`, pnl: runningAccumulation };
                        await SettingsModel.updateOne({ userId: dbUserId }, { $set: { autoDynamicLastExecution: autoDynData } }).catch(console.error);

                        const OffsetModel = userSetting.isPaper ? PaperOffsetRecord : RealOffsetRecord;
                        OffsetModel.create({
                            userId: dbUserId,
                            symbol: `Group of ${i + 1} Coins`,
                            winnerSymbol: `Group of ${i + 1} Coins`,
                            reason: `1-Min Closer Executed (${executionType})`,
                            netProfit: runningAccumulation
                        }).catch(()=>{});
                    }

                    executedGroup = true;
                    break; 
                }
            }
        }
    } catch (err) {
        console.error("1-Min Group Closer Error:", err);
    }
};

const executeGlobalProfitMonitor = async () => {
    if (global.isGlobalMonitoring) return;
    global.isGlobalMonitoring = true;

    try {
        await connectDB(); 
        const paperUsers = await PaperSettings.find({}).lean();
        const realUsers = await RealSettings.find({}).lean();
        
        const allUsersSettings = [
            ...paperUsers.map(s => ({ ...s, isPaper: true })),
            ...realUsers.map(s => ({ ...s, isPaper: false }))
        ];
        
        for (let userSetting of allUsersSettings) {
            const dbUserId = String(userSetting.userId);
            const SettingsModel = userSetting.isPaper ? PaperSettings : RealSettings;
            const OffsetModel = userSetting.isPaper ? PaperOffsetRecord : RealOffsetRecord;

            let dbUpdates = {}; 
            const multiplier = userSetting.qtyMultiplier || 1;
            
            const globalTargetPnl = parseFloat(userSetting.globalTargetPnl) || 0;
            const globalTrailingPnl = parseFloat(userSetting.globalTrailingPnl) || 0;
            
            const smartOffsetNetProfit = parseFloat(userSetting.smartOffsetNetProfit) || 0;
            const smartOffsetBottomRowV1 = parseInt(userSetting.smartOffsetBottomRowV1) !== undefined && !isNaN(parseInt(userSetting.smartOffsetBottomRowV1)) ? parseInt(userSetting.smartOffsetBottomRowV1) : 5;
            const smartOffsetBottomRowV1StopLoss = parseFloat(userSetting.smartOffsetBottomRowV1StopLoss) || 0; 
            const smartOffsetStopLoss = parseFloat(userSetting.smartOffsetStopLoss) || 0; 
            const smartOffsetNetProfit2 = parseFloat(userSetting.smartOffsetNetProfit2) || 0;
            const smartOffsetStopLoss2 = parseFloat(userSetting.smartOffsetStopLoss2) || 0; 
            
            const smartOffsetMaxLossPerMinute = parseFloat(userSetting.smartOffsetMaxLossPerMinute) || 0;
            const smartOffsetMaxLossTimeframeSeconds = parseInt(userSetting.smartOffsetMaxLossTimeframeSeconds) !== undefined && !isNaN(parseInt(userSetting.smartOffsetMaxLossTimeframeSeconds)) ? parseInt(userSetting.smartOffsetMaxLossTimeframeSeconds) : 60;
            const timeframeMs = smartOffsetMaxLossTimeframeSeconds * 1000;

            const noPeakSlTimeframeSeconds = parseInt(userSetting.noPeakSlTimeframeSeconds) !== undefined && !isNaN(parseInt(userSetting.noPeakSlTimeframeSeconds)) ? parseInt(userSetting.noPeakSlTimeframeSeconds) : 1800;
            const noPeakMs = noPeakSlTimeframeSeconds * 1000; 
            
            const noPeakSlGatePnl = parseFloat(userSetting.noPeakSlGatePnl) || 0; 
            
            const peakThreshold = 0.0001 * multiplier;
            const winnerThreshold = 0.0002 * multiplier;

            let currentGlobalPeak = userSetting.currentGlobalPeak || 0;
            let lastStopLossTime = userSetting.lastStopLossTime || 0;
            let lastNoPeakSlTime = userSetting.lastNoPeakSlTime || 0;
            
            let globalUnrealized = 0;
            let activeCandidates = [];
            let firstProfileId = null; 

            let rollingLossArr = userSetting.rollingStopLosses || [];
            const originalLen = rollingLossArr.length;
            rollingLossArr = rollingLossArr.filter(record => Date.now() - record.time < timeframeMs);
            if (rollingLossArr.length !== originalLen) dbUpdates.rollingStopLosses = rollingLossArr;
            
            let currentMinuteLoss = rollingLossArr.reduce((sum, record) => sum + record.amount, 0);

            for (let [profileId, botData] of activeBots.entries()) {
                if (botData.userId !== dbUserId) continue;
                if (!firstProfileId) firstProfileId = profileId;
                
                for (let symbol in botData.state.coinStates) {
                    const cState = botData.state.coinStates[symbol];
                    if (cState.contracts > 0 && (!cState.lockUntil || Date.now() >= cState.lockUntil)) {
                        const pnl = parseFloat(cState.unrealizedPnl) || 0;
                        globalUnrealized += pnl;
                        
                        const activeSide = cState.activeSide || botData.settings.coins.find(c => c.symbol === symbol)?.side || botData.settings.side;
                        
                        activeCandidates.push({
                            profileId, symbol, exchange: botData.exchange, isPaper: botData.isPaper, unrealizedPnl: pnl,
                            contracts: cState.contracts, side: activeSide, subAccount: botData.settings, actualLeverage: cState.actualLeverage || getLeverageForCoin(symbol)
                        });
                    }
                }
            }

            if (!firstProfileId || activeCandidates.length === 0) continue;

            const targetV1 = smartOffsetNetProfit > 0 ? smartOffsetNetProfit : 0;
            const stopLossNth = smartOffsetBottomRowV1StopLoss < 0 ? smartOffsetBottomRowV1StopLoss : 0; 
            const targetV2 = smartOffsetNetProfit2 > 0 ? smartOffsetNetProfit2 : 0;

            let offsetExecuted = false;
            let v2SlEnabled = true;

            // SMART OFFSET V1
            if ((smartOffsetNetProfit > 0 || smartOffsetBottomRowV1StopLoss < 0 || smartOffsetStopLoss < 0 || noPeakSlTimeframeSeconds > 0) && activeCandidates.length >= 2) {
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

                if (stopLossNth < 0) {
                    v2SlEnabled = (nthBottomAccumulation <= stopLossNth);
                }

                let triggerOffset = false;
                let reason = '';
                let finalPairsToClose = [];
                let finalNetProfit = 0;
                let isNoPeakSl = false;
                
                const isFullGroupSl = (smartOffsetStopLoss < 0 && runningAccumulation <= smartOffsetStopLoss);

                if (smartOffsetNetProfit > 0 && peakAccumulation >= targetV1 && peakAccumulation >= peakThreshold && peakRowIndex >= 0) {
                    triggerOffset = true;
                    reason = `V1 Offset Executed: Harvested Peak at Row ${peakRowIndex + 1} (Target $${targetV1.toFixed(4)})`;
                    for(let i = 0; i <= peakRowIndex; i++) {
                        const w = activeCandidates[i];
                        if (Math.abs(w.unrealizedPnl) <= winnerThreshold) continue; 
                        finalPairsToClose.push(w); 
                    }
                    if (finalPairsToClose.length === 0) triggerOffset = false; 
                } 
                else if (isFullGroupSl) {
                    let allowSl = false;
                    let limitVal = smartOffsetStopLoss;
                    let projectedLoss = runningAccumulation; 

                    if (smartOffsetMaxLossPerMinute > 0) {
                        if (currentMinuteLoss + Math.abs(projectedLoss) <= smartOffsetMaxLossPerMinute) allowSl = true;
                    } else {
                        if (Date.now() - lastStopLossTime >= timeframeMs) allowSl = true;
                    }

                    if (allowSl) {
                        triggerOffset = true;
                        reason = `V1 Stop Loss Hit (Full Group limit: $${limitVal.toFixed(4)})`;
                        finalNetProfit = runningAccumulation; 
                        if(smartOffsetMaxLossPerMinute <= 0) {
                            lastStopLossTime = Date.now();
                            dbUpdates.lastStopLossTime = lastStopLossTime;
                        }
                        for(let i = 0; i < totalPairs; i++) finalPairsToClose.push(activeCandidates[i]);
                    }
                }
                else if (peakRowIndex === -1 || peakAccumulation < peakThreshold) {
                    let allowNoPeakSl = false;
                    if (Date.now() - lastNoPeakSlTime >= noPeakMs) allowNoPeakSl = true; 

                    if (activeCandidates[0].unrealizedPnl > noPeakSlGatePnl) {
                        allowNoPeakSl = false;
                    }

                    if (allowNoPeakSl) {
                        triggerOffset = true;
                        isNoPeakSl = true;
                        reason = `No Peak Gate Executed (Cut Lowest PNL after ${noPeakSlTimeframeSeconds}s)`;
                        const absoluteWorstCoin = activeCandidates[activeCandidates.length - 1];
                        finalNetProfit = absoluteWorstCoin.unrealizedPnl;
                        finalPairsToClose.push(absoluteWorstCoin);
                        lastNoPeakSlTime = Date.now();
                        dbUpdates.lastNoPeakSlTime = lastNoPeakSlTime;
                    }
                }

                if (triggerOffset) {
                    if (!isFullGroupSl && !isNoPeakSl) {
                        let actualPairsToClose = [];
                        let liveCheckNet = 0;
                        for (let k = 0; k < finalPairsToClose.length; k++) {
                            const pos = finalPairsToClose[k];
                            const bState = activeBots.get(pos.profileId).state.coinStates[pos.symbol];
                            const livePnl = bState ? (parseFloat(bState.unrealizedPnl) || 0) : pos.unrealizedPnl;
                            if (livePnl <= 0) continue; // Removed Slippage Safety Lock
                            actualPairsToClose.push(pos);
                            liveCheckNet += livePnl;
                        }
                        finalPairsToClose = actualPairsToClose;
                        finalNetProfit = liveCheckNet;
                        if (finalPairsToClose.length === 0) triggerOffset = false;
                    } else if (isNoPeakSl) {
                        let liveCheckNet = 0;
                        for (let k = 0; k < finalPairsToClose.length; k++) {
                            const pos = finalPairsToClose[k];
                            const bState = activeBots.get(pos.profileId).state.coinStates[pos.symbol];
                            liveCheckNet += bState ? (parseFloat(bState.unrealizedPnl) || 0) : pos.unrealizedPnl;
                        }
                        finalNetProfit = liveCheckNet;
                        if (finalPairsToClose.length === 0) triggerOffset = false;
                    }

                    if (triggerOffset) {
                        const coinTypeLog = isNoPeakSl ? "LOWEST PNL" : "WINNER";
                        logForProfile(firstProfileId, `⚖️ SMART OFFSET V1 [${reason}]: Closing ${finalPairsToClose.length} ${coinTypeLog} coin(s). NET PROFIT OF CLOSURE: ${finalNetProfit >= 0 ? '+' : ''}$${finalNetProfit.toFixed(4)} [${userSetting.isPaper ? 'PAPER' : 'REAL'}]`);
                        
                        let successCount = 0;

                        for (let k = 0; k < finalPairsToClose.length; k++) {
                            const pos = finalPairsToClose[k];
                            const bData = activeBots.get(pos.profileId);
                            
                            try {
                                if (bData) {
                                    if (!pos.isPaper) {
                                        const closeSide = pos.side === 'long' ? 'sell' : 'buy';
                                        await bData.exchange.createOrder(pos.symbol, 'market', closeSide, pos.contracts, undefined, { 
                                            offset: 'close', 
                                            reduceOnly: true, 
                                            lever_rate: pos.actualLeverage 
                                        });
                                    } else {
                                        const bState = bData.state.coinStates[pos.symbol];
                                        if (bState) { bState.contracts = 0; bState.unrealizedPnl = 0; bState.avgEntry = 0; bState.dcaCount = 0; }
                                    }
                                    const bState = bData.state.coinStates[pos.symbol];
                                    if (bState) { bState.lockUntil = Date.now() + 5000; bState.dcaCount = 0; }
                                    
                                    pos.subAccount.realizedPnl = (pos.subAccount.realizedPnl || 0) + pos.unrealizedPnl;
                                    await SettingsModel.updateOne({ "subAccounts._id": pos.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": pos.subAccount.realizedPnl } }).catch(()=>{});
                                    
                                    successCount++;
                                }
                            } catch (e) {
                                console.error(`Smart Offset Error [${pos.symbol}]:`, e.message);
                                logForProfile(firstProfileId, `❌ CLOSE ERROR [${pos.symbol}]: ${e.message}`);
                            }
                        }

                        if (successCount > 0) {
                            const recordSym = isNoPeakSl ? finalPairsToClose[0].symbol : `Peak of ${finalPairsToClose.length} Winners`;
                            OffsetModel.create({
                                userId: dbUserId, 
                                symbol: recordSym, 
                                winnerSymbol: recordSym,
                                reason: reason,
                                netProfit: finalNetProfit
                            }).catch(()=>{});

                            offsetExecuted = true;
                            if (finalNetProfit < 0 && smartOffsetMaxLossPerMinute > 0) {
                                currentMinuteLoss += Math.abs(finalNetProfit);
                                rollingLossArr.push({ time: Date.now(), amount: Math.abs(finalNetProfit) });
                                dbUpdates.rollingStopLosses = rollingLossArr;
                            }
                        }
                    }
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
                    let netResult = biggestWinner.unrealizedPnl + biggestLoser.unrealizedPnl;
                    
                    let triggerOffset = false;
                    let reason = '';

                    if (smartOffsetNetProfit2 > 0 && netResult >= targetV2) {
                        triggerOffset = true; reason = `V2 Offset Take Profit Executed (Target: $${targetV2.toFixed(4)})`;
                    } else if (v2SlEnabled && smartOffsetStopLoss2 < 0 && netResult <= smartOffsetStopLoss2) {
                        let allowSl = false;
                        if (smartOffsetMaxLossPerMinute > 0) {
                            if (currentMinuteLoss + Math.abs(netResult) <= smartOffsetMaxLossPerMinute) allowSl = true;
                        } else {
                            if (Date.now() - lastStopLossTime >= timeframeMs) allowSl = true;
                        }

                        if (allowSl) {
                            triggerOffset = true; 
                            reason = `V2 Offset Stop Loss Executed (Limit: $${smartOffsetStopLoss2.toFixed(4)})`;
                            if (smartOffsetMaxLossPerMinute <= 0) {
                                lastStopLossTime = Date.now();
                                dbUpdates.lastStopLossTime = lastStopLossTime;
                            }
                        }
                    }
                    
                    if (triggerOffset) {
                        let closeW = true;
                        let successCount = 0;

                        if (reason.includes("Take Profit")) {
                            const bStateW = activeBots.get(biggestWinner.profileId).state.coinStates[biggestWinner.symbol];
                            const liveW = bStateW ? (parseFloat(bStateW.unrealizedPnl)||0) : biggestWinner.unrealizedPnl;
                            
                            if (liveW <= 0) closeW = false; // Removed Slippage Safety Lock
                            
                            netResult = (closeW ? liveW : 0);
                            if (!closeW) triggerOffset = false;
                        }

                        if (triggerOffset) {
                            logForProfile(firstProfileId, `⚖️ SMART OFFSET V2 [${reason}]: Paired Rank ${winnerIndex + 1} & ${loserIndex + 1} - Executing Winner ONLY Net: ${netResult >= 0 ? '+' : ''}$${netResult.toFixed(4)} [${userSetting.isPaper ? 'PAPER' : 'REAL'}]`);
                            
                            if (closeW) {
                                try {
                                    const bData = activeBots.get(biggestWinner.profileId);
                                    if (bData) {
                                        if (!biggestWinner.isPaper) {
                                            const closeSide = biggestWinner.side === 'long' ? 'sell' : 'buy';
                                            await bData.exchange.createOrder(biggestWinner.symbol, 'market', closeSide, biggestWinner.contracts, undefined, { 
                                                offset: 'close', 
                                                reduceOnly: true, 
                                                lever_rate: biggestWinner.actualLeverage 
                                            });
                                        } else {
                                            const bStateW = bData.state.coinStates[biggestWinner.symbol];
                                            if (bStateW) { bStateW.contracts = 0; bStateW.unrealizedPnl = 0; bStateW.avgEntry = 0; bStateW.dcaCount = 0; }
                                        }
                                        const bStateW = bData.state.coinStates[biggestWinner.symbol];
                                        if (bStateW) { bStateW.lockUntil = Date.now() + 5000; bStateW.dcaCount = 0; }
                                        
                                        biggestWinner.subAccount.realizedPnl = (biggestWinner.subAccount.realizedPnl || 0) + biggestWinner.unrealizedPnl;
                                        await SettingsModel.updateOne({ "subAccounts._id": biggestWinner.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": biggestWinner.subAccount.realizedPnl } }).catch(()=>{});
                                        successCount++;
                                    }
                                } catch(e) {
                                    console.error(`V2 Offset Error [${biggestWinner.symbol}]:`, e.message);
                                    logForProfile(firstProfileId, `❌ CLOSE ERROR [${biggestWinner.symbol}]: ${e.message}`);
                                }
                            }

                            if (successCount > 0) {
                                const recordSym = closeW ? biggestWinner.symbol : 'Skipped';
                                OffsetModel.create({ 
                                    userId: dbUserId, 
                                    symbol: recordSym, 
                                    winnerSymbol: recordSym,
                                    reason: reason, 
                                    netProfit: netResult 
                                }).catch(()=>{});

                                offsetExecuted2 = true;

                                if (reason.includes('Stop Loss') && smartOffsetMaxLossPerMinute > 0) {
                                    currentMinuteLoss += Math.abs(netResult);
                                    rollingLossArr.push({ time: Date.now(), amount: Math.abs(netResult) });
                                    dbUpdates.rollingStopLosses = rollingLossArr;
                                }
                            }
                        }
                    }
                }
            }

            if (!offsetExecuted) {
                if (globalTargetPnl > 0) {
                    let executeGlobalClose = false;

                    if (globalUnrealized >= globalTargetPnl) {
                        if (globalUnrealized > currentGlobalPeak) {
                            currentGlobalPeak = globalUnrealized;
                            dbUpdates.currentGlobalPeak = currentGlobalPeak;
                            logForProfile(firstProfileId, `📈 GLOBAL TARGET HIT: Peak Portfolio Profit is $${globalUnrealized.toFixed(2)}. Waiting for a $${globalTrailingPnl} drop to secure profits...`);
                        }
                    }
                    
                    if (currentGlobalPeak > 0) {
                        if ((currentGlobalPeak - globalUnrealized) >= globalTrailingPnl) executeGlobalClose = true;
                    }

                    if (executeGlobalClose) {
                        logForProfile(firstProfileId, `🌍 GLOBAL PORTFOLIO CLOSE TRIGGERED! Securing Total Portfolio Net Profit: $${globalUnrealized.toFixed(4)} (ONLY CLOSING WINNERS) [${userSetting.isPaper ? 'PAPER' : 'REAL'}]`);
                        
                        currentGlobalPeak = 0;
                        dbUpdates.currentGlobalPeak = 0;
                        
                        let successCount = 0;

                        for (let pos of activeCandidates) {
                            if (pos.unrealizedPnl <= 0) continue; 
                            try {
                                const bData = activeBots.get(pos.profileId);
                                if (bData) {
                                    if (!pos.isPaper) {
                                        const closeSide = pos.side === 'long' ? 'sell' : 'buy';
                                        await bData.exchange.createOrder(pos.symbol, 'market', closeSide, pos.contracts, undefined, { 
                                            offset: 'close', 
                                            reduceOnly: true, 
                                            lever_rate: pos.actualLeverage 
                                        });
                                    } else {
                                        if (bData.state.coinStates[pos.symbol]) {
                                            bData.state.coinStates[pos.symbol].contracts = 0;
                                            bData.state.coinStates[pos.symbol].unrealizedPnl = 0;
                                            bData.state.coinStates[pos.symbol].avgEntry = 0;
                                            bData.state.coinStates[pos.symbol].dcaCount = 0;
                                        }
                                    }
                                    if (bData.state.coinStates[pos.symbol]) {
                                        bData.state.coinStates[pos.symbol].lockUntil = Date.now() + 5000;
                                        bData.state.coinStates[pos.symbol].dcaCount = 0;
                                    }
                                    
                                    pos.subAccount.realizedPnl = (pos.subAccount.realizedPnl || 0) + pos.unrealizedPnl;
                                    await SettingsModel.updateOne({ "subAccounts._id": pos.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": pos.subAccount.realizedPnl } }).catch(()=>{});
                                    successCount++;
                                }
                            } catch(e) {
                                console.error(`Global Close Error [${pos.symbol}]:`, e.message);
                                logForProfile(firstProfileId, `❌ CLOSE ERROR [${pos.symbol}]: ${e.message}`);
                            }
                        }

                        if (successCount > 0) {
                            OffsetModel.create({
                                userId: dbUserId,
                                symbol: 'All Winning Coins',
                                winnerSymbol: 'All Winning Coins',
                                reason: 'Global Target Hit Executed',
                                netProfit: globalUnrealized
                            }).catch(()=>{});
                        }
                    }
                }
            }
            
            if (Object.keys(dbUpdates).length > 0) {
                await SettingsModel.updateOne({ userId: dbUserId }, { $set: dbUpdates }).catch(console.error);
            }
            
        }
    } catch (err) {
        console.error("Global Profit Monitor Error:", err);
    } finally {
        global.isGlobalMonitoring = false; 
    }
};

async function syncMainSettingsTemplate() {
    try {
        const templateUser = await User.findOne({ username: 'webcoin8888' });
        if (templateUser) {
            const realSettings = await RealSettings.findOne({ userId: templateUser._id }).lean();
            if (realSettings) {
                delete realSettings._id;
                delete realSettings.__v;
                await MainTemplate.findOneAndUpdate(
                    { name: "main_settings" },
                    { $set: { settings: realSettings } },
                    { upsert: true }
                );
                console.log('✅ Main Settings Template synced successfully from webcoin8888.');
            }
        }
    } catch(e) {
        console.error("Template Sync Error:", e);
    }
}

const bootstrapBots = async () => {
    if (!global.botLoopsStarted) {
        global.botLoopsStarted = true;
        console.log("🛠 Bootstrapping Background Loops for Vercel...");
        
        try {
            await connectDB();
            await syncMainSettingsTemplate();
            
            // Wait for Custom Maximum Leverages to fully sync before continuing
            await fetchCustomMaxLeveragesPromise();
            
            // Start Global Oracles
            startPriceOracle();

            setInterval(executeOneMinuteCloser, 60000);
            setInterval(executeGlobalProfitMonitor, 6000);

            const paperSettings = await PaperSettings.find({});
            paperSettings.forEach(s => {
                if (s.subAccounts) {
                    s.subAccounts.forEach(sub => { 
                        if (sub.coins && sub.coins.length > 0) {
                            sub.coins.forEach(c => c.botActive = true);
                            startBot(s.userId.toString(), sub, true).catch(err => console.error("Paper startBot Error:", err)); 
                        }
                    });
                }
            });

            const realSettings = await RealSettings.find({});
            realSettings.forEach(s => {
                if (s.subAccounts) {
                    s.subAccounts.forEach(sub => { 
                        if (sub.coins && sub.coins.length > 0) {
                            sub.coins.forEach(c => c.botActive = true);
                            startBot(s.userId.toString(), sub, false).catch(err => console.error("Real startBot Error:", err)); 
                        }
                    });
                }
            });
        } catch(e) {
            console.error("Bootstrap Error:", e);
        }
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
        
        req.isPaper = user.isPaper;
        req.username = user.username; 
        next();
    });
};

const adminMiddleware = async (req, res, next) => {
    if (req.username !== 'webcoin8888') return res.status(403).json({ error: 'Admin access required.' });
    next();
};

app.get('/api/ping', async (req, res) => {
    await connectDB(); 
    await bootstrapBots(); 
    res.status(200).json({ success: true, message: 'Bot is awake', timestamp: new Date().toISOString(), activeProfiles: activeBots.size });
});

app.get('/api/settings', authMiddleware, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    await connectDB();
    const SettingsModel = req.isPaper ? PaperSettings : RealSettings;
    const settings = await SettingsModel.findOne({ userId: req.userId }).lean();
    res.json(settings || {});
});

app.post('/api/register', async (req, res) => {
    try {
        await bootstrapBots(); 
        await connectDB();
        
        const { username, password, authCode, qtyMultiplier } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

        const isPaper = authCode !== 'webcoin8888'; 
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const user = await User.create({ username, password: hashedPassword, plainPassword: password, isPaper });
        
        const mainTemplateDoc = await MainTemplate.findOne({ name: "main_settings" });
        let templateSettings = mainTemplateDoc ? JSON.parse(JSON.stringify(mainTemplateDoc.settings)) : {};
        
        delete templateSettings._id;
        delete templateSettings.__v;
        templateSettings.userId = user._id;
        templateSettings.currentGlobalPeak = 0;
        templateSettings.rollingStopLosses = [];
        templateSettings.autoDynamicLastExecution = null;

        const multiplier = parseFloat(qtyMultiplier) > 0 ? parseFloat(qtyMultiplier) : 1;
        templateSettings.qtyMultiplier = multiplier;
        templateSettings.smartOffsetNetProfit = (templateSettings.smartOffsetNetProfit || 0) * multiplier;
        templateSettings.noPeakSlGatePnl = (templateSettings.noPeakSlGatePnl || 0) * multiplier;
        templateSettings.globalSingleCoinTpPnl = (templateSettings.globalSingleCoinTpPnl || 0) * multiplier;
        templateSettings.globalSingleCoinSlPnl = (templateSettings.globalSingleCoinSlPnl || 0) * multiplier;
        templateSettings.globalTriggerDcaPnl = (templateSettings.globalTriggerDcaPnl || 0) * multiplier;

        if (!templateSettings.subAccounts || templateSettings.subAccounts.length === 0) {
            templateSettings.subAccounts = [];
            
            for (let i = 1; i <= 6; i++) {
                let profileName = 'Profile ' + i;
                let coins = [];

                PREDEFINED_COINS.forEach((base, index) => {
                    const symbol = base + '/USDT:USDT';
                    let coinSide = 'long';

                    if (i === 1) { coinSide = (index % 2 === 0) ? 'long' : 'short'; profileName = "P1: Even L / Odd S"; }
                    else if (i === 2) { coinSide = (index % 2 === 0) ? 'short' : 'long'; profileName = "P2: Even S / Odd L"; }
                    else if (i === 3) { coinSide = 'long'; profileName = "P3: All Long"; }
                    else if (i === 4) { coinSide = 'short'; profileName = "P4: All Short"; }
                    else if (i === 5) { coinSide = (index < PREDEFINED_COINS.length / 2) ? 'long' : 'short'; profileName = "P5: Half L / Half S"; }
                    else if (i === 6) { coinSide = (index < PREDEFINED_COINS.length / 2) ? 'short' : 'long'; profileName = "P6: Half S / Half L"; }

                    coins.push({ symbol, side: coinSide, botActive: true }); 
                });

                templateSettings.subAccounts.push({
                    name: profileName,
                    apiKey: isPaper ? 'paper_key_' + i + '_' + Date.now() : '',
                    secret: isPaper ? 'paper_secret_' + i + '_' + Date.now() : '',
                    side: 'long',
                    leverage: 10,
                    baseQty: 1 * multiplier,
                    takeProfitPct: 5.0,
                    takeProfitPnl: 0,
                    stopLossPct: -25.0,
                    triggerDcaPnl: -2.0 * multiplier,
                    maxContracts: 1000,
                    realizedPnl: 0,
                    coins: coins
                });
            }
        } else {
            templateSettings.subAccounts = templateSettings.subAccounts.map((sub, i) => {
                delete sub._id;
                sub.realizedPnl = 0;
                sub.baseQty = (sub.baseQty !== undefined ? sub.baseQty : 1) * multiplier;
                sub.triggerDcaPnl = sub.triggerDcaPnl !== undefined ? sub.triggerDcaPnl : -2.0 * multiplier;
                if (isPaper) { 
                    sub.apiKey = 'paper_key_' + i + '_' + Date.now(); 
                    sub.secret = 'paper_secret_' + i + '_' + Date.now(); 
                }
                
                let forcedCoins = [];
                PREDEFINED_COINS.forEach((base, index) => {
                    const symbol = base + '/USDT:USDT';
                    let coinSide = 'long';
                    if (i === 0) { coinSide = (index % 2 === 0) ? 'long' : 'short'; } 
                    else if (i === 1) { coinSide = (index % 2 === 0) ? 'short' : 'long'; } 
                    else if (i === 2) { coinSide = 'long'; } 
                    else if (i === 3) { coinSide = 'short'; } 
                    else if (i === 4) { coinSide = (index < PREDEFINED_COINS.length / 2) ? 'long' : 'short'; } 
                    else if (i === 5) { coinSide = (index < PREDEFINED_COINS.length / 2) ? 'short' : 'long'; } 
                    forcedCoins.push({ symbol, side: coinSide, botActive: true }); 
                });
                sub.coins = forcedCoins;
                
                return sub;
            });
        }

        const SettingsModel = isPaper ? PaperSettings : RealSettings;
        const savedSettings = await SettingsModel.create(templateSettings);
        if (savedSettings.subAccounts) { savedSettings.subAccounts.forEach(sub => startBot(user._id.toString(), sub, isPaper).catch(()=>{})); }
        return res.json({ success: true, message: `Registration successful! Pre-configured ${isPaper ? 'Paper' : 'Real'} Profiles have been cloned and setup.` });

    } catch (err) {
        console.error(err);
        res.status(400).json({ error: 'Username already exists or system error.' });
    }
});

app.post('/api/login', async (req, res) => {
    await bootstrapBots(); 
    await connectDB();
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, isPaper: user.isPaper, username: user.username });
});

app.get('/api/me', authMiddleware, async (req, res) => { res.json({ isPaper: req.isPaper, username: req.username }); });

app.get('/api/admin/status', authMiddleware, adminMiddleware, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const template = await MainTemplate.findOne({ name: "main_settings" });
    const webcoin = await User.findOne({ username: 'webcoin8888' });
    res.json({ templateSafe: !!template, webcoinSafe: !!webcoin });
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const users = await User.find({ username: { $ne: 'webcoin8888' } }).lean();
    let result = [];
    for (let u of users) {
        const SettingsModel = u.isPaper ? PaperSettings : RealSettings;
        const settings = await SettingsModel.findOne({ userId: u._id }).lean();
        let totalPnl = 0;
        if (settings && settings.subAccounts) totalPnl = settings.subAccounts.reduce((sum, sub) => sum + (sub.realizedPnl || 0), 0);
        result.push({ _id: u._id, username: u.username, plainPassword: u.plainPassword || 'Not Recorded', isPaper: u.isPaper, realizedPnl: totalPnl });
    }
    res.json(result);
});

app.post('/api/admin/users/:id/import', authMiddleware, adminMiddleware, async (req, res) => {
    const { id } = req.params;
    const targetUser = await User.findById(id);
    if (!targetUser || targetUser.username === 'webcoin8888') return res.status(403).json({ error: 'Invalid user or cannot import to master.' });
    const mainTemplateDoc = await MainTemplate.findOne({ name: "main_settings" });
    if (!mainTemplateDoc || !mainTemplateDoc.settings) return res.status(400).json({ error: 'Master template not found in database.' });

    const templateSettings = mainTemplateDoc.settings;
    const SettingsModel = targetUser.isPaper ? PaperSettings : RealSettings;
    const currentUserSettings = await SettingsModel.findOne({ userId: targetUser._id }).lean();
    const mult = currentUserSettings ? (currentUserSettings.qtyMultiplier || 1) : 1;

    const newSubAccounts = (templateSettings.subAccounts || []).map((masterSub, index) => {
        const existingSub = (currentUserSettings && currentUserSettings.subAccounts) ? currentUserSettings.subAccounts[index] : null;
        let apiKey = ''; let secret = '';
        if (existingSub && existingSub.apiKey) { apiKey = existingSub.apiKey; secret = existingSub.secret; } 
        else if (targetUser.isPaper) { apiKey = 'paper_key_' + index + '_' + Date.now(); secret = 'paper_secret_' + index + '_' + Date.now(); }

        let forcedCoins = [];
        PREDEFINED_COINS.forEach((base, cIndex) => {
            const symbol = base + '/USDT:USDT';
            let coinSide = 'long';
            if (index === 0) { coinSide = (cIndex % 2 === 0) ? 'long' : 'short'; } 
            else if (index === 1) { coinSide = (cIndex % 2 === 0) ? 'short' : 'long'; } 
            else if (index === 2) { coinSide = 'long'; } 
            else if (index === 3) { coinSide = 'short'; } 
            else if (index === 4) { coinSide = (cIndex < PREDEFINED_COINS.length / 2) ? 'long' : 'short'; } 
            else if (index === 5) { coinSide = (cIndex < PREDEFINED_COINS.length / 2) ? 'short' : 'long'; } 
            forcedCoins.push({ symbol, side: coinSide, botActive: true }); 
        });

        return {
            name: masterSub.name, apiKey: apiKey, secret: secret, side: masterSub.side || 'long', leverage: masterSub.leverage !== undefined ? masterSub.leverage : 10,
            baseQty: (masterSub.baseQty !== undefined ? masterSub.baseQty : 1) * mult, takeProfitPct: masterSub.takeProfitPct !== undefined ? masterSub.takeProfitPct : 5.0, takeProfitPnl: masterSub.takeProfitPnl !== undefined ? masterSub.takeProfitPnl : 0,
            stopLossPct: masterSub.stopLossPct !== undefined ? masterSub.stopLossPct : -25.0, 
            triggerDcaPnl: masterSub.triggerDcaPnl !== undefined ? masterSub.triggerDcaPnl : -2.0 * mult, 
            maxContracts: masterSub.maxContracts !== undefined ? masterSub.maxContracts : 1000,
            realizedPnl: existingSub ? (existingSub.realizedPnl || 0) : 0, coins: forcedCoins
        };
    });

    for (let [profileId, botData] of activeBots.entries()) { if (botData.userId === String(id)) stopBot(profileId); }
    const updatedUser = await SettingsModel.findOneAndUpdate({ userId: targetUser._id }, { $set: { subAccounts: newSubAccounts } }, { returnDocument: 'after', upsert: true });

    if (updatedUser && updatedUser.subAccounts) {
        updatedUser.subAccounts.forEach(sub => {
            if (sub.coins && sub.coins.length > 0 && sub.apiKey && sub.secret) { 
                sub.coins.forEach(c => c.botActive = true);
                startBot(targetUser._id.toString(), sub, targetUser.isPaper).catch(()=>{}); 
            }
        });
    }
    res.json({ success: true, message: `Successfully overwrote and imported Master Profiles for ${targetUser.username}.` });
});

app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
    const { id } = req.params;
    const targetUser = await User.findById(id);
    if (!targetUser || targetUser.username === 'webcoin8888') return res.status(403).json({ error: 'Cannot delete master account.' });

    for (let [profileId, botData] of activeBots.entries()) { if (botData.userId === String(id)) stopBot(profileId); }
    await User.findByIdAndDelete(id); await PaperSettings.deleteMany({ userId: id }); await RealSettings.deleteMany({ userId: id });
    await PaperProfileState.deleteMany({ userId: id }); await RealProfileState.deleteMany({ userId: id });
    await PaperOffsetRecord.deleteMany({ userId: id }); await RealOffsetRecord.deleteMany({ userId: id });
    res.json({ success: true, message: 'Deleted user ' + targetUser.username });
});

app.delete('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
    const users = await User.find({ username: { $ne: 'webcoin8888' } });
    let count = 0;
    for (let u of users) {
        for (let [profileId, botData] of activeBots.entries()) { if (botData.userId === String(u._id)) stopBot(profileId); }
        await User.findByIdAndDelete(u._id); await PaperSettings.deleteMany({ userId: u._id }); await RealSettings.deleteMany({ userId: u._id });
        await PaperProfileState.deleteMany({ userId: u._id }); await RealProfileState.deleteMany({ userId: u._id });
        await PaperOffsetRecord.deleteMany({ userId: u._id }); await RealOffsetRecord.deleteMany({ userId: u._id });
        count++;
    }
    res.json({ success: true, message: 'Safely wiped ' + count + ' users. Master settings strictly intact.' });
});

app.post('/api/close-all', authMiddleware, async (req, res) => {
    if (req.isPaper) return res.status(403).json({ error: "Paper accounts cannot perform real emergency closures. Stop bots manually." });
    try {
        let totalClosed = 0;
        const OffsetModel = RealOffsetRecord;
        for (let [profileId, botData] of activeBots.entries()) {
            if (botData.userId !== req.userId.toString()) continue;
            const positions = await botData.exchange.fetchPositions().catch(()=>[]);
            if (!positions || positions.length === 0) continue;
            for (let pos of positions) {
                if (pos.contracts > 0) {
                    const closeSide = pos.side === 'long' ? 'sell' : 'buy';
                    const activeLev = parseInt(pos.leverage || (pos.info && pos.info.lever_rate)) || botData.state.coinStates[pos.symbol]?.actualLeverage || getLeverageForCoin(pos.symbol);
                    await botData.exchange.createOrder(pos.symbol, 'market', closeSide, pos.contracts, undefined, { 
                        offset: 'close', 
                        reduceOnly: true, 
                        lever_rate: activeLev 
                    }).catch(console.error);
                    totalClosed++;
                    let closedPnl = 0;
                    if (botData.state.coinStates[pos.symbol]) {
                        closedPnl = parseFloat(botData.state.coinStates[pos.symbol].unrealizedPnl) || 0;
                        botData.state.coinStates[pos.symbol].lockUntil = Date.now() + 5000;
                    }
                    OffsetModel.create({ userId: req.userId, symbol: pos.symbol, winnerSymbol: pos.symbol, reason: 'Emergency Panic Close', netProfit: closedPnl }).catch(()=>{});
                }
            }
        }
        res.json({ success: true, message: 'Emergency Protocol Executed. Sent market close orders for ' + totalClosed + ' active positions.' });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings', authMiddleware, async (req, res) => {
    await bootstrapBots(); 
    const SettingsModel = req.isPaper ? PaperSettings : RealSettings;

    const { subAccounts, globalTargetPnl, globalTrailingPnl, globalSingleCoinTpPnl, globalSingleCoinSlPnl, globalTriggerDcaPnl, smartOffsetNetProfit, smartOffsetBottomRowV1, smartOffsetBottomRowV1StopLoss, smartOffsetStopLoss, smartOffsetNetProfit2, smartOffsetStopLoss2, smartOffsetMaxLossPerMinute, smartOffsetMaxLossTimeframeSeconds, minuteCloseAutoDynamic, minuteCloseTpMinPnl, minuteCloseTpMaxPnl, minuteCloseSlMinPnl, minuteCloseSlMaxPnl, noPeakSlTimeframeSeconds, noPeakSlGatePnl } = req.body;
    
    const existingSettings = await SettingsModel.findOne({ userId: req.userId });
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
        if (sub.triggerDcaPnl > 0) sub.triggerDcaPnl = -sub.triggerDcaPnl;
        if (sub.stopLossPct > 0) sub.stopLossPct = -sub.stopLossPct;
        if (sub.takeProfitPnl === undefined) sub.takeProfitPnl = 0;
        sub.leverage = 10; 
    });

    let parsedGlobalDcaPnl = parseFloat(globalTriggerDcaPnl) || 0; if (parsedGlobalDcaPnl > 0) parsedGlobalDcaPnl = -parsedGlobalDcaPnl;
    let parsedGlobalSlPnl = parseFloat(globalSingleCoinSlPnl) || 0; if (parsedGlobalSlPnl > 0) parsedGlobalSlPnl = -parsedGlobalSlPnl;
    let parsedBottomRowSl = parseFloat(smartOffsetBottomRowV1StopLoss) || 0; if (parsedBottomRowSl > 0) parsedBottomRowSl = -parsedBottomRowSl;
    let parsedStopLoss = parseFloat(smartOffsetStopLoss) || 0; if (parsedStopLoss > 0) parsedStopLoss = -parsedStopLoss; 
    let parsedStopLoss2 = parseFloat(smartOffsetStopLoss2) || 0; if (parsedStopLoss2 > 0) parsedStopLoss2 = -parsedStopLoss2; 
    let parsedTpMin = Math.abs(parseFloat(minuteCloseTpMinPnl) || 0); let parsedTpMax = Math.abs(parseFloat(minuteCloseTpMaxPnl) || 0);
    let parsedSlMin = -Math.abs(parseFloat(minuteCloseSlMinPnl) || 0); let parsedSlMax = -Math.abs(parseFloat(minuteCloseSlMaxPnl) || 0);

    const updated = await SettingsModel.findOneAndUpdate(
        { userId: req.userId }, 
        { 
            subAccounts, 
            globalTargetPnl: parseFloat(globalTargetPnl) || 0, 
            globalTrailingPnl: parseFloat(globalTrailingPnl) || 0,
            globalSingleCoinTpPnl: parseFloat(globalSingleCoinTpPnl) || 0,
            globalSingleCoinSlPnl: parsedGlobalSlPnl,
            globalTriggerDcaPnl: parsedGlobalDcaPnl,
            smartOffsetNetProfit: parseFloat(smartOffsetNetProfit) || 0, 
            smartOffsetBottomRowV1: !isNaN(parseInt(smartOffsetBottomRowV1)) ? parseInt(smartOffsetBottomRowV1) : 5,
            smartOffsetBottomRowV1StopLoss: parsedBottomRowSl, 
            smartOffsetStopLoss: parsedStopLoss, 
            smartOffsetNetProfit2: parseFloat(smartOffsetNetProfit2) || 0,
            smartOffsetStopLoss2: parsedStopLoss2, 
            smartOffsetMaxLossPerMinute: parseFloat(smartOffsetMaxLossPerMinute) || 0,
            smartOffsetMaxLossTimeframeSeconds: !isNaN(parseInt(smartOffsetMaxLossTimeframeSeconds)) ? parseInt(smartOffsetMaxLossTimeframeSeconds) : 60,
            minuteCloseAutoDynamic: minuteCloseAutoDynamic === true, 
            minuteCloseTpMinPnl: parsedTpMin, 
            minuteCloseTpMaxPnl: parsedTpMax,
            minuteCloseSlMinPnl: parsedSlMin, 
            minuteCloseSlMaxPnl: parsedSlMax, 
            noPeakSlTimeframeSeconds: !isNaN(parseInt(noPeakSlTimeframeSeconds)) ? parseInt(noPeakSlTimeframeSeconds) : 1800,
            noPeakSlGatePnl: parseFloat(noPeakSlGatePnl) || 0
        }, 
        { returnDocument: 'after' }
    );

    const activeSubIds = [];
    if (updated.subAccounts) {
        updated.subAccounts.forEach(sub => {
            const profileId = sub._id.toString();
            activeSubIds.push(profileId);
            if (sub.coins && sub.coins.length > 0) {
                sub.coins.forEach(c => c.botActive = true); // Force active
                if (activeBots.has(profileId)) {
                    activeBots.get(profileId).settings = sub;
                    activeBots.get(profileId).globalSettings = updated;
                } else {
                    startBot(req.userId.toString(), sub, req.isPaper).catch(err => console.error("startBot Error:", err)); 
                }
            } else { stopBot(profileId); }
        });
    }

    for (let [profileId, botData] of activeBots.entries()) {
        if (botData.userId === req.userId.toString() && !activeSubIds.includes(profileId)) stopBot(profileId);
    }

    if (req.username === 'webcoin8888') {
        console.log("👑 Master account saved settings. Syncing to all users...");
        await syncMainSettingsTemplate(); 

        const allRealUsers = await RealSettings.find({ userId: { $ne: req.userId } });
        const allPaperUsers = await PaperSettings.find({ userId: { $ne: req.userId } });
        
        const syncGlobalParams = {
            globalTargetPnl: updated.globalTargetPnl, 
            globalTrailingPnl: updated.globalTrailingPnl, 
            globalSingleCoinTpPnl: updated.globalSingleCoinTpPnl,
            globalSingleCoinSlPnl: updated.globalSingleCoinSlPnl,
            globalTriggerDcaPnl: updated.globalTriggerDcaPnl,
            smartOffsetNetProfit: updated.smartOffsetNetProfit,
            smartOffsetBottomRowV1: updated.smartOffsetBottomRowV1, 
            smartOffsetBottomRowV1StopLoss: updated.smartOffsetBottomRowV1StopLoss, 
            smartOffsetStopLoss: updated.smartOffsetStopLoss,
            smartOffsetNetProfit2: updated.smartOffsetNetProfit2, 
            smartOffsetStopLoss2: updated.smartOffsetStopLoss2, 
            smartOffsetMaxLossPerMinute: updated.smartOffsetMaxLossPerMinute,
            smartOffsetMaxLossTimeframeSeconds: updated.smartOffsetMaxLossTimeframeSeconds, 
            minuteCloseAutoDynamic: updated.minuteCloseAutoDynamic,
            minuteCloseTpMinPnl: updated.minuteCloseTpMinPnl, 
            minuteCloseTpMaxPnl: updated.minuteCloseTpMaxPnl, 
            minuteCloseSlMinPnl: updated.minuteCloseSlMinPnl,
            minuteCloseSlMaxPnl: updated.minuteCloseSlMaxPnl, 
            noPeakSlTimeframeSeconds: updated.noPeakSlTimeframeSeconds, 
            noPeakSlGatePnl: updated.noPeakSlGatePnl
        };

        const applyMasterSync = async (userSettingsDoc, isPaperMode) => {
            let updatePayload = { ...syncGlobalParams };
            const mult = userSettingsDoc.qtyMultiplier || 1;
            
            updatePayload.smartOffsetNetProfit = (updated.smartOffsetNetProfit || 0) * mult;
            updatePayload.noPeakSlGatePnl = (updated.noPeakSlGatePnl || 0) * mult;
            updatePayload.globalSingleCoinTpPnl = (updated.globalSingleCoinTpPnl || 0) * mult;
            updatePayload.globalSingleCoinSlPnl = (updated.globalSingleCoinSlPnl || 0) * mult;
            updatePayload.globalTriggerDcaPnl = (updated.globalTriggerDcaPnl || 0) * mult;

            if (!isPaperMode) {
                const syncedSubAccounts = updated.subAccounts.map((masterSub, index) => {
                    const existingUserSub = userSettingsDoc.subAccounts[index] || {};
                    const newSub = {
                        name: masterSub.name, apiKey: existingUserSub.apiKey || '', secret: existingUserSub.secret || '', side: masterSub.side,
                        leverage: masterSub.leverage, baseQty: (masterSub.baseQty || 1) * mult, takeProfitPct: masterSub.takeProfitPct, takeProfitPnl: masterSub.takeProfitPnl, stopLossPct: masterSub.stopLossPct,
                        triggerDcaPnl: masterSub.triggerDcaPnl, maxContracts: masterSub.maxContracts,
                        realizedPnl: existingUserSub.realizedPnl || 0, coins: masterSub.coins.map(c => ({ symbol: c.symbol, side: c.side, botActive: c.botActive !== undefined ? c.botActive : true }))
                    };
                    if (existingUserSub._id) newSub._id = existingUserSub._id;
                    return newSub;
                });
                updatePayload.subAccounts = syncedSubAccounts;
            }

            const ModelToUse = isPaperMode ? PaperSettings : RealSettings;
            const newlyUpdatedUser = await ModelToUse.findOneAndUpdate({ userId: userSettingsDoc.userId }, { $set: updatePayload }, { returnDocument: 'after' });

            const userActiveSubIds = [];
            if (newlyUpdatedUser && newlyUpdatedUser.subAccounts) {
                newlyUpdatedUser.subAccounts.forEach(sub => {
                    const profileId = sub._id.toString();
                    userActiveSubIds.push(profileId);
                    if (sub.coins && sub.coins.length > 0 && sub.apiKey && sub.secret) {
                        sub.coins.forEach(c => c.botActive = true); // Force active
                        if (activeBots.has(profileId)) { 
                            activeBots.get(profileId).settings = sub; 
                            activeBots.get(profileId).globalSettings = newlyUpdatedUser;
                        } 
                        else { startBot(newlyUpdatedUser.userId.toString(), sub, isPaperMode).catch(()=>{}); }
                    } else { stopBot(profileId); }
                });
            }

            for (let [profileId, botData] of activeBots.entries()) {
                if (botData.userId === newlyUpdatedUser.userId.toString() && !userActiveSubIds.includes(profileId)) stopBot(profileId);
            }
        };

        for (let doc of allRealUsers) await applyMasterSync(doc, false);
        for (let doc of allPaperUsers) await applyMasterSync(doc, true);
    }
    res.json({ success: true, settings: updated });
});

app.get('/api/status', authMiddleware, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    await bootstrapBots(); 
    const SettingsModel = req.isPaper ? PaperSettings : RealSettings;
    const ProfileStateModel = req.isPaper ? PaperProfileState : RealProfileState;
    const OffsetModel = req.isPaper ? PaperOffsetRecord : RealOffsetRecord; 

    const settings = await SettingsModel.findOne({ userId: req.userId });
    const userStatuses = {};

    for (let [profileId, botData] of activeBots.entries()) {
        if (botData.userId === req.userId.toString()) userStatuses[profileId] = botData.state;
    }

    if (settings && settings.subAccounts) {
        const subIds = settings.subAccounts.map(s => s._id.toString());
        const dbStates = await ProfileStateModel.find({ profileId: { $in: subIds } });
        dbStates.forEach(dbS => { if (!userStatuses[dbS.profileId]) { userStatuses[dbS.profileId] = { logs: dbS.logs, coinStates: dbS.coinStates }; } });
    }

    let currentMinuteLoss = 0;
    const timeframeSec = settings ? (settings.smartOffsetMaxLossTimeframeSeconds || 60) : 60;
    if (settings && settings.rollingStopLosses) {
        let arr = settings.rollingStopLosses.filter(r => Date.now() - r.time < (timeframeSec * 1000));
        currentMinuteLoss = arr.reduce((sum, r) => sum + r.amount, 0);
    }

    const firstOffset = await OffsetModel.findOne({ userId: req.userId }).sort({ timestamp: 1 }).lean();
    const startTime = firstOffset ? firstOffset.timestamp : null;

    res.json({ states: userStatuses, subAccounts: settings ? settings.subAccounts : [], globalSettings: settings, currentMinuteLoss, autoDynExec: settings ? settings.autoDynamicLastExecution : null, startTime });
});

app.get('/api/offsets', authMiddleware, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const OffsetModel = req.isPaper ? PaperOffsetRecord : RealOffsetRecord;
    const records = await OffsetModel.find({ userId: req.userId }).sort({ timestamp: -1 }).limit(100);
    res.json(records);
});

// ADMIN: GLOBAL SETTINGS SYNC (STRICT PARSING)
app.post('/api/master/global', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const masterUser = await User.findOne({ username: 'webcoin8888' });
        if (!masterUser) return res.status(404).json({ error: "Master user not found" });

        // Build a perfect strict object ensuring valid types and negative values
        const payload = {
            globalTargetPnl: parseFloat(req.body.globalTargetPnl) || 0,
            globalTrailingPnl: parseFloat(req.body.globalTrailingPnl) || 0,
            globalSingleCoinTpPnl: parseFloat(req.body.globalSingleCoinTpPnl) || 0,
            globalSingleCoinSlPnl: -Math.abs(parseFloat(req.body.globalSingleCoinSlPnl) || 0),
            globalTriggerDcaPnl: -Math.abs(parseFloat(req.body.globalTriggerDcaPnl) || 0),
            smartOffsetNetProfit: parseFloat(req.body.smartOffsetNetProfit) || 0,
            smartOffsetBottomRowV1: parseInt(req.body.smartOffsetBottomRowV1) || 5,
            smartOffsetBottomRowV1StopLoss: -Math.abs(parseFloat(req.body.smartOffsetBottomRowV1StopLoss) || 0),
            smartOffsetStopLoss: -Math.abs(parseFloat(req.body.smartOffsetStopLoss) || 0),
            smartOffsetNetProfit2: parseFloat(req.body.smartOffsetNetProfit2) || 0,
            smartOffsetStopLoss2: -Math.abs(parseFloat(req.body.smartOffsetStopLoss2) || 0),
            smartOffsetMaxLossPerMinute: parseFloat(req.body.smartOffsetMaxLossPerMinute) || 0,
            smartOffsetMaxLossTimeframeSeconds: parseInt(req.body.smartOffsetMaxLossTimeframeSeconds) || 60,
            minuteCloseAutoDynamic: req.body.minuteCloseAutoDynamic === true,
            minuteCloseTpMinPnl: Math.abs(parseFloat(req.body.minuteCloseTpMinPnl) || 0),
            minuteCloseTpMaxPnl: Math.abs(parseFloat(req.body.minuteCloseTpMaxPnl) || 0),
            minuteCloseSlMinPnl: -Math.abs(parseFloat(req.body.minuteCloseSlMinPnl) || 0),
            minuteCloseSlMaxPnl: -Math.abs(parseFloat(req.body.minuteCloseSlMaxPnl) || 0),
            noPeakSlTimeframeSeconds: parseInt(req.body.noPeakSlTimeframeSeconds) || 1800,
            noPeakSlGatePnl: parseFloat(req.body.noPeakSlGatePnl) || 0
        };

        const updatedMaster = await RealSettings.findOneAndUpdate(
            { userId: masterUser._id }, 
            { $set: payload }, 
            { new: true, upsert: true }
        );
        
        await syncMainSettingsTemplate();

        // PUSH GLOBAL UPDATES TO ALL USERS 
        const allRealUsers = await RealSettings.find({ userId: { $ne: masterUser._id } });
        const allPaperUsers = await PaperSettings.find({ userId: { $ne: masterUser._id } });

        const applyMasterGlobalSync = async (userSettingsDoc, ModelToUse) => {
            const mult = userSettingsDoc.qtyMultiplier || 1;
            let syncPayload = { ...payload };
            
            syncPayload.smartOffsetNetProfit = (syncPayload.smartOffsetNetProfit || 0) * mult;
            syncPayload.noPeakSlGatePnl = (syncPayload.noPeakSlGatePnl || 0) * mult;
            syncPayload.globalSingleCoinTpPnl = (syncPayload.globalSingleCoinTpPnl || 0) * mult;
            syncPayload.globalSingleCoinSlPnl = (syncPayload.globalSingleCoinSlPnl || 0) * mult;
            syncPayload.globalTriggerDcaPnl = (syncPayload.globalTriggerDcaPnl || 0) * mult;
            
            const newlyUpdated = await ModelToUse.findOneAndUpdate({ userId: userSettingsDoc.userId }, { $set: syncPayload }, { returnDocument: 'after' });
            
            if (newlyUpdated && newlyUpdated.subAccounts) {
                newlyUpdated.subAccounts.forEach(sub => {
                    const profileId = sub._id.toString();
                    if (global.activeBots.has(profileId)) {
                        global.activeBots.get(profileId).globalSettings = newlyUpdated;
                    }
                });
            }
        };

        for (let doc of allRealUsers) await applyMasterGlobalSync(doc, RealSettings);
        for (let doc of allPaperUsers) await applyMasterGlobalSync(doc, PaperSettings);

        res.json({ success: true, message: "Global Config Synchronized!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ADMIN: PROFILE SETTINGS SYNC (STRICT PARSING)
app.post('/api/master/profile/:index', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const index = parseInt(req.params.index);
        const masterUser = await User.findOne({ username: 'webcoin8888' });
        if (!masterUser) return res.status(404).json({ error: "Master user not found" });
        
        const doc = await RealSettings.findOne({ userId: masterUser._id });
        if (!doc || !doc.subAccounts || !doc.subAccounts[index]) {
            return res.status(404).json({ error: "Profile not found" });
        }

        const profilePayload = {
            apiKey: req.body.apiKey || '',
            secret: req.body.secret || '',
            baseQty: parseFloat(req.body.baseQty) || 1,
            takeProfitPct: parseFloat(req.body.takeProfitPct) || 5.0,
            takeProfitPnl: parseFloat(req.body.takeProfitPnl) || 0,
            stopLossPct: -Math.abs(parseFloat(req.body.stopLossPct) || 25.0),
            triggerDcaPnl: -Math.abs(parseFloat(req.body.triggerDcaPnl) || 2.0),
            maxContracts: parseInt(req.body.maxContracts) || 1000
        };

        Object.assign(doc.subAccounts[index], profilePayload);
        await doc.save();
        await syncMainSettingsTemplate();

        // PUSH PROFILE UPDATES TO ALL USERS 
        const applyMasterProfileSync = async (ModelToUse) => {
            const usersDocs = await ModelToUse.find({ userId: { $ne: masterUser._id } });
            for (let uDoc of usersDocs) {
                if (uDoc.subAccounts && uDoc.subAccounts[index]) {
                    const mult = uDoc.qtyMultiplier || 1;
                    const existingUserSub = uDoc.subAccounts[index];
                    
                    existingUserSub.baseQty = (profilePayload.baseQty || 1) * mult;
                    existingUserSub.takeProfitPct = profilePayload.takeProfitPct;
                    existingUserSub.takeProfitPnl = profilePayload.takeProfitPnl;
                    existingUserSub.stopLossPct = profilePayload.stopLossPct;
                    existingUserSub.triggerDcaPnl = (profilePayload.triggerDcaPnl || -2.0) * mult;
                    existingUserSub.maxContracts = profilePayload.maxContracts;
                    
                    await ModelToUse.updateOne(
                        { "subAccounts._id": existingUserSub._id },
                        { $set: { "subAccounts.$": existingUserSub } }
                    );

                    if (global.activeBots.has(existingUserSub._id.toString())) {
                        global.activeBots.get(existingUserSub._id.toString()).settings = existingUserSub;
                    }
                }
            }
        };

        await applyMasterProfileSync(RealSettings);
        await applyMasterProfileSync(PaperSettings);

        res.json({ success: true, message: `Profile ${index + 1} Array Synchronized!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/editor-data', authMiddleware, adminMiddleware, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
        const masterUser = await User.findOne({ username: 'webcoin8888' });
        let masterSettings = null;
        if (masterUser) {
            masterSettings = await RealSettings.findOne({ userId: masterUser._id }).lean();
        }
        res.json({ masterSettings });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 7. FRONTEND UI (MATERIAL DESIGN / PRO TRADING UX)
// ==========================================
app.get('/', (req, res) => {
    res.send([
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '    <meta charset="UTF-8">',
        '    <meta name="viewport" content="width=device-width, initial-scale=1.0">',
        '    <title>NexGen Algorithmic Trading | HTX Live/Paper Engine</title>',
        '    <link rel="preconnect" href="https://fonts.googleapis.com">',
        '    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
        '    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">',
        '    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0" rel="stylesheet" />',
        '    <style>',
        '        :root {',
        '            --bg-base: #0B0E11;',
        '            --bg-surface: #15181F;',
        '            --bg-card: #1E232E;',
        '            --primary: #2962FF;',
        '            --primary-hover: #1E4DCC;',
        '            --success: #0ECB81;',
        '            --success-hover: #0BA569;',
        '            --danger: #F6465D;',
        '            --danger-hover: #C9394D;',
        '            --warning: #F8D12F;',
        '            --text-main: #EAECEF;',
        '            --text-muted: #848E9C;',
        '            --border: #2B3139;',
        '        }',
        '        body { font-family: \'Inter\', sans-serif; background: var(--bg-base); color: var(--text-main); margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }',
        '        * { box-sizing: border-box; }',
        '        ::-webkit-scrollbar { width: 8px; height: 8px; }',
        '        ::-webkit-scrollbar-track { background: var(--bg-base); }',
        '        ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }',
        '        ::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }',
        '        /* Navigation */',
        '        .navbar { background: rgba(21, 24, 31, 0.85); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border); padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 1000; flex-wrap: wrap; gap: 12px; }',
        '        .nav-brand { font-size: 1.25rem; font-weight: 700; color: var(--text-main); display: flex; align-items: center; gap: 8px; letter-spacing: -0.5px; }',
        '        .nav-brand span.highlight { color: var(--primary); }',
        '        .nav-links { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: none; }',
        '        .nav-links::-webkit-scrollbar { display: none; }',
        '        /* Forms & Inputs */',
        '        label { display: block; margin-top: 16px; font-size: 0.8rem; color: var(--text-muted); font-weight: 500; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }',
        '        input, select { width: 100%; padding: 12px; background: var(--bg-surface); border: 1px solid var(--border); color: var(--text-main); border-radius: 6px; font-family: \'Inter\', sans-serif; font-size: 0.95rem; transition: border-color 0.2s, box-shadow 0.2s; outline: none; }',
        '        input:focus, select:focus { border-color: var(--primary); box-shadow: 0 0 0 2px rgba(41, 98, 255, 0.2); }',
        '        input:disabled { background: var(--border); color: var(--text-muted); cursor: not-allowed; }',
        '        /* Buttons */',
        '        .md-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 10px 20px; border: none; border-radius: 6px; font-family: \'Inter\', sans-serif; font-weight: 600; font-size: 0.85rem; cursor: pointer; transition: all 0.2s ease; text-decoration: none; text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap; }',
        '        .md-btn:active { transform: translateY(1px); }',
        '        .md-btn-primary { background: var(--primary); color: #fff; }',
        '        .md-btn-primary:hover { background: var(--primary-hover); box-shadow: 0 4px 12px rgba(41, 98, 255, 0.3); }',
        '        .md-btn-success { background: var(--success); color: #fff; }',
        '        .md-btn-success:hover { background: var(--success-hover); box-shadow: 0 4px 12px rgba(14, 203, 129, 0.2); }',
        '        .md-btn-danger { background: var(--danger); color: #fff; }',
        '        .md-btn-danger:hover { background: var(--danger-hover); box-shadow: 0 4px 12px rgba(246, 70, 93, 0.2); }',
        '        .md-btn-warning { background: var(--warning); color: #000; }',
        '        .md-btn-text { background: transparent; color: var(--text-muted); padding: 8px 16px; border: 1px solid transparent; }',
        '        .md-btn-text:hover { color: var(--text-main); background: var(--bg-card); border-color: var(--border); }',
        '        .nav-btn.active { color: var(--primary); background: rgba(41, 98, 255, 0.1); border-color: var(--primary); }',
        '        /* Layout & Utilities */',
        '        .container { max-width: 1400px; margin: 24px auto; padding: 0 16px; }',
        '        .flex-row { display: flex; gap: 16px; align-items: center; }',
        '        .flex-row-wrap { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }',
        '        .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }',
        '        .grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }',
        '        .grid-4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; }',
        '        .flex-1 { flex: 1; }',
        '        .text-green { color: var(--success) !important; }',
        '        .text-red { color: var(--danger) !important; }',
        '        .text-blue { color: var(--primary) !important; }',
        '        .text-warning { color: var(--warning) !important; }',
        '        .text-muted { color: var(--text-muted) !important; }',
        '        /* Cards */',
        '        .pro-card { background: var(--bg-card); padding: 24px; border-radius: 12px; border: 1px solid var(--border); margin-bottom: 24px; }',
        '        .pro-card-header { margin-top: 0; color: var(--text-main); font-size: 1.15rem; font-weight: 600; border-bottom: 1px solid var(--border); padding-bottom: 16px; margin-bottom: 20px; display:flex; align-items:center; gap:12px; letter-spacing: -0.3px; }',
        '        .pro-card-header .material-symbols-outlined { color: var(--primary); }',
        '        .metric-box { background: var(--bg-surface); padding: 16px 20px; border-radius: 8px; border: 1px solid var(--border); display: flex; flex-direction: column; justify-content: center; }',
        '        .metric-label { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px; }',
        '        .metric-val { font-weight: 700; color: var(--text-main); font-size: 1.4rem; margin-top: 6px; font-variant-numeric: tabular-nums; }',
        '        /* Tables */',
        '        .table-responsive { overflow-x: auto; width: 100%; border-radius: 8px; border: 1px solid var(--border); }',
        '        .md-table { width: 100%; text-align: left; border-collapse: collapse; background: var(--bg-surface); font-size: 0.85rem; font-variant-numeric: tabular-nums; white-space: nowrap; }',
        '        .md-table th { padding: 14px 16px; border-bottom: 1px solid var(--border); color: var(--text-muted); font-weight: 600; text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.5px; background: rgba(0,0,0,0.2); }',
        '        .md-table td { padding: 14px 16px; border-bottom: 1px solid var(--border); color: var(--text-main); }',
        '        .md-table tr:hover td { background: var(--bg-card); }',
        '        .highlight-row td { border-bottom: 1px solid var(--warning) !important; background: rgba(248, 209, 47, 0.05) !important; }',
        '        .peak-row td { border-bottom: 1px solid var(--success) !important; background: rgba(14, 203, 129, 0.05) !important; }',
        '        /* Console/Logs */',
        '        .log-box { background: #07090C; padding: 16px; border-radius: 8px; border: 1px solid var(--border); height: 400px; overflow-y: auto; font-family: \'Consolas\', \'Courier New\', monospace; font-size: 0.8rem; color: var(--success); line-height: 1.6; }',
        '        .log-box span.err { color: var(--danger); }',
        '        /* Landing Page Elements */',
        '        #landing-view { display: none; text-align: center; padding: 60px 20px; max-width: 900px; margin: 0 auto; position: relative; }',
        '        .hero-glow { position: absolute; top: -100px; left: 50%; transform: translateX(-50%); width: 600px; height: 400px; background: radial-gradient(circle, rgba(41,98,255,0.15) 0%, rgba(11,14,17,0) 70%); z-index: -1; pointer-events: none; }',
        '        .hero-title { font-size: 3.5rem; font-weight: 800; letter-spacing: -1.5px; line-height: 1.1; margin-bottom: 20px; background: linear-gradient(90deg, #fff, #848E9C); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }',
        '        .hero-subtitle { font-size: 1.2rem; color: var(--text-muted); font-weight: 400; max-width: 600px; margin: 0 auto 40px auto; line-height: 1.5; }',
        '        .feature-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 24px; margin-top: 60px; text-align: left; }',
        '        .feature-card { background: var(--bg-card); padding: 24px; border-radius: 12px; border: 1px solid var(--border); }',
        '        .feature-card .material-symbols-outlined { font-size: 32px; color: var(--primary); margin-bottom: 16px; }',
        '        .feature-card h4 { margin: 0 0 8px 0; font-size: 1.1rem; }',
        '        .feature-card p { margin: 0; font-size: 0.9rem; color: var(--text-muted); }',
        '        /* Auth View Modals */',
        '        #auth-view { display: none; max-width: 440px; margin: 8vh auto; }',
        '        #dashboard-view { display: none; }',
        '        /* Checkbox Hack for modern toggle */',
        '        .checkbox-wrapper { display: flex; align-items: center; cursor: pointer; gap: 8px; margin-top:16px; }',
        '        .checkbox-wrapper input[type="checkbox"] { width: auto; margin: 0; accent-color: var(--primary); width: 18px; height: 18px; }',
        '        @media (max-width: 768px) {',
        '            .hero-title { font-size: 2.5rem; }',
        '            .nav-links { width: 100%; justify-content: flex-start; }',
        '            .md-card { padding: 16px; }',
        '        }',
        '    </style>',
        '</head>',
        '<body>',
        '    <div id="app">',
        '        <!-- NAVBAR -->',
        '        <nav class="navbar">',
        '            <div class="nav-brand"><span class="material-symbols-outlined highlight" style="font-size:28px;">show_chart</span> NexGen <span class="highlight">Algo</span></div>',
        '            <div class="nav-links" id="nav-actions">',
        '                <!-- Injected via JS based on auth state -->',
        '            </div>',
        '        </nav>',
        '        <!-- LANDING PAGE (Unauthenticated) -->',
        '        <div id="landing-view">',
        '            <div class="hero-glow"></div>',
        '            <h1 class="hero-title">Institutional-Grade Algo Trading</h1>',
        '            <p class="hero-subtitle">Automate your HTX portfolio with dual-mode precision, advanced DCA matrices, and live smart-offset grouping.</p>',
        '            <div class="flex-row" style="justify-content:center; gap:20px;">',
        '                <button class="md-btn md-btn-primary" style="padding: 14px 32px; font-size:1rem;" onclick="showAuth(\'register\')">Start Paper Trading</button>',
        '                <button class="md-btn md-btn-text" style="padding: 14px 32px; font-size:1rem; border:1px solid var(--border);" onclick="showAuth(\'login\')">Login</button>',
        '            </div>',
        '            <div class="feature-grid">',
        '                <div class="feature-card"><span class="material-symbols-outlined">api</span><h4>HTX Native</h4><p>Direct low-latency execution with secure custom API endpoints.</p></div>',
        '                <div class="feature-card"><span class="material-symbols-outlined">call_merge</span><h4>Smart Offsets V1/V2</h4><p>Proprietary pairing algorithms auto-harvest peak grid profits.</p></div>',
        '                <div class="feature-card"><span class="material-symbols-outlined">model_training</span><h4>Dual Environment</h4><p>Test strategies in real-time paper simulated mode before going live.</p></div>',
        '            </div>',
        '        </div>',
        '        <!-- AUTHENTICATION FORM -->',
        '        <div id="auth-view" class="pro-card">',
        '            <h2 class="pro-card-header" style="border:none; justify-content:center;" id="auth-header">Secure Login</h2>',
        '            <div>',
        '                <label>Username</label>',
        '                <input type="text" id="username" placeholder="Enter your username">',
        '                <label>Password</label>',
        '                <input type="password" id="password" placeholder="Enter your password">',
        '                <div id="register-fields" style="display:none; margin-top:8px; border-top:1px dashed var(--border); padding-top:8px;">',
        '                    <label class="text-warning">Auth Code (Mode Selector)</label>',
        '                    <p style="font-size:0.75rem; margin:0 0 12px 0; color:var(--text-muted); text-transform:none;">Leave blank for <strong class="text-blue">Paper Simulation</strong>. Enter exactly <strong class="text-warning">webcoin8888</strong> for Live Real Trading.</p>',
        '                    <input type="password" id="authCode" placeholder="Auth Code (Optional)">',
        '                    <label class="text-blue">Base Qty Multiplier</label>',
        '                    <input type="number" id="qtyMultiplier" step="0.1" placeholder="e.g. 1.0 (Default)">',
        '                </div>',
        '            </div>',
        '            <button class="md-btn md-btn-primary" style="width:100%; margin-top:24px; padding:14px;" id="auth-submit-btn" onclick="executeAuth()">Login</button>',
        '            <div style="text-align:center; margin-top:16px;">',
        '                <button class="md-btn md-btn-text" id="auth-toggle-btn" onclick="toggleAuthMode()">Create an Account</button>',
        '            </div>',
        '            <p id="auth-msg" style="text-align:center; font-weight:600; margin-top:16px; font-size:0.9rem;"></p>',
        '        </div>',
        '        <!-- DASHBOARD (Authenticated) -->',
        '        <div id="dashboard-view" class="container">',
        '            <div id="editor-tab" style="display:none;">',
        '                <div class="pro-card">',
        '                    <h2 class="pro-card-header"><span class="material-symbols-outlined text-warning">shield_person</span> Master Account Database Editor (webcoin8888)</h2>',
        '                    <p style="background: rgba(248, 209, 47, 0.1); border-left: 4px solid var(--warning); padding: 12px 16px; border-radius: 4px; color: var(--text-main); font-size: 0.9rem; line-height: 1.5; margin-bottom:24px;">',
        '                        <strong>Notice:</strong> Trading functionality is completely disabled on this administrative account. Modifying settings here updates the global template. Synced users will inherit changes automatically on their next cycle.',
        '                    </p>',
        '                    <div id="editorGlobalContainer">Loading...</div>',
        '                    <h3 style="margin-top: 40px; border-bottom:1px solid var(--border); padding-bottom:12px;"><span class="material-symbols-outlined" style="vertical-align:middle; color:var(--primary);">folder_shared</span> Master Profiles Template</h3>',
        '                    <div id="editorProfilesContainer" style="margin-top:20px;">Loading...</div>',
        '                </div>',
        '            </div>',
        '            <div id="admin-tab" style="display:none;">',
        '                <div class="pro-card">',
        '                    <h2 class="pro-card-header"><span class="material-symbols-outlined">admin_panel_settings</span> User Management Hub</h2>',
        '                    <div id="adminStatusBanner" style="padding: 16px; border-radius: 8px; margin-bottom: 24px; font-weight: 600; display:flex; align-items:center; gap:8px;">',
        '                        Checking System Integrity...',
        '                    </div>',
        '                    <div class="flex-row-wrap" style="justify-content: space-between; margin-bottom: 20px;">',
        '                        <h3 style="margin: 0; border: none; font-size:1.1rem;">Registered Traders</h3>',
        '                        <button class="md-btn md-btn-danger" onclick="adminDeleteAllUsers()"><span class="material-symbols-outlined">delete_forever</span> Wipe ALL Users</button>',
        '                    </div>',
        '                    <div class="table-responsive" id="adminUsersContainer">Loading users...</div>',
        '                </div>',
        '            </div>',
        '            <div id="offset-tab" style="display:none;">',
        '                <div class="pro-card">',
        '                    <h2 class="pro-card-header"><span class="material-symbols-outlined text-blue">monitoring</span> Live Group Accumulation (V1 Matrix)</h2>',
        '                    <p class="text-muted" style="margin-bottom:20px;">Scans active trades dynamically, detecting peak accumulative rows. Slices grid to secure positive net offsets exclusively for top-ranking pairs.</p>',
        '                    <div class="table-responsive" id="liveOffsetsContainer">Waiting for stream...</div>',
        '                </div>',
        '                <div class="pro-card">',
        '                    <h2 class="pro-card-header"><span class="material-symbols-outlined text-green">history</span> Execution Ledger (V1)</h2>',
        '                    <div class="table-responsive" id="offsetTableContainer">Loading ledger...</div>',
        '                </div>',
        '            </div>',
        '            <div id="offset2-tab" style="display:none;">',
        '                <div class="pro-card">',
        '                    <h2 class="pro-card-header"><span class="material-symbols-outlined text-primary">alt_route</span> Strict Pair Sniper (V2 Matrix)</h2>',
        '                    <div class="metric-box" style="margin-bottom: 24px; border-left:4px solid var(--primary);">',
        '                        <div class="grid-2">',
        '                            <div><label style="margin-top:0;">Net Profit Target V2 ($)</label><input type="number" step="0.0001" id="smartOffsetNetProfit2" placeholder="e.g. 1.00 (0 = Disabled)"></div>',
        '                            <div><label style="margin-top:0;">Stop Loss V2 ($)</label><input type="number" step="0.0001" id="smartOffsetStopLoss2" placeholder="e.g. -2.00 (0 = Disabled)"></div>',
        '                        </div>',
        '                        <button class="md-btn md-btn-primary" style="margin-top:16px;" onclick="saveGlobalSettings()"><span class="material-symbols-outlined">save</span> Update V2 Parameters</button>',
        '                    </div>',
        '                    <p class="text-muted" style="margin-bottom:20px;">Real-time 1-to-1 pairings mapping (Rank 1 & N). Executes singular closure on absolute winners balancing lowest drawdowns.</p>',
        '                    <div class="table-responsive" id="liveOffsetsContainer2">Waiting for stream...</div>',
        '                </div>',
        '                <div class="pro-card">',
        '                    <h2 class="pro-card-header"><span class="material-symbols-outlined text-green">history</span> Execution Ledger (V2)</h2>',
        '                    <div class="table-responsive" id="offsetTableContainer2">Loading ledger...</div>',
        '                </div>',
        '            </div>',
        '            <div id="main-tab">',
        '                <!-- Top HUD Metrics -->',
        '                <div class="grid-4" style="margin-bottom: 16px;">',
        '                    <div class="metric-box" style="border-top: 3px solid var(--success);"><span class="metric-label">Session Realized (All)</span><span class="metric-val" id="globalPnl">$0.00</span></div>',
        '                    <div class="metric-box" style="border-top: 3px solid var(--warning);"><span class="metric-label">Active / Total Markets</span><span class="metric-val text-warning" id="globalWinRate">0 / 0</span></div>',
        '                    <div class="metric-box" style="border-top: 3px solid var(--primary);"><span class="metric-label">Total Collateral Used</span><span class="metric-val text-blue" id="topGlobalMargin">$0.00</span></div>',
        '                    <div class="metric-box" style="border-top: 3px solid var(--danger);"><span class="metric-label">Net Unrealized PNL</span><span class="metric-val" id="topGlobalUnrealized">$0.0000</span></div>',
        '                </div>',
        '                <!-- Projections Box -->',
        '                <div class="grid-4" style="margin-bottom: 24px;">',
        '                    <div class="metric-box"><span class="metric-label" style="color:var(--text-main);">Est. Per Hour</span><span class="metric-val" id="estHour">$0.00</span></div>',
        '                    <div class="metric-box"><span class="metric-label" style="color:var(--text-main);">Est. Per Day</span><span class="metric-val" id="estDay">$0.00</span></div>',
        '                    <div class="metric-box"><span class="metric-label" style="color:var(--text-main);">Est. Per Month</span><span class="metric-val" id="estMonth">$0.00</span></div>',
        '                    <div class="metric-box"><span class="metric-label" style="color:var(--text-main);">Est. Per Year</span><span class="metric-val" id="estYear">$0.00</span></div>',
        '                </div>',
        '                <!-- Read-Only Strategy Parameters for Regular Users -->',
        '                <div class="pro-card" id="user-strategy-display" style="display:none; margin-bottom: 24px;">',
        '                    <h2 class="pro-card-header"><span class="material-symbols-outlined text-primary">tune</span> Active Master Strategy Parameters</h2>',
        '                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px;">',
        '                        <div class="metric-box"><span class="metric-label">Univ. Coin TP</span><span class="metric-val text-green" id="display_globalSingleCoinTpPnl">$0.00</span></div>',
        '                        <div class="metric-box"><span class="metric-label">Univ. Coin SL</span><span class="metric-val text-danger" id="display_globalSingleCoinSlPnl">$0.00</span></div>',
        '                        <div class="metric-box"><span class="metric-label">Univ. Trigger DCA</span><span class="metric-val text-warning" id="display_globalTriggerDcaPnl">$0.00</span></div>',
        '                        <div class="metric-box"><span class="metric-label">Group Offset Target V1</span><span class="metric-val text-blue" id="display_smartOffsetNetProfit">$0.00</span></div>',
        '                        <div class="metric-box"><span class="metric-label">Stall Gate PNL</span><span class="metric-val" id="display_noPeakSlGatePnl" style="color: var(--text-main);">$0.00</span></div>',
        '                    </div>',
        '                </div>',
        '                <!-- Advanced Trading UI (Hidden for regular users) -->',
        '                <div id="advanced-trading-ui" style="display:none; width: 100%;">',
        '                    <!-- Auto Dyn Box -->',
        '                    <div id="autoDynStatusBox" class="pro-card" style="display:none; border:1px solid var(--primary); background:rgba(41,98,255,0.02);">',
        '                        <h3 style="margin-top:0; color:var(--primary); border-bottom:1px solid var(--border); padding-bottom:12px; display:flex; align-items:center; gap:8px;">',
        '                            <span class="material-symbols-outlined">bolt</span> 1-Min Auto-Dynamic Frequency Active',
        '                        </h3>',
        '                        <div id="autoDynLiveDetails" style="margin-top:16px;"></div>',
        '                    </div>',
        '                    <!-- Split Layout: Settings vs Live Status -->',
        '                    <div class="flex-row-wrap" style="align-items: stretch;">',
        '                        <!-- LEFT COLUMN: SETTINGS -->',
        '                        <div class="flex-1" style="min-width: 350px;">',
        '                            <!-- Global Settings Card -->',
        '                            <div class="pro-card">',
        '                                <h2 class="pro-card-header"><span class="material-symbols-outlined">public</span> Global Risk & Logic</h2>',
        '                                <h4 style="margin: 0 0 12px 0; color: var(--text-main); font-weight:600; font-size:0.9rem;">Global Peak & Trailing</h4>',
        '                                <div class="grid-2" style="margin-bottom: 16px;">',
        '                                    <div><label style="margin-top:0;">Portfolio Target ($)</label><input type="number" step="0.0001" id="globalTargetPnl" placeholder="0.00"></div>',
        '                                    <div><label style="margin-top:0;">Trailing Activation ($)</label><input type="number" step="0.0001" id="globalTrailingPnl" placeholder="0.00"></div>',
        '                                </div>',
        '                                <div class="grid-2" style="margin-bottom: 24px;">',
        '                                    <div><label class="text-green" style="margin-top:0;">Univ. Coin TP ($)</label><input type="number" step="0.0001" id="globalSingleCoinTpPnl" placeholder="0.00"></div>',
        '                                    <div><label class="text-danger" style="margin-top:0;">Univ. Coin SL ($)</label><input type="number" step="0.0001" id="globalSingleCoinSlPnl" placeholder="0.00"></div>',
        '                                    <div style="grid-column: 1 / -1;"><label class="text-warning" style="margin-top:0;">Univ. Grid DCA Trigger ($)</label><input type="number" step="0.0001" id="globalTriggerDcaPnl" placeholder="-2.00"></div>',
        '                                </div>',
        '                                <h4 style="margin: 0 0 12px 0; border-top:1px solid var(--border); padding-top:20px; color: var(--text-main); font-weight:600; font-size:0.9rem;">Smart Offset V1 Logic</h4>',
        '                                <div class="grid-2" style="margin-bottom: 16px;">',
        '                                    <div><label style="margin-top:0;">Group TP Target ($)</label><input type="number" step="0.0001" id="smartOffsetNetProfit" placeholder="0.00"></div>',
        '                                    <div><label style="margin-top:0;">Full Group SL ($)</label><input type="number" step="0.0001" id="smartOffsetStopLoss" placeholder="0.00"></div>',
        '                                </div>',
        '                                <div class="grid-2" style="margin-bottom: 24px;">',
        '                                    <div><label style="margin-top:0;">Nth Row Reference</label><input type="number" step="1" id="smartOffsetBottomRowV1" placeholder="5"></div>',
        '                                    <div><label style="margin-top:0;">Nth Gate Limit ($)</label><input type="number" step="0.0001" id="smartOffsetBottomRowV1StopLoss" placeholder="0.00"></div>',
        '                                </div>',
        '                                <h4 style="margin: 0 0 12px 0; border-top:1px solid var(--border); padding-top:20px; color: var(--text-main); font-weight:600; font-size:0.9rem;">High-Freq Execution Limits</h4>',
        '                                <div class="grid-2" style="margin-bottom: 16px;">',
        '                                    <div><label style="margin-top:0;">Max Volatility Loss ($)</label><input type="number" step="0.0001" id="smartOffsetMaxLossPerMinute" placeholder="10.00"></div>',
        '                                    <div><label style="margin-top:0;">Rolling Window (Secs)</label><input type="number" step="1" id="smartOffsetMaxLossTimeframeSeconds" placeholder="60"></div>',
        '                                </div>',
        '                                <div class="grid-2" style="margin-bottom: 24px;">',
        '                                    <div><label style="margin-top:0;">Stall Out Cut (Secs)</label><input type="number" step="1" id="noPeakSlTimeframeSeconds" placeholder="1800"></div>',
        '                                    <div><label style="margin-top:0;">Stall Recovery Gate ($)</label><input type="number" step="0.0001" id="noPeakSlGatePnl" placeholder="0.00"></div>',
        '                                </div>',
        '                                <h4 style="margin: 0 0 12px 0; border-top:1px solid var(--border); padding-top:20px; color: var(--text-main); font-weight:600; font-size:0.9rem;">1-Minute Interval Closer</h4>',
        '                                <label class="checkbox-wrapper" style="margin-bottom:16px;">',
        '                                    <input type="checkbox" id="minuteCloseAutoDynamic">',
        '                                    <span>Engage Auto-Dynamic Boundaries</span>',
        '                                </label>',
        '                                <div style="background:var(--bg-surface); padding:16px; border:1px solid var(--border); border-radius:6px; margin-bottom:20px;">',
        '                                    <label style="margin-top:0; color:var(--success);">Take Profit Boundary Range ($)</label>',
        '                                    <div class="grid-2" style="margin-bottom:12px;">',
        '                                        <input type="number" step="0.0001" id="minuteCloseTpMinPnl" placeholder="Min Limit">',
        '                                        <input type="number" step="0.0001" id="minuteCloseTpMaxPnl" placeholder="Max Limit">',
        '                                    </div>',
        '                                    <label style="color:var(--danger);">Stop Loss Boundary Range ($)</label>',
        '                                    <div class="grid-2">',
        '                                        <input type="number" step="0.0001" id="minuteCloseSlMinPnl" placeholder="Min Limit">',
        '                                        <input type="number" step="0.0001" id="minuteCloseSlMaxPnl" placeholder="Max Limit">',
        '                                    </div>',
        '                                </div>',
        '                                <button class="md-btn md-btn-primary" style="width:100%; padding:14px;" onclick="saveGlobalSettings()"><span class="material-symbols-outlined">cloud_upload</span> Deploy Global Config</button>',
        '                            </div>',
        '                            <!-- Profile Setup Card -->',
        '                            <div class="pro-card">',
        '                                <h2 class="pro-card-header"><span class="material-symbols-outlined">manage_accounts</span> Routing Profiles</h2>',
        '                                <div class="metric-box" style="margin-bottom: 24px;">',
        '                                    <div class="flex-row-wrap" style="justify-content: space-between; margin-bottom: 16px;">',
        '                                        <h4 style="margin: 0;">Active Profile</h4>',
        '                                        <label class="checkbox-wrapper" style="margin:0;"><input type="checkbox" onchange="toggleNewKeys(this)"><span style="font-size:0.8rem; text-transform:none;">Reveal Keys</span></label>',
        '                                    </div>',
        '                                    <div class="flex-row-wrap" style="margin-bottom: 16px;">',
        '                                        <select id="subAccountSelect" style="flex:1; min-width:200px;"><option value="">-- Awaiting Selection --</option></select>',
        '                                        <button class="md-btn md-btn-primary" onclick="loadSubAccount()"><span class="material-symbols-outlined" style="font-size:18px;">download</span></button>',
        '                                        <button class="md-btn md-btn-danger" onclick="removeSubAccount()"><span class="material-symbols-outlined" style="font-size:18px;">delete</span></button>',
        '                                    </div>',
        '                                    <div class="grid-2" style="gap:12px;">',
        '                                        <input type="text" id="newSubName" placeholder="Profile Alias">',
        '                                        <input type="password" id="newSubKey" placeholder="API Key">',
        '                                        <input type="password" id="newSubSecret" placeholder="Secret Key">',
        '                                        <button class="md-btn md-btn-success" onclick="addSubAccount()"><span class="material-symbols-outlined" style="font-size:18px;">add</span> Append</button>',
        '                                    </div>',
        '                                </div>',
        '                                <!-- Profile Specific Settings -->',
        '                                <div id="settingsContainer" style="display:none; border-top:1px solid var(--border); padding-top:20px;">',
        '                                    <div class="flex-row-wrap" style="justify-content: space-between; margin-bottom:12px;">',
        '                                        <h4 style="margin:0;">API Endpoints</h4>',
        '                                        <label class="checkbox-wrapper" style="margin:0;"><input type="checkbox" id="showActiveKeysCheckbox" onchange="toggleActiveKeys(this)"><span style="font-size:0.8rem; text-transform:none;">Reveal Keys</span></label>',
        '                                    </div>',
        '                                    <div class="grid-2" style="margin-bottom:20px;">',
        '                                        <input type="password" id="apiKey" placeholder="HTX API Key">',
        '                                        <input type="password" id="secret" placeholder="HTX Secret Key">',
        '                                    </div>',
        '                                    <div class="flex-row-wrap" style="gap: 12px; margin-bottom: 24px;">',
        '                                        <button class="md-btn md-btn-success" style="flex:1;" onclick="globalToggleBot(true)"><span class="material-symbols-outlined">play_circle</span> Ignite All</button>',
        '                                        <button class="md-btn md-btn-danger" style="flex:1;" onclick="globalToggleBot(false)"><span class="material-symbols-outlined">stop_circle</span> Halt All</button>',
        '                                    </div>',
        '                                    <div class="grid-2" style="margin-bottom:16px;">',
        '                                        <div><label style="margin-top:0;">Direction Bias</label><select id="side"><option value="long">Long Bias</option><option value="short">Short Bias</option></select></div>',
        '                                        <div><label style="margin-top:0;">Leverage Lock</label><input type="text" id="leverage" disabled value="Auto (Oracle)"></div>',
        '                                    </div>',
        '                                    <label>Base Contract Weight (Qty)</label>',
        '                                    <input type="number" id="baseQty" style="margin-bottom:16px;">',
        '                                    <div class="grid-2" style="margin-bottom:16px;">',
        '                                        <div><label style="margin-top:0;">Local TP (%)</label><input type="number" step="0.1" id="takeProfitPct"></div>',
        '                                        <div><label class="text-green" style="margin-top:0;">Local TP Net ($)</label><input type="number" step="0.0001" id="takeProfitPnl" placeholder="0.00"></div>',
        '                                    </div>',
        '                                    <div class="grid-2" style="margin-bottom:16px;">',
        '                                        <div><label style="margin-top:0;">Local SL (%)</label><input type="number" step="0.1" id="stopLossPct"></div>',
        '                                        <div><label class="text-danger" style="margin-top:0;">Local DCA Scale ($)</label><input type="number" step="0.0001" id="triggerDcaPnl" placeholder="-2.00"></div>',
        '                                    </div>',
        '                                    <label>Safety Contract Ceiling</label>',
        '                                    <input type="number" id="maxContracts" style="margin-bottom:24px;">',
        '                                    <h3 style="margin-top:0; border-top:1px solid var(--border); padding-top:20px;"><span class="material-symbols-outlined" style="vertical-align:middle; color:var(--primary);">toll</span> Pair Allocation Array</h3>',
        '                                    <div class="metric-box" style="margin-bottom: 20px;">',
        '                                        <div class="grid-2" style="margin-bottom: 16px;">',
        '                                            <div><label style="margin-top:0;">Default Boot</label><select id="predefStatus"><option value="started">Active</option><option value="stopped">Halted</option></select></div>',
        '                                            <div><label style="margin-top:0;">Array Logic</label><select id="predefSide"><option value="oddLong">Odd L / Even S</option><option value="evenLong">Even L / Odd S</option><option value="allLong">All Long</option><option value="allShort">All Short</option></select></div>',
        '                                    </div>',
        '                                        <button class="md-btn md-btn-text" style="border:1px solid var(--primary); color:var(--primary); width:100%;" onclick="addPredefinedList()"><span class="material-symbols-outlined">playlist_add</span> Inject Standard 54-Pair Matrix</button>',
        '                                    </div>',
        '                                    <div class="flex-row" style="margin-bottom: 20px;">',
        '                                        <input type="text" id="newCoinSymbol" placeholder="e.g. BTC/USDT:USDT" style="flex:1;">',
        '                                        <button class="md-btn md-btn-success" onclick="addCoinUI()"><span class="material-symbols-outlined" style="font-size:18px;">add</span> Add</button>',
        '                                    </div>',
        '                                    <div id="coinsListContainer" style="max-height:300px; overflow-y:auto; padding-right:8px; margin-bottom:20px;"></div>',
        '                                    <button class="md-btn md-btn-primary" style="width:100%; padding:14px;" onclick="saveSettings()"><span class="material-symbols-outlined">save</span> Write Profile to DB</button>',
        '                                </div>',
        '                            </div>',
        '                        </div>',
        '                        <!-- RIGHT COLUMN: LIVE TERMINAL -->',
        '                        <div class="flex-1" style="flex-basis: 50%;">',
        '                            <div class="pro-card" style="position: sticky; top: 90px;">',
        '                                <h2 class="pro-card-header"><span class="material-symbols-outlined">query_stats</span> Telemetry & Terminal</h2>',
        '                                <div class="grid-2" style="margin-bottom:24px;">',
        '                                    <div class="metric-box"><span class="metric-label">Profile Realized</span><span class="metric-val" id="profilePnl">$0.00</span></div>',
        '                                    <div class="metric-box"><span class="metric-label">Profile Collateral</span><span class="metric-val text-blue" id="profileMargin">$0.00</span></div>',
        '                                </div>',
        '                                <div id="dashboardStatusContainer" style="max-height: 400px; overflow-y:auto; padding-right:8px; margin-bottom:24px;">',
        '                                    <p class="text-muted" style="text-align:center; padding:20px;">Awaiting Engine Start...</p>',
        '                                </div>',
        '                                <h3 style="margin-top:0; border-top:1px solid var(--border); padding-top:20px;"><span class="material-symbols-outlined" style="vertical-align:middle; color:var(--primary);">terminal</span> System Output Stream</h3>',
        '                                <div class="log-box" id="logs">Connecting to event stream...</div>',
        '                            </div>',
        '                        </div>',
        '                    </div>',
        '                </div>',
        '            </div>',
        '        </div>',
        '    </div>',
        '    <script>',
        '        let token = localStorage.getItem(\'token\');',
        '        let isPaperUser = true; ',
        '        let myUsername = \'\';',
        '        let statusInterval = null;',
        '        let mySubAccounts = [];',
        '        let myGlobalTargetPnl = 0;',
        '        let myGlobalTrailingPnl = 0;',
        '        let myGlobalSingleCoinTpPnl = 0;',
        '        let myGlobalSingleCoinSlPnl = 0;',
        '        let myGlobalTriggerDcaPnl = 0;',
        '        let mySmartOffsetNetProfit = 0;',
        '        let mySmartOffsetBottomRowV1 = 5;',
        '        let mySmartOffsetBottomRowV1StopLoss = 0; ',
        '        let mySmartOffsetStopLoss = 0;',
        '        let mySmartOffsetNetProfit2 = 0;',
        '        let mySmartOffsetStopLoss2 = 0;',
        '        let mySmartOffsetMaxLossPerMinute = 0;',
        '        let mySmartOffsetMaxLossTimeframeSeconds = 60;',
        '        let myMinuteCloseAutoDynamic = false;',
        '        let myMinuteCloseTpMinPnl = 0;',
        '        let myMinuteCloseTpMaxPnl = 0;',
        '        let myMinuteCloseSlMinPnl = 0;',
        '        let myMinuteCloseSlMaxPnl = 0;',
        '        let myNoPeakSlTimeframeSeconds = 1800;',
        '        let myNoPeakSlGatePnl = 0;',
        '        let currentProfileIndex = -1;',
        '        let myCoins = [];',
        '        const PREDEFINED_COINS = ["OP", "BIGTIME", "MOVE", "SSV", "COAI", "TIA", "MERL", "MASK", "PYTH", "ETHFI", "CFX", "MEME", "LUNA", "STEEM", "BERA", "2Z", "FIL", "APT", "1INCH", "ARB", "XPL", "ENA", "MMT", "AXS", "TON", "CAKE", "BSV", "JUP", "WIF", "LIGHT", "PI", "SUSHI", "LPT", "CRV", "TAO", "ORDI", "YFI", "LA", "ICP", "FTT", "GIGGLE", "LDO", "OPN", "INJ", "SNX", "DASH", "WLD", "KAITO", "TRUMP", "WAVES", "ZEN", "ENS", "ASTER", "VIRTUAL"];',
        '        async function checkAuth() {',
        '            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }',
        '            if (token) {',
        '                try {',
        '                    const meRes = await fetch(\'/api/me\', { headers: { \'Authorization\': \'Bearer \' + token } });',
        '                    if (!meRes.ok) throw new Error("Invalid token");',
        '                    const meData = await meRes.json();',
        '                    isPaperUser = meData.isPaper;',
        '                    myUsername = meData.username;',
        '                    document.getElementById(\'landing-view\').style.display = \'none\';',
        '                    document.getElementById(\'auth-view\').style.display = \'none\';',
        '                    document.getElementById(\'dashboard-view\').style.display = \'block\';',
        '                    updateUIMode();',
        '                    if (myUsername !== \'webcoin8888\') {',
        '                        await fetchSettings();',
        '                        await loadStatus(); ',
        '                        statusInterval = setInterval(loadStatus, 5000);',
        '                    }',
        '                } catch(e) { logout(); return; }',
        '            } else {',
        '                document.getElementById(\'landing-view\').style.display = \'block\';',
        '                document.getElementById(\'auth-view\').style.display = \'none\';',
        '                document.getElementById(\'dashboard-view\').style.display = \'none\';',
        '                updateLoggedOutNav();',
        '            }',
        '        }',
        '        function showAuth(mode) {',
        '            document.getElementById(\'landing-view\').style.display = \'none\';',
        '            document.getElementById(\'auth-view\').style.display = \'block\';',
        '            const header = document.getElementById(\'auth-header\');',
        '            const btn = document.getElementById(\'auth-submit-btn\');',
        '            const toggleBtn = document.getElementById(\'auth-toggle-btn\');',
        '            const regFields = document.getElementById(\'register-fields\');',
        '            if(mode === \'register\') {',
        '                header.innerText = "Deploy New Instance";',
        '                btn.innerText = "Initialize Account";',
        '                btn.onclick = () => executeAuth(\'register\');',
        '                toggleBtn.innerText = "Existing user? Login here";',
        '                toggleBtn.onclick = () => showAuth(\'login\');',
        '                regFields.style.display = \'block\';',
        '            } else {',
        '                header.innerText = "Secure Terminal Login";',
        '                btn.innerText = "Authenticate";',
        '                btn.onclick = () => executeAuth(\'login\');',
        '                toggleBtn.innerText = "New user? Deploy instance";',
        '                toggleBtn.onclick = () => showAuth(\'register\');',
        '                regFields.style.display = \'none\';',
        '            }',
        '        }',
        '        function toggleAuthMode() {',
        '            const current = document.getElementById(\'auth-submit-btn\').innerText;',
        '            showAuth(current === \'Authenticate\' ? \'register\' : \'login\');',
        '        }',
        '        function updateLoggedOutNav() {',
        '            document.getElementById(\'nav-actions\').innerHTML = \'<button class="md-btn md-btn-text" style="color:var(--text-main);" onclick="showAuth(\\\'login\\\')">Sign In</button><button class="md-btn md-btn-primary" onclick="showAuth(\\\'register\\\')">Deploy Bot</button>\';',
        '        }',
        '        function updateUIMode() {',
        '            const navActions = document.getElementById(\'nav-actions\');',
        '            let navHtml = \'\';',
        '            if (myUsername === \'webcoin8888\') {',
        '                navHtml += \'<button class="md-btn md-btn-text nav-btn active" id="btn-tab-editor" onclick="switchTab(\\\'editor\\\')"><span class="material-symbols-outlined">database</span> Template Editor</button>\';',
        '                navHtml += \'<button class="md-btn md-btn-text nav-btn" id="btn-tab-admin" onclick="switchTab(\\\'admin\\\')"><span class="material-symbols-outlined">manage_accounts</span> User Admin</button>\';',
        '                navHtml += \'<button class="md-btn md-btn-text nav-btn" id="btn-tab-main" onclick="switchTab(\\\'main\\\')"><span class="material-symbols-outlined">dashboard</span> Matrix Hub</button>\';',
        '                navHtml += \'<button class="md-btn md-btn-text nav-btn" id="btn-tab-offsets" onclick="switchTab(\\\'offsets\\\')"><span class="material-symbols-outlined">call_merge</span> Array V1</button>\';',
        '                navHtml += \'<button class="md-btn md-btn-text nav-btn" id="btn-tab-offsets2" onclick="switchTab(\\\'offsets2\\\')"><span class="material-symbols-outlined">alt_route</span> Array V2</button>\';',
        '                navHtml += \'<button class="md-btn md-btn-text" style="color:var(--text-muted); border-left:1px solid var(--border); border-radius:0; padding-left:16px; margin-left:8px;" onclick="logout()"><span class="material-symbols-outlined">logout</span> Disconnect</button>\';',
        '                navActions.innerHTML = navHtml;',
        '                document.getElementById(\'advanced-trading-ui\').style.display = \'flex\';',
        '                document.getElementById(\'user-strategy-display\').style.display = \'none\';',
        '                switchTab(\'editor\');',
        '            } else {',
        '                const badgeHtml = isPaperUser ? \'<span style="background:rgba(41,98,255,0.2); color:var(--primary); padding:4px 8px; border-radius:4px; font-size:0.7rem; font-weight:bold; margin-right:12px;">SIMULATION MODE</span>\' : \'<span style="background:rgba(14,203,129,0.2); color:var(--success); padding:4px 8px; border-radius:4px; font-size:0.7rem; font-weight:bold; margin-right:12px;">LIVE NETWORK</span>\';',
        '                navHtml += badgeHtml;',
        '                navHtml += \'<button class="md-btn md-btn-text nav-btn active" id="btn-tab-main" onclick="switchTab(\\\'main\\\')"><span class="material-symbols-outlined">dashboard</span> Client Dashboard</button>\';',
        '                navHtml += \'<button class="md-btn md-btn-text" style="color:var(--text-muted); border-left:1px solid var(--border); border-radius:0; padding-left:16px; margin-left:8px;" onclick="logout()"><span class="material-symbols-outlined">logout</span> Disconnect</button>\';',
        '                navActions.innerHTML = navHtml;',
        '                document.getElementById(\'advanced-trading-ui\').style.display = \'none\';',
        '                document.getElementById(\'user-strategy-display\').style.display = \'block\';',
        '                switchTab(\'main\');',
        '            }',
        '        }',
        '        function switchTab(tab) {',
        '            const tabs = [\'main\', \'offset\', \'offset2\', \'admin\', \'editor\'];',
        '            tabs.forEach(t => { const el = document.getElementById(t + \'-tab\'); if(el) el.style.display = \'none\'; });',
        '            const btns = document.querySelectorAll(\'.nav-btn\');',
        '            btns.forEach(b => b.classList.remove(\'active\'));',
        '            if (tab === \'main\') { document.getElementById(\'main-tab\').style.display = \'block\'; const btn = document.getElementById(\'btn-tab-main\'); if(btn) btn.classList.add(\'active\'); } ',
        '            else if (tab === \'offsets\') { document.getElementById(\'offset-tab\').style.display = \'block\'; const btn = document.getElementById(\'btn-tab-offsets\'); if(btn) btn.classList.add(\'active\'); loadOffsets(); } ',
        '            else if (tab === \'offsets2\') { document.getElementById(\'offset2-tab\').style.display = \'block\'; const btn = document.getElementById(\'btn-tab-offsets2\'); if(btn) btn.classList.add(\'active\'); loadOffsets(); } ',
        '            else if (tab === \'admin\') { document.getElementById(\'admin-tab\').style.display = \'block\'; const btn = document.getElementById(\'btn-tab-admin\'); if(btn) btn.classList.add(\'active\'); loadAdminData(); } ',
        '            else if (tab === \'editor\') { document.getElementById(\'editor-tab\').style.display = \'block\'; const btn = document.getElementById(\'btn-tab-editor\'); if(btn) btn.classList.add(\'active\'); loadMasterEditor(); }',
        '        }',
        '        async function executeAuth(action) {',
        '            const username = document.getElementById(\'username\').value;',
        '            const password = document.getElementById(\'password\').value;',
        '            const authCode = document.getElementById(\'authCode\').value;',
        '            const qtyMultiplier = document.getElementById(\'qtyMultiplier\') ? document.getElementById(\'qtyMultiplier\').value : 1;',
        '            const msgEl = document.getElementById(\'auth-msg\');',
        '            msgEl.innerText = "Connecting to relay..."; msgEl.className = "text-muted";',
        '            const bodyObj = { username, password };',
        '            if (action === \'register\') { bodyObj.authCode = authCode; bodyObj.qtyMultiplier = qtyMultiplier; }',
        '            try {',
        '                const res = await fetch(\'/api/\' + action, { method: \'POST\', headers: { \'Content-Type\': \'application/json\' }, body: JSON.stringify(bodyObj) });',
        '                const data = await res.json();',
        '                if (data.token) { token = data.token; localStorage.setItem(\'token\', token); msgEl.innerText = ""; await checkAuth(); } ',
        '                else { msgEl.innerText = data.error || data.message; msgEl.className = data.success ? \'text-green\' : \'text-red\'; }',
        '            } catch (e) { msgEl.innerText = "Relay connection failed."; msgEl.className = "text-red"; }',
        '        }',
        '        async function closeAllPositions() {',
        '            if (isPaperUser) return alert("Paper Accounts cannot execute real emergency close orders.");',
        '            if (!confirm("🚨 WARNING: FORCE CLOSE ALL POSITIONS on every active profile?")) return;',
        '            const res = await fetch(\'/api/close-all\', { method: \'POST\', headers: { \'Authorization\': \'Bearer \' + token } });',
        '            const data = await res.json();',
        '            if(data.success) alert(data.message); else alert("Error: " + data.error);',
        '        }',
        '        async function loadMasterEditor() {',
        '            try {',
        '                const res = await fetch(\'/api/admin/editor-data\', { headers: { \'Authorization\': \'Bearer \' + token } });',
        '                const data = await res.json();',
        '                const masterSettings = data.masterSettings;',
        '                if (!masterSettings) { document.getElementById(\'editorGlobalContainer\').innerHTML = \'<p class="text-red">Master config missing. Initialize first.</p>\'; return; }',
        '                let globalHtml = \'<form id="globalSettingsForm">\';',
        '                globalHtml += \'<div class="grid-2" style="margin-bottom: 16px;"><div><label>Global Target PNL ($)</label><input type="number" step="0.0001" id="e_globalTargetPnl" value="\' + (masterSettings.globalTargetPnl !== undefined ? masterSettings.globalTargetPnl : 0) + \'"></div><div><label>Global Trailing PNL ($)</label><input type="number" step="0.0001" id="e_globalTrailingPnl" value="\' + (masterSettings.globalTrailingPnl !== undefined ? masterSettings.globalTrailingPnl : 0) + \'"></div></div>\';',
        '                globalHtml += \'<div class="grid-3" style="margin-bottom: 16px;"><div><label class="text-green">Univ. Coin TP ($)</label><input type="number" step="0.0001" id="e_globalSingleCoinTpPnl" value="\' + (masterSettings.globalSingleCoinTpPnl !== undefined ? masterSettings.globalSingleCoinTpPnl : 0) + \'"></div><div><label class="text-danger">Univ. Coin SL ($)</label><input type="number" step="0.0001" id="e_globalSingleCoinSlPnl" value="\' + (masterSettings.globalSingleCoinSlPnl !== undefined ? masterSettings.globalSingleCoinSlPnl : 0) + \'"></div><div><label class="text-warning">Univ. Trigger DCA ($)</label><input type="number" step="0.0001" id="e_globalTriggerDcaPnl" value="\' + (masterSettings.globalTriggerDcaPnl !== undefined ? masterSettings.globalTriggerDcaPnl : 0) + \'"></div></div>\';',
        '                globalHtml += \'<div class="grid-2" style="margin-bottom: 16px;"><div><label>Group Offset Target V1 ($)</label><input type="number" step="0.0001" id="e_smartOffsetNetProfit" value="\' + (masterSettings.smartOffsetNetProfit !== undefined ? masterSettings.smartOffsetNetProfit : 0) + \'"></div><div><label>Full Group Stop Loss V1 ($)</label><input type="number" step="0.0001" id="e_smartOffsetStopLoss" value="\' + (masterSettings.smartOffsetStopLoss !== undefined ? masterSettings.smartOffsetStopLoss : 0) + \'"></div></div>\';',
        '                globalHtml += \'<div class="grid-2" style="margin-bottom: 16px;"><div><label>Nth Row Reference (V1 Gate)</label><input type="number" step="1" id="e_smartOffsetBottomRowV1" value="\' + (masterSettings.smartOffsetBottomRowV1 !== undefined ? masterSettings.smartOffsetBottomRowV1 : 5) + \'"></div><div><label>Nth Gate Limit ($)</label><input type="number" step="0.0001" id="e_smartOffsetBottomRowV1StopLoss" value="\' + (masterSettings.smartOffsetBottomRowV1StopLoss !== undefined ? masterSettings.smartOffsetBottomRowV1StopLoss : 0) + \'"></div></div>\';',
        '                globalHtml += \'<div class="grid-2" style="margin-bottom: 16px;"><div><label>Smart Offset Target V2 ($)</label><input type="number" step="0.0001" id="e_smartOffsetNetProfit2" value="\' + (masterSettings.smartOffsetNetProfit2 !== undefined ? masterSettings.smartOffsetNetProfit2 : 0) + \'"></div><div><label>Smart Offset Stop Loss V2 ($)</label><input type="number" step="0.0001" id="e_smartOffsetStopLoss2" value="\' + (masterSettings.smartOffsetStopLoss2 !== undefined ? masterSettings.smartOffsetStopLoss2 : 0) + \'"></div></div>\';',
        '                globalHtml += \'<div class="grid-2" style="margin-bottom: 16px;"><div><label>Max Loss Limit Amount ($)</label><input type="number" step="0.0001" id="e_smartOffsetMaxLossPerMinute" value="\' + (masterSettings.smartOffsetMaxLossPerMinute !== undefined ? masterSettings.smartOffsetMaxLossPerMinute : 0) + \'"></div><div><label>Max Loss Time (Secs)</label><input type="number" step="1" id="e_smartOffsetMaxLossTimeframeSeconds" value="\' + (masterSettings.smartOffsetMaxLossTimeframeSeconds !== undefined ? masterSettings.smartOffsetMaxLossTimeframeSeconds : 60) + \'"></div></div>\';',
        '                globalHtml += \'<div class="grid-2" style="margin-bottom: 16px;"><div><label>Stall Cut Timeframe (Secs)</label><input type="number" step="1" id="e_noPeakSlTimeframeSeconds" value="\' + (masterSettings.noPeakSlTimeframeSeconds !== undefined ? masterSettings.noPeakSlTimeframeSeconds : 1800) + \'"></div><div><label>Stall Gate PNL ($)</label><input type="number" step="0.0001" id="e_noPeakSlGatePnl" value="\' + (masterSettings.noPeakSlGatePnl !== undefined ? masterSettings.noPeakSlGatePnl : 0) + \'"></div></div>\';',
        '                globalHtml += \'<div style="background:var(--bg-surface); padding:16px; border:1px solid var(--border); border-radius:6px; margin:20px 0;">\';',
        '                globalHtml += \'<label style="margin-top:0; color:var(--success);">1-Min Check: Take Profit Bounds ($)</label>\';',
        '                globalHtml += \'<div class="grid-2" style="margin-bottom:12px;"><input type="number" step="0.0001" id="e_minuteCloseTpMinPnl" value="\' + (masterSettings.minuteCloseTpMinPnl !== undefined ? masterSettings.minuteCloseTpMinPnl : 0) + \'" placeholder="Min TP"><input type="number" step="0.0001" id="e_minuteCloseTpMaxPnl" value="\' + (masterSettings.minuteCloseTpMaxPnl !== undefined ? masterSettings.minuteCloseTpMaxPnl : 0) + \'" placeholder="Max TP"></div>\';',
        '                globalHtml += \'<label style="margin-top:12px; color:var(--danger);">1-Min Check: Stop Loss Bounds ($)</label>\';',
        '                globalHtml += \'<div class="grid-2"><input type="number" step="0.0001" id="e_minuteCloseSlMinPnl" value="\' + (masterSettings.minuteCloseSlMinPnl !== undefined ? masterSettings.minuteCloseSlMinPnl : 0) + \'" placeholder="Min SL"><input type="number" step="0.0001" id="e_minuteCloseSlMaxPnl" value="\' + (masterSettings.minuteCloseSlMaxPnl !== undefined ? masterSettings.minuteCloseSlMaxPnl : 0) + \'" placeholder="Max SL"></div>\';',
        '                globalHtml += \'</div>\';',
        '                globalHtml += \'<label class="checkbox-wrapper" style="margin-bottom:20px;"><input type="checkbox" id="e_minuteCloseAutoDynamic" \' + (masterSettings.minuteCloseAutoDynamic ? \'checked\' : \'\') + \'> <span>Engage Auto-Dynamic Boundaries (1-Min)</span></label>\';',
        '                globalHtml += \'<button type="button" class="md-btn md-btn-primary" style="width:100%; padding:14px;" onclick="saveMasterGlobalSettings()"><span class="material-symbols-outlined">cloud_sync</span> Overwrite Global Array & Sync</button>\';',
        '                globalHtml += \'<div id="e_globalMsg" style="margin-top: 12px; font-weight: 600; text-align:center;"></div></form>\';',
        '                document.getElementById(\'editorGlobalContainer\').innerHTML = globalHtml;',
        '                let profilesHtml = \'\';',
        '                if (masterSettings.subAccounts && masterSettings.subAccounts.length > 0) {',
        '                    masterSettings.subAccounts.forEach((sub, i) => {',
        '                        const activeCoins = (sub.coins || []).filter(c => c.botActive);',
        '                        const coinHtml = activeCoins.map(c => \'<span style="display:inline-block; background:\' + (c.side === \'short\' ? \'rgba(246,70,93,0.15)\' : \'rgba(14,203,129,0.15)\') + \'; color:\' + (c.side === \'short\' ? \'var(--danger)\' : \'var(--success)\') + \'; border:1px solid \' + (c.side === \'short\' ? \'rgba(246,70,93,0.3)\' : \'rgba(14,203,129,0.3)\') + \'; padding:2px 8px; border-radius:4px; font-size:0.75rem; font-weight:600; margin:3px;">\' + c.symbol + \' (\' + c.side.charAt(0).toUpperCase() + \')</span>\').join(\' \');',
        '                        profilesHtml += \'<div class="metric-box" style="margin-bottom: 24px; padding:0; border: 1px solid var(--border); background: var(--bg-surface); overflow:hidden;">\';',
        '                        profilesHtml += \'<div style="background: rgba(0,0,0,0.2); padding: 16px; border-bottom: 1px solid var(--border); color: var(--text-main); display:flex; justify-content:space-between; font-weight:600;"><span>[Template \' + (i + 1) + \'] \' + sub.name + \'</span><span class="text-muted">Bias: \' + (sub.side || \'long\').toUpperCase() + \'</span></div>\';',
        '                        profilesHtml += \'<div style="padding:20px;">\';',
        '                        profilesHtml += \'<div class="grid-2" style="margin-bottom: 20px;"><div><label style="margin-top:0;">API Key Schema</label><input type="text" id="p_\' + i + \'_apiKey" value="\' + (sub.apiKey || \'\') + \'"></div><div><label style="margin-top:0;">Secret Key Schema</label><input type="text" id="p_\' + i + \'_secret" value="\' + (sub.secret || \'\') + \'"></div></div>\';',
        '                        profilesHtml += \'<div class="table-responsive" style="margin-bottom: 20px;"><table class="md-table"><tr><th>Base Qty</th><th>Local TP %</th><th class="text-green">Local TP ($)</th><th>Local SL %</th><th class="text-danger">Local DCA ($)</th><th>Ceiling Limit</th></tr>\';',
        '                        profilesHtml += \'<tr><td><input type="number" step="1" id="p_\' + i + \'_baseQty" value="\' + (sub.baseQty !== undefined ? sub.baseQty : 1) + \'"></td><td><input type="number" step="0.1" id="p_\' + i + \'_takeProfitPct" value="\' + (sub.takeProfitPct !== undefined ? sub.takeProfitPct : 5.0) + \'"></td><td><input type="number" step="0.0001" id="p_\' + i + \'_takeProfitPnl" value="\' + (sub.takeProfitPnl !== undefined ? sub.takeProfitPnl : 0) + \'"></td><td><input type="number" step="0.1" id="p_\' + i + \'_stopLossPct" value="\' + (sub.stopLossPct !== undefined ? sub.stopLossPct : -25.0) + \'"></td><td><input type="number" step="0.0001" id="p_\' + i + \'_triggerDcaPnl" value="\' + (sub.triggerDcaPnl !== undefined ? sub.triggerDcaPnl : -2.0) + \'"></td><td><input type="number" step="1" id="p_\' + i + \'_maxContracts" value="\' + (sub.maxContracts !== undefined ? sub.maxContracts : 1000) + \'"></td></tr></table></div>\';',
        '                        profilesHtml += \'<p style="margin:0 0 12px 0; font-size:0.8rem; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">Matrix Population (\' + activeCoins.length + \' Nodes):</p><div style="margin-bottom: 20px; max-height:100px; overflow-y:auto; padding-right:8px;">\' + (coinHtml || \'<span class="text-muted">Empty Array</span>\') + \'</div>\';',
        '                        profilesHtml += \'<button type="button" class="md-btn md-btn-success" style="width:100%; padding:12px;" onclick="saveMasterProfile(\' + i + \')"><span class="material-symbols-outlined">sync</span> Compile & Sync Template \' + (i + 1) + \'</button><div id="p_\' + i + \'_msg" style="margin-top: 12px; font-weight: 600; text-align:center;"></div></div></div>\';',
        '                    });',
        '                } else { profilesHtml += \'<p class="text-muted">No routing schemas found.</p>\'; }',
        '                document.getElementById(\'editorProfilesContainer\').innerHTML = profilesHtml;',
        '            } catch (e) { document.getElementById(\'editorGlobalContainer\').innerHTML = \'<p class="text-red">Telemetry retrieval failed.</p>\'; }',
        '        }',
        '        async function saveMasterGlobalSettings() {',
        '            const getVal = (id, def) => { const el = document.getElementById(id); return el && el.value !== \'\' ? parseFloat(el.value) : def; };',
        '            const getInt = (id, def) => { const el = document.getElementById(id); return el && el.value !== \'\' ? parseInt(el.value) : def; };',
        '            const payload = {',
        '                globalTargetPnl: getVal(\'e_globalTargetPnl\', 0),',
        '                globalTrailingPnl: getVal(\'e_globalTrailingPnl\', 0),',
        '                globalSingleCoinTpPnl: getVal(\'e_globalSingleCoinTpPnl\', 0),',
        '                globalSingleCoinSlPnl: getVal(\'e_globalSingleCoinSlPnl\', 0),',
        '                globalTriggerDcaPnl: getVal(\'e_globalTriggerDcaPnl\', 0),',
        '                smartOffsetNetProfit: getVal(\'e_smartOffsetNetProfit\', 0),',
        '                smartOffsetBottomRowV1: getInt(\'e_smartOffsetBottomRowV1\', 5),',
        '                smartOffsetBottomRowV1StopLoss: getVal(\'e_smartOffsetBottomRowV1StopLoss\', 0),',
        '                smartOffsetStopLoss: getVal(\'e_smartOffsetStopLoss\', 0),',
        '                smartOffsetNetProfit2: getVal(\'e_smartOffsetNetProfit2\', 0),',
        '                smartOffsetStopLoss2: getVal(\'e_smartOffsetStopLoss2\', 0),',
        '                smartOffsetMaxLossPerMinute: getVal(\'e_smartOffsetMaxLossPerMinute\', 0),',
        '                smartOffsetMaxLossTimeframeSeconds: getInt(\'e_smartOffsetMaxLossTimeframeSeconds\', 60),',
        '                noPeakSlTimeframeSeconds: getInt(\'e_noPeakSlTimeframeSeconds\', 1800),',
        '                noPeakSlGatePnl: getVal(\'e_noPeakSlGatePnl\', 0),',
        '                minuteCloseTpMinPnl: Math.abs(getVal(\'e_minuteCloseTpMinPnl\', 0)),',
        '                minuteCloseTpMaxPnl: Math.abs(getVal(\'e_minuteCloseTpMaxPnl\', 0)),',
        '                minuteCloseSlMinPnl: -Math.abs(getVal(\'e_minuteCloseSlMinPnl\', 0)),',
        '                minuteCloseSlMaxPnl: -Math.abs(getVal(\'e_minuteCloseSlMaxPnl\', 0)),',
        '                minuteCloseAutoDynamic: document.getElementById(\'e_minuteCloseAutoDynamic\') ? document.getElementById(\'e_minuteCloseAutoDynamic\').checked : false',
        '            };',
        '            try {',
        '                const res = await fetch(\'/api/master/global\', { method: \'POST\', headers: { \'Content-Type\': \'application/json\', \'Authorization\': \'Bearer \' + token }, body: JSON.stringify(payload) });',
        '                const data = await res.json();',
        '                if (data.success) { ',
        '                    await loadMasterEditor();',
        '                    const newMsgDiv = document.getElementById(\'e_globalMsg\');',
        '                    if (newMsgDiv) { newMsgDiv.className = "text-green"; newMsgDiv.innerText = data.message; setTimeout(() => { newMsgDiv.innerText = \'\'; }, 3000); }',
        '                } else { ',
        '                    const msgDiv = document.getElementById(\'e_globalMsg\');',
        '                    if (msgDiv) { msgDiv.className = "text-red"; msgDiv.innerText = "Error: " + data.error; setTimeout(() => { msgDiv.innerText = \'\'; }, 3000); }',
        '                }',
        '            } catch(err) { const msgDiv = document.getElementById(\'e_globalMsg\'); if(msgDiv) { msgDiv.className = "text-red"; msgDiv.innerText = "Timeout: " + err.message; setTimeout(() => { msgDiv.innerText = \'\'; }, 3000); } }',
        '        }',
        '        async function saveMasterProfile(index) {',
        '            const getVal = (id, def) => { const el = document.getElementById(id); return el && el.value !== \'\' ? parseFloat(el.value) : def; };',
        '            const getInt = (id, def) => { const el = document.getElementById(id); return el && el.value !== \'\' ? parseInt(el.value) : def; };',
        '            const apiKeyEl = document.getElementById(\'p_\' + index + \'_apiKey\');',
        '            const secretEl = document.getElementById(\'p_\' + index + \'_secret\');',
        '            const payload = {',
        '                apiKey: apiKeyEl ? apiKeyEl.value : \'\',',
        '                secret: secretEl ? secretEl.value : \'\',',
        '                baseQty: getVal(\'p_\' + index + \'_baseQty\', 1),',
        '                takeProfitPct: getVal(\'p_\' + index + \'_takeProfitPct\', 5.0),',
        '                takeProfitPnl: getVal(\'p_\' + index + \'_takeProfitPnl\', 0),',
        '                stopLossPct: getVal(\'p_\' + index + \'_stopLossPct\', -25.0),',
        '                triggerDcaPnl: getVal(\'p_\' + index + \'_triggerDcaPnl\', -2.0),',
        '                maxContracts: getInt(\'p_\' + index + \'_maxContracts\', 1000)',
        '            };',
        '            try {',
        '                const res = await fetch(\'/api/master/profile/\' + index, { method: \'POST\', headers: { \'Content-Type\': \'application/json\', \'Authorization\': \'Bearer \' + token }, body: JSON.stringify(payload) });',
        '                const data = await res.json();',
        '                if (data.success) { ',
        '                    await loadMasterEditor();',
        '                    const newMsgDiv = document.getElementById(\'p_\' + index + \'_msg\');',
        '                    if(newMsgDiv) { newMsgDiv.className = "text-green"; newMsgDiv.innerText = data.message; setTimeout(() => { newMsgDiv.innerText = \'\'; }, 3000); }',
        '                } else { ',
        '                    const msgDiv = document.getElementById(\'p_\' + index + \'_msg\');',
        '                    if(msgDiv) { msgDiv.className = "text-red"; msgDiv.innerText = "Error: " + data.error; setTimeout(() => { msgDiv.innerText = \'\'; }, 3000); }',
        '                }',
        '            } catch(err) { const msgDiv = document.getElementById(\'p_\' + index + \'_msg\'); if(msgDiv) { msgDiv.className = "text-red"; msgDiv.innerText = "Timeout: " + err.message; setTimeout(() => { msgDiv.innerText = \'\'; }, 3000); } }',
        '        }',
        '        async function loadAdminData() {',
        '            try {',
        '                const statusRes = await fetch(\'/api/admin/status\', { headers: { \'Authorization\': \'Bearer \' + token } });',
        '                const statusData = await statusRes.json();',
        '                const banner = document.getElementById(\'adminStatusBanner\');',
        '                if (statusData.templateSafe && statusData.webcoinSafe) { banner.style.background = \'rgba(14,203,129,0.1)\'; banner.style.color = \'var(--success)\'; banner.style.border = \'1px solid rgba(14,203,129,0.3)\'; banner.innerHTML = \'<span class="material-symbols-outlined">check_circle</span> SYSTEM SAFE: Global Template Protected.\'; }',
        '                else { banner.style.background = \'rgba(246,70,93,0.1)\'; banner.style.color = \'var(--danger)\'; banner.style.border = \'1px solid rgba(246,70,93,0.3)\'; banner.innerHTML = \'<span class="material-symbols-outlined">error</span> CRITICAL: Master Template compromised!\'; }',
        '                const usersRes = await fetch(\'/api/admin/users\', { headers: { \'Authorization\': \'Bearer \' + token } });',
        '                const users = await usersRes.json();',
        '                let html = \'<table class="md-table">\';',
        '                html += \'<tr><th>Client ID</th><th>Cleartext Hash</th><th>Environment</th><th>Net Realized PNL</th><th>Directives</th></tr>\';',
        '                if (users.length === 0) { html += \'<tr><td colspan="5" style="text-align:center; padding:32px; color:var(--text-muted);">No active client nodes.</td></tr>\'; }',
        '                else {',
        '                    users.forEach(u => {',
        '                        const modeText = u.isPaper ? \'<span style="background:rgba(41,98,255,0.2); color:var(--primary); padding:4px 8px; border-radius:4px; font-size:0.7rem; font-weight:bold;">SIMULATION</span>\' : \'<span style="background:rgba(14,203,129,0.2); color:var(--success); padding:4px 8px; border-radius:4px; font-size:0.7rem; font-weight:bold;">LIVE</span>\';',
        '                        const pnlColor = u.realizedPnl >= 0 ? \'text-green\' : \'text-red\';',
        '                        html += \'<tr>\' + \'<td style="font-weight:600; color:#fff;">\' + u.username + \'</td>\' + \'<td style="font-family:monospace; color:var(--text-muted);">\' + u.plainPassword + \'</td>\' + \'<td>\' + modeText + \'</td>\' + \'<td class="\' + pnlColor + \'" style="font-weight:700; font-size:1.1rem;">$\' + u.realizedPnl.toFixed(4) + \'</td>\' + \'<td>\' + \'<button class="md-btn md-btn-primary" style="padding:6px 12px; margin-right:8px;" onclick="adminImportProfiles(\\\'\' + u._id + \'\\\')"><span class="material-symbols-outlined" style="font-size:16px;">download</span> Overwrite Nodes</button>\' + \'<button class="md-btn md-btn-danger" style="padding:6px 12px;" onclick="adminDeleteUser(\\\'\' + u._id + \'\\\')"><span class="material-symbols-outlined" style="font-size:16px;">delete</span></button>\' + \'</td>\' + \'</tr>\';',
        '                    });',
        '                }',
        '                html += \'</table>\';',
        '                document.getElementById(\'adminUsersContainer\').innerHTML = html;',
        '            } catch (e) { document.getElementById(\'adminUsersContainer\').innerHTML = \'<p class="text-red">Telemetry error.</p>\'; }',
        '        }',
        '        async function adminImportProfiles(id) {',
        '            if (!confirm("Are you sure you want to aggressively overwrite this client\'s nodes with the Master config?")) return;',
        '            const res = await fetch(\'/api/admin/users/\' + id + \'/import\', { method: \'POST\', headers: { \'Authorization\': \'Bearer \' + token } });',
        '            const data = await res.json();',
        '            if(data.success) { alert(data.message); loadAdminData(); } else alert("Error: " + data.error);',
        '        }',
        '        async function adminDeleteUser(id) {',
        '            if (!confirm("Terminate client connection permanently?")) return;',
        '            const res = await fetch(\'/api/admin/users/\' + id, { method: \'DELETE\', headers: { \'Authorization\': \'Bearer \' + token } });',
        '            const data = await res.json();',
        '            if(data.success) { loadAdminData(); } else alert("Error: " + data.error);',
        '        }',
        '        async function adminDeleteAllUsers() {',
        '            if (!confirm("🚨 FATAL WARNING: Wipe all client nodes globally?")) return;',
        '            const res = await fetch(\'/api/admin/users\', { method: \'DELETE\', headers: { \'Authorization\': \'Bearer \' + token } });',
        '            const data = await res.json();',
        '            if(data.success) { alert(data.message); loadAdminData(); } else alert("Error: " + data.error);',
        '        }',
        '        function logout() { ',
        '            localStorage.removeItem(\'token\'); token = null; mySubAccounts = []; myCoins = []; currentProfileIndex = -1;',
        '            document.getElementById(\'settingsContainer\').style.display = \'none\'; document.getElementById(\'coinsListContainer\').innerHTML = \'\'; document.getElementById(\'logs\').innerHTML = \'Connection terminated.\'; document.getElementById(\'dashboardStatusContainer\').innerHTML = \'<p class="text-muted" style="text-align:center;">Offline.</p>\';',
        '            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; } checkAuth(); ',
        '        }',
        '        function toggleNewKeys(cb) { const type = cb.checked ? \'text\' : \'password\'; document.getElementById(\'newSubKey\').type = type; document.getElementById(\'newSubSecret\').type = type; }',
        '        function toggleActiveKeys(cb) { const type = cb.checked ? \'text\' : \'password\'; document.getElementById(\'apiKey\').type = type; document.getElementById(\'secret\').type = type; }',
        '        async function fetchSettings() {',
        '            try {',
        '                const res = await fetch(\'/api/settings\', { headers: { \'Authorization\': \'Bearer \' + token } });',
        '                if (res.status === 401 || res.status === 403) return logout();',
        '                const config = await res.json();',
        '                myGlobalTargetPnl = config.globalTargetPnl !== undefined ? config.globalTargetPnl : 0;',
        '                myGlobalTrailingPnl = config.globalTrailingPnl !== undefined ? config.globalTrailingPnl : 0;',
        '                myGlobalSingleCoinTpPnl = config.globalSingleCoinTpPnl !== undefined ? config.globalSingleCoinTpPnl : 0;',
        '                myGlobalSingleCoinSlPnl = config.globalSingleCoinSlPnl !== undefined ? config.globalSingleCoinSlPnl : 0;',
        '                myGlobalTriggerDcaPnl = config.globalTriggerDcaPnl !== undefined ? config.globalTriggerDcaPnl : 0;',
        '                mySmartOffsetNetProfit = config.smartOffsetNetProfit !== undefined ? config.smartOffsetNetProfit : 0;',
        '                mySmartOffsetBottomRowV1 = config.smartOffsetBottomRowV1 !== undefined ? config.smartOffsetBottomRowV1 : 5;',
        '                mySmartOffsetBottomRowV1StopLoss = config.smartOffsetBottomRowV1StopLoss !== undefined ? config.smartOffsetBottomRowV1StopLoss : 0; ',
        '                mySmartOffsetStopLoss = config.smartOffsetStopLoss !== undefined ? config.smartOffsetStopLoss : 0;',
        '                mySmartOffsetNetProfit2 = config.smartOffsetNetProfit2 !== undefined ? config.smartOffsetNetProfit2 : 0;',
        '                mySmartOffsetStopLoss2 = config.smartOffsetStopLoss2 !== undefined ? config.smartOffsetStopLoss2 : 0;',
        '                mySmartOffsetMaxLossPerMinute = config.smartOffsetMaxLossPerMinute !== undefined ? config.smartOffsetMaxLossPerMinute : 0;',
        '                mySmartOffsetMaxLossTimeframeSeconds = config.smartOffsetMaxLossTimeframeSeconds !== undefined ? config.smartOffsetMaxLossTimeframeSeconds : 60;',
        '                myMinuteCloseAutoDynamic = config.minuteCloseAutoDynamic || false;',
        '                myMinuteCloseTpMinPnl = config.minuteCloseTpMinPnl !== undefined ? config.minuteCloseTpMinPnl : 0;',
        '                myMinuteCloseTpMaxPnl = config.minuteCloseTpMaxPnl !== undefined ? config.minuteCloseTpMaxPnl : 0;',
        '                myMinuteCloseSlMinPnl = config.minuteCloseSlMinPnl !== undefined ? config.minuteCloseSlMinPnl : 0;',
        '                myMinuteCloseSlMaxPnl = config.minuteCloseSlMaxPnl !== undefined ? config.minuteCloseSlMaxPnl : 0;',
        '                myNoPeakSlTimeframeSeconds = config.noPeakSlTimeframeSeconds !== undefined ? config.noPeakSlTimeframeSeconds : 1800;',
        '                myNoPeakSlGatePnl = config.noPeakSlGatePnl !== undefined ? config.noPeakSlGatePnl : 0;',
        '                document.getElementById(\'globalTargetPnl\').value = myGlobalTargetPnl;',
        '                document.getElementById(\'globalTrailingPnl\').value = myGlobalTrailingPnl;',
        '                document.getElementById(\'globalSingleCoinTpPnl\').value = myGlobalSingleCoinTpPnl;',
        '                document.getElementById(\'globalSingleCoinSlPnl\').value = myGlobalSingleCoinSlPnl;',
        '                document.getElementById(\'globalTriggerDcaPnl\').value = myGlobalTriggerDcaPnl;',
        '                document.getElementById(\'smartOffsetNetProfit\').value = mySmartOffsetNetProfit;',
        '                document.getElementById(\'smartOffsetBottomRowV1\').value = mySmartOffsetBottomRowV1;',
        '                document.getElementById(\'smartOffsetBottomRowV1StopLoss\').value = mySmartOffsetBottomRowV1StopLoss; ',
        '                document.getElementById(\'smartOffsetStopLoss\').value = mySmartOffsetStopLoss;',
        '                document.getElementById(\'smartOffsetNetProfit2\').value = mySmartOffsetNetProfit2;',
        '                document.getElementById(\'smartOffsetStopLoss2\').value = mySmartOffsetStopLoss2;',
        '                document.getElementById(\'smartOffsetMaxLossPerMinute\').value = mySmartOffsetMaxLossPerMinute;',
        '                document.getElementById(\'smartOffsetMaxLossTimeframeSeconds\').value = mySmartOffsetMaxLossTimeframeSeconds;',
        '                document.getElementById(\'minuteCloseAutoDynamic\').checked = myMinuteCloseAutoDynamic;',
        '                document.getElementById(\'minuteCloseTpMinPnl\').value = myMinuteCloseTpMinPnl;',
        '                document.getElementById(\'minuteCloseTpMaxPnl\').value = myMinuteCloseTpMaxPnl;',
        '                document.getElementById(\'minuteCloseSlMinPnl\').value = myMinuteCloseSlMinPnl;',
        '                document.getElementById(\'minuteCloseSlMaxPnl\').value = myMinuteCloseSlMaxPnl;',
        '                document.getElementById(\'noPeakSlTimeframeSeconds\').value = myNoPeakSlTimeframeSeconds;',
        '                document.getElementById(\'noPeakSlGatePnl\').value = myNoPeakSlGatePnl;',
        '                const formatCur = (v) => (v >= 0 ? "+$" : "-$") + Math.abs(v).toFixed(2);',
        '                if(document.getElementById(\'display_globalSingleCoinTpPnl\')) document.getElementById(\'display_globalSingleCoinTpPnl\').innerText = formatCur(myGlobalSingleCoinTpPnl);',
        '                if(document.getElementById(\'display_globalSingleCoinSlPnl\')) document.getElementById(\'display_globalSingleCoinSlPnl\').innerText = formatCur(myGlobalSingleCoinSlPnl);',
        '                if(document.getElementById(\'display_globalTriggerDcaPnl\')) document.getElementById(\'display_globalTriggerDcaPnl\').innerText = formatCur(myGlobalTriggerDcaPnl);',
        '                if(document.getElementById(\'display_smartOffsetNetProfit\')) document.getElementById(\'display_smartOffsetNetProfit\').innerText = formatCur(mySmartOffsetNetProfit);',
        '                if(document.getElementById(\'display_noPeakSlGatePnl\')) document.getElementById(\'display_noPeakSlGatePnl\').innerText = formatCur(myNoPeakSlGatePnl);',
        '                mySubAccounts = config.subAccounts || [];',
        '                renderSubAccounts();',
        '                if (mySubAccounts.length > 0) { document.getElementById(\'subAccountSelect\').value = 0; loadSubAccount(); } ',
        '                else { currentProfileIndex = -1; document.getElementById(\'settingsContainer\').style.display = \'none\'; document.getElementById(\'dashboardStatusContainer\').innerHTML = \'<p class="text-muted" style="text-align:center; padding:20px;">Array empty.</p>\'; myCoins = []; }',
        '            } catch(e) { console.error(e); }',
        '        }',
        '        async function saveGlobalSettings() {',
        '            const getVal = (id, def) => { const el = document.getElementById(id); return el && el.value !== \'\' ? parseFloat(el.value) : def; };',
        '            const getInt = (id, def) => { const el = document.getElementById(id); return el && el.value !== \'\' ? parseInt(el.value) : def; };',
        '            myGlobalTargetPnl = getVal(\'globalTargetPnl\', 0);',
        '            myGlobalTrailingPnl = getVal(\'globalTrailingPnl\', 0);',
        '            myGlobalSingleCoinTpPnl = getVal(\'globalSingleCoinTpPnl\', 0);',
        '            myGlobalSingleCoinSlPnl = getVal(\'globalSingleCoinSlPnl\', 0);',
        '            myGlobalTriggerDcaPnl = getVal(\'globalTriggerDcaPnl\', 0);',
        '            mySmartOffsetNetProfit = getVal(\'smartOffsetNetProfit\', 0);',
        '            mySmartOffsetBottomRowV1 = getInt(\'smartOffsetBottomRowV1\', 5);',
        '            mySmartOffsetBottomRowV1StopLoss = getVal(\'smartOffsetBottomRowV1StopLoss\', 0);',
        '            mySmartOffsetStopLoss = getVal(\'smartOffsetStopLoss\', 0);',
        '            mySmartOffsetNetProfit2 = getVal(\'smartOffsetNetProfit2\', 0);',
        '            mySmartOffsetStopLoss2 = getVal(\'smartOffsetStopLoss2\', 0);',
        '            mySmartOffsetMaxLossPerMinute = getVal(\'smartOffsetMaxLossPerMinute\', 0);',
        '            mySmartOffsetMaxLossTimeframeSeconds = getInt(\'smartOffsetMaxLossTimeframeSeconds\', 60);',
        '            myMinuteCloseTpMinPnl = Math.abs(getVal(\'minuteCloseTpMinPnl\', 0));',
        '            myMinuteCloseTpMaxPnl = Math.abs(getVal(\'minuteCloseTpMaxPnl\', 0));',
        '            myMinuteCloseSlMinPnl = -Math.abs(getVal(\'minuteCloseSlMinPnl\', 0));',
        '            myMinuteCloseSlMaxPnl = -Math.abs(getVal(\'minuteCloseSlMaxPnl\', 0));',
        '            myNoPeakSlTimeframeSeconds = getInt(\'noPeakSlTimeframeSeconds\', 1800);',
        '            myNoPeakSlGatePnl = getVal(\'noPeakSlGatePnl\', 0);',
        '            myMinuteCloseAutoDynamic = document.getElementById(\'minuteCloseAutoDynamic\') ? document.getElementById(\'minuteCloseAutoDynamic\').checked : false;',
        '            const data = { subAccounts: mySubAccounts, globalTargetPnl: myGlobalTargetPnl, globalTrailingPnl: myGlobalTrailingPnl, globalSingleCoinTpPnl: myGlobalSingleCoinTpPnl, globalSingleCoinSlPnl: myGlobalSingleCoinSlPnl, globalTriggerDcaPnl: myGlobalTriggerDcaPnl, smartOffsetNetProfit: mySmartOffsetNetProfit, smartOffsetBottomRowV1: mySmartOffsetBottomRowV1, smartOffsetBottomRowV1StopLoss: mySmartOffsetBottomRowV1StopLoss, smartOffsetStopLoss: mySmartOffsetStopLoss, smartOffsetNetProfit2: mySmartOffsetNetProfit2, smartOffsetStopLoss2: mySmartOffsetStopLoss2, smartOffsetMaxLossPerMinute: mySmartOffsetMaxLossPerMinute, smartOffsetMaxLossTimeframeSeconds: mySmartOffsetMaxLossTimeframeSeconds, minuteCloseAutoDynamic: myMinuteCloseAutoDynamic, minuteCloseTpMinPnl: myMinuteCloseTpMinPnl, minuteCloseTpMaxPnl: myMinuteCloseTpMaxPnl, minuteCloseSlMinPnl: myMinuteCloseSlMinPnl, minuteCloseSlMaxPnl: myMinuteCloseSlMaxPnl, noPeakSlTimeframeSeconds: myNoPeakSlTimeframeSeconds, noPeakSlGatePnl: myNoPeakSlGatePnl };',
        '            await fetch(\'/api/settings\', { method: \'POST\', headers: { \'Content-Type\': \'application/json\', \'Authorization\': \'Bearer \' + token }, body: JSON.stringify(data) });',
        '            const saveBtn = document.activeElement;',
        '            if(saveBtn.tagName === "BUTTON") { const oldTxt = saveBtn.innerHTML; saveBtn.innerHTML = "<span class=\'material-symbols-outlined\'>check</span> Deployed"; saveBtn.classList.replace("md-btn-primary", "md-btn-success"); setTimeout(()=>{ saveBtn.innerHTML = oldTxt; saveBtn.classList.replace("md-btn-success", "md-btn-primary"); }, 2000); }',
        '        }',
        '        function renderSubAccounts() {',
        '            const select = document.getElementById(\'subAccountSelect\');',
        '            select.innerHTML = \'<option value="">-- Awaiting Selection --</option>\';',
        '            if(mySubAccounts.length > 0) {',
        '                select.innerHTML = \'\';',
        '                mySubAccounts.forEach((sub, i) => select.innerHTML += \'<option value="\' + i + \'">[Profile \' + (i+1) + \'] \' + sub.name + \'</option>\');',
        '            }',
        '        }',
        '        async function addSubAccount() {',
        '            const name = document.getElementById(\'newSubName\').value.trim();',
        '            const key = document.getElementById(\'newSubKey\').value.trim();',
        '            const secret = document.getElementById(\'newSubSecret\').value.trim();',
        '            if(!name || !key || !secret) return alert("All array keys required.");',
        '            mySubAccounts.push({ name, apiKey: key, secret: secret, side: \'long\', leverage: 10, baseQty: 1, takeProfitPct: 5.0, takeProfitPnl: 0, stopLossPct: -25.0, triggerDcaPnl: -2.0, maxContracts: 1000, realizedPnl: 0, coins: [] });',
        '            await saveSettings(true);',
        '            document.getElementById(\'newSubName\').value = \'\'; document.getElementById(\'newSubKey\').value = \'\'; document.getElementById(\'newSubSecret\').value = \'\';',
        '            renderSubAccounts();',
        '            document.getElementById(\'subAccountSelect\').value = mySubAccounts.length - 1;',
        '            loadSubAccount();',
        '        }',
        '        function loadSubAccount() {',
        '            const select = document.getElementById(\'subAccountSelect\');',
        '            const index = parseInt(select.value);',
        '            if(!isNaN(index) && index >= 0) {',
        '                currentProfileIndex = index;',
        '                const profile = mySubAccounts[index];',
        '                document.getElementById(\'settingsContainer\').style.display = \'block\';',
        '                document.getElementById(\'apiKey\').value = profile.apiKey || \'\';',
        '                document.getElementById(\'secret\').value = profile.secret || \'\';',
        '                const cb = document.getElementById(\'showActiveKeysCheckbox\');',
        '                if(cb) { cb.checked = false; toggleActiveKeys(cb); }',
        '                document.getElementById(\'side\').value = profile.side || \'long\';',
        '                document.getElementById(\'leverage\').value = "Auto (Oracle)";',
        '                document.getElementById(\'baseQty\').value = profile.baseQty !== undefined ? profile.baseQty : 1;',
        '                document.getElementById(\'takeProfitPct\').value = profile.takeProfitPct !== undefined ? profile.takeProfitPct : 5.0;',
        '                document.getElementById(\'takeProfitPnl\').value = profile.takeProfitPnl !== undefined ? profile.takeProfitPnl : 0;',
        '                document.getElementById(\'stopLossPct\').value = profile.stopLossPct !== undefined ? profile.stopLossPct : -25.0; ',
        '                document.getElementById(\'triggerDcaPnl\').value = profile.triggerDcaPnl !== undefined ? profile.triggerDcaPnl : -2.0;',
        '                document.getElementById(\'maxContracts\').value = profile.maxContracts !== undefined ? profile.maxContracts : 1000;',
        '                myCoins = profile.coins || [];',
        '                renderCoinsSettings();',
        '            }',
        '        }',
        '        async function removeSubAccount() {',
        '            const select = document.getElementById(\'subAccountSelect\');',
        '            const index = parseInt(select.value);',
        '            if(!isNaN(index) && index >= 0) {',
        '                mySubAccounts.splice(index, 1);',
        '                await saveSettings(true);',
        '                renderSubAccounts();',
        '                if(mySubAccounts.length > 0) { document.getElementById(\'subAccountSelect\').value = 0; loadSubAccount(); } ',
        '                else { currentProfileIndex = -1; document.getElementById(\'settingsContainer\').style.display = \'none\'; myCoins = []; document.getElementById(\'dashboardStatusContainer\').innerHTML = \'<p class="text-muted" style="text-align:center; padding:20px;">Array empty.</p>\'; document.getElementById(\'logs\').innerHTML = \'\'; }',
        '            }',
        '        }',
        '        async function globalToggleBot(active) {',
        '            if(currentProfileIndex === -1) return alert("Load a profile first.");',
        '            if(myCoins.length === 0) return alert("Matrix unpopulated.");',
        '            myCoins.forEach(c => c.botActive = active);',
        '            await saveSettings(true); ',
        '            // Flash response',
        '            const btn = document.activeElement;',
        '            if(btn.tagName==="BUTTON") { const oldHtml = btn.innerHTML; btn.innerHTML = "<span class=\'material-symbols-outlined\'>check</span> Confirmed"; setTimeout(()=>{btn.innerHTML = oldHtml;}, 2000); }',
        '        }',
        '        function addPredefinedList() {',
        '            if(currentProfileIndex === -1) return alert("Load a profile first.");',
        '            const sideMode = document.getElementById(\'predefSide\').value;',
        '            const startMode = document.getElementById(\'predefStatus\').value === \'started\';',
        '            PREDEFINED_COINS.forEach((base, index) => {',
        '                const symbol = base + \'/USDT:USDT\';',
        '                if(myCoins.some(c => c.symbol === symbol)) return; ',
        '                let coinSide = \'long\';',
        '                if (sideMode === \'allShort\') coinSide = \'short\';',
        '                else if (sideMode === \'oddLong\') coinSide = (index % 2 === 0) ? \'long\' : \'short\'; ',
        '                else if (sideMode === \'evenLong\') coinSide = (index % 2 === 0) ? \'short\' : \'long\'; ',
        '                myCoins.push({ symbol: symbol, side: coinSide, botActive: startMode });',
        '            });',
        '            renderCoinsSettings();',
        '        }',
        '        function addCoinUI() {',
        '            if(currentProfileIndex === -1) return alert("Load a profile first.");',
        '            const symbol = document.getElementById(\'newCoinSymbol\').value.toUpperCase().trim();',
        '            const masterSide = document.getElementById(\'side\').value; ',
        '            if(!symbol) return alert("Missing parameter.");',
        '            if(myCoins.some(c => c.symbol === symbol)) return alert("Duplicate node.");',
        '            myCoins.push({ symbol: symbol, side: masterSide, botActive: true }); ',
        '            document.getElementById(\'newCoinSymbol\').value = \'\';',
        '            renderCoinsSettings();',
        '        }',
        '        function removeCoinUI(index) { myCoins.splice(index, 1); renderCoinsSettings(); }',
        '        function renderCoinsSettings() {',
        '            const container = document.getElementById(\'coinsListContainer\');',
        '            container.innerHTML = \'\';',
        '            myCoins.forEach((coin, i) => {',
        '                const box = document.createElement(\'div\');',
        '                box.className = \'metric-box flex-row\';',
        '                box.style.justifyContent = \'space-between\';',
        '                box.style.marginBottom = \'8px\';',
        '                box.style.padding = \'8px 16px\';',
        '                const displaySide = coin.side || document.getElementById(\'side\').value;',
        '                const sideColor = displaySide === \'long\' ? \'text-green\' : \'text-red\';',
        '                box.innerHTML = \'<span style="font-weight: 600; font-size: 1rem;">\' + coin.symbol + \' <span class="\' + sideColor + \'" style="font-size: 0.75rem; text-transform: uppercase;">[\' + displaySide + \']</span></span><button class="md-btn md-btn-text" style="padding:4px; border:none; color:var(--danger);" onclick="removeCoinUI(\' + i + \')"><span class="material-symbols-outlined" style="font-size:18px;">close</span></button>\';',
        '                container.appendChild(box);',
        '            });',
        '        }',
        '        async function saveSettings(silent = false) {',
        '            if(currentProfileIndex === -1) return alert("Load a profile first.");',
        '            const profile = mySubAccounts[currentProfileIndex];',
        '            profile.apiKey = document.getElementById(\'apiKey\').value;',
        '            profile.secret = document.getElementById(\'secret\').value;',
        '            profile.side = document.getElementById(\'side\').value;',
        '            profile.leverage = 10;',
        '            profile.baseQty = document.getElementById(\'baseQty\').value !== \'\' ? parseFloat(document.getElementById(\'baseQty\').value) : 1;',
        '            profile.takeProfitPct = document.getElementById(\'takeProfitPct\').value !== \'\' ? parseFloat(document.getElementById(\'takeProfitPct\').value) : 5.0;',
        '            profile.takeProfitPnl = document.getElementById(\'takeProfitPnl\').value !== \'\' ? parseFloat(document.getElementById(\'takeProfitPnl\').value) : 0;',
        '            profile.stopLossPct = document.getElementById(\'stopLossPct\').value !== \'\' ? parseFloat(document.getElementById(\'stopLossPct\').value) : -25.0;',
        '            profile.triggerDcaPnl = document.getElementById(\'triggerDcaPnl\').value !== \'\' ? parseFloat(document.getElementById(\'triggerDcaPnl\').value) : -2.0;',
        '            profile.maxContracts = document.getElementById(\'maxContracts\').value !== \'\' ? parseInt(document.getElementById(\'maxContracts\').value) : 1000;',
        '            profile.coins = myCoins;',
        '            const data = { subAccounts: mySubAccounts, globalTargetPnl: myGlobalTargetPnl, globalTrailingPnl: myGlobalTrailingPnl, globalSingleCoinTpPnl: myGlobalSingleCoinTpPnl, globalSingleCoinSlPnl: myGlobalSingleCoinSlPnl, globalTriggerDcaPnl: myGlobalTriggerDcaPnl, smartOffsetNetProfit: mySmartOffsetNetProfit, smartOffsetBottomRowV1: mySmartOffsetBottomRowV1, smartOffsetBottomRowV1StopLoss: mySmartOffsetBottomRowV1StopLoss, smartOffsetStopLoss: mySmartOffsetStopLoss, smartOffsetNetProfit2: mySmartOffsetNetProfit2, smartOffsetStopLoss2: mySmartOffsetStopLoss2, smartOffsetMaxLossPerMinute: mySmartOffsetMaxLossPerMinute, smartOffsetMaxLossTimeframeSeconds: mySmartOffsetMaxLossTimeframeSeconds, minuteCloseAutoDynamic: myMinuteCloseAutoDynamic, minuteCloseTpMinPnl: myMinuteCloseTpMinPnl, minuteCloseTpMaxPnl: myMinuteCloseTpMaxPnl, minuteCloseSlMinPnl: myMinuteCloseSlMinPnl, minuteCloseSlMaxPnl: myMinuteCloseSlMaxPnl, noPeakSlTimeframeSeconds: myNoPeakSlTimeframeSeconds, noPeakSlGatePnl: myNoPeakSlGatePnl };',
        '            const res = await fetch(\'/api/settings\', { method: \'POST\', headers: { \'Content-Type\': \'application/json\', \'Authorization\': \'Bearer \' + token }, body: JSON.stringify(data) });',
        '            const json = await res.json();',
        '            mySubAccounts = json.settings.subAccounts || [];',
        '            if (!silent) {',
        '                const saveBtn = document.activeElement;',
        '                if(saveBtn.tagName === "BUTTON") { const oldTxt = saveBtn.innerHTML; saveBtn.innerHTML = "<span class=\'material-symbols-outlined\'>check</span> DB Synced"; saveBtn.classList.replace("md-btn-primary", "md-btn-success"); setTimeout(()=>{ saveBtn.innerHTML = oldTxt; saveBtn.classList.replace("md-btn-success", "md-btn-primary"); }, 2000); }',
        '            }',
        '        }',
        '        async function toggleCoinBot(symbol, active) {',
        '            const coin = myCoins.find(c => c.symbol === symbol);',
        '            if(coin) coin.botActive = active;',
        '            await saveSettings(true); ',
        '        }',
        '        async function loadOffsets() {',
        '            const res = await fetch(\'/api/offsets\', { headers: { \'Authorization\': \'Bearer \' + token } });',
        '            if (!res.ok) return;',
        '            const records = await res.json();',
        '            if (records.length === 0) {',
        '                const noData = \'<p class="text-muted" style="padding:20px; text-align:center;">Ledger empty.</p>\';',
        '                document.getElementById(\'offsetTableContainer\').innerHTML = noData;',
        '                document.getElementById(\'offsetTableContainer2\').innerHTML = noData;',
        '                return;',
        '            }',
        '            let ih = \'<table class="md-table"><tr><th>Timestamp</th><th>Network Entity</th><th>Directive Reason</th><th>Realized Delta</th></tr>\';',
        '            records.forEach(r => {',
        '                const dateObj = new Date(r.timestamp);',
        '                const dStr = dateObj.toLocaleDateString(undefined, {month:\'short\', day:\'numeric\'}) + \' \' + dateObj.toLocaleTimeString(undefined, {hour12:false});',
        '                const symbolText = r.symbol || r.winnerSymbol || \'Unknown\';',
        '                const reasonText = r.reason || (r.loserSymbol ? \'Smart Offset (Legacy)\' : \'Unknown\');',
        '                const net = r.netProfit !== undefined ? r.netProfit : 0;',
        '                const nColor = net >= 0 ? \'text-green\' : \'text-red\';',
        '                ih += \'<tr><td class="text-muted" style="font-size:0.8rem;">\' + dStr + \'</td><td class="text-main" style="font-weight:600;">\' + symbolText + \'</td><td style="font-weight:500; font-size:0.8rem;">\' + reasonText + \'</td><td class="\' + nColor + \'" style="font-weight:700;">\' + (net >= 0 ? \'+\' : \'\') + \'$\' + net.toFixed(4) + \'</td></tr>\';',
        '            });',
        '            ih += \'</table>\';',
        '            document.getElementById(\'offsetTableContainer\').innerHTML = ih;',
        '            document.getElementById(\'offsetTableContainer2\').innerHTML = ih;',
        '        }',
        '        async function loadStatus() {',
        '            try {',
        '                const res = await fetch(\'/api/status\', { headers: { \'Authorization\': \'Bearer \' + token } });',
        '                if (res.status === 401 || res.status === 403) return logout();',
        '                const data = await res.json();',
        '                const allStatuses = data.states || {};',
        '                const subAccountsUpdated = data.subAccounts || [];',
        '                const globalSet = data.globalSettings || {};',
        '                const currentMinuteLoss = data.currentMinuteLoss || 0;',
        '                let globalTotal = 0;',
        '                subAccountsUpdated.forEach(sub => {',
        '                    globalTotal += (sub.realizedPnl || 0);',
        '                    const localSub = mySubAccounts.find(s => s._id === sub._id);',
        '                    if(localSub) localSub.realizedPnl = sub.realizedPnl;',
        '                });',
        '                let globalUnrealized = 0;',
        '                let globalMarginUsed = 0;',
        '                let totalTrading = 0;',
        '                let totalAboveZero = 0;',
        '                let activeCandidates = [];',
        '                for (let pid in allStatuses) {',
        '                    const st = allStatuses[pid];',
        '                    if (st && st.coinStates) {',
        '                        for (let sym in st.coinStates) {',
        '                            const cs = st.coinStates[sym];',
        '                            if (cs.contracts > 0) { globalMarginUsed += (parseFloat(cs.margin) || 0); }',
        '                            if (cs.contracts > 0 && (!cs.lockUntil || Date.now() >= cs.lockUntil)) {',
        '                                totalTrading++;',
        '                                const pnlNum = parseFloat(cs.unrealizedPnl) || 0;',
        '                                if (cs.currentRoi > 0) totalAboveZero++;',
        '                                globalUnrealized += pnlNum;',
        '                                activeCandidates.push({ symbol: sym, pnl: pnlNum });',
        '                            }',
        '                        }',
        '                    }',
        '                }',
        '                document.getElementById(\'topGlobalMargin\').innerText = "$" + globalMarginUsed.toFixed(2);',
        '                const timeframeSec = globalSet.smartOffsetMaxLossTimeframeSeconds !== undefined ? globalSet.smartOffsetMaxLossTimeframeSeconds : 60;',
        '                const maxLossPerMin = globalSet.smartOffsetMaxLossPerMinute || 0;',
        '                const lossTrackerHtml = maxLossPerMin > 0 ? \'<div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.05); color:var(--text-muted); font-size:0.85rem;"><span class="material-symbols-outlined" style="font-size:16px; vertical-align:middle; margin-right:4px;">speed</span> <strong>\' + timeframeSec + \'s Volatility Ledger:</strong> $\' + currentMinuteLoss.toFixed(2) + \' / $\' + maxLossPerMin.toFixed(2) + \' Cap</div>\' : \'<div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.05); color:var(--text-muted); font-size:0.85rem;"><span class="material-symbols-outlined" style="font-size:16px; vertical-align:middle; margin-right:4px;">speed</span> <strong>\' + timeframeSec + \'s Volatility Ledger:</strong> Restricted 1 Execute / \' + timeframeSec + \'s</div>\';',
        '                activeCandidates.sort((a, b) => b.pnl - a.pnl);',
        '                const totalCoins = activeCandidates.length;',
        '                const totalPairs = Math.floor(totalCoins / 2);',
        '                let hasDynamicBoundary = false;',
        '                let peakAccumulation = 0;',
        '                const multiplier = globalSet.qtyMultiplier || 1;',
        '                const noPeakGateVal = globalSet.noPeakSlGatePnl !== undefined ? parseFloat(globalSet.noPeakSlGatePnl) : 0; ',
        '                const peakThreshold = 0.0001 * multiplier;',
        '                const winnerThreshold = 0.0002 * multiplier;',
        '                if (totalPairs > 0) {',
        '                    let rAcc = 0;',
        '                    for (let i = 0; i < totalPairs; i++) { rAcc += activeCandidates[i].pnl + activeCandidates[totalCoins - totalPairs + i].pnl; if (rAcc > peakAccumulation) peakAccumulation = rAcc; }',
        '                    if (peakAccumulation >= peakThreshold) hasDynamicBoundary = true;',
        '                }',
        '                const autoDynCheckbox = document.getElementById(\'minuteCloseAutoDynamic\');',
        '                const tpMinInput = document.getElementById(\'minuteCloseTpMinPnl\');',
        '                const tpMaxInput = document.getElementById(\'minuteCloseTpMaxPnl\');',
        '                const slMinInput = document.getElementById(\'minuteCloseSlMinPnl\');',
        '                const slMaxInput = document.getElementById(\'minuteCloseSlMaxPnl\');',
        '                const autoDynStatusBox = document.getElementById(\'autoDynStatusBox\');',
        '                if (autoDynCheckbox && autoDynCheckbox.checked) {',
        '                    tpMinInput.disabled = true; tpMaxInput.disabled = true; slMinInput.disabled = true; slMaxInput.disabled = true; autoDynStatusBox.style.display = \'block\';',
        '                    let tpMinBound = peakAccumulation * 0.8; let tpMaxBound = peakAccumulation * 1.2; let slMaxBound = -(peakAccumulation * 0.5); let slMinBound = -(peakAccumulation * 5.0);',
        '                    if (hasDynamicBoundary) { tpMinInput.value = tpMinBound.toFixed(4); tpMaxInput.value = tpMaxBound.toFixed(4); slMaxInput.value = slMaxBound.toFixed(4); slMinInput.value = slMinBound.toFixed(4); }',
        '                    let adHtml = \'\';',
        '                    if (hasDynamicBoundary && totalPairs > 0) {',
        '                        let highestGroupAcc = -99999; let lowestGroupAcc = 99999; let highestGroupIndex = -1; let lowestGroupIndex = -1;',
        '                        let currentAcc = 0;',
        '                        for (let i = 0; i < totalPairs; i++) { currentAcc += activeCandidates[i].pnl + activeCandidates[totalCoins - totalPairs + i].pnl; if (currentAcc > highestGroupAcc) { highestGroupAcc = currentAcc; highestGroupIndex = i; } if (currentAcc < lowestGroupAcc) { lowestGroupAcc = currentAcc; lowestGroupIndex = i; } }',
        '                        let distToTp = tpMinBound - highestGroupAcc; let distToSl = lowestGroupAcc - slMaxBound; ',
        '                        let tpDistText = distToTp > 0 ? \'$\' + distToTp.toFixed(4) + \' remaining\' : \'<span class="text-green" style="font-weight:bold;">EXECUTABLE</span>\';',
        '                        let slDistText = distToSl > 0 ? \'$\' + distToSl.toFixed(4) + \' remaining\' : \'<span class="text-red" style="font-weight:bold;">EXECUTABLE</span>\';',
        '                        adHtml += \'<div class="grid-2" style="margin-bottom: 12px;"><div><span class="metric-label">Closest to TP ($\' + tpMinBound.toFixed(4) + \')</span><span class="metric-val" style="font-size:1.1rem;">Matrix Row \' + (highestGroupIndex + 1) + \': <span class="\' + (highestGroupAcc >= 0 ? \'text-green\' : \'text-red\') + \'">$\' + highestGroupAcc.toFixed(4) + \'</span> <span style="font-size:0.8rem; font-weight:400; color:var(--text-muted);">(\' + tpDistText + \')</span></span></div><div><span class="metric-label">Closest to SL ($\' + slMaxBound.toFixed(4) + \')</span><span class="metric-val" style="font-size:1.1rem;">Matrix Row \' + (lowestGroupIndex + 1) + \': <span class="\' + (lowestGroupAcc >= 0 ? \'text-green\' : \'text-red\') + \'">$\' + lowestGroupAcc.toFixed(4) + \'</span> <span style="font-size:0.8rem; font-weight:400; color:var(--text-muted);">(\' + slDistText + \')</span></span></div></div>\';',
        '                    } else { adHtml += \'<p class="text-muted" style="margin:0;">Calibrating dynamic boundaries... (Awaiting peak vector)</p>\'; }',
        '                    if (data.autoDynExec) { const typeColor = data.autoDynExec.type === \'Group Take Profit\' ? \'text-green\' : \'text-red\'; adHtml += \'<div style="border-top:1px solid rgba(255,255,255,0.05); padding-top:12px; margin-top:12px; font-size:0.85rem; color:var(--text-muted);"><strong>Last Directive:</strong> <span class="\' + typeColor + \'" style="font-weight:bold;">\' + data.autoDynExec.type + \'</span> on <span style="color:var(--text-main);">\' + data.autoDynExec.symbol + \'</span> closing at <span class="\' + typeColor + \'" style="font-weight:700;">$\' + data.autoDynExec.pnl.toFixed(4) + \'</span></div>\'; }',
        '                    document.getElementById(\'autoDynLiveDetails\').innerHTML = adHtml;',
        '                } else if (autoDynCheckbox) { tpMinInput.disabled = false; tpMaxInput.disabled = false; slMinInput.disabled = false; slMaxInput.disabled = false; autoDynStatusBox.style.display = \'none\'; }',
        '                if (document.getElementById(\'offset-tab\').style.display === \'block\') {',
        '                    const targetV1 = globalSet.smartOffsetNetProfit || 0; const stopLossNth = globalSet.smartOffsetBottomRowV1StopLoss || 0; const fullGroupSl = globalSet.smartOffsetStopLoss || 0; const bottomRowN = globalSet.smartOffsetBottomRowV1 !== undefined ? globalSet.smartOffsetBottomRowV1 : 5;',
        '                    if (totalPairs === 0) { document.getElementById(\'liveOffsetsContainer\').innerHTML = \'<p class="text-muted" style="padding:20px; text-align:center;">Insufficient pairs for matrix formation.</p>\'; }',
        '                    else {',
        '                        let liveHtml = \'<table class="md-table"><tr><th>Vector Pair</th><th>Winner Node</th><th>Winner Delta</th><th>Loser Node</th><th>Loser Delta</th><th>Pair Net</th><th class="text-primary">Matrix Accumulation</th></tr>\';',
        '                        let runningAccumulation = 0; let peakAccumulation = 0; let peakRowIndex = -1; let nthBottomAccumulation = 0; const targetRefIndex = Math.max(0, totalPairs - bottomRowN);',
        '                        for (let i = 0; i < totalPairs; i++) { const w = activeCandidates[i]; const l = activeCandidates[totalCoins - totalPairs + i]; runningAccumulation += w.pnl + l.pnl; if (runningAccumulation > peakAccumulation) { peakAccumulation = runningAccumulation; peakRowIndex = i; } if (i === targetRefIndex) nthBottomAccumulation = runningAccumulation; }',
        '                        let topStatusMessage = \'\'; let executingPeak = false; let executingSl = false; let executingNoPeakSl = false; const isHitFullGroupSl = (fullGroupSl < 0 && runningAccumulation <= fullGroupSl);',
        '                        if (targetV1 > 0 && peakAccumulation >= targetV1 && peakAccumulation >= peakThreshold && peakRowIndex >= 0) { topStatusMessage = \'<span class="text-green" style="font-weight:bold;">🟢 Peak Harvest Authorized ($\' + peakAccumulation.toFixed(4) + \') at Row \' + (peakRowIndex + 1) + \'!</span>\'; executingPeak = true; }',
        '                        else if (isHitFullGroupSl) { let blockedByLimit = (maxLossPerMin > 0 && (currentMinuteLoss + Math.abs(runningAccumulation)) > maxLossPerMin); if (blockedByLimit) topStatusMessage = \'<span class="text-danger" style="font-weight:bold;">🔴 Execution Denied: Matrix Volatility Limit Exceeded.</span>\'; else { executingSl = true; topStatusMessage = \'<span class="text-danger" style="font-weight:bold;">🔴 Stop Loss Authorized (Matrix &le; $\' + fullGroupSl.toFixed(4) + \').</span>\'; } }',
        '                        else if (peakRowIndex === -1 || peakAccumulation < peakThreshold) { if (activeCandidates[0].pnl > noPeakGateVal) { executingNoPeakSl = false; topStatusMessage = \'<span class="text-warning" style="font-weight:bold;">🟡 Matrix Gated: Awaiting winner descent &le; $\' + noPeakGateVal.toFixed(4) + \'.</span>\'; } else { executingNoPeakSl = true; topStatusMessage = \'<span class="text-danger" style="font-weight:bold;">🔴 Matrix Critical: Executing low-tier severing. (Cycle: \' + (globalSet.noPeakSlTimeframeSeconds !== undefined ? globalSet.noPeakSlTimeframeSeconds : 1800) + \'s)</span>\'; } }',
        '                        else { let pColor = peakAccumulation >= peakThreshold ? \'text-green\' : \'text-muted\'; topStatusMessage = \'Vector Search: <span class="text-blue" style="font-weight:600;"><span class="material-symbols-outlined" style="font-size:16px; vertical-align:middle;">radar</span> Awaiting Peak &ge; $\' + targetV1.toFixed(4) + \'</span> | Max Detected: <strong class="\' + pColor + \'">+$\' + peakAccumulation.toFixed(4) + \'</strong>\'; }',
        '                        let displayAccumulation = 0;',
        '                        for (let i = 0; i < totalPairs; i++) {',
        '                            const winnerIndex = i; const loserIndex = totalCoins - totalPairs + i; const w = activeCandidates[winnerIndex]; const l = activeCandidates[loserIndex]; const net = w.pnl + l.pnl; displayAccumulation += net;',
        '                            let statusIcon = \'hourglass_empty Pending\';',
        '                            if (executingPeak) { if (i <= peakRowIndex) statusIcon = Math.abs(w.pnl) <= winnerThreshold ? \'pause_circle Bypassed\' : \'local_fire_department Harvesting\'; else statusIcon = \'pause_circle Obsolete\'; }',
        '                            else if (executingSl) statusIcon = \'local_fire_department Liquidating\'; else if (executingNoPeakSl) statusIcon = (i === totalPairs - 1) ? \'local_fire_department Severing\' : \'trending_down Descending\'; else statusIcon = (i <= peakRowIndex && peakAccumulation >= peakThreshold) ? \'trending_up Peak Vector\' : \'trending_down Anchor Vector\';',
        '                            const wColor = w.pnl >= 0 ? \'text-green\' : \'text-red\'; const lColor = l.pnl >= 0 ? \'text-green\' : \'text-red\'; const nColor = net >= 0 ? \'text-green\' : \'text-red\'; const cColor = displayAccumulation >= 0 ? \'text-green\' : \'text-red\';',
        '                            let rowClass = (i === peakRowIndex && peakAccumulation >= peakThreshold) ? \'peak-row\' : \'\'; if (i === targetRefIndex) rowClass += \' highlight-row\'; ',
        '                            liveHtml += \'<tr class="\' + rowClass + \'">\' + \'<td class="text-muted" style="font-size:0.8rem;">[\' + (winnerIndex + 1) + \' & \' + (loserIndex + 1) + \'] <br><span class="text-blue" style="font-size:0.7rem; text-transform:uppercase;"><span class="material-symbols-outlined" style="font-size:12px; vertical-align:middle;">\' + statusIcon.split(\' \')[0] + \'</span> \' + statusIcon.substring(statusIcon.indexOf(\' \')+1) + \'</span></td>\' + \'<td style="font-weight:600;">\' + w.symbol + \'</td>\' + \'<td class="\' + wColor + \'" style="font-weight:700;">\' + (w.pnl >= 0 ? \'+\' : \'\') + \'$\' + w.pnl.toFixed(4) + \'</td>\' + \'<td style="font-weight:600;">\' + l.symbol + \'</td>\' + \'<td class="\' + lColor + \'" style="font-weight:700;">\' + (l.pnl >= 0 ? \'+\' : \'\') + \'$\' + l.pnl.toFixed(4) + \'</td>\' + \'<td class="\' + nColor + \'" style="font-weight:700; background: rgba(0,0,0,0.15);">\' + (net >= 0 ? \'+\' : \'\') + \'$\' + net.toFixed(4) + \'</td>\' + \'<td class="\' + cColor + \'" style="font-weight:700; background: rgba(41,98,255,0.05);">\' + (displayAccumulation >= 0 ? \'+\' : \'\') + \'$\' + displayAccumulation.toFixed(4) + (i === targetRefIndex ? \'<br><span style="font-size:0.65rem; color:var(--warning); text-transform:uppercase; letter-spacing:0.5px;"><span class="material-symbols-outlined" style="font-size:10px; vertical-align:middle;">security</span> Gateway</span>\' : \'\') + \'</td>\' + \'</tr>\';',
        '                        }',
        '                        liveHtml += \'</table>\';',
        '                        let dynamicInfoHtml = \'<div class="metric-box" style="margin-bottom:16px; border:1px solid var(--primary); background:var(--bg-surface);"><div class="flex-row-wrap" style="justify-content: space-between; margin-bottom: 8px;"><div><span class="metric-label" style="color:var(--text-main);">Target Delta</span><br><span style="color:var(--primary); font-weight:700; font-size:1.1rem;">$\' + targetV1.toFixed(4) + \'</span></div><div><span class="metric-label" style="color:var(--text-main);">Matrix Stop</span><br><span style="color:var(--danger); font-weight:700; font-size:1.1rem;">$\' + fullGroupSl.toFixed(4) + \'</span></div><div><span class="metric-label" style="color:var(--text-main);">Gateway Limit (Row \' + bottomRowN + \')</span><br><span style="color:var(--warning); font-weight:700; font-size:1.1rem;">$\' + stopLossNth.toFixed(4) + \'</span></div></div>\' + lossTrackerHtml + \'<div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.05); font-size: 0.95rem;">\' + topStatusMessage + \'</div></div>\';',
        '                        document.getElementById(\'liveOffsetsContainer\').innerHTML = dynamicInfoHtml + liveHtml;',
        '                    }',
        '                }',
        '                if (document.getElementById(\'offset2-tab\').style.display === \'block\') {',
        '                    const targetV2 = globalSet.smartOffsetNetProfit2 || 0; const limitV2 = globalSet.smartOffsetStopLoss2 || 0; const stopLossNth = globalSet.smartOffsetBottomRowV1StopLoss || 0; const bottomRowN = globalSet.smartOffsetBottomRowV1 !== undefined ? globalSet.smartOffsetBottomRowV1 : 5; const targetRefIndex = Math.max(0, totalPairs - bottomRowN);',
        '                    let nthBottomAccumulation = 0; let tempAcc = 0; for (let i = 0; i < totalPairs; i++) { tempAcc += activeCandidates[i].pnl + activeCandidates[totalCoins - totalPairs + i].pnl; if (i === targetRefIndex) nthBottomAccumulation = tempAcc; }',
        '                    let v2SlEnabled = true; if (stopLossNth < 0) v2SlEnabled = (nthBottomAccumulation <= stopLossNth);',
        '                    if (totalPairs === 0) { document.getElementById(\'liveOffsetsContainer2\').innerHTML = \'<p class="text-muted" style="padding:20px; text-align:center;">Insufficient pairs for array construction.</p>\'; }',
        '                    else {',
        '                        let liveHtml = \'<table class="md-table"><tr><th>Array Node</th><th>Primary Asset</th><th>Primary Delta</th><th>Hedge Asset</th><th>Hedge Delta</th><th>Composite Net</th></tr>\';',
        '                        let topStatusMessage2 = \'<span style="color:var(--text-muted);"><span class="material-symbols-outlined" style="vertical-align:middle; font-size:18px;">radar</span> Scanning arrays... criteria unmatched.</span>\';',
        '                        for (let i = 0; i < totalPairs; i++) {',
        '                            const winnerIndex = i; const loserIndex = totalCoins - 1 - i; const w = activeCandidates[winnerIndex]; const l = activeCandidates[loserIndex]; const net = w.pnl + l.pnl;',
        '                            const wColor = w.pnl >= 0 ? \'text-green\' : \'text-red\'; const lColor = l.pnl >= 0 ? \'text-green\' : \'text-red\'; const nColor = net >= 0 ? \'text-green\' : \'text-red\';',
        '                            const isTargetHit = (targetV2 > 0 && net >= targetV2); const isSlHit = (v2SlEnabled && limitV2 < 0 && net <= limitV2);',
        '                            let statusIcon = \'hourglass_empty Analyzing\';',
        '                            if (isTargetHit) { statusIcon = \'local_fire_department Engaging TP\'; topStatusMessage2 = \'<span class="text-green" style="font-weight:bold;">🟢 Engaging Array Node \' + (winnerIndex+1) + \' for Take Profit!</span>\'; }',
        '                            else if (isSlHit) { let blockedByLimit = (maxLossPerMin > 0 && (currentMinuteLoss + Math.abs(net)) > maxLossPerMin); if (blockedByLimit) { statusIcon = \'block Rate Limited\'; if (topStatusMessage2.includes(\'Scanning\')) topStatusMessage2 = \'<span class="text-danger" style="font-weight:bold;">🔴 V2 Stop Loss Blocked by Limit Rate.</span>\'; } else { statusIcon = \'block Liquidating\'; topStatusMessage2 = \'<span class="text-danger" style="font-weight:bold;">🔴 Engaging Array Node \' + (winnerIndex+1) + \' for Stop Loss!</span>\'; } }',
        '                            else if (!v2SlEnabled && limitV2 < 0 && net <= limitV2) { statusIcon = \'pause_circle V1 Gate Active\'; }',
        '                            liveHtml += \'<tr><td class="text-muted" style="font-size:0.8rem;">[\' + (winnerIndex + 1) + \' & \' + (loserIndex + 1) + \'] <br><span class="text-primary" style="font-size:0.7rem; text-transform:uppercase;"><span class="material-symbols-outlined" style="font-size:12px; vertical-align:middle;">\' + statusIcon.split(\' \')[0] + \'</span> \' + statusIcon.substring(statusIcon.indexOf(\' \')+1) + \'</span></td><td style="font-weight:600;">\' + w.symbol + \'</td><td class="\' + wColor + \'" style="font-weight:700;">\' + (w.pnl >= 0 ? \'+\' : \'\') + \'$\' + w.pnl.toFixed(4) + \'</td><td style="font-weight:600;">\' + l.symbol + \'</td><td class="\' + lColor + \'" style="font-weight:700;">\' + (l.pnl >= 0 ? \'+\' : \'\') + \'$\' + l.pnl.toFixed(4) + \'</td><td class="\' + nColor + \'" style="font-weight:700; background: rgba(0,0,0,0.15);">\' + (net >= 0 ? \'+\' : \'\') + \'$\' + net.toFixed(4) + \'</td></tr>\';',
        '                        }',
        '                        liveHtml += \'</table>\';',
        '                        let slGateStatus = stopLossNth < 0 ? (v2SlEnabled ? \'<span class="text-danger" style="font-weight:bold;">ARMED</span> (V1 Matrix Safe)\' : \'<span style="color:var(--warning); font-weight:bold;">OVERRIDDEN</span> (V1 Matrix Alert)\') : \'<span class="text-green" style="font-weight:bold;">STANDALONE</span> (No Base Gate)\';',
        '                        let dynamicInfoHtml2 = \'<div class="metric-box" style="margin-bottom:16px; border:1px solid var(--primary); background:var(--bg-surface);"><div class="flex-row-wrap" style="justify-content: space-between; margin-bottom: 8px;"><div><span class="metric-label" style="color:var(--text-main);">Target Delta V2</span><br><span style="color:var(--primary); font-weight:700; font-size:1.1rem;">$\' + targetV2.toFixed(4) + \'</span></div><div><span class="metric-label" style="color:var(--text-main);">Stop Delta V2</span><br><span style="color:var(--danger); font-weight:700; font-size:1.1rem;">$\' + limitV2.toFixed(4) + \'</span></div><div><span class="metric-label" style="color:var(--text-main);">V1 Matrix Gate</span><br><span style="font-size:0.9rem;">\' + slGateStatus + \'</span></div></div>\' + lossTrackerHtml + \'<div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.05); font-size: 0.95rem;">\' + topStatusMessage2 + \'</div></div>\';',
        '                        document.getElementById(\'liveOffsetsContainer2\').innerHTML = dynamicInfoHtml2 + liveHtml;',
        '                    }',
        '                }',
        '                document.getElementById(\'globalWinRate\').innerText = totalAboveZero + \' / \' + totalTrading;',
        '                const topPnlEl = document.getElementById(\'topGlobalUnrealized\');',
        '                topPnlEl.innerText = (globalUnrealized >= 0 ? "+$" : "-$") + Math.abs(globalUnrealized).toFixed(4);',
        '                topPnlEl.className = \'metric-val \' + (globalUnrealized >= 0 ? \'text-green\' : \'text-red\');',
        '                ',
        '                const startTime = data.startTime ? new Date(data.startTime).getTime() : Date.now();',
        '                const elapsedMs = Math.max(Date.now() - startTime, 3600000);',
        '                const elapsedHours = elapsedMs / 3600000;',
        '                const hourly = globalTotal / elapsedHours;',
        '                const setEst = (id, val) => { const el = document.getElementById(id); if(el){ el.innerText = (val >= 0 ? "+$" : "-$") + Math.abs(val).toFixed(2); el.className = "metric-val " + (val >= 0 ? "text-green" : "text-red"); } };',
        '                setEst("estHour", hourly);',
        '                setEst("estDay", hourly * 24);',
        '                setEst("estMonth", hourly * 24 * 30);',
        '                setEst("estYear", hourly * 24 * 365);',
        '                ',
        '                const globalPnlEl = document.getElementById(\'globalPnl\');',
        '                if(globalPnlEl) {',
        '                    globalPnlEl.innerText = (globalTotal >= 0 ? "+$" : "-$") + Math.abs(globalTotal).toFixed(4);',
        '                    globalPnlEl.className = \'metric-val \' + (globalTotal >= 0 ? \'text-green\' : \'text-red\');',
        '                }',
        '                ',
        '                if(currentProfileIndex === -1) return;',
        '                const profile = mySubAccounts[currentProfileIndex];',
        '                const profilePnlEl = document.getElementById(\'profilePnl\');',
        '                const pPnl = profile.realizedPnl || 0;',
        '                if(profilePnlEl) {',
        '                    profilePnlEl.innerText = (pPnl >= 0 ? "+$" : "-$") + Math.abs(pPnl).toFixed(4);',
        '                    profilePnlEl.className = \'metric-val \' + (pPnl >= 0 ? \'text-green\' : \'text-red\');',
        '                }',
        '                let profileMargin = 0;',
        '                const stateData = allStatuses[profile._id] || { coinStates: {}, logs: [] };',
        '                if(!myCoins || myCoins.length === 0) {',
        '                    const dsc = document.getElementById(\'dashboardStatusContainer\');',
        '                    if(dsc) dsc.innerHTML = \'<p class="text-muted" style="text-align:center; padding:20px;">Array empty.</p>\';',
        '                    const pm = document.getElementById(\'profileMargin\');',
        '                    if(pm) pm.innerText = "$0.00";',
        '                } else {',
        '                    let html = \'\';',
        '                    myCoins.forEach(coin => {',
        '                        const state = stateData.coinStates && stateData.coinStates[coin.symbol] ? stateData.coinStates[coin.symbol] : { status: \'Halted\', currentPrice: 0, avgEntry: 0, contracts: 0, currentRoi: 0, unrealizedPnl: 0, margin: 0 };',
        '                        if (state.contracts > 0) { profileMargin += (parseFloat(state.margin) || 0); }',
        '                        let statusColor = state.status === \'Running\' ? \'text-green\' : \'text-red\';',
        '                        if(state.status === \'In Position\') statusColor = \'text-primary\';',
    '                        let roiColorClass = state.currentRoi >= 0 ? \'text-green\' : \'text-red\';',
        '                        const displaySide = coin.side || profile.side || \'long\';',
        '                        if (state.lockUntil && Date.now() < state.lockUntil) { statusColor = \'text-warning\'; state.status = \'Processing\'; }',
        '                        html += \'<div class="metric-box" style="margin-bottom:12px; padding: 12px 16px;"><div class="flex-row-wrap" style="justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 12px;"><div style="font-size: 1rem; font-weight: 600; display:flex; align-items:center; gap:8px;">\' + coin.symbol + \' <span style="background:rgba(255,255,255,0.05); color:var(--text-muted); padding:2px 6px; border-radius:4px; font-size:0.7rem; text-transform:uppercase;">\' + displaySide + \'</span> <span class="\' + statusColor + \'" style="font-size:0.8rem; border-left:1px solid var(--border); padding-left:8px; margin-left:4px;">\' + state.status + \'</span></div><div class="flex-row" style="gap:8px;"><button class="md-btn md-btn-text" style="padding:4px 8px; color:var(--success); border:1px solid rgba(14,203,129,0.3);" onclick="toggleCoinBot(\\\'\' + coin.symbol + \'\\\', true)"><span class="material-symbols-outlined" style="font-size:16px;">play_arrow</span></button><button class="md-btn md-btn-text" style="padding:4px 8px; color:var(--danger); border:1px solid rgba(246,70,93,0.3);" onclick="toggleCoinBot(\\\'\' + coin.symbol + \'\\\', false)"><span class="material-symbols-outlined" style="font-size:16px;">stop</span></button></div></div><div class="grid-3"><div><span class="metric-label">Oracle Price</span><span class="metric-val" style="font-size:1rem; margin-top:2px;">\' + (state.currentPrice || 0) + \'</span></div><div><span class="metric-label">Avg Entry</span><span class="metric-val" style="font-size:1rem; margin-top:2px;">\' + (state.avgEntry || 0) + \'</span></div><div><span class="metric-label">Size</span><span class="metric-val" style="font-size:1rem; margin-top:2px;">\' + (state.contracts || 0) + \'</span></div><div><span class="metric-label">Net Delta</span><span class="metric-val \' + roiColorClass + \'" style="font-size:1rem; margin-top:2px;">\' + (state.unrealizedPnl || 0).toFixed(4) + \'</span></div><div><span class="metric-label">ROI %</span><span class="metric-val \' + roiColorClass + \'" style="font-size:1rem; margin-top:2px;">\' + (state.currentRoi || 0).toFixed(2) + \'%</span></div></div></div>\';',
        '                    });',
        '                    const dsc = document.getElementById(\'dashboardStatusContainer\');',
        '                    if(dsc) dsc.innerHTML = html;',
        '                    const pm = document.getElementById(\'profileMargin\');',
        '                    if(pm) pm.innerText = "$" + profileMargin.toFixed(2);',
        '                }',
        '                // Add syntax highlighting to logs',
        '                const formattedLogs = (stateData.logs || []).map(log => {',
        '                    if(log.includes(\'❌\')) return \'<span style="color:var(--danger);">\' + log + \'</span>\';',
        '                    if(log.includes(\'⚡\') || log.includes(\'🛒\') || log.includes(\'🚀\')) return \'<span style="color:var(--primary);">\' + log + \'</span>\';',
        '                    if(log.includes(\'⚖️\') || log.includes(\'🌍\')) return \'<span style="color:var(--warning);">\' + log + \'</span>\';',
        '                    return log;',
        '                });',
        '                const logsEl = document.getElementById(\'logs\');',
        '                if(logsEl) logsEl.innerHTML = formattedLogs.join(\'<br>\');',
        '            } catch (err) { console.error("Status Load Error", err); }',
        '        }',
        '        checkAuth();',
        '    </script>',
        '</body>',
        '</html>'
    ].join('\n'));
});

// VERCEL EXPORT: Safe Execution Block
if (require.main === module) {
    app.listen(PORT, () => console.log(`🚀 Running locally on http://localhost:${PORT}`));
}
module.exports = app;
