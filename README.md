# CryptoBot Server

Persistent crypto trading bot with Kraken integration. Runs 24/7 on Railway.

## Quick Start

1. Copy `.env.example` to `.env` and fill in your values
2. Run the Supabase migration SQL in your Supabase dashboard
3. `npm install`
4. `npm run dev` (local) or deploy to Railway

## Architecture

- **Exchange**: Kraken via ccxt (real-time prices + order execution)
- **Database**: Supabase (trade history, positions, signals)
- **Hosting**: Railway (always-on persistent process)
- **Strategies**: Day Trader, Swing Trader, Scalper, DCA, Contrarian, Momentum

## Trading Modes

- `paper` — Simulated trades, no real money (default)
- `live` — Real orders on Kraken (requires API keys with trading permissions)

## Environment Variables

See `.env.example` for all configuration options.
