// Cifrado AES-GCM de los tokens guardados en KV (defensa en profundidad:
// quien lea el namespace de KV no obtiene los tokens sin TOKEN_ENCRYPTION_KEY).

const PREFIX = 'v1:';
const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(b64: string): Promise<CryptoKey> {
  let p = keyCache.get(b64);
  if (!p) {
    const raw = b64ToBytes(b64.trim());
    if (raw.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY debe ser de 32 bytes en base64');
    p = crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    keyCache.set(b64, p);
  }
  return p;
}

export async function encryptString(plain: string, keyB64: string): Promise<string> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return PREFIX + bytesToB64(out);
}

export async function decryptString(stored: string, keyB64: string): Promise<string> {
  if (!stored.startsWith(PREFIX)) throw new Error('Formato de token cifrado desconocido');
  const key = await importKey(keyB64);
  const data = b64ToBytes(stored.slice(PREFIX.length));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, key, data.slice(12));
  return new TextDecoder().decode(pt);
}

export function randomToken(bytes = 32): string {
  return bytesToB64(crypto.getRandomValues(new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
