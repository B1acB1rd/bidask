import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import { PriceQuote, DexType } from '../types';
import { logger } from '../utils/logger';

const ORCA_API_BASE = 'https://api.mainnet.orca.so';
const ORCA_WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

interface OrcaWhirlpoolData {
    address: string;
    tokenMintA: string;
    tokenMintB: string;
    tokenVaultA: string;
    tokenVaultB: string;
    tickSpacing: number;
    tickCurrentIndex: number;
    sqrtPrice: string;
    liquidity: string;
    feeRate: number;
    protocolFeeRate: number;
    price: number;
    priceRange: {
        minPrice: number;
        maxPrice: number;
    };
}

export class OrcaFeed {
    private connection: Connection;
    private whirlpoolCache: Map<string, OrcaWhirlpoolData> = new Map();
    private priceCache: Map<string, { price: number; timestamp: number }> = new Map();
    private cacheMaxAge = 2000;

    constructor(connection: Connection) {
        this.connection = connection;
    }

    /**
     * Get all whirlpools for a token
     */
    async getWhirlpoolsForToken(tokenMint: string): Promise<OrcaWhirlpoolData[]> {
        try {
            const response = await axios.get(`${ORCA_API_BASE}/v1/whirlpool/list`, {
                timeout: 5000,
            });

            const whirlpools: OrcaWhirlpoolData[] = response.data?.whirlpools || [];

            // Filter pools containing the token
            return whirlpools.filter(
                pool => pool.tokenMintA === tokenMint || pool.tokenMintB === tokenMint
            );
        } catch (error) {
            logger.error('Orca whirlpool fetch failed', error as Error);
            return [];
        }
    }

    /**
     * Get specific whirlpool data
     */
    async getWhirlpool(poolAddress: string): Promise<OrcaWhirlpoolData | null> {
        const cached = this.whirlpoolCache.get(poolAddress);
        if (cached) return cached;

        try {
            const response = await axios.get(`${ORCA_API_BASE}/v1/whirlpool/${poolAddress}`, {
                timeout: 5000,
            });

            const pool = response.data;
            if (pool) {
                this.whirlpoolCache.set(poolAddress, pool);
            }

            return pool || null;
        } catch (error) {
            logger.error(`Orca whirlpool ${poolAddress} fetch failed`, error as Error);
            return null;
        }
    }

    /**
     * Get quote for swapping on Orca
     */
    async getQuote(
        inputMint: string,
        outputMint: string,
        amount: number,
        inputDecimals: number = 9,
        slippageBps: number = 50
    ): Promise<PriceQuote | null> {
        try {
            const amountRaw = Math.floor(amount * Math.pow(10, inputDecimals));

            // Use Orca quote API
            const response = await axios.get(`${ORCA_API_BASE}/v1/quote`, {
                params: {
                    inputMint,
                    outputMint,
                    amount: amountRaw.toString(),
                    slippageBps,
                    swapMode: 'ExactIn',
                },
                timeout: 5000,
            });

            const data = response.data;
            if (!data) return null;

            const outputDecimals = data.outputMint === inputMint ? inputDecimals : 6;
            const inputAmountParsed = parseInt(data.inAmount || data.amount) / Math.pow(10, inputDecimals);
            const outputAmountParsed = parseInt(data.outAmount || data.estimatedAmountOut) / Math.pow(10, outputDecimals);

            const quote: PriceQuote = {
                dex: 'orca' as DexType,
                inputMint,
                outputMint,
                inputAmount: inputAmountParsed,
                outputAmount: outputAmountParsed,
                price: outputAmountParsed / inputAmountParsed,
                priceImpact: parseFloat(data.priceImpactPct || data.priceImpact || '0'),
                fees: parseFloat(data.fees || '0') / Math.pow(10, outputDecimals),
                liquidity: parseFloat(data.liquidity || '0'),
                route: data.route?.map((r: any) => r.address) || [],
                timestamp: Date.now(),
            };

            return quote;
        } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 404) {
                // No route available
                return null;
            }
            logger.error('Orca quote failed', error as Error);
            return null;
        }
    }

    /**
     * Calculate price from whirlpool sqrt price
     * sqrtPriceX64 = sqrt(price) * 2^64
     */
    calculatePriceFromSqrt(sqrtPriceX64: string, decimalsA: number, decimalsB: number): number {
        const sqrtPrice = BigInt(sqrtPriceX64);
        const Q64 = BigInt(2) ** BigInt(64);

        // price = (sqrtPrice / 2^64)^2 * 10^(decimalsA - decimalsB)
        const priceNum = Number(sqrtPrice * sqrtPrice) / Number(Q64 * Q64);
        const decimalAdjustment = Math.pow(10, decimalsA - decimalsB);

        return priceNum * decimalAdjustment;
    }

    /**
     * Get swap transaction from Orca
     */
    async getSwapTransaction(
        inputMint: string,
        outputMint: string,
        amount: number,
        slippageBps: number,
        userPublicKey: string,
        inputDecimals: number = 9
    ): Promise<{ transaction: string } | null> {
        try {
            const amountRaw = Math.floor(amount * Math.pow(10, inputDecimals));

            const response = await axios.post(`${ORCA_API_BASE}/v1/swap`, {
                inputMint,
                outputMint,
                amount: amountRaw.toString(),
                slippageBps,
                swapMode: 'ExactIn',
                wallet: userPublicKey,
            }, {
                timeout: 10000,
            });

            return response.data || null;
        } catch (error) {
            logger.error('Orca swap transaction failed', error as Error);
            return null;
        }
    }

    /**
     * Get token price in USD from Orca
     */
    async getTokenPrice(tokenMint: string): Promise<number | null> {
        const cached = this.priceCache.get(tokenMint);
        if (cached && Date.now() - cached.timestamp < this.cacheMaxAge) {
            return cached.price;
        }

        try {
            const response = await axios.get(`${ORCA_API_BASE}/v1/token/price`, {
                params: { mint: tokenMint },
                timeout: 5000,
            });

            const price = parseFloat(response.data?.price || '0');
            if (price > 0) {
                this.priceCache.set(tokenMint, { price, timestamp: Date.now() });
            }

            return price || null;
        } catch (error) {
            logger.error('Orca price fetch failed', error as Error);
            return null;
        }
    }

    /**
     * Clear caches
     */
    clearCache(): void {
        this.whirlpoolCache.clear();
        this.priceCache.clear();
    }
}

export default OrcaFeed;
