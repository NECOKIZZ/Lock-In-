// Simulates EXACTLY what app.html will do in the browser: raw web3.js only,
// hand-encoded instructions (no Anchor, no @solana/spl-token helpers).
// A throwaway keypair stands in for the Phantom wallet.
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from "@solana/web3.js";
import * as fs from "fs";

const cfgSrc = fs.readFileSync(process.env.HOME + "/Player and match score perps/app/ui/config.js", "utf8");
const win: any = {}; new Function("window", cfgSrc)(win);
const C = win.PP_CONFIG;

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSVAR_RENT = new PublicKey("SysvarRent111111111111111111111111111111111");

const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

function ataFor(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}
// ATA create-idempotent (ix discriminator 1)
function ixCreateAtaIdempotent(payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}
// SPL-Token MintTo (ix 7)
function ixMintTo(mint: PublicKey, dest: PublicKey, authority: PublicKey, amount: bigint) {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([7]), u64le(amount)]),
  });
}
// player_perps stake(guess_home u8, guess_away u8, amount u64)
function ixStake(programId: PublicKey, staker: PublicKey, fixture: PublicKey, position: PublicKey,
                 stakerUsdc: PublicKey, escrow: PublicKey, gh: number, ga: number, amount: bigint) {
  const disc = Buffer.from([206, 176, 202, 18, 200, 209, 179, 108]);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: staker, isSigner: true, isWritable: true },
      { pubkey: fixture, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: stakerUsdc, isSigner: false, isWritable: true },
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc, Buffer.from([gh, ga]), u64le(amount)]),
  });
}

async function main() {
  const conn = new Connection(C.RPC, "confirmed");
  const keeper = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
    fs.readFileSync(process.env.HOME + "/Player and match score perps/app/keeper/.keys/keeper-devnet.json", "utf8"))));
  const faucet = Keypair.fromSecretKey(new Uint8Array(C.FAUCET_SECRET));
  const user = Keypair.generate(); // stands in for Phantom

  // fund the fake user with a little SOL for fees/rent (browser users bring their own)
  await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: user.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL })), [keeper]);

  const programId = new PublicKey(C.PROGRAM_ID);
  const mint = new PublicKey(C.USDC_MINT);
  const fixture = new PublicKey(C.FIXTURE_PDA);
  const escrow = new PublicKey(C.ESCROW);
  const idBuf = u64le(BigInt(C.FIXTURE_ID));
  const [position] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake"), idBuf, user.publicKey.toBuffer()], programId);
  const userAta = ataFor(user.publicKey, mint);

  const gh = 2, ga = 1, amount = 50_000_000n; // $50, guess 2-1
  const tx = new Transaction().add(
    ixCreateAtaIdempotent(user.publicKey, userAta, user.publicKey, mint),
    ixMintTo(mint, userAta, faucet.publicKey, amount),
    ixStake(programId, user.publicKey, fixture, position, userAta, escrow, gh, ga, amount),
  );
  // browser flow: page partial-signs with faucet, wallet signs as fee payer
  tx.feePayer = user.publicKey;
  const sig = await sendAndConfirmTransaction(conn, tx, [user, faucet]);
  console.log("✓ stake tx:", sig);

  const pos = await conn.getAccountInfo(position);
  if (!pos) throw new Error("position account missing!");
  // decode: disc(8) fixture(32) staker(32) gh(1) ga(1) stake(8)...
  const d = pos.data;
  console.log("✓ position PDA:", position.toBase58());
  console.log("  guess:", d[72] + "-" + d[73], "| stake:", Number(d.readBigUInt64LE(74)) / 1e6, "USDC");
  const esc = await conn.getTokenAccountBalance(escrow);
  console.log("✓ escrow balance now:", esc.value.uiAmountString, "USDC");
}
main().catch((e) => { console.error("PROBE FAILED:", e?.message ?? e, e?.logs?.slice(-8)?.join("\n") ?? ""); process.exit(1); });
