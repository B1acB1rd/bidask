import { Connection } from '@solana/web3.js';
import { PriceQuote, DexType } from '../types';
import { JupiterFeed } from './jupiter';
import { RaydiumFeed } from './raydium';
import { OrcaFeed } from './orca';
import { logger } from '../utils/logger';
import { getConfig, TOKENS } from '../config';

export interface AggregatedQuotes {
    token: string;
    quotes: PriceQuote[];
    bestBuy: PriceQuote | null;   // Lowest price to buy
    bestSell: PriceQuote | null;  // Highest price to sell
    spreadBps: number;            // Spread in basis points
    timestamp: number;
}

export class PriceAggregator {
    private connection: Connection;
    private jupiter: JupiterFeed;
    private raydium: RaydiumFeed;
    private orca: OrcaFeed;
    private config = getConfig();

    // Performance tracking
    private lastFetchTime = 0;
    private avgFetchTime = 0;
    private fetchCount = 0;

    constructor(connection: Connection) {
        this.connection = connection;
        this.jupiter = new JupiterFeed();
        this.raydium = new RaydiumFeed(connection);
        this.orca = new OrcaFeed(connection);
    }

    /**
     * Fetch quotes from all DEXs in parallel for a token pair
     */
    async getQuotesForPair(
        inputMint: string,
        outputMint: string,
        amount: number,
        inputDecimals: number = 9
    ): Promise<PriceQuote[]> {
        const startTime = Date.now();
        const quotes: PriceQuote[] = [];

        try {
            // Fetch from all DEXs in parallel
            const [jupiterQuote, raydiumQuote, orcaQuote] = await Promise.all([
                this.jupiter.getQuote(inputMint, outputMint, amount, inputDecimals).catch(() => null),
                this.raydium.getQuote(inputMint, outputMint, amount, inputDecimals).catch(() => null),
                this.orca.getQuote(inputMint, outputMint, amount, inputDecimals).catch(() => null),
            ]);

            if (jupiterQuote) quotes.push(jupiterQuote);
            if (raydiumQuote) quotes.push(raydiumQuote);
            if (orcaQuote) quotes.push(orcaQuote);

            // Update performance stats
            const fetchTime = Date.now() - startTime;
            this.fetchCount++;
            this.avgFetchTime = (this.avgFetchTime * (this.fetchCount - 1) + fetchTime) / this.fetchCount;
            this.lastFetchTime = fetchTime;

            logger.debug(`Fetched ${quotes.length} quotes in ${fetchTime}ms`);
        } catch (error) {
            logger.error('Failed to fetch quotes', error as Error);
        }

        return quotes;
    }

    /**
     * Get aggregated quotes with best buy/sell prices
     */
    async getAggregatedQuotes(
        tokenMint: string,
        amount: number = 1,
        decimals: number = 9
    ): Promise<AggregatedQuotes> {
        // Get quotes for buying token with USDC
        const buyQuotes = await this.getQuotesForPair(
            TOKENS.USDC,
            tokenMint,
            amount * 100, // Assume ~$100 worth for quoting
            6 // USDC decimals
        );

        // Get quotes for selling token to USDC
        const sellQuotes = await this.getQuotesForPair(
            tokenMint,
            TOKENS.USDC,
            amount,
            decimals
        );

        // Find best buy (lowest price)
        let bestBuy: PriceQuote | null = null;
        for (const quote of buyQuotes) {
            if (!bestBuy || quote.price < bestBuy.price) {
                bestBuy = quote;
            }
        }

        // Find best sell (highest price)
        let bestSell: PriceQuote | null = null;
        for (const quote of sellQuotes) {
            if (!bestSell || quote.price > bestSell.price) {
                bestSell = quote;
            }
        }

        // Calculate spread
        let spreadBps = 0;
        if (bestBuy && bestSell && bestBuy.price > 0) {
            spreadBps = ((bestSell.price - bestBuy.price) / bestBuy.price) * 10000;
        }

        return {
            token: tokenMint,
            quotes: [...buyQuotes, ...sellQuotes],
            bestBuy,
            bestSell,
            spreadBps,
            timestamp: Date.now(),
        };
    }

    /**
     * Get cross-DEX arbitrage quotes (buy on one, sell on another)
     */
    async getCrossExchangeQuotes(
        tokenMint: string,
        baseToken: string = TOKENS.SOL,
        amount: number = 1,
        tokenDecimals: number = 9,
        baseDecimals: number = 9
    ): Promise<{
        buyQuotes: PriceQuote[];
        sellQuotes: PriceQuote[];
        opportunities: Array<{
            buyDex: DexType;
            sellDex: DexType;
            buyQuote: PriceQuote;
            sellQuote: PriceQuote;
            spreadBps: number;
            estimatedProfit: number;
        }>;
    }> {
        // Get buy quotes (base -> token)
        const buyQuotes = await this.getQuotesForPair(baseToken, tokenMint, amount, baseDecimals);

        // For each buy quote, get the corresponding amount we'd receive
        // Then get sell quotes for that amount
        const opportunities: Array<{
            buyDex: DexType;
            sellDex: DexType;
            buyQuote: PriceQuote;
            sellQuote: PriceQuote;
            spreadBps: number;
            estimatedProfit: number;
        }> = [];

        // Get sell quotes (token -> base) using various amounts
        const sellQuotes = await this.getQuotesForPair(tokenMint, baseToken, amount, tokenDecimals);

        // Find arbitrage opportunities
        for (const buyQuote of buyQuotes) {
            for (const sellQuote of sellQuotes) {
                if (buyQuote.dex === sellQuote.dex) continue; // Skip same-DEX

                // Calculate spread: (sellPrice - buyPrice) / buyPrice
                const spread = (sellQuote.price - (1 / buyQuote.price)) / (1 / buyQuote.price);
                const spreadBps = spread * 10000;

                // Estimate profit after fees
                const estimatedProfit = (sellQuote.outputAmount - buyQuote.inputAmount) -
                    (buyQuote.fees + sellQuote.fees);

                if (spreadBps > 0) {
                    opportunities.push({
                        buyDex: buyQuote.dex,
                        sellDex: sellQuote.dex,
                        buyQuote,
                        sellQuote,
                        spreadBps,
                        estimatedProfit,
                    });
                }
            }
        }

        // Sort by profit potential
        opportunities.sort((a, b) => b.spreadBps - a.spreadBps);

        return {
            buyQuotes,
            sellQuotes,
            opportunities,
        };
    }

    /**
     * Get SOL price in USD
     */
    async getSolPrice(): Promise<number> {
        const price = await this.jupiter.getSolPrice();
        return price || 0;
    }

    /**
     * Get performance stats
     */
    getStats() {
        return {
            lastFetchTime: this.lastFetchTime,
            avgFetchTime: Math.round(this.avgFetchTime),
            fetchCount: this.fetchCount,
        };
    }

    /**
     * Fetch quotes for all token permutations (for Triangular Arbitrage)
     * Warning: N^2 complexity. Keep token list small.
     * Rate Limited: Sequential execution to avoid 429s
     */
    async getAllPairQuotes(tokens: string[], amount: number = 1): Promise<PriceQuote[]> {
        const quotes: PriceQuote[] = [];

        // Randomize order to avoid hitting same pair bottlenecks
        const pairs: { from: string, to: string }[] = [];
        for (let i = 0; i < tokens.length; i++) {
            for (let j = 0; j < tokens.length; j++) {
                if (i === j) continue;
                pairs.push({ from: tokens[i], to: tokens[j] });
            }
        }

        // Execute sequentially with delay
        for (const pair of pairs) {
            try {
                // Add Small delay to be nice to public API
                await new Promise(resolve => setTimeout(resolve, 300));

                const pairQuotes = await this.getQuotesForPair(pair.from, pair.to, amount);
                if (pairQuotes) quotes.push(...pairQuotes);
            } catch (e) {
                // Ignore individual failures
            }
        }

        return quotes;
    }

    /**
     * Clear all caches
     */
    clearCaches(): void {
        this.jupiter.clearCache();
        this.raydium.clearCache();
        this.orca.clearCache();
    }
}

export default PriceAggregator;
