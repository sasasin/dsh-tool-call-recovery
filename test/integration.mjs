import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const project = fileURLToPath(new URL('..', import.meta.url));
const plugin = process.env.DSH_RECOVERY_PLUGIN_DIR ? resolve(process.env.DSH_RECOVERY_PLUGIN_DIR) : project;
const resultsDir = resolve(project, 'test-results/integration');
await mkdir(resultsDir, { recursive: true });
const summaries = [];

for (const scenario of ['disabled', 'recover', 'quoted', 'exhausted', 'intermittent', 'turn-limit', 'failed-execution']) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-recovery-integration-'));
  const home = join(root, 'home');
  const cwd = join(root, 'work');
  const profile = join(home, 'profiles/headless');
  await mkdir(join(profile, 'node_modules'), { recursive: true });
  await mkdir(cwd);
  const expected = `RECOVERY_${randomUUID()}`;
  const sentinel = join(cwd, 'sentinel.txt');
  await writeFile(sentinel, expected + '\n');
  const sentinels = [sentinel, join(cwd, 'sentinel-2.txt'), join(cwd, 'sentinel-3.txt')];
  for (const path of sentinels.slice(1)) await writeFile(path, expected + '\n');
  const xmlFor = path => `<tool_call>\n<function=read>\n<parameter=file_path>\n${path}\n</parameter>\n</function>\n</tool_call>`;
  const xml = xmlFor(sentinel);
  const intermittent = ['intermittent', 'turn-limit', 'failed-execution'].includes(scenario);
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body);
      if (!data.tools?.some(tool => tool.function?.name === 'run_code')) throw new Error('PTC の公開スキーマがない');
      requests.push(data);
      const turn = requests.length;
      let delta;
      let finish = 'stop';
      if ((scenario === 'recover' && turn === 2) || (intermittent && turn % 2 === 0)) {
        assert.match(JSON.stringify(data.messages.at(-1)), /実行されていません/);
        const code = scenario === 'failed-execution' ? 'throw new Error("test execution failure")'
          : `return await tools.read({file_path: ${JSON.stringify(sentinels[Math.floor((turn - 1) / 2)])}})`;
        delta = { tool_calls: [{ index: 0, id: 'read-through-ptc-' + turn, type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ description: 'Read the test sentinel', code }) } }] };
        finish = 'tool_calls';
      } else if ((scenario === 'recover' && turn === 3) || (scenario === 'intermittent' && turn === 7)) {
        assert.ok(data.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes(expected)), '本物の read の結果が次のモデル入力に入る');
        delta = { content: expected };
      } else {
        delta = { content: scenario === 'quoted' ? '```xml\n' + xml + '\n```' : intermittent ? xmlFor(sentinels[Math.floor((turn - 1) / 2)]) : xml };
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const base = { id: 'test-' + turn, object: 'chat.completion.chunk', created: 1, model: 'recovery-test' };
      for (const [piece, reason] of [[{ role: 'assistant', ...delta }, null], [{}, finish]]) {
        res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: piece, finish_reason: reason }] }) + '\n\n');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message, type: 'test_failure' } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-headless', private: true,
    dependencies: { 'dsh-tool-call-recovery': `link:${plugin}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'dsh-tool-call-recovery'] } } }));
  await writeFile(join(profile, 'cordis.yml'), '[]\n');
  await writeFile(join(profile, 'cordis.patch.yml'), `- id: tool-call-recovery\n  config:\n    enabled: ${scenario !== 'disabled'}\n` + (scenario === 'turn-limit' ? '    maxRecoveriesPerTurn: 2\n' : ''));
  await symlink(plugin, join(profile, 'node_modules/dsh-tool-call-recovery'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(home, 'cordis.patch.yml'), `- id: llm-pi-ai
  config:
    providers:
      local-provider:
        api: openai-completions
        baseURL: http://127.0.0.1:${port}/v1/
        apiKeyEnv: LOCAL_PROVIDER_API_KEY
        models:
          - id: recovery-test
            contextWindow: 65536
            maxTokens: 1024
- id: agent-default-model
  config:
    provider: local-provider
    model: recovery-test
- id: tool-executor-native
  disabled: true
- id: tool-executor-ptc
  disabled: false
- id: tool-web
  disabled: true
`);
  let stdout = ''; let stderr = '';
  const child = spawn('dsh', ['headless', '--permission-mode', 'read-only', '--approval-policy', 'never', '--json', 'Read the sentinel and report its contents.'],
    { cwd, env: { ...process.env, DSH_HOME: home, LOCAL_PROVIDER_API_KEY: 'local-test-placeholder' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => stdout += bytes);
  child.stderr.on('data', bytes => stderr += bytes);
  const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  await new Promise(resolve => server.close(resolve));
  const events = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const final = events.find(event => event.type === 'final');
  if (scenario === 'recover' || scenario === 'intermittent') {
    assert.equal(code, 0, stderr);
    assert.equal(requests.length, scenario === 'recover' ? 3 : 7);
    assert.equal(final.text, expected);
    assert.deepEqual(events.filter(event => event.type === 'tool_call').map(event => event.tool), Array(scenario === 'recover' ? 1 : 3).fill('run_code'));
    assert.equal(events.filter(event => event.type === 'tool_result' && event.status === 'completed').length, scenario === 'recover' ? 1 : 3);
  } else if (scenario === 'turn-limit' || scenario === 'failed-execution') {
    assert.equal(requests.length, 5, stderr);
    assert.equal(code, 1);
    assert.equal(final.reason.kind, 'error');
    assert.match(JSON.stringify(events) + stderr, scenario === 'turn-limit' ? /ターン全体の上限 2 回/ : /連続 2 回/);
  } else if (scenario === 'exhausted') {
    assert.equal(requests.length, 3, stderr);
    assert.equal(code, 1);
    assert.equal(final.reason.kind, 'error');
    assert.match(JSON.stringify(events) + stderr, /修正できませんでした/);
  } else {
    assert.equal(code, 0, stderr);
    assert.equal(requests.length, 1);
    assert.match(final.text, /<tool_call>/);
  }
  assert.equal(await readFile(sentinel, 'utf8'), expected + '\n');
  for (const path of sentinels.slice(1)) assert.equal(await readFile(path, 'utf8'), expected + '\n');
  const summary = { scenario, passed: true, modelRequests: requests.length, exitCode: code, finalReason: final.reason.kind, root };
  summaries.push(summary);
  await writeFile(join(resultsDir, `${scenario}.json`), JSON.stringify({ summary, events, stderr }, null, 2) + '\n');
  console.log(JSON.stringify(summary));
}
await writeFile(join(resultsDir, 'summary.json'), JSON.stringify(summaries, null, 2) + '\n');
