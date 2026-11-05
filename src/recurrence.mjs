import { BridgeError } from './core.mjs';

// Observed public Web protocol, not an official compatibility guarantee. No custom bitfield guessing.
export const RECURRENCE_PATTERNS = Object.freeze({ none: 0, daily: 50331649, weekdays: 75235329, weekly: 67108865, monthly: 83886081 });
export const RECURRENCE_TIMEZONE = 'Asia/Shanghai';
export const RECURRENCE_WARNINGS = Object.freeze([
  'weekdays仅指周一至周五，不含法定节假日或调休；桥接保留Asia/Shanghai同一时分秒，与网页本周分支可能归零到午夜的行为不同。',
  'monthly逐实例以当前日期推进，月底不足则clamp到月底，可能发生31日→28日→28日漂移；不自动恢复原月底锚点。',
]);
export function recurrenceName(pattern) {
  return Object.entries(RECURRENCE_PATTERNS).find(([, value]) => value === pattern)?.[0] ?? null;
}
const invalid = () => new BridgeError('INVALID_MUTATION', '日期或重复规则不支持安全运算。', 400);
const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: RECURRENCE_TIMEZONE, calendar: 'gregory', numberingSystem: 'latn',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const utc = (year, month, day, hour = 0, minute = 0, second = 0) => {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day); date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
};
function instant(value) {
  if (typeof value !== 'string') throw invalid();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw invalid();
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const maxDay = new Date(utc(year, month + 1, 0)).getUTCDate();
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > maxDay || hour > 23 || minute > 59 || second > 59
    || match[8] === '-00:00' || (match[8] !== 'Z' && (Number(match[8].slice(1, 3)) > 23 || Number(match[8].slice(4)) > 59))) throw invalid();
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw invalid();
  return { time, fraction: (match[7]?.slice(1) ?? '').replace(/0+$/, '').padEnd(3, '0') };
}
function localParts(time) {
  return Object.fromEntries(formatter.formatToParts(time).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}
const wallTime = p => utc(p.year, p.month, p.day, p.hour, p.minute, p.second);
// Resolve Shanghai calendar time independently of the host timezone. Historical DST gaps/folds are rejected,
// rather than silently changing the requested local clock or guessing which occurrence was intended.
function fromLocal(parts) {
  const wall = wallTime(parts), offsets = new Set();
  for (const delta of [-2, 0, 2]) {
    const probe = wall + delta * 86400000;
    offsets.add(wallTime(localParts(probe)) - probe);
  }
  const candidates = [...offsets].map(offset => wall - offset).filter(time => wallTime(localParts(time)) === wall);
  if (candidates.length !== 1) throw invalid();
  return candidates[0];
}
export function shanghaiDate(value) {
  const p = localParts(instant(value).time);
  if (p.year < 1 || p.year > 9999) throw invalid();
  return p.year * 10000 + p.month * 100 + p.day;
}
/** Return exactly one next occurrence at the same Shanghai local clock. Never skip overdue occurrences. */
export function nextDueAt(dueAt, recurrence) {
  const name = typeof recurrence === 'number' ? recurrenceName(recurrence) : recurrence;
  if (!Object.hasOwn(RECURRENCE_PATTERNS, name ?? '') || name === 'none') throw invalid();
  const { time, fraction } = instant(dueAt), parts = localParts(time);
  const calendar = new Date(utc(parts.year, parts.month, parts.day));
  if (name === 'monthly') {
    const maxDay = new Date(utc(parts.year, parts.month + 2, 0)).getUTCDate();
    calendar.setUTCDate(1); calendar.setUTCMonth(calendar.getUTCMonth() + 1);
    calendar.setUTCDate(Math.min(parts.day, maxDay));
  } else {
    calendar.setUTCDate(calendar.getUTCDate() + (name === 'weekly' ? 7 : 1));
    if (name === 'weekdays') while ([0, 6].includes(calendar.getUTCDay())) calendar.setUTCDate(calendar.getUTCDate() + 1);
  }
  const target = { ...parts, year: calendar.getUTCFullYear(), month: calendar.getUTCMonth() + 1, day: calendar.getUTCDate() };
  if (target.year < 1 || target.year > 9999) throw invalid();
  const result = new Date(fromLocal(target)).toISOString();
  if (result.length !== 24 || result.startsWith('0000-')) throw invalid();
  return `${result.slice(0, 19)}.${fraction}Z`;
}
