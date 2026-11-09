import test from 'node:test';
import assert from 'node:assert/strict';
import {checkIntent, verifyPsbt} from './intent.mjs';
const original = {node:'A',address:'bcrt1qoriginal',amount:1};
test('HTTP MITM address change is rejected before signing',()=>{
 assert.throws(()=>checkIntent(original,{node:'A',to:'bcrt1qattacker',amount:1}),/PSBT 검증 실패/);
});
test('PSBT recipient address and amount must match trusted intent',()=>{
 const good={tx:{vout:[{value:1,scriptPubKey:{address:'bcrt1qoriginal'}},{value:0.5,scriptPubKey:{address:'bcrt1qchange'}}]}};
 assert.equal(verifyPsbt(good,original,1).recipient,'bcrt1qoriginal');
 assert.throws(()=>verifyPsbt({tx:{vout:[{value:1,scriptPubKey:{address:'bcrt1qattacker'}}]}},original,-1),/PSBT 검증 실패/);
 assert.throws(()=>verifyPsbt({tx:{vout:[{value:0.9,scriptPubKey:{address:'bcrt1qoriginal'}}]}},original,-1),/PSBT 검증 실패/);
});
