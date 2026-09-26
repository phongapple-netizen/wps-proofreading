const test = require('node:test');
const assert = require('node:assert/strict');
const client = require('../js/opencode-client.js');

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    }
  };
}

test('health check uses the normalized endpoint and returns safe status fields', async () => {
  const calls = [];
  const health = await client.checkHealth(
    { endpoint: 'http://127.0.0.1:4096///' },
    async (url, init) => {
      calls.push({ url, init });
      return response(200, { healthy: true, version: '1.2.3', secret: 'never-return' });
    }
  );

  assert.equal(calls[0].url, 'http://127.0.0.1:4096/global/health');
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(health, { ok: true, healthy: true, status: 200, version: '1.2.3' });
  assert.equal(JSON.stringify(health).includes('never-return'), false);
});

test('model enumeration supports provider arrays, provider objects, model arrays and default selection', async () => {
  const result = await client.fetchModels(
    { endpoint: 'http://127.0.0.1:4096' },
    async () => response(200, {
      providers: [
        {
          id: 'openai',
          models: {
            'gpt-4o': { id: 'gpt-4o' },
            'vendor/model/v2': {}
          }
        },
        { id: 'local', models: [{ id: 'qwen3' }, { id: 'qwen3-thinking', default: true }] }
      ],
      default: { local: 'qwen3-thinking' }
    })
  );

  assert.deepEqual(result.models, [
    'local/qwen3',
    'local/qwen3-thinking',
    'openai/gpt-4o',
    'openai/vendor/model/v2'
  ]);
  assert.equal(result.defaultModel, 'local/qwen3-thinking');
  assert.equal(result.default, result.defaultModel);

  const objectResult = await client.fetchModels(
    {},
    async () => response(200, {
      providers: {
        anthropic: { models: { 'claude/model/long-id': {} } }
      },
      default: 'anthropic/claude/model/long-id'
    })
  );
  assert.deepEqual(objectResult.models, ['anthropic/claude/model/long-id']);
  assert.equal(objectResult.defaultModel, 'anthropic/claude/model/long-id');
});

test('Basic auth is only sent as a header and model IDs split at the first slash', async () => {
  const calls = [];
  const secret = 'dont-put-this-anywhere-else';
  const result = await client.request(
    {
      endpoint: 'http://127.0.0.1:4096/',
      model: 'provider/model/with/more/slashes',
      serverPassword: secret
    },
    '请校对这段文字。',
    async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/session')) return response(201, { id: 'session-1' });
      if (url.endsWith('/message')) return response(200, {
        parts: [
          { type: 'reasoning', text: '内部内容不应拼接' },
          { type: 'text', text: '{"issues":[' },
          { type: 'text', text: ']} ' }
        ]
      });
      return response(204, null);
    }
  );

  assert.equal(result, '{"issues":[]} ');
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.url.includes(secret), false);
    assert.equal(String(call.init.body || '').includes(secret), false);
    assert.equal(call.init.headers.Authorization, `Basic ${Buffer.from(`opencode:${secret}`).toString('base64')}`);
  }
  const message = JSON.parse(calls[1].init.body);
  assert.deepEqual(message.model, {
    providerID: 'provider',
    modelID: 'model/with/more/slashes'
  });
  assert.equal(message.agent, 'wps-proofreader');
  assert.deepEqual(message.tools, { '*': false });
  assert.deepEqual(message.parts, [{ type: 'text', text: '请校对这段文字。' }]);
  assert.equal(calls[2].init.method, 'DELETE');
});

test('successful requests delete the temporary session without aborting it', async () => {
  const paths = [];
  await client.request({ model: 'local/qwen' }, 'prompt', async (url, init) => {
    paths.push(`${init.method} ${new URL(url).pathname}`);
    if (init.method === 'POST' && url.endsWith('/session')) return response(200, { id: 'ok-session' });
    if (url.endsWith('/message')) return response(200, { parts: [{ type: 'text', text: 'done' }] });
    return response(204, null);
  });

  assert.deepEqual(paths, [
    'POST /session',
    'POST /session/ok-session/message',
    'DELETE /session/ok-session'
  ]);
});

test('a stalled session cleanup cannot block a completed proofreading result', async () => {
  const started = Date.now();
  const result = await client.request({ model: 'local/qwen' }, 'prompt', async (url, init) => {
    if (init.method === 'DELETE') return new Promise(() => {});
    if (url.endsWith('/session')) return response(200, { id: 'stalled-cleanup' });
    return response(200, { parts: [{ type: 'text', text: '{"issues":[]}' }] });
  });
  assert.equal(result, '{"issues":[]}');
  assert.equal(Date.now() - started < 5000, true);
});

test('failed requests best-effort abort and then delete the temporary session', async () => {
  const paths = [];
  await assert.rejects(
    client.request({ model: 'local/qwen' }, 'prompt', async (url, init) => {
      paths.push(`${init.method} ${new URL(url).pathname}`);
      if (init.method === 'POST' && url.endsWith('/session')) return response(200, { id: 'failed-session' });
      if (url.endsWith('/message')) return response(500, { error: 'secret response body must stay hidden' });
      return response(204, null);
    }),
    (error) => error.code === 'HTTP_ERROR' && !error.message.includes('secret')
  );

  assert.deepEqual(paths, [
    'POST /session',
    'POST /session/failed-session/message',
    'POST /session/failed-session/abort',
    'DELETE /session/failed-session'
  ]);
});

test('cancellation returns a safe Chinese error and still cleans up after a created session', async () => {
  const controller = new AbortController();
  const paths = [];
  await assert.rejects(
    client.request({ model: 'local/qwen', signal: controller.signal }, 'prompt', async (url, init) => {
      paths.push(`${init.method} ${new URL(url).pathname}`);
      if (init.method === 'POST' && url.endsWith('/session')) return response(200, { id: 'cancelled-session' });
      controller.abort();
      const error = new Error('secret should not leak');
      error.name = 'AbortError';
      throw error;
    }),
    (error) => error.code === 'ABORTED' && error.message === '请求已取消。' && !error.message.includes('secret')
  );
  assert.deepEqual(paths, [
    'POST /session',
    'POST /session/cancelled-session/message',
    'POST /session/cancelled-session/abort',
    'DELETE /session/cancelled-session'
  ]);
});

test('invalid endpoint and model errors never echo a password', async () => {
  assert.throws(
    () => client.normalizeEndpoint('ftp://127.0.0.1:4096?password=top-secret'),
    (error) => error.code === 'INVALID_ENDPOINT' && !error.message.includes('top-secret')
  );
  assert.throws(
    () => client.parseModelName('provider/   '),
    (error) => error.code === 'INVALID_MODEL'
  );
});
