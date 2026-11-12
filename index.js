import { randomUUID } from 'node:crypto';
import { detectToolCallText } from './detector.js';

export const name = 'tool-call-recovery';
export const inject = [];
export const SOURCE = 'tool-call-recovery';

export function parseConfig(input = {}) {
  const defaults = { enabled: true, ptcOnly: true, maxRetries: 2, maxRecoveriesPerTurn: 20, maxTextChars: 65536 };
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(defaults, key)) throw new TypeError(`tool-call-recovery: unknown config ${key}`);
  }
  const config = { ...defaults, ...input };
  for (const key of ['enabled', 'ptcOnly']) {
    if (typeof config[key] !== 'boolean') throw new TypeError(`${key} must be boolean`);
  }
  for (const [key, min, max] of [['maxRetries', 0, 10], ['maxRecoveriesPerTurn', 1, 1000], ['maxTextChars', 1024, 1048576]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new TypeError(`${key} must be an integer in ${min}..${max}`);
  }
  return Object.freeze(config);
}

export class ToolCallRecoveryExhausted extends Error {
  constructor(limit, scope = 'consecutive') {
    super(scope === 'turn'
      ? `本文のツール呼び出しに対する補正がターン全体の上限 ${limit} 回に達しました。処理は未完了です。`
      : `正常なツール実行を挟まず、本文のツール呼び出しを連続 ${limit} 回の再試行で修正できませんでした。処理は未完了です。`);
    this.name = 'ToolCallRecoveryExhausted';
    this.code = 'TOOL_CALL_RECOVERY_EXHAUSTED';
  }
}

/** Count a failure streak separately from the whole-turn safety budget. Older notices need no migration. */
export function recoveryHistory(messages, turn) {
  let retries = 0;
  let total = 0;
  const handled = new Set();
  for (const message of messages) {
    if (message.role === 'tool' && !message.isError) retries = 0;
    if (message.source?.kind === SOURCE && message.source.turn === turn) {
      retries++;
      total++;
      handled.add(message.source.targetMessageId);
    }
  }
  return { retries, total, handled };
}

/** The stop-boundary listener is exported so policy can be tested without a model. */
export function createRecoveryHandler(input) {
  const config = parseConfig(input);
  const states = new WeakMap();
  return ({ agent, turn, signal }) => {
    if (!config.enabled || signal.aborted) return;
    const header = agent.session.requestHeader();
    const publicNames = (header?.tools ?? []).map(tool => tool.name);
    const ptc = publicNames.length === 1 && publicNames[0] === 'run_code';
    if (!publicNames.length || (config.ptcOnly && !ptc)) return;

    const messages = agent.session.deriveMessages();
    const message = messages.findLast(item => item.role === 'assistant');
    // Never replay a mixed response: some of its operations may already have run.
    if (!message || message.content.some(block => block.type === 'tool-call')) return;
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    const names = detectToolCallText(text, config);
    if (!names.length) return;

    const history = recoveryHistory(messages, turn);
    const previous = states.get(agent);
    const state = { turn, ...history };
    // Keep duplicate protection while a just-queued notice has not reached deriveMessages yet.
    if (previous?.turn === turn) for (const id of previous.handled) state.handled.add(id);
    states.set(agent, state);
    if (state.handled.has(message.id)) return;
    state.handled.add(message.id);
    if (state.retries >= config.maxRetries) throw new ToolCallRecoveryExhausted(config.maxRetries);
    if (state.total >= config.maxRecoveriesPerTurn) throw new ToolCallRecoveryExhausted(config.maxRecoveriesPerTurn, 'turn');
    state.retries++;
    state.total++;

    const guidance = ptc
      ? 'この PTC セッションで直接呼べるツールは run_code だけです。SDK のツールは run_code のプログラム内から await tools.name(args) の形で呼んでください。'
      : `直接呼べるツールは ${publicNames.join(', ')} です。公開された正式なツール呼び出しを使ってください。`;
    // An identified notice goes through steer, so both the retry and its cause are durable.
    const content = [Object.freeze({ type: 'text', text:
      `ツール呼び出しの形式を修正してください（連続再試行 ${state.retries}/${config.maxRetries}、ターン通算 ${state.total}/${config.maxRecoveriesPerTurn}）。直前の返答に含まれる ${names.join(', ')} の XML 風文字列は通常の本文であり、実行されていません。\n`
      + guidance + '\n'
      + '必要な処理を正式なツール呼び出しとして再生成し、結果を確認してから作業を続けてください。すでに成功した別の処理は繰り返さず、元の依頼・承認・権限制限を守ってください。'
    })];
    agent.steer(Object.freeze({
      id: randomUUID(), role: 'user', content: Object.freeze(content),
      source: Object.freeze({ kind: SOURCE, form: 'notice', summary: `本文のツール呼び出しを補正（連続 ${state.retries}/${config.maxRetries}、通算 ${state.total}/${config.maxRecoveriesPerTurn}）`,
        turn, attempt: state.retries, totalAttempt: state.total, targetMessageId: message.id, toolNames: Object.freeze(names) }),
    }));
  };
}

export function apply(ctx, config) {
  ctx.on('agent/turn-stopping', createRecoveryHandler(config));
}
