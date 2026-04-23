// ============================================================
// PROJECT: cryptotrader
// FILE: src/backtest.ts (NEW FILE)
// DESCRIPTION: Backtesting Engine — replay historical data
//   through your strategies to validate performance before
//   risking real money. Fee-aware, with full analytics.
// ============================================================

import { StrategyType, BotPosition, BotTrade, AnalysisResult } from './types';
import { getStrategy } from './strategies';
import { KrakenExchange, getCoinIdFromPair } from './exchange';
import { analyzeCoin, fetchFearGreed, shouldExecuteTrade, checkExitConditions, updateTrailingStop } from './engine';
import { smartPositionSize } from './position-sizing';
import { calculateATR } from './indicators';
import { log } from './logger';

// ============================================================
// BACKTEST CONFIG
// ============================================================
export interface BacktestConfig {
  strategy: StrategyType;
  pairs: string[];
  startDate: Date;
  endDate: Date;
  initialBalance: number;
  takerFeeRate: number;      // e.g. 0.004 (0.40%)
  makerFeeRate: number;      // e.g. 0.0025 (0.25%)
  useLimitOrders: boolean;   // true = maker fees, false = taker fees
  minTakeProfitPercent: number; // minimum TP floor (e.g. 2.0)
  slippagePercent: number;   // simulated slippage (e.g. 0.1 = 0.1%)
}

// ============================================================
// BACKTEST RESULT
// ============================================================
export interface BacktestResult {
  config: BacktestConfig;
  strategyName: string;

  // Performance
  finalBalance: number;
  totalReturn: number;
  totalReturnPercent: number;
  annualizedReturn: number;

  // Trade Stats
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  profitFactor: number;
  expectancy: number;

  // Risk Metrics
  maxDrawdown: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;

  // Fee Analysis
  totalFeessPaid: number;
  avgFeePerTrade: number;

  // Equity Curve
  equityCurve: { timestamp: number; balance: number }[];

  // Per-Pair Breakdown
  pairBreakdown: {
    pair: string;
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    avgPnl: number;
  }[];

  // Timing
  durationDays: number;
  tradesPerDay: number;
  startDate: string;
  endDate: string;
}

// ============================================================
// BACKTESTING ENGINE
// ============================================================
export class BacktestEngine {
  private exchange: KrakenExchange;
  private config: BacktestConfig;
  private balance: number;
  private positions: BotPosition[] = [];
  private closedTrades: BotTrade[] = [];
  private equityCurve: { timestamp: number; balance: number }[] = [];
  private peakBalance: number;
  private maxDrawdown: number = 0;
  private maxDrawdownPercent: number = 0;
  private dailyReturns: number[] = [];
  private totalFees: number = 0;

  constructor(config: BacktestConfig) {
    this.config = config;
    this.balance = config.initialBalance;
    this.peakBalance = config.initialBalance;
    this.exchange = new KrakenExchange('paper');
  }

  // ============================================================
  // RUN BACKTEST
  // ============================================================
  async run(): Promise<BacktestResult> {
    const strategy = getStrategy(this.config.strategy);
    const feeRate = this.config.useLimitOrders
      ? this.config.makerFeeRate
      : this.config.takerFeeRate;

    log('info', '========================================');
    log('info', '  BACKTESTING ENGINE');
    log('info', '========================================');
    log('info', `Strategy: ${strategy.name}`);
    log('info', `Pairs: ${this.config.pairs.join(', ')}`);
    log('info', `Period: ${this.config.startDate.toISOString().split('T')[0]} to ${this.config.endDate.toISOString().split('T')[0]}`);
    log('info', `Initial Balance: $${this.config.initialBalance.toFixed(2)}`);
    log('info', `Fee Rate: ${(feeRate * 100).toFixed(2)}% per trade`);
    log('info', `Min TP Floor: ${this.config.minTakeProfitPercent}%`);
    log('info', '========================================');

    // Fetch historical data for all pairs
    log('info', 'Fetching historical data from Kraken...');
    const historicalData = await this.fetchHistoricalData();

    if (historicalData.size === 0) {
      throw new Error('No historical data fetched — cannot run backtest');
    }

    // Determine the number of candles to walk through
    const firstPairData = historicalData.values().next().value;
    if (!firstPairData || firstPairData.length === 0) {
      throw new Error('Empty historical data');
    }
    const totalCandles = firstPairData.length;
    log('info', `Loaded ${totalCandles} candles per pair. Starting simulation...`);

    // Fetch Fear & Greed (use current — historical not available for free)
    let fearGreed = 50; // default neutral
    try {
      fearGreed = await fetchFearGreed();
    } catch {
      log('warn', 'Fear & Greed fetch failed — using neutral (50)');
    }

    // Walk forward candle by candle
    const windowSize = Math.max(50, 30); // minimum candles for indicators
    let lastDayBalance = this.balance;
    let lastDay = -1;
    let cycleCount = 0;

    for (let i = windowSize; i < totalCandles; i++) {
      cycleCount++;

      // Track daily returns for Sharpe/Sortino
      const currentTimestamp = firstPairData[i][0];
      const currentDate = new Date(currentTimestamp);
      const dayOfYear = Math.floor(currentTimestamp / (24 * 60 * 60 * 1000));

      if (dayOfYear !== lastDay && lastDay !== -1) {
        const dailyReturn = (this.balance - lastDayBalance) / lastDayBalance;
        this.dailyReturns.push(dailyReturn);
        lastDayBalance = this.balance;
      }
      lastDay = dayOfYear;

      // Record equity curve every 10 candles to keep data manageable
      if (i % 10 === 0) {
        const totalValue = this.getTotalValue(historicalData, i);
        this.equityCurve.push({ timestamp: currentTimestamp, balance: totalValue });

        // Track max drawdown
        if (totalValue > this.peakBalance) {
          this.peakBalance = totalValue;
        }
        const drawdown = this.peakBalance - totalValue;
        const drawdownPercent = (drawdown / this.peakBalance) * 100;
        if (drawdown > this.maxDrawdown) {
          this.maxDrawdown = drawdown;
          this.maxDrawdownPercent = drawdownPercent;
        }
      }

      // Check exits on existing positions
      for (const position of [...this.positions]) {
        const pairData = historicalData.get(position.pair);
        if (!pairData || !pairData[i]) continue;

        const currentPrice = pairData[i][4]; // close price
        const highPrice = pairData[i][2];    // high
        const lowPrice = pairData[i][3];     // low

        // Check stop loss hit (using low of candle)
        if (position.stop_loss_price > 0 && lowPrice <= position.stop_loss_price) {
          this.executeBacktestSell(position, position.stop_loss_price, 'Stop Loss', feeRate);
          continue;
        }

        // Check take profit hit (using high of candle)
        if (position.take_profit_price > 0 && highPrice >= position.take_profit_price) {
          this.executeBacktestSell(position, position.take_profit_price, 'Take Profit', feeRate);
          continue;
        }

        // Update trailing stop
        const updated = updateTrailingStop(position, currentPrice, strategy);
        const idx = this.positions.findIndex(p => p.pair === position.pair);
        if (idx >= 0) this.positions[idx] = updated;

        // Check trailing stop hit
        if (updated.trailing_stop_price && lowPrice <= updated.trailing_stop_price) {
          this.executeBacktestSell(updated, updated.trailing_stop_price, 'Trailing Stop', feeRate);
          continue;
        }

        // Update position value
        if (idx >= 0) {
          this.positions[idx].current_price = currentPrice;
          this.positions[idx].position_value = currentPrice * position.quantity;
        }
      }

      // Analyze each pair for new entries (every N candles based on strategy interval)
      const candleIntervalMs = this.getCandleIntervalMs(strategy.primaryTimeframe || '5m');
      const strategyIntervalCandles = Math.max(1, Math.floor(strategy.intervalMs / candleIntervalMs));

      if (i % strategyIntervalCandles !== 0) continue;

      for (const pair of this.config.pairs) {
        const pairData = historicalData.get(pair);
        if (!pairData) continue;

        // Build OHLCV window for analysis
        const ohlcvWindow = pairData.slice(Math.max(0, i - windowSize), i + 1);
        if (ohlcvWindow.length < 30) continue;

        const currentCandle = pairData[i];
        const currentPrice = currentCandle[4]; // close

        // Build market data object matching what analyzeCoin expects
        const marketData = {
          pair,
          symbol: pair.split('/')[0],
          current_price: currentPrice,
          bid: currentPrice * 0.9999,
          ask: currentPrice * 1.0001,
          spread: currentPrice * 0.0002,
          volume_24h: currentCandle[5],
          price_change_24h: 0,
          ohlcv: ohlcvWindow.map((c: number[]) => ({
            timestamp: c[0],
            open: c[1],
            high: c[2],
            low: c[3],
            close: c[4],
            volume: c[5],
          })),
        };

        // Run analysis
        const analysis = analyzeCoin(marketData, fearGreed, strategy);

        // Build mock settings for shouldExecuteTrade
        const mockSettings = {
          enabled: true,
          strategy: this.config.strategy,
          mode: 'paper' as const,
          initial_balance: this.config.initialBalance,
          current_balance: this.balance,
          selected_pairs: this.config.pairs,
          max_daily_trades: 30,
          daily_loss_limit_percent: 5,
          alerts_enabled: false,
          correlation_guard_enabled: false,
          max_correlated_positions: 3,
          kelly_sizing_enabled: true,
          whale_tracking_enabled: false,
        };

        const { execute } = shouldExecuteTrade(
          analysis, mockSettings, this.positions, this.closedTrades, strategy
        );

        if (!execute) continue;

        if (analysis.action === 'BUY') {
          this.executeBacktestBuy(analysis, strategy, feeRate);
        } else if (analysis.action === 'SELL') {
          const pos = this.positions.find(p => p.pair === analysis.pair);
          if (pos) {
            this.executeBacktestSell(pos, analysis.current_price, 'Sell Signal', feeRate);
          }
        }
      }

      // Progress logging every 500 candles
      if (cycleCount % 500 === 0) {
        const progress = ((i - windowSize) / (totalCandles - windowSize) * 100).toFixed(1);
        const totalValue = this.getTotalValue(historicalData, i);
        log('info', `Progress: ${progress}% | Balance: $${totalValue.toFixed(2)} | Trades: ${this.closedTrades.length} | Positions: ${this.positions.length}`);
      }
    }

    // Close any remaining positions at the last price
    for (const position of [...this.positions]) {
      const pairData = historicalData.get(position.pair);
      if (pairData && pairData.length > 0) {
        const lastPrice = pairData[pairData.length - 1][4];
        this.executeBacktestSell(position, lastPrice, 'End of Backtest', feeRate);
      }
    }

    // Build and return results
    return this.buildResults();
  }

  // ============================================================
  // FETCH HISTORICAL DATA
  // ============================================================
  private async fetchHistoricalData(): Promise<Map<string, number[][]>> {
    const data = new Map<string, number[][]>();
    const strategy = getStrategy(this.config.strategy);
    const timeframe = strategy.primaryTimeframe || '5m';

    for (const pair of this.config.pairs) {
      try {
        log('info', `Fetching ${pair} ${timeframe} data...`);

        // Kraken OHLCV endpoint with since parameter
        const krakenPair = this.mapToKrakenPair(pair);
        const interval = this.timeframeToMinutes(timeframe);
        const since = Math.floor(this.config.startDate.getTime() / 1000);

        // Fetch in chunks (Kraken returns max 720 candles per request)
        let allCandles: number[][] = [];
        let fetchSince = since;
        const endTimestamp = Math.floor(this.config.endDate.getTime() / 1000);

        while (fetchSince < endTimestamp) {
          const url = `https://api.kraken.com/0/public/OHLC?pair=${krakenPair}&interval=${interval}&since=${fetchSince}`;
          const response = await fetch(url);
          const json: any = await response.json();

          if (json.error && json.error.length > 0) {
            log('warn', `Kraken API error for ${pair}: ${json.error.join(', ')}`);
            break;
          }

          const resultKey = Object.keys(json.result).find(k => k !== 'last');
          if (!resultKey || !json.result[resultKey]) break;

          const candles = json.result[resultKey].map((c: any) => [
            c[0] * 1000,           // timestamp (ms)
            parseFloat(c[1]),       // open
            parseFloat(c[2]),       // high
            parseFloat(c[3]),       // low
            parseFloat(c[4]),       // close
            parseFloat(c[6]),       // volume
          ]);

          if (candles.length === 0) break;

          allCandles = allCandles.concat(candles);
          fetchSince = candles[candles.length - 1][0] / 1000 + 1;

          // Rate limit
          await new Promise(r => setTimeout(r, 1500));
        }

        // Filter to date range
        const startMs = this.config.startDate.getTime();
        const endMs = this.config.endDate.getTime();
        allCandles = allCandles.filter(c => c[0] >= startMs && c[0] <= endMs);

        if (allCandles.length > 0) {
          data.set(pair, allCandles);
          log('info', `${pair}: loaded ${allCandles.length} candles`);
        } else {
          log('warn', `${pair}: no data in date range`);
        }
      } catch (err: any) {
        log('error', `Failed to fetch ${pair}: ${err.message}`);
      }
    }

    return data;
  }

  // ============================================================
  // SIMULATE BUY
  // ============================================================
  private executeBacktestBuy(
    analysis: AnalysisResult,
    strategy: ReturnType<typeof getStrategy>,
    feeRate: number
  ): void {
    // Position sizing
    let positionSize: number;
    const atrValue = analysis.indicator_details?.atr?.atr || 0;

    if (strategy.riskParams.useKellySizing) {
      const sizing = smartPositionSize(
        this.closedTrades,
        analysis.current_price,
        atrValue,
        this.balance,
        strategy.riskParams.riskPerTradePercent || 2,
        strategy.riskParams.maxKellyPercent || 20,
        strategy.riskParams.atrStopMultiplier || 2.0
      );
      positionSize = sizing.position_size_usd;
    } else {
      positionSize = this.balance * (strategy.riskParams.maxPositionPercent / 100);
    }

    positionSize = Math.min(positionSize, this.balance);
    if (positionSize < 5) return;

    // Apply slippage
    const slippage = 1 + (this.config.slippagePercent / 100);
    const entryPrice = analysis.current_price * slippage;
    const quantity = positionSize / entryPrice;

    // Deduct fee
    const buyFee = positionSize * feeRate;
    this.balance -= (positionSize + buyFee);
    this.totalFees += buyFee;

    // Calculate stops
    let stopLossPrice = 0;
    let takeProfitPrice = 0;

    if (strategy.riskParams.useAtrStops && atrValue > 0) {
      const atrMult = strategy.riskParams.atrStopMultiplier || 2;
      stopLossPrice = entryPrice - (atrValue * atrMult);
      takeProfitPrice = entryPrice + (atrValue * atrMult * 2);
    } else {
      if (strategy.riskParams.stopLossPercent > 0)
        stopLossPrice = entryPrice * (1 - strategy.riskParams.stopLossPercent / 100);
      if (strategy.riskParams.takeProfitPercent > 0)
        takeProfitPrice = entryPrice * (1 + strategy.riskParams.takeProfitPercent / 100);
    }

    // Enforce minimum TP floor
    const minTpPrice = entryPrice * (1 + this.config.minTakeProfitPercent / 100);
    if (takeProfitPrice > 0 && takeProfitPrice < minTpPrice) {
      takeProfitPrice = minTpPrice;
    }

    const position: BotPosition = {
      coin_id: getCoinIdFromPair(analysis.pair),
      symbol: analysis.symbol,
      pair: analysis.pair,
      entry_price: entryPrice,
      current_price: entryPrice,
      quantity,
      position_value: positionSize,
      unrealized_pnl: 0,
      unrealized_pnl_percent: 0,
      stop_loss_price: stopLossPrice,
      take_profit_price: takeProfitPrice,
      trailing_stop_price: strategy.riskParams.trailingStop
        ? entryPrice * (1 - strategy.riskParams.trailingStopPercent / 100)
        : undefined,
      highest_price: entryPrice,
      strategy: strategy.id,
      opened_at: new Date().toISOString(),
    };

    this.positions.push(position);
  }

  // ============================================================
  // SIMULATE SELL
  // ============================================================
  private executeBacktestSell(
    position: BotPosition,
    exitPrice: number,
    reason: string,
    feeRate: number
  ): void {
    // Apply slippage on sells (price slightly worse)
    const slippage = 1 - (this.config.slippagePercent / 100);
    const adjustedExitPrice = exitPrice * slippage;

    // Calculate fee-aware P&L
    const grossPnl = (adjustedExitPrice - position.entry_price) * position.quantity;
    const buyFee = position.entry_price * position.quantity * feeRate;
    const sellFee = adjustedExitPrice * position.quantity * feeRate;
    const totalFees = buyFee + sellFee;
    const netPnl = grossPnl - totalFees;

    // Credit balance (sell fee already deducted)
    const sellProceeds = (adjustedExitPrice * position.quantity) - sellFee;
    this.balance += sellProceeds;
    this.totalFees += sellFee;

    // Remove position
    this.positions = this.positions.filter(p => p.pair !== position.pair);

    // Record trade
    const trade: BotTrade = {
      coin_id: position.coin_id,
      symbol: position.symbol,
      pair: position.pair,
      action: 'SELL',
      strategy: position.strategy,
      entry_price: position.entry_price,
      exit_price: adjustedExitPrice,
      quantity: position.quantity,
      position_value: adjustedExitPrice * position.quantity,
      pnl: netPnl,
      pnl_percent: (netPnl / (position.entry_price * position.quantity)) * 100,
      score: 0,
      confidence: 0,
      reasoning: [reason],
      status: 'closed',
      stop_loss_price: position.stop_loss_price,
      take_profit_price: position.take_profit_price,
      opened_at: position.opened_at,
      closed_at: new Date().toISOString(),
      mode: 'paper',
      exit_reason: reason,
    };

    this.closedTrades.push(trade);
  }

  // ============================================================
  // BUILD RESULTS
  // ============================================================
  private buildResults(): BacktestResult {
    const strategy = getStrategy(this.config.strategy);
    const durationMs = this.config.endDate.getTime() - this.config.startDate.getTime();
    const durationDays = durationMs / (1000 * 60 * 60 * 24);

    const wins = this.closedTrades.filter(t => (t.pnl || 0) > 0);
    const losses = this.closedTrades.filter(t => (t.pnl || 0) <= 0);

    const totalReturn = this.balance - this.config.initialBalance;
    const totalReturnPercent = (totalReturn / this.config.initialBalance) * 100;

    const avgWin = wins.length > 0
      ? wins.reduce((s, t) => s + (t.pnl || 0), 0) / wins.length : 0;
    const avgLoss = losses.length > 0
      ? Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0) / losses.length) : 0;

    const grossProfit = wins.reduce((s, t) => s + (t.pnl || 0), 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    const expectancy = this.closedTrades.length > 0
      ? this.closedTrades.reduce((s, t) => s + (t.pnl || 0), 0) / this.closedTrades.length : 0;

    // Consecutive wins/losses
    let maxConsWins = 0, maxConsLosses = 0, consWins = 0, consLosses = 0;
    for (const t of this.closedTrades) {
      if ((t.pnl || 0) > 0) {
        consWins++; consLosses = 0;
        maxConsWins = Math.max(maxConsWins, consWins);
      } else {
        consLosses++; consWins = 0;
        maxConsLosses = Math.max(maxConsLosses, consLosses);
      }
    }

    // Sharpe Ratio (annualized, assuming 365 trading days for crypto)
    const avgDailyReturn = this.dailyReturns.length > 0
      ? this.dailyReturns.reduce((a, b) => a + b, 0) / this.dailyReturns.length : 0;
    const stdDailyReturn = this.dailyReturns.length > 1
      ? Math.sqrt(this.dailyReturns.reduce((s, r) => s + (r - avgDailyReturn) ** 2, 0) / (this.dailyReturns.length - 1)) : 1;
    const sharpeRatio = stdDailyReturn > 0
      ? (avgDailyReturn / stdDailyReturn) * Math.sqrt(365) : 0;

    // Sortino Ratio (only downside deviation)
    const downsideReturns = this.dailyReturns.filter(r => r < 0);
    const downsideDev = downsideReturns.length > 1
      ? Math.sqrt(downsideReturns.reduce((s, r) => s + r ** 2, 0) / downsideReturns.length) : 1;
    const sortinoRatio = downsideDev > 0
      ? (avgDailyReturn / downsideDev) * Math.sqrt(365) : 0;

    // Calmar Ratio
    const annualizedReturn = durationDays > 0
      ? ((this.balance / this.config.initialBalance) ** (365 / durationDays) - 1) * 100 : 0;
    const calmarRatio = this.maxDrawdownPercent > 0
      ? annualizedReturn / this.maxDrawdownPercent : 0;

    // Per-pair breakdown
    const pairMap = new Map<string, { trades: number; wins: number; losses: number; pnl: number }>();
    for (const t of this.closedTrades) {
      const entry = pairMap.get(t.pair) || { trades: 0, wins: 0, losses: 0, pnl: 0 };
      entry.trades++;
      if ((t.pnl || 0) > 0) entry.wins++;
      else entry.losses++;
      entry.pnl += t.pnl || 0;
      pairMap.set(t.pair, entry);
    }

    const pairBreakdown = Array.from(pairMap.entries()).map(([pair, stats]) => ({
      pair,
      trades: stats.trades,
      wins: stats.wins,
      losses: stats.losses,
      winRate: stats.trades > 0 ? (stats.wins / stats.trades) * 100 : 0,
      totalPnl: stats.pnl,
      avgPnl: stats.trades > 0 ? stats.pnl / stats.trades : 0,
    })).sort((a, b) => b.totalPnl - a.totalPnl);

    // Largest win/loss
    const pnls = this.closedTrades.map(t => t.pnl || 0);
    const largestWin = pnls.length > 0 ? Math.max(...pnls) : 0;
    const largestLoss = pnls.length > 0 ? Math.min(...pnls) : 0;

    return {
      config: this.config,
      strategyName: strategy.name,
      finalBalance: this.balance,
      totalReturn,
      totalReturnPercent,
      annualizedReturn,
      totalTrades: this.closedTrades.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate: this.closedTrades.length > 0 ? (wins.length / this.closedTrades.length) * 100 : 0,
      avgWin,
      avgLoss,
      largestWin,
      largestLoss,
      profitFactor,
      expectancy,
      maxDrawdown: this.maxDrawdown,
      maxDrawdownPercent: this.maxDrawdownPercent,
      sharpeRatio,
      sortinoRatio,
      calmarRatio,
      maxConsecutiveWins: maxConsWins,
      maxConsecutiveLosses: maxConsLosses,
      totalFeessPaid: this.totalFees,
      avgFeePerTrade: this.closedTrades.length > 0 ? this.totalFees / this.closedTrades.length : 0,
      equityCurve: this.equityCurve,
      pairBreakdown,
      durationDays,
      tradesPerDay: durationDays > 0 ? this.closedTrades.length / durationDays : 0,
      startDate: this.config.startDate.toISOString().split('T')[0],
      endDate: this.config.endDate.toISOString().split('T')[0],
    };
  }

  // ============================================================
  // PRINT REPORT
  // ============================================================
  static printReport(result: BacktestResult): void {
    const line = '='.repeat(60);
    console.log('\n' + line);
    console.log('  BACKTEST RESULTS');
    console.log(line);
    console.log(`  Strategy:       ${result.strategyName}`);
    console.log(`  Period:         ${result.startDate} to ${result.endDate} (${result.durationDays.toFixed(0)} days)`);
    console.log(`  Initial:        $${result.config.initialBalance.toFixed(2)}`);
    console.log(`  Final:          $${result.finalBalance.toFixed(2)}`);
    console.log(line);

    console.log('\n  PERFORMANCE');
    console.log(`  Total Return:   $${result.totalReturn.toFixed(2)} (${result.totalReturnPercent.toFixed(2)}%)`);
    console.log(`  Annualized:     ${result.annualizedReturn.toFixed(2)}%`);
    console.log(`  Profit Factor:  ${result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2)}`);
    console.log(`  Expectancy:     $${result.expectancy.toFixed(2)} per trade`);

    console.log('\n  TRADES');
    console.log(`  Total:          ${result.totalTrades}`);
    console.log(`  Winners:        ${result.winningTrades} (${result.winRate.toFixed(1)}%)`);
    console.log(`  Losers:         ${result.losingTrades}`);
    console.log(`  Avg Win:        $${result.avgWin.toFixed(2)}`);
    console.log(`  Avg Loss:       $${result.avgLoss.toFixed(2)}`);
    console.log(`  Largest Win:    $${result.largestWin.toFixed(2)}`);
    console.log(`  Largest Loss:   $${result.largestLoss.toFixed(2)}`);
    console.log(`  Trades/Day:     ${result.tradesPerDay.toFixed(1)}`);
    console.log(`  Max Cons. Wins: ${result.maxConsecutiveWins}`);
    console.log(`  Max Cons. Loss: ${result.maxConsecutiveLosses}`);

    console.log('\n  RISK METRICS');
    console.log(`  Max Drawdown:   $${result.maxDrawdown.toFixed(2)} (${result.maxDrawdownPercent.toFixed(2)}%)`);
    console.log(`  Sharpe Ratio:   ${result.sharpeRatio.toFixed(2)}`);
    console.log(`  Sortino Ratio:  ${result.sortinoRatio.toFixed(2)}`);
    console.log(`  Calmar Ratio:   ${result.calmarRatio.toFixed(2)}`);

    console.log('\n  FEES');
    console.log(`  Total Fees:     $${result.totalFeessPaid.toFixed(2)}`);
    console.log(`  Avg Fee/Trade:  $${result.avgFeePerTrade.toFixed(4)}`);
    console.log(`  Fee Rate:       ${(result.config.useLimitOrders ? result.config.makerFeeRate : result.config.takerFeeRate) * 100}%`);

    if (result.pairBreakdown.length > 0) {
      console.log('\n  PER-PAIR BREAKDOWN');
      console.log('  ' + '-'.repeat(56));
      console.log('  Pair          Trades  Wins  WR%     P&L      Avg');
      console.log('  ' + '-'.repeat(56));
      for (const p of result.pairBreakdown) {
        console.log(`  ${p.pair.padEnd(14)} ${String(p.trades).padStart(5)}  ${String(p.wins).padStart(4)}  ${p.winRate.toFixed(1).padStart(5)}%  $${p.totalPnl.toFixed(2).padStart(8)}  $${p.avgPnl.toFixed(2).padStart(7)}`);
      }
    }

    console.log('\n' + line);

    // Verdict
    if (result.totalReturnPercent > 10 && result.sharpeRatio > 1 && result.maxDrawdownPercent < 15) {
      console.log('  ✅ VERDICT: Strategy looks STRONG — consider live testing');
    } else if (result.totalReturnPercent > 0 && result.sharpeRatio > 0.5) {
      console.log('  ⚠️ VERDICT: Strategy is MARGINAL — needs optimization');
    } else {
      console.log('  ❌ VERDICT: Strategy is UNPROFITABLE — do NOT go live');
    }
    console.log(line + '\n');
  }

  // ============================================================
  // HELPER METHODS
  // ============================================================
  private getTotalValue(data: Map<string, number[][]>, candleIndex: number): number {
    let posValue = 0;
    for (const pos of this.positions) {
      const pairData = data.get(pos.pair);
      if (pairData && pairData[candleIndex]) {
        posValue += pairData[candleIndex][4] * pos.quantity;
      } else {
        posValue += pos.position_value;
      }
    }
    return this.balance + posValue;
  }

  private mapToKrakenPair(pair: string): string {
    const map: Record<string, string> = {
      'BTC/USD': 'XXBTZUSD', 'ETH/USD': 'XETHZUSD',
      'SOL/USD': 'SOLUSD', 'DOGE/USD': 'XDGUSD',
      'ADA/USD': 'ADAUSD', 'XRP/USD': 'XXRPZUSD',
      'DOT/USD': 'DOTUSD', 'AVAX/USD': 'AVAXUSD',
      'LINK/USD': 'LINKUSD',
    };
    return map[pair] || pair.replace('/', '');
  }

  private timeframeToMinutes(tf: string): number {
    const map: Record<string, number> = {
      '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440,
    };
    return map[tf] || 5;
  }

  private getCandleIntervalMs(tf: string): number {
    return this.timeframeToMinutes(tf) * 60 * 1000;
  }
}
