const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { createManager, discoverExecutable } = require('../scripts/opencode-manager');
const { createServer } = require('../scripts/dev-server');

function processStub() {
  const child = new EventEmitter();
  child.unref = () => {};
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('exit'); };
  return child;
}

test('discovery finds the user install without shell PATH and ignores directories', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wps-opencode-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const directory = path.join(home, '.opencode', 'bin');
  fs.mkdirSync(path.join(directory, 'opencode'), { recursive: true });
  // A PATH directory named opencode must never be spawned.
  const install = path.join(home, '.npm-global', 'bin');
  fs.mkdirSync(install, { recursive: true });
  const binary = path.join(install, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  fs.writeFileSync(binary, '', { mode: 0o700 });
  assert.equal(discoverExecutable({ PATH: directory }, home), binary);
});

test('a healthy existing service connects even without an installed CLI', async () => {
  const manager = createManager({ discover: () => null, probe: async () => ({ state: 'ready', version: 'test' }),
    spawn: () => { throw new Error('must not spawn'); } });
  assert.deepEqual(await manager.start(), { state: 'ready', version: 'test', found: true, managed: false });
});

test('missing installs and unrelated listeners never cause a process start', async () => {
  for (const [executable, health, expected] of [[null, 'absent', 'missing'], ['/bin/opencode', 'port_conflict', 'port_conflict']]) {
    const manager = createManager({ discover: () => executable, probe: async () => ({ state: health }),
      spawn: () => { throw new Error('must not spawn'); } });
    assert.equal((await manager.start()).state, expected);
  }
});

test('concurrent starts share one child, and an exited service can restart', async () => {
  let state = 'absent';
  const children = [];
  const manager = createManager({ discover: () => '/bin/opencode', probe: async () => ({ state, version: 'test' }),
    spawn: (command, args, options) => {
      assert.equal(command, '/bin/opencode');
      assert.deepEqual(args, ['serve', '--hostname', '127.0.0.1', '--port', '4096', '--cors', 'http://127.0.0.1:3891']);
      assert.equal(options.windowsHide, true);
      const child = processStub(); children.push(child); state = 'ready'; return child;
    } });
  const [first, second] = await Promise.all([manager.start(), manager.start()]);
  assert.equal(first.state, 'ready'); assert.equal(second.managed, true);
  assert.equal(children.length, 1);
  children[0].emit('exit'); state = 'absent';
  assert.equal((await manager.start()).state, 'ready');
  assert.equal(children.length, 2);
});

test('failed starts clean up only their child and allow a fresh retry', async () => {
  let ready = false;
  const children = [];
  const manager = createManager({ discover: () => '/bin/opencode', timeout: 5,
    probe: async () => ({ state: ready ? 'ready' : 'absent', version: 'test' }),
    pause: async () => new Promise((resolve) => setTimeout(resolve, 6)),
    spawn: () => { const child = processStub(); children.push(child); if (children.length > 1) ready = true; return child; } });
  assert.equal((await manager.start()).state, 'error');
  assert.equal(children[0].killed, true);
  assert.equal((await manager.start()).state, 'ready');
  assert.equal(children[1].killed, false);
});

test('spawn errors are handled and do not leave a managed process', async () => {
  const manager = createManager({ discover: () => '/bin/opencode', probe: async () => ({ state: 'absent' }),
    spawn: () => { const child = processStub(); queueMicrotask(() => child.emit('error', new Error('ENOENT'))); return child; } });
  const result = await manager.start();
  assert.equal(result.state, 'error'); assert.equal(result.managed, false);
  assert.match(result.detail, /提前退出/);
});

test('Node asset server exposes manager routes and rejects cross-origin starts', async (t) => {
  let starts = 0;
  const server = createServer({ port: 3891, manager: { status: async () => ({ state: 'stopped' }),
    start: async () => { starts++; return { state: 'ready' }; } } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  function fetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      const request = http.request(url, options, (response) => {
        let body = '';
        response.setEncoding('utf8'); response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, json: async () => JSON.parse(body) }));
      });
      request.on('error', reject); request.end();
    });
  }
  const headers = { Host: '127.0.0.1:3891' };
  assert.equal((await (await fetch(base + '/api/opencode/status', { headers })).json()).state, 'stopped');
  assert.equal((await fetch(base + '/api/opencode/start', { method: 'POST', headers })).status, 403);
  assert.equal((await fetch(base + '/api/opencode/start', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(base + '/api/opencode/start', { headers })).status, 405);
  assert.equal(starts, 0);
  const response = await fetch(base + '/api/opencode/start', { method: 'POST', headers: { ...headers, Origin: 'http://127.0.0.1:3891' } });
  assert.equal((await response.json()).state, 'ready'); assert.equal(starts, 1);
});
