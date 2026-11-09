import path from 'node:path';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { root, nodes } from './bitcoin.mjs';

// Trusted intents are created locally, outside the HTTP request/proxy path.
const directory = path.join(root, '.local', 'trusted-intents');
const sat = amount => Math.round(amount * 1e8);
export function checkIntent(intent, { node, to, amount }) {
  if (!intent || intent.node !== node || intent.address !== to || sat(intent.amount) !== sat(amount)) {
    throw Object.assign(new Error('PSBT 검증 실패: 신뢰된 원래 송금 의도와 HTTP 요청이 일치하지 않습니다. 서명을 중단합니다.'), {status: 409});
  }
}
export function verifyPsbt(decoded, intent, changePosition) {
  const outputs = decoded?.tx?.vout;
  if (!Array.isArray(outputs) || !Number.isInteger(changePosition)) throw new Error('PSBT 출력 검증 불가');
  const payees = outputs.filter((_, i) => i !== changePosition);
  if (payees.length !== 1 || payees[0]?.scriptPubKey?.address !== intent.address || sat(payees[0].value) !== sat(intent.amount)) {
    throw Object.assign(new Error('PSBT 검증 실패: 수신 주소 또는 금액이 원래 송금 의도와 다릅니다. 서명을 중단합니다.'), {status: 409});
  }
  if (outputs.length > 2 || (changePosition >= outputs.length && changePosition !== -1)) throw new Error('예상하지 못한 PSBT 출력');
  return {recipient: intent.address, amount: intent.amount, changePosition, outputs: outputs.map(o => ({address:o.scriptPubKey?.address || null, value:o.value}))};
}
export async function saveIntent({node,address,amount}) {
  if (!nodes.includes(node) || typeof address !== 'string' || !address || !(amount >= 0.00001 && amount <= 10)) throw new Error('노드, 주소, 송금액이 올바르지 않습니다.');
  await mkdir(directory,{recursive:true,mode:0o700});
  const id=randomBytes(16).toString('hex');
  await writeFile(path.join(directory,`${id}.json`),JSON.stringify({node,address,amount,createdAt:Date.now()}),{flag:'wx',mode:0o600});
  return id;
}
export async function loadIntent(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw Object.assign(new Error('신뢰된 송금 의도 ID를 입력하세요.'),{status:400});
  let intent;
  try {intent=JSON.parse(await readFile(path.join(directory,`${id}.json`),'utf8'));}
  catch {throw Object.assign(new Error('신뢰된 송금 의도가 없습니다. 로컬에서 먼저 생성하세요.'),{status:409});}
  if (Date.now()-intent.createdAt>15*60*1000) throw Object.assign(new Error('송금 의도 유효기간(15분)이 지났습니다.'),{status:409});
  return intent;
}
export async function consumeIntent(id) {
  // Rename atomically so a successful signing request cannot reuse the same intent.
  await rename(path.join(directory,`${id}.json`),path.join(directory,`${id}.used`));
}
