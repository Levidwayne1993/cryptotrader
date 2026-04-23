// ============================================================
// PROJECT: cryptotrader
// FILE: src/exchange.ts
// DESCRIPTION: Kraken exchange connector with multi-timeframe
//   data fetching, order book depth, and WebSocket streaming
// ============================================================

import { OHLCV, MarketData, MultiTimeframeData, OrderBookData, OrderBookLevel, Timeframe } from './types';
import { log } from './logger';

// Kraken timeframe mapping (in minutes)
const TIMEFRAME_MAP: Record<Timeframe, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
};

// Pair symbol mapping for Kraken REST API
const KRAKEN_PAIR_MAP: Record<string, string> = {
  'BTC/USD': 'XXBTZUSD',
  'ETH/USD': 'XETHZUSD',
  'SOL/USD': 'SOLUSD',
  'DOGE/USD': 'XDGUSD',
  'ADA/USD': 'ADAUSD',
  'XRP/USD': 'XXRPZUSD',
  'DOT/USD': 'DOTUSD',
  'AVAX/USD': 'AVAXUSD',
  'LINK/USD': 'LINKUSD',
};

export function getPair(symbol: string): string {
  return KRAKEN_PAIR_MAP[symbol] || symbol.replace('/', '');
}

export function getCoinIdFromPair(pair: string): string {
  const map: Record<string, string> = {
    'BTC/USD': 'bitcoin', 'ETH/USD': 'ethereum', 'SOL/USD': 'solana',
    'DOGE/USD': 'dogecoin', 'ADA/USD': 'cardano', 'XRP/USD': 'ripple',
    'DOT/USD': 'polkadot', 'AVAX/USD': 'avalanche-2', 'LINK/USD': 'chainlink',
  };
  return map[pair] || pair.split('/')[0].toLowerCase();
}

export class KrakenExchange {
  private mode: 'paper' | 'live';
  private baseUrl = 'https://api.kraken.com';
  private apiKey: string;
  private apiSecret: string;
  private rateLimitDelay = 1500; // ms between requests
  private lastRequestTime = 0;

  constructor(mode: 'paper' | 'live') {
    this.mode = mode;
    this.apiKey = process.env.KRAKEN_API_KEY || '';
    this.apiSecret = process.env.KRAKEN_API_SECRET || '';
  }

  // ---- Rate limiter ----
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.rateLimitDelay) {
      await new Promise(r => setTimeout(r, this.rateLimitDelay - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  // ---- Test connection ----
  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/0/public/SystemStatus`, {
        signal: AbortSignal.timeout(10000),
      });
      const data = await response.json() as any;
      if (data?.result?.status === 'online') {
        // Get market count
        const assetPairs = await fetch(`${this.baseUrl}/0/public/AssetPairs`, {
          signal: AbortSignal.timeout(10000),
        });
        const pairs = await assetPairs.json() as any;
        const count = Object.keys(pairs?.result || {}).length;
        log('info', `Connected to Kraken — ${count} markets available`);
        return true;
      }
      return false;
    } catch (err: any) {
      log('error', `Kraken connection failed: ${err.message}`);
      return false;
    }
  }

  // ---- Get balance (live mode) ----
  async getBalance(): Promise<{ free: number; total: number }> {
    if (this.mode === 'paper') {
      return { free: 0, total: 0 };
    }
    try {
      // Private API call would go here with signed request
      return { free: 0, total: 0 };
    } catch {
      return { free: 0, total: 0 };
    }
  }

  // ---- Fetch OHLCV for a single timeframe ----
  async getOHLCV(pair: string, timeframe: Timeframe = '5m', limit: number = 100): Promise<OHLCV[]> {
    await this.rateLimit();
    try {
      const krakenPair = getPair(pair);
      const interval = TIMEFRAME_MAP[timeframe];
      const url = `${this.baseUrl}/0/public/OHLC?pair=${krakenPair}&interval=${interval}`;

      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
      });
      const data = await response.json() as any;

      if (data.error && data.error.length > 0) {
        log('warn', `Kraken OHLC error for ${pair}: ${data.error.join(', ')}`);
        return [];
      }

      const resultKey = Object.keys(data.result || {}).find(k => k !== 'last');
      if (!resultKey || !data.result[resultKey]) return [];

      const candles: OHLCV[] = data.result[resultKey]
        .slice(-limit)
        .map((c: any) => ({
          timestamp: c[0] * 1000,
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[6]),
        }));

      return candles;
    } catch (err: any) {
      log('warn', `Failed to fetch OHLCV for ${pair} ${timeframe}: ${err.message}`);
      return [];
    }
  }

  // ---- NEW: Multi-timeframe data ----
  async getMultiTimeframeData(
    pair: string,
    timeframes: Timeframe[] = ['5m', '15m', '1h', '4h']
  ): Promise<MultiTimeframeData | null> {
    try {
      const tfData: Record<Timeframe, OHLCV[]> = {} as any;

      for (const tf of timeframes) {
        const candles = await this.getOHLCV(pair, tf, 100);
        if (candles.length > 0) {
          tfData[tf] = candles;
        }
      }

      // Need at least the primary timeframe
      if (Object.keys(tfData).length === 0) return null;

      const primaryCandles = tfData[timeframes[0]] || Object.values(tfData)[0];
      const lastCandle = primaryCandles[primaryCandles.length - 1];
      const firstCandle = primaryCandles[0];

      return {
        pair,
        symbol: pair.split('/')[0],
        current_price: lastCandle.close,
        timeframes: tfData,
        volume_24h: primaryCandles.reduce((sum, c) => sum + c.volume, 0),
        price_change_24h: firstCandle.close > 0
          ? ((lastCandle.close - firstCandle.close) / firstCandle.close) * 100
          : 0,
      };
    } catch (err: any) {
      log('warn', `Multi-timeframe fetch failed for ${pair}: ${err.message}`);
      return null;
    }
  }

  // ---- Get market data (single timeframe, backward compatible) ----
  async getMarketData(pair: string, timeframe: Timeframe = '5m'): Promise<MarketData | null> {
    const ohlcv = await this.getOHLCV(pair, timeframe);
    if (ohlcv.length === 0) return null;

    const last = ohlcv[ohlcv.length - 1];
    const first = ohlcv[0];
    const volume24h = ohlcv.reduce((sum, c) => sum + c.volume, 0);

    // Also fetch ticker for bid/ask
    let bid = 0, ask = 0, spread = 0;
    try {
      await this.rateLimit();
      const krakenPair = getPair(pair);
      const tickerRes = await fetch(`${this.baseUrl}/0/public/Ticker?pair=${krakenPair}`, {
        signal: AbortSignal.timeout(10000),
      });
      const tickerData = await tickerRes.json() as any;
      const key = Object.keys(tickerData.result || {})[0];
      if (key && tickerData.result[key]) {
        bid = parseFloat(tickerData.result[key].b[0]);
        ask = parseFloat(tickerData.result[key].a[0]);
        spread = ask - bid;
      }
    } catch { /* ticker is supplementary */ }

    return {
      pair,
      symbol: pair.split('/')[0],
      current_price: last.close,
      ohlcv,
      volume_24h: volume24h,
      price_change_24h: first.close > 0
        ? ((last.close - first.close) / first.close) * 100
        : 0,
      bid,
      ask,
      spread,
    };
  }

  // ---- Get multiple market data ----
  async getMultipleMarketData(
    pairs: string[],
    timeframe: Timeframe = '5m'
  ): Promise<MarketData[]> {
    const results: MarketData[] = [];
    for (const pair of pairs) {
      const data = await this.getMarketData(pair, timeframe);
      if (data) results.push(data);
    }
    return results;
  }

  // ---- NEW: Order Book Depth ----
  async getOrderBook(pair: string, depth: number = 25): Promise<OrderBookData | null> {
    await this.rateLimit();
    try {
      const krakenPair = getPair(pair);
      const url = `${this.baseUrl}/0/public/Depth?pair=${krakenPair}&count=${depth}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = await response.json() as any;

      if (data.error?.length > 0) return null;

      const key = Object.keys(data.result || {})[0];
      if (!key) return null;

      const rawBids = data.result[key].bids || [];
      const rawAsks = data.result[key].asks || [];

      let bidTotal = 0;
      const bids: OrderBookLevel[] = rawBids.map((b: any) => {
        const price = parseFloat(b[0]);
        const amount = parseFloat(b[1]);
        bidTotal += amount;
        return { price, amount, total: bidTotal };
      });

      let askTotal = 0;
      const asks: OrderBookLevel[] = rawAsks.map((a: any) => {
        const price = parseFloat(a[0]);
        const amount = parseFloat(a[1]);
        askTotal += amount;
        return { price, amount, total: askTotal };
      });

      const bestBid = bids[0]?.price || 0;
      const bestAsk = asks[0]?.price || 0;
      const spread = bestAsk - bestBid;
      const spreadPercent = bestAsk > 0 ? (spread / bestAsk) * 100 : 0;

      const bidDepth = bids.reduce((sum, b) => sum + b.amount * b.price, 0);
      const askDepth = asks.reduce((sum, a) => sum + a.amount * a.price, 0);
      const imbalance = askDepth > 0 ? bidDepth / askDepth : 1;

      return {
        pair,
        bids,
        asks,
        spread: Math.round(spread * 100) / 100,
        spread_percent: Math.round(spreadPercent * 10000) / 10000,
        bid_depth: Math.round(bidDepth),
        ask_depth: Math.round(askDepth),
        imbalance: Math.round(imbalance * 100) / 100,
        timestamp: Date.now(),
      };
    } catch (err: any) {
      log('warn', `Order book fetch failed for ${pair}: ${err.message}`);
      return null;
    }
  }

  // ---- Paper trade execution ----
  async marketBuy(
    pair: string,
    amountUsd: number
  ): Promise<{ success: boolean; price?: number; quantity?: number; orderId?: string; error?: string }> {
    if (this.mode === 'paper') {
      // Simulate with current price
      const data = await this.getMarketData(pair, '1m');
      if (!data) return { success: false, error: 'No market data' };

      const slippage = 1 + (Math.random() * 0.002);  // 0-0.2% slippage
      const price = data.current_price * slippage;
      const quantity = amountUsd / price;

      return {
        success: true,
        price,
        quantity,
        orderId: `paper-buy-${Date.now()}`,
      };
    }

    // Live mode — would use Kraken private API
    return { success: false, error: 'Live trading not implemented' };
  }

  async marketSell(
    pair: string,
    quantity: number
  ): Promise<{ success: boolean; price?: number; quantity?: number; orderId?: string; error?: string }> {
    if (this.mode === 'paper') {
      const data = await this.getMarketData(pair, '1m');
      if (!data) return { success: false, error: 'No market data' };

      const slippage = 1 - (Math.random() * 0.002);
      const price = data.current_price * slippage;

      return {
        success: true,
        price,
        quantity,
        orderId: `paper-sell-${Date.now()}`,
      };
    }

    return { success: false, error: 'Live trading not implemented' };
  }

  // ---- Correlation Matrix ----
  async calculateCorrelation(
    pairs: string[],
    timeframe: Timeframe = '1h',
    period: number = 50
  ): Promise<{ matrix: number[][]; pairs: string[]; highly_correlated: Array<{ pair_a: string; pair_b: string; correlation: number }> }> {
    // Fetch closes for each pair
    const closesMap: Record<string, number[]> = {};

    for (const pair of pairs) {
      const ohlcv = await this.getOHLCV(pair, timeframe, period + 1);
      if (ohlcv.length >= period) {
        // Convert to returns
        const closes = ohlcv.map(c => c.close);
        const returns: number[] = [];
        for (let i = 1; i < closes.length; i++) {
          returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
        }
        closesMap[pair] = returns;
      }
    }

    const activePairs = Object.keys(closesMap);
    const n = activePairs.length;
    const matrix: number[][] = Array(n).fill(null).map(() => Array(n).fill(0));
    const highlyCorrelated: Array<{ pair_a: string; pair_b: string; correlation: number }> = [];

    for (let i = 0; i < n; i++) {
      matrix[i][i] = 1.0;
      for (let j = i + 1; j < n; j++) {
        const corr = pearsonCorrelation(closesMap[activePairs[i]], closesMap[activePairs[j]]);
        matrix[i][j] = corr;
        matrix[j][i] = corr;

        if (Math.abs(corr) > 0.7) {
          highlyCorrelated.push({
            pair_a: activePairs[i],
            pair_b: activePairs[j],
            correlation: Math.round(corr * 100) / 100,
          });
        }
      }
    }

    return { matrix, pairs: activePairs, highly_correlated: highlyCorrelated };
  }
}

// ---- Pearson correlation helper ----
function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 5) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt(
    (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY)
  );

  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 100) / 100;
}
