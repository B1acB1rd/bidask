import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import { PriceQuote, DexType, PoolInfo } from '../types';
import { logger } from '../utils/logger';
import { DEX_PROGRAMS } from '../config';

const RAYDIUM_API_BASE = 'https://api-v3.raydium.io';

interface RaydiumPoolInfo {
    id: string;
    baseMint: string;
    quoteMint: string;
    lpMint: string;
    baseDecimals: number;
    quoteDecimals: number;
    lpDecimals: number;
    version: number;
    programId: string;
    authority: string;
    openOrders: string;
    targetOrders: string;
    baseVault: string;
    quoteVault: string;
    withdrawQueue: string;
    lpVault: string;
    marketVersion: number;
    marketProgramId: string;
    marketId: string;
    marketAuthority: string;
    marketBaseVault: string;
    marketQuoteVault: string;
    marketBids: string;
    marketAsks: string;
    marketEventQueue: string;
    lookupTableAccount: string;
    liquidity?: number;
}

interface RaydiumPriceResponse {
    id: string;
    success: boolean;
    data: {
        [key: string]: string;
    };
}

export class RaydiumFeed {
    private connection: Connection;
    private poolCache: Map<string, RaydiumPoolInfo[]> = new Map();
    private priceCache: Map<string, { price: number; timestamp: number }> = new Map();
    private cacheMaxAge = 2000; // 2 second cache

    constructor(connection: Connection) {
        this.connection = connection;
    }

    /**
     * Fetch pools for a token pair
     */
    async getPoolsForPair(tokenA: string, tokenB: string): Promise<RaydiumPoolInfo[]> {
        const cacheKey = [tokenA, tokenB].sort().join('-');

        const cached = this.poolCache.get(cacheKey);
        if (cached) return cached;

        try {
            const response = await axios.get(`${RAYDIUM_API_BASE}/pools/info/mint`, {
                params: {
                    mint1: tokenA,
                    mint2: tokenB,
                    poolType: 'standard',
                    poolSortField: 'liquidity',
                    sortType: 'desc',
                    pageSize: 10,
                    page: 1,
                },
                timeout: 5000,
            });

            const pools = response.data?.data?.data || [];
            this.poolCache.set(cacheKey, pools);

            return pools;
        } catch (error) {
            logger.error('Raydium pool fetch failed', error as Error);
            return [];
        }
    }

    /**
     * Get token prices from Raydium
     */
    async getTokenPrices(mints: string[]): Promise<Map<string, number>> {
        const prices = new Map<string, number>();

        try {
            const response = await axios.get<RaydiumPriceResponse>(`${RAYDIUM_API_BASE}/mint/price`, {
                params: {
                    mints: mints.join(','),
                },
                timeout: 5000,
            });

            if (response.data.success && response.data.data) {
                for (const [mint, priceStr] of Object.entries(response.data.data)) {
                    const price = parseFloat(priceStr);
                    if (!isNaN(price)) {
                        prices.set(mint, price);
                        this.priceCache.set(mint, { price, timestamp: Date.now() });
                    }
                }
            }
        } catch (error) {
            logger.error('Raydium price fetch failed', error as Error);
        }

        return prices;
    }

    /**
     * Get quote for swapping on Raydium
     */
    async getQuote(
        inputMint: string,
        outputMint: string,
        amount: number,
        inputDecimals: number = 9,
        slippageBps: number = 50
    ): Promise<PriceQuote | null> {
        try {
            // Get pools for this pair
            const pools = await this.getPoolsForPair(inputMint, outputMint);
            if (pools.length === 0) {
                return null;
            }

            // Use Raydium swap compute API
            const amountRaw = Math.floor(amount * Math.pow(10, inputDecimals));

            const response = await axios.get(`${RAYDIUM_API_BASE}/compute/swap-base-in`, {
                params: {
                    inputMint,
                    outputMint,
                    amount: amountRaw.toString(),
                    slippageBps,
                    txVersion: 'V0',
                },
                timeout: 5000,
            });

            const data = response.data?.data;
            if (!data) return null;

            const outputDecimals = data.outputMint === inputMint ? inputDecimals : 6; // Assume 6 for stablecoins
            const inputAmountParsed = parseInt(data.inputAmount) / Math.pow(10, inputDecimals);
            const outputAmountParsed = parseInt(data.outputAmount) / Math.pow(10, outputDecimals);

            const quote: PriceQuote = {
                dex: 'raydium' as DexType,
                inputMint,
                outputMint,
                inputAmount: inputAmountParsed,
                outputAmount: outputAmountParsed,
                price: outputAmountParsed / inputAmountParsed,
                priceImpact: parseFloat(data.priceImpactPct || '0'),
                fees: 0, // Raydium fees are built into output
                liquidity: pools[0]?.liquidity || 0,
                route: data.routePlan?.map((r: any) => r.poolId) || [],
                timestamp: Date.now(),
            };

            return quote;
        } catch (error) {
            if (axios.isAxiosError(error)) {
                logger.debug(`Raydium quote unavailable for ${inputMint}-${outputMint}`);
            } else {
                logger.error('Raydium quote failed', error as Error);
            }
            return null;
        }
    }

    /**
     * Get pool on-chain data for accurate reserves
     */
    async getPoolReserves(poolAddress: string): Promise<{ baseReserve: number; quoteReserve: number } | null> {
        try {
            const poolPubkey = new PublicKey(poolAddress);
            const accountInfo = await this.connection.getAccountInfo(poolPubkey);

            if (!accountInfo) return null;

            // Decode Raydium AMM state (simplified - actual decoding requires full layout)
            // For production, use @raydium-io/raydium-sdk-v2

            return null; // Placeholder - need SDK for accurate decoding
        } catch (error) {
            logger.error('Failed to get pool reserves', error as Error);
            return null;
        }
    }

    /**
     * Get swap transaction from Raydium
     */
    async getSwapTransaction(
        inputMint: string,
        outputMint: string,
        amount: number,
        slippageBps: number,
        userPublicKey: string,
        inputDecimals: number = 9
    ): Promise<{ transaction: string; lastValidBlockHeight: number } | null> {
        try {
            const amountRaw = Math.floor(amount * Math.pow(10, inputDecimals));

            const response = await axios.get(`${RAYDIUM_API_BASE}/transaction/swap-base-in`, {
                params: {
                    inputMint,
                    outputMint,
                    amount: amountRaw.toString(),
                    slippageBps,
                    txVersion: 'V0',
                    wallet: userPublicKey,
                    wrapSol: true,
                    unwrapSol: true,
                    computeUnitPriceMicroLamports: 100000, // Priority fee
                },
                timeout: 10000,
            });

            const data = response.data?.data;
            if (!data) return null;

            return {
                transaction: data.transaction,
                lastValidBlockHeight: data.lastValidBlockHeight,
            };
        } catch (error) {
            logger.error('Raydium swap transaction failed', error as Error);
            return null;
        }
    }

    /**
     * Clear caches
     */
    clearCache(): void {
        this.poolCache.clear();
        this.priceCache.clear();
    }
}

export default RaydiumFeed;
