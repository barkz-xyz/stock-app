import { dateOnly } from './dates.js'

const formatters = new Map()
export function businessDayKey(value = new Date(), timeZone = 'America/Santiago') {
  if (!formatters.has(timeZone)) formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }))
  const parts = formatters.get(timeZone).formatToParts(new Date(value))
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type).value).join('-')
}

export function registerBusinessDate(session, timeZone = 'America/Santiago') {
  return dateOnly(session?.business_date ?? session?.businessDate) || businessDayKey(session.opened_at ?? session.openedAt, timeZone)
}

export function registerIsActive(session, day = businessDayKey(), timeZone = 'America/Santiago') {
  return Boolean(session && !(session.closed_at ?? session.closedAt) && registerBusinessDate(session, timeZone) === day)
}

// The server supplies both timestamps, so browser clock skew cannot postpone rollover.
export function scheduleRegisterDay(calendar, onRollover, timers = globalThis) {
  const delay = Date.parse(calendar?.nextDayAt) - Date.parse(calendar?.serverNow)
  if (!Number.isFinite(delay)) return () => {}
  const timer = timers.setTimeout(onRollover, Math.max(1, delay + 25))
  return () => timers.clearTimeout(timer)
}
