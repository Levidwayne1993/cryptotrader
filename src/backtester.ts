// ============================================================
// PROJECT: cryptotrader
// FILE: src/backtester.ts  (NEW FILE)
// DESCRIPTION: Historical backtesting engine
//   Test strategies against past data before risking real money
// ============================================================

import {
  BacktestConfig, BacktestResult, BotTrade, OHLCV,
  MarketData, StrategyConfig, BotPosition, BotSettings,
} from './types';
import { getStrategy } from './strategies';
import { KrakenExchange } from './exchange';
import {
  analyzeCoin, shouldExecuteTrade, checkExitConditions,
  updateTrailingStop,
} from './engine';
import { log } from './logger';

export class Backtester {
  private exchange: KrakenExchange;

  constructor() {
    this.exchange = new KrakenExchange('paper');
  }

  async run(config: BacktestConfig): Promise<BacktestResult> {
    const strategy = getStrategy(config.strategy);
    log('info', '========================================');
    log('info', '  BACKTESTER STARTING');
    log('info', `  Strategy: ${strategy.name}`);
    log('info', `  Pairs: ${config.pairs.join(', ')}`);
    log('info', `  Period: ${config.startDate} to ${config.endDate}`);
    log('info', `  Balance: $${config.initialBalance}`);
    log('info', '========================================');

    let balance = config.initialBalance;
    const positions: BotPosition[] = [];
    const allTrades: BotTrade[] = [];
    const equityCurve: Array<{ timestamp: number; balance: number }> = [];
    let maxBalance = balance;
    let maxDrawdown = 0;

    // Fetch historical data for all pairs
    const historicalData: Record<string, OHLCV[]> = {};
    for (const pair of config.pairs) {
      const candles = await this.exchange.getOHLCV(
        pair,
        config.timeframe || '1h',
        720  // ~30 days of hourly data
      );
      if (candles.length > 0) {
        historicalData[pair] = candles;
        log('info', `Loaded ${candles.length} candles for ${pair}`);
      }
    }

    if (Object.keys(historicalData).length === 0) {
      log('error', 'No historical data available');
      return this.emptyResult(config);
    }

    // Find the common time range
    const minCandles = Math.min(
      ...Object.values(historicalData).map(c => c.length)
    );

    // Simulate candle by candle
    const windowSize = 50;  // lookback for indicators

    for (let i = windowSize; i < minCandles; i++) {
      const timestamp = Object.values(historicalData)[0][i].timestamp;

      // Check exits first
      for (const pos of [...positions]) {
        const candles = historicalData[pos.pair];
        if (!candles) continue;
        const currentPrice = candles[i].close;

        // Update trailing stop
        const updated = updateTrailingStop(pos, currentPrice, strategy);
        const idx = positions.findIndex(p => p.pair === pos.pair);
        if (idx >= 0) positions[idx] = updated;

        // Check exit
        const exit = checkExitConditions(updated, currentPrice, strategy);
        if (exit.shouldSell) {
          const pnl = (currentPrice - updated.entry_price) * updated.quantity;
          const pnlPercent = ((currentPrice - updated.entry_price) / updated.entry_price) * 100;

          // Apply slippage and commission
          const slippage = currentPrice * (config.slippage_percent || 0.1) / 100;
          const exitPrice = currentPrice - slippage;
          const commission = (exitPrice * updated.quantity) * (config.commission_percent || 0.1) / 100;

          balance += (exitPrice * updated.quantity) - commission;
          positions.splice(positions.findIndex(p => p.pair === pos.pair), 1);

          const trade: BotTrade = {
            coin_id: pos.coin_id,
            symbol: pos.symbol,
            pair: pos.pair,
            action: 'SELL',
            strategy: strategy.id,
            entry_price: pos.entry_price,
            exit_price: exitPrice,
            quantity: pos.quantity,
            position_value: exitPrice * pos.quantity,
            pnl: pnl - commission,
            pnl_percent: pnlPercent,
            score: 0,
            confidence: 0,
            reasoning: [exit.reason],
            status: 'closed',
            opened_at: pos.opened_at,
            closed_at: new Date(timestamp).toISOString(),
            mode: 'paper',
            exit_reason: exit.reason,
          };
          allTrades.push(trade);
        }
      }

      // Analyze each pair for entries
      for (const pair of config.pairs) {
        const candles = historicalData[pair];
        if (!candles || i >= candles.length) continue;

        const windowCandles = candles.slice(i - windowSize, i + 1);
        const currentPrice = candles[i].close;

        const marketData: MarketData = {
          pair,
          symbol: pair.split('/')[0],
          current_price: currentPrice,
          ohlcv: windowCandles,
          volume_24h: windowCandles.reduce((s, c) => s + c.volume, 0),
          price_change_24h: windowCandles.length > 1
            ? ((currentPrice - windowCandles[0].close) / windowCandles[0].close) * 100
            : 0,
        };

        const settings: BotSettings = {
          enabled: true,
          strategy: config.strategy,
          mode: 'paper',
          initial_balance: config.initialBalance,
          current_balance: balance,
          selected_pairs: config.pairs,
          max_daily_trades: 50,
          daily_loss_limit_percent: 10,
        };

        const analysis = analyzeCoin(marketData, 50, strategy);
        const { execute } = shouldExecuteTrade(
          analysis, settings, positions, allTrades, strategy
        );

        if (execute && analysis.action === 'BUY') {
          const posSize = Math.min(
            balance * (strategy.riskParams.maxPositionPercent / 100),
            balance
          );
          if (posSize < 5) continue;

          const slippage = currentPrice * (config.slippage_percent || 0.1) / 100;
          const entryPrice = currentPrice + slippage;
          const commission = posSize * (config.commission_percent || 0.1) / 100;
          const quantity = (posSize - commission) / entryPrice;

          balance -= posSize;

          const stopLoss = strategy.riskParams.stopLossPercent > 0
            ? entryPrice * (1 - strategy.riskParams.stopLossPercent / 100) : 0;
          const takeProfit = strategy.riskParams.takeProfitPercent > 0
            ? entryPrice * (1 + strategy.riskParams.takeProfitPercent / 100) : 0;

          positions.push({
            coin_id: pair.split('/')[0].toLowerCase(),
            symbol: pair.split('/')[0],
            pair,
            entry_price: entryPrice,
            current_price: entryPrice,
            quantity,
            position_value: posSize,
            unrealized_pnl: 0,
            unrealized_pnl_percent: 0,
            stop_loss_price: stopLoss,
            take_profit_price: takeProfit,
            trailing_stop_price: strategy.riskParams.trailingStop
              ? entryPrice * (1 - strategy.riskParams.trailingStopPercent / 100) : undefined,
            highest_price: entryPrice,
            strategy: strategy.id,
            opened_at: new Date(timestamp).toISOString(),
          });

          allTrades.push({
            coin_id: pair.split('/')[0].toLowerCase(),
            symbol: pair.split('/')[0],
            pair,
            action: 'BUY',
            strategy: strategy.id,
            entry_price: entryPrice,
            quantity,
            position_value: posSize,
            score: analysis.score,
            confidence: analysis.confidence,
            reasoning: analysis.reasoning,
            status: 'open',
            opened_at: new Date(timestamp).toISOString(),
            mode: 'paper',
          });
        }
      }

      // Track equity curve
      const positionValue = positions.reduce((sum, p) => {
        const candles = historicalData[p.pair];
        if (!candles || i >= candles.length) return sum;
        return sum + candles[i].close * p.quantity;
      }, 0);
      const totalEquity = balance + positionValue;
      equityCurve.push({ timestamp, balance: totalEquity });

      // Track drawdown
      if (totalEquity > maxBalance) maxBalance = totalEquity;
      const drawdown = ((maxBalance - totalEquity) / maxBalance) * 100;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    // Close any remaining positions at last price
    for (const pos of positions) {
      const candles = historicalData[pos.pair];
      if (!candles) continue;
      const lastPrice = candles[candles.length - 1].close;
      const pnl = (lastPrice - pos.entry_price) * pos.quantity;
      balance += lastPrice * pos.quantity;

      const closedTrade = allTrades.find(
        t => t.pair === pos.pair && t.status === 'open'
      );
      if (closedTrade) {
        closedTrade.status = 'closed';
        closedTrade.exit_price = lastPrice;
        closedTrade.pnl = pnl;
        closedTrade.pnl_percent =
          ((lastPrice - pos.entry_price) / pos.entry_price) * 100;
        closedTrade.closed_at = new Date().toISOString();
      }
    }

    // Calculate metrics
    const closedTrades = allTrades.filter(t => t.status === 'closed');
    const wins = closedTrades.filter(t => (t.pnl || 0) > 0);
    const losses = closedTrades.filter(t => (t.pnl || 0) < 0);
    const winRate = closedTrades.length > 0
      ? (wins.length / closedTrades.length) * 100 : 0;
    const totalReturn = ((balance - config.initialBalance) / config.initialBalance) * 100;

    const avgWin = wins.length > 0
      ? wins.reduce((s, t) => s + (t.pnl || 0), 0) / wins.length : 0;
    const avgLoss = losses.length > 0
      ? Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0) / losses.length) : 0;
    const profitFactor = avgLoss > 0
      ? (avgWin * wins.length) / (avgLoss * losses.length) : 0;

    // Sharpe & Sortino (simplified)
    const returns = equityCurve.map((e, i) =>
      i > 0 ? (e.balance - equityCurve[i - 1].balance) / equityCurve[i - 1].balance : 0
    ).slice(1);

    const avgReturn = returns.length > 0
      ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const stdDev = returns.length > 0
      ? Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / returns.length)
      : 1;
    const downside = returns.filter(r => r < 0);
    const downsideDev = downside.length > 0
      ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length)
      : 1;

    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;
    const sortinoRatio = downsideDev > 0 ? (avgReturn / downsideDev) * Math.sqrt(252) : 0;

    // Avg trade duration
    const durations = closedTrades
      .filter(t => t.opened_at && t.closed_at)
      .map(t => {
        const open = new Date(t.opened_at).getTime();
        const close = new Date(t.closed_at!).getTime();
        return (close - open) / (1000 * 60 * 60);
      });
    const avgDuration = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

    const result: BacktestResult = {
      config,
      trades: closedTrades,
      final_balance: Math.round(balance * 100) / 100,
      total_return_percent: Math.round(totalReturn * 100) / 100,
      max_drawdown_percent: Math.round(maxDrawdown * 100) / 100,
      sharpe_ratio: Math.round(sharpeRatio * 100) / 100,
      sortino_ratio: Math.round(sortinoRatio * 100) / 100,
      profit_factor: Math.round(profitFactor * 100) / 100,
      win_rate: Math.round(winRate * 100) / 100,
      total_trades: closedTrades.length,
      avg_trade_duration_hours: Math.round(avgDuration * 10) / 10,
      best_trade_pnl: closedTrades.length > 0
        ? Math.max(...closedTrades.map(t => t.pnl || 0)) : 0,
      worst_trade_pnl: closedTrades.length > 0
        ? Math.min(...closedTrades.map(t => t.pnl || 0)) : 0,
      monthly_returns: [],
      equity_curve: equityCurve,
    };

    // Log results
    log('info', '========================================');
    log('info', '  BACKTEST RESULTS');
    log('info', '========================================');
    log('info', `  Final Balance: $${result.final_balance}`);
    log('info', `  Total Return: ${result.total_return_percent}%`);
    log('info', `  Max Drawdown: ${result.max_drawdown_percent}%`);
    log('info', `  Win Rate: ${result.win_rate}%`);
    log('info', `  Total Trades: ${result.total_trades}`);
    log('info', `  Profit Factor: ${result.profit_factor}`);
    log('info', `  Sharpe Ratio: ${result.sharpe_ratio}`);
    log('info', `  Sortino Ratio: ${result.sortino_ratio}`);
    log('info', `  Avg Hold Time: ${result.avg_trade_duration_hours}h`);
    log('info', `  Best Trade: $${result.best_trade_pnl.toFixed(2)}`);
    log('info', `  Worst Trade: $${result.worst_trade_pnl.toFixed(2)}`);
    log('info', '========================================');

    return result;
  }

  private emptyResult(config: BacktestConfig): BacktestResult {
    return {
      config,
      trades: [],
      final_balance: config.initialBalance,
      total_return_percent: 0,
      max_drawdown_percent: 0,
      sharpe_ratio: 0,
      sortino_ratio: 0,
      profit_factor: 0,
      win_rate: 0,
      total_trades: 0,
      avg_trade_duration_hours: 0,
      best_trade_pnl: 0,
      worst_trade_pnl: 0,
      monthly_returns: [],
      equity_curve: [],
    };
  }
}
