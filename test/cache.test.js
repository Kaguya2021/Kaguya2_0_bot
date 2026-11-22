import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BoundedCache } from '../src/services/cache.js';

describe('BoundedCache', () => {
  test('эвикция самых старых записей при превышении лимита', () => {
    const c = new BoundedCache({ maxSize: 3 });
    c.set('a', 1).set('b', 2).set('c', 3).set('d', 4);
    assert.equal(c.size, 3);
    assert.equal(c.has('a'), false);
    assert.equal(c.get('d'), 4);
  });

  test('обновление ключа делает его свежим', () => {
    const c = new BoundedCache({ maxSize: 2 });
    c.set('a', 1).set('b', 2).set('a', 10).set('c', 3);
    assert.equal(c.has('b'), false);
    assert.equal(c.get('a'), 10);
  });

  test('null значения кэшируются (has, а не truthiness)', () => {
    const c = new BoundedCache({ maxSize: 10 });
    c.set('u', null);
    assert.equal(c.has('u'), true);
    assert.equal(c.get('u'), null);
    assert.equal(c.get('missing'), undefined);
  });

  test('TTL: запись протухает и удаляется', () => {
    let now = 1000;
    const c = new BoundedCache({ maxSize: 10, ttlMs: 100, now: () => now });
    c.set('a', 1);
    c.set('b', 2, 500); // индивидуальный TTL
    now = 1099;
    assert.equal(c.get('a'), 1);
    now = 1100;
    assert.equal(c.has('a'), false);
    assert.equal(c.get('b'), 2);
  });

  test('cleanup() удаляет протухшие записи', () => {
    let now = 0;
    const c = new BoundedCache({ maxSize: 10, ttlMs: 10, now: () => now });
    c.set('a', 1).set('b', 2);
    c.set('c', 3, 0); // без TTL
    now = 50;
    assert.equal(c.cleanup(), 2);
    assert.equal(c.size, 1);
    assert.equal(c.get('c'), 3);
  });

  test('startCleanup использует unref и останавливается', () => {
    const c = new BoundedCache({ maxSize: 10 }).startCleanup(1000);
    assert.ok(c.timer);
    assert.equal(c.timer.hasRef(), false);
    c.stopCleanup();
    assert.equal(c.timer, null);
  });

  test('невалидный maxSize', () => {
    assert.throws(() => new BoundedCache({ maxSize: 0 }));
  });
});
