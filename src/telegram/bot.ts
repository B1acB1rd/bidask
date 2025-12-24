import TelegramBot from 'node-telegram-bot-api';
import { getConfig } from '../config';
import { logger } from '../utils/logger';
import { ArbitrageOpportunity, BotStatus, TradeResult } from '../types';

export class TelegramNotifier {
    private bot: TelegramBot | null = null;
    private chatId: string;
    private config = getConfig();
    private isInitialized = false;

    // Rate limiting
    private lastMessageTime = 0;
    private minMessageInterval = 1000; // 1 second between messages
    private messageQueue: string[] = [];

    // Command handlers
    private commandHandlers: Map<string, (msg: TelegramBot.Message) => void> = new Map();

    // Status getter (set by main bot)
    private statusGetter: (() => BotStatus) | null = null;

    constructor() {
        this.chatId = this.config.telegramChatId;
    }

    /**
     * Initialize Telegram bot
     */
    async initialize(): Promise<boolean> {
        if (!this.config.telegramBotToken) {
            logger.warn('⚠️ Telegram bot token not configured. Notifications disabled.');
            return false;
        }

        if (!this.chatId) {
            logger.warn('⚠️ Telegram chat ID not configured. Notifications disabled.');
            return false;
        }

        try {
            this.bot = new TelegramBot(this.config.telegramBotToken, { polling: true });

            // Set up command handlers
            this.setupCommands();

            this.isInitialized = true;
            logger.info('✅ Telegram bot initialized');

            // Send startup message
            await this.send('🤖 *Solana Arbitrage Bot Started*\n\n' +
                `Network: \`${this.config.network}\`\n` +
                'Type /help for commands');

            return true;
        } catch (error) {
            logger.error('Failed to initialize Telegram bot', error as Error);
            return false;
        }
    }

    /**
     * Set up command handlers
     */
    private setupCommands(): void {
        if (!this.bot) return;

        // /start command
        this.bot.onText(/\/start/, (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            this.send('🚀 Bot is running!\n\nUse /help to see available commands.');
        });

        // /help command
        this.bot.onText(/\/help/, (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            this.send(
                '*📖 Available Commands*\n\n' +
                '/status - Show bot status\n' +
                '/balance - Show wallet balance\n' +
                '/stats - Show trading stats\n' +
                '/opportunities - Show recent opportunities\n' +
                '/pause - Pause trading\n' +
                '/resume - Resume trading\n' +
                '/help - Show this message'
            );
        });

        // /status command
        this.bot.onText(/\/status/, (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            if (this.statusGetter) {
                const status = this.statusGetter();
                this.sendStatus(status);
            } else {
                this.send('Status not available');
            }
        });

        // /balance command
        this.bot.onText(/\/balance/, (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            if (this.statusGetter) {
                const status = this.statusGetter();
                this.send(`💰 *Wallet Balance*\n\n${status.balanceSol.toFixed(4)} SOL`);
            }
        });

        // /stats command
        this.bot.onText(/\/stats/, (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;
            if (this.statusGetter) {
                const status = this.statusGetter();
                this.send(
                    '*📊 Trading Stats*\n\n' +
                    `Opportunities: ${status.opportunitiesDetected}\n` +
                    `Trades Executed: ${status.tradesExecuted}\n` +
                    `Successful: ${status.tradesSuccessful}\n` +
                    `Failed: ${status.tradesFailed}\n` +
                    `Total Profit: $${status.totalProfitUsd.toFixed(2)}`
                );
            }
        });

        // Custom command handler for external registration
        this.bot.on('message', (msg) => {
            if (msg.chat.id.toString() !== this.chatId) return;

            const text = msg.text || '';
            for (const [pattern, handler] of this.commandHandlers) {
                if (text.startsWith(pattern)) {
                    handler(msg);
                    break;
                }
            }
        });
    }

    /**
     * Register status getter function
     */
    setStatusGetter(getter: () => BotStatus): void {
        this.statusGetter = getter;
    }

    /**
     * Register custom command handler
     */
    onCommand(command: string, handler: (msg: TelegramBot.Message) => void): void {
        this.commandHandlers.set(command, handler);
    }

    /**
     * Send message with rate limiting
     */
    async send(message: string): Promise<void> {
        if (!this.bot || !this.isInitialized) return;

        const now = Date.now();

        if (now - this.lastMessageTime < this.minMessageInterval) {
            // Queue message
            this.messageQueue.push(message);

            // Process queue after interval
            setTimeout(() => this.processQueue(), this.minMessageInterval);
            return;
        }

        try {
            await this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown' });
            this.lastMessageTime = now;
        } catch (error) {
            logger.error('Failed to send Telegram message', error as Error);
        }
    }

    /**
     * Process queued messages
     */
    private async processQueue(): Promise<void> {
        if (this.messageQueue.length === 0) return;

        const message = this.messageQueue.shift();
        if (message) {
            await this.send(message);
        }
    }

    /**
     * Send opportunity notification
     */
    async notifyOpportunity(opp: ArbitrageOpportunity): Promise<void> {
        const message =
            '🎯 *Arbitrage Opportunity*\n\n' +
            `Token: \`${opp.tokenMint.slice(0, 8)}...\`\n` +
            `Buy: ${opp.buyDex} @ ${opp.buyPrice.toFixed(6)}\n` +
            `Sell: ${opp.sellDex} @ ${opp.sellPrice.toFixed(6)}\n` +
            `Spread: ${opp.spreadBps.toFixed(2)} bps\n` +
            `Est. Profit: $${opp.estimatedProfitUsd.toFixed(4)}`;

        await this.send(message);
    }

    /**
     * Send trade result notification
     */
    async notifyTrade(result: TradeResult): Promise<void> {
        const emoji = result.success ? '✅' : '❌';
        const status = result.success ? 'Successful' : 'Failed';

        let message = `${emoji} *Trade ${status}*\n\n` +
            `Token: \`${result.opportunity.tokenMint.slice(0, 8)}...\`\n` +
            `Buy DEX: ${result.opportunity.buyDex}\n` +
            `Sell DEX: ${result.opportunity.sellDex}\n` +
            `Duration: ${result.duration}ms`;

        if (result.success && result.buyTxHash) {
            message += `\n\n[View TX](https://solscan.io/tx/${result.buyTxHash})`;
        }

        if (result.error) {
            message += `\n\nError: ${result.error}`;
        }

        await this.send(message);
    }

    /**
     * Send status update
     */
    async sendStatus(status: BotStatus): Promise<void> {
        const runningEmoji = status.isRunning ? '🟢' : '🔴';

        const message =
            `${runningEmoji} *Bot Status*\n\n` +
            `Network: \`${status.network}\`\n` +
            `Wallet: \`${status.walletAddress?.slice(0, 8) || 'N/A'}...\`\n` +
            `Balance: ${status.balanceSol.toFixed(4)} SOL\n\n` +
            `*Stats*\n` +
            `Opportunities: ${status.opportunitiesDetected}\n` +
            `Trades: ${status.tradesExecuted}\n` +
            `Success Rate: ${status.tradesExecuted > 0 ? ((status.tradesSuccessful / status.tradesExecuted) * 100).toFixed(1) : 0}%\n` +
            `Profit: $${status.totalProfitUsd.toFixed(2)}\n\n` +
            `Uptime: ${Math.floor(status.uptime / 60000)} min\n` +
            `Avg Latency: ${status.avgLatencyMs}ms`;

        await this.send(message);
    }

    /**
     * Send error notification
     */
    async notifyError(error: string): Promise<void> {
        await this.send(`⚠️ *Error*\n\n${error}`);
    }

    /**
     * Send daily summary
     */
    async sendDailySummary(stats: {
        opportunitiesDetected: number;
        tradesExecuted: number;
        tradesSuccessful: number;
        profitUsd: number;
    }): Promise<void> {
        const message =
            '📊 *Daily Summary*\n\n' +
            `Opportunities: ${stats.opportunitiesDetected}\n` +
            `Trades: ${stats.tradesExecuted}\n` +
            `Success Rate: ${stats.tradesExecuted > 0 ? ((stats.tradesSuccessful / stats.tradesExecuted) * 100).toFixed(1) : 0}%\n` +
            `Profit: $${stats.profitUsd.toFixed(2)}`;

        await this.send(message);
    }

    /**
     * Stop the bot
     */
    stop(): void {
        if (this.bot) {
            this.bot.stopPolling();
            this.isInitialized = false;
            logger.info('Telegram bot stopped');
        }
    }
}

export default TelegramNotifier;
