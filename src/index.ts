

import { Connection } from '@solana/web3.js';
import { getConfig, TOKENS } from './config';
import { logger } from './utils/logger';
import { WalletManager } from './wallet/manager';
import { PriceAggregator } from './feeds/aggregator';
import { ArbitrageDetector } from './engine/detector';
import { RiskManager } from './engine/risk';
import { TradeExecutor } from './engine/executor';
import { TelegramNotifier } from './telegram/bot';
import { ArbitrageOpportunity, BotStatus } from './types';

import dns from 'dns';
// Force use of Google Public DNS to bypass local ISP/Router blocking
try {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (e) {
    // Ignore errors if setting DNS fails
}

import express from 'express';


// Start dummy HTTP server for Render/Railway keep-alive
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running! 🚀'));
app.get('/health', (req, res) => res.status(200).send('OK'));
app.listen(PORT, () => console.log(`🌍 Web server running on port ${PORT}`));

export class SolanaArbitrageBot {
    private config = getConfig();
    private connection: Connection;
    private wallet: WalletManager;
    private aggregator: PriceAggregator;
    private detector: ArbitrageDetector;
    private riskManager: RiskManager;
    private executor: TradeExecutor;
    private telegram: TelegramNotifier;
    private currentBalance: number = 0;

    // Bot state
    private isRunning = false;
    private isPaused = false;
    private startTime = Date.now();
    private scanInterval: NodeJS.Timeout | null = null;

    // Stats
    private opportunitiesDetected = 0;
    private tradesExecuted = 0;
    private tradesSuccessful = 0;
    private tradesFailed = 0;
    private totalProfitUsd = 0;

    // Token list to monitor
    private monitoredTokens: string[] = [];

    constructor() {
        // Initialize connection
        this.connection = new Connection(this.config.rpcUrl, {
            commitment: 'confirmed',
            wsEndpoint: this.config.wsUrl,
        });

        // Initialize components
        this.wallet = new WalletManager(this.connection);
        this.aggregator = new PriceAggregator(this.connection);
        this.detector = new ArbitrageDetector(this.connection, this.aggregator);
        this.riskManager = new RiskManager();
        this.executor = new TradeExecutor(this.connection, this.wallet);
        this.telegram = new TelegramNotifier();

        // Set default tokens to monitor
        this.monitoredTokens = [
            TOKENS.BONK,
            TOKENS.JUP,
            TOKENS.RAY,
            TOKENS.ORCA,
        ];
    }

    /**
     * Start the bot
     */
    async start(): Promise<void> {
        logger.info('🚀 Starting Solana Arbitrage Bot...');
        logger.info(`📡 Network: ${this.config.network}`);
        logger.info(`🔗 RPC: ${this.config.rpcUrl}`);

        try {
            // Initialize wallet
            const walletInitialized = await this.wallet.initialize();

            if (!walletInitialized) {
                logger.warn('⚠️ Running in monitoring mode (no wallet)');
            } else {
                // Request airdrop on devnet if balance is low
                if (this.config.network === 'devnet') {
                    const balance = await this.wallet.getBalance();
                    if (balance < 0.1) {
                        logger.info('Requesting devnet airdrop...');
                        await this.wallet.requestAirdrop(2);
                    }
                }
            }

            // Initialize Telegram
            await this.telegram.initialize();
            this.telegram.setStatusGetter(() => this.getStatus());

            // Set up Telegram command handlers
            this.setupTelegramCommands();

            // Set up opportunity callback
            this.detector.onOpportunity((opp) => this.handleOpportunity(opp));

            // Start scanning loop
            this.isRunning = true;
            this.startScanLoop();

            logger.info('✅ Bot started successfully!');
            logger.info(`📊 Monitoring ${this.monitoredTokens.length} tokens`);

            // Keep process alive
            process.on('SIGINT', () => this.shutdown());
            process.on('SIGTERM', () => this.shutdown());

        } catch (error) {
            logger.error('Failed to start bot', error as Error);
            throw error;
        }
    }

    /**
     * Main scanning loop
     */
    private startScanLoop(): void {
        const scanTokens = async () => {
            if (!this.isRunning || this.isPaused) return;

            try {
                const startTime = Date.now();

                // Scan for opportunities
                const START_SCAN = Date.now();

                // Update balance periodically (every scan is fine, or every 5 scans)
                this.currentBalance = await this.wallet.getBalance();

                const opportunities = await this.detector.scanTokens(
                    this.monitoredTokens,
                    TOKENS.SOL,
                    this.config.maxTradeSizeSol
                );

                const scanTime = Date.now() - startTime;

                if (opportunities.length > 0) {
                    logger.info(`Found ${opportunities.length} opportunities in ${scanTime}ms`);
                } else {
                    logger.debug(`Scan complete in ${scanTime}ms - no opportunities`);
                }

            } catch (error) {
                logger.error('Scan loop error', error as Error);
            }
        };

        // Run immediately, then on interval
        scanTokens();
        this.scanInterval = setInterval(scanTokens, this.config.priceRefreshMs);
    }

    /**
     * Handle detected opportunity
     */
    private async handleOpportunity(opp: ArbitrageOpportunity): Promise<void> {
        this.opportunitiesDetected++;

        // Notify via Telegram
        await this.telegram.notifyOpportunity(opp);

        // Check if we can trade
        if (!this.wallet.isAvailable()) {
            logger.info('Opportunity detected but wallet not available');
            return;
        }

        // Risk check
        const balance = await this.wallet.getBalance();
        const riskCheck = this.riskManager.checkTrade(opp, balance);

        if (!riskCheck.passed) {
            logger.info(`Risk check failed: ${riskCheck.reason}`);
            return;
        }

        // Log warnings
        for (const warning of riskCheck.warnings) {
            logger.warn(`⚠️ ${warning}`);
        }

        // Execute trade
        logger.info(`💹 Executing opportunity with spread ${opp.spreadBps.toFixed(2)} bps`);

        const result = await this.executor.execute(opp);
        this.tradesExecuted++;

        if (result.success) {
            this.tradesSuccessful++;
            this.totalProfitUsd += opp.estimatedProfitUsd;
            this.riskManager.recordTrade(opp.estimatedProfitUsd, true);
        } else {
            this.tradesFailed++;
            this.riskManager.recordTrade(0, false);
        }

        // Notify result
        await this.telegram.notifyTrade(result);
    }

    /**
     * Set up Telegram command handlers
     */
    private setupTelegramCommands(): void {
        // Pause command
        this.telegram.onCommand('/pause', () => {
            this.isPaused = true;
            this.telegram.send('⏸️ Bot paused. Use /resume to continue.');
            logger.info('Bot paused via Telegram');
        });

        // Resume command
        this.telegram.onCommand('/resume', () => {
            this.isPaused = false;
            this.telegram.send('▶️ Bot resumed!');
            logger.info('Bot resumed via Telegram');
        });

        // Opportunities command
        this.telegram.onCommand('/opportunities', () => {
            const opportunities = this.detector.getActiveOpportunities();
            if (opportunities.length === 0) {
                this.telegram.send('No active opportunities');
            } else {
                let msg = '🎯 *Active Opportunities*\n\n';
                for (const opp of opportunities.slice(0, 5)) {
                    msg += `• ${opp.buyDex} → ${opp.sellDex}: ${opp.spreadBps.toFixed(2)} bps\n`;
                }
                this.telegram.send(msg);
            }
        });
    }

    /**
     * Get bot status
     */
    getStatus(): BotStatus {
        const pubkey = this.wallet.getPublicKey();
        const aggregatorStats = this.aggregator.getStats();

        return {
            isRunning: this.isRunning && !this.isPaused,
            network: this.config.network,
            walletAddress: pubkey?.toBase58(),
            balanceSol: this.currentBalance,
            opportunitiesDetected: this.opportunitiesDetected,
            tradesExecuted: this.tradesExecuted,
            tradesSuccessful: this.tradesSuccessful,
            tradesFailed: this.tradesFailed,
            totalProfitUsd: this.totalProfitUsd,
            uptime: Date.now() - this.startTime,
            lastPriceUpdate: Date.now(),
            avgLatencyMs: aggregatorStats.avgFetchTime,
        };
    }

    /**
     * Graceful shutdown
     */
    async shutdown(): Promise<void> {
        logger.info('🛑 Shutting down...');

        this.isRunning = false;

        if (this.scanInterval) {
            clearInterval(this.scanInterval);
        }

        this.telegram.stop();

        // Send final stats
        const stats = this.detector.getStats();
        logger.info(`Final stats: ${JSON.stringify(stats)}`);

        logger.info('👋 Goodbye!');
        process.exit(0);
    }

    /**
     * Add token to monitor list
     */
    addToken(mint: string): void {
        if (!this.monitoredTokens.includes(mint)) {
            this.monitoredTokens.push(mint);
            logger.info(`Added token to monitor: ${mint}`);
        }
    }

    /**
     * Remove token from monitor list
     */
    removeToken(mint: string): void {
        const index = this.monitoredTokens.indexOf(mint);
        if (index > -1) {
            this.monitoredTokens.splice(index, 1);
            logger.info(`Removed token from monitor: ${mint}`);
        }
    }
}

// Main entry point
async function main() {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║          🚀 SOLANA DEX ARBITRAGE BOT v1.0.0 🚀                ║
║                                                               ║
║  Fast, efficient arbitrage across Jupiter, Raydium, Orca      ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `);

    const bot = new SolanaArbitrageBot();
    await bot.start();
}

// Run the bot
main().catch((error) => {
    logger.error('Fatal error', error);
    process.exit(1);
});
