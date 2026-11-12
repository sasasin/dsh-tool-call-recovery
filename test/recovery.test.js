import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectToolCallText } from '../detector.js';
import { createRecoveryHandler, parseConfig, SOURCE, ToolCallRecoveryExhausted } from '../index.js';

const xml = (name = 'read') => `<tool_call>\n<function=${name}>\n<parameter=file_path>\nsentinel.txt\n</parameter>\n</function>\n</tool_call>`;
const assistant = (id, text = xml(), extra = []) => ({ id, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }, ...extra] });
function fixture(publicNames = ['run_code']) {
  const messages = [assistant('a')];
  const notices = [];
  const agent = { session: { requestHeader: () => ({ tools: publicNames.map(name => ({ name })) }), deriveMessages: () => messages },
    steer: message => { notices.push(message); messages.push(message); } };
  return { agent, messages, notices, payload: { agent, turn: 1, signal: new AbortController().signal } };
}

test('今回の XML と外側の閉じタグが欠けた XML を検知する', () => {
  assert.deepEqual(detectToolCallText(xml()), ['read']);
  assert.deepEqual(detectToolCallText(xml().replace('\n</tool_call>', '')), ['read']);
  assert.deepEqual(detectToolCallText('ファイルを読みます。\n\n' + xml()), ['read']);
  assert.deepEqual(detectToolCallText(xml() + '\n' + xml('bash')), ['read', 'bash']);
});

test('引用・コード・説明用の例・通常の文章では再試行しない', () => {
  for (const text of ['```xml\n' + xml() + '\n```', '~~~\n' + xml() + '\n~~~',
    xml().split('\n').map(line => '> ' + line).join('\n'),
    xml().split('\n').map(line => '    ' + line).join('\n'),
    '例:\n' + xml(), 'Example:\n' + xml(), xml() + '\nこれが呼び出し形式の例です。',
    '`' + xml().replaceAll('\n', ' ') + '`', '作業が完了しました。', '<tool_call><function=read>未完の値']) {
    assert.deepEqual(detectToolCallText(text), [], text);
  }
});

test('コードフェンス終了後の本物の末尾ブロックは検知する', () => {
  assert.deepEqual(detectToolCallText('```\n' + xml('write') + '\n```\n' + xml()), ['read']);
});

test('再試行は正式な通知として記録され、同じ応答には重複しない', () => {
  const f = fixture(); const handler = createRecoveryHandler();
  handler(f.payload); handler(f.payload);
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].source.kind, SOURCE);
  assert.equal(f.notices[0].source.targetMessageId, 'a');
  assert.match(f.notices[0].content[0].text, /run_code/);
  assert.match(f.notices[0].content[0].text, /実行されていません/);
});

test('再試行上限で未完了のエラーにし、無限ループを防ぐ', () => {
  const f = fixture(); const handler = createRecoveryHandler({ maxRetries: 2 });
  handler(f.payload); f.messages.push(assistant('b')); handler(f.payload);
  f.messages.push(assistant('c'));
  assert.throws(() => handler(f.payload), ToolCallRecoveryExhausted);
  assert.equal(f.notices.length, 2);
});

test('プラグインを再生成しても履歴の再試行回数を引き継ぐ', () => {
  const f = fixture(); createRecoveryHandler({ maxRetries: 1 })(f.payload);
  f.messages.push(assistant('b'));
  assert.throws(() => createRecoveryHandler({ maxRetries: 1 })(f.payload), ToolCallRecoveryExhausted);
});

test('次のターンでは再試行回数をリセットする', () => {
  const f = fixture(); const handler = createRecoveryHandler({ maxRetries: 1 });
  handler(f.payload); f.messages.push(assistant('b'));
  handler({ ...f.payload, turn: 2 });
  assert.equal(f.notices.length, 2);
  assert.equal(f.notices[1].source.attempt, 1);
});

test('復旧して作業が進んだ後の別の誤出力は、新しい連続失敗として数える', () => {
  const f = fixture(); const handler = createRecoveryHandler({ maxRetries: 2 });
  for (let i = 0; i < 3; i++) {
    if (i) f.messages.push(assistant('incident-' + i));
    handler(f.payload);
    assert.equal(f.notices.at(-1).source.attempt, 1);
    assert.equal(f.notices.at(-1).source.totalAttempt, i + 1);
    f.messages.push({ id: 'success-' + i, role: 'tool', content: [], isError: false });
  }
  assert.equal(f.notices.length, 3);
});

test('正式な呼び出しでも実行失敗の場合は連続失敗をリセットしない', () => {
  const f = fixture(); const handler = createRecoveryHandler({ maxRetries: 1 });
  handler(f.payload);
  f.messages.push({ id: 'error', role: 'tool', content: [], isError: true }, assistant('b'));
  assert.throws(() => handler(f.payload), ToolCallRecoveryExhausted);
});

test('進捗を挟んでもターン全体の上限は別に適用する', () => {
  const f = fixture(); const handler = createRecoveryHandler({ maxRecoveriesPerTurn: 2 });
  handler(f.payload);
  f.messages.push({ id: 'success-1', role: 'tool', content: [] }, assistant('b'));
  handler(f.payload);
  f.messages.push({ id: 'success-2', role: 'tool', content: [] }, assistant('c'));
  assert.throws(() => handler(f.payload), /ターン全体の上限 2 回/);
});

test('旧形式の通知の後に成功があれば、再読み込み後も連続失敗はゼロから始まる', () => {
  const f = fixture();
  f.messages.unshift({ id: 'old-notice', role: 'user', content: [], source: { kind: SOURCE, turn: 1, attempt: 2, targetMessageId: 'old' } },
    { id: 'old-success', role: 'tool', content: [], isError: false });
  createRecoveryHandler({ maxRetries: 1 })(f.payload);
  assert.equal(f.notices[0].source.attempt, 1);
  assert.equal(f.notices[0].source.totalAttempt, 2);
});

test('正式な呼び出し・混在応答・中断・無効・native は既定で対象外', () => {
  for (const mode of ['mixed', 'aborted', 'disabled', 'native']) {
    const f = fixture(mode === 'native' ? ['read'] : ['run_code']);
    if (mode === 'mixed') f.messages[0].content.push({ type: 'tool-call', name: 'run_code', id: 'call', arguments: '{}' });
    if (mode === 'aborted') f.payload.signal = AbortSignal.abort();
    createRecoveryHandler(mode === 'disabled' ? { enabled: false } : {})(f.payload);
    assert.equal(f.notices.length, 0, mode);
  }
});

test('native への適用は明示設定で可能', () => {
  const f = fixture(['read']); createRecoveryHandler({ ptcOnly: false })(f.payload);
  assert.equal(f.notices.length, 1);
});

test('長すぎる本文と不正な設定を拒否する', () => {
  assert.deepEqual(detectToolCallText('x'.repeat(66000) + '\n' + xml()), []);
  for (const cfg of [{ maxRetries: -1 }, { maxRetries: 1.2 }, { enabled: 'yes' }, { typo: 1 }, { toString: 1 }]) assert.throws(() => parseConfig(cfg));
});
