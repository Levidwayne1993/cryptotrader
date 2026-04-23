// ============================================================
// Main bot controller — the persistent server-side trading loop
// Replaces the client-side bot-trading.ts entirely
// ============================================================

import {
  StrategyType,
  BotSettings,
  BotPosition,
  BotTrade,
  AnalysisResult,
  TradeMode,
} from './types';
import { getStrategy } from './strategies';
import { KrakenExchange, getPair, getCoinIdFromPair } from './exchange';
import {
  analyzeCoin,
  fetchFearGreed,
  shouldExecuteTrade,
  checkExitConditions,
  updateTrailingStop,
} from './engine';
import {
  saveTrade,
  saveSignal,
  savePositions,
  loadPositions,
  loadRecentTrades,
  saveSettings,
  loadSettings,
} from './database';
import { log } from './logger';

// Default trading pairs
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
  private isRunning: boolean = false;
  private cycleCount: number = 0;

  constructor() {
    const mode = (process.env.TRADE_MODE || 'paper') as TradeMode;
    this.exchange = new KrakenExchange(mode);

    this.settings = {
      enabled: true,
      strategy: (process.env.STRATEGY || 'swing_trader') as StrategyType,
      mode,
      initial_balance: parseFloat(process.env.INITIAL_BALANCE || '1000'),
      current_balance: parseFloat(process.env.INITIAL_BALANCE || '1000'),
      selected_pairs: (process.env.TRADING_PAIRS || DEFAULT_PAIRS.join(','))
        .split(',')
        .map(s => s.trim()),
      max_daily_trades: parseInt(process.env.MAX_DAILY_TRADES || '30'),
      daily_loss_limit_percent: parseFloat(process.env.DAILY_LOSS_LIMIT || '5'),
    };
  }

  // -- Initialize and start
  async start(): Promise<void> {
    log('info', '========================================');
    log('info', '  CryptoBot Server Starting...');
    log('info', '========================================');
    log('info', `Mode: ${this.settings.mode.toUpperCase()}`);
    log('info', `Strategy: ${getStrategy(this.settings.strategy).name}`);
    log('info', `Pairs: ${this.settings.selected_pairs.join(', ')}`);
    log('info', `Balance: $${this.settings.initial_balance}`);
    log('info', '========================================');

    // Test exchange connection
    const connected = await this.exchange.testConnection();
    if (!connected) {
      log('error', 'Cannot connect to Kraken. Check API keys.');
      if (this.settings.mode === 'live') {
        log('error', 'LIVE mode requires valid API keys. Exiting.');
        process.exit(1);
      }
    }

    // Load state from database
    await this.loadState();

    // If in live mode, sync balance from exchange
    if (this.settings.mode === 'live') {
      const balance = await this.exchange.getBalance();
      if (balance.free > 0) {
        this.settings.current_balance = balance.free;
        log('info', `Live balance synced: $${balance.free.toFixed(2)}`);
      }
    }

    // Start the trading loop
    const strategy = getStrategy(this.settings.strategy);
    this.isRunning = true;
    log('info', `Starting trading loop — interval: ${strategy.intervalMs / 1000}s`);

    // Run first cycle immediately
    await this.runCycle();

    // Then run on interval
    this.intervalId = setInterval(async () => {
      await this.runCycle();
    }, strategy.intervalMs);

    // Handle graceful shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());

    log('info', 'Bot is running. Press Ctrl+C to stop.');
  }

  // -- Main analysis + trading cycle
  private async runCycle(): Promise<void> {
    this.cycleCount++;
    const strategy = getStrategy(this.settings.strategy);
    log('info', `--- Cycle #${this.cycleCount} [${strategy.shortName}] ---`);

    try {
      // 1. Fetch Fear & Greed Index
      const fearGreed = await fetchFearGreed();

      // 2. Fetch market data for all pairs
      const marketDataList = await this.exchange.getMultipleMarketData(
        this.settings.selected_pairs
      );

      if (marketDataList.length === 0) {
        log('warn', 'No market data received — skipping cycle');
        return;
      }

      // 3. Check exit conditions on existing positions
      for (const position of [...this.positions]) {
        const marketData = marketDataList.find((m) => m.pair === position.pair);
        if (!marketData) continue;

        // Update trailing stop
        const updatedPosition = updateTrailingStop(
          position,
          marketData.current_price,
          strategy
        );
        const posIdx = this.positions.findIndex((p) => p.pair === position.pair);
        if (posIdx >= 0) this.positions[posIdx] = updatedPosition;

        // Check stop loss / take profit / trailing stop
        const exitCheck = checkExitConditions(
          updatedPosition,
          marketData.current_price,
          strategy
        );
        if (exitCheck.shouldSell) {
          await this.executeSell(updatedPosition, marketData.current_price, exitCheck.reason, strategy);
        }
      }

      // 4. Analyze each pair for new entries
      const analyses: AnalysisResult[] = [];
      for (const marketData of marketDataList) {
        if (marketData.ohlcv.length < 30) {
          log('warn', `Insufficient data for ${marketData.pair} — need 30+ candles, got ${marketData.ohlcv.length}`);
          continue;
        }

        const analysis = analyzeCoin(marketData, fearGreed, strategy);
        analyses.push(analysis);

        // Log every coin's score (not just non-HOLD)
        log('info', `${analysis.pair}: score=${analysis.score} conf=${analysis.confidence}% -> ${analysis.action}`);

        // Log signals
        if (analysis.action !== 'HOLD') {
          log('signal', `${analysis.action} signal: ${analysis.symbol} @ $${analysis.current_price.toFixed(2)} | Score: ${analysis.score} | Confidence: ${analysis.confidence}%`);
        }

        // Save signal to database
        await saveSignal(analysis);

        // Check if we should execute
        const { execute, reason } = shouldExecuteTrade(
          analysis,
          this.settings,
          this.positions,
          this.recentTrades,
          strategy
        );

        if (!execute) {
          if (analysis.action !== 'HOLD') {
            log('info', `Skipped ${analysis.action} ${analysis.symbol}: ${reason}`);
          }
          continue;
        }

        // Execute the trade
        if (analysis.action === 'BUY') {
          await this.executeBuy(analysis, strategy);
        } else if (analysis.action === 'SELL') {
          const position = this.positions.find((p) => p.pair === analysis.pair);
          if (position) {
            await this.executeSell(position, analysis.current_price, 'Signal score below sell threshold', strategy);
          }
        }
      }

      // 5. Update position prices
      for (let i = 0; i < this.positions.length; i++) {
        const marketData = marketDataList.find((m) => m.pair === this.positions[i].pair);
        if (marketData) {
          this.positions[i].current_price = marketData.current_price;
          this.positions[i].position_value = marketData.current_price * this.positions[i].quantity;
          this.positions[i].unrealized_pnl =
            (marketData.current_price - this.positions[i].entry_price) * this.positions[i].quantity;
          this.positions[i].unrealized_pnl_percent =
            ((marketData.current_price - this.positions[i].entry_price) / this.positions[i].entry_price) * 100;
        }
      }

      // 6. Save state
      await this.saveState();

      // 7. Log summary
      this.logSummary();
    } catch (err: any) {
      log('error', `Cycle error: ${err.message}`);
    }
  }

  // -- Execute a buy
  private async executeBuy(
    analysis: AnalysisResult,
    strategy: ReturnType<typeof getStrategy>
  ): Promise<void> {
    // Calculate position size
    let positionSize =
      this.settings.current_balance * (strategy.riskParams.maxPositionPercent / 100);

    // DCA Smart sizing
    if (strategy.id === 'dca') {
      const baseDcaAmount = this.settings.current_balance * 0.05;
      if (analysis.indicators.fear_greed < 30) {
        positionSize = baseDcaAmount * 1.5;
      } else if (analysis.indicators.fear_greed > 70) {
        positionSize = baseDcaAmount * 0.5;
      } else {
        positionSize = baseDcaAmount;
      }
    }

    positionSize = Math.min(positionSize, this.settings.current_balance);
    if (positionSize < 5) {
      log('warn', `Position size too small ($${positionSize.toFixed(2)}) — skipping`);
      return;
    }

    // Place the order
    const result = await this.exchange.marketBuy(analysis.pair, positionSize);
    if (!result.success) {
      log('error', `Buy failed: ${result.error}`);
      return;
    }

    const price = result.price || analysis.current_price;
    const quantity = result.quantity || positionSize / price;

    // Update balance
    this.settings.current_balance -= positionSize;

    // Calculate stop loss and take profit
    const stopLossPrice =
      strategy.riskParams.stopLossPercent > 0
        ? price * (1 - strategy.riskParams.stopLossPercent / 100)
        : 0;
    const takeProfitPrice =
      strategy.riskParams.takeProfitPercent > 0
        ? price * (1 + strategy.riskParams.takeProfitPercent / 100)
        : 0;

    // Create position
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
        ? price * (1 - strategy.riskParams.trailingStopPercent / 100)
        : undefined,
      highest_price: price,
      strategy: strategy.id,
      opened_at: new Date().toISOString(),
      order_id: result.orderId,
    };

    this.positions.push(position);

    // Create trade record
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
    };

    this.recentTrades.push(trade);
    await saveTrade(trade);

    log('trade', `✅ BUY ${quantity.toFixed(8)} ${analysis.symbol} @ $${price.toFixed(2)} = $${positionSize.toFixed(2)} | SL: $${stopLossPrice.toFixed(2)} | TP: $${takeProfitPrice.toFixed(2)}`);
  }

  // -- Execute a sell
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
    const pnlPercent =
      ((exitPrice - position.entry_price) / position.entry_price) * 100;

    // Update balance
    this.settings.current_balance += exitPrice * position.quantity;

    // Remove position
    this.positions = this.positions.filter((p) => p.pair !== position.pair);

    // Create trade record
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
      reasoning: [`Sell reason: ${reason}`],
      status: 'closed',
      stop_loss_price: position.stop_loss_price,
      take_profit_price: position.take_profit_price,
      trailing_stop_price: position.trailing_stop_price,
      opened_at: position.opened_at,
      closed_at: new Date().toISOString(),
      order_id: result.orderId,
      mode: this.settings.mode,
    };

    this.recentTrades.push(trade);
    await saveTrade(trade);

    const pnlSign = pnl >= 0 ? '+' : '';
    const emoji = pnl >= 0 ? '💰' : '📉';
    log('trade', `${emoji} SELL ${position.quantity.toFixed(8)} ${position.symbol} @ $${exitPrice.toFixed(2)} | PnL: ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPercent.toFixed(2)}%) | Reason: ${reason}`);
  }

  // -- Log current status summary
  private logSummary(): void {
    const closedTrades = this.recentTrades.filter((t) => t.status === 'closed');
    const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const wins = closedTrades.filter((t) => (t.pnl || 0) > 0).length;
    const winRate =
      closedTrades.length > 0
        ? ((wins / closedTrades.length) * 100).toFixed(1)
        : '0.0';
    const unrealizedPnl = this.positions.reduce((sum, p) => sum + p.unrealized_pnl, 0);

    log('info', [
      `Balance: $${this.settings.current_balance.toFixed(2)}`,
      `Positions: ${this.positions.length}`,
      `Trades: ${closedTrades.length}`,
      `Win Rate: ${winRate}%`,
      `Realized PnL: $${totalPnl.toFixed(2)}`,
      `Unrealized PnL: $${unrealizedPnl.toFixed(2)}`,
    ].join(' | '));
  }

  // -- Load state from database
  private async loadState(): Promise<void> {
    try {
      const savedPositions = await loadPositions();
      if (savedPositions.length > 0) {
        this.positions = savedPositions;
        log('info', `Loaded ${savedPositions.length} open positions from database`);
      }

      const savedTrades = await loadRecentTrades();
      if (savedTrades.length > 0) {
        this.recentTrades = savedTrades;
        log('info', `Loaded ${savedTrades.length} recent trades from database`);
      }

      const savedSettings = await loadSettings();
      if (savedSettings) {
        // Preserve env-driven config but restore balance
        this.settings.current_balance = savedSettings.current_balance;
        log('info', `Loaded settings — balance: $${savedSettings.current_balance.toFixed(2)}`);
      }
    } catch (err: any) {
      log('warn', `Could not load state: ${err.message} — starting fresh`);
    }
  }

  // -- Save state to database
  private async saveState(): Promise<void> {
    await savePositions(this.positions);
    await saveSettings(this.settings);
  }

  // -- Graceful shutdown
  private async shutdown(): Promise<void> {
    log('info', 'Shutting down...');
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    await this.saveState();
    log('info', 'State saved. Goodbye!');
    process.exit(0);
  }
}
