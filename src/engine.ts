// ============================================================
// PROJECT: cryptotrader
// FILE: src/engine.ts
// DESCRIPTION: Upgraded scoring engine with ALL pro indicators
//   Multi-timeframe, order book, whale data, ADX, ATR, OBV,
//   VWAP, Ichimoku, Fibonacci — everything feeds into score
// ============================================================

import {
  MarketData, AnalysisResult, StrategyConfig, BotSettings,
  BotPosition, BotTrade, OHLCV, MultiTimeframeResult,
  TimeframeSignal, Timeframe, WhaleData, OrderBookData,
  IndicatorResults,
} from './types';
import {
  calculateRSI, calculateMACD, calculateEMA, calculateBollingerBands,
  calculateStochasticRSI, calculateMomentum, calculateVolumeChange,
  calculateADX, calculateATR, calculateOBV, calculateVWAP,
  calculateIchimoku, calculateFibonacci,
} from './indicators';
import { log } from './logger';

// ---- Fetch Fear & Greed Index ----
export async function fetchFearGreed(): Promise<number> {
  try {
    const response = await fetch('https://api.alternative.me/fng/?limit=1', {
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json() as any;
    return parseInt(data?.data?.[0]?.value || '50');
  } catch {
    return 50;
  }
}

// ---- Main Analysis Function ----
export function analyzeCoin(
  marketData: MarketData,
  fearGreed: number,
  strategy: StrategyConfig,
  whaleData?: WhaleData,
  orderBook?: OrderBookData,
  multiTfData?: Record<Timeframe, OHLCV[]>,
): AnalysisResult {
  const { ohlcv, pair, current_price } = marketData;
  const closes = ohlcv.map(c => c.close);
  const volumes = ohlcv.map(c => c.volume);
  const weights = strategy.indicatorWeights;
  const reasoning: string[] = [];

  // ============================================================
  // CALCULATE ALL INDICATORS
  // ============================================================

  // Original indicators
  const rsi = calculateRSI(closes);
  const macd = calculateMACD(closes);
  const emaShort = calculateEMA(closes, 9);
  const emaLong = calculateEMA(closes, 21);
  const bb = calculateBollingerBands(closes);
  const stochRsi = calculateStochasticRSI(closes);
  const momentum = calculateMomentum(closes);
  const volumeChange = calculateVolumeChange(volumes);

  // NEW pro indicators
  const adx = calculateADX(ohlcv);
  const atr = calculateATR(ohlcv);
  const obv = calculateOBV(ohlcv);
  const vwap = calculateVWAP(ohlcv);
  const ichimoku = calculateIchimoku(ohlcv);
  const fibonacci = calculateFibonacci(ohlcv);

  // ============================================================
  // SCORE EACH INDICATOR (raw scores -100 to +100)
  // ============================================================
  let totalScore = 0;
  let totalWeight = 0;

  // --- RSI ---
  let rsiScore = 0;
  if (rsi < 25) { rsiScore = 80; reasoning.push(`RSI ${rsi.toFixed(0)} — strongly oversold`); }
  else if (rsi < 35) { rsiScore = 50; reasoning.push(`RSI ${rsi.toFixed(0)} — oversold`); }
  else if (rsi < 45) { rsiScore = 20; reasoning.push(`RSI ${rsi.toFixed(0)} — leaning oversold`); }
  else if (rsi > 75) { rsiScore = -80; reasoning.push(`RSI ${rsi.toFixed(0)} — strongly overbought`); }
  else if (rsi > 65) { rsiScore = -50; reasoning.push(`RSI ${rsi.toFixed(0)} — overbought`); }
  else if (rsi > 55) { rsiScore = -20; reasoning.push(`RSI ${rsi.toFixed(0)} — leaning overbought`); }
  totalScore += rsiScore * (weights.rsi / 100);
  totalWeight += weights.rsi;

  // --- MACD ---
  let macdScore = 0;
  if (macd.histogram > 0 && macd.macd > macd.signal) {
    macdScore = Math.min(80, macd.histogram * 500);
    reasoning.push('MACD bullish crossover');
  } else if (macd.histogram < 0 && macd.macd < macd.signal) {
    macdScore = Math.max(-80, macd.histogram * 500);
    reasoning.push('MACD bearish');
  }
  totalScore += macdScore * (weights.macd / 100);
  totalWeight += weights.macd;

  // --- EMA ---
  let emaScore = 0;
  const emaShortVal = emaShort[emaShort.length - 1] || 0;
  const emaLongVal = emaLong[emaLong.length - 1] || 0;
  if (emaLongVal > 0) {
    const emaDiff = ((emaShortVal - emaLongVal) / emaLongVal) * 100;
    if (emaDiff > 0.5) { emaScore = Math.min(70, emaDiff * 30); reasoning.push(`EMA bullish spread ${emaDiff.toFixed(2)}%`); }
    else if (emaDiff < -0.5) { emaScore = Math.max(-70, emaDiff * 30); reasoning.push(`EMA bearish spread ${emaDiff.toFixed(2)}%`); }
  }
  totalScore += emaScore * (weights.ema / 100);
  totalWeight += weights.ema;

  // --- Bollinger Bands ---
  let bbScore = 0;
  if (current_price < bb.lower) { bbScore = 60; reasoning.push('Price below lower Bollinger Band'); }
  else if (current_price < bb.middle) { bbScore = 20; }
  else if (current_price > bb.upper) { bbScore = -60; reasoning.push('Price above upper Bollinger Band'); }
  else if (current_price > bb.middle) { bbScore = -20; }
  totalScore += bbScore * (weights.bollingerBands / 100);
  totalWeight += weights.bollingerBands;

  // --- Volume ---
  let volScore = 0;
  if (volumeChange > 50) { volScore = 40; reasoning.push(`Volume surge +${volumeChange.toFixed(0)}%`); }
  else if (volumeChange > 20) { volScore = 20; }
  else if (volumeChange < -30) { volScore = -20; }
  totalScore += volScore * (weights.volume / 100);
  totalWeight += weights.volume;

  // --- Stochastic RSI ---
  let stochScore = 0;
  if (stochRsi.k < 20 && stochRsi.d < 20) { stochScore = 60; reasoning.push('Stochastic RSI oversold'); }
  else if (stochRsi.k < 30) { stochScore = 30; }
  else if (stochRsi.k > 80 && stochRsi.d > 80) { stochScore = -60; }
  else if (stochRsi.k > 70) { stochScore = -30; }
  totalScore += stochScore * (weights.stochasticRsi / 100);
  totalWeight += weights.stochasticRsi;

  // --- Momentum ---
  let momScore = 0;
  if (momentum > 5) { momScore = 50; reasoning.push(`Strong upward momentum +${momentum.toFixed(1)}%`); }
  else if (momentum > 2) { momScore = 25; }
  else if (momentum < -5) { momScore = -50; reasoning.push(`Strong downward momentum ${momentum.toFixed(1)}%`); }
  else if (momentum < -2) { momScore = -25; }
  totalScore += momScore * (weights.momentum / 100);
  totalWeight += weights.momentum;

  // --- Fear & Greed ---
  let fgScore = 0;
  if (fearGreed < 20) { fgScore = 50; reasoning.push(`Extreme Fear (${fearGreed})`); }
  else if (fearGreed < 35) { fgScore = 25; }
  else if (fearGreed > 80) { fgScore = -50; reasoning.push(`Extreme Greed (${fearGreed})`); }
  else if (fearGreed > 65) { fgScore = -25; }
  totalScore += fgScore * (weights.fearGreed / 100);
  totalWeight += weights.fearGreed;

  // --- Sentiment (placeholder) ---
  totalScore += 0;
  totalWeight += weights.sentiment;

  // ============================================================
  // NEW PRO INDICATOR SCORING
  // ============================================================

  // --- ADX (Trend Strength) ---
  const adxWeight = weights.adx || 0;
  if (adxWeight > 0) {
    let adxScore = 0;
    if (adx.trending && adx.trend_direction === 'bullish') {
      adxScore = Math.min(70, adx.adx * 1.5);
      reasoning.push(`ADX ${adx.adx.toFixed(0)} — strong bullish trend`);
    } else if (adx.trending && adx.trend_direction === 'bearish') {
      adxScore = -Math.min(70, adx.adx * 1.5);
      reasoning.push(`ADX ${adx.adx.toFixed(0)} — strong bearish trend`);
    } else if (!adx.trending) {
      adxScore = 0; // ranging market
    }
    totalScore += adxScore * (adxWeight / 100);
    totalWeight += adxWeight;
  }

  // --- OBV (Volume Flow) ---
  const obvWeight = weights.obv || 0;
  if (obvWeight > 0) {
    let obvScore = 0;
    if (obv.divergence === 'bullish') {
      obvScore = 60;
      reasoning.push('OBV bullish divergence — accumulation');
    } else if (obv.divergence === 'bearish') {
      obvScore = -60;
      reasoning.push('OBV bearish divergence — distribution');
    } else if (obv.obv_trend === 'rising') {
      obvScore = 30;
    } else if (obv.obv_trend === 'falling') {
      obvScore = -30;
    }
    totalScore += obvScore * (obvWeight / 100);
    totalWeight += obvWeight;
  }

  // --- VWAP ---
  const vwapWeight = weights.vwap || 0;
  if (vwapWeight > 0) {
    let vwapScore = 0;
    if (vwap.position === 'below' && vwap.price_vs_vwap < -1) {
      vwapScore = 50;
      reasoning.push(`Price ${vwap.price_vs_vwap.toFixed(1)}% below VWAP — undervalued`);
    } else if (vwap.position === 'below') {
      vwapScore = 25;
    } else if (vwap.position === 'above' && vwap.price_vs_vwap > 1) {
      vwapScore = -50;
      reasoning.push(`Price ${vwap.price_vs_vwap.toFixed(1)}% above VWAP — overvalued`);
    } else if (vwap.position === 'above') {
      vwapScore = -25;
    }
    totalScore += vwapScore * (vwapWeight / 100);
    totalWeight += vwapWeight;
  }

  // --- Ichimoku Cloud ---
  const ichimokuWeight = weights.ichimoku || 0;
  if (ichimokuWeight > 0) {
    let ichimokuScore = 0;
    // Score based on signal strength (0-5)
    if (ichimoku.signal_strength >= 4) {
      ichimokuScore = 70;
      reasoning.push(`Ichimoku strongly bullish (${ichimoku.signal_strength}/5)`);
    } else if (ichimoku.signal_strength >= 3) {
      ichimokuScore = 40;
      reasoning.push(`Ichimoku bullish (${ichimoku.signal_strength}/5)`);
    } else if (ichimoku.signal_strength <= 1) {
      ichimokuScore = -60;
      reasoning.push(`Ichimoku bearish (${ichimoku.signal_strength}/5)`);
    } else if (ichimoku.signal_strength === 2) {
      ichimokuScore = -20;
    }
    // TK cross bonus
    if (ichimoku.tk_cross === 'bullish') { ichimokuScore += 20; reasoning.push('Ichimoku TK bullish cross'); }
    if (ichimoku.tk_cross === 'bearish') { ichimokuScore -= 20; }
    ichimokuScore = Math.max(-80, Math.min(80, ichimokuScore));
    totalScore += ichimokuScore * (ichimokuWeight / 100);
    totalWeight += ichimokuWeight;
  }

  // --- Fibonacci ---
  const fibWeight = weights.fibonacci || 0;
  if (fibWeight > 0) {
    let fibScore = 0;
    if (fibonacci.current_zone.includes('61.8%') || fibonacci.current_zone.includes('78.6%')) {
      fibScore = 50;
      reasoning.push(`Price at key Fibonacci support (${fibonacci.current_zone})`);
    } else if (fibonacci.current_zone.includes('38.2%') || fibonacci.current_zone.includes('50%')) {
      fibScore = 25;
      reasoning.push(`Price at Fibonacci mid-zone (${fibonacci.current_zone})`);
    } else if (fibonacci.current_zone.includes('23.6%') || fibonacci.current_zone.includes('0%')) {
      fibScore = -30;
    }
    totalScore += fibScore * (fibWeight / 100);
    totalWeight += fibWeight;
  }

  // --- Order Book Depth ---
  const obWeight = weights.orderBook || 0;
  if (obWeight > 0 && orderBook) {
    let obScore = 0;
    // imbalance > 1.3 = more bids than asks = bullish
    if (orderBook.imbalance > 1.5) {
      obScore = 60;
      reasoning.push(`Order book bullish — bid/ask ratio ${orderBook.imbalance.toFixed(2)}`);
    } else if (orderBook.imbalance > 1.2) {
      obScore = 30;
    } else if (orderBook.imbalance < 0.7) {
      obScore = -60;
      reasoning.push(`Order book bearish — bid/ask ratio ${orderBook.imbalance.toFixed(2)}`);
    } else if (orderBook.imbalance < 0.8) {
      obScore = -30;
    }
    totalScore += obScore * (obWeight / 100);
    totalWeight += obWeight;
  }

  // --- Whale Flow ---
  const whaleWeight = weights.whaleFlow || 0;
  if (whaleWeight > 0 && whaleData) {
    let whaleScore = 0;
    if (whaleData.whale_sentiment > 30) {
      whaleScore = 50;
      reasoning.push(`Whale sentiment bullish (${whaleData.whale_sentiment})`);
    } else if (whaleData.whale_sentiment > 10) {
      whaleScore = 25;
    } else if (whaleData.whale_sentiment < -30) {
      whaleScore = -50;
      reasoning.push(`Whale sentiment bearish (${whaleData.whale_sentiment})`);
    } else if (whaleData.whale_sentiment < -10) {
      whaleScore = -25;
    }
    totalScore += whaleScore * (whaleWeight / 100);
    totalWeight += whaleWeight;
  }

  // --- Multi-Timeframe ---
  const mtfWeight = weights.multiTimeframe || 0;
  let multiTfResult: MultiTimeframeResult | undefined;
  if (mtfWeight > 0 && multiTfData) {
    multiTfResult = analyzeMultiTimeframe(multiTfData);
    totalScore += multiTfResult.score_bonus * (mtfWeight / 100);
    totalWeight += mtfWeight;
    if (multiTfResult.alignment > 70) {
      reasoning.push(`Multi-TF aligned ${multiTfResult.alignment.toFixed(0)}% — ${multiTfResult.dominant_trend}`);
    } else if (multiTfResult.conflicting) {
      reasoning.push('Multi-TF conflict — short vs long term disagree');
    }
  }

  // ============================================================
  // FINAL SCORE & CONFIDENCE
  // ============================================================

  // Normalize score — higher weight means proportionally more influence
  const normalizedScore = totalWeight > 0
    ? Math.round(totalScore * (100 / totalWeight) * 100) / 100
    : 0;

  // Confidence = how many indicators agree on direction
  const indicatorScores = [rsiScore, macdScore, emaScore, bbScore, volScore, momScore, stochScore];
  const bullish = indicatorScores.filter(s => s > 10).length;
  const bearish = indicatorScores.filter(s => s < -10).length;
  const total = indicatorScores.length;
  const agreement = Math.max(bullish, bearish);
  const confidence = Math.round((agreement / total) * 100);

  // Determine action
  let action: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  const thresholds = strategy.signalThresholds;

  if (normalizedScore >= thresholds.buyScore && confidence >= thresholds.minConfidence) {
    // Check ADX minimum if configured
    if (thresholds.minAdx && adx.adx < thresholds.minAdx) {
      reasoning.push(`ADX ${adx.adx.toFixed(0)} below minimum ${thresholds.minAdx} — no trend`);
    }
    // Check max ATR if configured
    else if (thresholds.maxAtrPercent && atr.atr_percent > thresholds.maxAtrPercent) {
      reasoning.push(`ATR ${atr.atr_percent.toFixed(1)}% exceeds max ${thresholds.maxAtrPercent}% — too volatile`);
    }
    // Check multi-timeframe alignment
    else if (thresholds.minMultiTimeframeAlignment && multiTfResult &&
             multiTfResult.alignment < thresholds.minMultiTimeframeAlignment) {
      reasoning.push(`MTF alignment ${multiTfResult.alignment.toFixed(0)}% below minimum`);
    }
    else {
      action = 'BUY';
    }
  } else if (normalizedScore <= thresholds.sellScore) {
    action = 'SELL';
  }

  // Build full indicator details
  const indicatorDetails: IndicatorResults = {
    rsi, macd, ema_short: emaShortVal, ema_long: emaLongVal,
    bollinger: bb, stochastic_rsi: stochRsi, volume_change: volumeChange,
    momentum, fear_greed: fearGreed, sentiment: 0,
    adx, atr, obv, vwap, ichimoku, fibonacci,
  };

  return {
    pair,
    symbol: marketData.symbol,
    action,
    score: normalizedScore,
    confidence,
    current_price,
    indicators: {
      rsi, macd_histogram: macd.histogram, ema_diff: emaShortVal - emaLongVal,
      bb_position: current_price < bb.middle ? 'below' : 'above',
      volume_change: volumeChange, momentum, fear_greed: fearGreed,
      stoch_rsi_k: stochRsi.k, adx: adx.adx, atr: atr.atr,
      obv_trend: obv.obv_trend, vwap_position: vwap.position,
      ichimoku_strength: ichimoku.signal_strength, fib_zone: fibonacci.current_zone,
    },
    reasoning,
    multi_timeframe: multiTfResult,
    whale_data: whaleData,
    order_book: orderBook,
    indicator_details: indicatorDetails,
  };
}

// ---- Multi-Timeframe Analysis ----
function analyzeMultiTimeframe(
  tfData: Record<Timeframe, OHLCV[]>
): MultiTimeframeResult {
  const signals: TimeframeSignal[] = [];

  for (const [tf, candles] of Object.entries(tfData)) {
    if (candles.length < 30) continue;

    const closes = candles.map(c => c.close);
    const rsi = calculateRSI(closes);
    const macd = calculateMACD(closes);
    const emaShort = calculateEMA(closes, 9);
    const emaLong = calculateEMA(closes, 21);

    const emaShortVal = emaShort[emaShort.length - 1];
    const emaLongVal = emaLong[emaLong.length - 1];

    let trend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    let strength = 50;

    // Score this timeframe
    let tfScore = 0;
    if (rsi < 40) tfScore += 1;
    if (rsi > 60) tfScore -= 1;
    if (macd.histogram > 0) tfScore += 1;
    if (macd.histogram < 0) tfScore -= 1;
    if (emaShortVal > emaLongVal) tfScore += 1;
    if (emaShortVal < emaLongVal) tfScore -= 1;

    if (tfScore >= 2) { trend = 'bullish'; strength = 50 + tfScore * 15; }
    else if (tfScore <= -2) { trend = 'bearish'; strength = 50 + Math.abs(tfScore) * 15; }
    else { strength = 50; }

    signals.push({
      timeframe: tf as Timeframe,
      trend,
      strength: Math.min(100, strength),
      rsi,
      macd_histogram: macd.histogram,
      ema_trend: emaShortVal > emaLongVal ? 'bullish' : 'bearish',
    });
  }

  // Calculate alignment
  const bullishCount = signals.filter(s => s.trend === 'bullish').length;
  const bearishCount = signals.filter(s => s.trend === 'bearish').length;
  const total = signals.length;
  const alignment = total > 0
    ? (Math.max(bullishCount, bearishCount) / total) * 100
    : 0;

  let dominant_trend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (bullishCount > bearishCount && alignment > 50) dominant_trend = 'bullish';
  if (bearishCount > bullishCount && alignment > 50) dominant_trend = 'bearish';

  // Score bonus — aligned timeframes boost confidence
  let score_bonus = 0;
  if (alignment >= 80) score_bonus = dominant_trend === 'bullish' ? 60 : -60;
  else if (alignment >= 60) score_bonus = dominant_trend === 'bullish' ? 35 : -35;

  // Check for conflict (short bullish, long bearish or vice versa)
  const shortTf = signals.filter(s => ['1m', '5m', '15m'].includes(s.timeframe));
  const longTf = signals.filter(s => ['1h', '4h', '1d'].includes(s.timeframe));
  const shortBullish = shortTf.some(s => s.trend === 'bullish');
  const longBearish = longTf.some(s => s.trend === 'bearish');
  const conflicting = (shortBullish && longBearish) ||
    (shortTf.some(s => s.trend === 'bearish') && longTf.some(s => s.trend === 'bullish'));

  return { signals, alignment, dominant_trend, score_bonus, conflicting };
}

// ---- Should Execute Trade (risk checks) ----
export function shouldExecuteTrade(
  analysis: AnalysisResult,
  settings: BotSettings,
  positions: BotPosition[],
  recentTrades: BotTrade[],
  strategy: StrategyConfig
): { execute: boolean; reason: string } {
  if (analysis.action === 'HOLD') {
    return { execute: false, reason: 'HOLD signal' };
  }

  // Max positions
  if (analysis.action === 'BUY' &&
      positions.length >= strategy.riskParams.maxOpenPositions) {
    return { execute: false, reason: `Max positions (${strategy.riskParams.maxOpenPositions}) reached` };
  }

  // Already have position in this pair
  if (analysis.action === 'BUY' &&
      positions.some(p => p.pair === analysis.pair)) {
    return { execute: false, reason: 'Already holding this pair' };
  }

  // Cooldown check
  const lastTrade = recentTrades
    .filter(t => t.pair === analysis.pair)
    .sort((a, b) => new Date(b.opened_at).getTime() - new Date(a.opened_at).getTime())[0];

  if (lastTrade) {
    const elapsed = Date.now() - new Date(lastTrade.opened_at).getTime();
    if (elapsed < strategy.riskParams.cooldownMs) {
      return { execute: false, reason: 'Cooldown period active' };
    }
  }

  // Daily trade limit
  const today = new Date().toISOString().split('T')[0];
  const tradesToday = recentTrades.filter(t =>
    t.opened_at.startsWith(today)
  ).length;
  if (tradesToday >= settings.max_daily_trades) {
    return { execute: false, reason: 'Daily trade limit reached' };
  }

  // Minimum balance check
  if (analysis.action === 'BUY' && settings.current_balance < 5) {
    return { execute: false, reason: 'Insufficient balance' };
  }

  return { execute: true, reason: 'All checks passed' };
}

// ============================================================
// TP TRAIL CONFIG — hold through take profit during momentum spikes
// ============================================================
const TP_TRAIL_VOLUME_THRESHOLD = 2.0;   // Current volume must be >= 2x the 20-period avg
const TP_TRAIL_RSI_THRESHOLD = 60;       // RSI must be >= 60 (strong bullish momentum)
const TP_TRAIL_MAX_HOLD_PERCENT = 8.0;   // Safety cap — always sell at +8% no matter what

// ---- Detect Momentum Spike ----
function detectMomentumSpike(ohlcv: OHLCV[]): {
  isSpike: boolean;
  volumeRatio: number;
  rsi: number;
} {
  const closes = ohlcv.map(c => c.close);
  const volumes = ohlcv.map(c => c.volume);

  // Current RSI
  const rsi = calculateRSI(closes);

  // Volume ratio: current candle vs 20-period average
  const recentVolumes = volumes.slice(-20);
  const avgVolume = recentVolumes.reduce((sum, v) => sum + v, 0) / recentVolumes.length;
  const currentVolume = volumes[volumes.length - 1];
  const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;

  // Spike = volume surge AND RSI confirms bullish momentum
  const isSpike = volumeRatio >= TP_TRAIL_VOLUME_THRESHOLD && rsi >= TP_TRAIL_RSI_THRESHOLD;

  return { isSpike, volumeRatio, rsi };
}

// ---- Check Exit Conditions (with TP Trail) ----
export function checkExitConditions(
  position: BotPosition,
  currentPrice: number,
  strategy: StrategyConfig,
  ohlcv?: OHLCV[]
): { shouldSell: boolean; reason: string } {
  const pnlPercent = ((currentPrice - position.entry_price) / position.entry_price) * 100;

  // Stop Loss
  if (strategy.riskParams.stopLossPercent > 0 && pnlPercent <= -strategy.riskParams.stopLossPercent) {
    return { shouldSell: true, reason: `Stop loss hit (${pnlPercent.toFixed(2)}%)` };
  }

  // TP Trail Safety Cap — always sell at max hold regardless of momentum
  if (pnlPercent >= TP_TRAIL_MAX_HOLD_PERCENT) {
    return { shouldSell: true, reason: `TP Trail safety cap hit (+${pnlPercent.toFixed(2)}% >= ${TP_TRAIL_MAX_HOLD_PERCENT}%)` };
  }

  // Take Profit — with momentum override (TP Trail)
  if (strategy.riskParams.takeProfitPercent > 0 && pnlPercent >= strategy.riskParams.takeProfitPercent) {
    // If we have OHLCV data, check for momentum spike
    if (ohlcv && ohlcv.length >= 30) {
      const spike = detectMomentumSpike(ohlcv);
      if (spike.isSpike) {
        // Strong momentum detected — skip fixed TP, let trailing stop ride the wave
        log('info', `\uD83D\uDE80 TP TRAIL: ${position.pair} at +${pnlPercent.toFixed(2)}% — HOLDING through TP (Vol: ${spike.volumeRatio.toFixed(1)}x avg, RSI: ${spike.rsi.toFixed(0)})`);
        return { shouldSell: false, reason: '' };
      }
    }
    // No spike or no data — take profit normally
    return { shouldSell: true, reason: `Take profit hit (+${pnlPercent.toFixed(2)}%)` };
  }

  // Trailing Stop
  if (position.trailing_stop_price && currentPrice <= position.trailing_stop_price) {
    return { shouldSell: true, reason: `Trailing stop hit at $${position.trailing_stop_price.toFixed(2)}` };
  }

  return { shouldSell: false, reason: '' };
}

// ---- Update Trailing Stop ----
export function updateTrailingStop(
  position: BotPosition,
  currentPrice: number,
  strategy: StrategyConfig
): BotPosition {
  if (!strategy.riskParams.trailingStop) return position;

  const updated = { ...position };

  if (currentPrice > updated.highest_price) {
    updated.highest_price = currentPrice;
    const newTrailingStop = currentPrice * (1 - strategy.riskParams.trailingStopPercent / 100);

    if (!updated.trailing_stop_price || newTrailingStop > updated.trailing_stop_price) {
      updated.trailing_stop_price = newTrailingStop;
    }
  }

  return updated;
}
