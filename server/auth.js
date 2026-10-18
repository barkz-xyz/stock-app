import crypto from 'node:crypto'
import { countUsers, getLoginUser, createLoginSession, getSessionUser, revokeLoginSession, createUser, setOwnPassword } from './store.js'
import { publicUser, verifyPassword, hashPassword, validatePassword, userError } from './user-security.js'
if (process.env.STAFF_PIN && !process.env.SESSION_SECRET) throw new Error('SESSION_SECRET is required when STAFF_PIN is configured.')
const cookieName='bakery_session', attempts=new Map()
const dummyHash=hashPassword(crypto.randomBytes(32).toString('hex'))
const tokenHash=value=>crypto.createHash('sha256').update(value).digest('hex')
function token(req) {
  for(const part of String(req.headers.cookie||'').split(';')){
    const [name,...value]=part.trim().split('=')
    if(name===cookieName){try{const raw=decodeURIComponent(value.join('='));return /^[a-f0-9]{64}$/.test(raw)?raw:null}catch{return null}}
  }
  return null
}
function cookieOptions(){return {httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production'||Boolean(process.env.RAILWAY_PROJECT_ID||process.env.RAILWAY_ENVIRONMENT_ID),maxAge:12*3600000,path:'/'}}
async function identity(req){if(req.authUser!==undefined)return req.authUser;const value=token(req);return req.authUser=value?await getSessionUser(tokenHash(value)):null}
export async function authStatus(req){const user=await identity(req);return {required:true,authenticated:Boolean(user),user,setupRequired:!user&&!(await countUsers()),productionReady:Boolean(process.env.SESSION_SECRET)}}
async function issue(req,res,user){const value=crypto.randomBytes(32).toString('hex');await createLoginSession(user.id,tokenHash(value));res.cookie(cookieName,value,cookieOptions());req.authUser=publicUser(user);return res.json(await authStatus(req))}
function throttle(req,scope='login'){const now=Date.now(),key=scope+':'+(req.ip||'unknown');for(const [k,v]of attempts)if(v.resetAt<now)attempts.delete(k);let r=attempts.get(key);if(!r){if(attempts.size>=10000)throw userError('Demasiados intentos. Intenta más tarde.',429);r={count:0,resetAt:now+600000};attempts.set(key,r)}if(r.count>=8)throw userError('Demasiados intentos. Intenta en unos minutos.',429);r.count++;return key}
export async function login(req,res,next){try{
  const key=throttle(req),username=String(req.body?.username||'admin').trim().toLowerCase(),password=req.body?.password??req.body?.pin??''
  const user=await getLoginUser(username)
  const valid=await verifyPassword(password,user?(user.password_hash??user.passwordHash):await dummyHash)
  if(!user||!user.active||!valid)throw userError('Usuario o contraseña incorrectos.',401)
  attempts.delete(key);return issue(req,res,user)
}catch(e){next(e)}}
export async function setupAdmin(req,res,next){try{
  throttle(req,'setup')
  if(process.env.NODE_ENV==='production'||process.env.RAILWAY_PROJECT_ID||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))throw userError('Configura el administrador desde este equipo.',403)
  const user=await createUser(req.body,true);return issue(req,res,user)
}catch(e){next(e)}}
export async function changePassword(req,res,next){try{
  const user=await identity(req);if(!user)throw userError('Ingresa para continuar.',401)
  const attemptKey=throttle(req,'password');validatePassword(req.body?.password)
  const current=await getLoginUser(user.username),old=req.body?.currentPassword
  if(!await verifyPassword(old,current.password_hash??current.passwordHash))throw userError('La contraseña actual es incorrecta.',401)
  if(old===req.body.password)throw userError('Elige una contraseña diferente al código anterior.')
  const updated=await setOwnPassword(user.id,await hashPassword(req.body.password));attempts.delete(attemptKey);return issue(req,res,updated)
}catch(e){next(e)}}
export async function logout(req,res,next){try{const value=token(req);if(value)await revokeLoginSession(tokenHash(value));res.clearCookie(cookieName,{...cookieOptions(),maxAge:undefined});res.status(204).end()}catch(e){next(e)}}
export async function requireAuth(req,res,next){try{
  const user=await identity(req);if(!user)return res.status(401).json({error:'Ingresa para continuar.'})
  if(user.mustChangePassword)return res.status(403).json({error:'Cambia la contraseña inicial para continuar.',code:'PASSWORD_CHANGE_REQUIRED'})
  req.user=user;next()
}catch(e){next(e)}}
export function requireAdmin(req,res,next){if(req.user?.role==='admin')return next();res.status(403).json({error:'Esta acción requiere un administrador.',code:'FORBIDDEN'})}
export function cashierBoundary(req,res,next){
  if(req.user.role==='admin')return next()
  const read=req.method==='GET',path=req.path
  const allowed=read&&(/^\/(events|items|pos\/(config|terminal)|sales|sales\/history)$/.test(path)||/^\/(sales|checkouts)\/[^/]+$/.test(path))||/^\/register-sessions(?:\/[^/]+\/closure(?:\/pdf)?)?$/.test(path)&&['GET','POST'].includes(req.method)||req.method==='POST'&&(/^\/sales\/(cash|card)$/.test(path)||/^\/sales\/[^/]+\/(retry-card|cancel)$/.test(path))
  return allowed?next():res.status(403).json({error:'Tu acceso está limitado a Caja.',code:'FORBIDDEN'})
}
export function pointAccessIsProtected(){return Boolean(process.env.SESSION_SECRET)}
