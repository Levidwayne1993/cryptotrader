// ============================================================
// PROJECT: cryptotrader
// FILE: src/types.ts  (UPDATED — replaces existing file)
// DESCRIPTION: Complete type definitions for all pro features
//   NOW INCLUDES:
//   - Partial Take Profit (laddered TP) fields
//   - DCA Safety Order fields
//   - Dynamic SL Tightening support
// ============================================================

// ---- Core Enums ----
export type TradeMode = 'paper' | 'live';
export type StrategyType = 'day_trader' | 'swing_trader' | 'scalper' | 'dca' | 'contrarian' | 'momentum';
export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export type AlertChannel = 'discord' | 'telegram' | 'both';

// ---- Bot Settings ----
export interface BotSettings {
  enabled: boolean;
  strategy: StrategyType;
  mode: TradeMode;
  initial_balance: number;
  current_balance: number;
  selected_pairs: string[];
  max_daily_trades: number;
  daily_loss_limit_percent: number;
  // Pro features
  alerts_enabled?: boolean;
  alert_channels?: AlertChannel[];
  discord_webhook_url?: string;
  telegram_bot_token?: string;
  telegram_chat_id?: string;
  circuit_breaker?: CircuitBreakerConfig;
  correlation_guard_enabled?: boolean;
  max_correlated_positions?: number;
  kelly_sizing_enabled?: boolean;
  whale_tracking_enabled?: boolean;
}

// ---- Circuit Breaker ----
export interface CircuitBreakerConfig {
  max_daily_loss_percent: number;
  max_consecutive_losses: number;
  volatility_pause_multiplier: number;  // pause if ATR > normal * this
  cooldown_minutes: number;
}

export interface CircuitBreakerState {
  is_tripped: boolean;
  reason: string;
  tripped_at: string | null;
  resume_at: string | null;
  daily_loss_percent: number;
  consecutive_losses: number;
  trades_today: number;
}

// ---- Market Data ----
export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketData {
  pair: string;
  symbol: string;
  current_price: number;
  ohlcv: OHLCV[];
  volume_24h: number;
  price_change_24h: number;
  bid?: number;
  ask?: number;
  spread?: number;
}

export interface MultiTimeframeData {
  pair: string;
  symbol: string;
  current_price: number;
  timeframes: Record<Timeframe, OHLCV[]>;
  volume_24h: number;
  price_change_24h: number;
}

// ---- Order Book ----
export interface OrderBookLevel {
  price: number;
  amount: number;
  total: number;  // cumulative
}

export interface OrderBookData {
  pair: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  spread: number;
  spread_percent: number;
  bid_depth: number;    // total bid volume
  ask_depth: number;    // total ask volume
  imbalance: number;    // bid_depth / ask_depth ratio
  timestamp: number;
}

// ---- Indicators ----
export interface IndicatorResults {
  // Existing
  rsi: number;
  macd: { macd: number; signal: number; histogram: number };
  ema_short: number;
  ema_long: number;
  bollinger: { upper: number; middle: number; lower: number; bandwidth: number };
  stochastic_rsi: { k: number; d: number };
  volume_change: number;
  momentum: number;
  fear_greed: number;
  sentiment: number;
  // NEW — Pro Indicators
  adx: ADXResult;
  atr: ATRResult;
  obv: OBVResult;
  vwap: VWAPResult;
  ichimoku: IchimokuResult;
  fibonacci: FibonacciResult;
}

export interface ADXResult {
  adx: number;         // 0–100, trend strength
  plus_di: number;     // +DI (bullish directional)
  minus_di: number;    // -DI (bearish directional)
  trending: boolean;   // adx > 25
  trend_direction: 'bullish' | 'bearish' | 'neutral';
}

export interface ATRResult {
  atr: number;
  atr_percent: number;     // ATR as % of price
  volatility: 'low' | 'normal' | 'high' | 'extreme';
  atr_sma: number;         // SMA of ATR for comparison
  expanding: boolean;      // volatility increasing
}

export interface OBVResult {
  obv: number;
  obv_sma: number;
  obv_trend: 'rising' | 'falling' | 'flat';
  divergence: 'bullish' | 'bearish' | 'none';  // price vs OBV divergence
}

export interface VWAPResult {
  vwap: number;
  price_vs_vwap: number;   // % above/below VWAP
  position: 'above' | 'below' | 'at';
  upper_band: number;      // VWAP + 2 std dev
  lower_band: number;      // VWAP - 2 std dev
}

export interface IchimokuResult {
  tenkan: number;          // Conversion Line (9-period)
  kijun: number;           // Base Line (26-period)
  senkou_a: number;        // Leading Span A
  senkou_b: number;        // Leading Span B
  chikou: number;          // Lagging Span
  cloud_color: 'green' | 'red';
  price_vs_cloud: 'above' | 'inside' | 'below';
  tk_cross: 'bullish' | 'bearish' | 'none';
  signal_strength: number; // 0–5 based on how many conditions align
}

export interface FibonacciResult {
  levels: FibLevel[];
  trend: 'up' | 'down';
  nearest_support: number;
  nearest_resistance: number;
  current_zone: string;    // e.g., "between 38.2% and 50%"
}

export interface FibLevel {
  level: number;     // 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1
  price: number;
  label: string;     // "23.6%", "38.2%", etc.
}

// ---- Multi-Timeframe Analysis ----
export interface TimeframeSignal {
  timeframe: Timeframe;
  trend: 'bullish' | 'bearish' | 'neutral';
  strength: number;   // 0–100
  rsi: number;
  macd_histogram: number;
  ema_trend: 'bullish' | 'bearish';
}

export interface MultiTimeframeResult {
  signals: TimeframeSignal[];
  alignment: number;        // % of timeframes agreeing
  dominant_trend: 'bullish' | 'bearish' | 'neutral';
  score_bonus: number;      // added to main score when aligned
  conflicting: boolean;     // short-term vs long-term disagree
}

// ---- Whale Tracking ----
export interface WhaleAlert {
  id: string;
  coin: string;
  amount: number;
  amount_usd: number;
  from_type: 'exchange' | 'wallet' | 'unknown';
  to_type: 'exchange' | 'wallet' | 'unknown';
  from_exchange?: string;
  to_exchange?: string;
  timestamp: number;
  signal: 'bearish' | 'bullish' | 'neutral';
  // Bearish: large move TO exchange (likely selling)
  // Bullish: large move FROM exchange (likely holding)
}

export interface WhaleData {
  pair: string;
  recent_alerts: WhaleAlert[];
  net_exchange_flow: number;  // positive = inflow (bearish), negative = outflow (bullish)
  large_tx_count_24h: number;
  whale_sentiment: number;    // -100 to +100
}

// ---- Liquidation Data ----
export interface LiquidationCluster {
  price: number;
  long_liquidation_usd: number;
  short_liquidation_usd: number;
  total_usd: number;
}

export interface LiquidationData {
  pair: string;
  clusters: LiquidationCluster[];
  nearest_long_liquidation: number;   // price below
  nearest_short_liquidation: number;  // price above
  liquidation_24h_usd: number;
  dominant_direction: 'longs' | 'shorts' | 'balanced';
}

// ---- Funding Rate ----
export interface FundingRateData {
  pair: string;
  current_rate: number;       // positive = longs pay shorts
  predicted_rate: number;
  rate_8h_avg: number;
  sentiment: 'overleveraged_longs' | 'overleveraged_shorts' | 'neutral';
  annualized_rate: number;
}

// ---- Correlation ----
export interface CorrelationData {
  pair_a: string;
  pair_b: string;
  correlation: number;  // -1 to +1
  period: number;       // in candles
}

export interface CorrelationMatrix {
  pairs: string[];
  matrix: number[][];   // correlation coefficients
  highly_correlated: Array<{ pair_a: string; pair_b: string; correlation: number }>;
}

// ---- Position Sizing ----
export interface KellyResult {
  kelly_fraction: number;      // raw Kelly %
  half_kelly: number;          // conservative (half Kelly)
  position_size_usd: number;   // actual $ amount
  win_rate: number;
  avg_win: number;
  avg_loss: number;
  edge: number;                // expected value per trade
}

export interface ATRPositionSize {
  atr: number;
  stop_distance: number;       // ATR * multiplier
  stop_price: number;
  position_size_usd: number;
  risk_amount: number;         // $ risked on the trade
  risk_percent: number;        // % of portfolio risked
}

// ---- Strategy Config ----
export interface RiskParams {
  stopLossPercent: number;
  takeProfitPercent: number;
  maxPositionPercent: number;
  maxOpenPositions: number;
  trailingStop: boolean;
  trailingStopPercent: number;
  cooldownMs: number;
  // Pro additions
  useAtrStops?: boolean;
  atrStopMultiplier?: number;    // e.g., 2.0 = stop at 2x ATR
  useKellySizing?: boolean;
  maxKellyPercent?: number;      // cap Kelly at this %
  riskPerTradePercent?: number;  // for ATR-based sizing
  // ============================================================
  // PARTIAL TAKE PROFIT CONFIG
  //   Sell tp1SellPercent% of position at tp1Percent profit,
  //   then let the rest ride with trailing stop / TP Trail
  // ============================================================
  partialTpEnabled?: boolean;
  tp1Percent?: number;           // e.g., 2.33 — first TP level
  tp1SellPercent?: number;       // e.g., 50 — sell 50% of position at TP1
  // ============================================================
  // DCA SAFETY ORDER CONFIG
  //   When price dips after entry, buy more to average down
  // ============================================================
  dcaEnabled?: boolean;
  dcaMaxOrders?: number;         // Max # of safety orders (e.g., 3)
  dcaStepPercent?: number;       // First safety order triggers at -X% (e.g., 1.5)
  dcaStepMultiplier?: number;    // Each subsequent step is wider by this factor (e.g., 1.5)
  dcaOrderSizePercent?: number;  // Each DCA order size as % of original buy (e.g., 50)
  // ============================================================
  // DYNAMIC SL TIGHTENING CONFIG
  //   Progressive stop loss that locks in more profit as price rises
  // ============================================================
  dynamicSlEnabled?: boolean;
  dynamicSlLevels?: DynamicSlLevel[];  // Custom tightening tiers
}

// Dynamic SL Tightening tier definition
export interface DynamicSlLevel {
  profitPercent: number;    // When profit reaches this % (e.g., 3)
  lockPercent: number;      // Move SL to this % above entry (e.g., 1.5)
}

export interface SignalThresholds {
  buyScore: number;
  sellScore: number;
  minConfidence: number;
  // Pro additions
  minMultiTimeframeAlignment?: number;  // e.g., 60 = need 60% of timeframes to agree
  minAdx?: number;                      // only trade when trend is strong enough
  maxAtrPercent?: number;               // skip trades in extreme volatility
}

export interface IndicatorWeights {
  rsi: number;
  macd: number;
  ema: number;
  bollingerBands: number;
  volume: number;
  sentiment: number;
  fearGreed: number;
  momentum: number;
  stochasticRsi: number;
  // Pro additions
  adx?: number;
  obv?: number;
  vwap?: number;
  ichimoku?: number;
  fibonacci?: number;
  orderBook?: number;
  whaleFlow?: number;
  fundingRate?: number;
  liquidation?: number;
  multiTimeframe?: number;
}

export interface StrategyConfig {
  id: StrategyType;
  name: string;
  shortName: string;
  description: string;
  intervalMs: number;
  riskParams: RiskParams;
  signalThresholds: SignalThresholds;
  indicatorWeights: IndicatorWeights;
  // Pro additions
  timeframes?: Timeframe[];            // which timeframes to analyze
  primaryTimeframe?: Timeframe;         // main analysis timeframe
  useOrderBook?: boolean;
  useWhaleTracking?: boolean;
  useFundingRate?: boolean;
  useLiquidationData?: boolean;
}

// ---- Analysis Result ----
export interface AnalysisResult {
  pair: string;
  symbol: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  score: number;
  confidence: number;
  current_price: number;
  indicators: Record<string, any>;
  reasoning: string[];
  // Pro additions
  multi_timeframe?: MultiTimeframeResult;
  whale_data?: WhaleData;
  order_book?: OrderBookData;
  funding_rate?: FundingRateData;
  liquidation?: LiquidationData;
  position_sizing?: KellyResult;
  atr_sizing?: ATRPositionSize;
  correlation_warning?: string;
  indicator_details?: IndicatorResults;
}

// ---- Positions & Trades ----
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
  strategy: string;
  opened_at: string;
  order_id?: string;
  // Pro additions
  atr_at_entry?: number;
  kelly_fraction?: number;
  risk_amount?: number;
  timeframe_alignment?: number;
  // ============================================================
  // PARTIAL TAKE PROFIT (Laddered TP)
  //   Sell a portion at TP1, let the rest ride with trailing stop
  // ============================================================
  original_quantity?: number;      // Full qty before any partial sells
  tp1_hit?: boolean;               // Whether TP1 has already fired
  partial_sells_count?: number;    // How many partial sells have executed
  // ============================================================
  // DCA SAFETY ORDERS
  //   Buy more at lower prices to average down entry
  // ============================================================
  dca_orders_filled?: number;      // How many safety orders have filled (0, 1, 2, ...)
  dca_total_invested?: number;     // Total $ invested including all DCA buys
  average_entry_price?: number;    // Weighted average entry after DCA
  // ============================================================
  // DYNAMIC SL TIGHTENING
  //   Track the last tightening level so we only ratchet up
  // ============================================================
  dynamic_sl_level?: number;       // Last profit tier that triggered SL tightening (e.g., 3, 5, 7)
}

export interface BotTrade {
  coin_id: string;
  symbol: string;
  pair: string;
  action: 'BUY' | 'SELL';
  strategy: string;
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
  stop_loss_price?: number;
  take_profit_price?: number;
  trailing_stop_price?: number;
  opened_at: string;
  closed_at?: string;
  order_id?: string;
  mode: TradeMode;
  // Pro additions
  kelly_fraction?: number;
  atr_at_entry?: number;
  risk_amount?: number;
  exit_reason?: string;
  timeframe_alignment?: number;
  // ============================================================
  // PARTIAL TP + DCA tracking on trade records
  // ============================================================
  is_partial?: boolean;             // true if this SELL was a partial TP (not a full exit)
  is_dca_buy?: boolean;             // true if this BUY was a DCA safety order (not initial entry)
  average_entry_price?: number;     // Weighted avg entry at time of trade
  dca_order_number?: number;        // Which DCA order this was (1, 2, 3...)
}

// ---- Backtesting ----
export interface BacktestConfig {
  strategy: StrategyType;
  pairs: string[];
  startDate: string;
  endDate: string;
  initialBalance: number;
  timeframe: Timeframe;
  slippage_percent?: number;
  commission_percent?: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  trades: BotTrade[];
  final_balance: number;
  total_return_percent: number;
  max_drawdown_percent: number;
  sharpe_ratio: number;
  sortino_ratio: number;
  profit_factor: number;
  win_rate: number;
  total_trades: number;
  avg_trade_duration_hours: number;
  best_trade_pnl: number;
  worst_trade_pnl: number;
  monthly_returns: Array<{ month: string; return_percent: number }>;
  equity_curve: Array<{ timestamp: number; balance: number }>;
}

// ---- Alerts ----
export interface AlertMessage {
  type: 'trade_opened' | 'trade_closed' | 'signal' | 'circuit_breaker' | 'whale_alert' | 'error' | 'daily_summary';
  title: string;
  body: string;
  emoji: string;
  timestamp: string;
  data?: Record<string, any>;
}
