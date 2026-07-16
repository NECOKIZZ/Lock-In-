// TxLine (TxODDS) client for the Player Perps keeper.
//
// Responsibilities:
//   1. Authenticate to the World Cup free tier (guest JWT → on-chain subscribe →
//      activate → API token).
//   2. Fetch a cryptographic final-score proof for a fixture and shape it into the
//      exact `StatValidationInputV3` the `player_perps.validate_score` instruction
//      forwards to `txoracle.validate_stat_v3` via CPI.
//
// The keeper never *decides* the score — it fetches TxLine's proof and the
// on-chain program re-verifies it against TxLine's daily Merkle root before
// storing (home, away). So this client is trustless-by-audit: a wrong proof is
// rejected on-chain (`ScoreProofRejected`).
//
// Runtime deps (npm i): @coral-xyz/anchor @solana/web3.js @solana/spl-token axios tweetnacl bn.js
// Network: devnet by default; set TXLINE_MAINNET=1 for mainnet.
// Mirrors tx-on-chain/examples/devnet (common/users.ts + subscription_scores_v3c.ts).

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import axios from "axios";
import type { AxiosInstance } from "axios";
import nacl from "tweetnacl";
import BN from "bn.js";
import fs from "node:fs";
import txoracleDevnetIdl from "./txoracle.devnet.json" with { type: "json" };
import txoracleMainnetIdl from "./txoracle.mainnet.json" with { type: "json" };

const MAINNET = process.env.TXLINE_MAINNET === "1";

/** Per-network endpoints + program addresses (from tx-on-chain programs/addresses). */
export const NET = MAINNET
  ? {
      apiBase: "https://txline.txodds.com/api",
      jwtUrl: "https://txline.txodds.com/auth/guest/start",
      programId: "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA",
      txlMint: "Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL",
      rpc: process.env.SOLANA_RPC ?? "https://api.mainnet-beta.solana.com",
      idl: txoracleMainnetIdl,
    }
  : {
      apiBase: "https://txline-dev.txodds.com/api",
      jwtUrl: "https://txline-dev.txodds.com/auth/guest/start",
      programId: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
      txlMint: "4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG",
      rpc: process.env.SOLANA_RPC ?? "https://api.devnet.solana.com",
      idl: txoracleDevnetIdl,
    };

const DAY_MS = 86_400_000;
// Soccer full-match total goals (prefix 0). At a game_finalised record these are
// the 120' score; penalty-shootout goals live in the 6000-series, so a shootout
// never moves them. Order matters — the on-chain strategy assumes [home, away].
const STAT_KEYS_FT_SCORE = "1,2";

// ---- Shapes matching the Anchor StatValidationInputV3 (camelCase JS client) ----
export interface ProofNode {
  hash: number[];
  isRightSibling: boolean;
}
export interface ScoreStat {
  key: number;
  value: number;
  period: number;
}
export interface StatValidationInputV3 {
  ts: BN;
  fixtureSummary: {
    fixtureId: BN;
    updateStats: { updateCount: number; minTimestamp: BN; maxTimestamp: BN };
    eventsSubTreeRoot: number[];
  };
  fixtureProof: ProofNode[];
  mainTreeProof: ProofNode[];
  eventStatRoot: number[];
  leaves: { stat: ScoreStat; statProof: ProofNode[] }[];
  leafIndices: number[];
  multiproofHashes: ProofNode[];
}

/** Everything player_perps.validate_score needs, plus the resolved accounts. */
export interface ValidatedScore {
  payload: StatValidationInputV3;
  home: number;
  away: number;
  seq: number;
  dailyScoresPda: PublicKey;
  txoracleProgramId: PublicKey;
}

export interface TxlineSession {
  jwt: string;
  apiToken: string;
  wallet: Keypair;
  connection: Connection;
  program: anchor.Program;
  api: AxiosInstance;
}

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// Proof hashes arrive as hex (64 chars) or base64; coerce to a 32-byte number[].
const parseHash = (h: any): number[] => {
  const raw = h?.hash ?? h;
  if (typeof raw === "string") {
    const buf = raw.length === 64 ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    return Array.from(buf);
  }
  return Array.from(raw as ArrayLike<number>);
};
const mapProof = (proof: any[]): ProofNode[] =>
  (proof ?? []).map((p) => ({ hash: parseHash(p), isRightSibling: p.isRightSibling ?? false }));

/**
 * Authenticate + subscribe to the free tier and return a ready session.
 * `serviceLevelId` 1 = 60s-delayed World Cup free tier; `leagues` [] = standard bundle.
 */
export async function connect(walletPath: string): Promise<TxlineSession> {
  const connection = new Connection(NET.rpc, "confirmed");
  const wallet = loadKeypair(walletPath);
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), {
    commitment: "confirmed",
  });
  // Force the IDL address to the target network's program id.
  const idl = { ...(NET.idl as anchor.Idl), address: NET.programId };
  const program = new anchor.Program(idl, provider);

  const jwt = (await axios.post(NET.jwtUrl)).data.token as string;
  const apiToken = await subscribeAndActivate({ connection, wallet, program, jwt });

  const api = axios.create({
    baseURL: NET.apiBase,
    headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken },
  });

  return { jwt, apiToken, wallet, connection, program, api };
}

/** On-chain subscribe(1, 4) then sign `${txSig}::${jwt}` and activate → API token. */
async function subscribeAndActivate(args: {
  connection: Connection;
  wallet: Keypair;
  program: anchor.Program;
  jwt: string;
  serviceLevelId?: number;
  weeks?: number;
  leagues?: number[];
}): Promise<string> {
  const { connection, wallet, program, jwt } = args;
  const serviceLevelId = args.serviceLevelId ?? 1;
  const weeks = args.weeks ?? 4;
  const leagues = args.leagues ?? [];
  const tokenMint = new PublicKey(NET.txlMint);

  const userAta = getAssociatedTokenAddressSync(tokenMint, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const info = await connection.getAccountInfo(userAta);
  if (!info) {
    const { Transaction, sendAndConfirmTransaction } = await import("@solana/web3.js");
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        userAta,
        wallet.publicKey,
        tokenMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: "confirmed" });
  }

  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")],
    program.programId,
  );
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_treasury_v2")],
    program.programId,
  );
  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    tokenMint,
    tokenTreasuryPda,
    true,
    TOKEN_2022_PROGRAM_ID,
  );

  const txSig = await program.methods
    .subscribe(serviceLevelId, weeks)
    .accounts({
      user: wallet.publicKey,
      pricingMatrix: pricingMatrixPda,
      tokenMint,
      userTokenAccount: userAta,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });

  // Activation message signed by the SAME wallet that subscribed.
  const message = new TextEncoder().encode(`${txSig}:${leagues.join(",")}:${jwt}`);
  const walletSignature = Buffer.from(nacl.sign.detached(message, wallet.secretKey)).toString("base64");

  const res = await axios.post(
    `${NET.apiBase}/token/activate`,
    { txSig, walletSignature, leagues },
    { headers: { Authorization: `Bearer ${jwt}` } },
  );
  return (res.data.token ?? res.data) as string;
}

/** Case-insensitive field read (the feed mixes `Seq`/`seq`, `FixtureId`/`fixtureId`). */
const pick = (o: any, ...names: string[]) => {
  for (const n of names) if (o?.[n] !== undefined) return o[n];
  return undefined;
};

/**
 * Find the `game_finalised` record's sequence for a fixture. Finalisation records
 * carry action=game_finalised with statusId/period=100 (all finish types).
 * STEP-0: confirm the exact field names/values against a real devnet payload.
 */
export async function findFinalisedSeq(api: AxiosInstance, fixtureId: number): Promise<number> {
  const { data } = await api.get(`/scores/historical/${fixtureId}`);
  const records: any[] = Array.isArray(data) ? data : (data?.records ?? data?.updates ?? []);
  const finals = records.filter((r) => {
    const action = pick(r, "action", "Action");
    const status = pick(r, "statusId", "StatusId");
    const period = pick(r, "period", "Period");
    return action === "game_finalised" || status === 100 || period === 100;
  });
  if (finals.length === 0) {
    throw new Error(`No game_finalised record for fixture ${fixtureId} yet (match not final?)`);
  }
  const seqs = finals.map((r) => Number(pick(r, "Seq", "seq"))).filter((s) => Number.isInteger(s) && s > 0);
  if (seqs.length === 0) throw new Error(`Finalised record for ${fixtureId} had no valid Seq`);
  return Math.max(...seqs);
}

/** Fetch + shape the V3 proof for the final score of `fixtureId`. */
export async function fetchValidatedFinalScore(
  session: TxlineSession,
  fixtureId: number,
  seqOverride?: number,
): Promise<ValidatedScore> {
  const seq = seqOverride ?? (await findFinalisedSeq(session.api, fixtureId));

  const { data: val } = await session.api.get(
    `/scores/stat-validation-v3?fixtureId=${fixtureId}&seq=${seq}&statKeys=${STAT_KEYS_FT_SCORE}`,
  );

  const targetTs = Number(val.summary.updateStats.minTimestamp);
  const payload: StatValidationInputV3 = {
    ts: new BN(targetTs),
    fixtureSummary: {
      fixtureId: new BN(val.summary.fixtureId),
      updateStats: {
        updateCount: val.summary.updateStats.updateCount,
        minTimestamp: new BN(val.summary.updateStats.minTimestamp),
        maxTimestamp: new BN(val.summary.updateStats.maxTimestamp),
      },
      eventsSubTreeRoot: parseHash(val.summary.eventStatsSubTreeRoot),
    },
    fixtureProof: mapProof(val.subTreeProof),
    mainTreeProof: mapProof(val.mainTreeProof),
    eventStatRoot: parseHash(val.eventStatRoot),
    leaves: val.statsToProve.map((l: any) => ({ stat: l.stat, statProof: mapProof(l.statProof) })),
    leafIndices: val.multiproof.indices,
    multiproofHashes: mapProof(val.multiproof.hashes),
  };

  // statKeys were requested as "1,2" → index 0 = P1 goals (home), 1 = P2 goals (away).
  const home = Number(payload.leaves[0].stat.value);
  const away = Number(payload.leaves[1].stat.value);
  if (payload.leaves[0].stat.key !== 1 || payload.leaves[1].stat.key !== 2) {
    throw new Error(
      `Unexpected stat key order: got ${payload.leaves.map((l) => l.stat.key)}, expected [1,2]`,
    );
  }

  const txoracleProgramId = session.program.programId;
  const epochDay = Math.floor(targetTs / DAY_MS);
  const [dailyScoresPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)],
    txoracleProgramId,
  );

  return { payload, home, away, seq, dailyScoresPda, txoracleProgramId };
}
