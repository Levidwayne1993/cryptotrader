// ============================================================
// PROJECT: cryptotrader
// FILE: src/bot.ts
// DESCRIPTION: Main bot controller — PRO EDITION
//   Circuit breakers, correlation guard, Kelly sizing,
//   whale tracking, order book, multi-timeframe, alerts
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

  constructor() {
    const mode = (process.env.TRADE_MODE || 'paper') as TradeMode;
    this.exchange = new KrakenExchange(mode);

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
    log('info', '  CryptoBot PRO Server Starting...');
    log('info', '========================================');
    log('info', `Mode: ${this.settings.mode.toUpperCase()}`);
    log('info', `Strategy: ${getStrategy(this.settings.strategy).name}`);
    log('info', `Pairs: ${this.settings.selected_pairs.join(', ')}`);
    log('info', `Balance: $${this.settings.initial_balance}`);
    log('info', `Alerts: ${this.settings.alerts_enabled ? 'ON' : 'OFF'}`);
    log('info', `Whale Tracking: ${this.settings.whale_tracking_enabled ? 'ON' : 'OFF'}`);
    log('info', `Kelly Sizing: ${this.settings.kelly_sizing_enabled ? 'ON' : 'OFF'}`);
    log('info', `Correlation Guard: ${this.settings.correlation_guard_enabled ? 'ON' : 'OFF'}`);
    log('info', '========================================');

    const connected = await this.exchange.testConnection();
    if (!connected) {
      log('error', 'Cannot connect to Kraken.');
      if (this.settings.mode === 'live') { process.exit(1); }
    }

    await this.loadState();
    this.dailyStartBalance = this.settings.current_balance;

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
  // MAIN CYCLE
  // ============================================================
  private async runCycle(): Promise<void> {
    this.cycleCount++;
    const strategy = getStrategy(this.settings.strategy);
    log('info', `--- Cycle #${this.cycleCount} [${strategy.shortName}] ---`);

    try {
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
          log('debug', `Whale data fetch failed: ${err.message}`);
        }
      }

      // 6. Update correlation cache periodically (every 10 cycles)
      if (this.settings.correlation_guard_enabled &&
          this.cycleCount - this.lastCorrelationCheck >= 10) {
        await this.updateCorrelations();
        this.lastCorrelationCheck = this.cycleCount;
      }

      // 7. Check exits on existing positions
      for (const position of [...this.positions]) {
        const md = marketDataList.find(m => m.pair === position.pair);
        if (!md) continue;

        const updated = updateTrailingStop(position, md.current_price, strategy);
        const idx = this.positions.findIndex(p => p.pair === position.pair);
        if (idx >= 0) this.positions[idx] = updated;

        const exit = checkExitConditions(updated, md.current_price, strategy);
        if (exit.shouldSell) {
          await this.executeSell(updated, md.current_price, exit.reason, strategy);
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
          whaleData, orderBook, multiTfData
        );

        // Log every score
        log('info', `${analysis.pair}: score=${analysis.score} conf=${analysis.confidence}% -> ${analysis.action}`);

        if (analysis.action !== 'HOLD') {
          log('signal', `${analysis.action} signal: ${analysis.symbol} @ $${analysis.current_price.toFixed(2)} | Score: ${analysis.score} | Conf: ${analysis.confidence}%`);
        }

        await saveSignal(analysis);

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

      // 9. Update positions
      for (let i = 0; i < this.positions.length; i++) {
        const md = marketDataList.find(m => m.pair === this.positions[i].pair);
        if (md) {
          this.positions[i].current_price = md.current_price;
          this.positions[i].position_value = md.current_price * this.positions[i].quantity;
          this.positions[i].unrealized_pnl =
            (md.current_price - this.positions[i].entry_price) * this.positions[i].quantity;
          this.positions[i].unrealized_pnl_percent =
            ((md.current_price - this.positions[i].entry_price) / this.positions[i].entry_price) * 100;
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
  // EXECUTE BUY — with Kelly sizing + ATR stops
  // ============================================================
  private async executeBuy(
    analysis: AnalysisResult,
    strategy: ReturnType<typeof getStrategy>
  ): Promise<void> {
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
      // DCA or fallback sizing
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

    const result = await this.exchange.marketBuy(analysis.pair, positionSize);
    if (!result.success) {
      log('error', `Buy failed: ${result.error}`);
      return;
    }

    const price = result.price || analysis.current_price;
    const quantity = result.quantity || positionSize / price;
    this.settings.current_balance -= positionSize;

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

    log('trade', `BUY ${quantity.toFixed(8)} ${analysis.symbol} @ $${price.toFixed(2)} = $${positionSize.toFixed(2)} | SL: $${stopLossPrice.toFixed(2)} | TP: $${takeProfitPrice.toFixed(2)}`);

    // Send alert
    await this.alertManager.tradeOpened({
      pair: analysis.pair, price, quantity, positionSize,
      score: analysis.score, confidence: analysis.confidence,
      stopLoss: stopLossPrice, takeProfit: takeProfitPrice,
      strategy: strategy.id, kellyFraction,
    });
  }

  // ============================================================
  // EXECUTE SELL
  // ============================================================
  private async executeSell(
    position: BotPosition,
    currentPrice: number,
    reason: string,
    strategy: ReturnType<typeof getStrategy>
  ): Promise<void> {
    const result = await this.exchange.marketSell(position.pair, position.quantity);
    if (!result.success) {
      log('error', `Sell failed: ${result.error}`);
      return;
    }

    const exitPrice = result.price || currentPrice;
    const pnl = (exitPrice - position.entry_price) * position.quantity;
    const pnlPercent = ((exitPrice - position.entry_price) / position.entry_price) * 100;

    this.settings.current_balance += exitPrice * position.quantity;
    this.positions = this.positions.filter(p => p.pair !== position.pair);

    // Update circuit breaker state
    if (pnl < 0) {
      this.circuitBreaker.consecutive_losses++;
      if (this.circuitBreaker.consecutive_losses >= 5) {
        this.tripCircuitBreaker(`${this.circuitBreaker.consecutive_losses} consecutive losses`);
      }
    } else {
      this.circuitBreaker.consecutive_losses = 0;
    }
    this.circuitBreaker.trades_today++;

    // Calculate hold time
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
      reasoning: [`Exit: ${reason}`],
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
    log('trade', `${emoji} SELL ${position.quantity.toFixed(8)} ${position.symbol} @ $${exitPrice.toFixed(2)} | PnL: ${sign}$${pnl.toFixed(2)} (${sign}${pnlPercent.toFixed(2)}%) | ${reason} | Hold: ${holdTime}`);

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
    const dailyLossPercent =
      ((this.dailyStartBalance - this.settings.current_balance) / this.dailyStartBalance) * 100;
    this.circuitBreaker.daily_loss_percent = dailyLossPercent;

    if (dailyLossPercent >= this.settings.daily_loss_limit_percent) {
      this.tripCircuitBreaker(`Daily loss limit hit: ${dailyLossPercent.toFixed(2)}%`);
    }
  }

  private tripCircuitBreaker(reason: string): void {
    this.circuitBreaker.is_tripped = true;
    this.circuitBreaker.reason = reason;
    this.circuitBreaker.tripped_at = new Date().toISOString();
    // Resume in 2 hours
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
      log('debug', `Correlation update failed: ${err.message}`);
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
        log('debug', `${newPair} correlated with ${pos.pair}: ${corr}`);
      }
    }

    return correlatedCount >= maxCorrelated;
  }

  // ============================================================
  // LOGGING & STATE
  // ============================================================
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
