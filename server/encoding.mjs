import { createHash } from 'node:crypto';
export const sha256d = b => createHash('sha256').update(createHash('sha256').update(b).digest()).digest();
export const blockHash = b => Buffer.from(sha256d(b.subarray(0, 80))).reverse().toString('hex');

// Regtest proof of work; reject other targets rather than performing expensive mining.
export function solveHeader(header) {
  const bits = header.readUInt32LE(72);
  if (bits !== 0x207fffff) throw new Error('Only standard regtest target supported');
  const target = BigInt(bits & 0xffffff) << (8n * (BigInt(bits >>> 24) - 3n));
  for (let nonce = 0; nonce < 100000; nonce++) {
    header.writeUInt32LE(nonce, 76);
    if (BigInt(`0x${blockHash(header)}`) <= target) return header;
  }
  throw new Error('Regtest PoW search limit');
}

export function corruptSignature(hex) {
  const tx = Buffer.from(hex, 'hex');
  let pos = 4;
  const compact = () => {
    const v = tx[pos++];
    if (v < 253) return v;
    if (v === 253) { const n = tx.readUInt16LE(pos); pos += 2; return n; }
    throw new Error('Unexpected large test transaction');
  };
  if (tx[pos++] !== 0 || tx[pos++] !== 1) throw new Error('Expected SegWit transaction');
  const inputs = compact();
  for (let i = 0; i < inputs; i++) { pos += 36; const length = compact(); pos += length + 4; }
  const outputs = compact();
  for (let i = 0; i < outputs; i++) { pos += 8; const length = compact(); pos += length; }
  for (let i = 0; i < inputs; i++) {
    const items = compact();
    for (let j = 0; j < items; j++) {
      const length = compact();
      if (length >= 70 && length <= 73 && tx[pos] === 0x30) {
        tx[pos + 10] ^= 1;
        return tx.toString('hex');
      }
      pos += length;
    }
  }
  throw new Error('DER signature not found');
}
