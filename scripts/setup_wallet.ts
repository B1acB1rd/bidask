
import { Keypair, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

async function setup() {
    console.log('🔐 Generating new Devnet Wallet...');

    // Generate keypair
    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toBase58();
    const secretKey = bs58.encode(keypair.secretKey);

    console.log('\n---------------------------------------------------');
    console.log('📄 PUBLIC KEY (Address):', publicKey);
    console.log('🔑 PRIVATE KEY (Save this!):', secretKey);
    console.log('---------------------------------------------------\n');

    // Request Airdrop
    console.log('💧 Requesting 2 SOL Airdrop from Devnet...');
    try {
        const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
        const signature = await connection.requestAirdrop(keypair.publicKey, 2 * LAMPORTS_PER_SOL);
        console.log('⏳ Confirming transaction...');
        await connection.confirmTransaction(signature);
        console.log('✅ Airdrop Successful! Balance: 2 SOL');
    } catch (e) {
        console.error('❌ Airdrop failed (Devnet faucet might be busy).');
        console.error('   You can try again later: solana airdrop 2 ' + publicKey + ' --url devnet');
        console.error('   Or visit: https://faucet.solana.com/');
    }
}

setup().catch(console.error);
