import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, Modal, StyleSheet, useWindowDimensions, Platform, StatusBar } from 'react-native';

const palette = { bg: '#f5f6f7', panel: '#ffffff', border: '#dce0e5', text: '#242a31', muted: '#69727d', green: '#365d85', orange: '#a35531' };
const names = { bootstrap: '테스트 시작', recover: '연결 복구', mine: '블록 생성', fund: '10 BTC 추가', zero: '잔액 초기화', reset: '전체 데이터 초기화', send: '코인 보내기', partition: '네트워크 분리', fork: '블록체인 포크', reorg: '체인 재구성', 'double-spend': '이중 지불', signature: '잘못된 서명 검증', block: '변조 블록 검증', majority: '51% 공격 원리', network: '네트워크 제한 실습' };
const money = value => value == null ? "'초기 설정 필요'" : `${Number(value).toLocaleString('en-US', { maximumFractionDigits: 8 })} BTC`;
function historySummary(record) {
  const transfer = record.evidence || record.events?.find(event => event.step === 'transfer')?.data;
  if (record.kind === 'send' && transfer?.from && transfer?.to && transfer?.amount != null) {
    return `노드 ${transfer.from} → ${transfer.to ? `노드 ${transfer.to}` : transfer.address || '외부 주소'} · ${money(transfer.amount)}`;
  }
  return record.role === 'admin' ? '관리자' : `노드 ${record.role}`;
}
function Button({ title, onPress, disabled, secondary, danger }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => [s.button, secondary && s.secondary, danger && s.danger, (disabled || pressed) && { opacity: .45 }]}><Text style={[s.buttonText, secondary && { color: palette.text }]}>{title}</Text></Pressable>;
}
function Tag({ children, warning }) { return <Text style={[s.tag, warning && { color: palette.orange }]}>{children}</Text>; }
function Field(props) { return <TextInput placeholderTextColor="#8b939d" autoCapitalize="none" autoCorrect={false} style={s.input} {...props} />; }
export default function App() {
  const wide = useWindowDimensions().width > 900;
  const endpoint = Platform.OS === 'web' ? '' : 'http://192.168.0.10:8000';
  const [key, setKey] = useState('');
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState(null);
  const [tab, setTab] = useState('overview');
  const [selected, setSelected] = useState('A');
  const [to, setTo] = useState('');
  const [fundTarget, setFundTarget] = useState('');
  const [amount, setAmount] = useState('1');
  const [intentId, setIntentId] = useState('');
  const [pending, setPending] = useState(null);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState(null);
  const [sending, setSending] = useState(false);
  const [technical, setTechnical] = useState(false);
  const refreshing = useRef(false);
  const auth = useRef(0);
  async function api(route, body) {
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/${route}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key.trim()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }
  async function refresh() {
    if (refreshing.current) return;
    refreshing.current = true;
    const epoch = auth.current;
    try {
      const data = await api('state');
      if (auth.current !== epoch) return;
      setState(data); setConnected(true); setError('');
      if (data.role !== 'admin') { setSelected(data.role); setTab(current => ['node', 'history'].includes(current) ? current : 'node'); }
    } catch (e) { if (auth.current === epoch) setError(e.message); }
    finally { refreshing.current = false; }
  }
  useEffect(() => { if (!connected) return; const timer = setInterval(refresh, 3000); return () => clearInterval(timer); }, [connected, key, endpoint]);
  async function execute() {
    setSending(true);
    try { await api('actions', { ...pending, confirm: 'REGTEST' }); setPending(null); await refresh(); }
    catch (e) { setError(e.message); }
    finally { setSending(false); }
  }
  async function sendTransfer() {
    setSending(true);
    setError('');
    try {
      const destination = state?.recipientAddresses?.[to];
      if (!destination) throw new Error('수신 노드의 지갑 주소를 불러오지 못했습니다.');
      await api('actions', { action: 'send', node: selected, to: destination, amount: Number(amount), intentId: intentId.trim(), confirm: 'REGTEST' });
      setIntentId('');
      await refresh();
    } catch (e) { setError(e.message); }
    finally { setSending(false); }
  }
  const admin = state?.role === 'admin';
  const busy = !!state?.busy || sending;
  const node = state?.nodes.find(n => n.id === selected);
  const ask = (action, extra = {}) => { setError(''); setPending({ action, ...extra }); };
  const ready = state?.nodes.every(n => n.balance != null);
  const chooseNode = id => { setSelected(id); setTo(''); setTechnical(false); setTab('node'); };
  const pendingTitle = pending && (pending.action === 'experiment' ? names[pending.scenario] : names[pending.action]);
  const pendingText = !pending ? '' : pending.action === 'send' ? `노드 ${pending.node}에서 노드 ${pending.to}로 ${pending.amount} BTC를 보냅니다. 수수료가 별도로 필요합니다. 전송 후 서버가 테스트 블록을 자동 생성하여 거래를 확정합니다.` : pending.action === 'mine' ? `노드 ${pending.node}에서 블록 1개를 생성합니다. 블록에 포함된 거래가 확정되고 다른 노드에 전달됩니다.` : pending.action === 'fund' ? `노드 ${pending.node}에 10 BTC를 추가합니다.` : pending.action === 'zero' ? `노드 ${pending.node}의 잔액을 0 BTC로 만듭니다.` : pending.action === 'reset' ? 'A·B·C의 블록, 지갑, 잔액, 피어 기록과 전체 거래내역을 삭제합니다.' : pending.action === 'bootstrap' ? '실습용 지갑을 준비합니다.' : pending.action === 'recover' ? '노드를 다시 연결하고 같은 체인으로 동기화합니다.' : state?.scenarios.find(item => item.id === pending.scenario)?.detail;
  return <View style={s.root}><StatusBar barStyle="dark-content" /><ScrollView contentContainerStyle={[s.page, !wide && s.mobilePage]} keyboardShouldPersistTaps="handled">
    {!connected ? <View style={[s.card, { maxWidth: 480, width: '100%', alignSelf: 'center', marginVertical: 24 }]}>
      <Text style={s.label}>접속 키</Text><Field value={key} onChangeText={setKey} secureTextEntry placeholder="접속 키 입력" />
      <Button title="접속하기" onPress={refresh} disabled={!key.trim()} />
    </View> : <>
      <View style={s.nav}><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.navContent}>{(admin ? [['overview', '대시보드'], ['node', '코인 보내기'], ['admin', '관리자'], ['history', '거래내역 확인']] : [['node', '송금하기'], ['history', '거래내역']]).map(([id, title]) => <Pressable accessibilityRole="tab" accessibilityState={{ selected: tab === id }} key={id} onPress={() => setTab(id)} style={[s.navItem, tab === id && s.navActive]}><Text style={{ color: tab === id ? palette.green : palette.muted, fontWeight: tab === id ? '600' : '400' }}>{title}</Text></Pressable>)}<View style={s.navLogout}><Button title="로그아웃" secondary onPress={() => { auth.current++; setConnected(false); setKey(''); setState(null); setTab('overview'); setFundTarget(''); setPending(null); setDetail(null); }} /></View></ScrollView></View>
      {state.busy && <View style={s.banner}><Text style={s.heading}>{names[state.busy.kind] || '실습 작업'} 진행 중</Text></View>}
      {tab === 'overview' && <>
        <View style={s.section}><Text style={s.heading}>대시보드</Text></View>
        <View style={s.table}><View style={s.tableHeading}><Text style={s.label}>노드 현황</Text></View>{state.nodes.map(n => <Pressable accessibilityRole="button" accessibilityLabel={`노드 ${n.id} 상세 보기`} key={n.id} onPress={() => chooseNode(n.id)} style={s.nodeRow}><View style={s.row}><Text style={s.subheading}>노드 {n.id}</Text><Tag warning={!n.online || !n.active}>{!n.online ? '연결 안 됨' : n.active ? '연결됨' : '분리됨'}</Tag></View><View style={[s.nodeValues, !wide && { flexBasis: '100%' }]}><Text style={s.body}>블록 {n.height ?? '—'}개</Text><Text style={s.body}>피어 {n.peers?.length ?? '—'}개</Text><Text style={s.body}>미확정 {n.mempool?.length ?? '—'}건</Text><Text style={s.balanceSmall}>{money(n.balance)}</Text></View></Pressable>)}</View>
        <View style={[s.card, { width: '100%' }]}><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.actionRow}><Button title={ready ? '준비 상태 다시 확인' : '테스트 시작'} disabled={busy} onPress={() => ask('bootstrap')} />{ready && <Button title="코인 보내기" onPress={() => chooseNode('A')} />}<Button title="전체 데이터 삭제" danger disabled={busy} onPress={() => ask('reset')} /></ScrollView></View>
      </>}
      {tab === 'node' && <>
        <View style={s.section}><Text style={s.heading}>코인 보내기</Text></View>{admin && <View style={s.row}>{['A','B','C'].map(n => <Button key={n} title={`노드 ${n}`} secondary={selected !== n} onPress={() => chooseNode(n)} />)}</View>}
        <View style={[s.row, s.column]}><View style={[s.card, s.stackCard]}><Text style={s.subheading}>잔액</Text><Text style={s.metric}>{money(node?.balance)}</Text>{admin && <Button title="블록 1개 생성 · 거래 확정" disabled={busy || !node?.online || !ready} onPress={() => ask('mine', { node: selected, count: 1 })} />}{admin && <Pressable accessibilityRole="button" onPress={() => setTechnical(!technical)}><Text style={s.link}>{technical ? '접기' : '블록 해시와 피어 상세 보기'}</Text></Pressable>}{admin && technical && <View style={s.section}><Text style={s.label}>마지막 블록 해시</Text><Text selectable style={s.mono}>{node?.hash}</Text><Text style={s.label}>누적 작업량</Text><Text selectable style={s.mono}>{node?.chainwork}</Text>{node?.peers?.map((p,i) => <Text key={i} style={s.body}>{p.address} · {p.inbound ? '수신 연결' : '발신 연결'}</Text>)}</View>}</View>
        <View style={[s.card, s.stackCard]}><Text style={s.label}>수신자 지정</Text><View style={s.row}>{['A','B','C'].filter(n => n !== selected).map(n => <Button key={n} title={`노드 ${n}`} secondary={to !== n} onPress={() => setTo(current => current === n ? '' : n)} />)}</View>{!!to && <Text selectable style={s.mono}>수신 지갑 주소: {state?.recipientAddresses?.[to] || '불러오는 중'}</Text>}<Text style={s.label}>보낼 BTC</Text><Field accessibilityLabel="보낼 BTC" keyboardType="decimal-pad" value={amount} onChangeText={setAmount} /><Text style={s.label}>신뢰된 송금 의도 ID (로컬 터미널에서 생성)</Text><Field accessibilityLabel="송금 의도 ID" value={intentId} onChangeText={setIntentId} placeholder="32자리 의도 ID" /><Text style={s.caption}>먼저 로컬 터미널에서 node server/prepare-intent.mjs A B 1 실행. 송신 노드·수신 노드·금액을 현재 선택과 일치시키세요. 수수료 1 sat/vB</Text><Button title={sending ? '송금 요청 중…' : '송금하기'} disabled={busy || !node?.online || node?.balance == null || !to || !state?.recipientAddresses?.[to] || !/^[a-f0-9]{32}$/.test(intentId.trim()) || to === selected || !(Number(amount) >= 0.00001 && Number(amount) <= 10)} onPress={sendTransfer} /></View></View>
      </>}
      {tab === 'admin' && <><View style={s.section}><Text style={s.heading}>관리자</Text></View><View style={[s.card, s.stackCard]}><View style={s.row}>{['A','B','C'].map(n => <Button key={n} title={`노드 ${n}`} secondary={fundTarget !== n} onPress={() => setFundTarget(current => current === n ? '' : n)} />)}</View><View style={s.row}><Button title="10 BTC 추가" disabled={busy || !fundTarget} onPress={() => ask('fund', { node: fundTarget })} /><Button title="잔액 몰수" danger disabled={busy || !fundTarget} onPress={() => ask('zero', { node: fundTarget })} /></View></View></>}
      {tab === 'experiments' && <><View style={s.section}><Text style={s.heading}>보안 실험</Text><Text style={s.body}>처음에는 네트워크 분리부터 하나씩 진행하세요. 완료 후 결과 확인에서 검증 증거를 볼 수 있습니다.</Text></View>{!ready && <View style={s.note}><Text style={s.body}>먼저 실습 준비에서 지갑과 코인을 준비하세요.</Text></View>}<View style={s.table}>{state.scenarios.map((scenario,i) => <View key={scenario.id} style={[s.experimentRow, !wide && s.column]}><Text style={s.listNumber}>{i+1}.</Text><View style={{ flex: 1, gap: 8 }}><View style={s.row}><Text style={s.subheading}>{scenario.title}</Text><Tag warning={scenario.level.includes('상')}>난이도 {scenario.level}</Tag></View><Text style={s.body}>{scenario.detail}</Text></View><Button title="실험하기" secondary disabled={busy || !ready} onPress={() => ask('experiment', { scenario: scenario.id })} /></View>)}</View><Text style={s.caption}>포크 실험 후에는 우세 체인으로 다시 연결합니다. 51%는 원리 시연이며 대규모 공격 성능은 측정하지 않습니다.</Text></>}
      {tab === 'history' && <><View style={s.section}><Text style={s.heading}>거래내역 확인</Text></View>{!state.history.length && <Text style={s.body}>거래내역이 없습니다</Text>}<View style={s.table}>{state.history.map(r => <Pressable accessibilityRole="button" key={r.id} onPress={() => setDetail(r)} style={s.historyRow}><View style={s.spread}><Text style={s.subheading}>{names[r.kind] || r.kind}</Text><Tag warning={r.status !== 'passed'}>{r.status === 'passed' ? '완료' : '실패'}</Tag></View><Text style={s.caption}>{new Date(r.startedAt).toLocaleString('ko-KR')} · {historySummary(r)}</Text><Text style={s.body}>{r.error || (r.kind === 'send' ? (r.status === 'passed' ? '송금 완료' : '송금 실패') : (r.status === 'passed' ? '처리 완료' : '처리 실패'))}</Text></Pressable>)}</View></>}
      <Modal visible={!!detail} transparent animationType="fade" onRequestClose={() => setDetail(null)}><View style={s.overlay}><View style={s.dialog}><ScrollView contentContainerStyle={s.card}><View style={[s.spread, { justifyContent: 'flex-end' }]}><Button title="닫기" secondary onPress={() => setDetail(null)} /></View><Text selectable style={s.mono}>{JSON.stringify(detail, null, 2)}</Text></ScrollView></View></View></Modal>
    </>}
    <Modal visible={!!pending} transparent animationType="fade" onRequestClose={() => { if (!sending) setPending(null); }}><View style={s.overlay}><View style={s.dialog}><ScrollView contentContainerStyle={s.card} keyboardShouldPersistTaps="handled"><Text style={s.heading}>{pendingTitle}</Text><Text style={s.body}>{pendingText}</Text>{!!error && <Text accessibilityRole="alert" style={{ color: palette.orange }}>{error}</Text>}<View style={s.row}><Button title={sending ? '요청 중…' : pending?.action === 'reset' ? '삭제하고 초기화' : '확인'} danger={pending?.action === 'reset'} onPress={execute} disabled={sending} /><Button title="취소" secondary onPress={() => setPending(null)} disabled={sending} /></View></ScrollView></View></View></Modal>
    {!!error && !pending && <View accessibilityRole="alert" style={s.banner}><Text style={{ color: palette.orange }}>{error}</Text></View>}
  </ScrollView></View>;
}
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.bg }, page: { padding: 36, maxWidth: 1180, width: '100%', alignSelf: 'center', gap: 24 }, mobilePage: { width: '100%', maxWidth: '100%', alignSelf: 'stretch', paddingHorizontal: 16, paddingVertical: 18 }, mobileCard: { width: '100%', alignSelf: 'stretch', flexBasis: 'auto', flexGrow: 0 }, stackCard: { width: '100%', alignSelf: 'stretch', flexGrow: 0, flexShrink: 1, flexBasis: 'auto' },
  overlay: { flex: 1, backgroundColor: '#18212d66', alignItems: 'center', justifyContent: 'center', padding: 18 }, dialog: { width: '100%', maxWidth: 640, maxHeight: '85%' },
  header: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 20, paddingBottom: 20 },
  title: { color: palette.text, fontSize: 20, fontWeight: '700', marginBottom: 3 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 12 }, mark: { width: 34, height: 38, backgroundColor: '#e9e1d5', borderRadius: 4, alignItems: 'center', justifyContent: 'center' }, markText: { color: '#885e27', fontSize: 26, fontWeight: '600' },
  tag: { color: '#4d6f5c', fontSize: 12, lineHeight: 22 },
  card: { backgroundColor: palette.panel, padding: 24, borderRadius: 5, borderWidth: 1, borderColor: palette.border, gap: 16, minWidth: 0 },
  heading: { color: palette.text, fontSize: 22, fontWeight: '600', lineHeight: 32 }, subheading: { color: palette.text, fontSize: 15, fontWeight: '600', lineHeight: 23 }, body: { color: palette.muted, fontSize: 14, lineHeight: 24 }, caption: { color: palette.muted, fontSize: 12, lineHeight: 20 }, label: { color: palette.text, fontSize: 13, marginTop: 4 },
  mono: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', color: '#566373', fontSize: 11, lineHeight: 19, ...(Platform.OS === 'web' ? { overflowWrap: 'anywhere' } : {}) },
  input: { borderWidth: 1, borderColor: '#cbd1d8', borderRadius: 4, backgroundColor: '#fff', color: palette.text, padding: 13, fontSize: 15, minHeight: 46 },
  button: { backgroundColor: palette.green, paddingVertical: 12, paddingHorizontal: 17, borderRadius: 4, alignItems: 'center', justifyContent: 'center', minHeight: 44 }, buttonText: { color: '#fff', fontWeight: '500', fontSize: 14 }, secondary: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#cfd5dd' }, danger: { backgroundColor: '#a33f3f' },
  nav: { borderBottomWidth: 1, borderColor: palette.border }, navContent: { flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }, navLogout: { marginLeft: 'auto', paddingLeft: 14, paddingBottom: 4 }, navItem: { padding: 14, minHeight: 46 }, navActive: { borderBottomWidth: 2, borderColor: palette.green },
  row: { flexDirection: 'row', gap: 14, flexWrap: 'wrap', alignItems: 'center' }, actionRow: { flexDirection: 'row', gap: 14, alignItems: 'center' }, column: { flexDirection: 'column', alignItems: 'stretch', width: '100%' }, spread: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }, section: { gap: 8, marginTop: 4 }, metric: { color: palette.text, fontSize: 27, fontWeight: '500', fontVariant: ['tabular-nums'] }, banner: { padding: 18, backgroundColor: '#fffaf0', borderColor: '#e6d8b3', borderWidth: 1, borderRadius: 4, gap: 8 }, footer: { borderTopWidth: 1, borderColor: palette.border, paddingTop: 24, flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 },
  table: { backgroundColor: '#fff', borderWidth: 1, borderColor: palette.border, borderRadius: 5, overflow: 'hidden' }, tableHeading: { paddingHorizontal: 22, paddingVertical: 14, flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, backgroundColor: '#fafbfc' }, nodeRow: { borderTopWidth: 1, borderColor: '#e9ebee', paddingHorizontal: 22, paddingVertical: 20, flexDirection: 'row', alignItems: 'center', gap: 16, flexWrap: 'wrap' }, nodeValues: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap', gap: 22 }, balanceSmall: { color: palette.text, fontSize: 14, fontWeight: '500', minWidth: 140, textAlign: 'right', fontVariant: ['tabular-nums'] }, tableFoot: { borderTopWidth: 1, borderColor: '#e9ebee', padding: 18 }, note: { backgroundColor: '#f2f4f7', borderLeftWidth: 2, borderColor: '#9cabbc', padding: 15 }, link: { color: palette.green, fontSize: 13, paddingVertical: 10 }, experimentRow: { padding: 22, borderTopWidth: 1, borderColor: '#e9ebee', flexDirection: 'row', gap: 20, alignItems: 'center' }, listNumber: { color: '#929ca7', fontSize: 13, width: 22 }, historyRow: { borderTopWidth: 1, borderColor: '#e9ebee', padding: 22, gap: 8 }
});
