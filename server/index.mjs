import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { root, dataRoot, nodes, snapshot, guard, rpc, connect, sync, mine, fundNode, zeroNodeBalance, address, receivingAddress } from './bitcoin.mjs';
import { scenarios, runScenario, bootstrap } from './experiments.mjs';
import { loadIntent, checkIntent, verifyPsbt, consumeIntent } from './intent.mjs';

const local = process.env.LAB_TEST_DATA ? path.join(dataRoot, 'api') : path.join(root, '.local');
await mkdir(local, { recursive: true });
const keyFile = path.join(local, 'access.json');
const historyFile = path.join(local, 'history.json');
const execFileAsync = promisify(execFile);
let keys;
try { keys = JSON.parse(await readFile(keyFile, 'utf8')); }
catch (e) {
  if (e.code !== 'ENOENT') throw e;
  keys = Object.fromEntries(['admin', ...nodes].map(role => [role, randomBytes(32).toString('hex')]));
  await writeFile(keyFile, JSON.stringify(keys, null, 2), { mode: 0o600 });
}
let history = [];
try { history = JSON.parse(await readFile(historyFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
let busy = null;
let currentEvents = [];
const limit = 16384;

function roleFor(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  for (const [role, key] of Object.entries(keys)) {
    const a = Buffer.from(token), b = Buffer.from(key);
    if (a.length === b.length && timingSafeEqual(a, b)) return role;
  }
  return null;
}
function assert(ok, message, status = 400) { if (!ok) throw Object.assign(new Error(message), { status }); }
async function body(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    assert(Buffer.byteLength(data) <= limit, '요청 크기 초과', 413);
  }
  try { return JSON.parse(data || '{}'); } catch { throw Object.assign(new Error('잘못된 JSON'), { status: 400 }); }
}
async function resetLab() {
  const windowsRoot = process.env.SystemRoot || 'C:\\Windows';
  const powerShell = path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await execFileAsync(powerShell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'lab.ps1'), 'Reset'], {
    cwd: root, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024
  });
  return { reset: true, nodes: await snapshot() };
}
async function launch(kind, role, task, { clearHistory = false } = {}) {
  assert(!busy, '다른 작업이 실행 중입니다.', 409);
  const record = { id: randomBytes(8).toString('hex'), kind, role, startedAt: new Date().toISOString(), status: 'running', events: [] };
  busy = record; currentEvents = record.events;
  const log = (step, data) => currentEvents.push({ at: new Date().toISOString(), step, data });
  // Respond immediately; progress and final evidence are available through /api/state.
  setImmediate(async () => {
    try { record.evidence = await task(log); record.status = 'passed'; }
    catch (e) { record.status = 'failed'; record.error = e.message; }
    finally {
      record.endedAt = new Date().toISOString();
      if (clearHistory && record.status === 'passed') history = [];
      else { history.unshift(record); history = history.slice(0, 50); }
      try { await writeFile(historyFile, JSON.stringify(history, null, 2)); }
      catch { record.persistenceError = '결과 파일 저장 실패. 화면의 JSON을 별도로 저장하세요.'; }
      busy = null;
    }
  });
  return { id: record.id };
}
function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
const origins = new Set((process.env.LAB_ORIGINS || '').split(',').filter(Boolean));
const server = http.createServer(async (req, res) => {
  try {
    const origin = req.headers.origin;
    // Same-origin web works without CORS. Explicit allowlist supports Metro / native web preview.
    const ownOrigin = origin && origin === `http://${req.headers.host}`;
    if (origin && !ownOrigin) {
      assert(origins.has(origin), '허용되지 않은 Origin', 403);
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.writeHead(204); res.end(); return;
    }
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      assert(req.method === 'GET', 'Method not allowed', 405);
      const dist = path.join(root, 'app', 'dist');
      let file = path.resolve(dist, `.${decodeURIComponent(url.pathname)}`);
      assert(file.startsWith(dist + path.sep) || file === dist, '잘못된 경로', 403);
      try { if (!(await stat(file)).isFile()) file = path.join(dist, 'index.html'); }
      catch { file = path.join(dist, 'index.html'); }
      let content;
      try { content = await readFile(file); } catch { send(res, 503, { error: '웹 빌드가 없습니다. npm run build를 실행하세요.' }); return; }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.ttf': 'font/ttf' };
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(content); return;
    }
    const role = roleFor(req);
    assert(role, '접속 키가 필요합니다.', 401);
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const status = await snapshot();
      const recipientAddresses = Object.fromEntries(await Promise.all(nodes.map(async n => {
        try { return [n, await receivingAddress(n)]; } catch { return [n, null]; }
      })));
      const visibleNodes = role === 'admin' ? status : status.filter(n => n.id === role).map(({ id, online, active, balance, error }) => ({ id, online, active, balance, error }));
      send(res, 200, { role, nodes: visibleNodes, recipientAddresses, scenarios,
        busy: busy && (role === 'admin' || busy.role === role) ? busy : busy ? { status: 'running', kind: '다른 사용자의 작업', events: [] } : null,
        history: role === 'admin' ? history : history.filter(r => r.role === role) }); return;
    }
    assert(req.method === 'POST' && url.pathname === '/api/actions', '찾을 수 없는 API', 404);
    const input = await body(req);
    assert(input.confirm === 'REGTEST', '실행 확인이 필요합니다.');
    const adminActions = ['bootstrap', 'experiment', 'recover', 'mine', 'fund', 'zero', 'reset'];
    if (adminActions.includes(input.action)) assert(role === 'admin', '관리자 권한이 필요합니다.', 403);
    assert([...adminActions, 'send'].includes(input.action), '허용되지 않은 동작');
    if (input.action === 'experiment') assert(scenarios.some(s => s.id === input.scenario), '알 수 없는 시나리오');
    if (['mine', 'send', 'fund', 'zero'].includes(input.action)) assert(nodes.includes(input.node), '알 수 없는 노드');
    if (input.action === 'mine') assert(Number.isInteger(input.count) && input.count >= 1 && input.count <= 10, '블록 수는 1~10');
    if (input.action === 'send') {
      assert(role === 'admin' || role === input.node, '다른 노드의 지갑을 사용할 수 없습니다.', 403);
      assert(typeof input.to === 'string' && input.to.length <= 100, '수신 지갑 주소를 입력하세요.');
      assert(typeof input.intentId === 'string', '로컬에서 생성한 신뢰된 송금 의도 ID가 필요합니다.');
      assert(typeof input.amount === 'number' && Number.isFinite(input.amount) && input.amount >= 0.00001 && input.amount <= 10, '송금액은 0.00001~10 BTC');
    }
    const job = await launch(input.action === 'experiment' ? input.scenario : input.action, role, async log => {
      if (input.action === 'reset') return resetLab();
      await guard();
      if (input.action === 'bootstrap') return bootstrap(log);
      if (input.action === 'experiment') return runScenario(input.scenario, log);
      if (input.action === 'recover') { await connect(); await sync(); return snapshot(); }
      if (input.action === 'mine') { const hashes = await mine(input.node, input.count); log('blocks', hashes); return hashes; }
      if (input.action === 'fund') { await connect(); await sync(); const result = await fundNode(input.node, 10); log('funding', result); return result; }
      if (input.action === 'zero') { await connect(); await sync(); const result = await zeroNodeBalance(input.node); log('balance-reset', result); return result; }
      const dest = input.to;
      const intent = await loadIntent(input.intentId);
      // Check against the independent trusted local file before any signing.
      checkIntent(intent, {node:input.node,to:dest,amount:input.amount});
      const validation = await rpc(input.node, 'validateaddress', [dest]);
      assert(validation.isvalid && validation.iswitness, '올바른 Regtest SegWit 주소가 아닙니다.');
      const recipientAddresses = Object.fromEntries(await Promise.all(nodes.map(async n => [n, await receivingAddress(n)])));
      const recipientNode = nodes.find(n => recipientAddresses[n] === dest) || null;
      assert(recipientNode !== input.node, '자기 노드로 송금할 수 없습니다.');
      // Construct an unsigned PSBT. Bitcoin Core identifies the change output.
      const funded = await rpc(input.node, 'walletcreatefundedpsbt', [[], [{[dest]:input.amount}], 0, {fee_rate:1, replaceable:false}, true], true);
      const decoded = await rpc(input.node, 'decodepsbt', [funded.psbt]);
      const verified = verifyPsbt(decoded, intent, funded.changepos);
      log('psbt-verified', {intentId:input.intentId, ...verified, fee:funded.fee});
      // Consume before signing: replaying the same intent must fail.
      await consumeIntent(input.intentId);
      const signed = await rpc(input.node, 'walletprocesspsbt', [funded.psbt], true);
      assert(signed.complete, 'PSBT 서명이 완료되지 않았습니다.');
      const finalized = await rpc(input.node, 'finalizepsbt', [signed.psbt]);
      assert(finalized.complete && finalized.hex, 'PSBT 최종 거래 생성 실패');
      const txid = await rpc(input.node, 'sendrawtransaction', [finalized.hex]);
      log('transfer', { from: input.node, to: recipientNode, address: dest, amount: input.amount, txid });
      try {
        // Mine on the sender, which already has the transaction in its mempool.
        // Rewards go to the separate miner wallet, never the user's balance.
        const block = (await mine(input.node, 1)).at(-1);
        log('blocks', [block]);
        await sync(block);
        const sent = await rpc(input.node, 'gettransaction', [txid], true);
        const received = recipientNode ? await rpc(recipientNode, 'gettransaction', [txid], true) : null;
        assert(sent.confirmations >= 1 && (!received || received.confirmations >= 1), '거래의 블록 확정을 확인하지 못했습니다.');
        const receipt = { txid, from: input.node, to: recipientNode, address: dest, amount: input.amount,
          fee: -sent.fee, block, confirmations: sent.confirmations, recipientWalletVerified: !!received };
        log('confirmed', receipt);
        return receipt;
      } catch (error) {
        throw new Error(`거래는 전송됐지만 자동 확정을 완료하지 못했습니다. 중복 송금하지 말고 거래내역을 확인하세요. 거래 ID: ${txid}. ${error.message}`);
      }
    }, { clearHistory: input.action === 'reset' });
    send(res, 202, job);
  } catch (e) {
    send(res, e.status || 500, { error: e.status ? e.message : '요청 처리 실패. PC의 노드 상태와 서버 로그를 확인하세요.' });
  }
});
const host = process.env.LAB_HOST || '127.0.0.1';
const port = Number(process.env.LAB_PORT || 8000);
server.listen(port, host, () => {
  console.log(`Regtest Lab: http://${host}:${port}`);
  console.log('접속 키 파일: .local/access.json');
});
