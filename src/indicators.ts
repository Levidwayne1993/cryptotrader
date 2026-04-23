// ============================================================
// Technical analysis indicators — ported from original codebase
// All pure functions, no dependencies
// ============================================================

import { MACD, BollingerBands, FullIndicators } from './types';

// — Simple Moving Average
export function sma(data: number[], period: number): number {
  if (data.length < period) return data[data.length - 1] || 0;
  const slice = data.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// — Exponential Moving Average
export function ema(data: number[], period: number): number {
  if (data.length === 0) return 0;
  if (data.length < period) return sma(data, data.length);
  const k = 2 / (period + 1);
  let emaValue = sma(data.slice(0, period), period);
  for (let i = period; i < data.length; i++) {
    emaValue = data[i] * k + emaValue * (1 - k);
  }
  return emaValue;
}

// — Full EMA Series (for MACD)
function emaSeries(data: number[], period: number): number[] {
  if (data.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];
  let emaVal = sma(data.slice(0, period), period);
  for (let i = 0; i < data.length; i++) {
    if (i < period) {
      result.push(sma(data.slice(0, i + 1), i + 1));
    } else {
      emaVal = data[i] * k + emaVal * (1 - k);
      result.push(emaVal);
    }
  }
  return result;
}

// — RSI (Relative Strength Index)
export function rsi(data: number[], period: number = 14): number {
  if (data.length < period + 1) return 50;
  const changes: number[] = [];
  for (let i = 1; i < data.length; i++) {
    changes.push(data[i] - data[i - 1]);
  }
  const recentChanges = changes.slice(-period);
  let avgGain = 0;
  let avgLoss = 0;
  for (const change of recentChanges) {
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// — Stochastic RSI
export function stochasticRsi(
  data: number[],
  rsiPeriod: number = 14,
  stochPeriod: number = 14
): number {
  if (data.length < rsiPeriod + stochPeriod) return 50;
  const rsiValues: number[] = [];
  for (let i = rsiPeriod + 1; i <= data.length; i++) {
    rsiValues.push(rsi(data.slice(0, i), rsiPeriod));
  }
  const recentRsi = rsiValues.slice(-stochPeriod);
  const currentRsi = recentRsi[recentRsi.length - 1];
  const minRsi = Math.min(...recentRsi);
  const maxRsi = Math.max(...recentRsi);
  if (maxRsi === minRsi) return 50;
  return ((currentRsi - minRsi) / (maxRsi - minRsi)) * 100;
}

// — MACD
export function macd(
  data: number[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): MACD {
  if (data.length < slowPeriod) {
    return { value: 0, signal: 0, histogram: 0 };
  }
  const fastEma = emaSeries(data, fastPeriod);
  const slowEma = emaSeries(data, slowPeriod);
  const macdLine: number[] = [];
  for (let i = 0; i < data.length; i++) {
    macdLine.push(fastEma[i] - slowEma[i]);
  }
  const signalLine = emaSeries(macdLine.slice(slowPeriod - 1), signalPeriod);
  const currentMacd = macdLine[macdLine.length - 1];
  const currentSignal = signalLine[signalLine.length - 1];
  return {
    value: currentMacd,
    signal: currentSignal,
    histogram: currentMacd - currentSignal,
  };
}

// — Bollinger Bands
export function bollingerBands(
  data: number[],
  period: number = 20,
  stdDevMultiplier: number = 2
): BollingerBands {
  if (data.length < period) {
    const avg = sma(data, data.length);
    return { upper: avg, middle: avg, lower: avg };
  }
  const slice = data.slice(-period);
  const middle = sma(slice, period);
  const squaredDiffs = slice.map((v) => Math.pow(v - middle, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    upper: middle + stdDev * stdDevMultiplier,
    middle,
    lower: middle - stdDev * stdDevMultiplier,
  };
}

// — Momentum (Rate of Change)
export function momentum(data: number[], period: number = 10): number {
  if (data.length < period + 1) return 0;
  const current = data[data.length - 1];
  const past = data[data.length - 1 - period];
  if (past === 0) return 0;
  return ((current - past) / past) * 100;
}

// — Volume Change %
export function volumeChange(volumes: number[], period: number = 5): number {
  if (volumes.length < period + 1) return 0;
  const recentAvg = sma(volumes.slice(-period), period);
  const prevAvg = sma(volumes.slice(-(period * 2), -period), period);
  if (prevAvg === 0) return 0;
  return ((recentAvg - prevAvg) / prevAvg) * 100;
}

// — Price vs EMA (% deviation)
export function priceVsEma(price: number, emaValue: number): number {
  if (emaValue === 0) return 0;
  return ((price - emaValue) / emaValue) * 100;
}

// — Price position relative to Bollinger Bands
export function priceVsBollinger(
  price: number,
  bands: BollingerBands
): 'above_upper' | 'below_lower' | 'within' {
  if (price > bands.upper) return 'above_upper';
  if (price < bands.lower) return 'below_lower';
  return 'within';
}

// — Full Analysis Bundle
export function calculateAllIndicators(
  prices: number[],
  volumes: number[],
  shortPeriod: number = 9,
  longPeriod: number = 21
): FullIndicators {
  const currentPrice = prices[prices.length - 1] || 0;
  const emaShort = ema(prices, shortPeriod);
  const emaLong = ema(prices, longPeriod);
  const bb = bollingerBands(prices);
  return {
    rsi: rsi(prices),
    stochasticRsi: stochasticRsi(prices),
    macd: macd(prices),
    emaShort,
    emaLong,
    bollingerBands: bb,
    momentum: momentum(prices),
    volumeChange: volumeChange(volumes),
    priceVsEma: priceVsEma(currentPrice, emaLong),
    priceVsBollinger: priceVsBollinger(currentPrice, bb),
  };
}
