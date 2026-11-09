// Run on the trusted local terminal, not through the intercepted HTTP API.
import { saveIntent } from './intent.mjs';
import { rpc, receivingAddress } from './bitcoin.mjs';
const [node, recipient, amountText] = process.argv.slice(2);
const amount=Number(amountText);
try {
  const address=['A','B','C'].includes(recipient) ? await receivingAddress(recipient) : recipient;
  const valid=await rpc(node,'validateaddress',[address]);
  if (!valid.isvalid || !valid.iswitness) throw new Error('올바른 Regtest SegWit 주소가 아닙니다.');
  const id=await saveIntent({node,address,amount});
  console.log(`신뢰된 송금 의도 등록 완료\n보내는 노드: ${node}\n원래 수신 주소: ${address}\n금액: ${amount} BTC\n의도 ID: ${id}\n웹 화면의 의도 ID 칸에 입력하세요.`);
} catch(e) {console.error(e.message);process.exitCode=1;}
