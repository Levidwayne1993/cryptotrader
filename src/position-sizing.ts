// ============================================================
// PROJECT: cryptotrader
// FILE: src/position-sizing.ts  (NEW FILE)
// DESCRIPTION: Kelly Criterion + ATR-based position sizing
// ============================================================

import { BotTrade, KellyResult, ATRPositionSize } from './types';

// ---- Kelly Criterion ----
// Calculates optimal position size based on historical win rate
// and average win/loss ratio. Uses Half-Kelly for safety.
//
// Formula: f* = (bp - q) / b
//   f* = fraction of bankroll to wager
//   b  = avg_win / avg_loss (odds)
//   p  = probability of winning
//   q  = probability of losing (1 - p)

export function calculateKellySizing(
  closedTrades: BotTrade[],
  currentBalance: number,
  maxKellyPercent: number = 25  // cap at 25% of portfolio
): KellyResult {
  const defaultResult: KellyResult = {
    kelly_fraction: 0,
    half_kelly: 0,
    position_size_usd: 0,
    win_rate: 0,
    avg_win: 0,
    avg_loss: 0,
    edge: 0,
  };

  // Need at least 10 closed trades for meaningful statistics
  if (closedTrades.length < 10) {
    // Use conservative default sizing (5% of portfolio)
    return {
      ...defaultResult,
      half_kelly: 5,
      position_size_usd: currentBalance * 0.05,
    };
  }

  const wins = closedTrades.filter(t => (t.pnl || 0) > 0);
  const losses = closedTrades.filter(t => (t.pnl || 0) < 0);

  if (wins.length === 0 || losses.length === 0) {
    return {
      ...defaultResult,
      half_kelly: 5,
      position_size_usd: currentBalance * 0.05,
    };
  }

  const winRate = wins.length / closedTrades.length;
  const lossRate = 1 - winRate;

  const avgWin = wins.reduce((sum, t) => sum + Math.abs(t.pnl_percent || 0), 0) / wins.length;
  const avgLoss = losses.reduce((sum, t) => sum + Math.abs(t.pnl_percent || 0), 0) / losses.length;

  if (avgLoss === 0) {
    return {
      ...defaultResult,
      win_rate: winRate * 100,
      avg_win: avgWin,
      half_kelly: maxKellyPercent / 2,
      position_size_usd: currentBalance * (maxKellyPercent / 200),
    };
  }

  // Kelly formula
  const b = avgWin / avgLoss;  // win/loss ratio
  const kellyFraction = ((b * winRate) - lossRate) / b;

  // Edge = expected value per trade
  const edge = (winRate * avgWin) - (lossRate * avgLoss);

  // Half-Kelly (more conservative, lower variance)
  const halfKelly = Math.max(0, kellyFraction / 2) * 100;

  // Cap at maximum
  const cappedKelly = Math.min(halfKelly, maxKellyPercent);

  const positionSize = currentBalance * (cappedKelly / 100);

  return {
    kelly_fraction: Math.round(kellyFraction * 10000) / 100,
    half_kelly: Math.round(cappedKelly * 100) / 100,
    position_size_usd: Math.round(positionSize * 100) / 100,
    win_rate: Math.round(winRate * 10000) / 100,
    avg_win: Math.round(avgWin * 100) / 100,
    avg_loss: Math.round(avgLoss * 100) / 100,
    edge: Math.round(edge * 100) / 100,
  };
}

// ---- ATR-Based Position Sizing ----
// Sizes positions based on volatility so you risk the same $ amount
// on every trade regardless of how volatile the coin is.
//
// Logic: If BTC has ATR of $2000 and SOL has ATR of $5,
//        you'd buy WAY less BTC to risk the same amount.
//
// Formula:
//   stop_distance = ATR * multiplier
//   shares = risk_amount / stop_distance
//   position_size = shares * current_price

export function calculateATRPositionSize(
  currentPrice: number,
  atr: number,
  currentBalance: number,
  riskPerTradePercent: number = 2,   // risk 2% of portfolio per trade
  atrMultiplier: number = 2.0        // stop at 2x ATR
): ATRPositionSize {
  if (atr <= 0 || currentPrice <= 0) {
    return {
      atr: 0,
      stop_distance: 0,
      stop_price: currentPrice,
      position_size_usd: currentBalance * 0.05,
      risk_amount: currentBalance * (riskPerTradePercent / 100),
      risk_percent: riskPerTradePercent,
    };
  }

  const riskAmount = currentBalance * (riskPerTradePercent / 100);
  const stopDistance = atr * atrMultiplier;
  const stopPrice = currentPrice - stopDistance;

  // How many units can we buy so that if price drops by stopDistance,
  // we only lose riskAmount?
  const units = riskAmount / stopDistance;
  const positionSize = units * currentPrice;

  // Cap at reasonable portion of portfolio
  const cappedPosition = Math.min(positionSize, currentBalance * 0.25);

  return {
    atr: Math.round(atr * 100) / 100,
    stop_distance: Math.round(stopDistance * 100) / 100,
    stop_price: Math.round(stopPrice * 100) / 100,
    position_size_usd: Math.round(cappedPosition * 100) / 100,
    risk_amount: Math.round(riskAmount * 100) / 100,
    risk_percent: riskPerTradePercent,
  };
}

// ---- Combined Smart Sizing ----
// Uses both Kelly and ATR to determine the best position size.
// Takes the MORE CONSERVATIVE of the two.

export function smartPositionSize(
  closedTrades: BotTrade[],
  currentPrice: number,
  atr: number,
  currentBalance: number,
  riskPerTradePercent: number = 2,
  maxKellyPercent: number = 25,
  atrMultiplier: number = 2.0
): { position_size_usd: number; method: string; kelly: KellyResult; atr_sizing: ATRPositionSize } {
  const kelly = calculateKellySizing(closedTrades, currentBalance, maxKellyPercent);
  const atrSizing = calculateATRPositionSize(
    currentPrice, atr, currentBalance, riskPerTradePercent, atrMultiplier
  );

  // Use the more conservative of the two
  let positionSize: number;
  let method: string;

  if (kelly.position_size_usd <= atrSizing.position_size_usd) {
    positionSize = kelly.position_size_usd;
    method = 'kelly';
  } else {
    positionSize = atrSizing.position_size_usd;
    method = 'atr';
  }

  // Floor: minimum $5 trade
  positionSize = Math.max(positionSize, 5);

  // Ceiling: never exceed 25% of balance
  positionSize = Math.min(positionSize, currentBalance * 0.25);

  return {
    position_size_usd: Math.round(positionSize * 100) / 100,
    method,
    kelly,
    atr_sizing: atrSizing,
  };
}
