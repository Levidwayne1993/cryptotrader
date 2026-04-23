// ============================================================
// Supabase database layer — stores trades, positions, signals
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

// -- Save a signal/analysis result
export async function saveSignal(analysis: AnalysisResult): Promise<void> {
  try {
    const db = getSupabase();
    const { error } = await db.from('bot_signals').insert({
      coin_id: analysis.coin_id,
      symbol: analysis.symbol,
      pair: analysis.pair,
      action: analysis.action,
      score: analysis.score,
      confidence: analysis.confidence,
      reasoning: analysis.reasoning,
      strategy: analysis.strategy,
      current_price: analysis.current_price,
      indicators: analysis.indicators,
      timestamp: analysis.timestamp,
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

// -- Save/update positions
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

// -- Save bot settings
export async function saveSettings(settings: BotSettings): Promise<void> {
  try {
    const db = getSupabase();
    const { error } = await db
      .from('bot_settings')
      .upsert({ id: 'default', ...settings });
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
