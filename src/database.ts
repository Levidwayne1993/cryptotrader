// ============================================================
// PROJECT: cryptotrader
// FILE: src/database.ts
// DESCRIPTION: Supabase database layer — NOW saves all pro fields
//   ADX, ATR, multi-timeframe, whale flow, Kelly, exit reason
// ============================================================

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { BotTrade, BotPosition, BotSettings, AnalysisResult } from './types';
import { log } from './logger';

let supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!supabase) {
    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!url || !key) {
      log('warn', 'Supabase credentials missing — database logging disabled');
    }
    supabase = createClient(url, key);
  }
  return supabase;
}

// -- Save a trade to the database
export async function saveTrade(trade: BotTrade): Promise<void> {
  try {
    const db = getSupabase();
    const { error } = await db.from('bot_trades').insert({
      coin_id: trade.coin_id,
      symbol: trade.symbol,
      pair: trade.pair,
      action: trade.action,
      strategy: trade.strategy,
      entry_price: trade.entry_price,
      exit_price: trade.exit_price || null,
      quantity: trade.quantity,
      position_value: trade.position_value,
      pnl: trade.pnl || null,
      pnl_percent: trade.pnl_percent || null,
      score: trade.score,
      confidence: trade.confidence,
      reasoning: trade.reasoning,
      status: trade.status,
      stop_loss_price: trade.stop_loss_price,
      take_profit_price: trade.take_profit_price,
      trailing_stop_price: trade.trailing_stop_price || null,
      opened_at: trade.opened_at,
      closed_at: trade.closed_at || null,
      order_id: trade.order_id || null,
      mode: trade.mode,
      // PRO FIELDS
      exit_reason: trade.exit_reason || null,
      kelly_fraction: trade.kelly_fraction || null,
      atr_at_entry: trade.atr_at_entry || null,
      risk_amount: trade.risk_amount || null,
      timeframe_alignment: trade.timeframe_alignment || null,
    });

    if (error) {
      log('error', `Failed to save trade: ${error.message}`);
    } else {
      log('info', `Trade saved: ${trade.action} ${trade.symbol} @ $${trade.entry_price}`);
    }
  } catch (err: any) {
    log('error', `Database error saving trade: ${err.message}`);
  }
}

// -- Update a trade (e.g., when closing)
export async function updateTrade(
  tradeId: string,
  updates: Partial<BotTrade>
): Promise<void> {
  try {
    const db = getSupabase();
    const { error } = await db
      .from('bot_trades')
      .update(updates)
      .eq('id', tradeId);

    if (error) {
      log('error', `Failed to update trade ${tradeId}: ${error.message}`);
    }
  } catch (err: any) {
    log('error', `Database error updating trade: ${err.message}`);
  }
}

// -- Save a signal/analysis result (with PRO fields)
export async function saveSignal(analysis: AnalysisResult): Promise<void> {
  try {
    const db = getSupabase();

    // Extract pro indicator data
    const adx = analysis.indicator_details?.adx?.adx ?? null;
    const atrPercent = analysis.indicator_details?.atr?.atr_percent ?? null;
    const multiTfAlignment = analysis.multi_timeframe?.alignment ?? null;
    const whaleSentiment = analysis.whale_data?.whale_sentiment ?? null;
    const orderBookImbalance = analysis.order_book?.imbalance ?? null;

    // Determine whale flow direction
    let whaleFlow: string | null = null;
    if (whaleSentiment !== null) {
      if (whaleSentiment > 15) whaleFlow = 'bullish';
      else if (whaleSentiment < -15) whaleFlow = 'bearish';
      else whaleFlow = 'neutral';
    }

    const { error } = await db.from('bot_signals').insert({
      pair: analysis.pair,
      symbol: analysis.symbol,
      action: analysis.action,
      score: analysis.score,
      confidence: analysis.confidence,
      reasoning: analysis.reasoning,
      current_price: analysis.current_price,
      indicators: analysis.indicators,
      created_at: new Date().toISOString(),
      // PRO FIELDS
      adx: adx,
      atr_percent: atrPercent,
      multi_timeframe_alignment: multiTfAlignment,
      whale_flow: whaleFlow,
      whale_sentiment: whaleSentiment,
      order_book_imbalance: orderBookImbalance,
      ichimoku_strength: analysis.indicator_details?.ichimoku?.signal_strength ?? null,
      vwap_position: analysis.indicator_details?.vwap?.position ?? null,
      obv_trend: analysis.indicator_details?.obv?.obv_trend ?? null,
      obv_divergence: analysis.indicator_details?.obv?.divergence ?? null,
      fib_zone: analysis.indicator_details?.fibonacci?.current_zone ?? null,
      dominant_trend: analysis.multi_timeframe?.dominant_trend ?? null,
    });

    if (error && !error.message.includes('does not exist')) {
      log('error', `Failed to save signal: ${error.message}`);
    }
  } catch (err: any) {
    // Signals table might not exist yet — that's okay
  }
}

// -- Load open positions from database
export async function loadPositions(): Promise<BotPosition[]> {
  try {
    const db = getSupabase();
    const { data, error } = await db
      .from('bot_positions')
      .select('*')
      .order('opened_at', { ascending: false });

    if (error) {
      log('warn', `Could not load positions: ${error.message}`);
      return [];
    }
    return (data || []) as BotPosition[];
  } catch {
    return [];
  }
}

// -- Save/update positions (with PRO fields)
export async function savePositions(positions: BotPosition[]): Promise<void> {
  try {
    const db = getSupabase();

    // Clear old positions and insert current ones
    await db.from('bot_positions').delete().neq('coin_id', '___never___');

    if (positions.length > 0) {
      const { error } = await db.from('bot_positions').insert(
        positions.map((p) => ({
          coin_id: p.coin_id,
          symbol: p.symbol,
          pair: p.pair,
          entry_price: p.entry_price,
          current_price: p.current_price,
          quantity: p.quantity,
          position_value: p.position_value,
          unrealized_pnl: p.unrealized_pnl,
          unrealized_pnl_percent: p.unrealized_pnl_percent,
          stop_loss_price: p.stop_loss_price,
          take_profit_price: p.take_profit_price,
          trailing_stop_price: p.trailing_stop_price || null,
          highest_price: p.highest_price,
          strategy: p.strategy,
          opened_at: p.opened_at,
          order_id: p.order_id || null,
          // PRO FIELDS
          atr_at_entry: p.atr_at_entry || null,
          kelly_fraction: p.kelly_fraction || null,
          risk_amount: p.risk_amount || null,
          timeframe_alignment: p.timeframe_alignment || null,
        }))
      );

      if (error) {
        log('error', `Failed to save positions: ${error.message}`);
      }
    }
  } catch (err: any) {
    log('error', `Database error saving positions: ${err.message}`);
  }
}

// -- Load recent trades
export async function loadRecentTrades(limit: number = 50): Promise<BotTrade[]> {
  try {
    const db = getSupabase();
    const { data, error } = await db
      .from('bot_trades')
      .select('*')
      .order('opened_at', { ascending: false })
      .limit(limit);

    if (error) {
      log('warn', `Could not load trades: ${error.message}`);
      return [];
    }
    return (data || []) as BotTrade[];
  } catch {
    return [];
  }
}

// -- Save bot settings (with PRO fields)
export async function saveSettings(settings: BotSettings): Promise<void> {
  try {
    const db = getSupabase();
    const { error } = await db
      .from('bot_settings')
      .upsert({
        id: 'default',
        enabled: settings.enabled,
        strategy: settings.strategy,
        mode: settings.mode,
        initial_balance: settings.initial_balance,
        current_balance: settings.current_balance,
        selected_pairs: settings.selected_pairs,
        max_daily_trades: settings.max_daily_trades,
        daily_loss_limit_percent: settings.daily_loss_limit_percent,
        // PRO FIELDS
        alerts_enabled: settings.alerts_enabled || false,
        correlation_guard_enabled: settings.correlation_guard_enabled || false,
        kelly_sizing_enabled: settings.kelly_sizing_enabled || false,
        whale_tracking_enabled: settings.whale_tracking_enabled || false,
        updated_at: new Date().toISOString(),
      });

    if (error && !error.message.includes('does not exist')) {
      log('error', `Failed to save settings: ${error.message}`);
    }
  } catch (err: any) {
    log('error', `Database error saving settings: ${err.message}`);
  }
}

// -- Load bot settings
export async function loadSettings(): Promise<BotSettings | null> {
  try {
    const db = getSupabase();
    const { data, error } = await db
      .from('bot_settings')
      .select('*')
      .eq('id', 'default')
      .single();

    if (error || !data) return null;
    return data as BotSettings;
  } catch {
    return null;
  }
}

// -- Initialize database tables (run once)
export async function initDatabase(): Promise<void> {
  log('info', 'Checking database tables...');
  const db = getSupabase();

  // Test connection
  const { error } = await db.from('bot_trades').select('id').limit(1);

  if (error && error.message.includes('does not exist')) {
    log('warn', 'Database tables not found — you need to run the migration SQL. See setup instructions.');
  } else if (error) {
    log('warn', `Database check: ${error.message}`);
  } else {
    log('info', 'Database tables verified');
  }
}
