import crypto from 'node:crypto'

const staffPin = process.env.STAFF_PIN || ''
const configuredSecret = process.env.SESSION_SECRET || ''
if (staffPin && !configuredSecret) throw new Error('SESSION_SECRET is required when STAFF_PIN is configured.')
const sessionSecret = configuredSecret
const cookieName = 'bakery_session'
const sessionLifetimeSeconds = 12 * 60 * 60
const attempts = new Map()
const maximumAttemptRecords = 10000
let nextAttemptCleanup = 0

function signature(value) {
  return crypto.createHmac('sha256', sessionSecret).update(value).digest('base64url')
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function parseCookies(header = '') {
  const cookies = Object.create(null)
  for (const value of header.split(';').map((part) => part.trim()).filter(Boolean)) {
    const index = value.indexOf('=')
    if (index < 1) continue
    try {
      cookies[value.slice(0, index)] = decodeURIComponent(value.slice(index + 1))
    } catch {
      // Ignore malformed values, including unrelated cookies, without throwing a 500.
    }
  }
  return cookies
}

function validSession(req) {
  if (!staffPin) return true
  const token = parseCookies(req.headers.cookie)[cookieName]
  if (!token) return false
  const [expires, receivedSignature, extra] = token.split('.')
  if (!/^\d+$/.test(expires || '') || !receivedSignature || extra !== undefined || Number(expires) < Math.floor(Date.now() / 1000)) return false
  return safeEqual(signature(expires), receivedSignature)
}

function cookieOptions() {
  const isRailway = Boolean(
    process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_ID ||
    process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_PUBLIC_DOMAIN,
  )
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production' || isRailway,
    maxAge: sessionLifetimeSeconds * 1000,
    path: '/',
  }
}

export function authStatus(req) {
  return {
    required: Boolean(staffPin),
    authenticated: validSession(req),
    productionReady: Boolean(staffPin && configuredSecret),
  }
}

export function login(req, res) {
  if (!staffPin) return res.json(authStatus(req))
  const now = Date.now()
  if (now >= nextAttemptCleanup) {
    for (const [address, attempt] of attempts) {
      if (now >= attempt.resetAt) attempts.delete(address)
    }
    nextAttemptCleanup = now + 60000
  }
  const key = req.ip || 'unknown'
  const record = attempts.get(key) || { count: 0, resetAt: now + 10 * 60 * 1000 }
  if (now >= record.resetAt) Object.assign(record, { count: 0, resetAt: now + 10 * 60 * 1000 })
  if (record.count >= 8) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' })

  if (!safeEqual(req.body?.pin || '', staffPin)) {
    if (!attempts.has(key) && attempts.size >= maximumAttemptRecords) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' })
    record.count += 1
    attempts.set(key, record)
    return res.status(401).json({ error: 'Incorrect access code.' })
  }

  attempts.delete(key)
  const expires = String(Math.floor(Date.now() / 1000) + sessionLifetimeSeconds)
  res.cookie(cookieName, `${expires}.${signature(expires)}`, cookieOptions())
  return res.json({ required: true, authenticated: true, productionReady: Boolean(configuredSecret) })
}

export function logout(_req, res) {
  res.clearCookie(cookieName, { ...cookieOptions(), maxAge: undefined })
  res.status(204).end()
}

export function requireAuth(req, res, next) {
  if (validSession(req)) return next()
  res.status(401).json({ error: 'Sign in to continue.' })
}

export function pointAccessIsProtected() {
  return Boolean(staffPin && configuredSecret)
}
