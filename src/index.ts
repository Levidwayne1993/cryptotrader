// ============================================================
// Entry point — starts the persistent trading bot
// ============================================================

import dotenv from 'dotenv';
dotenv.config();

import { TradingBot } from './bot';
import { initDatabase } from './database';
import { log } from './logger';

async function main() {
  log('info', 'CryptoBot Server v1.0.0');

  // Validate required environment variables
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    log('error', `Missing required environment variables: ${missing.join(', ')}`);
    log('info', 'Copy .env.example to .env and fill in your values.');
    process.exit(1);
  }

  // Warn if no Kraken keys in live mode
  if (process.env.TRADE_MODE === 'live') {
    if (!process.env.KRAKEN_API_KEY || !process.env.KRAKEN_API_SECRET) {
      log('error', 'LIVE mode requires KRAKEN_API_KEY and KRAKEN_API_SECRET');
      process.exit(1);
    }
  }

  // Initialize database
  await initDatabase();

  // Start the bot
  const bot = new TradingBot();
  await bot.start();
}

main().catch((err) => {
  log('error', `Fatal error: ${err.message}`);
  process.exit(1);
});
