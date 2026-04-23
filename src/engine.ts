// ============================================================
// Analysis engine — ported from bot-engine.ts
// Now uses Kraken OHLCV data instead of CoinGecko sparklines
// ============================================================

import {
  StrategyConfig,
  AnalysisResult,
  IndicatorSnapshot,
  TradeAction,
  CoinMarketData,
  BotPosition,
  BotTrade,
  BotSettings,
  FullIndicators,
} from './types';
import { calculateAllIndicators } from './indicators';
import { log } from './logger';

const FEAR_GREED_URL = 'https://api.alternative.me/fng/?limit=1';

// -- Fetch Fear & Greed Index
export async function fetchFearGreed(): Promise<number> {
  try {
    const res = await fetch(FEAR_GREED_URL);
    if (res.ok) {
      const data = await res.json();
      return parseInt((data as any).data?.[0]?.value || '50');
    }
  } catch {}
  return 50;
}

// -- Analyze a single coin
export function analyzeCoin(
  marketData: CoinMarketData,
  fearGreed: number,
  strategy: StrategyConfig
): AnalysisResult {
  // Extract price and volume arrays from OHLCV
  const prices = marketData.ohlcv.map((c) => c.close);
  const volumes = marketData.ohlcv.map((c) => c.volume);

  // Calculate all technical indicators
  const indicators = calculateAllIndicators(prices, volumes);

  // Generate sentiment score from price action
  const sentimentScore = Math.max(
    -100,
    Math.min(100, marketData.price_change_24h * 5 - 50)
  );

  // Build indicator snapshot
  const snapshot: IndicatorSnapshot = {
    rsi: indicators.rsi,
    macd: indicators.macd,
    ema_short: indicators.emaShort,
    ema_long: indicators.emaLong,
    bollinger: indicators.bollingerBands,
    volume_change: indicators.volumeChange,
    momentum: indicators.momentum,
    stochastic_rsi: indicators.stochasticRsi,
    fear_greed: fearGreed,
    sentiment_score: sentimentScore,
    price_vs_ema: indicators.priceVsEma,
    price_vs_bollinger: indicators.priceVsBollinger,
  };

  // Score with strategy
  const { score, reasoning, confidence } = scoreWithStrategy(
    indicators,
    fearGreed,
    sentimentScore,
    strategy,
    marketData
  );

  // Determine action
  let action: TradeAction = 'HOLD';
  if (
    score >= strategy.signalThresholds.buyScore &&
    confidence >= strategy.signalThresholds.minConfidence
  ) {
    action = 'BUY';
  } else if (score <= strategy.signalThresholds.sellScore) {
    action = 'SELL';
  }

  return {
    coin_id: marketData.symbol.toLowerCase(),
    symbol: marketData.symbol,
    pair: marketData.pair,
    current_price: marketData.current_price,
    action,
    score,
    confidence,
    reasoning,
    indicators: snapshot,
    strategy: strategy.id,
    timestamp: new Date().toISOString(),
  };
}

// -- Scoring engine (ported from original)
function scoreWithStrategy(
  ind: FullIndicators,
  fearGreed: number,
  sentiment: number,
  strategy: StrategyConfig,
  marketData: CoinMarketData
): { score: number; reasoning: string[]; confidence: number } {
  const weights = strategy.indicatorWeights;
  const reasoning: string[] = [];
  let totalScore = 0;
  let bullishFactors = 0;
  let bearishFactors = 0;

  // RSI Score
  if (weights.rsi > 0) {
    let rsiScore = 0;
    if (ind.rsi < 30) {
      rsiScore = 80 + (30 - ind.rsi) * 2;
      reasoning.push(`RSI ${ind.rsi.toFixed(1)} — oversold, buy signal`);
      bullishFactors++;
    } else if (ind.rsi > 70) {
      rsiScore = -(80 + (ind.rsi - 70) * 2);
      reasoning.push(`RSI ${ind.rsi.toFixed(1)} — overbought, sell signal`);
      bearishFactors++;
    } else if (ind.rsi < 45) {
      rsiScore = 30;
      reasoning.push(`RSI ${ind.rsi.toFixed(1)} — leaning bullish`);
      bullishFactors++;
    } else if (ind.rsi > 55) {
      rsiScore = -30;
      reasoning.push(`RSI ${ind.rsi.toFixed(1)} — leaning bearish`);
      bearishFactors++;
    } else {
      reasoning.push(`RSI ${ind.rsi.toFixed(1)} — neutral`);
    }
    totalScore += rsiScore * (weights.rsi / 100);
  }

  // MACD Score
  if (weights.macd > 0) {
    let macdScore = 0;
    if (ind.macd.histogram > 0 && ind.macd.value > ind.macd.signal) {
      macdScore = 60 + Math.min(40, Math.abs(ind.macd.histogram) * 1000);
      reasoning.push('MACD bullish crossover — histogram positive');
      bullishFactors++;
    } else if (ind.macd.histogram < 0 && ind.macd.value < ind.macd.signal) {
      macdScore = -(60 + Math.min(40, Math.abs(ind.macd.histogram) * 1000));
      reasoning.push('MACD bearish crossover — histogram negative');
      bearishFactors++;
    } else {
      reasoning.push('MACD neutral — no clear crossover');
    }
    totalScore += macdScore * (weights.macd / 100);
  }

  // EMA Score
  if (weights.ema > 0) {
    let emaScore = 0;
    if (ind.emaShort > ind.emaLong) {
      const spread = ((ind.emaShort - ind.emaLong) / ind.emaLong) * 100;
      emaScore = 50 + Math.min(50, spread * 10);
      reasoning.push(`EMA bullish — short above long (${spread.toFixed(2)}% spread)`);
      bullishFactors++;
    } else {
      const spread = ((ind.emaLong - ind.emaShort) / ind.emaLong) * 100;
      emaScore = -(50 + Math.min(50, spread * 10));
      reasoning.push(`EMA bearish — short below long (${spread.toFixed(2)}% spread)`);
      bearishFactors++;
    }
    totalScore += emaScore * (weights.ema / 100);
  }

  // Bollinger Bands Score
  if (weights.bollingerBands > 0) {
    let bbScore = 0;
    if (ind.priceVsBollinger === 'below_lower') {
      bbScore = 80;
      reasoning.push('Price below lower Bollinger Band — potential bounce');
      bullishFactors++;
    } else if (ind.priceVsBollinger === 'above_upper') {
      bbScore = -80;
      reasoning.push('Price above upper Bollinger Band — potential pullback');
      bearishFactors++;
    } else {
      const price = marketData.current_price;
      const mid = ind.bollingerBands.middle;
      if (price < mid) {
        bbScore = 20;
        reasoning.push('Price below BB middle — room to grow');
      } else {
        bbScore = -20;
        reasoning.push('Price above BB middle — extended');
      }
    }
    totalScore += bbScore * (weights.bollingerBands / 100);
  }

  // Volume Score
  if (weights.volume > 0) {
    let volScore = 0;
    if (ind.volumeChange > 50) {
      volScore = 60;
      reasoning.push(`Volume surge +${ind.volumeChange.toFixed(0)}% — strong interest`);
      bullishFactors++;
    } else if (ind.volumeChange > 20) {
      volScore = 30;
      reasoning.push(`Volume rising +${ind.volumeChange.toFixed(0)}%`);
    } else if (ind.volumeChange < -30) {
      volScore = -40;
      reasoning.push(`Volume declining ${ind.volumeChange.toFixed(0)}% — fading interest`);
      bearishFactors++;
    } else {
      reasoning.push('Volume stable');
    }
    totalScore += volScore * (weights.volume / 100);
  }

  // Sentiment Score
  if (weights.sentiment > 0) {
    let sentScore = 0;
    const effectiveSentiment = strategy.id === 'contrarian' ? -sentiment : sentiment;
    if (effectiveSentiment > 30) {
      sentScore = 50;
      reasoning.push(
        strategy.id === 'contrarian'
          ? 'Market fear detected — contrarian buy zone'
          : 'Positive sentiment — bullish'
      );
      bullishFactors++;
    } else if (effectiveSentiment < -30) {
      sentScore = -50;
      reasoning.push(
        strategy.id === 'contrarian'
          ? 'Market greed detected — contrarian sell zone'
          : 'Negative sentiment — bearish'
      );
      bearishFactors++;
    }
    totalScore += sentScore * (weights.sentiment / 100);
  }

  // Fear & Greed Score
  if (weights.fearGreed > 0) {
    let fgScore = 0;
    const isContrarian = strategy.id === 'contrarian' || strategy.id === 'dca';
    if (fearGreed < 25) {
      fgScore = isContrarian ? 90 : -30;
      reasoning.push(
        isContrarian
          ? `Extreme Fear (${fearGreed}) — strong buy zone`
          : `Extreme Fear (${fearGreed}) — risky market`
      );
      if (isContrarian) bullishFactors++;
      else bearishFactors++;
    } else if (fearGreed > 75) {
      fgScore = isContrarian ? -70 : 30;
      reasoning.push(
        isContrarian
          ? `Extreme Greed (${fearGreed}) — danger zone, sell`
          : `Extreme Greed (${fearGreed}) — market euphoria`
      );
      if (isContrarian) bearishFactors++;
      else bullishFactors++;
    } else {
      reasoning.push(`Fear & Greed neutral (${fearGreed})`);
    }
    totalScore += fgScore * (weights.fearGreed / 100);
  }

  // Momentum Score
  if (weights.momentum > 0) {
    let momScore = 0;
    if (ind.momentum > 5) {
      momScore = 60;
      reasoning.push(`Strong upward momentum +${ind.momentum.toFixed(1)}%`);
      bullishFactors++;
    } else if (ind.momentum > 2) {
      momScore = 30;
      reasoning.push(`Positive momentum +${ind.momentum.toFixed(1)}%`);
    } else if (ind.momentum < -5) {
      momScore = -60;
      reasoning.push(`Strong downward momentum ${ind.momentum.toFixed(1)}%`);
      bearishFactors++;
    } else if (ind.momentum < -2) {
      momScore = -30;
      reasoning.push(`Negative momentum ${ind.momentum.toFixed(1)}%`);
    } else {
      reasoning.push('Flat momentum');
    }
    totalScore += momScore * (weights.momentum / 100);
  }

  // Stochastic RSI Score
  if (weights.stochasticRsi > 0) {
    let stochScore = 0;
    if (ind.stochasticRsi < 20) {
      stochScore = 70;
      reasoning.push(`StochRSI oversold (${ind.stochasticRsi.toFixed(0)})`);
      bullishFactors++;
    } else if (ind.stochasticRsi > 80) {
      stochScore = -70;
      reasoning.push(`StochRSI overbought (${ind.stochasticRsi.toFixed(0)})`);
      bearishFactors++;
    }
    totalScore += stochScore * (weights.stochasticRsi / 100);
  }

  // DCA Special: Always buy
  if (strategy.id === 'dca') {
    totalScore = Math.max(totalScore, 10);
    reasoning.push('DCA mode — scheduled buy regardless of conditions');
    if (fearGreed < 30) {
      reasoning.push('Smart DCA: 1.5x buy amount (market fear discount)');
    } else if (fearGreed > 70) {
      reasoning.push('Smart DCA: 0.5x buy amount (market overheated)');
    }
  }

  // Calculate confidence
  const totalFactors = bullishFactors + bearishFactors;
  const alignment =
    totalFactors > 0
      ? Math.abs(bullishFactors - bearishFactors) / totalFactors
      : 0;
  const confidence = Math.min(
    100,
    Math.round(50 + alignment * 30 + Math.abs(totalScore) * 0.2)
  );

  return {
    score: Math.round(totalScore),
    reasoning,
    confidence: Math.min(100, confidence),
  };
}

// -- Should we execute this trade?
export function shouldExecuteTrade(
  analysis: AnalysisResult,
  settings: BotSettings,
  positions: BotPosition[],
  recentTrades: BotTrade[],
  strategy: StrategyConfig
): { execute: boolean; reason: string } {
  if (!settings.enabled) {
    return { execute: false, reason: 'Bot is disabled' };
  }

  // Check daily trade limit
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTrades = recentTrades.filter(
    (t) => new Date(t.opened_at) >= todayStart
  ).length;
  if (todayTrades >= settings.max_daily_trades) {
    return { execute: false, reason: `Daily trade limit reached (${settings.max_daily_trades})` };
  }

  // Check daily loss limit
  const todayPnl = recentTrades
    .filter((t) => new Date(t.opened_at) >= todayStart && t.pnl !== undefined)
    .reduce((sum, t) => sum + (t.pnl || 0), 0);
  const lossLimit = settings.initial_balance * (settings.daily_loss_limit_percent / 100);
  if (todayPnl < -lossLimit) {
    return { execute: false, reason: `Daily loss limit hit ($${lossLimit.toFixed(2)})` };
  }

  if (analysis.action === 'BUY') {
    if (positions.length >= strategy.riskParams.maxOpenPositions) {
      return { execute: false, reason: `Max positions (${strategy.riskParams.maxOpenPositions}) reached` };
    }
    if (positions.some((p) => p.pair === analysis.pair)) {
      return { execute: false, reason: `Already holding ${analysis.symbol}` };
    }
    // Cooldown check
    const lastTrade = recentTrades.find(
      (t) => t.pair === analysis.pair && t.status === 'closed'
    );
    if (lastTrade && lastTrade.closed_at) {
      const timeSince = Date.now() - new Date(lastTrade.closed_at).getTime();
      if (timeSince < strategy.riskParams.cooldownMs) {
        const remaining = Math.round(
          (strategy.riskParams.cooldownMs - timeSince) / 60000
        );
        return { execute: false, reason: `Cooldown: ${remaining} min remaining for ${analysis.symbol}` };
      }
    }
    // Check sufficient balance
    const positionSize = settings.current_balance * (strategy.riskParams.maxPositionPercent / 100);
    if (positionSize < 5) {
      return { execute: false, reason: 'Insufficient balance for position' };
    }
    return { execute: true, reason: 'All checks passed' };
  }

  if (analysis.action === 'SELL') {
    if (!positions.some((p) => p.pair === analysis.pair)) {
      return { execute: false, reason: `Not holding ${analysis.symbol}` };
    }
    return { execute: true, reason: 'All checks passed' };
  }

  return { execute: false, reason: 'HOLD signal — no trade' };
}

// -- Check exit conditions (stop loss, take profit, trailing stop)
export function checkExitConditions(
  position: BotPosition,
  currentPrice: number,
  strategy: StrategyConfig
): { shouldSell: boolean; reason: string } {
  if (
    strategy.riskParams.stopLossPercent > 0 &&
    currentPrice <= position.stop_loss_price
  ) {
    return { shouldSell: true, reason: 'Stop Loss triggered' };
  }
  if (
    strategy.riskParams.takeProfitPercent > 0 &&
    position.take_profit_price > 0 &&
    currentPrice >= position.take_profit_price
  ) {
    return { shouldSell: true, reason: 'Take Profit reached' };
  }
  if (
    strategy.riskParams.trailingStop &&
    position.trailing_stop_price &&
    currentPrice <= position.trailing_stop_price
  ) {
    return { shouldSell: true, reason: 'Trailing Stop triggered' };
  }
  return { shouldSell: false, reason: '' };
}

// -- Update trailing stop
export function updateTrailingStop(
  position: BotPosition,
  currentPrice: number,
  strategy: StrategyConfig
): BotPosition {
  if (!strategy.riskParams.trailingStop) return position;
  if (currentPrice > position.highest_price) {
    const newTrailingStop =
      currentPrice * (1 - strategy.riskParams.trailingStopPercent / 100);
    return {
      ...position,
      current_price: currentPrice,
      highest_price: currentPrice,
      trailing_stop_price: Math.max(
        position.trailing_stop_price || 0,
        newTrailingStop
      ),
      unrealized_pnl: (currentPrice - position.entry_price) * position.quantity,
      unrealized_pnl_percent:
        ((currentPrice - position.entry_price) / position.entry_price) * 100,
    };
  }
  return {
    ...position,
    current_price: currentPrice,
    unrealized_pnl: (currentPrice - position.entry_price) * position.quantity,
    unrealized_pnl_percent:
      ((currentPrice - position.entry_price) / position.entry_price) * 100,
  };
}
