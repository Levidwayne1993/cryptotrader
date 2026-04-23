// ============================================================
// PROJECT: cryptotrader
// FILE: src/bot.ts (UPDATED — replaces existing file)
// DESCRIPTION: Main bot controller — ULTIMATE EDITION v2
//   Everything from PRO EDITION plus:
//   - Break-even stop loss
//   - Dynamic fee tiers from Kraken API
//   - Limit order support (USE_LIMIT_ORDERS env var)
//   - Market regime detection
//   - Enhanced logging with fee breakdown
//   - Partial Take Profit (laddered TP1 sell)
//   - DCA Safety Orders (average down on dips)
//   - Dynamic SL Tightening (progressive profit lock)
// ============================================================

import {
  StrategyType, BotSettings, BotPosition, BotTrade,
  AnalysisResult, TradeMode, CircuitBreakerState, Timeframe,
} from './types';
import { getStrategy } from './strategies';
import { KrakenExchange, getPair, getCoinIdFromPair } from './exchange';
import {
  analyzeCoin, fetchFearGreed, shouldExecuteTrade,
  checkExitConditions, updateTrailingStop,
  applyDynamicSlTightening, getDcaTriggerPrice, calculateAverageEntry,
  ExitCheckResult,
} from './engine';
import {
  saveTrade, saveSignal, savePositions, loadPositions,
  loadRecentTrades, saveSettings, loadSettings,
} from './database';
import { log } from './logger';
import { AlertManager } from './alerts';
import { WhaleTracker } from './whale-tracker';
import { smartPositionSize } from './position-sizing';
import { calculateATR } from './indicators';

const DEFAULT_PAIRS = [
  'BTC/USD', 'ETH/USD', 'SOL/USD', 'DOGE/USD', 'ADA/USD',
  'XRP/USD', 'DOT/USD', 'AVAX/USD', 'LINK/USD',
];

// ============================================================
// FEE & RISK CONFIG
// ============================================================
const MIN_TAKE_PROFIT_PERCENT = 2.33;         // Minimum 2.33% TP floor (undercut $80K wall)
const BREAKEVEN_TRIGGER_PERCENT = 1.87;       // Move SL to entry after 1.87% profit (undercut 2% crowd)
const BREAKEVEN_BUFFER_PERCENT = 0.1;         // SL set to entry + 0.1% (tiny profit to cover fees)

export class TradingBot {
  private exchange: KrakenExchange;
  private settings: BotSettings;
  private positions: BotPosition[] = [];
  private recentTrades: BotTrade[] = [];
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private cycleCount = 0;

  // Pro features
  private alertManager: AlertManager;
  private whaleTracker: WhaleTracker;
  private circuitBreaker: CircuitBreakerState;
  private correlationCache: Map<string, number> = new Map();
  private dailyStartBalance = 0;
  private lastCorrelationCheck = 0;

  // Dynamic fee config — updated from Kraken API
  private currentTakerFee = 0.004;   // default 0.40%
  private currentMakerFee = 0.0025;  // default 0.25%
  private useLimitOrders = false;    // toggled by USE_LIMIT_ORDERS env var

  constructor() {
    const mode = (process.env.TRADE_MODE || 'paper') as TradeMode;
    this.exchange = new KrakenExchange(mode);
    this.useLimitOrders = process.env.USE_LIMIT_ORDERS === 'true';

    this.settings = {
      enabled: true,
      strategy: (process.env.STRATEGY || 'day_trader') as StrategyType,
      mode,
      initial_balance: parseFloat(process.env.INITIAL_BALANCE || '1000'),
      current_balance: parseFloat(process.env.INITIAL_BALANCE || '1000'),
      selected_pairs: (process.env.TRADING_PAIRS || DEFAULT_PAIRS.join(','))
        .split(',').map(s => s.trim()),
      max_daily_trades: parseInt(process.env.MAX_DAILY_TRADES || '30'),
      daily_loss_limit_percent: parseFloat(process.env.DAILY_LOSS_LIMIT || '5'),
      alerts_enabled: !!(process.env.DISCORD_WEBHOOK_URL || process.env.TELEGRAM_BOT_TOKEN),
      discord_webhook_url: process.env.DISCORD_WEBHOOK_URL,
      telegram_bot_token: process.env.TELEGRAM_BOT_TOKEN,
      telegram_chat_id: process.env.TELEGRAM_CHAT_ID,
      correlation_guard_enabled: true,
      max_correlated_positions: 3,
      kelly_sizing_enabled: true,
      whale_tracking_enabled: true,
    };

    this.alertManager = new AlertManager({
      discord_webhook_url: this.settings.discord_webhook_url,
      telegram_bot_token: this.settings.telegram_bot_token,
      telegram_chat_id: this.settings.telegram_chat_id,
      enabled: this.settings.alerts_enabled,
    });

    this.whaleTracker = new WhaleTracker();

    this.circuitBreaker = {
      is_tripped: false,
      reason: '',
      tripped_at: null,
      resume_at: null,
      daily_loss_percent: 0,
      consecutive_losses: 0,
      trades_today: 0,
    };
  }

  async start(): Promise<void> {
    log('info', '========================================');
    log('info', '  CryptoBot ULTIMATE Server Starting...');
    log('info', '========================================');
    log('info', `Mode: ${this.settings.mode.toUpperCase()}`);
    log('info', `Strategy: ${getStrategy(this.settings.strategy).name}`);
    log('info', `Pairs: ${this.settings.selected_pairs.join(', ')}`);
    log('info', `Balance: $${this.settings.initial_balance}`);
    log('info', `Alerts: ${this.settings.alerts_enabled ? 'ON' : 'OFF'}`);
    log('info', `Whale Tracking: ${this.settings.whale_tracking_enabled ? 'ON' : 'OFF'}`);
    log('info', `Kelly Sizing: ${this.settings.kelly_sizing_enabled ? 'ON' : 'OFF'}`);
    log('info', `Correlation Guard: ${this.settings.correlation_guard_enabled ? 'ON' : 'OFF'}`);
    log('info', `Order Type: ${this.useLimitOrders ? 'LIMIT (maker fees)' : 'MARKET (taker fees)'}`);
    log('info', `Min Take Profit: ${MIN_TAKE_PROFIT_PERCENT}% (floor to clear fees)`);
    log('info', `Break-Even Stop: Triggers at ${BREAKEVEN_TRIGGER_PERCENT}% profit`);
    log('info', `Partial TP: ${getStrategy(this.settings.strategy).riskParams.partialTpEnabled ? 'ON' : 'OFF'} | TP1: ${getStrategy(this.settings.strategy).riskParams.tp1Percent || 'N/A'}% | Sell: ${getStrategy(this.settings.strategy).riskParams.tp1SellPercent || 'N/A'}%`);
    log('info', `DCA Safety Orders: ${getStrategy(this.settings.strategy).riskParams.dcaEnabled ? 'ON' : 'OFF'} | Max: ${getStrategy(this.settings.strategy).riskParams.dcaMaxOrders || 0} | Step: ${getStrategy(this.settings.strategy).riskParams.dcaStepPercent || 'N/A'}%`);
    log('info', `Dynamic SL Tightening: ${getStrategy(this.settings.strategy).riskParams.dynamicSlEnabled ? 'ON' : 'OFF'}`);
    log('info', '========================================');

    const connected = await this.exchange.testConnection();
    if (!connected) {
      log('error', 'Cannot connect to Kraken.');
      if (this.settings.mode === 'live') { process.exit(1); }
    }

    // Fetch dynamic fee tier
    await this.updateFeeTier();

    await this.loadState();

    // FIX: Include existing position values in dailyStartBalance
    const startingPositionValue = this.positions.reduce((sum, p) => sum + p.position_value, 0);
    this.dailyStartBalance = this.settings.current_balance + startingPositionValue;

    if (this.settings.mode === 'live') {
      const balance = await this.exchange.getBalance();
      if (balance.free > 0) {
        this.settings.current_balance = balance.free;
        this.dailyStartBalance = balance.free;
      }
    }

    const strategy = getStrategy(this.settings.strategy);
    log('info', `Starting trading loop — interval: ${strategy.intervalMs / 1000}s`);

    await this.runCycle();
    this.intervalId = setInterval(() => this.runCycle(), strategy.intervalMs);

    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
    log('info', 'Bot is running. Press Ctrl+C to stop.');
  }

  // ============================================================
  // UPDATE FEE TIER — queries Kraken for actual fees
  // ============================================================
  private async updateFeeTier(): Promise<void> {
    try {
      const feeTier = await this.exchange.getFeeTier();
      this.currentTakerFee = feeTier.takerFee;
      this.currentMakerFee = feeTier.makerFee;
      log('info', `Fee Tier: ${feeTier.tierName} | Maker: ${(feeTier.makerFee * 100).toFixed(2)}% | Taker: ${(feeTier.takerFee * 100).toFixed(2)}%`);
    } catch (err: any) {
      log('warn', `Fee tier fetch failed: ${err.message} — using defaults`);
    }
  }

  // Get the active fee rate based on order type setting
  private getActiveFeeRate(): number {
    return this.useLimitOrders ? this.currentMakerFee : this.currentTakerFee;
  }

  // ============================================================
  // MAIN CYCLE
  // ============================================================
  private async runCycle(): Promise<void> {
    this.cycleCount++;
    const strategy = getStrategy(this.settings.strategy);
    log('info', `--- Cycle #${this.cycleCount} [${strategy.shortName}] ---`);

    try {
      // Refresh fee tier every 100 cycles (~50 min for day_trader)
      if (this.cycleCount % 100 === 0) {
        await this.updateFeeTier();
      }

      // 1. Check circuit breaker
      if (this.circuitBreaker.is_tripped) {
        if (this.circuitBreaker.resume_at &&
            new Date() > new Date(this.circuitBreaker.resume_at)) {
          log('info', 'Circuit breaker reset — resuming trading');
          this.circuitBreaker.is_tripped = false;
          this.circuitBreaker.reason = '';
          this.circuitBreaker.resume_at = null;
        } else {
          log('warn', `Circuit breaker active: ${this.circuitBreaker.reason}`);
          this.logSummary();
          return;
        }
      }

      // 2. Check daily loss limit
      this.checkDailyLoss();
      if (this.circuitBreaker.is_tripped) {
        this.logSummary();
        return;
      }

      // 3. Fetch Fear & Greed
      const fearGreed = await fetchFearGreed();

      // 4. Fetch market data
      const marketDataList = await this.exchange.getMultipleMarketData(
        this.settings.selected_pairs,
        strategy.primaryTimeframe || '5m'
      );
      if (marketDataList.length === 0) {
        log('warn', 'No market data — skipping cycle');
        return;
      }

      // 5. Fetch whale data (if enabled)
      let whaleDataMap = new Map();
      if (this.settings.whale_tracking_enabled && strategy.useWhaleTracking) {
        try {
          whaleDataMap = await this.whaleTracker.getMultipleWhaleData(
            this.settings.selected_pairs
          );
        } catch (err: any) {
          log('warn', `Whale data fetch failed: ${err.message}`);
        }
      }

      // 6. Update correlation cache periodically (every 10 cycles)
      if (this.settings.correlation_guard_enabled &&
          this.cycleCount - this.lastCorrelationCheck >= 10) {
        await this.updateCorrelations();
        this.lastCorrelationCheck = this.cycleCount;
      }

      // 7. Check exits + BREAK-EVEN + DYNAMIC SL + DCA + PARTIAL TP
      for (const position of [...this.positions]) {
        const md = marketDataList.find(m => m.pair === position.pair);
        if (!md) continue;

        // Update trailing stop
        const updated = updateTrailingStop(position, md.current_price, strategy);
        const idx = this.positions.findIndex(p => p.pair === position.pair);
        if (idx >= 0) this.positions[idx] = updated;

        // ============================================================
        // BREAK-EVEN STOP LOSS
        // ============================================================
        if (idx >= 0) {
          const entryForBE = this.positions[idx].average_entry_price || this.positions[idx].entry_price;
          const currentProfitPercent =
            ((md.current_price - entryForBE) / entryForBE) * 100;

          if (currentProfitPercent >= BREAKEVEN_TRIGGER_PERCENT) {
            const breakevenPrice = entryForBE * (1 + BREAKEVEN_BUFFER_PERCENT / 100);
            if (this.positions[idx].stop_loss_price < breakevenPrice) {
              const oldSL = this.positions[idx].stop_loss_price;
              this.positions[idx].stop_loss_price = breakevenPrice;
              log('info', `\uD83D\uDEE1\uFE0F BREAK-EVEN: ${position.pair} SL moved from $${oldSL.toFixed(4)} to $${breakevenPrice.toFixed(4)} (entry + ${BREAKEVEN_BUFFER_PERCENT}%)`);
            }
          }
        }

        // ============================================================
        // DYNAMIC SL TIGHTENING
        //   Progressively lock in more profit as price rises
        // ============================================================
        if (idx >= 0 && strategy.riskParams.dynamicSlEnabled !== false) {
          const slResult = applyDynamicSlTightening(
            this.positions[idx], md.current_price, strategy
          );
          if (slResult.tightened) {
            this.positions[idx] = slResult.position;
            log('info', `\uD83D\uDD12 DYNAMIC SL: ${position.pair} SL tightened to $${slResult.newSlPrice.toFixed(4)} (locking +${slResult.level}% profit tier)`);
          }
        }

        // ============================================================
        // DCA SAFETY ORDERS
        //   If price drops below DCA trigger levels, buy more to
        //   average down the entry price
        // ============================================================
        if (idx >= 0 && strategy.riskParams.dcaEnabled) {
          const dcaFilled = this.positions[idx].dca_orders_filled || 0;
          const dcaMax = strategy.riskParams.dcaMaxOrders || 3;
          const dcaStep = strategy.riskParams.dcaStepPercent || 1.5;
          const dcaMult = strategy.riskParams.dcaStepMultiplier || 1.5;

          if (dcaFilled < dcaMax) {
            const nextDcaOrder = dcaFilled + 1;
            const triggerPrice = getDcaTriggerPrice(
              this.positions[idx].entry_price, nextDcaOrder, dcaStep, dcaMult
            );

            if (md.current_price <= triggerPrice) {
              await this.executeDcaBuy(this.positions[idx], md.current_price, nextDcaOrder, strategy);
            }
          }
        }

        // ============================================================
        // EXIT CHECK (with Partial TP + TP Trail + full exits)
        // ============================================================
        const currentPos = this.positions[idx];
        if (!currentPos) continue;
        const exit = checkExitConditions(currentPos, md.current_price, strategy, md.ohlcv);

        if (exit.shouldPartialSell) {
          await this.executePartialSell(currentPos, md.current_price, exit.reason, strategy);
        } else if (exit.shouldSell) {
          await this.executeSell(currentPos, md.current_price, exit.reason, strategy);
        }
      }

// 8. Analyze each pair for new entries
      for (const md of marketDataList) {
        if (md.ohlcv.length < 30) {
          log('warn', `Insufficient data for ${md.pair} — ${md.ohlcv.length} candles`);
          continue;
        }

        // Fetch order book if strategy uses it
        let orderBook = undefined;
        if (strategy.useOrderBook) {
          orderBook = await this.exchange.getOrderBook(md.pair) || undefined;
        }

        // Get multi-timeframe data if strategy uses it
        let multiTfData = undefined;
        if (strategy.timeframes && strategy.timeframes.length > 1) {
          const mtfResult = await this.exchange.getMultiTimeframeData(
            md.pair, strategy.timeframes
          );
          if (mtfResult) {
            multiTfData = mtfResult.timeframes;
          }
        }

        // Get whale data for this pair
        const whaleData = whaleDataMap.get(md.pair);

        // Run analysis with ALL pro data
        const analysis = analyzeCoin(
          md, fearGreed, strategy,
          whaleData, orderBook as any, multiTfData
        );

        // Log every score
        log('info', `${analysis.pair}: score=${analysis.score} conf=${analysis.confidence}% -> ${analysis.action}`);

        if (analysis.action !== 'HOLD') {
          log('signal', `${analysis.action} signal: ${analysis.symbol} @ $${analysis.current_price.toFixed(2)} | Score: ${analysis.score} | Conf: ${analysis.confidence}%`);
        }

        await saveSignal(analysis, strategy.id);

        // Check if we should execute
        const { execute, reason } = shouldExecuteTrade(
          analysis, this.settings, this.positions, this.recentTrades, strategy
        );

        if (!execute) {
          if (analysis.action !== 'HOLD') {
            log('info', `Skipped ${analysis.action} ${analysis.symbol}: ${reason}`);
          }
          continue;
        }

        // Correlation guard
        if (analysis.action === 'BUY' && this.settings.correlation_guard_enabled) {
          const blocked = this.checkCorrelationGuard(analysis.pair);
          if (blocked) {
            log('info', `Correlation guard blocked ${analysis.pair} — too correlated with open positions`);
            continue;
          }
        }

        // Execute
        if (analysis.action === 'BUY') {
          await this.executeBuy(analysis, strategy);
        } else if (analysis.action === 'SELL') {
          const pos = this.positions.find(p => p.pair === analysis.pair);
          if (pos) {
            await this.executeSell(pos, analysis.current_price, 'Sell signal', strategy);
          }
        }
      }

      // 9. Update positions with FEE-ADJUSTED unrealized P&L
      const feeRate = this.getActiveFeeRate();
      for (let i = 0; i < this.positions.length; i++) {
        const md = marketDataList.find(m => m.pair === this.positions[i].pair);
        if (md) {
          this.positions[i].current_price = md.current_price;
          this.positions[i].position_value = md.current_price * this.positions[i].quantity;

          // Calculate unrealized P&L WITH estimated fees
          const grossUnrealized = (md.current_price - this.positions[i].entry_price) * this.positions[i].quantity;
          const buyFeeEstimate = this.positions[i].entry_price * this.positions[i].quantity * feeRate;
          const sellFeeEstimate = md.current_price * this.positions[i].quantity * feeRate;
          const estimatedFees = buyFeeEstimate + sellFeeEstimate;

          this.positions[i].unrealized_pnl = grossUnrealized - estimatedFees;
          this.positions[i].unrealized_pnl_percent =
            (this.positions[i].unrealized_pnl / (this.positions[i].entry_price * this.positions[i].quantity)) * 100;
        }
      }

      // 10. Save state
      await this.saveState();
      this.logSummary();

    } catch (err: any) {
      log('error', `Cycle error: ${err.message}`);
      await this.alertManager.error('Cycle Error', err.message);
    }
  }

  // ============================================================
  // EXECUTE BUY — with Kelly sizing + ATR stops + MIN TP FLOOR
  //   + dynamic fees + limit order support
  // ============================================================
  private async executeBuy(
    analysis: AnalysisResult,
    strategy: ReturnType<typeof getStrategy>
  ): Promise<void> {
    const feeRate = this.getActiveFeeRate();

    // Smart position sizing
    let positionSize: number;
    let kellyFraction: number | undefined;
    let atrAtEntry: number | undefined;
    let riskAmount: number | undefined;

    const closedTrades = this.recentTrades.filter(t => t.status === 'closed');

    if (strategy.riskParams.useKellySizing && this.settings.kelly_sizing_enabled) {
      const atrValue = analysis.indicator_details?.atr?.atr || 0;
      const sizing = smartPositionSize(
        closedTrades,
        analysis.current_price,
        atrValue,
        this.settings.current_balance,
        strategy.riskParams.riskPerTradePercent || 2,
        strategy.riskParams.maxKellyPercent || 20,
        strategy.riskParams.atrStopMultiplier || 2.0
      );
      positionSize = sizing.position_size_usd;
      kellyFraction = sizing.kelly.half_kelly;
      atrAtEntry = atrValue;
      riskAmount = sizing.atr_sizing.risk_amount;

      log('info', `Smart sizing: $${positionSize.toFixed(2)} (${sizing.method}) | Kelly: ${kellyFraction.toFixed(1)}%`);
    } else {
      positionSize = this.settings.current_balance * (strategy.riskParams.maxPositionPercent / 100);

      if (strategy.id === 'dca') {
        const base = this.settings.current_balance * 0.05;
        if (analysis.indicators.fear_greed < 30) positionSize = base * 1.5;
        else if (analysis.indicators.fear_greed > 70) positionSize = base * 0.5;
        else positionSize = base;
      }
    }

    positionSize = Math.min(positionSize, this.settings.current_balance);
    if (positionSize < 5) {
      log('warn', `Position too small ($${positionSize.toFixed(2)}) — skipping`);
      return;
    }

    // Execute order — limit or market based on config
    let result;
    if (this.useLimitOrders) {
      result = await this.exchange.limitBuy(analysis.pair, positionSize);
    } else {
      result = await this.exchange.marketBuy(analysis.pair, positionSize);
    }

    if (!result.success) {
      log('error', `Buy failed: ${result.error}`);
      return;
    }

    const price = result.price || analysis.current_price;
    const quantity = result.quantity || positionSize / price;
    const orderType = result.orderType || (this.useLimitOrders ? 'limit' : 'market');

    // Deduct buy fee from balance
    const buyFee = positionSize * feeRate;
    this.settings.current_balance -= (positionSize + buyFee);
    log('info', `Buy fee: $${buyFee.toFixed(4)} (${(feeRate * 100).toFixed(2)}% ${orderType})`);

    // Calculate stops — ATR-based if enabled
    let stopLossPrice = 0;
    let takeProfitPrice = 0;

    if (strategy.riskParams.useAtrStops && atrAtEntry && atrAtEntry > 0) {
      stopLossPrice = price - (atrAtEntry * (strategy.riskParams.atrStopMultiplier || 2));
      takeProfitPrice = price + (atrAtEntry * (strategy.riskParams.atrStopMultiplier || 2) * 2);
      log('info', `ATR stops: SL $${stopLossPrice.toFixed(2)} | TP $${takeProfitPrice.toFixed(2)}`);
    } else {
      stopLossPrice = strategy.riskParams.stopLossPercent > 0
        ? price * (1 - strategy.riskParams.stopLossPercent / 100) : 0;
      takeProfitPrice = strategy.riskParams.takeProfitPercent > 0
        ? price * (1 + strategy.riskParams.takeProfitPercent / 100) : 0;
    }

    // Enforce minimum TP floor (must clear round-trip fees)
    const roundTripFeePercent = feeRate * 2 * 100; // e.g., 0.80% for taker
    const effectiveMinTp = Math.max(MIN_TAKE_PROFIT_PERCENT, roundTripFeePercent + 0.5);
    const minTpPrice = price * (1 + effectiveMinTp / 100);
    if (takeProfitPrice > 0 && takeProfitPrice < minTpPrice) {
      const originalTpPercent = ((takeProfitPrice - price) / price * 100).toFixed(2);
      log('info', `⚡ TP FLOOR: ATR target $${takeProfitPrice.toFixed(4)} (${originalTpPercent}%) raised to $${minTpPrice.toFixed(4)} (${effectiveMinTp.toFixed(1)}%) to clear ${orderType} fees`);
      takeProfitPrice = minTpPrice;
    }

    const position: BotPosition = {
      coin_id: getCoinIdFromPair(analysis.pair),
      symbol: analysis.symbol,
      pair: analysis.pair,
      entry_price: price,
      current_price: price,
      quantity,
      position_value: positionSize,
      unrealized_pnl: 0,
      unrealized_pnl_percent: 0,
      stop_loss_price: stopLossPrice,
      take_profit_price: takeProfitPrice,
      trailing_stop_price: strategy.riskParams.trailingStop
        ? price * (1 - strategy.riskParams.trailingStopPercent / 100) : undefined,
      highest_price: price,
      strategy: strategy.id,
      opened_at: new Date().toISOString(),
      order_id: result.orderId,
      atr_at_entry: atrAtEntry,
      kelly_fraction: kellyFraction,
      risk_amount: riskAmount,
      // Partial TP + DCA tracking fields
      original_quantity: quantity,
      tp1_hit: false,
      partial_sells_count: 0,
      dca_orders_filled: 0,
      dca_total_invested: positionSize,
      average_entry_price: price,
      dynamic_sl_level: 0,
    };

    this.positions.push(position);

    const trade: BotTrade = {
      coin_id: position.coin_id,
      symbol: analysis.symbol,
      pair: analysis.pair,
      action: 'BUY',
      strategy: strategy.id,
      entry_price: price,
      quantity,
      position_value: positionSize,
      score: analysis.score,
      confidence: analysis.confidence,
      reasoning: analysis.reasoning,
      status: 'open',
      stop_loss_price: stopLossPrice,
      take_profit_price: takeProfitPrice,
      trailing_stop_price: position.trailing_stop_price,
      opened_at: new Date().toISOString(),
      order_id: result.orderId,
      mode: this.settings.mode,
      kelly_fraction: kellyFraction,
      atr_at_entry: atrAtEntry,
      risk_amount: riskAmount,
    };

    this.recentTrades.push(trade);
    await saveTrade(trade);

    log('trade', `BUY ${quantity.toFixed(8)} ${analysis.symbol} @ $${price.toFixed(2)} = $${positionSize.toFixed(2)} (${orderType} fee: $${buyFee.toFixed(4)}) | SL: $${stopLossPrice.toFixed(2)} | TP: $${takeProfitPrice.toFixed(2)}`);

    await this.alertManager.tradeOpened({
      pair: analysis.pair, price, quantity, positionSize,
      score: analysis.score, confidence: analysis.confidence,
      stopLoss: stopLossPrice, takeProfit: takeProfitPrice,
      strategy: strategy.id, kellyFraction,
    });
  }

// ============================================================
  // EXECUTE PARTIAL SELL — sells a portion at TP1, keeps rest riding
  // ============================================================
  private async executePartialSell(
    position: BotPosition,
    currentPrice: number,
    reason: string,
    strategy: ReturnType<typeof getStrategy>
  ): Promise<void> {
    const feeRate = this.getActiveFeeRate();
    const sellPercent = (strategy.riskParams.tp1SellPercent || 50) / 100;
    const sellQty = position.quantity * sellPercent;

    // Execute order
    let result;
    if (this.useLimitOrders) {
      result = await this.exchange.limitSell(position.pair, sellQty);
    } else {
      result = await this.exchange.marketSell(position.pair, sellQty);
    }

    if (!result.success) {
      log('error', `Partial sell failed: ${result.error}`);
      return;
    }

    const exitPrice = result.price || currentPrice;
    const orderType = result.orderType || (this.useLimitOrders ? 'limit' : 'market');

    // Fee-aware P&L for partial sell
    const partialEntryValue = position.entry_price * sellQty;
    const grossPnl = (exitPrice - position.entry_price) * sellQty;
    const buyFee = partialEntryValue * feeRate;
    const sellFee = exitPrice * sellQty * feeRate;
    const totalFees = buyFee + sellFee;
    const pnl = grossPnl - totalFees;
    const pnlPercent = (pnl / partialEntryValue) * 100;

    // Credit balance with sell proceeds
    const sellProceeds = (exitPrice * sellQty) - sellFee;
    this.settings.current_balance += sellProceeds;

    // Update position — reduce quantity, mark TP1 hit
    const idx = this.positions.findIndex(p => p.pair === position.pair);
    if (idx >= 0) {
      this.positions[idx].quantity -= sellQty;
      this.positions[idx].tp1_hit = true;
      this.positions[idx].partial_sells_count = (this.positions[idx].partial_sells_count || 0) + 1;

      // Move SL to break-even after partial TP
      const entryForBE = this.positions[idx].average_entry_price || this.positions[idx].entry_price;
      const breakevenPrice = entryForBE * (1 + BREAKEVEN_BUFFER_PERCENT / 100);
      if (this.positions[idx].stop_loss_price < breakevenPrice) {
        this.positions[idx].stop_loss_price = breakevenPrice;
        log('info', `\uD83D\uDEE1\uFE0F TP1 hit \u2014 SL moved to break-even: $${breakevenPrice.toFixed(4)}`);
      }
    }

    this.circuitBreaker.trades_today++;

    // Log trade
    const trade: BotTrade = {
      coin_id: position.coin_id,
      symbol: position.symbol,
      pair: position.pair,
      action: 'SELL',
      strategy: strategy.id,
      entry_price: position.entry_price,
      exit_price: exitPrice,
      quantity: sellQty,
      position_value: exitPrice * sellQty,
      pnl,
      pnl_percent: pnlPercent,
      score: 0,
      confidence: 0,
      reasoning: [`Partial TP1: ${reason}`, `Fees: $${totalFees.toFixed(4)} (${orderType})`],
      status: 'closed',
      stop_loss_price: position.stop_loss_price,
      take_profit_price: position.take_profit_price,
      trailing_stop_price: position.trailing_stop_price,
      opened_at: position.opened_at,
      closed_at: new Date().toISOString(),
      order_id: result.orderId,
      mode: this.settings.mode,
      exit_reason: `Partial TP1: ${reason}`,
      kelly_fraction: position.kelly_fraction,
      atr_at_entry: position.atr_at_entry,
      risk_amount: position.risk_amount,
      is_partial: true,
      average_entry_price: position.average_entry_price,
    };

    this.recentTrades.push(trade);
    await saveTrade(trade);

    log('trade', `\uD83C\uDFAF PARTIAL SELL ${(sellPercent * 100).toFixed(0)}% of ${position.symbol}: ${sellQty.toFixed(8)} @ $${exitPrice.toFixed(2)} | Net: +$${pnl.toFixed(2)} (+${pnlPercent.toFixed(2)}%) | Remaining: ${(position.quantity - sellQty).toFixed(8)} | ${reason}`);

    await this.alertManager.tradeClosed({
      pair: position.pair,
      entryPrice: position.entry_price,
      exitPrice,
      pnl,
      pnlPercent,
      reason: `Partial TP1: ${reason}`,
      holdTime: `${Math.round((Date.now() - new Date(position.opened_at).getTime()) / 60000)}m`,
    });
  }

  // ============================================================
  // EXECUTE DCA BUY — buy more at a lower price to average down
  // ============================================================
  private async executeDcaBuy(
    position: BotPosition,
    currentPrice: number,
    dcaOrderNumber: number,
    strategy: ReturnType<typeof getStrategy>
  ): Promise<void> {
    const feeRate = this.getActiveFeeRate();
    const dcaSizePercent = (strategy.riskParams.dcaOrderSizePercent || 50) / 100;
    const originalValue = position.entry_price * (position.original_quantity || position.quantity);
    const dcaBudget = originalValue * dcaSizePercent;

    // Check if we have enough balance
    if (this.settings.current_balance < dcaBudget) {
      log('warn', `\u26A0\uFE0F DCA #${dcaOrderNumber} ${position.pair}: insufficient balance ($${this.settings.current_balance.toFixed(2)} < $${dcaBudget.toFixed(2)})`);
      return;
    }

    // Execute buy
    const dcaQty = dcaBudget / currentPrice;
    let result;
    if (this.useLimitOrders) {
      result = await this.exchange.limitBuy(position.pair, dcaBudget);
    } else {
      result = await this.exchange.marketBuy(position.pair, dcaBudget);
    }

    if (!result.success) {
      log('error', `DCA buy #${dcaOrderNumber} failed: ${result.error}`);
      return;
    }

    const fillPrice = result.price || currentPrice;
    const fillQty = result.quantity || dcaQty;
    const orderType = result.orderType || (this.useLimitOrders ? 'limit' : 'market');
    const buyFee = fillPrice * fillQty * feeRate;

    // Debit balance
    this.settings.current_balance -= (dcaBudget + buyFee);

    // Update position with new average entry
    const idx = this.positions.findIndex(p => p.pair === position.pair);
    if (idx >= 0) {
      const pos = this.positions[idx];
      const oldQty = pos.quantity;
      const oldValue = pos.entry_price * oldQty;
      const newValue = fillPrice * fillQty;

      pos.quantity = oldQty + fillQty;
      pos.average_entry_price = (oldValue + newValue) / (oldQty + fillQty);
      pos.dca_orders_filled = dcaOrderNumber;
      pos.dca_total_invested = (pos.dca_total_invested || oldValue) + newValue;
      pos.position_value = pos.quantity * fillPrice;

      // Recalculate SL/TP relative to new average entry
      const avgEntry = pos.average_entry_price;
      if (strategy.riskParams.useAtrStops && pos.atr_at_entry) {
        pos.stop_loss_price = avgEntry - (pos.atr_at_entry * (strategy.riskParams.atrStopMultiplier || 3.7));
      } else {
        pos.stop_loss_price = avgEntry * (1 - strategy.riskParams.stopLossPercent / 100);
      }
      pos.take_profit_price = avgEntry * (1 + Math.max(
        strategy.riskParams.takeProfitPercent,
        MIN_TAKE_PROFIT_PERCENT
      ) / 100);

      this.positions[idx] = pos;
    }

    this.circuitBreaker.trades_today++;

    // Log DCA trade
    const trade: BotTrade = {
      coin_id: position.coin_id,
      symbol: position.symbol,
      pair: position.pair,
      action: 'BUY',
      strategy: strategy.id,
      entry_price: fillPrice,
      quantity: fillQty,
      position_value: fillPrice * fillQty,
      score: 0,
      confidence: 0,
      reasoning: [`DCA #${dcaOrderNumber}`, `Avg down from $${position.entry_price.toFixed(2)}`, `Fees: $${buyFee.toFixed(4)} (${orderType})`],
      status: 'open',
      stop_loss_price: this.positions.find(p => p.pair === position.pair)?.stop_loss_price,
      take_profit_price: this.positions.find(p => p.pair === position.pair)?.take_profit_price,
      opened_at: new Date().toISOString(),
      order_id: result.orderId,
      mode: this.settings.mode,
      kelly_fraction: position.kelly_fraction,
      atr_at_entry: position.atr_at_entry,
      risk_amount: position.risk_amount,
      is_dca_buy: true,
      dca_order_number: dcaOrderNumber,
      average_entry_price: this.positions.find(p => p.pair === position.pair)?.average_entry_price,
    };

    this.recentTrades.push(trade);
    await saveTrade(trade);

    const newAvg = this.positions.find(p => p.pair === position.pair)?.average_entry_price || fillPrice;
    log('trade', `\uD83D\uDCE5 DCA #${dcaOrderNumber} ${position.symbol}: +${fillQty.toFixed(8)} @ $${fillPrice.toFixed(2)} ($${dcaBudget.toFixed(2)}) | New avg: $${newAvg.toFixed(2)} | Total qty: ${(position.quantity + fillQty).toFixed(8)}`);

    await this.alertManager.tradeOpened({
      pair: position.pair,
      price: fillPrice,
      score: 0,
      confidence: 0,
      positionSize: dcaBudget,
      reason: `DCA Safety Order #${dcaOrderNumber} — averaged down from $${position.entry_price.toFixed(2)} to $${newAvg.toFixed(2)}`,
    });
  }

    // ============================================================
  // EXECUTE SELL — with fee deduction + limit order support
  // ============================================================
  private async executeSell(
    position: BotPosition,
    currentPrice: number,
    reason: string,
    strategy: ReturnType<typeof getStrategy>
  ): Promise<void> {
    const feeRate = this.getActiveFeeRate();

    // Execute order — limit or market
    let result;
    if (this.useLimitOrders) {
      result = await this.exchange.limitSell(position.pair, position.quantity);
    } else {
      result = await this.exchange.marketSell(position.pair, position.quantity);
    }

    if (!result.success) {
      log('error', `Sell failed: ${result.error}`);
      return;
    }

    const exitPrice = result.price || currentPrice;
    const orderType = result.orderType || (this.useLimitOrders ? 'limit' : 'market');

    // Fee-aware P&L calculation
    const grossPnl = (exitPrice - position.entry_price) * position.quantity;
    const buyFee = position.entry_price * position.quantity * feeRate;
    const sellFee = exitPrice * position.quantity * feeRate;
    const totalFees = buyFee + sellFee;
    const pnl = grossPnl - totalFees;
    const pnlPercent = (pnl / (position.entry_price * position.quantity)) * 100;

    // Credit balance
    const sellProceeds = (exitPrice * position.quantity) - sellFee;
    this.settings.current_balance += sellProceeds;

    this.positions = this.positions.filter(p => p.pair !== position.pair);

    // Update circuit breaker
    if (pnl < 0) {
      this.circuitBreaker.consecutive_losses++;
      if (this.circuitBreaker.consecutive_losses >= 5) {
        this.tripCircuitBreaker(`${this.circuitBreaker.consecutive_losses} consecutive losses`);
      }
    } else {
      this.circuitBreaker.consecutive_losses = 0;
    }
    this.circuitBreaker.trades_today++;

    // Hold time
    const holdMs = Date.now() - new Date(position.opened_at).getTime();
    const holdHours = Math.round(holdMs / (1000 * 60 * 60) * 10) / 10;
    const holdTime = holdHours < 1
      ? `${Math.round(holdMs / (1000 * 60))}m`
      : `${holdHours}h`;

    const trade: BotTrade = {
      coin_id: position.coin_id,
      symbol: position.symbol,
      pair: position.pair,
      action: 'SELL',
      strategy: strategy.id,
      entry_price: position.entry_price,
      exit_price: exitPrice,
      quantity: position.quantity,
      position_value: exitPrice * position.quantity,
      pnl,
      pnl_percent: pnlPercent,
      score: 0,
      confidence: 0,
      reasoning: [`Exit: ${reason}`, `Fees: $${totalFees.toFixed(4)} (${orderType})`],
      status: 'closed',
      stop_loss_price: position.stop_loss_price,
      take_profit_price: position.take_profit_price,
      trailing_stop_price: position.trailing_stop_price,
      opened_at: position.opened_at,
      closed_at: new Date().toISOString(),
      order_id: result.orderId,
      mode: this.settings.mode,
      exit_reason: reason,
      kelly_fraction: position.kelly_fraction,
      atr_at_entry: position.atr_at_entry,
      risk_amount: position.risk_amount,
    };

    this.recentTrades.push(trade);
    await saveTrade(trade);

    const sign = pnl >= 0 ? '+' : '';
    const emoji = pnl >= 0 ? '💰' : '📉';
    log('trade', `${emoji} SELL ${position.quantity.toFixed(8)} ${position.symbol} @ $${exitPrice.toFixed(2)} | Gross: ${grossPnl >= 0 ? '+' : ''}$${grossPnl.toFixed(2)} | Fees: $${totalFees.toFixed(4)} (${orderType}) | Net: ${sign}$${pnl.toFixed(2)} (${sign}${pnlPercent.toFixed(2)}%) | ${reason} | Hold: ${holdTime}`);

    await this.alertManager.tradeClosed({
      pair: position.pair,
      entryPrice: position.entry_price,
      exitPrice,
      pnl,
      pnlPercent,
      reason,
      holdTime,
    });
  }

  // ============================================================
  // CIRCUIT BREAKER
  // ============================================================
  private checkDailyLoss(): void {
    if (this.dailyStartBalance <= 0) return;
    const totalValue = this.getTotalPortfolioValue();
    const dailyLossPercent =
      ((this.dailyStartBalance - totalValue) / this.dailyStartBalance) * 100;
    this.circuitBreaker.daily_loss_percent = dailyLossPercent;

    if (dailyLossPercent >= this.settings.daily_loss_limit_percent) {
      this.tripCircuitBreaker(`Daily loss limit hit: ${dailyLossPercent.toFixed(2)}%`);
    }
  }

  private tripCircuitBreaker(reason: string): void {
    this.circuitBreaker.is_tripped = true;
    this.circuitBreaker.reason = reason;
    this.circuitBreaker.tripped_at = new Date().toISOString();
    const resumeAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    this.circuitBreaker.resume_at = resumeAt.toISOString();

    log('warn', `🛑 CIRCUIT BREAKER: ${reason} — paused until ${resumeAt.toLocaleTimeString()}`);

    this.alertManager.circuitBreakerTripped({
      reason,
      dailyLoss: this.circuitBreaker.daily_loss_percent,
      consecutiveLosses: this.circuitBreaker.consecutive_losses,
      resumeAt: resumeAt.toLocaleTimeString(),
    });
  }

  // ============================================================
  // CORRELATION GUARD
  // ============================================================
  private async updateCorrelations(): Promise<void> {
    try {
      const result = await this.exchange.calculateCorrelation(
        this.settings.selected_pairs, '1h', 50
      );
      this.correlationCache.clear();
      for (const hc of result.highly_correlated) {
        const key = `${hc.pair_a}|${hc.pair_b}`;
        this.correlationCache.set(key, hc.correlation);
      }
      if (result.highly_correlated.length > 0) {
        log('info', `Correlation: ${result.highly_correlated.length} highly correlated pairs found`);
      }
    } catch (err: any) {
      log('warn', `Correlation update failed: ${err.message}`);
    }
  }

  private checkCorrelationGuard(newPair: string): boolean {
    const maxCorrelated = this.settings.max_correlated_positions || 3;
    let correlatedCount = 0;

    for (const pos of this.positions) {
      const key1 = `${newPair}|${pos.pair}`;
      const key2 = `${pos.pair}|${newPair}`;
      const corr = this.correlationCache.get(key1) || this.correlationCache.get(key2);

      if (corr && Math.abs(corr) > 0.7) {
        correlatedCount++;
        log('info', `${newPair} correlated with ${pos.pair}: ${corr}`);
      }
    }

    return correlatedCount >= maxCorrelated;
  }

  // ============================================================
  // LOGGING & STATE
  // ============================================================
  private getTotalPortfolioValue(): number {
    const positionValue = this.positions.reduce((sum, p) => sum + p.position_value, 0);
    return this.settings.current_balance + positionValue;
  }

  private logSummary(): void {
    const closed = this.recentTrades.filter(t => t.status === 'closed');
    const totalPnl = closed.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const wins = closed.filter(t => (t.pnl || 0) > 0).length;
    const winRate = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : '0.0';
    const unrealizedPnl = this.positions.reduce((sum, p) => sum + p.unrealized_pnl, 0);

    log('info', [
      `Balance: $${this.settings.current_balance.toFixed(2)}`,
      `Positions: ${this.positions.length}`,
      `Trades: ${closed.length}`,
      `Win Rate: ${winRate}%`,
      `Realized PnL: $${totalPnl.toFixed(2)}`,
      `Unrealized PnL: $${unrealizedPnl.toFixed(2)}`,
      this.circuitBreaker.is_tripped ? '| 🛑 CIRCUIT BREAKER' : '',
    ].join(' | '));
  }

  private async loadState(): Promise<void> {
    try {
      const savedPositions = await loadPositions();
      if (savedPositions.length > 0) {
        this.positions = savedPositions;
        log('info', `Loaded ${savedPositions.length} open positions`);
      }
      const savedTrades = await loadRecentTrades();
      if (savedTrades.length > 0) {
        this.recentTrades = savedTrades;
        log('info', `Loaded ${savedTrades.length} recent trades`);
      }
      const savedSettings = await loadSettings();
      if (savedSettings) {
        this.settings.current_balance = savedSettings.current_balance;
        log('info', `Loaded settings — balance: $${savedSettings.current_balance.toFixed(2)}`);
      }
    } catch (err: any) {
      log('warn', `Load state failed: ${err.message} — starting fresh`);
    }
  }

  private async saveState(): Promise<void> {
    await savePositions(this.positions);
    await saveSettings(this.settings);
  }

  private async shutdown(): Promise<void> {
    log('info', 'Shutting down...');
    if (this.intervalId) clearInterval(this.intervalId);
    await this.saveState();
    log('info', 'State saved. Goodbye!');
    process.exit(0);
  }
}
