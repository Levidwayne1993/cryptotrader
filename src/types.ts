// ============================================================
// Core type definitions for the trading bot
// ============================================================

export type StrategyType =
  | 'day_trader'
  | 'swing_trader'
  | 'scalper'
  | 'dca'
  | 'contrarian'
  | 'momentum';

export type TradeAction = 'BUY' | 'SELL' | 'HOLD';
export type TradeMode = 'paper' | 'live';

export interface StrategyConfig {
  id: StrategyType;
  name: string;
  shortName: string;
  description: string;
  intervalMs: number;
  riskParams: {
    stopLossPercent: number;
    takeProfitPercent: number;
    maxPositionPercent: number;
    maxOpenPositions: number;
    trailingStop: boolean;
    trailingStopPercent: number;
    cooldownMs: number;
  };
  signalThresholds: {
    buyScore: number;
    sellScore: number;
    minConfidence: number;
  };
  indicatorWeights: {
    rsi: number;
    macd: number;
    ema: number;
    bollingerBands: number;
    volume: number;
    sentiment: number;
    fearGreed: number;
    momentum: number;
    stochasticRsi: number;
  };
}

export interface MACD {
  value: number;
  signal: number;
  histogram: number;
}

export interface BollingerBands {
  upper: number;
  middle: number;
  lower: number;
}

export interface FullIndicators {
  rsi: number;
  stochasticRsi: number;
  macd: MACD;
  emaShort: number;
  emaLong: number;
  bollingerBands: BollingerBands;
  momentum: number;
  volumeChange: number;
  priceVsEma: number;
  priceVsBollinger: 'above_upper' | 'below_lower' | 'within';
}

export interface IndicatorSnapshot {
  rsi: number;
  macd: MACD;
  ema_short: number;
  ema_long: number;
  bollinger: BollingerBands;
  volume_change: number;
  momentum: number;
  stochastic_rsi: number;
  fear_greed: number;
  sentiment_score: number;
  price_vs_ema: number;
  price_vs_bollinger: string;
}

export interface AnalysisResult {
  coin_id: string;
  symbol: string;
  pair: string;
  current_price: number;
  action: TradeAction;
  score: number;
  confidence: number;
  reasoning: string[];
  indicators: IndicatorSnapshot;
  strategy: StrategyType;
  timestamp: string;
}

export interface BotPosition {
  coin_id: string;
  symbol: string;
  pair: string;
  entry_price: number;
  current_price: number;
  quantity: number;
  position_value: number;
  unrealized_pnl: number;
  unrealized_pnl_percent: number;
  stop_loss_price: number;
  take_profit_price: number;
  trailing_stop_price?: number;
  highest_price: number;
  strategy: StrategyType;
  opened_at: string;
  order_id?: string;
}

export interface BotTrade {
  id?: string;
  coin_id: string;
  symbol: string;
  pair: string;
  action: 'BUY' | 'SELL';
  strategy: StrategyType;
  entry_price: number;
  exit_price?: number;
  quantity: number;
  position_value: number;
  pnl?: number;
  pnl_percent?: number;
  score: number;
  confidence: number;
  reasoning: string[];
  status: 'open' | 'closed';
  stop_loss_price: number;
  take_profit_price: number;
  trailing_stop_price?: number;
  opened_at: string;
  closed_at?: string;
  order_id?: string;
  mode: TradeMode;
}

export interface BotSettings {
  enabled: boolean;
  strategy: StrategyType;
  mode: TradeMode;
  initial_balance: number;
  current_balance: number;
  selected_pairs: string[];
  max_daily_trades: number;
  daily_loss_limit_percent: number;
}

export interface CoinMarketData {
  symbol: string;
  pair: string;
  current_price: number;
  price_change_24h: number;
  volume_24h: number;
  market_cap: number;
  ohlcv: OHLCV[];
}

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
