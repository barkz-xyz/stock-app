import crypto from 'node:crypto'
import { promisify } from 'node:util'
const scrypt = promisify(crypto.scrypt)
export const userError = (message, status = 400, code = 'INVALID_USER') => Object.assign(new Error(message), { status, code })
export const publicUser = u => u ? { id:u.id, username:u.username, name:u.name, role:u.role, active:u.active, mustChangePassword:Boolean(u.must_change_password ?? u.mustChangePassword) } : null
export function cleanUser(body, creating = true) {
  const username = String(body.username || '').trim().toLowerCase(), name = String(body.name || '').trim()
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username) || !name || name.length > 80 || !['admin','cashier'].includes(body.role)) throw userError('Indica nombre, usuario (3–40 caracteres) y un rol válido.')
  if (creating || body.password) validatePassword(body.password)
  return { username, name, role:body.role, active:body.active !== false, password:body.password || '' }
}
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw userError('La contraseña debe tener entre 8 y 128 caracteres.')
}
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = await scrypt(password, salt, 64, { N:65536, r:8, p:1, maxmem:128*1024*1024 })
  return `${salt}:${hash.toString('hex')}`
}
export async function verifyPassword(password, encoded) {
  const [salt, hash] = String(encoded || '').split(':')
  if (!salt || !/^[a-f0-9]{128}$/.test(hash || '') || typeof password !== 'string' || password.length > 128) return false
  const value = await scrypt(password, salt, 64, { N:65536, r:8, p:1, maxmem:128*1024*1024 })
  return crypto.timingSafeEqual(value, Buffer.from(hash,'hex'))
}
