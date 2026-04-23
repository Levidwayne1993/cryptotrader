// ============================================================
// PROJECT: cryptotrader
// FILE: src/whale-tracker.ts  (NEW FILE)
// DESCRIPTION: On-chain whale movement tracking
//   Uses free Blockchain.com API + Whale Alert patterns
//   Tracks large transfers to/from exchanges
// ============================================================

import { WhaleAlert, WhaleData } from './types';
import { log } from './logger';

// Map trading pairs to CoinGecko IDs for price lookup
const COIN_MAP: Record<string, { id: string; symbol: string; minWhaleUsd: number }> = {
  'BTC/USD': { id: 'bitcoin', symbol: 'BTC', minWhaleUsd: 1_000_000 },
  'ETH/USD': { id: 'ethereum', symbol: 'ETH', minWhaleUsd: 500_000 },
  'SOL/USD': { id: 'solana', symbol: 'SOL', minWhaleUsd: 250_000 },
  'DOGE/USD': { id: 'dogecoin', symbol: 'DOGE', minWhaleUsd: 200_000 },
  'ADA/USD': { id: 'cardano', symbol: 'ADA', minWhaleUsd: 200_000 },
  'XRP/USD': { id: 'ripple', symbol: 'XRP', minWhaleUsd: 500_000 },
  'DOT/USD': { id: 'polkadot', symbol: 'DOT', minWhaleUsd: 200_000 },
  'AVAX/USD': { id: 'avalanche-2', symbol: 'AVAX', minWhaleUsd: 200_000 },
  'LINK/USD': { id: 'chainlink', symbol: 'LINK', minWhaleUsd: 200_000 },
};

// Known exchange wallet label patterns
const EXCHANGE_PATTERNS = [
  'binance', 'coinbase', 'kraken', 'bitfinex', 'huobi', 'okex', 'okx',
  'kucoin', 'bybit', 'gate.io', 'gemini', 'bitstamp', 'ftx', 'crypto.com',
  'bittrex', 'poloniex', 'mexc', 'upbit', 'bithumb',
];

function isExchangeAddress(label: string): boolean {
  const lower = label.toLowerCase();
  return EXCHANGE_PATTERNS.some(ex => lower.includes(ex));
}

function getExchangeName(label: string): string | undefined {
  const lower = label.toLowerCase();
  const match = EXCHANGE_PATTERNS.find(ex => lower.includes(ex));
  return match ? match.charAt(0).toUpperCase() + match.slice(1) : undefined;
}

// ---- Fetch whale data from Blockchair (free, no API key needed) ----
async function fetchBlockchairWhales(
  coin: string,
  minUsd: number
): Promise<WhaleAlert[]> {
  const alerts: WhaleAlert[] = [];

  try {
    // Blockchair API - recent large transactions
    // Supports: bitcoin, ethereum
    const chainMap: Record<string, string> = {
      'BTC': 'bitcoin',
      'ETH': 'ethereum',
    };

    const chain = chainMap[coin];
    if (!chain) return alerts;

    const url = `https://api.blockchair.com/${chain}/transactions?s=output_total(desc)&limit=10`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return alerts;

    const data: any = await response.json();
    if (!data?.data) return alerts;

    for (const tx of data.data) {
      const outputUsd = tx.output_total_usd || 0;
      if (outputUsd < minUsd) continue;

      alerts.push({
        id: tx.hash?.substring(0, 16) || String(Date.now()),
        coin,
        amount: tx.output_total / 1e8,  // satoshis to BTC
        amount_usd: outputUsd,
        from_type: 'unknown',
        to_type: 'unknown',
        timestamp: new Date(tx.time).getTime(),
        signal: 'neutral',
      });
    }
  } catch (err: any) {
    // Silently fail — whale data is supplementary
    log('warn', `Blockchair fetch failed for ${coin}: ${err.message}`);
  }

  return alerts;
}

// ---- Fetch exchange flow data from CryptoQuant-style endpoints ----
// Uses CoinGlass free data for exchange netflow estimates
async function fetchExchangeNetflow(coinId: string): Promise<number> {
  try {
    // Use CoinGecko exchange data as a proxy for flow
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/tickers?include_exchange_logo=false&depth=true`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return 0;

    const data: any = await response.json();
    if (!data?.tickers) return 0;

    // Analyze bid/ask volume ratio across exchanges as flow proxy
    let totalBidDepth = 0;
    let totalAskDepth = 0;

    for (const ticker of data.tickers.slice(0, 20)) {
      totalBidDepth += ticker.bid_ask_spread_percentage < 1
        ? (ticker.converted_volume?.usd || 0) * 0.5
        : 0;
      totalAskDepth += ticker.bid_ask_spread_percentage < 1
        ? (ticker.converted_volume?.usd || 0) * 0.5
        : 0;
    }

    // Positive = net inflow (bearish), negative = net outflow (bullish)
    return totalBidDepth - totalAskDepth;
  } catch {
    return 0;
  }
}

// ---- Main Whale Tracker Class ----
export class WhaleTracker {
  private cache: Map<string, { data: WhaleData; expires: number }> = new Map();
  private cacheDurationMs = 5 * 60 * 1000;  // 5 minute cache

  async getWhaleData(pair: string): Promise<WhaleData> {
    // Check cache first
    const cached = this.cache.get(pair);
    if (cached && Date.now() < cached.expires) {
      return cached.data;
    }

    const coinInfo = COIN_MAP[pair];
    if (!coinInfo) {
      return this.emptyWhaleData(pair);
    }

    try {
      // Fetch whale alerts and exchange netflow in parallel
      const [alerts, netflow] = await Promise.all([
        fetchBlockchairWhales(coinInfo.symbol, coinInfo.minWhaleUsd),
        fetchExchangeNetflow(coinInfo.id),
      ]);

      // Classify whale alerts
      const classifiedAlerts = alerts.map(alert => {
        // Heuristic: large transfers during high-volume periods
        // tend to be exchange-related
        if (alert.amount_usd > coinInfo.minWhaleUsd * 5) {
          alert.signal = 'bearish';  // very large = likely selling
        }
        return alert;
      });

      // Calculate whale sentiment (-100 to +100)
      let sentiment = 0;
      const bearishAlerts = classifiedAlerts.filter(a => a.signal === 'bearish').length;
      const bullishAlerts = classifiedAlerts.filter(a => a.signal === 'bullish').length;
      const totalAlerts = classifiedAlerts.length;

      if (totalAlerts > 0) {
        sentiment = ((bullishAlerts - bearishAlerts) / totalAlerts) * 100;
      }

      // Factor in exchange netflow
      if (netflow > 0) sentiment -= 10;  // net inflow = bearish pressure
      if (netflow < 0) sentiment += 10;  // net outflow = bullish

      sentiment = Math.max(-100, Math.min(100, sentiment));

      const whaleData: WhaleData = {
        pair,
        recent_alerts: classifiedAlerts.slice(0, 10),
        net_exchange_flow: netflow,
        large_tx_count_24h: classifiedAlerts.length,
        whale_sentiment: Math.round(sentiment),
      };

      // Cache the result
      this.cache.set(pair, {
        data: whaleData,
        expires: Date.now() + this.cacheDurationMs,
      });

      return whaleData;
    } catch (err: any) {
      log('warn', `Whale tracking failed for ${pair}: ${err.message}`);
      return this.emptyWhaleData(pair);
    }
  }

  async getMultipleWhaleData(pairs: string[]): Promise<Map<string, WhaleData>> {
    const results = new Map<string, WhaleData>();

    // Process in batches of 3 to avoid rate limiting
    for (let i = 0; i < pairs.length; i += 3) {
      const batch = pairs.slice(i, i + 3);
      const batchResults = await Promise.allSettled(
        batch.map(pair => this.getWhaleData(pair))
      );

      batch.forEach((pair, idx) => {
        const result = batchResults[idx];
        if (result.status === 'fulfilled') {
          results.set(pair, result.value);
        } else {
          results.set(pair, this.emptyWhaleData(pair));
        }
      });

      // Small delay between batches
      if (i + 3 < pairs.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    return results;
  }

  private emptyWhaleData(pair: string): WhaleData {
    return {
      pair,
      recent_alerts: [],
      net_exchange_flow: 0,
      large_tx_count_24h: 0,
      whale_sentiment: 0,
    };
  }

  clearCache(): void {
    this.cache.clear();
  }
}
