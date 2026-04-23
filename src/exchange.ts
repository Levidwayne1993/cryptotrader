// ============================================================
// Kraken exchange connector via ccxt
// Handles all exchange communication — prices, orders, balances
// ============================================================

import ccxt from 'ccxt';
import { CoinMarketData, OHLCV, TradeMode } from './types';
import { log } from './logger';

// Map of friendly names to Kraken trading pairs
const PAIR_MAP: Record<string, string> = {
  bitcoin:    'BTC/USD',
  ethereum:   'ETH/USD',
  solana:     'SOL/USD',
  dogecoin:   'DOGE/USD',
  cardano:    'ADA/USD',
  ripple:     'XRP/USD',
  polkadot:   'DOT/USD',
  avalanche:  'AVAX/USD',
  chainlink:  'LINK/USD',
  polygon:    'MATIC/USD',
  litecoin:   'LTC/USD',
  uniswap:    'UNI/USD',
  stellar:    'XLM/USD',
  cosmos:     'ATOM/USD',
  algorand:   'ALGO/USD',
};

export function getPair(coinId: string): string {
  return PAIR_MAP[coinId] || `${coinId.toUpperCase()}/USD`;
}

export function getSupportedPairs(): string[] {
  return Object.values(PAIR_MAP);
}

export function getCoinIdFromPair(pair: string): string {
  const entry = Object.entries(PAIR_MAP).find(([, p]) => p === pair);
  return entry ? entry[0] : pair.replace('/USD', '').toLowerCase();
}

export class KrakenExchange {
  private exchange: any;
  private mode: TradeMode;

  constructor(mode: TradeMode = 'paper') {
    this.mode = mode;

    const config: any = {
      apiKey: process.env.KRAKEN_API_KEY || '',
      secret: process.env.KRAKEN_API_SECRET || '',
      enableRateLimit: true,
      timeout: 30000,
    };

    // Use Kraken's sandbox for paper trading if available
    if (mode === 'paper') {
      log('info', 'Exchange initialized in PAPER mode — no real orders will be placed');
    } else {
      log('warn', '⚠️  Exchange initialized in LIVE mode — real money at risk');
    }

    this.exchange = new ccxt.kraken(config);
  }

  // -- Connection test
  async testConnection(): Promise<boolean> {
    try {
      const markets = await this.exchange.loadMarkets();
      log('info', `Connected to Kraken — ${Object.keys(markets).length} markets available`);
      return true;
    } catch (err: any) {
      log('error', `Kraken connection failed: ${err.message}`);
      return false;
    }
  }

  // -- Fetch current ticker price for a pair
  async getPrice(pair: string): Promise<number> {
    try {
      const ticker = await this.exchange.fetchTicker(pair);
      return ticker.last || 0;
    } catch (err: any) {
      log('error', `Failed to fetch price for ${pair}: ${err.message}`);
      return 0;
    }
  }

  // -- Fetch OHLCV candles for technical analysis
  async getOHLCV(
    pair: string,
    timeframe: string = '1h',
    limit: number = 200
  ): Promise<OHLCV[]> {
    try {
      const candles = await this.exchange.fetchOHLCV(pair, timeframe, undefined, limit);
      return candles.map((c: any) => ({
        timestamp: c[0] as number,
        open: c[1] as number,
        high: c[2] as number,
        low: c[3] as number,
        close: c[4] as number,
        volume: c[5] as number,
      }));
    } catch (err: any) {
      log('error', `Failed to fetch OHLCV for ${pair}: ${err.message}`);
      return [];
    }
  }

  // -- Fetch full market data for a coin (price + history)
  async getMarketData(pair: string): Promise<CoinMarketData | null> {
    try {
      const [ticker, ohlcv] = await Promise.all([
        this.exchange.fetchTicker(pair),
        this.getOHLCV(pair, '1h', 200),
      ]);

      return {
        symbol: pair.split('/')[0],
        pair,
        current_price: ticker.last || 0,
        price_change_24h: ticker.percentage || 0,
        volume_24h: ticker.quoteVolume || 0,
        market_cap: 0, // Kraken doesn't provide market cap
        ohlcv,
      };
    } catch (err: any) {
      log('error', `Failed to fetch market data for ${pair}: ${err.message}`);
      return null;
    }
  }

  // -- Fetch market data for multiple pairs
  async getMultipleMarketData(pairs: string[]): Promise<CoinMarketData[]> {
    const results: CoinMarketData[] = [];
    // Process in batches of 3 to respect rate limits
    for (let i = 0; i < pairs.length; i += 3) {
      const batch = pairs.slice(i, i + 3);
      const batchResults = await Promise.all(
        batch.map((pair) => this.getMarketData(pair))
      );
      for (const result of batchResults) {
        if (result) results.push(result);
      }
      // Small delay between batches for rate limiting
      if (i + 3 < pairs.length) {
        await sleep(1000);
      }
    }
    return results;
  }

  // -- Get account balance
  async getBalance(): Promise<{ total: number; free: number; used: number; currencies: Record<string, number> }> {
    if (this.mode === 'paper') {
      return { total: 0, free: 0, used: 0, currencies: {} };
    }
    try {
      const balance = await this.exchange.fetchBalance();
      const currencies: Record<string, number> = {};
      for (const [currency, data] of Object.entries(balance.total || {})) {
        if (data && (data as number) > 0) {
          currencies[currency] = data as number;
        }
      }
      return {
        total: (balance.total?.['USD'] as number) || 0,
        free: (balance.free?.['USD'] as number) || 0,
        used: (balance.used?.['USD'] as number) || 0,
        currencies,
      };
    } catch (err: any) {
      log('error', `Failed to fetch balance: ${err.message}`);
      return { total: 0, free: 0, used: 0, currencies: {} };
    }
  }

  // -- Place a market buy order
  async marketBuy(
    pair: string,
    usdAmount: number
  ): Promise<{ success: boolean; orderId?: string; price?: number; quantity?: number; error?: string }> {
    if (this.mode === 'paper') {
      const price = await this.getPrice(pair);
      if (price === 0) return { success: false, error: 'Could not fetch price' };
      const quantity = usdAmount / price;
      log('info', `[PAPER] BUY ${quantity.toFixed(8)} ${pair} @ $${price.toFixed(2)} = $${usdAmount.toFixed(2)}`);
      return {
        success: true,
        orderId: `paper_${Date.now()}`,
        price,
        quantity,
      };
    }

    try {
      const price = await this.getPrice(pair);
      if (price === 0) return { success: false, error: 'Could not fetch price' };

      const quantity = usdAmount / price;

      // Fetch market info for minimum order size
      await this.exchange.loadMarkets();
      const market = this.exchange.markets[pair];
      if (market && market.limits?.amount?.min && quantity < market.limits.amount.min) {
        return {
          success: false,
          error: `Order too small. Minimum: ${market.limits.amount.min} ${pair.split('/')[0]}`,
        };
      }

      const order = await this.exchange.createMarketBuyOrder(pair, quantity);
      log('info', `LIVE BUY ${quantity.toFixed(8)} ${pair} — Order ID: ${order.id}`);
      return {
        success: true,
        orderId: order.id,
        price: order.average || price,
        quantity: order.filled || quantity,
      };
    } catch (err: any) {
      log('error', `BUY order failed for ${pair}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // -- Place a market sell order
  async marketSell(
    pair: string,
    quantity: number
  ): Promise<{ success: boolean; orderId?: string; price?: number; error?: string }> {
    if (this.mode === 'paper') {
      const price = await this.getPrice(pair);
      if (price === 0) return { success: false, error: 'Could not fetch price' };
      log('info', `[PAPER] SELL ${quantity.toFixed(8)} ${pair} @ $${price.toFixed(2)} = $${(quantity * price).toFixed(2)}`);
      return {
        success: true,
        orderId: `paper_${Date.now()}`,
        price,
      };
    }

    try {
      const order = await this.exchange.createMarketSellOrder(pair, quantity);
      log('info', `LIVE SELL ${quantity.toFixed(8)} ${pair} — Order ID: ${order.id}`);
      return {
        success: true,
        orderId: order.id,
        price: order.average || 0,
      };
    } catch (err: any) {
      log('error', `SELL order failed for ${pair}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // -- Get minimum order size for a pair
  async getMinOrderSize(pair: string): Promise<number> {
    try {
      await this.exchange.loadMarkets();
      const market = this.exchange.markets[pair];
      return market?.limits?.amount?.min || 0;
    } catch {
      return 0;
    }
  }

  getMode(): TradeMode {
    return this.mode;
  }

  setMode(mode: TradeMode): void {
    this.mode = mode;
    log('info', `Exchange mode changed to: ${mode.toUpperCase()}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
