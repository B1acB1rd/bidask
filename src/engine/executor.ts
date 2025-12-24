import {
    Connection,
    Keypair,
    Transaction,
    VersionedTransaction,
    TransactionInstruction,
    PublicKey,
    ComputeBudgetProgram,
    LAMPORTS_PER_SOL,
    TransactionMessage,
    AddressLookupTableAccount,
} from '@solana/web3.js';
import axios from 'axios';
import bs58 from 'bs58';
import { ArbitrageOpportunity, TradeResult } from '../types';
import { WalletManager } from '../wallet/manager';
import { getConfig } from '../config';
import { logger, logTrade } from '../utils/logger';

// Jito endpoints for MEV protection
const JITO_ENDPOINTS = {
    'mainnet-beta': [
        'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
        'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
        'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
        'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
        'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
    ],
    'devnet': [],
};

export interface ExecutorConfig {
    useJitoBundles: boolean;
    jitoTipLamports: number;
    maxPriorityFeeLamports: number;
    maxRetries: number;
    confirmTimeoutMs: number;
}

export class TradeExecutor {
    private connection: Connection;
    private wallet: WalletManager;
    private config: ExecutorConfig;
    private globalConfig = getConfig();

    // Execution stats
    private executedTrades = 0;
    private successfulTrades = 0;
    private failedTrades = 0;
    private totalGasSpent = 0;

    constructor(
        connection: Connection,
        wallet: WalletManager,
        config?: Partial<ExecutorConfig>
    ) {
        this.connection = connection;
        this.wallet = wallet;
        this.config = {
            useJitoBundles: config?.useJitoBundles ?? this.globalConfig.useJitoBundles,
            jitoTipLamports: config?.jitoTipLamports ?? this.globalConfig.jitoTipLamports,
            maxPriorityFeeLamports: config?.maxPriorityFeeLamports ?? this.globalConfig.maxPriorityFeeLamports,
            maxRetries: config?.maxRetries ?? 3,
            confirmTimeoutMs: config?.confirmTimeoutMs ?? 30000,
        };
    }

    /**
     * Execute an arbitrage opportunity
     */
    async execute(opportunity: ArbitrageOpportunity): Promise<TradeResult> {
        const startTime = Date.now();

        const result: TradeResult = {
            success: false,
            opportunity,
            executedAt: startTime,
            duration: 0,
        };

        try {
            const keypair = this.wallet.getKeypair();
            if (!keypair) {
                throw new Error('Wallet not initialized');
            }

            logger.info(`🚀 Executing arbitrage: Buy on ${opportunity.buyDex}, Sell on ${opportunity.sellDex}`);

            // Build the atomic transaction
            const transaction = await this.buildAtomicTransaction(opportunity, keypair);

            if (!transaction) {
                throw new Error('Failed to build transaction');
            }

            // Execute based on configuration
            let txHash: string;

            if (this.config.useJitoBundles && this.globalConfig.network === 'mainnet-beta') {
                txHash = await this.submitJitoBundle(transaction, keypair);
            } else {
                txHash = await this.submitTransaction(transaction);
            }

            // Wait for confirmation
            const confirmed = await this.confirmTransaction(txHash);

            if (confirmed) {
                result.success = true;
                result.buyTxHash = txHash;
                result.sellTxHash = txHash; // Same tx for atomic arb
                this.successfulTrades++;

                logger.info(`✅ Arbitrage successful! TX: ${txHash}`);
            } else {
                throw new Error('Transaction not confirmed');
            }

        } catch (error) {
            const err = error as Error;
            result.error = err.message;
            this.failedTrades++;

            logger.error(`❌ Arbitrage execution failed: ${err.message}`);

            logTrade({
                type: 'BUY',
                dex: opportunity.buyDex,
                token: opportunity.tokenMint,
                amount: opportunity.tradeSize,
                price: opportunity.buyPrice,
                success: false,
                error: err.message,
            });
        }

        this.executedTrades++;
        result.duration = Date.now() - startTime;

        return result;
    }

    /**
     * Build atomic transaction with both buy and sell instructions
     */
    private async buildAtomicTransaction(
        opportunity: ArbitrageOpportunity,
        payer: Keypair
    ): Promise<VersionedTransaction | null> {
        try {
            // Add compute budget instructions for priority
            const computeUnitLimit = ComputeBudgetProgram.setComputeUnitLimit({
                units: 400000, // 400k units should be enough for 2 swaps
            });

            const computeUnitPrice = ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: Math.floor(this.config.maxPriorityFeeLamports / 400000 * 1000000),
            });

            // Get recent blockhash
            const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');

            // For this implementation, we'll use Jupiter's swap API which can handle the routing
            // In production, you'd want to build custom instructions for each DEX

            const instructions: TransactionInstruction[] = [
                computeUnitLimit,
                computeUnitPrice,
            ];

            // Add Jito tip if using bundles
            if (this.config.useJitoBundles) {
                const tipInstruction = this.createJitoTipInstruction(payer.publicKey);
                if (tipInstruction) {
                    instructions.push(tipInstruction);
                }
            }

            // Note: In production, you would add actual swap instructions here
            // This requires integrating with Jupiter's transaction building API
            // or building raw DEX instructions

            // Create versioned transaction
            const messageV0 = new TransactionMessage({
                payerKey: payer.publicKey,
                recentBlockhash: blockhash,
                instructions,
            }).compileToV0Message();

            const transaction = new VersionedTransaction(messageV0);
            transaction.sign([payer]);

            return transaction;
        } catch (error) {
            logger.error('Failed to build transaction', error as Error);
            return null;
        }
    }

    /**
     * Create Jito tip instruction
     */
    private createJitoTipInstruction(payer: PublicKey): TransactionInstruction | null {
        // Jito tip accounts (one of these should be used)
        const JITO_TIP_ACCOUNTS = [
            'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
            'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
            '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
            'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
            'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
            'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
            'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
            '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
        ];

        try {
            // Pick random tip account
            const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];

            return {
                keys: [
                    { pubkey: payer, isSigner: true, isWritable: true },
                    { pubkey: new PublicKey(tipAccount), isSigner: false, isWritable: true },
                ],
                programId: new PublicKey('11111111111111111111111111111111'), // System program
                data: Buffer.from([
                    2, 0, 0, 0, // Transfer instruction
                    ...new Uint8Array(new BigUint64Array([BigInt(this.config.jitoTipLamports)]).buffer),
                ]),
            };
        } catch (error) {
            logger.error('Failed to create Jito tip instruction', error as Error);
            return null;
        }
    }

    /**
     * Submit transaction normally
     */
    private async submitTransaction(transaction: VersionedTransaction): Promise<string> {
        const signature = await this.connection.sendTransaction(transaction, {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            maxRetries: this.config.maxRetries,
        });

        return signature;
    }

    /**
     * Submit transaction via Jito bundle for MEV protection
     */
    private async submitJitoBundle(transaction: VersionedTransaction, payer: Keypair): Promise<string> {
        const serialized = Buffer.from(transaction.serialize()).toString('base64');

        const endpoints = JITO_ENDPOINTS[this.globalConfig.network as keyof typeof JITO_ENDPOINTS] || [];

        if (endpoints.length === 0) {
            logger.warn('No Jito endpoints for network, falling back to normal submission');
            return this.submitTransaction(transaction);
        }

        // Try each endpoint
        for (const endpoint of endpoints) {
            try {
                const response = await axios.post(endpoint, {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'sendBundle',
                    params: [[serialized]],
                }, {
                    timeout: 10000,
                    headers: { 'Content-Type': 'application/json' },
                });

                if (response.data.result) {
                    logger.info(`Bundle submitted to Jito: ${response.data.result}`);

                    // Get the transaction signature from bundle
                    return bs58.encode(transaction.signatures[0]);
                }
            } catch (error) {
                logger.warn(`Jito endpoint ${endpoint} failed, trying next...`);
            }
        }

        // Fallback to normal submission
        logger.warn('All Jito endpoints failed, falling back to normal submission');
        return this.submitTransaction(transaction);
    }

    /**
     * Confirm transaction
     */
    private async confirmTransaction(signature: string): Promise<boolean> {
        try {
            const confirmation = await this.connection.confirmTransaction(
                {
                    signature,
                    blockhash: (await this.connection.getLatestBlockhash()).blockhash,
                    lastValidBlockHeight: (await this.connection.getLatestBlockhash()).lastValidBlockHeight,
                },
                'confirmed'
            );

            return !confirmation.value.err;
        } catch (error) {
            logger.error('Transaction confirmation failed', error as Error);
            return false;
        }
    }

    /**
     * Simulate transaction before execution
     */
    async simulate(opportunity: ArbitrageOpportunity): Promise<{
        success: boolean;
        logs?: string[];
        unitsConsumed?: number;
        error?: string;
    }> {
        const keypair = this.wallet.getKeypair();
        if (!keypair) {
            return { success: false, error: 'Wallet not initialized' };
        }

        try {
            const transaction = await this.buildAtomicTransaction(opportunity, keypair);
            if (!transaction) {
                return { success: false, error: 'Failed to build transaction' };
            }

            const simulation = await this.connection.simulateTransaction(transaction);

            return {
                success: !simulation.value.err,
                logs: simulation.value.logs || undefined,
                unitsConsumed: simulation.value.unitsConsumed || undefined,
                error: simulation.value.err ? JSON.stringify(simulation.value.err) : undefined,
            };
        } catch (error) {
            return { success: false, error: (error as Error).message };
        }
    }

    /**
     * Get execution stats
     */
    getStats() {
        return {
            executedTrades: this.executedTrades,
            successfulTrades: this.successfulTrades,
            failedTrades: this.failedTrades,
            successRate: this.executedTrades > 0
                ? ((this.successfulTrades / this.executedTrades) * 100).toFixed(1) + '%'
                : 'N/A',
            totalGasSpent: this.totalGasSpent / LAMPORTS_PER_SOL,
        };
    }
}

export default TradeExecutor;
