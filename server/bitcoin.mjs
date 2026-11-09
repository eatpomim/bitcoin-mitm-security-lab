import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const nodes = ['A', 'B', 'C'];
export const dataRoot = process.env.LAB_TEST_DATA ? path.join(root, '.test-data', path.basename(process.env.LAB_TEST_DATA)) : path.join(root, 'lab-data');
export const ports = process.env.LAB_TEST_DATA ? { A: 20443, B: 20543, C: 20643 } : { A: 19443, B: 19543, C: 19643 };
export const p2p = process.env.LAB_TEST_DATA ? { A: 20444, B: 20544, C: 20644 } : { A: 19444, B: 19544, C: 19644 };
export const walletName = n => `lab-user-${n}`;
export const minerWalletName = n => `lab-miner-${n}`;
export async function rpc(n, method, params = [], wallet = false) {
  if (!nodes.includes(n)) throw new Error('Unknown node');
  const cookie = await readFile(path.join(dataRoot, n, 'regtest', '.cookie'), 'utf8');
  const selectedWallet = wallet === true ? walletName(n) : typeof wallet === 'string' ? wallet : null;
  const response = await fetch(`http://127.0.0.1:${ports[n]}/${selectedWallet ? `wallet/${selectedWallet}` : ''}`, {
    method: 'POST', headers: { Authorization: `Basic ${Buffer.from(cookie.trim()).toString('base64')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000)
  });
  const data = await response.json();
  if (data.error) throw new Error(`${method}: ${data.error.message}`);
  return data.result;
}
export async function guard() {
  for (const n of nodes) {
    if ((await rpc(n, 'getblockchaininfo')).chain !== 'regtest') throw new Error('Regtest required');
  }
}
export async function snapshot() {
  return Promise.all(nodes.map(async n => {
    try {
      const [chain, net, peers, mempool] = await Promise.all([
        rpc(n, 'getblockchaininfo'), rpc(n, 'getnetworkinfo'), rpc(n, 'getpeerinfo'), rpc(n, 'getrawmempool')
      ]);
      let balance = null;
      try { balance = await rpc(n, 'getbalances', [], true); } catch { }
      return { id: n, online: true, height: chain.blocks, hash: chain.bestblockhash, chainwork: chain.chainwork,
        chain: chain.chain, pruned: chain.pruned, active: net.networkactive, peers: peers.map(p => ({ address: p.addr, inbound: p.inbound, bytesSent: p.bytessent, bytesReceived: p.bytesrecv })),
        mempool, balance: balance?.mine?.trusted ?? null };
    } catch { return { id: n, online: false, error: '노드에 연결할 수 없습니다. lab.ps1 Start와 로그를 확인하세요.' }; }
  }));
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function waitFor(fn, message, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await sleep(300); }
  throw new Error(message);
}
export async function connect() {
  for (const n of nodes) await rpc(n, 'setnetworkactive', [true]);
  for (const n of ['B', 'C']) await rpc('A', 'addnode', [`127.0.0.1:${p2p[n]}`, 'onetry']);
}
export async function sync(expected) {
  await waitFor(async () => {
    const hashes = await Promise.all(nodes.map(n => rpc(n, 'getbestblockhash')));
    return hashes.every(h => h === (expected || hashes[0]));
  }, '체인 동기화 시간 초과');
}
async function ensureNamedWallet(n, name) {
  if ((await rpc(n, 'listwallets')).includes(name)) return;
  const existing = await rpc(n, 'listwalletdir');
  if (existing.wallets.some(w => w.name === name)) await rpc(n, 'loadwallet', [name]);
  else await rpc(n, 'createwallet', [name]);
}
export const ensureWallet = n => ensureNamedWallet(n, walletName(n));
export const ensureMinerWallet = n => ensureNamedWallet(n, minerWalletName(n));
export const address = (n, wallet = walletName(n)) => rpc(n, 'getnewaddress', ['', 'bech32'], wallet);
// Stable labeled receiving address for the UI; do not generate a new one on each poll.
export async function receivingAddress(n) {
  const label = 'mitm-demo-recipient';
  const addresses = await rpc(n, 'getaddressesbylabel', [label], true).catch(e => {
    if (/Label not found|No addresses with label/i.test(e.message)) return null;
    throw e;
  });
  if (addresses && Object.keys(addresses).length) return Object.keys(addresses)[0];
  return rpc(n, 'getnewaddress', [label, 'bech32'], true);
}

export async function mine(n, count) {
  await ensureMinerWallet(n);
  return rpc(n, 'generatetoaddress', [count, await address(n, minerWalletName(n))]);
}
export async function fundNode(n, amount = 10) {
  await ensureWallet(n);
  await ensureMinerWallet('A');
  let balance = await rpc('A', 'getbalance', [], minerWalletName('A'));
  if (balance < amount + 0.001) {
    const prepared = await mine('A', 101);
    await sync(prepared.at(-1));
    balance = await rpc('A', 'getbalance', [], minerWalletName('A'));
  }
  if (balance < amount + 0.001) throw new Error('채굴 전용 지갑의 잔액이 부족합니다.');
  const txid = await rpc('A', 'sendtoaddress', [await address(n), amount, '', '', false, true, null, 'unset', false, 1], minerWalletName('A'));
  const block = (await mine('A', 1)).at(-1);
  await sync(block);
  return { node: n, amount, txid, block };
}
export async function zeroNodeBalance(n) {
  await ensureWallet(n);
  await ensureMinerWallet('A');
  const confirmationBlock = (await mine('A', 1)).at(-1);
  await sync(confirmationBlock);
  const before = await rpc(n, 'getbalance', [], true);
  if (before <= 0) return { node: n, before: 0, after: 0, txid: null, block: confirmationBlock };
  const destination = await address('A', minerWalletName('A'));
  const sweep = await rpc(n, 'sendall', [[destination], null, 'unset', 1], true);
  if (!sweep.complete || !sweep.txid) throw new Error('잔액 회수 거래를 완성하지 못했습니다.');
  const block = (await mine('A', 1)).at(-1);
  await sync(block);
  const after = await rpc(n, 'getbalance', [], true);
  if (after !== 0) throw new Error(`잔액 초기화 후 ${after} BTC가 남았습니다.`);
  return { node: n, before, after, txid: sweep.txid, block };
}
