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

test('request timings include session creation, message, cleanup and overlapping permission polls', async () => {
  const timing = {}, calls = [];
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const result = await client.request({ model: 'provider/model', password: 'private-secret', timing },
    'private-document-body', async (url, init) => {
      calls.push([url, init.method]);
      if (url.endsWith('/session')) { await delay(12); return response(201, protectedSession('timed-session')); }
      if (url.endsWith('/message')) { await delay(1150); return response(200, { parts: [{ type: 'text', text: '{"issues":[]}' }] }); }
      if (url.endsWith('/permission')) { await delay(12); return response(200, []); }
      if (init.method === 'DELETE') await delay(12);
      return response(204, null);
    });
  assert.equal(result, '{"issues":[]}');
  for (const field of ['createSessionMs', 'messageMs', 'cleanupMs', 'pollMs']) assert.ok(timing[field] >= 5, field);
  assert.equal(timing.pollCount, 1);
  assert.ok(Object.values(timing).every(value => typeof value === 'number'));
  assert.doesNotMatch(JSON.stringify(timing), /private|timed-session/);
  assert.equal(calls.filter(([url]) => url.endsWith('/permission')).length, 1);
  assert.equal(calls.some(([url, method]) => url.includes('/permission/') && method === 'POST'), false);
});

test('timed failed and cancelled OpenCode requests still clean up and HTTP 429 is recognizable', async () => {
  for (const cancelled of [false, true]) {
    const timing = {}, calls = [], controller = new AbortController();
    await assert.rejects(client.request({ model: 'provider/model', timing, signal: controller.signal },
      'private-document-body', async (url, init) => {
        calls.push(init.method + ' ' + url);
        if (url.endsWith('/session')) return response(201, protectedSession('timed-failure'));
        if (url.endsWith('/message')) {
          if (cancelled) controller.abort();
          return response(429, { secret: 'private-error' });
        }
        return response(204, null);
      }), error => error.code === (cancelled ? 'ABORTED' : 'MODEL_RATE_LIMITED'));
    assert.ok(calls.some(call => call.includes('/abort')));
    assert.ok(calls.some(call => call.startsWith('DELETE ')));
    for (const key of ['createSessionMs', 'messageMs', 'cleanupMs']) assert.ok(timing[key] >= 0);
  }
});

function protectedSession(id) {
  return { id, permission: [{ permission: '*', pattern: '*', action: 'ask' }] };
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

test('connection failures distinguish the service URL, CORS setting, and service password', async () => {
  await assert.rejects(
    client.checkHealth({ endpoint: 'http://127.0.0.1:4096' }, async () => { throw new TypeError('Failed to fetch'); }),
    (error) => error.code === 'NETWORK_ERROR' &&
      error.message.includes('global/health') && error.message.includes('opencode serve') &&
      error.message.includes('--cors http://127.0.0.1:3891')
  );
  await assert.rejects(
    client.checkHealth({ endpoint: 'http://127.0.0.1:4096', password: 'test-secret' }, async () => response(401, {})),
    (error) => error.code === 'HTTP_ERROR' && /服务密码/.test(error.message) &&
      !error.message.includes('test-secret')
  );
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
      if (url.endsWith('/session')) return response(201, protectedSession('session-1'));
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
  assert.equal(message.agent, 'build');
  assert.equal(Object.hasOwn(message, 'tools'), false);
  assert.match(message.system, /不要调用工具/);
  assert.deepEqual(JSON.parse(calls[0].init.body).permission, protectedSession('').permission);
  assert.deepEqual(message.parts, [{ type: 'text', text: '请校对这段文字。' }]);
  assert.equal(calls[2].init.method, 'DELETE');
});

test('parallel OpenCode requests use independent sessions and shared cancellation cleans both', async () => {
  const controller = new AbortController();
  const paths = [];
  let sessions = 0, messages = 0;
  const fetcher = async (url, init) => {
    paths.push(`${init.method} ${new URL(url).pathname}`);
    if (init.method === 'POST' && url.endsWith('/session')) return response(200, protectedSession(`parallel-${++sessions}`));
    if (url.endsWith('/permission')) return response(200, []);
    if (url.endsWith('/message')) {
      messages++;
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => {
        const error = new Error('cancelled'); error.name = 'AbortError'; reject(error);
      }, { once: true }));
    }
    return response(204, null);
  };
  const requests = [1, 2].map(() => client.request({ model: 'local/qwen', signal: controller.signal }, 'fixture', fetcher));
  const results = Promise.allSettled(requests);
  for (let i = 0; i < 100 && messages !== 2; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages, 2);
  controller.abort();
  assert.ok((await results).every(result => result.status === 'rejected'));
  for (const id of ['parallel-1', 'parallel-2']) {
    assert.ok(paths.includes(`POST /session/${id}/abort`));
    assert.ok(paths.includes(`DELETE /session/${id}`));
  }
});

test('successful requests delete the temporary session without aborting it', async () => {
  const paths = [];
  await client.request({ model: 'local/qwen' }, 'prompt', async (url, init) => {
    paths.push(`${init.method} ${new URL(url).pathname}`);
    if (init.method === 'POST' && url.endsWith('/session')) return response(200, protectedSession('ok-session'));
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
    if (url.endsWith('/session')) return response(200, protectedSession('stalled-cleanup'));
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
      if (init.method === 'POST' && url.endsWith('/session')) return response(200, protectedSession('failed-session'));
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

test('HTTP 200 with a free-tier rejection reports the model restriction and cleans up', async () => {
  const paths = [];
  await assert.rejects(
    client.request({ model: 'opencode/mimo-v2.6-flash-free' }, 'prompt', async (url, init) => {
      paths.push(`${init.method} ${new URL(url).pathname}`);
      if (init.method === 'POST' && url.endsWith('/session')) return response(200, protectedSession('restricted-session'));
      if (url.endsWith('/message')) return response(200, {
        info: {
          role: 'assistant',
          error: {
            name: 'APIError',
            data: {
              message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode",
              statusCode: 403,
              isRetryable: false,
              responseBody: 'private document and provider details',
              responseHeaders: { Authorization: 'Bearer secret-key' }
            }
          }
        },
        parts: []
      });
      return response(204, null);
    }),
    (error) => {
      assert.equal(error.code, 'MODEL_RESTRICTED');
      assert.match(error.message, /免费额度仅限 OpenCode 内使用/);
      assert.match(error.message, /HTTP 403/);
      assert.match(error.message, /代理或权限配置不兼容/);
      assert.doesNotMatch(error.message, /private|secret-key|没有返回文本/);
      return true;
    }
  );
  assert.deepEqual(paths, [
    'POST /session',
    'POST /session/restricted-session/message',
    'POST /session/restricted-session/abort',
    'DELETE /session/restricted-session'
  ]);
});

test('model failures override partial text and produce safe, actionable messages', async (t) => {
  const cases = [
    { name: 'APIError', statusCode: 401, code: 'MODEL_AUTH_ERROR', message: /服务端检查模型提供商的密钥/ },
    { name: 'APIError', statusCode: 403, code: 'MODEL_AUTH_ERROR', message: /没有调用权限/ },
    { name: 'ProviderAuthError', code: 'MODEL_AUTH_ERROR', message: /插件中的服务密码仅用于连接/ },
    { name: 'APIError', statusCode: 402, code: 'MODEL_QUOTA_ERROR', message: /额度不足/ },
    { name: 'APIError', statusCode: 429, code: 'MODEL_RATE_LIMITED', message: /稍后重试或切换模型/ },
    { name: 'APIError', statusCode: 503, code: 'MODEL_ERROR', message: /HTTP 503/ },
    { name: 'MessageAbortedError', code: 'MODEL_ABORTED', message: /请求已中止/ },
    { name: 'ContextOverflowError', code: 'MODEL_CONTEXT_OVERFLOW', message: /上下文容量/ },
    { name: 'MessageOutputLengthError', code: 'MODEL_OUTPUT_LIMIT', message: /输出达到长度上限/ },
    { name: 'ContentFilterError', code: 'MODEL_CONTENT_FILTERED', message: /拦截了本次响应/ },
    { name: 'UnknownError', code: 'MODEL_ERROR', message: /服务端日志和模型设置/ }
  ];
  for (const fixture of cases) {
    await t.test(`${fixture.name} ${fixture.statusCode || ''}`, async () => {
      await assert.rejects(
        client.request({ model: 'local/qwen' }, 'prompt', async (url, init) => {
          if (init.method === 'POST' && url.endsWith('/session')) return response(200, protectedSession('model-error-session'));
          if (url.endsWith('/message')) return response(200, {
            info: { error: { name: fixture.name, data: { statusCode: fixture.statusCode, message: 'secret credential and document' } } },
            parts: [{ type: 'text', text: '{"issues":[]}' }]
          });
          return response(204, null);
        }),
        (error) => {
          assert.equal(error.code, fixture.code);
          assert.match(error.message, fixture.message);
          assert.doesNotMatch(error.message, /secret|credential|document/);
          return true;
        }
      );
    });
  }
});

test('a response with only reasoning still reports an empty model output', async () => {
  await assert.rejects(
    client.request({ model: 'local/qwen' }, 'prompt', async (url, init) => {
      if (init.method === 'POST' && url.endsWith('/session')) return response(200, protectedSession('empty-session'));
      if (url.endsWith('/message')) return response(200, {
        info: { role: 'assistant' },
        parts: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: '  ' }]
      });
      return response(204, null);
    }),
    (error) => error.code === 'EMPTY_RESPONSE' && /重试或切换模型/.test(error.message) && !error.message.includes('private')
  );
});

test('cancellation returns a safe Chinese error and still cleans up after a created session', async () => {
  const controller = new AbortController();
  const paths = [];
  await assert.rejects(
    client.request({ model: 'local/qwen', signal: controller.signal }, 'prompt', async (url, init) => {
      paths.push(`${init.method} ${new URL(url).pathname}`);
      if (init.method === 'POST' && url.endsWith('/session')) return response(200, protectedSession('cancelled-session'));
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

test('a server that ignores session permissions is stopped before sending document text', async () => {
  const paths = [];
  await assert.rejects(client.request({ model: 'opencode/mimo-v2.6-flash-free' }, 'private document', async (url, init) => {
    paths.push(`${init.method} ${new URL(url).pathname}`);
    if (init.method === 'POST' && url.endsWith('/session')) return response(200, { id: 'unprotected-session' });
    assert.equal(String(init.body || '').includes('private document'), false);
    return response(200, true);
  }), (error) => error.code === 'UNSAFE_SESSION');
  assert.deepEqual(paths, ['POST /session', 'POST /session/unprotected-session/abort', 'DELETE /session/unprotected-session']);
});

test('a pending tool permission aborts proofreading without granting access', async () => {
  const calls = [];
  let messageSignal;
  await assert.rejects(client.request({ model: 'opencode/mimo-v2.6-flash-free' }, 'prompt', async (url, init) => {
    calls.push({ path: new URL(url).pathname, method: init.method, body: init.body });
    if (init.method === 'POST' && url.endsWith('/session')) return response(200, protectedSession('tool-session'));
    if (url.endsWith('/message')) {
      messageSignal = init.signal;
      return new Promise(() => {});
    }
    if (url.endsWith('/permission')) return response(200, [{ id: 'per_test', sessionID: 'tool-session', permission: 'bash' }]);
    return response(200, true);
  }), (error) => error.code === 'MODEL_TOOL_BLOCKED');
  assert.equal(messageSignal.aborted, true);
  assert.equal(calls.some(call => /\/reply$/.test(call.path)), false);
  assert.deepEqual(calls.slice(-2).map(call => `${call.method} ${call.path}`), [
    'POST /session/tool-session/abort', 'DELETE /session/tool-session'
  ]);
});

test('permission requests from other sessions are left alone while proofreading completes', async () => {
  const paths = [];
  let completeMessage;
  const result = await client.request({ model: 'local/qwen' }, 'prompt', async (url, init) => {
    paths.push(`${init.method} ${new URL(url).pathname}`);
    if (init.method === 'POST' && url.endsWith('/session')) return response(200, protectedSession('own-session'));
    if (url.endsWith('/message')) return new Promise(resolve => { completeMessage = resolve; });
    if (url.endsWith('/permission')) {
      setTimeout(() => completeMessage(response(200, { parts: [{ type: 'text', text: '{"issues":[]}' }] })), 10);
      return response(200, [{ id: 'per_unrelated', sessionID: 'another-session', permission: 'read' }]);
    }
    return response(200, true);
  });
  assert.equal(result, '{"issues":[]}');
  assert.deepEqual(paths, ['POST /session', 'POST /session/own-session/message', 'GET /permission', 'DELETE /session/own-session']);
});

test('failed permission monitoring stops a pending model request and cleans up', async () => {
  const paths = [];
  await assert.rejects(client.request({ model: 'local/qwen' }, 'prompt', async (url, init) => {
    paths.push(`${init.method} ${new URL(url).pathname}`);
    if (init.method === 'POST' && url.endsWith('/session')) return response(200, protectedSession('guard-failed-session'));
    if (url.endsWith('/message')) return new Promise(() => {});
    if (url.endsWith('/permission')) return response(503, null);
    return response(200, true);
  }), (error) => error.code === 'HTTP_ERROR');
  assert.deepEqual(paths.slice(-2), ['POST /session/guard-failed-session/abort', 'DELETE /session/guard-failed-session']);
});
