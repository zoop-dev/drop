function toB64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

async function generateKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
async function exportKey(key) {
  return toB64(await crypto.subtle.exportKey('raw', key));
}
async function importKey(b64) {
  return crypto.subtle.importKey('raw', fromB64(b64), { name: 'AES-GCM' }, false, ['decrypt']);
}

const CHUNK_SIZE = 49152;
const SAVED_NICKNAME_KEY = 'drop-nickname';

function isCompressible(mimeType, size) {
  if (size > 50 * 1024 * 1024) return false;
  const t = mimeType || '';
  if (t.startsWith('image/') || t.startsWith('video/') || t.startsWith('audio/')) return false;
  if (/zip|rar|7z|gz|bz2|xz|zst|br|lzma/.test(t)) return false;
  if (t === 'application/pdf') return false;
  return true;
}
async function compressBuffer(buffer) {
  const cs = new CompressionStream('gzip');
  const w = cs.writable.getWriter();
  const result = new Response(cs.readable).arrayBuffer();
  await w.write(new Uint8Array(buffer));
  await w.close();
  return result;
}
async function decompressBuffer(buffer) {
  const ds = new DecompressionStream('gzip');
  const w = ds.writable.getWriter();
  await w.write(new Uint8Array(buffer));
  await w.close();
  return new Response(ds.readable).arrayBuffer();
}

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, '');
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}
function bytesToUuid(b) {
  const h = Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
async function encryptChunkRaw(key, buffer) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);
  return { iv, data };
}
