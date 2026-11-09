import { rpc, nodes, guard, connect, sync, mine, ensureWallet, address, snapshot, waitFor, walletName } from './bitcoin.mjs';
import { solveHeader, blockHash, corruptSignature } from './encoding.mjs';

export const scenarios = [
  { id: 'partition', title: '네트워크 분리', level: '중', detail: 'C를 격리하고 A의 새 블록이 C에 전파되지 않는지 검증합니다.' },
  { id: 'fork', title: '블록체인 포크', level: '중', detail: '같은 부모에서 A와 C가 서로 다른 유효 블록을 생성합니다.' },
  { id: 'reorg', title: '체인 재구성', level: '중', detail: 'C의 작업량이 더 큰 체인을 공개하고 A/B의 체인 교체를 검증합니다.' },
  { id: 'double-spend', title: '이중 지불', level: '중', detail: '동일 UTXO의 상충 거래를 두 체인에 포함하고 재구성 후 살아남은 출력을 확인합니다.' },
  { id: 'signature', title: '잘못된 전자서명', level: '중', detail: '정상 서명의 수락 가능 여부와 손상시킨 서명의 거부 사유를 비교합니다.' },
  { id: 'block', title: '변조된 블록 거부', level: '상', detail: '유효한 Regtest PoW를 가진 잘못된 머클 루트의 블록을 제출합니다.' },
  { id: 'majority', title: '51% 공격 원리', level: '상', detail: '비공개 경쟁 체인이 앞선 뒤 공개되어 확정 거래가 뒤집히는 원리 시연입니다.' },
  { id: 'network', title: '네트워크 공격 · 제한 실습', level: '상 · 제한', detail: '3노드 격리 중 전파 지연과 재연결 회복을 측정합니다. 대규모·해시파워 성능 측정은 지원하지 않습니다.' }
];
const check = (condition, message) => { if (!condition) throw new Error(message); };

async function signedPair() {
  const utxos = await rpc('A', 'listunspent', [1], true);
  const u = utxos.find(u => u.spendable && u.amount > 1.001);
  if (!u) throw new Error('A의 성숙 UTXO가 없습니다. 초기 자금 준비를 실행하세요.');
  const input = [{ txid: u.txid, vout: u.vout, sequence: 0xfffffffd }];
  const amount = 1;
  const change = Number((u.amount - amount - 0.0001).toFixed(8));
  const changeAddress = await address('A');
  const sign = async dest => {
    const raw = await rpc('A', 'createrawtransaction', [input, { [dest]: amount, [changeAddress]: change }]);
    const signed = await rpc('A', 'signrawtransactionwithwallet', [raw], true);
    check(signed.complete, '거래 서명 실패');
    return signed.hex;
  };
  return { input: u, normal: await sign(await address('B')), conflict: await sign(await address('C')) };
}

export async function bootstrap(log) {
  await guard();
  for (const n of nodes) await ensureWallet(n);
  await connect(); await sync();
  log('wallets', { prepared: nodes.map(walletName) });
  return { wallets: nodes.map(walletName), nodes: await snapshot() };
}

export async function runScenario(id, log) {
  check(scenarios.some(s => s.id === id), '알 수 없는 시나리오');
  await guard();
  for (const n of nodes) await ensureWallet(n);
  await connect(); await sync();
  const before = await snapshot(); log('before', before);
  let result;
  let isolated = false;
  let recovered = false;
  try {
    if (id === 'signature') {
      const pair = await signedPair();
      const baseline = (await rpc('A', 'testmempoolaccept', [[pair.normal]]))[0];
      check(baseline.allowed, '정상 거래 대조군이 거부되었습니다.');
      const rejected = (await rpc('A', 'testmempoolaccept', [[corruptSignature(pair.normal)]]))[0];
      check(rejected.allowed === false && /script|signature/i.test(rejected['reject-reason'] || ''), '서명 검증 거부를 확인하지 못했습니다.');
      result = { baseline, rejected, broadcast: false };
    } else if (id === 'block') {
      const tip = await rpc('A', 'getbestblockhash');
      const raw = Buffer.from(await rpc('A', 'getblock', [tip, 0]), 'hex');
      raw.write(tip.match(/../g).reverse().join(''), 4, 32, 'hex');
      raw.fill(0, 36, 68);
      raw.writeUInt32LE(Math.max(raw.readUInt32LE(68) + 1, Math.floor(Date.now() / 1000)), 68);
      solveHeader(raw.subarray(0, 80));
      const candidate = blockHash(raw);
      const reason = await rpc('A', 'submitblock', [raw.toString('hex')]);
      const after = await rpc('A', 'getbestblockhash');
      check(reason === 'bad-txnmrklroot' && tip === after, `머클 루트 거부 검증 실패: ${reason}`);
      result = { candidate, reason, before: tip, after, validProofOfWork: true };
    } else {
      let pair;
      if (['double-spend', 'majority'].includes(id)) pair = await signedPair();
      // A/B remain connected while C becomes a private competing branch.
      await rpc('C', 'setnetworkactive', [false]); isolated = true;
      await waitFor(async () => (await rpc('C', 'getpeerinfo')).length === 0, 'C 격리 실패');
      const parent = await rpc('C', 'getbestblockhash');
      let normalTx, conflictTx;
      if (pair) normalTx = await rpc('A', 'sendrawtransaction', [pair.normal]);
      const publicTip = (await mine('A', 1)).at(-1);
      await waitFor(async () => await rpc('B', 'getbestblockhash') === publicTip, 'A/B 전파 실패');
      check(await rpc('C', 'getbestblockhash') === parent, '격리된 C에 블록이 전파되었습니다.');
      log('partition', { parent, publicTip, cPeers: 0 });
      if (id === 'partition' || id === 'network') {
        const start = Date.now();
        await connect(); await sync(publicTip); recovered = true;
        result = { parent, publicTip, blockedPropagation: true, recoveryMs: Date.now() - start, scale: '3 local nodes' };
      } else {
        if (pair) conflictTx = await rpc('C', 'sendrawtransaction', [pair.conflict]);
        const forkTip = (await mine('C', 1)).at(-1);
        check(forkTip !== publicTip, '포크 생성 실패');
        const publicHeader = await rpc('A', 'getblockheader', [publicTip]);
        const forkHeader = await rpc('C', 'getblockheader', [forkTip]);
        check(publicHeader.previousblockhash === forkHeader.previousblockhash, '공통 부모 불일치');
        log('fork', { parent, publicTip, forkTip });
        const winningTip = (await mine('C', 2)).at(-1);
        const winner = await rpc('C', 'getblockheader', [winningTip]);
        check(BigInt(`0x${winner.chainwork}`) > BigInt(`0x${publicHeader.chainwork}`), '누적 작업량 검증 실패');
        await connect(); await sync(winningTip); recovered = true;
        const orphan = await rpc('A', 'getblockheader', [publicTip]);
        check(orphan.confirmations === -1, '기존 블록이 비활성 체인으로 바뀌지 않았습니다.');
        result = { parent, publicTip, forkTip, winningTip, publicWork: publicHeader.chainwork, winnerWork: winner.chainwork, orphanConfirmations: orphan.confirmations };
        if (pair) {
          const normalOutput = await rpc('A', 'gettxout', [normalTx, 0, true]);
          const winnerOutput = await rpc('A', 'gettxout', [conflictTx, 0, true]);
          check(normalOutput === null && winnerOutput?.confirmations >= 1, '상충 거래 최종 출력 검증 실패');
          result = { ...result, input: { txid: pair.input.txid, vout: pair.input.vout }, normalTx, conflictTx,
            normalOutput, winnerOutput, meaning: '통제된 경쟁 체인 공개. 실제 해시파워 51% 측정 아님.' };
        }
      }
    }
    log('verified', result);
    return { result, before, after: await snapshot() };
  } finally {
    if (isolated && !recovered) {
      try { await connect(); await sync(); log('cleanup', { connected: true }); }
      catch { log('cleanup-error', { message: '재연결 실패. 관리자 화면에서 전체 연결 복구를 실행하세요.' }); }
    }
  }
}
