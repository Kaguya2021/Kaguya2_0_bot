import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWithinWorkingHours,
  validateTimeArgs,
  isValidTime,
  parseTzOffset,
  formatTzOffset,
  formatLocalTime,
  pauseKey,
  isPauseActive,
  parseAdminIds,
  isAutoReplyActive,
  isBlocked,
  callWith429Retry,
  broadcast
} from '../lib/utils.js';
import { BoundedCache } from '../lib/cache.js';

// Время в UTC: 2026-01-01THH:MM:00Z
const at = (hhmm) => new Date(`2026-01-01T${hhmm}:00Z`);
const day = { start_time: '09:00', end_time: '18:00' };
const night = { start_time: '22:00', end_time: '06:00' };

describe('isWithinWorkingHours', () => {
  test('без расписания — всегда true', () => {
    assert.equal(isWithinWorkingHours('1', null, 0, at('03:00')), true);
    assert.equal(isWithinWorkingHours('1', { start_time: null, end_time: null }, 0, at('03:00')), true);
  });

  test('обычный интервал 09:00-18:00 (UTC)', () => {
    assert.equal(isWithinWorkingHours('1', day, 0, at('12:00')), true);
    assert.equal(isWithinWorkingHours('1', day, 0, at('08:59')), false);
    assert.equal(isWithinWorkingHours('1', day, 0, at('18:01')), false);
  });

  test('граничные минуты включительно', () => {
    assert.equal(isWithinWorkingHours('1', day, 0, at('09:00')), true);
    assert.equal(isWithinWorkingHours('1', day, 0, at('18:00')), true);
  });

  test('ночной интервал через полночь 22:00-06:00', () => {
    assert.equal(isWithinWorkingHours('1', night, 0, at('23:30')), true);
    assert.equal(isWithinWorkingHours('1', night, 0, at('00:00')), true);
    assert.equal(isWithinWorkingHours('1', night, 0, at('05:59')), true);
    assert.equal(isWithinWorkingHours('1', night, 0, at('06:00')), true);
    assert.equal(isWithinWorkingHours('1', night, 0, at('06:01')), false);
    assert.equal(isWithinWorkingHours('1', night, 0, at('21:59')), false);
    assert.equal(isWithinWorkingHours('1', night, 0, at('22:00')), true);
  });

  test('положительный часовой пояс (+6): 03:30 UTC = 09:30 локально', () => {
    assert.equal(isWithinWorkingHours('1', day, 360, at('03:30')), true);
    assert.equal(isWithinWorkingHours('1', day, 360, at('12:30')), false); // 18:30 локально
  });

  test('отрицательный часовой пояс (-3): 11:00 UTC = 08:00 локально', () => {
    assert.equal(isWithinWorkingHours('1', day, -180, at('11:00')), false);
    assert.equal(isWithinWorkingHours('1', day, -180, at('12:00')), true); // 09:00 локально
  });

  test('часовой пояс с переходом даты и ночным интервалом', () => {
    // +5:30: 18:00 UTC = 23:30 локально -> внутри 22:00-06:00
    assert.equal(isWithinWorkingHours('1', night, 330, at('18:00')), true);
    // -10: 05:00 UTC = 19:00 предыдущего дня -> вне
    assert.equal(isWithinWorkingHours('1', night, -600, at('05:00')), false);
    // +14: 10:00 UTC = 00:00 следующего дня -> внутри
    assert.equal(isWithinWorkingHours('1', night, 840, at('10:00')), true);
  });

  test('админы не исключены из расписания', () => {
    assert.equal(isWithinWorkingHours('6511859639', day, 0, at('03:00')), false);
  });
});

describe('валидация /time', () => {
  test('корректные значения', () => {
    assert.deepEqual(validateTimeArgs(['05:00', '20:00']), { ok: true, start: '05:00', end: '20:00' });
    assert.equal(validateTimeArgs(['22:00', '06:00']).ok, true);
    assert.equal(validateTimeArgs(['00:00', '23:59']).ok, true);
  });

  test('мусорные вводы', () => {
    for (const bad of ['24:00', '5:00', '05:60', '0500', 'ab:cd', '', '05:00:00', ' 05:00', '-1:00', '12:5']) {
      assert.equal(isValidTime(bad), false, bad);
    }
    assert.equal(validateTimeArgs(['05:00']).ok, false);
    assert.equal(validateTimeArgs([]).ok, false);
    assert.equal(validateTimeArgs(['05:00', '20:00', 'x']).ok, false);
    assert.equal(validateTimeArgs(['05:00', '25:00']).ok, false);
    assert.equal(validateTimeArgs(['hello', 'world']).ok, false);
    assert.equal(validateTimeArgs(null).ok, false);
  });
});

describe('валидация /tz', () => {
  test('корректные значения', () => {
    assert.equal(parseTzOffset('+6'), 360);
    assert.equal(parseTzOffset('-3'), -180);
    assert.equal(parseTzOffset('0'), 0);
    assert.equal(parseTzOffset('-0'), 0);
    assert.equal(parseTzOffset('+3:30'), 210);
    assert.equal(parseTzOffset('-9:30'), -570);
    assert.equal(parseTzOffset('5'), 300);
    assert.equal(parseTzOffset('+14'), 840);
    assert.equal(parseTzOffset('-12'), -720);
    assert.equal(parseTzOffset('UTC+3'), 180);
  });

  test('мусорные вводы и выход за диапазон', () => {
    for (const bad of ['+15', '-13', '+14:30', '-12:30', 'abc', '', '+', '3:60', '+3:5', '++3', '3.5', null, undefined, 6]) {
      assert.equal(parseTzOffset(bad), null, String(bad));
    }
  });

  test('форматирование', () => {
    assert.equal(formatTzOffset(0), 'UTC+0');
    assert.equal(formatTzOffset(360), 'UTC+6');
    assert.equal(formatTzOffset(-180), 'UTC-3');
    assert.equal(formatTzOffset(210), 'UTC+3:30');
    assert.equal(formatTzOffset(-570), 'UTC-9:30');
    assert.equal(formatLocalTime(at('23:30'), 60), '00:30');
    assert.equal(formatLocalTime(at('00:15'), -60), '23:15');
  });
});

describe('изоляция пауз ownerId:chatId', () => {
  test('пауза владельца A не блокирует владельца B в чате с тем же клиентом', () => {
    const pauses = new BoundedCache({ maxSize: 100 });
    const now = 1_000_000;
    const client = '555';
    pauses.set(pauseKey('ownerA', client), now + 60_000);

    assert.equal(isPauseActive(pauses, 'ownerA', client, now), true);
    assert.equal(isPauseActive(pauses, 'ownerB', client, now), false);
    assert.equal(isPauseActive(pauses, 'ownerA', '777', now), false);
  });

  test('истёкшая пауза не активна', () => {
    const pauses = new Map();
    pauses.set(pauseKey('a', 'c'), 100);
    assert.equal(isPauseActive(pauses, 'a', 'c', 101), false);
    assert.equal(isPauseActive(pauses, 'a', 'c', 99), true);
  });

  test('формат ключа', () => {
    assert.equal(pauseKey('1', '2'), '1:2');
  });
});

describe('прочие хелперы', () => {
  test('parseAdminIds', () => {
    assert.deepEqual(parseAdminIds('1, 2,3'), ['1', '2', '3']);
    assert.equal(parseAdminIds(''), null);
    assert.equal(parseAdminIds(undefined), null);
    assert.deepEqual(parseAdminIds('1,abc,,2'), ['1', '2']);
  });

  test('isAutoReplyActive / isBlocked', () => {
    assert.equal(isAutoReplyActive({ auto_off_until: null }, 10), true);
    assert.equal(isAutoReplyActive({ auto_off_until: 20 }, 10), false);
    assert.equal(isAutoReplyActive({ auto_off_until: '20' }, 30), true);
    assert.equal(isBlocked({ blocked_until: null }, 10), false);
    assert.equal(isBlocked({ blocked_until: 20 }, 10), true);
    assert.equal(isBlocked({ blocked_until: 5 }, 10), false);
  });

  test('callWith429Retry: пауза на retry_after и один повтор', async () => {
    const sleeps = [];
    let calls = 0;
    const res = await callWith429Retry(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('Too Many Requests'), { error_code: 429, parameters: { retry_after: 2 } });
      return 'ok';
    }, async (ms) => sleeps.push(ms));
    assert.equal(res, 'ok');
    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [2000]);
  });

  test('callWith429Retry: не-429 ошибки пробрасываются без повтора', async () => {
    let calls = 0;
    await assert.rejects(callWith429Retry(async () => { calls++; throw Object.assign(new Error('x'), { error_code: 403 }); }, async () => {}));
    assert.equal(calls, 1);
  });

  test('broadcast считает доставленные и ошибки', async () => {
    const res = await broadcast(['1', '2', '3'], async (id) => {
      if (id === '2') throw new Error('blocked');
    }, { delayMs: 0, sleep: async () => {} });
    assert.deepEqual(res, { delivered: 2, failed: 1 });
  });
});
