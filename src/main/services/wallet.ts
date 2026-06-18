import { app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Bip39, EnglishMnemonic, Random, stringToPath } from '@cosmjs/crypto';
import { fromBech32 } from '@cosmjs/encoding';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import {
  BECH32_PREFIX,
  DENOM,
  dvpnToUdvpn,
  udvpnToDvpn,
} from './chain';
import { getSettings } from './settings';
import {
  readClients,
  signClient,
  withRpcTimeout,
  RPC_QUERY_TIMEOUT_MS,
  RPC_BROADCAST_TIMEOUT_MS,
} from './sentinel-client';
import { readStore, writeStore } from './store';
import { addEvent } from './events';
import { log } from './logger';
import type {
  SendTxRequest,
  SendTxResult,
  WalletState,
} from '../../shared/types';

/**
 * App-level wallet.
 *
 *   • Mnemonic — real BIP-39 (24 words from 32 bytes CSPRNG entropy) or
 *     imported from the user.
 *   • Derivation — m/44'/118'/0'/0/0 (app wallet only). Per-node operator
 *     keys live on their respective nodes, not here.
 *   • Address — bech32 with prefix `sent`.
 *   • At rest — Electron safeStorage (OS keychain). Missing encryption =>
 *     refuse to persist.
 *   • Sends — SigningSentinelClient with gas auto-estimate, gas fallback,
 *     chain-id check, classified error codes.
 */

const MNEMONIC_FILE = 'wallet.secret';
const APP_HD_PATH = "m/44'/118'/0'/0/0";
// Sentinel's chain consumes a bit more gas than stock Cosmos MsgSend
// (observed ~122K for a simple send, presumably due to additional ante
// handlers from vpn + wasm modules). 250K gives generous headroom.
const GAS_FALLBACK = 250_000;

function mnemonicPath(): string {
  return path.join(app.getPath('userData'), MNEMONIC_FILE);
}

async function requireEncryption(): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'This computer cannot safely save your wallet recovery phrase. ' +
        'On Linux, turn on a system keyring (such as gnome-keyring or kwallet) and try again. ' +
        'On Windows and macOS this normally works automatically — please make sure you are signed in to your user account.',
    );
  }
}

async function saveMnemonic(mnemonic: string): Promise<void> {
  await requireEncryption();
  const enc = safeStorage.encryptString(mnemonic);
  await fs.mkdir(path.dirname(mnemonicPath()), { recursive: true });
  await fs.writeFile(mnemonicPath(), enc);
}

async function loadMnemonic(): Promise<string> {
  await requireEncryption();
  const buf = await fs.readFile(mnemonicPath());
  return safeStorage.decryptString(buf);
}

async function hasMnemonicFile(): Promise<boolean> {
  // Existence alone is not enough: a present-but-undecryptable vault (keychain
  // rotated, profile copied to another machine, corrupt blob) would otherwise
  // make the UI report "wallet ready" and then fail at first sign/send. Verify
  // we can actually decrypt to a non-empty string.
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    const buf = await fs.readFile(mnemonicPath());
    if (!buf.length) return false;
    const mnemonic = safeStorage.decryptString(buf);
    return mnemonic.trim().length > 0;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code && code !== 'ENOENT') {
      log.warn('wallet vault present but unreadable/undecryptable', { code, err: String(err) });
    } else if (!code) {
      // decryptString throws plain Errors (no errno) when the blob is corrupt
      // or the key changed.
      log.warn('wallet vault could not be decrypted', { err: String(err) });
    }
    return false;
  }
}

async function appSigner(): Promise<DirectSecp256k1HdWallet> {
  const mnemonic = await loadMnemonic();
  return DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: BECH32_PREFIX,
    hdPaths: [stringToPath(APP_HD_PATH)],
  });
}

/**
 * Generate a brand-new 24-word mnemonic + derived sent1 address, for a
 * freshly-deployed node. This is produced in-app so we can pre-seed the
 * node's keyring (via sentinelhub inside the container) and know the
 * operator address up-front — without waiting for the first on-chain
 * status heartbeat.
 */
export async function generateNodeKey(): Promise<{ mnemonic: string; address: string }> {
  const entropy = Random.getBytes(32);
  const mnemonic = Bip39.encode(entropy).toString();
  const signer = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: BECH32_PREFIX,
    hdPaths: [stringToPath(APP_HD_PATH)],
  });
  const [{ address }] = await signer.getAccounts();
  return { mnemonic, address };
}

/** Build a signer from any mnemonic (used for node-level withdrawals). */
export async function signerFromMnemonic(mnemonic: string): Promise<DirectSecp256k1HdWallet> {
  return DirectSecp256k1HdWallet.fromMnemonic(mnemonic.trim(), {
    prefix: BECH32_PREFIX,
    hdPaths: [stringToPath(APP_HD_PATH)],
  });
}

function isValidBech32(addr: string): boolean {
  try {
    const { prefix } = fromBech32(addr);
    return prefix === BECH32_PREFIX;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getWallet(): Promise<WalletState> {
  const store = await readStore();
  const hasKey = await hasMnemonicFile();
  if (store.wallet && hasKey) {
    return { ...store.wallet, hasMnemonic: true };
  }
  return {
    address: null,
    balanceDVPN: 0,
    createdAt: null,
    hasMnemonic: false,
  };
}

export interface CreateWalletResult {
  wallet: WalletState;
  mnemonic: string;
}

export async function createWallet(): Promise<CreateWalletResult> {
  await requireEncryption();
  const entropy = Random.getBytes(32); // 256 bits → 24 words
  const mnemonic = Bip39.encode(entropy).toString();
  return persistMnemonic(mnemonic, 'wallet-created');
}

export async function restoreWallet(phrase: string): Promise<WalletState> {
  const trimmed = phrase.trim().toLowerCase().replace(/\s+/g, ' ');
  try {
    new EnglishMnemonic(trimmed);
  } catch {
    throw new Error('That recovery phrase doesn\'t look right. Please enter the 12, 15, 18, 21, or 24 English words from your wallet backup, separated by single spaces.');
  }
  const { wallet } = await persistMnemonic(trimmed, 'wallet-restored');
  return wallet;
}

async function persistMnemonic(
  mnemonic: string,
  kind: 'wallet-created' | 'wallet-restored',
): Promise<CreateWalletResult> {
  await saveMnemonic(mnemonic);
  const signer = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: BECH32_PREFIX,
    hdPaths: [stringToPath(APP_HD_PATH)],
  });
  const [{ address }] = await signer.getAccounts();

  const wallet: WalletState = {
    address,
    balanceDVPN: 0,
    createdAt: new Date().toISOString(),
    hasMnemonic: true,
  };
  const store = await readStore();
  store.wallet = wallet;
  await writeStore(store);

  await addEvent({
    kind,
    title: kind === 'wallet-created' ? 'Wallet created' : 'Wallet restored',
    subtitle: `${address.slice(0, 10)}…${address.slice(-6)}`,
  });

  refreshWalletBalance().catch((err) => log.debug('initial balance refresh skipped', { err: String(err) }));
  return { wallet, mnemonic };
}

/**
 * Wipe the app wallet: delete the encrypted mnemonic file and clear the
 * persisted wallet record. Per-node operator mnemonics (separate files
 * keyed by node id) are NOT touched — those still exist if you reimport
 * the same recovery phrase. Running nodes keep running. The renderer
 * should treat a successful return as "back to WalletSetup".
 */
export async function logoutWallet(): Promise<void> {
  try {
    await fs.unlink(mnemonicPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const store = await readStore();
  store.wallet = null;
  await writeStore(store);
  await addEvent({
    kind: 'wallet-logout',
    title: 'Wallet logged out',
    subtitle: 'Encrypted vault cleared',
  });
}

/** Query current DVPN balance for the app wallet. Silent on RPC failure. */
export async function refreshWalletBalance(): Promise<WalletState> {
  const store = await readStore();
  const address = store.wallet?.address;
  if (!address) return getWallet();
  try {
    const balance = await fetchBalance(address);
    // Re-read after the (awaited) RPC round-trip: a concurrent logout may have
    // cleared store.wallet while fetchBalance was in flight. Mutating/returning
    // the pre-fetch reference would resurrect a logged-out wallet or NPE.
    const fresh = await readStore();
    if (fresh.wallet?.address === address) {
      fresh.wallet.balanceDVPN = balance;
      await writeStore(fresh);
      return { ...fresh.wallet };
    }
  } catch (err) {
    log.warn('wallet balance refresh failed', { err: (err as Error).message });
  }
  return getWallet();
}

export async function fetchBalance(address: string): Promise<number> {
  const { stargate, disconnect } = await readClients();
  try {
    const coin = await withRpcTimeout(
      () => stargate.getBalance(address, DENOM),
      RPC_QUERY_TIMEOUT_MS,
      'getBalance',
    );
    return udvpnToDvpn(coin.amount);
  } finally {
    disconnect();
  }
}

/**
 * Sign + broadcast a MsgSend from the app wallet. Returns a
 * structured result so the UI can distinguish insufficient funds from
 * gas-estimation failures from RPC timeouts.
 */
export async function sendTokens(req: SendTxRequest): Promise<SendTxResult> {
  if (!isValidBech32(req.to.trim())) {
    return { ok: false, error: `Recipient "${req.to}" is not a valid sent1 address.`, errorCode: 'invalid-address' };
  }
  if (!(req.amountDVPN > 0)) {
    return { ok: false, error: 'Amount must be greater than 0.', errorCode: 'invalid-amount' };
  }

  // Retry on transient RPC failures: pool-wide outages, timeouts, and
  // sequence races. Wallet sends are safe to retry because the chain
  // rejects a duplicate (sequence, account) tuple — at most one of N
  // retries can land. Hard failures (insufficient funds, invalid
  // address, chain mismatch, non-zero broadcast code) break out
  // immediately so we don't waste DVPN on guaranteed-failing retries.
  const MAX_SEND_ATTEMPTS = 4;
  const SEND_RETRY_DELAY_MS = 4_000;
  const isTransient = (msg: string) =>
    /timed out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|getaddrinfo|EAI_AGAIN|Could not connect to the Sentinel network|none responded|sequence mismatch/i.test(
      msg,
    );

  let lastErr = '';
  let lastCode: SendTxResult['errorCode'] = 'timeout';
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    try {
      const settings = await getSettings();
      const signer = await appSigner();
      const [{ address: from }] = await signer.getAccounts();
      const { client, disconnect, url } = await signClient(signer);

      try {
        const actualChainId = await withRpcTimeout(
          () => client.getChainId(),
          RPC_QUERY_TIMEOUT_MS,
          'getChainId',
        );
        if (actualChainId !== settings.chainId) {
          return {
            ok: false,
            error: `RPC ${url} reports chain ${actualChainId} but app is configured for ${settings.chainId}. Aborting.`,
            errorCode: 'chain-mismatch',
          };
        }

        const coins = [{ denom: DENOM, amount: dvpnToUdvpn(req.amountDVPN) }];
        const memo = req.memo ?? '';
        const gas = GAS_FALLBACK;
        const feeUdvpn = String(Math.max(1, Math.ceil(gas * Number(settings.gasPriceUdvpn))));
        const fee = { amount: [{ denom: DENOM, amount: feeUdvpn }], gas: String(gas) };
        const result = await withRpcTimeout(
          () => client.sendTokens(from, req.to.trim(), coins, fee, memo),
          RPC_BROADCAST_TIMEOUT_MS,
          'sendTokens',
        );

        if (result.code !== 0) {
          const classified = classifyErr(result.rawLog ?? '');
          if (classified === 'sequence-mismatch' && attempt < MAX_SEND_ATTEMPTS) {
            lastErr = result.rawLog ?? `code ${result.code}`;
            lastCode = classified;
            log.warn('sendTokens sequence-mismatch, retrying', { attempt, err: lastErr.slice(0, 160) });
            await new Promise((resolve) => setTimeout(resolve, SEND_RETRY_DELAY_MS));
            continue;
          }
          await addEvent({
            kind: 'withdraw-failed',
            title: 'Send failed',
            subtitle: sanitizeErr(result.rawLog),
            amountDVPN: -req.amountDVPN,
          });
          return { ok: false, error: sanitizeErr(result.rawLog), errorCode: classified };
        }

        await addEvent({
          kind: 'withdraw-sent',
          title: 'Send confirmed',
          subtitle: `to ${req.to.slice(0, 10)}…${req.to.slice(-6)}`,
          amountDVPN: -req.amountDVPN,
          txHash: result.transactionHash,
        });
        refreshWalletBalance().catch((err) =>
          log.debug('post-send balance refresh skipped', { err: String(err) }),
        );

        return {
          ok: true,
          txHash: result.transactionHash,
          height: result.height,
          gasUsed: Number(result.gasUsed ?? 0),
        };
      } finally {
        disconnect();
      }
    } catch (err) {
      lastErr = (err as Error).message ?? 'Unknown broadcast error';
      lastCode = classifyErr(lastErr);
      if (!isTransient(lastErr) || attempt === MAX_SEND_ATTEMPTS) {
        break;
      }
      log.warn('sendTokens transient failure, retrying', { attempt, err: lastErr.slice(0, 160) });
      await new Promise((resolve) => setTimeout(resolve, SEND_RETRY_DELAY_MS));
    }
  }

  log.error('sendTokens failed', { err: lastErr });
  await addEvent({
    kind: 'withdraw-failed',
    title: 'Send failed',
    subtitle: sanitizeErr(lastErr),
    amountDVPN: -req.amountDVPN,
  });
  return { ok: false, error: sanitizeErr(lastErr), errorCode: lastCode };
}

export function classifyErr(rawLog: string): SendTxResult['errorCode'] {
  if (/insufficient funds|insufficient fee/i.test(rawLog)) return 'insufficient-funds';
  if (/account sequence mismatch|sequence mismatch/i.test(rawLog)) return 'sequence-mismatch';
  if (/invalid address|decoding bech32/i.test(rawLog)) return 'invalid-address';
  if (/timeout|context deadline exceeded|abort/i.test(rawLog)) return 'timeout';
  if (/connection refused|Network Error|ECONNREFUSED|ETIMEDOUT/i.test(rawLog)) return 'rpc-unavailable';
  if (/chain mismatch|chain-id/i.test(rawLog)) return 'chain-mismatch';
  if (/simulate|gas estimation/i.test(rawLog)) return 'gas-estimation-failed';
  return 'unknown';
}

function sanitizeErr(msg: string | undefined): string {
  if (!msg) return 'Unknown error';
  // Strip URLs (RPC leaks) and long hex blobs so event log stays clean.
  return msg
    .replace(/https?:\/\/\S+/g, '[rpc]')
    .replace(/0x[a-fA-F0-9]{8,}/g, '[hex]')
    .slice(0, 240);
}
