import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { getConfig } from '../config';
import { logger } from '../utils/logger';

export class WalletManager {
    private connection: Connection;
    private keypair: Keypair | null = null;
    private config = getConfig();

    constructor(connection: Connection) {
        this.connection = connection;
    }

    /**
     * Initialize wallet from private key in config
     */
    async initialize(): Promise<boolean> {
        try {
            if (!this.config.walletPrivateKey) {
                logger.warn('⚠️ No wallet private key configured. Running in read-only mode.');
                return false;
            }

            // Decode base58 private key
            const secretKey = bs58.decode(this.config.walletPrivateKey);
            this.keypair = Keypair.fromSecretKey(secretKey);

            logger.info(`🔐 Wallet initialized: ${this.keypair.publicKey.toBase58()}`);

            // Check balance
            const balance = await this.getBalance();
            logger.info(`💰 Wallet balance: ${balance.toFixed(4)} SOL`);

            if (balance < 0.01) {
                logger.warn('⚠️ Low wallet balance! Consider adding more SOL.');
            }

            return true;
        } catch (error) {
            logger.error('Failed to initialize wallet', error as Error);
            return false;
        }
    }

    /**
     * Get wallet public key
     */
    getPublicKey(): PublicKey | null {
        return this.keypair?.publicKey || null;
    }

    /**
     * Get keypair for signing (use carefully!)
     */
    getKeypair(): Keypair | null {
        return this.keypair;
    }

    /**
     * Check if wallet is available
     */
    isAvailable(): boolean {
        return this.keypair !== null;
    }

    /**
     * Get SOL balance
     */
    async getBalance(): Promise<number> {
        if (!this.keypair) return 0;

        try {
            const balance = await this.connection.getBalance(this.keypair.publicKey);
            return balance / LAMPORTS_PER_SOL;
        } catch (error) {
            logger.error('Failed to get balance', error as Error);
            return 0;
        }
    }

    /**
     * Get token balance for a specific mint
     */
    async getTokenBalance(mintAddress: string): Promise<number> {
        if (!this.keypair) return 0;

        try {
            const mint = new PublicKey(mintAddress);
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                this.keypair.publicKey,
                { mint }
            );

            if (tokenAccounts.value.length === 0) return 0;

            const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
            return parseFloat(balance.uiAmountString || '0');
        } catch (error) {
            logger.error(`Failed to get token balance for ${mintAddress}`, error as Error);
            return 0;
        }
    }

    /**
     * Get all token balances
     */
    async getAllTokenBalances(): Promise<Map<string, number>> {
        const balances = new Map<string, number>();

        if (!this.keypair) return balances;

        try {
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                this.keypair.publicKey,
                { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
            );

            for (const account of tokenAccounts.value) {
                const info = account.account.data.parsed.info;
                const mint = info.mint;
                const amount = parseFloat(info.tokenAmount.uiAmountString || '0');
                if (amount > 0) {
                    balances.set(mint, amount);
                }
            }
        } catch (error) {
            logger.error('Failed to get all token balances', error as Error);
        }

        return balances;
    }

    /**
     * Generate a new wallet (for testing)
     */
    static generateNewWallet(): { publicKey: string; privateKey: string } {
        const keypair = Keypair.generate();
        return {
            publicKey: keypair.publicKey.toBase58(),
            privateKey: bs58.encode(keypair.secretKey),
        };
    }

    /**
     * Request airdrop on devnet
     */
    async requestAirdrop(amountSol: number = 1): Promise<boolean> {
        if (!this.keypair) {
            logger.error('Cannot request airdrop: wallet not initialized');
            return false;
        }

        if (this.config.network !== 'devnet') {
            logger.error('Airdrops only available on devnet');
            return false;
        }

        try {
            logger.info(`Requesting ${amountSol} SOL airdrop...`);

            const signature = await this.connection.requestAirdrop(
                this.keypair.publicKey,
                amountSol * LAMPORTS_PER_SOL
            );

            await this.connection.confirmTransaction(signature, 'confirmed');

            const newBalance = await this.getBalance();
            logger.info(`✅ Airdrop received! New balance: ${newBalance.toFixed(4)} SOL`);

            return true;
        } catch (error) {
            logger.error('Airdrop failed', error as Error);
            return false;
        }
    }
}

export default WalletManager;
