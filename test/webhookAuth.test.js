import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookSecretMiddleware, safeEqual, SECRET_HEADER } from '../src/services/webhook.js';

function mockReq(headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: lower, get: (name) => lower[name.toLowerCase()] };
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; }
  };
}

function run(mw, headers) {
  const req = mockReq(headers);
  const res = mockRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

describe('webhook secret middleware', () => {
  const mw = createWebhookSecretMiddleware('s3cr3t_TOKEN-1');

  test('нет заголовка -> 401', () => {
    const { res, nextCalled } = run(mw, {});
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
  });

  test('неверный заголовок -> 401', () => {
    const { res, nextCalled } = run(mw, { [SECRET_HEADER]: 'wrong' });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
  });

  test('неверный заголовок той же длины -> 401', () => {
    const { res, nextCalled } = run(mw, { [SECRET_HEADER]: 's3cr3t_TOKEN-2' });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
  });

  test('верный заголовок -> next()', () => {
    const { res, nextCalled } = run(mw, { 'X-Telegram-Bot-Api-Secret-Token': 's3cr3t_TOKEN-1' });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  });

  test('секрет не задан -> пропускает (обратная совместимость)', () => {
    const { nextCalled } = run(createWebhookSecretMiddleware(''), {});
    assert.equal(nextCalled, true);
  });

  test('safeEqual: разные длины и не-строки', () => {
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual(undefined, 'abc'), false);
    assert.equal(safeEqual('abc', 'abc'), true);
  });
});
