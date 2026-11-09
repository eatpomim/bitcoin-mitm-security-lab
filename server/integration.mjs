// Dedicated disposable-in-purpose chains; files are kept for inspection, never deleted.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
process.env.LAB_TEST_DATA = `run-${Date.now()}`;
const { dataRoot, nodes, ports, p2p, rpc, guard, waitFor, mine, sync, fundNode, zeroNodeBalance } = await import('./bitcoin.mjs');
const { scenarios, bootstrap, runScenario } = await import('./experiments.mjs');
const children = [];
const report = [];
try {
  for (const n of nodes) {
    const dir = path.join(dataRoot, n); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'bitcoin.conf'), [
      'regtest=1', 'server=1', 'dbcache=32', 'maxmempool=16', 'maxconnections=16', 'rpcthreads=2', 'par=1', 'discover=0', 'natpmp=0', 'listenonion=0', 'printtoconsole=0',
      '[regtest]', 'connect=0', 'dnsseed=0', `port=${p2p[n]}`, `bind=127.0.0.1:${p2p[n]}`, `rpcport=${ports[n]}`, 'rpcbind=127.0.0.1', 'rpcallowip=127.0.0.1'
    ].join('\n'));
    const child = spawn('C:\\Program Files\\Bitcoin\\daemon\\bitcoind.exe', [`-datadir=${dir}`, '-regtest'], { windowsHide: true, stdio: 'ignore' });
    child.on('error', error => console.error(error.message));
    children.push(child);
    await waitFor(async () => { try { return (await rpc(n, 'getblockchaininfo')).chain === 'regtest'; } catch { return false; } }, `Node ${n} startup failed`, 45000);
  }
  await waitFor(async () => { try { await guard(); return true; } catch { return false; } }, 'Test startup failed', 45000);
  const log = () => {};
  await bootstrap(log);
  const aBeforeMining = await rpc('A', 'getbalance', [], true);
  const hiddenMinerTip = (await mine('A', 1)).at(-1);
  await sync(hiddenMinerTip);
  assert.equal(await rpc('A', 'getbalance', [], true), aBeforeMining);
  await fundNode('B', 10);
  assert.equal(await rpc('B', 'getbalance', [], true), 10);
  await zeroNodeBalance('B');
  assert.equal(await rpc('B', 'getbalance', [], true), 0);
  await fundNode('A', 10);
  assert.equal(await rpc('A', 'getbalance', [], true), 10);
  report.push({ id: 'separate-miner-and-admin-funding', status: 'passed' });
  console.log('PASS hidden miner, admin funding, and selected-node balance reset');
  for (const scenario of scenarios) {
    const start = Date.now();
    const evidence = await runScenario(scenario.id, log);
    assert(evidence.after.every(n => n.online && n.chain === 'regtest'));
    const record = { id: scenario.id, status: 'passed', elapsedMs: Date.now() - start, evidence };
    report.push(record);
    console.log(`PASS ${scenario.id} (${record.elapsedMs}ms)`);
  }
  const apiProcess = spawn(process.execPath, [path.join(import.meta.dirname, 'index.mjs')], {
    env: { ...process.env, LAB_HOST: '127.0.0.1', LAB_PORT: '18000' }, windowsHide: true, stdio: 'ignore'
  });
  children.push(apiProcess);
  const base = 'http://127.0.0.1:18000';
  await waitFor(async () => { try { return (await fetch(`${base}/api/state`)).status === 401; } catch { return false; } }, 'API startup failed');
  const keys = JSON.parse(await readFile(path.join(dataRoot, 'api', 'access.json'), 'utf8'));
  const request = async (role, payload) => fetch(`${base}/api/${payload ? 'actions' : 'state'}`, {
    method: payload ? 'POST' : 'GET', headers: { Authorization: `Bearer ${keys[role]}`, 'Content-Type': 'application/json' },
    ...(payload ? { body: JSON.stringify({ confirm: 'REGTEST', ...payload }) } : {})
  });
  const scoped = await (await request('A')).json();
  assert.deepEqual(scoped.nodes.map(n => n.id), ['A']);
  assert.equal('height' in scoped.nodes[0], false);
  assert.equal('peers' in scoped.nodes[0], false);
  assert.equal('mempool' in scoped.nodes[0], false);
  assert.equal((await request('A', { action: 'experiment', scenario: 'block' })).status, 403);
  assert.equal((await request('A', { action: 'reset', resetConfirm: '초기화' })).status, 403);
  assert.equal((await request('A', { action: 'zero', node: 'A' })).status, 403);
  assert.equal((await request('A', { action: 'mine', node: 'A', count: 1 })).status, 403);
  assert.equal((await request('A', { action: 'send', node: 'B', to: 'C', amount: 1 })).status, 403);
  assert.equal((await request('admin', { action: 'mine', node: 'A', count: 999999 })).status, 400);
  assert.equal((await request('admin', { action: 'experiment', scenario: 'signature', confirm: '' })).status, 400);
  const job = await request('admin', { action: 'experiment', scenario: 'signature' });
  assert.equal(job.status, 202);
  const { id } = await job.json();
  assert.equal((await request('admin', { action: 'recover' })).status, 409);
  await waitFor(async () => {
    const state = await (await request('admin')).json();
    const record = state.history.find(r => r.id === id);
    if (!record) return false;
    assert.equal(record.status, 'passed'); return true;
  }, 'API job completion failed');
  const forbidden = await fetch(`${base}/api/state`, { headers: { Origin: 'https://untrusted.example', Authorization: `Bearer ${keys.admin}` } });
  assert.equal(forbidden.status, 403);
  await fundNode('A', 10);
  for (const [role, from, to, amount] of [['A', 'A', 'B', 0.5], ['B', 'B', 'C', 0.25], ['admin', 'C', 'B', 0.1]]) {
    const before = Object.fromEntries(await Promise.all(nodes.map(async n => [n, await rpc(n, 'getbalance', [], true)])));
    const height = await rpc(from, 'getblockcount');
    const response = await request(role, { action: 'send', node: from, to, amount });
    assert.equal(response.status, 202);
    const { id: transferId } = await response.json();
    let record;
    await waitFor(async () => {
      const state = await (await request(role)).json();
      record = state.history.find(r => r.id === transferId);
      return !!record;
    }, 'Automatic transfer confirmation timed out');
    assert.equal(record.status, 'passed', record.error);
    const receipt = record.evidence;
    const sent = await rpc(from, 'gettransaction', [receipt.txid], true);
    const received = await rpc(to, 'gettransaction', [receipt.txid], true);
    assert.equal(receipt.fee, -sent.fee);
    assert(receipt.fee > 0);
    assert.equal(receipt.confirmations, 1);
    assert.equal(received.confirmations, 1);
    assert.equal(received.blockhash, receipt.block);
    assert(received.details.some(d => d.address === receipt.address && d.category === 'receive' && d.amount === amount));
    assert.equal(await rpc(from, 'getblockcount'), height + 1);
    for (const n of nodes) {
      const expected = before[n] + (n === from ? -amount - receipt.fee : n === to ? amount : 0);
      assert.equal(Math.round((await rpc(n, 'getbalance', [], true)) * 1e8), Math.round(expected * 1e8));
    }
    const receiverState = await (await request(to)).json();
    assert.equal(receiverState.nodes[0].balance, await rpc(to, 'getbalance', [], true));
    report.push({ id: `auto-confirm-${role}-${from}-to-${to}`, status: 'passed', evidence: receipt });
    console.log(`PASS automatic confirmation and exact balance changes: ${role}, ${from} -> ${to}`);
  }
  const heightBeforeFailure = await rpc('B', 'getblockcount');
  const insufficient = await request('B', { action: 'send', node: 'B', to: 'A', amount: 10 });
  assert.equal(insufficient.status, 202);
  const { id: failedId } = await insufficient.json();
  await waitFor(async () => {
    const state = await (await request('B')).json();
    const record = state.history.find(r => r.id === failedId);
    if (!record) return false;
    assert.equal(record.status, 'failed');
    assert.equal(record.events.some(e => e.step === 'blocks'), false);
    return true;
  }, 'Insufficient balance job timed out');
  assert.equal(await rpc('B', 'getblockcount'), heightBeforeFailure);
  report.push({ id: 'insufficient-balance-no-auto-block', status: 'passed' });
  console.log('PASS rejected transfer does not generate a block');
  apiProcess.kill();
  report.push({ id: 'api-auth-lock-confirmation', status: 'passed' });
  console.log('PASS API authentication, node scope, role restrictions, input limits, confirmation, job lock, origin checks');
} catch (error) {
  report.push({ status: 'failed', error: error.stack }); console.error(error); process.exitCode = 1;
} finally {
  await writeFile(path.join(dataRoot, 'report.json'), JSON.stringify(report, null, 2));
  for (const n of nodes) { try { await rpc(n, 'stop'); } catch { } }
  for (const child of children) {
    if (child.exitCode !== null) continue;
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (child.exitCode === null) child.kill();
  }
  console.log(`Evidence: ${dataRoot}`);
}
