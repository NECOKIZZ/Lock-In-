#!/usr/bin/env node
// Player Perps — environment & deployment health check.
// Run: node app/keeper/e2e/healthcheck.mjs   (no deps beyond the vendored web3 bundle)
// Verifies every moving part agrees: keys, SOL, program, fixture PDA, config.js, UI files.
import fs from "node:fs";
import path from "node:path";

const HOME = process.env.HOME;
const APP = path.join(HOME, "Player and match score perps", "app");
const UI = path.join(APP, "ui");
let pass = 0, fail = 0, warn = 0;
const ok = (c, msg, warnOnly = false) => {
  console.log((c ? "  ✓ " : warnOnly ? "  ⚠ " : "  ✗ ") + msg);
  c ? pass++ : warnOnly ? warn++ : fail++;
};

// --- load web3 from the vendored browser bundle (works offline) ---
(0, eval)(fs.readFileSync(path.join(UI, "web3.iife.min.js"), "utf8"));
const w3 = globalThis.solanaWeb3;

console.log("— files —");
const files = {
  "keeper key": path.join(APP, "keeper/.keys/keeper-devnet.json"),
  "program keypair": path.join(APP, "target/deploy/player_perps-keypair.json"),
  "program .so": path.join(APP, "target/deploy/player_perps.so"),
  "ui/index.html": path.join(UI, "index.html"),
  "ui/app.html": path.join(UI, "app.html"),
  "ui/style.css": path.join(UI, "style.css"),
  "ui/config.js": path.join(UI, "config.js"),
  "ui/web3 bundle": path.join(UI, "web3.iife.min.js"),
  "IDL": path.join(APP, "keeper/e2e/player_perps.idl.json"),
};
for (const [name, p] of Object.entries(files)) ok(fs.existsSync(p), `${name} — ${p.replace(HOME, "~")}`);

// --- config.js ---
console.log("— config.js —");
const w = {}; new Function("window", fs.readFileSync(path.join(UI, "config.js"), "utf8"))(w);
const C = w.PP_CONFIG ?? {};
ok(!!C.PROGRAM_ID && !!C.FIXTURE_PDA && !!C.USDC_MINT && !!C.ESCROW, "all addresses present");
ok(Array.isArray(C.FAUCET_SECRET) && C.FAUCET_SECRET.length === 64, "faucet secret well-formed (devnet-only pattern)");
const declared = fs.readFileSync(path.join(APP, "programs/player_perps/src/lib.rs"), "utf8").match(/declare_id!\("([^"]+)"\)/)?.[1];
ok(declared === C.PROGRAM_ID, `config PROGRAM_ID matches declare_id! (${declared?.slice(0, 8)}…)`);
const idl = JSON.parse(fs.readFileSync(files["IDL"], "utf8"));
ok(idl.address === C.PROGRAM_ID, "IDL address matches config");

// --- chain state ---
console.log("— devnet chain state —");
const conn = new w3.Connection(C.RPC ?? "https://api.devnet.solana.com", "confirmed");
try {
  const keeper = w3.Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(files["keeper key"], "utf8"))));
  const bal = await conn.getBalance(keeper.publicKey) / 1e9;
  ok(true, `keeper ${keeper.publicKey.toBase58().slice(0, 8)}… balance ${bal.toFixed(2)} SOL`);
  ok(bal >= 1, bal >= 1 ? "keeper SOL sufficient (≥1)" : `keeper SOL LOW (${bal.toFixed(2)}) — airdrop or fund`, bal >= 0.2);

  const prog = await conn.getAccountInfo(new w3.PublicKey(C.PROGRAM_ID));
  ok(!!prog?.executable, `program ${C.PROGRAM_ID.slice(0, 8)}… deployed & executable`);

  const fx = await conn.getAccountInfo(new w3.PublicKey(C.FIXTURE_PDA));
  if (fx) {
    const d = fx.data, dv = new DataView(d.buffer, d.byteOffset);
    const id = Number(dv.getBigUint64(8, true));
    const lockTime = Number(dv.getBigInt64(16, true));
    const status = ["Open","Locked","ScoreValidated","DistancesComputed","MedianVerified","Settled","Void"][d[24]];
    const pool = Number(dv.getBigUint64(75, true)) / 1e6;
    const stakers = dv.getUint16(83, true);
    ok(id === C.FIXTURE_ID, `fixture id on-chain (${id}) matches config (${C.FIXTURE_ID})`);
    const secsLeft = lockTime - Math.floor(Date.now() / 1000);
    ok(status === "Open" && secsLeft > 0,
      `fixture ${status}, lock ${secsLeft > 0 ? "in " + (secsLeft / 3600).toFixed(1) + "h" : "PASSED " + (-secsLeft / 3600).toFixed(1) + "h ago"} — pool $${pool} / ${stakers} stakers`,
      true);
    const esc = await conn.getTokenAccountBalance(new w3.PublicKey(C.ESCROW));
    ok(Number(esc.value.uiAmount) === pool, `escrow token balance ($${esc.value.uiAmountString}) equals fixture.total_pool ($${pool})`);
  } else ok(false, "fixture PDA missing on-chain — run setup-ui-fixture.ts");

  const faucet = w3.Keypair.fromSecretKey(new Uint8Array(C.FAUCET_SECRET));
  const mintAcc = await conn.getAccountInfo(new w3.PublicKey(C.USDC_MINT));
  // SPL mint layout: mintAuthorityOption u32 @0, mintAuthority pubkey @4
  const authOk = mintAcc && new DataView(mintAcc.data.buffer, mintAcc.data.byteOffset).getUint32(0, true) === 1
    && new w3.PublicKey(mintAcc.data.slice(4, 36)).equals(faucet.publicKey);
  ok(!!authOk, "demo mint authority == faucet key in config.js (browser staking will work)");
} catch (e) { ok(false, "RPC error: " + e.message.slice(0, 80)); }

// --- auth (TxLine) ---
console.log("— txline —");
const auth = "/tmp/txline-auth.json";
ok(fs.existsSync(auth), "auth cache present (/tmp/txline-auth.json) — regenerates via subscribe if missing", true);

console.log(`\n${fail === 0 ? "HEALTHY" : "UNHEALTHY"} — ${pass} pass, ${warn} warn, ${fail} fail`);
process.exit(fail ? 1 : 0);
