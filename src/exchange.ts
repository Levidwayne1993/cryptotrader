// ============================================================
// PROJECT: cryptotrader
// FILE: src/exchange.ts (UPDATED — replaces existing file)
// DESCRIPTION: Kraken Exchange Integration — UPGRADED
//   Now includes: live trading, limit orders, fee tier
//   detection, real balance queries, and all existing
//   paper mode functionality preserved.
// ============================================================

import { log } from './logger';
import { TradeMode } from './types';

// ============================================================
// KRAKEN PAIR MAPPING
// ============================================================
const PAIR_MAP: Record<string, string> = {
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

const COIN_ID_MAP: Record<string, string> = {
  'BTC/USD': 'bitcoin', 'ETH/USD': 'ethereum', 'SOL/USD': 'solana',
  'DOGE/USD': 'dogecoin', 'ADA/USD': 'cardano', 'XRP/USD': 'ripple',
  'DOT/USD': 'polkadot', 'AVAX/USD': 'avalanche-2', 'LINK/USD': 'chainlink',
};

export function getPair(pair: string): string {
  return PAIR_MAP[pair] || pair.replace('/', '');
}

export function getCoinIdFromPair(pair: string): string {
  return COIN_ID_MAP[pair] || pair.split('/')[0].toLowerCase();
}

// ============================================================
// TYPES
// ============================================================
interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface MarketData {
  pair: string;
  symbol: string;
  current_price: number;
  bid: number;
  ask: number;
  spread: number;
  volume_24h: number;
  price_change_24h: number;
  ohlcv: OHLCV[];
}

interface OrderResult {
  success: boolean;
  orderId?: string;
  price?: number;
  quantity?: number;
  cost?: number;
  fee?: number;
  error?: string;
  orderType?: 'market' | 'limit';
  status?: 'filled' | 'partial' | 'open' | 'cancelled';
}

interface OrderBookData {
  bids: { price: number; volume: number }[];
  asks: { price: number; volume: number }[];
  bid_volume: number;
  ask_volume: number;
  imbalance: number;
  spread: number;
  spread_percent: number;
}

interface BalanceResult {
  total: number;
  free: number;
  used: number;
  positions: Record<string, number>;
}

interface FeeTierResult {
  makerFee: number;
  takerFee: number;
  volume30d: number;
  tierName: string;
}

// ============================================================
// KRAKEN FEE TIERS (as of 2026)
// Based on 30-day rolling trade volume
// ============================================================
const KRAKEN_FEE_TIERS = [
  { maxVolume: 10000,     maker: 0.0025, taker: 0.0040, name: 'Starter ($0-$10K)' },
  { maxVolume: 50000,     maker: 0.0020, taker: 0.0035, name: 'Intermediate ($10K-$50K)' },
  { maxVolume: 100000,    maker: 0.0014, taker: 0.0024, name: 'Advanced ($50K-$100K)' },
  { maxVolume: 250000,    maker: 0.0012, taker: 0.0022, name: 'Pro ($100K-$250K)' },
  { maxVolume: 500000,    maker: 0.0010, taker: 0.0020, name: 'Expert ($250K-$500K)' },
  { maxVolume: 1000000,   maker: 0.0008, taker: 0.0018, name: 'Champion ($500K-$1M)' },
  { maxVolume: 5000000,   maker: 0.0006, taker: 0.0016, name: 'Market Maker ($1M-$5M)' },
  { maxVolume: 10000000,  maker: 0.0004, taker: 0.0014, name: 'Institutional ($5M-$10M)' },
  { maxVolume: Infinity,  maker: 0.0002, taker: 0.0012, name: 'Elite ($10M+)' },
];

// ============================================================
// KRAKEN EXCHANGE CLASS
// ============================================================
export class KrakenExchange {
  private mode: TradeMode;
  private lastRequestTime = 0;
  private rateLimitMs = 1500;
  private apiKey: string;
  private apiSecret: string;
  private cachedFeeTier: FeeTierResult | null = null;
  private feeTierCacheTime = 0;
  private feeTierCacheDuration = 60 * 60 * 1000; // 1 hour

  constructor(mode: TradeMode) {
    this.mode = mode;
    this.apiKey = process.env.KRAKEN_API_KEY || '';
    this.apiSecret = process.env.KRAKEN_API_SECRET || '';

    if (mode === 'live' && (!this.apiKey || !this.apiSecret)) {
      log('warn', 'LIVE mode requires KRAKEN_API_KEY and KRAKEN_API_SECRET environment variables');
    }
  }

  // ============================================================
  // RATE LIMITER
  // ============================================================
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const timeSince = now - this.lastRequestTime;
    if (timeSince < this.rateLimitMs) {
      await new Promise(r => setTimeout(r, this.rateLimitMs - timeSince));
    }
    this.lastRequestTime = Date.now();
  }

  // ============================================================
  // KRAKEN SIGNED REQUEST (for private endpoints)
  // Uses HMAC-SHA512 with nonce for authentication
  // ============================================================
  private async signedRequest(endpoint: string, params: Record<string, string> = {}): Promise<any> {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('API keys not configured — set KRAKEN_API_KEY and KRAKEN_API_SECRET');
    }

    const crypto = await import('crypto');
    const nonce = Date.now() * 1000;
    params.nonce = nonce.toString();

    const postData = new URLSearchParams(params).toString();
    const path = `/0/private/${endpoint}`;

    // Kraken signature: HMAC-SHA512(path + SHA256(nonce + postData), base64decode(secret))
    const sha256Hash = crypto.createHash('sha256')
      .update(nonce + postData)
      .digest();
    const message = Buffer.concat([Buffer.from(path), sha256Hash]);
    const signature = crypto.createHmac('sha512', Buffer.from(this.apiSecret, 'base64'))
      .update(message)
      .digest('base64');

    await this.rateLimit();

    const response = await fetch(`https://api.kraken.com${path}`, {
      method: 'POST',
      headers: {
        'API-Key': this.apiKey,
        'API-Sign': signature,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: postData,
    });

    const json = await response.json();
    if (json.error && json.error.length > 0) {
      throw new Error(`Kraken API error: ${json.error.join(', ')}`);
    }
    return json.result;
  }

  // ============================================================
  // PUBLIC: Test Connection
  // ============================================================
  async testConnection(): Promise<boolean> {
    try {
      await this.rateLimit();
      const response = await fetch('https://api.kraken.com/0/public/SystemStatus');
      const json = await response.json();
      if (json.result?.status === 'online') {
        // Also get asset pair count
        const pairsRes = await fetch('https://api.kraken.com/0/public/AssetPairs');
        const pairsJson = await pairsRes.json();
        const pairCount = Object.keys(pairsJson.result || {}).length;
        log('info', `Connected to Kraken — ${pairCount} markets available`);
        return true;
      }
      log('warn', `Kraken status: ${json.result?.status}`);
      return false;
    } catch (err: any) {
      log('error', `Kraken connection failed: ${err.message}`);
      return false;
    }
  }

  // ============================================================
  // PUBLIC: Get OHLCV Candles
  // ============================================================
  async getOHLCV(pair: string, timeframe: string = '5', limit: number = 100): Promise<OHLCV[]> {
    try {
      await this.rateLimit();
      const krakenPair = getPair(pair);
      const interval = this.timeframeToMinutes(timeframe);
      const url = `https://api.kraken.com/0/public/OHLC?pair=${krakenPair}&interval=${interval}`;

      const response = await fetch(url);
      const json = await response.json();

      if (json.error && json.error.length > 0) {
        log('warn', `OHLCV error for ${pair}: ${json.error.join(', ')}`);
        return [];
      }

      const resultKey = Object.keys(json.result).find(k => k !== 'last');
      if (!resultKey) return [];

      const candles = json.result[resultKey]
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
      log('error', `OHLCV fetch failed for ${pair}: ${err.message}`);
      return [];
    }
  }

  // ============================================================
  // PUBLIC: Get Ticker
  // ============================================================
  async getTicker(pair: string): Promise<{ bid: number; ask: number; last: number; volume: number; spread: number } | null> {
    try {
      await this.rateLimit();
      const krakenPair = getPair(pair);
      const url = `https://api.kraken.com/0/public/Ticker?pair=${krakenPair}`;
      const response = await fetch(url);
      const json = await response.json();

      if (json.error && json.error.length > 0) return null;

      const resultKey = Object.keys(json.result)[0];
      if (!resultKey) return null;

      const data = json.result[resultKey];
      const bid = parseFloat(data.b[0]);
      const ask = parseFloat(data.a[0]);

      return {
        bid,
        ask,
        last: parseFloat(data.c[0]),
        volume: parseFloat(data.v[1]),
        spread: ask - bid,
      };
    } catch {
      return null;
    }
  }

  // ============================================================
  // PUBLIC: Get Market Data (combined OHLCV + ticker)
  // ============================================================
  async getMarketData(pair: string, timeframe: string = '5m'): Promise<MarketData | null> {
    try {
      const tfMinutes = this.timeframeToMinutes(timeframe);
      const ohlcv = await this.getOHLCV(pair, tfMinutes.toString(), 100);
      if (ohlcv.length === 0) return null;

      const ticker = await this.getTicker(pair);
      const lastCandle = ohlcv[ohlcv.length - 1];

      return {
        pair,
        symbol: pair.split('/')[0],
        current_price: ticker?.last || lastCandle.close,
        bid: ticker?.bid || lastCandle.close * 0.999,
        ask: ticker?.ask || lastCandle.close * 1.001,
        spread: ticker?.spread || lastCandle.close * 0.002,
        volume_24h: ticker?.volume || 0,
        price_change_24h: ohlcv.length > 1
          ? ((lastCandle.close - ohlcv[0].open) / ohlcv[0].open) * 100 : 0,
        ohlcv,
      };
    } catch (err: any) {
      log('error', `Market data failed for ${pair}: ${err.message}`);
      return null;
    }
  }

  // ============================================================
  // PUBLIC: Get Multiple Market Data
  // ============================================================
  async getMultipleMarketData(pairs: string[], timeframe: string = '5m'): Promise<MarketData[]> {
    const results: MarketData[] = [];
    for (const pair of pairs) {
      const data = await this.getMarketData(pair, timeframe);
      if (data) results.push(data);
    }
    return results;
  }

  // ============================================================
  // PUBLIC: Get Order Book
  // ============================================================
  async getOrderBook(pair: string, depth: number = 25): Promise<OrderBookData | null> {
    try {
      await this.rateLimit();
      const krakenPair = getPair(pair);
      const url = `https://api.kraken.com/0/public/Depth?pair=${krakenPair}&count=${depth}`;
      const response = await fetch(url);
      const json = await response.json();

      if (json.error && json.error.length > 0) return null;

      const resultKey = Object.keys(json.result)[0];
      if (!resultKey) return null;

      const data = json.result[resultKey];
      const bids = data.bids.map((b: any) => ({
        price: parseFloat(b[0]),
        volume: parseFloat(b[1]),
      }));
      const asks = data.asks.map((a: any) => ({
        price: parseFloat(a[0]),
        volume: parseFloat(a[1]),
      }));

      const bidVolume = bids.reduce((s: number, b: any) => s + b.volume, 0);
      const askVolume = asks.reduce((s: number, a: any) => s + a.volume, 0);
      const totalVolume = bidVolume + askVolume;

      return {
        bids, asks, bid_volume: bidVolume, ask_volume: askVolume,
        imbalance: totalVolume > 0 ? (bidVolume - askVolume) / totalVolume : 0,
        spread: asks.length > 0 && bids.length > 0 ? asks[0].price - bids[0].price : 0,
        spread_percent: asks.length > 0 && bids.length > 0
          ? ((asks[0].price - bids[0].price) / asks[0].price) * 100 : 0,
      };
    } catch {
      return null;
    }
  }

  // ============================================================
  // PUBLIC: Get Multi-Timeframe Data
  // ============================================================
  async getMultiTimeframeData(pair: string, timeframes: string[]): Promise<any> {
    const tfData: any = { pair, timeframes: {} };
    for (const tf of timeframes) {
      const ohlcv = await this.getOHLCV(pair, this.timeframeToMinutes(tf).toString(), 50);
      if (ohlcv.length > 0) {
        tfData.timeframes[tf] = ohlcv;
      }
    }
    return Object.keys(tfData.timeframes).length > 0 ? tfData : null;
  }

  // ============================================================
  // PUBLIC: Calculate Correlation Matrix
  // ============================================================
  async calculateCorrelation(
    pairs: string[], timeframe: string = '1h', periods: number = 50
  ): Promise<{ highly_correlated: { pair_a: string; pair_b: string; correlation: number }[] }> {
    const returns: Map<string, number[]> = new Map();

    for (const pair of pairs) {
      const ohlcv = await this.getOHLCV(pair, this.timeframeToMinutes(timeframe).toString(), periods + 1);
      if (ohlcv.length < 10) continue;
      const pairReturns: number[] = [];
      for (let i = 1; i < ohlcv.length; i++) {
        pairReturns.push((ohlcv[i].close - ohlcv[i - 1].close) / ohlcv[i - 1].close);
      }
      returns.set(pair, pairReturns);
    }

    const highlyCorrelated: { pair_a: string; pair_b: string; correlation: number }[] = [];
    const pairList = Array.from(returns.keys());

    for (let i = 0; i < pairList.length; i++) {
      for (let j = i + 1; j < pairList.length; j++) {
        const a = returns.get(pairList[i])!;
        const b = returns.get(pairList[j])!;
        const len = Math.min(a.length, b.length);
        if (len < 5) continue;

        const meanA = a.slice(0, len).reduce((s, v) => s + v, 0) / len;
        const meanB = b.slice(0, len).reduce((s, v) => s + v, 0) / len;
        let cov = 0, varA = 0, varB = 0;
        for (let k = 0; k < len; k++) {
          cov += (a[k] - meanA) * (b[k] - meanB);
          varA += (a[k] - meanA) ** 2;
          varB += (b[k] - meanB) ** 2;
        }
        const corr = Math.sqrt(varA * varB) > 0 ? cov / Math.sqrt(varA * varB) : 0;

        if (Math.abs(corr) > 0.7) {
          highlyCorrelated.push({ pair_a: pairList[i], pair_b: pairList[j], correlation: corr });
        }
      }
    }

    return { highly_correlated: highlyCorrelated };
  }

  // ============================================================
  // PRIVATE: Get Account Balance (LIVE)
  // ============================================================
  async getBalance(): Promise<BalanceResult> {
    if (this.mode !== 'live') {
      return { total: 0, free: 0, used: 0, positions: {} };
    }

    try {
      const result = await this.signedRequest('Balance');
      const positions: Record<string, number> = {};
      let totalUsd = 0;

      for (const [asset, amount] of Object.entries(result)) {
        const balance = parseFloat(amount as string);
        if (balance > 0) {
          positions[asset] = balance;
          // USD and stablecoins count as free balance
          if (asset === 'ZUSD' || asset === 'USD' || asset === 'USDT' || asset === 'USDC') {
            totalUsd += balance;
          }
        }
      }

      // Get trade balance for margin info
      let freeBalance = totalUsd;
      let usedBalance = 0;
      try {
        const tradeBalance = await this.signedRequest('TradeBalance', { asset: 'ZUSD' });
        freeBalance = parseFloat(tradeBalance.mf || tradeBalance.eb || totalUsd.toString());
        usedBalance = parseFloat(tradeBalance.m || '0');
      } catch {
        // Fallback to simple balance
      }

      log('info', `Live balance: $${freeBalance.toFixed(2)} free, $${usedBalance.toFixed(2)} used`);
      return { total: freeBalance + usedBalance, free: freeBalance, used: usedBalance, positions };
    } catch (err: any) {
      log('error', `Balance fetch failed: ${err.message}`);
      return { total: 0, free: 0, used: 0, positions: {} };
    }
  }

  // ============================================================
  // PRIVATE: Get Fee Tier (LIVE)
  // Queries Kraken for your actual fee tier based on 30-day volume
  // ============================================================
  async getFeeTier(pair?: string): Promise<FeeTierResult> {
    // Return cached if fresh
    if (this.cachedFeeTier && Date.now() - this.feeTierCacheTime < this.feeTierCacheDuration) {
      return this.cachedFeeTier;
    }

    if (this.mode !== 'live') {
      // Paper mode: return default starter tier
      const defaultTier = {
        makerFee: 0.0025,
        takerFee: 0.0040,
        volume30d: 0,
        tierName: 'Starter ($0-$10K) — Paper Mode',
      };
      this.cachedFeeTier = defaultTier;
      this.feeTierCacheTime = Date.now();
      return defaultTier;
    }

    try {
      const queryPair = pair ? getPair(pair) : 'XXBTZUSD';
      const result = await this.signedRequest('TradeVolume', { pair: queryPair });

      const volume30d = parseFloat(result.volume || '0');
      const feeInfo = result.fees?.[queryPair];

      let makerFee = 0.0025;
      let takerFee = 0.0040;
      let tierName = 'Unknown';

      if (feeInfo) {
        // Kraken returns fee as percentage (e.g., 0.40 for 0.40%)
        takerFee = parseFloat(feeInfo.fee) / 100;
        makerFee = parseFloat(feeInfo.minfee || feeInfo.fee) / 100;
        // Find tier name
        for (const tier of KRAKEN_FEE_TIERS) {
          if (volume30d <= tier.maxVolume) {
            tierName = tier.name;
            break;
          }
        }
      } else {
        // Determine from volume using our tier table
        for (const tier of KRAKEN_FEE_TIERS) {
          if (volume30d <= tier.maxVolume) {
            makerFee = tier.maker;
            takerFee = tier.taker;
            tierName = tier.name;
            break;
          }
        }
      }

      const feeTier = { makerFee, takerFee, volume30d, tierName };
      this.cachedFeeTier = feeTier;
      this.feeTierCacheTime = Date.now();

      log('info', `Fee tier: ${tierName} | Maker: ${(makerFee * 100).toFixed(2)}% | Taker: ${(takerFee * 100).toFixed(2)}% | 30d Vol: $${volume30d.toFixed(0)}`);
      return feeTier;
    } catch (err: any) {
      log('warn', `Fee tier fetch failed: ${err.message} — using default`);
      const fallback = { makerFee: 0.0025, takerFee: 0.0040, volume30d: 0, tierName: 'Starter (fallback)' };
      this.cachedFeeTier = fallback;
      this.feeTierCacheTime = Date.now();
      return fallback;
    }
  }

  // ============================================================
  // MARKET BUY (taker — instant fill, higher fee)
  // ============================================================
  async marketBuy(pair: string, amountUSD: number): Promise<OrderResult> {
    if (this.mode === 'paper') {
      return this.paperMarketBuy(pair, amountUSD);
    }
    return this.liveMarketBuy(pair, amountUSD);
  }

  // ============================================================
  // MARKET SELL (taker — instant fill, higher fee)
  // ============================================================
  async marketSell(pair: string, quantity: number): Promise<OrderResult> {
    if (this.mode === 'paper') {
      return this.paperMarketSell(pair, quantity);
    }
    return this.liveMarketSell(pair, quantity);
  }

  // ============================================================
  // LIMIT BUY (maker — slower fill, lower fee)
  // Places order at slightly below current price
  // ============================================================
  async limitBuy(pair: string, amountUSD: number, limitPrice?: number): Promise<OrderResult> {
    if (this.mode === 'paper') {
      return this.paperMarketBuy(pair, amountUSD); // paper treats limits as market
    }
    return this.liveLimitBuy(pair, amountUSD, limitPrice);
  }

  // ============================================================
  // LIMIT SELL (maker — slower fill, lower fee)
  // Places order at slightly above current price
  // ============================================================
  async limitSell(pair: string, quantity: number, limitPrice?: number): Promise<OrderResult> {
    if (this.mode === 'paper') {
      return this.paperMarketSell(pair, quantity); // paper treats limits as market
    }
    return this.liveLimitSell(pair, quantity, limitPrice);
  }

  // ============================================================
  // LIVE: Market Buy Implementation
  // ============================================================
  private async liveMarketBuy(pair: string, amountUSD: number): Promise<OrderResult> {
    try {
      const ticker = await this.getTicker(pair);
      if (!ticker) throw new Error(`Cannot get price for ${pair}`);

      const krakenPair = getPair(pair);
      const volume = amountUSD / ticker.ask;

      // Determine decimal precision for the pair
      const decimals = this.getVolumeDecimals(pair);
      const volumeStr = volume.toFixed(decimals);

      log('info', `LIVE MARKET BUY: ${pair} | Volume: ${volumeStr} | Est. Cost: $${amountUSD.toFixed(2)}`);

      const result = await this.signedRequest('AddOrder', {
        pair: krakenPair,
        type: 'buy',
        ordertype: 'market',
        volume: volumeStr,
        // Validate only first time? Remove this line for real orders:
        // validate: 'true',
      });

      const orderId = result.txid?.[0] || 'unknown';
      log('info', `LIVE order placed: ${orderId}`);

      // Poll for fill
      const fill = await this.waitForFill(orderId);

      return {
        success: true,
        orderId,
        price: fill.price || ticker.ask,
        quantity: fill.quantity || volume,
        cost: fill.cost || amountUSD,
        fee: fill.fee || 0,
        orderType: 'market',
        status: fill.status || 'filled',
      };
    } catch (err: any) {
      log('error', `LIVE market buy failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ============================================================
  // LIVE: Market Sell Implementation
  // ============================================================
  private async liveMarketSell(pair: string, quantity: number): Promise<OrderResult> {
    try {
      const ticker = await this.getTicker(pair);
      if (!ticker) throw new Error(`Cannot get price for ${pair}`);

      const krakenPair = getPair(pair);
      const decimals = this.getVolumeDecimals(pair);
      const volumeStr = quantity.toFixed(decimals);

      log('info', `LIVE MARKET SELL: ${pair} | Volume: ${volumeStr} | Est. Value: $${(quantity * ticker.bid).toFixed(2)}`);

      const result = await this.signedRequest('AddOrder', {
        pair: krakenPair,
        type: 'sell',
        ordertype: 'market',
        volume: volumeStr,
      });

      const orderId = result.txid?.[0] || 'unknown';
      log('info', `LIVE sell order placed: ${orderId}`);

      const fill = await this.waitForFill(orderId);

      return {
        success: true,
        orderId,
        price: fill.price || ticker.bid,
        quantity: fill.quantity || quantity,
        cost: fill.cost || quantity * ticker.bid,
        fee: fill.fee || 0,
        orderType: 'market',
        status: fill.status || 'filled',
      };
    } catch (err: any) {
      log('error', `LIVE market sell failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ============================================================
  // LIVE: Limit Buy Implementation
  // Places a limit buy at specified price or slightly below ask
  // ============================================================
  private async liveLimitBuy(pair: string, amountUSD: number, limitPrice?: number): Promise<OrderResult> {
    try {
      const ticker = await this.getTicker(pair);
      if (!ticker) throw new Error(`Cannot get price for ${pair}`);

      const krakenPair = getPair(pair);

      // If no limit price specified, place at midpoint of spread
      const price = limitPrice || (ticker.bid + ticker.ask) / 2;
      const priceDecimals = this.getPriceDecimals(pair);
      const priceStr = price.toFixed(priceDecimals);

      const volume = amountUSD / price;
      const volDecimals = this.getVolumeDecimals(pair);
      const volumeStr = volume.toFixed(volDecimals);

      log('info', `LIVE LIMIT BUY: ${pair} | Price: $${priceStr} | Volume: ${volumeStr}`);

      const result = await this.signedRequest('AddOrder', {
        pair: krakenPair,
        type: 'buy',
        ordertype: 'limit',
        price: priceStr,
        volume: volumeStr,
        // Expire in 5 minutes if not filled
        expiretm: '+300',
      });

      const orderId = result.txid?.[0] || 'unknown';
      log('info', `LIVE limit buy placed: ${orderId} @ $${priceStr}`);

      // Wait for fill (with timeout)
      const fill = await this.waitForFill(orderId, 300000); // 5 min timeout

      if (fill.status === 'open' || fill.status === 'cancelled') {
        // Order didn't fill — cancel if still open
        try { await this.cancelOrder(orderId); } catch { /* already cancelled */ }

        // Fall back to market order
        log('warn', `Limit buy didn't fill — falling back to market order`);
        return this.liveMarketBuy(pair, amountUSD);
      }

      return {
        success: true,
        orderId,
        price: fill.price || price,
        quantity: fill.quantity || volume,
        cost: fill.cost || amountUSD,
        fee: fill.fee || 0,
        orderType: 'limit',
        status: fill.status || 'filled',
      };
    } catch (err: any) {
      log('error', `LIVE limit buy failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ============================================================
  // LIVE: Limit Sell Implementation
  // ============================================================
  private async liveLimitSell(pair: string, quantity: number, limitPrice?: number): Promise<OrderResult> {
    try {
      const ticker = await this.getTicker(pair);
      if (!ticker) throw new Error(`Cannot get price for ${pair}`);

      const krakenPair = getPair(pair);

      // If no limit price, place at midpoint of spread
      const price = limitPrice || (ticker.bid + ticker.ask) / 2;
      const priceDecimals = this.getPriceDecimals(pair);
      const priceStr = price.toFixed(priceDecimals);

      const volDecimals = this.getVolumeDecimals(pair);
      const volumeStr = quantity.toFixed(volDecimals);

      log('info', `LIVE LIMIT SELL: ${pair} | Price: $${priceStr} | Volume: ${volumeStr}`);

      const result = await this.signedRequest('AddOrder', {
        pair: krakenPair,
        type: 'sell',
        ordertype: 'limit',
        price: priceStr,
        volume: volumeStr,
        expiretm: '+300',
      });

      const orderId = result.txid?.[0] || 'unknown';
      log('info', `LIVE limit sell placed: ${orderId} @ $${priceStr}`);

      const fill = await this.waitForFill(orderId, 300000);

      if (fill.status === 'open' || fill.status === 'cancelled') {
        try { await this.cancelOrder(orderId); } catch { /* already cancelled */ }
        log('warn', `Limit sell didn't fill — falling back to market order`);
        return this.liveMarketSell(pair, quantity);
      }

      return {
        success: true,
        orderId,
        price: fill.price || price,
        quantity: fill.quantity || quantity,
        cost: fill.cost || quantity * price,
        fee: fill.fee || 0,
        orderType: 'limit',
        status: fill.status || 'filled',
      };
    } catch (err: any) {
      log('error', `LIVE limit sell failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ============================================================
  // LIVE: Wait for Order Fill
  // Polls order status until filled, cancelled, or timeout
  // ============================================================
  private async waitForFill(
    orderId: string,
    timeoutMs: number = 30000
  ): Promise<{ price: number; quantity: number; cost: number; fee: number; status: string }> {
    const startTime = Date.now();
    const pollInterval = 2000;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const result = await this.signedRequest('QueryOrders', { txid: orderId });
        const order = result[orderId];

        if (!order) {
          await new Promise(r => setTimeout(r, pollInterval));
          continue;
        }

        const status = order.status; // open, closed, cancelled, expired

        if (status === 'closed') {
          return {
            price: parseFloat(order.price || order.descr?.price || '0'),
            quantity: parseFloat(order.vol_exec || order.vol || '0'),
            cost: parseFloat(order.cost || '0'),
            fee: parseFloat(order.fee || '0'),
            status: 'filled',
          };
        }

        if (status === 'cancelled' || status === 'expired') {
          return { price: 0, quantity: 0, cost: 0, fee: 0, status: 'cancelled' };
        }

        // Check for partial fill
        const volExec = parseFloat(order.vol_exec || '0');
        if (volExec > 0 && status === 'open') {
          log('info', `Order ${orderId} partially filled: ${volExec}`);
        }
      } catch (err: any) {
        log('warn', `Order poll error: ${err.message}`);
      }

      await new Promise(r => setTimeout(r, pollInterval));
    }

    // Timeout — return as still open
    return { price: 0, quantity: 0, cost: 0, fee: 0, status: 'open' };
  }

  // ============================================================
  // LIVE: Cancel Order
  // ============================================================
  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      await this.signedRequest('CancelOrder', { txid: orderId });
      log('info', `Order ${orderId} cancelled`);
      return true;
    } catch (err: any) {
      log('warn', `Cancel failed for ${orderId}: ${err.message}`);
      return false;
    }
  }

  // ============================================================
  // LIVE: Cancel All Open Orders
  // Emergency kill switch
  // ============================================================
  async cancelAllOrders(): Promise<number> {
    try {
      const result = await this.signedRequest('CancelAll');
      const count = result.count || 0;
      log('warn', `🛑 EMERGENCY: Cancelled ${count} open orders`);
      return count;
    } catch (err: any) {
      log('error', `Cancel all failed: ${err.message}`);
      return 0;
    }
  }

  // ============================================================
  // PAPER MODE: Simulated Market Buy
  // ============================================================
  private async paperMarketBuy(pair: string, amountUSD: number): Promise<OrderResult> {
    try {
      const ticker = await this.getTicker(pair);
      if (!ticker) throw new Error(`Cannot get price for ${pair}`);

      // Simulate slippage (0-0.2%)
      const slippage = 1 + (Math.random() * 0.002);
      const fillPrice = ticker.ask * slippage;
      const quantity = amountUSD / fillPrice;

      return {
        success: true,
        orderId: `paper-${Date.now()}`,
        price: fillPrice,
        quantity,
        cost: amountUSD,
        fee: 0, // Fees handled by bot.ts
        orderType: 'market',
        status: 'filled',
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  // ============================================================
  // PAPER MODE: Simulated Market Sell
  // ============================================================
  private async paperMarketSell(pair: string, quantity: number): Promise<OrderResult> {
    try {
      const ticker = await this.getTicker(pair);
      if (!ticker) throw new Error(`Cannot get price for ${pair}`);

      const slippage = 1 - (Math.random() * 0.002);
      const fillPrice = ticker.bid * slippage;

      return {
        success: true,
        orderId: `paper-${Date.now()}`,
        price: fillPrice,
        quantity,
        cost: quantity * fillPrice,
        fee: 0,
        orderType: 'market',
        status: 'filled',
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  // ============================================================
  // HELPERS
  // ============================================================
  private timeframeToMinutes(tf: string): number {
    const map: Record<string, number> = {
      '1m': 1, '5m': 5, '15m': 15, '30m': 30,
      '1h': 60, '4h': 240, '1d': 1440,
      '1': 1, '5': 5, '15': 15, '30': 30,
      '60': 60, '240': 240, '1440': 1440,
    };
    return map[tf] || parseInt(tf) || 5;
  }

  // Decimal precision for order volumes per pair
  private getVolumeDecimals(pair: string): number {
    const map: Record<string, number> = {
      'BTC/USD': 8, 'ETH/USD': 8, 'SOL/USD': 6,
      'DOGE/USD': 2, 'ADA/USD': 2, 'XRP/USD': 2,
      'DOT/USD': 6, 'AVAX/USD': 6, 'LINK/USD': 6,
    };
    return map[pair] || 6;
  }

  // Decimal precision for order prices per pair
  private getPriceDecimals(pair: string): number {
    const map: Record<string, number> = {
      'BTC/USD': 1, 'ETH/USD': 2, 'SOL/USD': 2,
      'DOGE/USD': 6, 'ADA/USD': 6, 'XRP/USD': 5,
      'DOT/USD': 4, 'AVAX/USD': 4, 'LINK/USD': 4,
    };
    return map[pair] || 4;
  }
}
