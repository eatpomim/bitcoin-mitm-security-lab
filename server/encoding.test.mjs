import test from 'node:test';
import assert from 'node:assert/strict';
import { solveHeader, blockHash, corruptSignature } from './encoding.mjs';

test('regtest header meets target without changing its body fields', () => {
  const header = Buffer.alloc(80); header.writeUInt32LE(0x207fffff, 72);
  const prefix = header.subarray(0, 76).toString('hex');
  solveHeader(header);
  assert.equal(header.subarray(0, 76).toString('hex'), prefix);
  assert(BigInt(`0x${blockHash(header)}`) <= (0x7fffffn << 232n));
  header.writeUInt32LE(0x1d00ffff, 72);
  assert.throws(() => solveHeader(header), /regtest target/);
});
test('witness mutation preserves serialization and changes one signature byte', () => {
  const signature = Buffer.alloc(71, 0x12); signature[0] = 0x30;
  const raw = Buffer.concat([
    Buffer.from('02000000000101', 'hex'), Buffer.alloc(36), Buffer.from('00ffffffff01', 'hex'),
    Buffer.alloc(8), Buffer.from('01510247', 'hex'), signature,
    Buffer.from('21', 'hex'), Buffer.alloc(33, 2), Buffer.alloc(4)
  ]);
  const changed = Buffer.from(corruptSignature(raw.toString('hex')), 'hex');
  assert.equal(changed.length, raw.length);
  assert.equal(changed.filter((byte, i) => byte !== raw[i]).length, 1);
  assert.equal(changed.at(-1), raw.at(-1));
});
