// Обязательная подписка на канал (только личное меню: /start и пользовательские callback-кнопки).
// НИКОГДА не вызывается из business_* апдейтов и channel.js — getChatMember там не нужен и стоит лимитов.
//
// Fail-open: если проверка невозможна (бот не админ канала, неверный ID, сеть) — пользователь проходит,
// в консоль пишется троттлированное предупреждение (не чаще раза в 10 минут, без записи в message_logs).
import { config } from '../config.js';
import { BoundedCache } from './cache.js';

export const SUB_CACHE_TTL = 10 * 60 * 1000;
export const WARN_THROTTLE_MS = 10 * 60 * 1000;

// userId -> true. Кэшируются только подтверждённые подписки: неподписанный после подписки
// нажимает «Проверить подписку» и сразу проходит.
const subCache = new BoundedCache({ maxSize: 5000, ttlMs: SUB_CACHE_TTL });

let lastWarnAt = 0;

export function clearSubscriptionCache() {
  subCache.clear();
  lastWarnAt = 0;
}

export function isSubscriptionGateActive(cfg = config) {
  return Boolean(cfg.requireSubscription && cfg.targetChannelId);
}

export function getChannelUrl(cfg = config) {
  const id = String(cfg.targetChannelId || '');
  if (id.startsWith('@') && id.length > 1) return `https://t.me/${id.slice(1)}`;
  return cfg.channelInviteUrl || null;
}

export function isMemberStatus(member) {
  const status = member?.status;
  if (status === 'creator' || status === 'administrator' || status === 'member') return true;
  return status === 'restricted' && member.is_member === true;
}

// Ошибки Bot API, означающие «пользователя нет в канале» (= не подписан), а не сбой проверки.
const NOT_MEMBER_RE = /USER_NOT_PARTICIPANT|PARTICIPANT_ID_INVALID|user not found|member not found/i;

export function isNotMemberError(err) {
  const text = `${err?.description || ''} ${err?.message || ''}`;
  return NOT_MEMBER_RE.test(text);
}

function warnThrottled(err) {
  const now = Date.now();
  if (now - lastWarnAt < WARN_THROTTLE_MS) return;
  lastWarnAt = now;
  console.warn(
    '⚠️ Проверка подписки недоступна (fail-open, пользователи пропускаются). ' +
    'Проверьте TARGET_CHANNEL_ID и что бот — админ канала:',
    err?.description || err?.message || String(err)
  );
}

export async function checkUserSubscription(api, userId, { force = false, cfg = config } = {}) {
  if (!isSubscriptionGateActive(cfg)) return { subscribed: true, bypassed: true };
  const key = String(userId);
  if (cfg.adminIds?.includes(key)) return { subscribed: true, bypassed: true };
  if (!force && subCache.has(key)) return { subscribed: true, cached: true };

  try {
    const member = await api.getChatMember(cfg.targetChannelId, Number(userId));
    if (isMemberStatus(member)) {
      subCache.set(key, true);
      return { subscribed: true };
    }
    subCache.delete(key);
    return { subscribed: false };
  } catch (err) {
    if (isNotMemberError(err)) {
      subCache.delete(key);
      return { subscribed: false };
    }
    warnThrottled(err);
    return { subscribed: true, fallback: true };
  }
}
