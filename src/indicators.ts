// ============================================================
// PROJECT: cryptotrader
// FILE: src/indicators.ts
// DESCRIPTION: All technical indicators — original + pro-grade
//   NEW: ADX, ATR, OBV, VWAP, Ichimoku Cloud, Fibonacci
// ============================================================

import {
  OHLCV,
  ADXResult,
  ATRResult,
  OBVResult,
  VWAPResult,
  IchimokuResult,
  FibonacciResult,
  FibLevel,
} from './types';

// ============================================================
// EXISTING INDICATORS (preserved from original)
// ============================================================

export function calculateRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

export function calculateEMA(data: number[], period: number): number[] {
  if (data.length === 0) return [];
  const k = 2 / (period + 1);
  const ema: number[] = [data[0]];
  for (let i = 1; i < data.length; i++) {
    ema.push(data[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

export function calculateSMA(data: number[], period: number): number[] {
  const sma: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      sma.push(data[i]);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += data[j];
    }
    sma.push(sum / period);
  }
  return sma;
}

export function calculateMACD(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
): { macd: number; signal: number; histogram: number } {
  if (closes.length < slowPeriod + signalPeriod) {
    return { macd: 0, signal: 0, histogram: 0 };
  }
  const fastEma = calculateEMA(closes, fastPeriod);
  const slowEma = calculateEMA(closes, slowPeriod);
  const macdLine: number[] = fastEma.map((v, i) => v - slowEma[i]);
  const signalLine = calculateEMA(macdLine, signalPeriod);
  const last = macdLine.length - 1;
  return {
    macd: macdLine[last],
    signal: signalLine[last],
    histogram: macdLine[last] - signalLine[last],
  };
}

export function calculateBollingerBands(
  closes: number[],
  period = 20,
  stdDevMultiplier = 2
): { upper: number; middle: number; lower: number; bandwidth: number } {
  if (closes.length < period) {
    const last = closes[closes.length - 1] || 0;
    return { upper: last, middle: last, lower: last, bandwidth: 0 };
  }
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  const upper = mean + stdDevMultiplier * stdDev;
  const lower = mean - stdDevMultiplier * stdDev;
  return {
    upper,
    middle: mean,
    lower,
    bandwidth: upper - lower,
  };
}

export function calculateStochasticRSI(
  closes: number[],
  rsiPeriod = 14,
  stochPeriod = 14,
  kSmooth = 3,
  dSmooth = 3
): { k: number; d: number } {
  if (closes.length < rsiPeriod + stochPeriod) return { k: 50, d: 50 };

  // Calculate RSI series
  const rsiValues: number[] = [];
  for (let i = rsiPeriod; i < closes.length; i++) {
    const slice = closes.slice(i - rsiPeriod, i + 1);
    rsiValues.push(calculateRSI(slice, rsiPeriod));
  }

  if (rsiValues.length < stochPeriod) return { k: 50, d: 50 };

  // Stochastic of RSI
  const stochK: number[] = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const slice = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const min = Math.min(...slice);
    const max = Math.max(...slice);
    const range = max - min;
    stochK.push(range === 0 ? 50 : ((rsiValues[i] - min) / range) * 100);
  }

  // Smooth K
  const smoothedK = calculateSMA(stochK, kSmooth);
  // Smooth D
  const smoothedD = calculateSMA(smoothedK, dSmooth);

  return {
    k: smoothedK[smoothedK.length - 1] || 50,
    d: smoothedD[smoothedD.length - 1] || 50,
  };
}

export function calculateMomentum(closes: number[], period = 10): number {
  if (closes.length < period + 1) return 0;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - 1 - period];
  return ((current - past) / past) * 100;
}

export function calculateVolumeChange(volumes: number[], period = 20): number {
  if (volumes.length < period + 1) return 0;
  const recentAvg =
    volumes.slice(-period).reduce((a, b) => a + b, 0) / period;
  const currentVol = volumes[volumes.length - 1];
  if (recentAvg === 0) return 0;
  return ((currentVol - recentAvg) / recentAvg) * 100;
}

// ============================================================
// NEW PRO INDICATORS
// ============================================================

// ---- ADX (Average Directional Index) ----
// Measures TREND STRENGTH (not direction)
// ADX > 25 = trending, ADX < 20 = ranging
// +DI > -DI = bullish, -DI > +DI = bearish
export function calculateADX(candles: OHLCV[], period = 14): ADXResult {
  if (candles.length < period * 2) {
    return { adx: 0, plus_di: 0, minus_di: 0, trending: false, trend_direction: 'neutral' };
  }

  const tr: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevHigh = candles[i - 1].high;
    const prevLow = candles[i - 1].low;
    const prevClose = candles[i - 1].close;

    // True Range
    tr.push(Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    ));

    // Directional Movement
    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Smooth using Wilder's method
  const smoothTR = wildersSmooth(tr, period);
  const smoothPlusDM = wildersSmooth(plusDM, period);
  const smoothMinusDM = wildersSmooth(minusDM, period);

  // Calculate +DI and -DI
  const plusDI: number[] = [];
  const minusDI: number[] = [];
  const dx: number[] = [];

  for (let i = 0; i < smoothTR.length; i++) {
    const pdi = smoothTR[i] !== 0 ? (smoothPlusDM[i] / smoothTR[i]) * 100 : 0;
    const mdi = smoothTR[i] !== 0 ? (smoothMinusDM[i] / smoothTR[i]) * 100 : 0;
    plusDI.push(pdi);
    minusDI.push(mdi);

    const diSum = pdi + mdi;
    dx.push(diSum !== 0 ? (Math.abs(pdi - mdi) / diSum) * 100 : 0);
  }

  // ADX = smoothed DX
  const adxValues = wildersSmooth(dx, period);
  const lastADX = adxValues[adxValues.length - 1] || 0;
  const lastPlusDI = plusDI[plusDI.length - 1] || 0;
  const lastMinusDI = minusDI[minusDI.length - 1] || 0;

  let direction: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (lastPlusDI > lastMinusDI + 3) direction = 'bullish';
  else if (lastMinusDI > lastPlusDI + 3) direction = 'bearish';

  return {
    adx: Math.round(lastADX * 100) / 100,
    plus_di: Math.round(lastPlusDI * 100) / 100,
    minus_di: Math.round(lastMinusDI * 100) / 100,
    trending: lastADX > 25,
    trend_direction: direction,
  };
}

// ---- ATR (Average True Range) ----
// Measures VOLATILITY — used for dynamic stop losses
// Higher ATR = more volatile, need wider stops
export function calculateATR(candles: OHLCV[], period = 14): ATRResult {
  if (candles.length < period + 1) {
    return { atr: 0, atr_percent: 0, volatility: 'normal', atr_sma: 0, expanding: false };
  }

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    trueRanges.push(Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    ));
  }

  // ATR using Wilder's smoothing
  const atrValues = wildersSmooth(trueRanges, period);
  const currentATR = atrValues[atrValues.length - 1] || 0;
  const currentPrice = candles[candles.length - 1].close;
  const atrPercent = currentPrice > 0 ? (currentATR / currentPrice) * 100 : 0;

  // ATR SMA for comparison (is volatility expanding?)
  const atrSMA = atrValues.length >= 20
    ? atrValues.slice(-20).reduce((a, b) => a + b, 0) / 20
    : currentATR;

  const expanding = currentATR > atrSMA * 1.1;

  // Classify volatility
  let volatility: 'low' | 'normal' | 'high' | 'extreme' = 'normal';
  if (atrPercent < 1) volatility = 'low';
  else if (atrPercent < 3) volatility = 'normal';
  else if (atrPercent < 6) volatility = 'high';
  else volatility = 'extreme';

  return {
    atr: Math.round(currentATR * 100) / 100,
    atr_percent: Math.round(atrPercent * 100) / 100,
    volatility,
    atr_sma: Math.round(atrSMA * 100) / 100,
    expanding,
  };
}

// ---- OBV (On-Balance Volume) ----
// Tracks cumulative volume flow — confirms price moves
// Rising OBV + Rising price = strong trend
// Divergence = potential reversal
export function calculateOBV(candles: OHLCV[], smaPeriod = 20): OBVResult {
  if (candles.length < smaPeriod + 1) {
    return { obv: 0, obv_sma: 0, obv_trend: 'flat', divergence: 'none' };
  }

  const obvValues: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    const prevOBV = obvValues[i - 1];
    if (candles[i].close > candles[i - 1].close) {
      obvValues.push(prevOBV + candles[i].volume);
    } else if (candles[i].close < candles[i - 1].close) {
      obvValues.push(prevOBV - candles[i].volume);
    } else {
      obvValues.push(prevOBV);
    }
  }

  const currentOBV = obvValues[obvValues.length - 1];
  const obvSMA = obvValues.slice(-smaPeriod).reduce((a, b) => a + b, 0) / smaPeriod;

  // OBV trend (compare last 5 values)
  const recentOBV = obvValues.slice(-5);
  let obvTrend: 'rising' | 'falling' | 'flat' = 'flat';
  if (recentOBV.length >= 5) {
    const obvChange = recentOBV[recentOBV.length - 1] - recentOBV[0];
    const avgVol = candles.slice(-5).reduce((a, c) => a + c.volume, 0) / 5;
    if (obvChange > avgVol * 0.5) obvTrend = 'rising';
    else if (obvChange < -avgVol * 0.5) obvTrend = 'falling';
  }

  // Divergence detection
  const recentPrices = candles.slice(-10);
  let divergence: 'bullish' | 'bearish' | 'none' = 'none';
  if (recentPrices.length >= 10) {
    const priceUp = recentPrices[recentPrices.length - 1].close > recentPrices[0].close;
    const priceDown = recentPrices[recentPrices.length - 1].close < recentPrices[0].close;
    const recentOBVSlice = obvValues.slice(-10);
    const obvUp = recentOBVSlice[recentOBVSlice.length - 1] > recentOBVSlice[0];
    const obvDown = recentOBVSlice[recentOBVSlice.length - 1] < recentOBVSlice[0];

    if (priceDown && obvUp) divergence = 'bullish';   // price falling but volume accumulating
    if (priceUp && obvDown) divergence = 'bearish';    // price rising but volume declining
  }

  return {
    obv: Math.round(currentOBV),
    obv_sma: Math.round(obvSMA),
    obv_trend: obvTrend,
    divergence,
  };
}

// ---- VWAP (Volume Weighted Average Price) ----
// Institutional benchmark — "fair price" for the session
// Price above VWAP = bullish, below = bearish
export function calculateVWAP(candles: OHLCV[]): VWAPResult {
  if (candles.length < 2) {
    const p = candles[0]?.close || 0;
    return { vwap: p, price_vs_vwap: 0, position: 'at', upper_band: p, lower_band: p };
  }

  let cumulativeTPV = 0;  // typical price * volume
  let cumulativeVol = 0;
  const vwapValues: number[] = [];

  for (const candle of candles) {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    cumulativeTPV += typicalPrice * candle.volume;
    cumulativeVol += candle.volume;
    vwapValues.push(cumulativeVol > 0 ? cumulativeTPV / cumulativeVol : typicalPrice);
  }

  const vwap = vwapValues[vwapValues.length - 1];
  const currentPrice = candles[candles.length - 1].close;
  const priceVsVwap = vwap > 0 ? ((currentPrice - vwap) / vwap) * 100 : 0;

  // VWAP standard deviation bands
  let sumSqDiff = 0;
  for (let i = 0; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    sumSqDiff += Math.pow(tp - vwap, 2) * candles[i].volume;
  }
  const stdDev = cumulativeVol > 0 ? Math.sqrt(sumSqDiff / cumulativeVol) : 0;

  let position: 'above' | 'below' | 'at' = 'at';
  if (currentPrice > vwap + stdDev * 0.5) position = 'above';
  else if (currentPrice < vwap - stdDev * 0.5) position = 'below';

  return {
    vwap: Math.round(vwap * 100) / 100,
    price_vs_vwap: Math.round(priceVsVwap * 100) / 100,
    position,
    upper_band: Math.round((vwap + 2 * stdDev) * 100) / 100,
    lower_band: Math.round((vwap - 2 * stdDev) * 100) / 100,
  };
}

// ---- ICHIMOKU CLOUD ----
// All-in-one trend system: trend, momentum, support/resistance
// 5 signals: TK cross, price vs cloud, cloud color, chikou, cloud thickness
export function calculateIchimoku(candles: OHLCV[]): IchimokuResult {
  const defaultResult: IchimokuResult = {
    tenkan: 0, kijun: 0, senkou_a: 0, senkou_b: 0, chikou: 0,
    cloud_color: 'red', price_vs_cloud: 'below', tk_cross: 'none', signal_strength: 0,
  };

  if (candles.length < 52) return defaultResult;

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const currentPrice = closes[closes.length - 1];

  // Tenkan-sen (Conversion Line): (9-period high + 9-period low) / 2
  const tenkan = midpoint(highs, lows, 9);

  // Kijun-sen (Base Line): (26-period high + 26-period low) / 2
  const kijun = midpoint(highs, lows, 26);

  // Senkou Span A (Leading Span A): (Tenkan + Kijun) / 2, plotted 26 periods ahead
  const senkou_a = (tenkan + kijun) / 2;

  // Senkou Span B (Leading Span B): (52-period high + 52-period low) / 2, plotted 26 periods ahead
  const senkou_b = midpoint(highs, lows, 52);

  // Chikou Span (Lagging Span): current close, plotted 26 periods back
  const chikou = currentPrice;

  // Cloud color
  const cloud_color = senkou_a >= senkou_b ? 'green' : 'red';

  // Price vs Cloud
  const cloudTop = Math.max(senkou_a, senkou_b);
  const cloudBottom = Math.min(senkou_a, senkou_b);
  let price_vs_cloud: 'above' | 'inside' | 'below' = 'inside';
  if (currentPrice > cloudTop) price_vs_cloud = 'above';
  else if (currentPrice < cloudBottom) price_vs_cloud = 'below';

  // TK Cross
  const prevTenkan = midpoint(
    highs.slice(0, -1), lows.slice(0, -1), 9
  );
  const prevKijun = midpoint(
    highs.slice(0, -1), lows.slice(0, -1), 26
  );
  let tk_cross: 'bullish' | 'bearish' | 'none' = 'none';
  if (tenkan > kijun && prevTenkan <= prevKijun) tk_cross = 'bullish';
  else if (tenkan < kijun && prevTenkan >= prevKijun) tk_cross = 'bearish';

  // Signal strength (0-5)
  let signal_strength = 0;
  if (price_vs_cloud === 'above') signal_strength++;  // price above cloud
  if (cloud_color === 'green') signal_strength++;      // bullish cloud
  if (tenkan > kijun) signal_strength++;               // TK bullish
  if (tk_cross === 'bullish') signal_strength++;        // fresh cross
  // Chikou above price 26 periods ago
  if (candles.length >= 27) {
    const price26ago = closes[closes.length - 27];
    if (chikou > price26ago) signal_strength++;
  }

  return {
    tenkan: Math.round(tenkan * 100) / 100,
    kijun: Math.round(kijun * 100) / 100,
    senkou_a: Math.round(senkou_a * 100) / 100,
    senkou_b: Math.round(senkou_b * 100) / 100,
    chikou: Math.round(chikou * 100) / 100,
    cloud_color,
    price_vs_cloud,
    tk_cross,
    signal_strength,
  };
}

// ---- FIBONACCI RETRACEMENTS ----
// Key support/resistance levels based on swing high/low
// Levels: 0%, 23.6%, 38.2%, 50%, 61.8%, 78.6%, 100%
export function calculateFibonacci(candles: OHLCV[], lookback = 50): FibonacciResult {
  if (candles.length < lookback) {
    const p = candles[candles.length - 1]?.close || 0;
    return {
      levels: [], trend: 'up', nearest_support: p, nearest_resistance: p, current_zone: 'unknown',
    };
  }

  const slice = candles.slice(-lookback);
  const highs = slice.map(c => c.high);
  const lows = slice.map(c => c.low);
  const swingHigh = Math.max(...highs);
  const swingLow = Math.min(...lows);
  const currentPrice = candles[candles.length - 1].close;

  // Determine trend direction
  const highIndex = highs.indexOf(swingHigh);
  const lowIndex = lows.indexOf(swingLow);
  const trend: 'up' | 'down' = highIndex > lowIndex ? 'up' : 'down';

  const diff = swingHigh - swingLow;
  const fibRatios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const fibLabels = ['0%', '23.6%', '38.2%', '50%', '61.8%', '78.6%', '100%'];

  const levels: FibLevel[] = fibRatios.map((ratio, i) => {
    const price = trend === 'up'
      ? swingHigh - diff * ratio   // retracement from high
      : swingLow + diff * ratio;   // retracement from low
    return { level: ratio, price: Math.round(price * 100) / 100, label: fibLabels[i] };
  });

  // Find nearest support and resistance
  const sortedLevels = [...levels].sort((a, b) => a.price - b.price);
  let nearestSupport = sortedLevels[0].price;
  let nearestResistance = sortedLevels[sortedLevels.length - 1].price;
  let currentZone = 'outside';

  for (let i = 0; i < sortedLevels.length - 1; i++) {
    if (currentPrice >= sortedLevels[i].price && currentPrice <= sortedLevels[i + 1].price) {
      nearestSupport = sortedLevels[i].price;
      nearestResistance = sortedLevels[i + 1].price;
      currentZone = `between ${sortedLevels[i].label} and ${sortedLevels[i + 1].label}`;
      break;
    }
  }

  return {
    levels,
    trend,
    nearest_support: nearestSupport,
    nearest_resistance: nearestResistance,
    current_zone: currentZone,
  };
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function wildersSmooth(data: number[], period: number): number[] {
  if (data.length < period) return data;
  const result: number[] = [];

  // First value = SMA
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  result.push(sum / period);

  // Subsequent values use Wilder's smoothing
  for (let i = period; i < data.length; i++) {
    result.push((result[result.length - 1] * (period - 1) + data[i]) / period);
  }
  return result;
}

function midpoint(highs: number[], lows: number[], period: number): number {
  const h = highs.slice(-period);
  const l = lows.slice(-period);
  return (Math.max(...h) + Math.min(...l)) / 2;
}
