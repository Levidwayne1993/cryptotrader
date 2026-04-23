// ============================================================
// All 6 trading strategy configurations â€” ported from original
// ============================================================

import { StrategyConfig, StrategyType } from './types';

export const STRATEGIES: Record<StrategyType, StrategyConfig> = {
  day_trader: {
    id: 'day_trader',
    name: 'Day Trader',
    shortName: 'DAY',
    description: 'Fast entries & exits within the same day.',
    intervalMs: 2 * 60 * 1000,
    riskParams: {
      stopLossPercent: 3,
      takeProfitPercent: 5,
      maxPositionPercent: 15,
      maxOpenPositions: 6,
      trailingStop: true,
      trailingStopPercent: 2,
      cooldownMs: 5 * 60 * 1000,
    },
    signalThresholds: { buyScore: 8, sellScore: -8, minConfidence: 35 },
    indicatorWeights: {
      rsi: 20, macd: 20, ema: 15, bollingerBands: 10,
      volume: 15, sentiment: 5, fearGreed: 3, momentum: 10, stochasticRsi: 2,
    },
  },

  swing_trader: {
    id: 'swing_trader',
    name: 'Swing Trader',
    shortName: 'SWING',
    description: 'Holds positions for days to weeks.',
    intervalMs: 4 * 60 * 60 * 1000,
    riskParams: {
      stopLossPercent: 10,
      takeProfitPercent: 25,
      maxPositionPercent: 25,
      maxOpenPositions: 4,
      trailingStop: true,
      trailingStopPercent: 6,
      cooldownMs: 4 * 60 * 60 * 1000,
    },
    signalThresholds: { buyScore: 30, sellScore: -20, minConfidence: 55 },
    indicatorWeights: {
      rsi: 10, macd: 15, ema: 25, bollingerBands: 10,
      volume: 10, sentiment: 10, fearGreed: 8, momentum: 10, stochasticRsi: 2,
    },
  },

  scalper: {
    id: 'scalper',
    name: 'Scalper',
    shortName: 'SCALP',
    description: 'Ultra-fast micro-trades.',
    intervalMs: 1 * 60 * 1000,
    riskParams: {
      stopLossPercent: 1.5,
      takeProfitPercent: 2.5,
      maxPositionPercent: 10,
      maxOpenPositions: 8,
      trailingStop: false,
      trailingStopPercent: 0,
      cooldownMs: 2 * 60 * 1000,
    },
    signalThresholds: { buyScore: 15, sellScore: -10, minConfidence: 40 },
    indicatorWeights: {
      rsi: 25, macd: 10, ema: 5, bollingerBands: 25,
      volume: 20, sentiment: 2, fearGreed: 1, momentum: 10, stochasticRsi: 2,
    },
  },

  dca: {
    id: 'dca',
    name: 'DCA Bot',
    shortName: 'DCA',
    description: 'Buys at regular intervals regardless of price.',
    intervalMs: 4 * 60 * 60 * 1000,
    riskParams: {
      stopLossPercent: 0,
      takeProfitPercent: 0,
      maxPositionPercent: 100,
      maxOpenPositions: 10,
      trailingStop: false,
      trailingStopPercent: 0,
      cooldownMs: 4 * 60 * 60 * 1000,
    },
    signalThresholds: { buyScore: 0, sellScore: -999, minConfidence: 0 },
    indicatorWeights: {
      rsi: 5, macd: 0, ema: 0, bollingerBands: 5,
      volume: 0, sentiment: 0, fearGreed: 10, momentum: 0, stochasticRsi: 0,
    },
  },

  contrarian: {
    id: 'contrarian',
    name: 'Contrarian',
    shortName: 'CONTRA',
    description: 'Buys fear, sells greed.',
    intervalMs: 30 * 60 * 1000,
    riskParams: {
      stopLossPercent: 15,
      takeProfitPercent: 30,
      maxPositionPercent: 20,
      maxOpenPositions: 5,
      trailingStop: true,
      trailingStopPercent: 8,
      cooldownMs: 60 * 60 * 1000,
    },
    signalThresholds: { buyScore: 25, sellScore: -20, minConfidence: 50 },
    indicatorWeights: {
      rsi: 10, macd: 5, ema: 5, bollingerBands: 5,
      volume: 10, sentiment: 25, fearGreed: 30, momentum: 5, stochasticRsi: 5,
    },
  },

  momentum: {
    id: 'momentum',
    name: 'Momentum Rider',
    shortName: 'MOMO',
    description: 'Rides strong trends and breakouts.',
    intervalMs: 10 * 60 * 1000,
    riskParams: {
      stopLossPercent: 7,
      takeProfitPercent: 18,
      maxPositionPercent: 20,
      maxOpenPositions: 5,
      trailingStop: true,
      trailingStopPercent: 5,
      cooldownMs: 15 * 60 * 1000,
    },
    signalThresholds: { buyScore: 25, sellScore: -18, minConfidence: 50 },
    indicatorWeights: {
      rsi: 10, macd: 20, ema: 20, bollingerBands: 5,
      volume: 20, sentiment: 5, fearGreed: 5, momentum: 15, stochasticRsi: 0,
    },
  },
};

export function getStrategy(id: StrategyType): StrategyConfig {
  return STRATEGIES[id];
}

export function getAllStrategies(): StrategyConfig[] {
  return Object.values(STRATEGIES);
}
