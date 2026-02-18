/**
 * Device identity management for OpenClaw gateway device pairing.
 *
 * Generates an Ed25519 keypair via Web Crypto API, persists it in IndexedDB,
 * and provides signing utilities for the gateway connect handshake.
 */

const DB_NAME = 'forge_device';
const DB_VERSION = 1;
const STORE_NAME = 'identity';
const IDENTITY_KEY = 'device';

// ── IndexedDB helpers ──────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ── Encoding helpers ───────────────────────────────────────────────

function bufToBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bufToHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Key generation & fingerprinting ────────────────────────────────

async function generateKeyPair() {
  return crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
}

/**
 * Extract the raw 32-byte public key from a CryptoKey.
 * SPKI for Ed25519 is a fixed 12-byte prefix + 32 bytes of key material.
 */
async function exportPublicKeyRaw(key) {
  const spki = await crypto.subtle.exportKey('spki', key);
  return spki.slice(12);
}

async function fingerprintKey(key) {
  const raw = await exportPublicKeyRaw(key);
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return bufToHex(hash);
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Load or create the device identity.
 * The keypair is persisted in IndexedDB so it survives page reloads.
 */
export async function getOrCreateDeviceIdentity() {
  const db = await openDB();

  const stored = await idbGet(db, IDENTITY_KEY);
  if (stored?.version === 1) {
    try {
      const privateKey = await crypto.subtle.importKey(
        'jwk', stored.jwkPrivate, { name: 'Ed25519' }, true, ['sign'],
      );
      const publicKey = await crypto.subtle.importKey(
        'jwk', stored.jwkPublic, { name: 'Ed25519' }, true, ['verify'],
      );
      db.close();
      return {
        id: stored.deviceId,
        publicKeyRaw: stored.publicKeyRaw,
        keyPair: { privateKey, publicKey },
      };
    } catch {
      // Corrupted — regenerate below
    }
  }

  const keyPair = await generateKeyPair();
  const raw = await exportPublicKeyRaw(keyPair.publicKey);
  const publicKeyRaw = bufToBase64Url(raw);
  const deviceId = await fingerprintKey(keyPair.publicKey);
  const jwkPublic = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const jwkPrivate = await crypto.subtle.exportKey('jwk', keyPair.privateKey);

  const record = {
    version: 1,
    deviceId,
    publicKeyRaw,
    jwkPublic,
    jwkPrivate,
  };
  await idbPut(db, IDENTITY_KEY, record);
  db.close();

  return { id: deviceId, publicKeyRaw, keyPair };
}

// ── Signing ────────────────────────────────────────────────────────

/**
 * Build the canonical payload string that the gateway expects to verify.
 * Must match OpenClaw's `buildDeviceAuthPayload` exactly.
 */
export function buildDeviceAuthPayload({ deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce }) {
  const version = nonce ? 'v2' : 'v1';
  const base = [
    version,
    deviceId,
    clientId,
    clientMode,
    role,
    scopes.join(','),
    String(signedAtMs),
    token ?? '',
  ];
  if (version === 'v2') base.push(nonce ?? '');
  return base.join('|');
}

/**
 * Sign a payload string with the device's Ed25519 private key.
 * Returns a base64url-encoded signature.
 */
export async function signPayload(privateKey, payload) {
  const data = new TextEncoder().encode(payload);
  const sig = await crypto.subtle.sign('Ed25519', privateKey, data);
  return bufToBase64Url(sig);
}
