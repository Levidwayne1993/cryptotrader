// ============================================================
// PROJECT: cryptotrader
// FILE: src/alerts.ts  (NEW FILE)
// DESCRIPTION: Discord & Telegram notification system
//   Sends real-time alerts for trades, signals, and errors
// ============================================================

import { AlertMessage } from './types';
import { log } from './logger';

// ---- Discord Webhook ----
async function sendDiscord(webhookUrl: string, message: AlertMessage): Promise<void> {
  if (!webhookUrl) return;

  const colorMap: Record<string, number> = {
    trade_opened: 0x00ff00,   // green
    trade_closed: 0xff9900,   // orange
    signal: 0x00bfff,         // cyan
    circuit_breaker: 0xff0000, // red
    whale_alert: 0x9b59b6,    // purple
    error: 0xff0000,          // red
    daily_summary: 0x3498db,  // blue
  };

  const embed = {
    title: `${message.emoji} ${message.title}`,
    description: message.body,
    color: colorMap[message.type] || 0xffffff,
    timestamp: message.timestamp,
    footer: { text: 'CryptoTrader Bot' },
    fields: message.data
      ? Object.entries(message.data).map(([k, v]) => ({
          name: k,
          value: String(v),
          inline: true,
        }))
      : [],
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!response.ok) {
      log('warn', `Discord alert failed: ${response.status}`);
    }
  } catch (err: any) {
    log('warn', `Discord alert error: ${err.message}`);
  }
}

// ---- Telegram Bot ----
async function sendTelegram(
  botToken: string,
  chatId: string,
  message: AlertMessage
): Promise<void> {
  if (!botToken || !chatId) return;

  // Build formatted message
  let text = `${message.emoji} *${escapeMarkdown(message.title)}*\n\n`;
  text += escapeMarkdown(message.body);

  if (message.data) {
    text += '\n\n';
    for (const [key, value] of Object.entries(message.data)) {
      text += `*${escapeMarkdown(key)}:* ${escapeMarkdown(String(value))}\n`;
    }
  }

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      }),
    });
    if (!response.ok) {
      // Retry without markdown if parsing fails
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `${message.emoji} ${message.title}\n\n${message.body}`,
        }),
      });
    }
  } catch (err: any) {
    log('warn', `Telegram alert error: ${err.message}`);
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

// ---- Alert Manager ----
export class AlertManager {
  private discordWebhook: string;
  private telegramToken: string;
  private telegramChatId: string;
  private enabled: boolean;
  private channels: string[];

  constructor(config: {
    discord_webhook_url?: string;
    telegram_bot_token?: string;
    telegram_chat_id?: string;
    enabled?: boolean;
    channels?: string[];
  }) {
    this.discordWebhook = config.discord_webhook_url || process.env.DISCORD_WEBHOOK_URL || '';
    this.telegramToken = config.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN || '';
    this.telegramChatId = config.telegram_chat_id || process.env.TELEGRAM_CHAT_ID || '';
    this.enabled = config.enabled !== false;
    this.channels = config.channels || ['discord', 'telegram'];
  }

  async send(message: AlertMessage): Promise<void> {
    if (!this.enabled) return;

    const promises: Promise<void>[] = [];

    if (this.channels.includes('discord') && this.discordWebhook) {
      promises.push(sendDiscord(this.discordWebhook, message));
    }
    if (this.channels.includes('telegram') && this.telegramToken) {
      promises.push(sendTelegram(this.telegramToken, this.telegramChatId, message));
    }

    await Promise.allSettled(promises);
  }

  // ---- Pre-built Alert Templates ----

  async tradeOpened(data: {
    pair: string;
    price: number;
    quantity: number;
    positionSize: number;
    score: number;
    confidence: number;
    stopLoss: number;
    takeProfit: number;
    strategy: string;
    kellyFraction?: number;
  }): Promise<void> {
    await this.send({
      type: 'trade_opened',
      emoji: '🟢',
      title: `BUY ${data.pair}`,
      body: `Opened position at $${data.price.toLocaleString()}`,
      timestamp: new Date().toISOString(),
      data: {
        'Size': `$${data.positionSize.toFixed(2)}`,
        'Qty': data.quantity.toFixed(8),
        'Score': data.score,
        'Confidence': `${data.confidence}%`,
        'Stop Loss': `$${data.stopLoss.toFixed(2)}`,
        'Take Profit': `$${data.takeProfit.toFixed(2)}`,
        'Strategy': data.strategy,
        ...(data.kellyFraction ? { 'Kelly %': `${data.kellyFraction}%` } : {}),
      },
    });
  }

  async tradeClosed(data: {
    pair: string;
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    pnlPercent: number;
    reason: string;
    holdTime: string;
  }): Promise<void> {
    const won = data.pnl >= 0;
    await this.send({
      type: 'trade_closed',
      emoji: won ? '💰' : '📉',
      title: `SELL ${data.pair} — ${won ? 'WIN' : 'LOSS'}`,
      body: `Closed at $${data.exitPrice.toLocaleString()} (${data.reason})`,
      timestamp: new Date().toISOString(),
      data: {
        'P&L': `${data.pnl >= 0 ? '+' : ''}$${data.pnl.toFixed(2)}`,
        'Return': `${data.pnlPercent >= 0 ? '+' : ''}${data.pnlPercent.toFixed(2)}%`,
        'Entry': `$${data.entryPrice.toLocaleString()}`,
        'Exit': `$${data.exitPrice.toLocaleString()}`,
        'Hold Time': data.holdTime,
        'Reason': data.reason,
      },
    });
  }

  async circuitBreakerTripped(data: {
    reason: string;
    dailyLoss: number;
    consecutiveLosses: number;
    resumeAt: string;
  }): Promise<void> {
    await this.send({
      type: 'circuit_breaker',
      emoji: '🛑',
      title: 'CIRCUIT BREAKER TRIPPED',
      body: `Trading paused: ${data.reason}`,
      timestamp: new Date().toISOString(),
      data: {
        'Daily Loss': `${data.dailyLoss.toFixed(2)}%`,
        'Consecutive Losses': data.consecutiveLosses,
        'Resumes At': data.resumeAt,
      },
    });
  }

  async whaleMovement(data: {
    coin: string;
    amount: number;
    amountUsd: number;
    direction: string;
    exchange?: string;
  }): Promise<void> {
    await this.send({
      type: 'whale_alert',
      emoji: '🐋',
      title: `Whale Movement — ${data.coin}`,
      body: `${data.amount.toLocaleString()} ${data.coin} ($${(data.amountUsd / 1e6).toFixed(1)}M) moved ${data.direction}`,
      timestamp: new Date().toISOString(),
      data: {
        'Amount': `${data.amount.toLocaleString()} ${data.coin}`,
        'Value': `$${data.amountUsd.toLocaleString()}`,
        'Direction': data.direction,
        ...(data.exchange ? { 'Exchange': data.exchange } : {}),
      },
    });
  }

  async dailySummary(data: {
    balance: number;
    dayPnl: number;
    dayPnlPercent: number;
    tradesOpened: number;
    tradesClosed: number;
    winRate: number;
    openPositions: number;
    unrealizedPnl: number;
  }): Promise<void> {
    const up = data.dayPnl >= 0;
    await this.send({
      type: 'daily_summary',
      emoji: up ? '📊' : '📉',
      title: 'Daily Trading Summary',
      body: `${up ? 'Profitable' : 'Down'} day: ${up ? '+' : ''}$${data.dayPnl.toFixed(2)} (${up ? '+' : ''}${data.dayPnlPercent.toFixed(2)}%)`,
      timestamp: new Date().toISOString(),
      data: {
        'Balance': `$${data.balance.toFixed(2)}`,
        'Day P&L': `${up ? '+' : ''}$${data.dayPnl.toFixed(2)}`,
        'Trades Opened': data.tradesOpened,
        'Trades Closed': data.tradesClosed,
        'Win Rate': `${data.winRate.toFixed(1)}%`,
        'Open Positions': data.openPositions,
        'Unrealized P&L': `$${data.unrealizedPnl.toFixed(2)}`,
      },
    });
  }

  async error(title: string, errorMessage: string): Promise<void> {
    await this.send({
      type: 'error',
      emoji: '❌',
      title: `Error: ${title}`,
      body: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }
}
