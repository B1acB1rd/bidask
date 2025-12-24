import { Connection } from '@solana/web3.js';
import { v4 as uuidv4 } from 'uuid';
import { PriceQuote, ArbitrageOpportunity, DexType } from '../types';
import { PriceAggregator } from '../feeds/aggregator';
import { TokenGraph } from './graph';
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
    private graph: TokenGraph;

    // Track detected opportunities
    private opportunities: Map<string, ArbitrageOpportunity> = new Map();
    private opportunityHistory: ArbitrageOpportunity[] = [];

    // Callbacks
    private onOpportunityCallbacks: Array<(opp: ArbitrageOpportunity) => void> = [];

    constructor(connection: Connection, aggregator: PriceAggregator, config?: Partial<DetectorConfig>) {
        this.connection = connection;
        this.aggregator = aggregator;
        this.graph = new TokenGraph();
        this.config = {
            minProfitBps: config?.minProfitBps ?? this.globalConfig.minProfitBps,
            maxSlippageBps: config?.maxSlippageBps ?? this.globalConfig.maxSlippageBps,
            minLiquidityUsd: config?.minLiquidityUsd ?? this.globalConfig.minLiquidityUsd,
            opportunityTtlMs: config?.opportunityTtlMs ?? 5000,
        };
    }

    /**
     * Scan for triangular arbitrage opportunities
     */
    async scanGraph(tokens: string[], amount: number = 1): Promise<ArbitrageOpportunity[]> {
        const found: ArbitrageOpportunity[] = [];

        try {
            // 1. Fetch all pair quotes
            const quotes = await this.aggregator.getAllPairQuotes(tokens, amount);

            // 2. Update graph
            for (const quote of quotes) {
                this.graph.updateEdge(
                    quote.inputMint,
                    quote.outputMint,
                    quote.dex,
                    quote.price,
                    quote
                );
            }

            // 3. Find triangles starting from SOL
            const triangles = this.graph.findTriangles(TOKENS.SOL);

            // 4. Convert to opportunities
            const solPrice = await this.aggregator.getSolPrice() || 20;

            for (const tri of triangles) {
                if (tri.profitBps < this.config.minProfitBps) continue;

                const gasEstimateUsd = 0.003 * solPrice;
                const tradeSizeUsd = amount * solPrice;
                const grossProfitUsd = (tri.profitBps / 10000) * tradeSizeUsd;
                const netProfitUsd = grossProfitUsd - gasEstimateUsd;

                if (netProfitUsd <= 0) continue;

                const opportunity: ArbitrageOpportunity = {
                    id: uuidv4(),
                    tokenMint: TOKENS.SOL,
                    tokenSymbol: 'SOL-TRI',

                    isTriangular: true,
                    path: tri.path.map(e => ({
                        from: '',
                        to: e.to,
                        dex: e.dex as DexType,
                        quote: e.quote!
                    })),

                    buyDex: tri.path[0].dex as DexType,
                    buyPrice: tri.path[0].price,
                    buyQuote: tri.path[0].quote!,
                    sellDex: tri.path[2].dex as DexType,
                    sellPrice: tri.path[2].price,
                    sellQuote: tri.path[2].quote!,

                    spreadBps: tri.profitBps,
                    estimatedProfitBps: tri.profitBps,
                    estimatedProfitUsd: netProfitUsd,
                    tradeSize: amount,
                    tradeSizeUsd,

                    detectedAt: Date.now(),
                    expiresAt: Date.now() + this.config.opportunityTtlMs,
                };

                // Fix 'from' addresses
                if (opportunity.path && opportunity.path.length === 3) {
                    opportunity.path[0].from = TOKENS.SOL;
                    opportunity.path[1].from = opportunity.path[0].to;
                    opportunity.path[2].from = opportunity.path[1].to;
                }

                found.push(opportunity);
                this.opportunities.set(opportunity.id, opportunity);
                this.opportunityHistory.push(opportunity);

                logOpportunity({
                    buyDex: opportunity.buyDex,
                    sellDex: opportunity.sellDex,
                    token: 'TRI-ARB',
                    spreadBps: opportunity.spreadBps,
                    estimatedProfit: netProfitUsd
                });

                this.notifyCallbacks(opportunity);
            }
        } catch (error) {
            logger.error('Graph scan failed', error as Error);
        }

        return found;
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

            const solPrice = await this.aggregator.getSolPrice();

            for (const opp of opportunities) {
                if (!this.passesFilters(opp.buyQuote, opp.sellQuote, opp.spreadBps)) continue;

                const gasEstimate = 0.001;
                const gasCostUsd = gasEstimate * solPrice;
                const tradeSizeUsd = amount * solPrice;
                const grossProfitUsd = (opp.spreadBps / 10000) * tradeSizeUsd;
                const netProfitUsd = grossProfitUsd - gasCostUsd;

                if (netProfitUsd <= 0) continue;

                const opportunity: ArbitrageOpportunity = {
                    id: uuidv4(),
                    tokenMint,
                    tokenSymbol: 'UNK',

                    buyDex: opp.buyDex,
                    buyPrice: 1 / opp.buyQuote.price,
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

                logOpportunity({
                    buyDex: opp.buyDex,
                    sellDex: opp.sellDex,
                    token: tokenMint,
                    spreadBps: opp.spreadBps,
                    estimatedProfit: netProfitUsd,
                });

                this.notifyCallbacks(opportunity);
            }
        } catch (error) {
            logger.error('Scan failed', error as Error);
        }

        return found;
    }

    private passesFilters(buyQuote: PriceQuote, sellQuote: PriceQuote, spreadBps: number): boolean {
        if (spreadBps < this.config.minProfitBps) return false;
        if (buyQuote.priceImpact > this.config.maxSlippageBps / 100 || sellQuote.priceImpact > this.config.maxSlippageBps / 100) return false;
        if ((buyQuote.liquidity > 0 && buyQuote.liquidity < this.config.minLiquidityUsd) ||
            (sellQuote.liquidity > 0 && sellQuote.liquidity < this.config.minLiquidityUsd)) return false;
        return true;
    }

    async scanTokens(tokenMints: string[], baseToken: string = TOKENS.SOL, amount: number = 1): Promise<ArbitrageOpportunity[]> {
        const allOpportunities: ArbitrageOpportunity[] = [];
        const batchSize = 3;
        for (let i = 0; i < tokenMints.length; i += batchSize) {
            const batch = tokenMints.slice(i, i + batchSize);
            const results = await Promise.all(batch.map(token => this.scanToken(token, baseToken, amount)));
            for (const opportunities of results) allOpportunities.push(...opportunities);
        }
        allOpportunities.sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd);
        return allOpportunities;
    }

    onOpportunity(callback: (opp: ArbitrageOpportunity) => void): void {
        this.onOpportunityCallbacks.push(callback);
    }

    private notifyCallbacks(opp: ArbitrageOpportunity) {
        for (const callback of this.onOpportunityCallbacks) {
            try { callback(opp); } catch (e) { logger.error('Callback error', e as Error); }
        }
    }

    getActiveOpportunities(): ArbitrageOpportunity[] {
        const now = Date.now();
        const active: ArbitrageOpportunity[] = [];
        for (const [id, opp] of this.opportunities) {
            if (opp.expiresAt > now) active.push(opp);
            else this.opportunities.delete(id);
        }
        return active;
    }

    getStats() {
        // Simplified stats for brevity as we are rewriting
        return {
            totalDetected: this.opportunityHistory.length,
            activeOpportunities: this.getActiveOpportunities().length,
        };
    }

    getOpportunity(id: string) { return this.opportunities.get(id); }
    getHistory(limit: number = 100) { return this.opportunityHistory.slice(-limit); }
    clearHistory() { this.opportunityHistory = []; this.opportunities.clear(); }
}

export default ArbitrageDetector;
