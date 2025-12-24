import axios from 'axios';
import { PriceQuote, DexType } from '../types';
import { logger } from '../utils/logger';
import { TOKENS } from '../config';

const JUPITER_API_BASE = 'https://public.jupiterapi.com';

interface JupiterQuoteResponse {
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    priceImpactPct: string;
    routePlan: Array<{
        swapInfo: {
            ammKey: string;
            label: string;
            inputMint: string;
            outputMint: string;
            inAmount: string;
            outAmount: string;
            feeAmount: string;
            feeMint: string;
        };
        percent: number;
    }>;
    otherAmountThreshold: string;
    swapMode: string;
    slippageBps: number;
}

export class JupiterFeed {
    private apiBase: string;
    private cache: Map<string, { quote: PriceQuote; timestamp: number }> = new Map();
    private cacheMaxAge = 1000; // 1 second cache

    constructor(apiBase: string = JUPITER_API_BASE) {
        this.apiBase = apiBase;
    }

    /**
     * Get price quote from Jupiter aggregator
     */
    async getQuote(
        inputMint: string,
        outputMint: string,
        amount: number,
        decimals: number = 9,
        slippageBps: number = 50
    ): Promise<PriceQuote | null> {
        try {
            // Check cache first
            const cacheKey = `${inputMint}-${outputMint}-${amount}`;
            const cached = this.cache.get(cacheKey);
            if (cached && Date.now() - cached.timestamp < this.cacheMaxAge) {
                return cached.quote;
            }

            // Convert amount to lamports/smallest unit
            const amountLamports = Math.floor(amount * Math.pow(10, decimals));

            const response = await axios.get<JupiterQuoteResponse>(`${this.apiBase}/quote`, {
                params: {
                    inputMint,
                    outputMint,
                    amount: amountLamports.toString(),
                    slippageBps,
                    onlyDirectRoutes: false,
                    asLegacyTransaction: false,
                },
                timeout: 5000,
            });

            const data = response.data;

            // Parse response
            const inAmount = parseInt(data.inAmount) / Math.pow(10, decimals);
            const outAmount = parseInt(data.outAmount) / Math.pow(10, decimals);
            const price = outAmount / inAmount;

            // Calculate total fees from route
            let totalFees = 0;
            const routeLabels: string[] = [];

            for (const step of data.routePlan) {
                const feeAmount = parseInt(step.swapInfo.feeAmount) / Math.pow(10, decimals);
                totalFees += feeAmount;
                routeLabels.push(step.swapInfo.label);
            }

            const quote: PriceQuote = {
                dex: 'jupiter' as DexType,
                inputMint,
                outputMint,
                inputAmount: inAmount,
                outputAmount: outAmount,
                price,
                priceImpact: parseFloat(data.priceImpactPct),
                fees: totalFees,
                liquidity: 0, // Jupiter doesn't provide this directly
                route: routeLabels,
                timestamp: Date.now(),
            };

            // Update cache
            this.cache.set(cacheKey, { quote, timestamp: Date.now() });

            return quote;
        } catch (error) {
            if (axios.isAxiosError(error)) {
                logger.error(`Jupiter API error: ${error.message}`);
            } else {
                logger.error('Jupiter quote failed', error as Error);
            }
            return null;
        }
    }

    /**
     * Get price for a token pair in both directions
     */
    async getBidirectionalQuotes(
        tokenA: string,
        tokenB: string,
        amount: number,
        decimals: number = 9
    ): Promise<{ buy: PriceQuote | null; sell: PriceQuote | null }> {
        const [buy, sell] = await Promise.all([
            this.getQuote(tokenA, tokenB, amount, decimals),
            this.getQuote(tokenB, tokenA, amount, decimals),
        ]);

        return { buy, sell };
    }

    /**
     * Get swap transaction for execution
     */
    async getSwapTransaction(
        quoteResponse: JupiterQuoteResponse,
        userPublicKey: string,
        priorityFee?: number
    ): Promise<string | null> {
        try {
            const response = await axios.post(`${this.apiBase}/swap`, {
                quoteResponse,
                userPublicKey,
                wrapAndUnwrapSol: true,
                dynamicComputeUnitLimit: true,
                prioritizationFeeLamports: priorityFee || 'auto',
            }, {
                timeout: 10000,
            });

            return response.data.swapTransaction;
        } catch (error) {
            logger.error('Jupiter swap transaction failed', error as Error);
            return null;
        }
    }

    /**
     * Get price in USD (via USDC)
     */
    async getPriceInUsd(tokenMint: string, amount: number = 1): Promise<number | null> {
        if (tokenMint === TOKENS.USDC) return amount;

        const quote = await this.getQuote(tokenMint, TOKENS.USDC, amount, 9, 50);
        return quote?.outputAmount || null;
    }

    /**
     * Get SOL price in USD
     */
    async getSolPrice(): Promise<number | null> {
        return this.getPriceInUsd(TOKENS.SOL, 1);
    }

    /**
     * Clear cache
     */
    clearCache(): void {
        this.cache.clear();
    }
}

export default JupiterFeed;
