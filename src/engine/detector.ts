import { Connection } from '@solana/web3.js';
import { v4 as uuidv4 } from 'uuid';
import { PriceQuote, ArbitrageOpportunity, DexType } from '../types';
import { PriceAggregator } from '../feeds/aggregator';
import { getConfig, TOKENS } from '../config';
import { logger, logOpportunity } from '../utils/logger';

export interface DetectorConfig {
    minProfitBps: number;        // Minimum profit threshold
    maxSlippageBps: number;      // Maximum acceptable slippage
    minLiquidityUsd: number;     // Minimum pool liquidity
    opportunityTtlMs: number;    // How long opportunity is valid
}

export class ArbitrageDetector {
    private connection: Connection;
    private aggregator: PriceAggregator;
    private config: DetectorConfig;
    private globalConfig = getConfig();

    // Track detected opportunities
    private opportunities: Map<string, ArbitrageOpportunity> = new Map();
    private opportunityHistory: ArbitrageOpportunity[] = [];

    // Callbacks
    private onOpportunityCallbacks: Array<(opp: ArbitrageOpportunity) => void> = [];

    constructor(connection: Connection, aggregator: PriceAggregator, config?: Partial<DetectorConfig>) {
        this.connection = connection;
        this.aggregator = aggregator;
        this.config = {
            minProfitBps: config?.minProfitBps ?? this.globalConfig.minProfitBps,
            maxSlippageBps: config?.maxSlippageBps ?? this.globalConfig.maxSlippageBps,
            minLiquidityUsd: config?.minLiquidityUsd ?? this.globalConfig.minLiquidityUsd,
            opportunityTtlMs: config?.opportunityTtlMs ?? 5000, // 5 second default
        };
    }

    /**
     * Scan for arbitrage opportunities on a token pair
     */
    async scanToken(
        tokenMint: string,
        baseToken: string = TOKENS.SOL,
        amount: number = 1,
        tokenDecimals: number = 9,
        baseDecimals: number = 9
    ): Promise<ArbitrageOpportunity[]> {
        const found: ArbitrageOpportunity[] = [];

        try {
            const { buyQuotes, sellQuotes, opportunities } = await this.aggregator.getCrossExchangeQuotes(
                tokenMint,
                baseToken,
                amount,
                tokenDecimals,
                baseDecimals
            );

            // Get SOL price for USD calculations
            const solPrice = await this.aggregator.getSolPrice();

            for (const opp of opportunities) {
                // Apply filters
                if (!this.passesFilters(opp.buyQuote, opp.sellQuote, opp.spreadBps)) {
                    continue;
                }

                // Calculate estimated profit after gas
                const gasEstimate = 0.001; // ~0.001 SOL for swap tx
                const gasCostUsd = gasEstimate * solPrice;
                const tradeSizeUsd = amount * solPrice;
                const grossProfitUsd = (opp.spreadBps / 10000) * tradeSizeUsd;
                const netProfitUsd = grossProfitUsd - gasCostUsd;

                // Only consider if net profitable
                if (netProfitUsd <= 0) continue;

                const opportunity: ArbitrageOpportunity = {
                    id: uuidv4(),
                    tokenMint,

                    buyDex: opp.buyDex,
                    buyPrice: 1 / opp.buyQuote.price, // Price per token
                    buyQuote: opp.buyQuote,

                    sellDex: opp.sellDex,
                    sellPrice: opp.sellQuote.price,
                    sellQuote: opp.sellQuote,

                    spreadBps: opp.spreadBps,
                    estimatedProfitBps: opp.spreadBps - (gasCostUsd / tradeSizeUsd * 10000),
                    estimatedProfitUsd: netProfitUsd,
                    tradeSize: amount,
                    tradeSizeUsd,

                    detectedAt: Date.now(),
                    expiresAt: Date.now() + this.config.opportunityTtlMs,
                };

                found.push(opportunity);
                this.opportunities.set(opportunity.id, opportunity);
                this.opportunityHistory.push(opportunity);

                // Log and notify
                logOpportunity({
                    buyDex: opp.buyDex,
                    sellDex: opp.sellDex,
                    token: tokenMint,
                    spreadBps: opp.spreadBps,
                    estimatedProfit: netProfitUsd,
                });

                // Call registered callbacks
                for (const callback of this.onOpportunityCallbacks) {
                    try {
                        callback(opportunity);
                    } catch (e) {
                        logger.error('Opportunity callback failed', e as Error);
                    }
                }
            }
        } catch (error) {
            logger.error('Scan failed', error as Error);
        }

        return found;
    }

    /**
     * Check if an opportunity passes all risk filters
     */
    private passesFilters(
        buyQuote: PriceQuote,
        sellQuote: PriceQuote,
        spreadBps: number
    ): boolean {
        // Minimum profit threshold
        if (spreadBps < this.config.minProfitBps) {
            return false;
        }

        // Price impact check
        if (buyQuote.priceImpact > this.config.maxSlippageBps / 100 ||
            sellQuote.priceImpact > this.config.maxSlippageBps / 100) {
            return false;
        }

        // Liquidity check
        if (buyQuote.liquidity > 0 && buyQuote.liquidity < this.config.minLiquidityUsd) {
            return false;
        }
        if (sellQuote.liquidity > 0 && sellQuote.liquidity < this.config.minLiquidityUsd) {
            return false;
        }

        return true;
    }

    /**
     * Scan multiple tokens
     */
    async scanTokens(
        tokenMints: string[],
        baseToken: string = TOKENS.SOL,
        amount: number = 1
    ): Promise<ArbitrageOpportunity[]> {
        const allOpportunities: ArbitrageOpportunity[] = [];

        // Scan tokens in parallel (but limit concurrency)
        const batchSize = 3;
        for (let i = 0; i < tokenMints.length; i += batchSize) {
            const batch = tokenMints.slice(i, i + batchSize);
            const results = await Promise.all(
                batch.map(token => this.scanToken(token, baseToken, amount))
            );

            for (const opportunities of results) {
                allOpportunities.push(...opportunities);
            }
        }

        // Sort by profit potential
        allOpportunities.sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd);

        return allOpportunities;
    }

    /**
     * Register callback for new opportunities
     */
    onOpportunity(callback: (opp: ArbitrageOpportunity) => void): void {
        this.onOpportunityCallbacks.push(callback);
    }

    /**
     * Get current active opportunities
     */
    getActiveOpportunities(): ArbitrageOpportunity[] {
        const now = Date.now();
        const active: ArbitrageOpportunity[] = [];

        for (const [id, opp] of this.opportunities) {
            if (opp.expiresAt > now) {
                active.push(opp);
            } else {
                this.opportunities.delete(id);
            }
        }

        return active;
    }

    /**
     * Get opportunity by ID
     */
    getOpportunity(id: string): ArbitrageOpportunity | undefined {
        return this.opportunities.get(id);
    }

    /**
     * Get opportunity history
     */
    getHistory(limit: number = 100): ArbitrageOpportunity[] {
        return this.opportunityHistory.slice(-limit);
    }

    /**
     * Get statistics
     */
    getStats() {
        const now = Date.now();
        const last5Min = this.opportunityHistory.filter(o => now - o.detectedAt < 5 * 60 * 1000);
        const lastHour = this.opportunityHistory.filter(o => now - o.detectedAt < 60 * 60 * 1000);

        return {
            totalDetected: this.opportunityHistory.length,
            activeOpportunities: this.getActiveOpportunities().length,
            last5Minutes: last5Min.length,
            lastHour: lastHour.length,
            avgSpreadBps: last5Min.length > 0
                ? last5Min.reduce((sum, o) => sum + o.spreadBps, 0) / last5Min.length
                : 0,
            avgProfitUsd: last5Min.length > 0
                ? last5Min.reduce((sum, o) => sum + o.estimatedProfitUsd, 0) / last5Min.length
                : 0,
        };
    }

    /**
     * Clear history
     */
    clearHistory(): void {
        this.opportunityHistory = [];
        this.opportunities.clear();
    }
}

export default ArbitrageDetector;
