/**
 * Cloudflare Access 签名公钥（JWKS）的获取与缓存。
 *
 * 两级缓存，都是为了压住免费额度：
 *   1. isolate 内存（10 分钟）—— 绝大多数请求命中这里，零外部调用
 *   2. KV（1 小时）—— 跨 isolate 共享，最多 24 次写入/天
 *      （KV 免费额度只有 1000 写/天，所以热路径上除了这里不写任何 KV）
 *
 * Access 默认每 6 周轮换一次签名密钥，因此缓存必须能过期；
 * 另外遇到未知 kid 时会强制穿透缓存重拉一次，让轮换当场生效而不用等 TTL 到期。
 */

const KV_KEY = 'access:jwks:v1';
const MEM_TTL_MS = 10 * 60 * 1000;
const KV_TTL_S = 3600;

/** @type {{ expiresAt: number, keys: Map<string, CryptoKey> } | null} */
let memo = null;

/** team domain 必须长成 xxx.cloudflareaccess.com，避免配置被改成任意地址造成 SSRF。 */
const TEAM_DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}\.cloudflareaccess\.com$/i;

/** @param {any} jwks @returns {Promise<Map<string, CryptoKey>>} */
async function importKeys(jwks) {
  /** @type {Map<string, CryptoKey>} */
  const keys = new Map();
  for (const jwk of jwks?.keys ?? []) {
    if (jwk?.kty !== 'RSA' || !jwk.kid || !jwk.n || !jwk.e) continue;
    try {
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      keys.set(jwk.kid, key);
    } catch {
      // 单个 key 导入失败不影响其余 key
    }
  }
  return keys;
}

/** @param {any} env @returns {Promise<any>} */
async function fetchFromAccess(env) {
  const domain = String(env.ACCESS_TEAM_DOMAIN || '');
  if (!TEAM_DOMAIN_RE.test(domain)) {
    throw new Error('ACCESS_TEAM_DOMAIN 格式非法: ' + JSON.stringify(domain));
  }
  const res = await fetch('https://' + domain + '/cdn-cgi/access/certs', {
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!res.ok) throw new Error('JWKS 拉取失败 HTTP ' + res.status);
  return await res.json();
}

/** @param {any} env @param {boolean} bypassKv */
async function refresh(env, bypassKv) {
  let jwks = null;

  if (!bypassKv && env.CACHE) {
    try { jwks = await env.CACHE.get(KV_KEY, 'json'); } catch { /* KV 故障时退回直连 */ }
  }
  if (!jwks) {
    jwks = await fetchFromAccess(env);
    if (env.CACHE) {
      try {
        await env.CACHE.put(KV_KEY, JSON.stringify(jwks), { expirationTtl: KV_TTL_S });
      } catch { /* 写 KV 失败不影响本次校验 */ }
    }
  }

  const keys = await importKeys(jwks);
  if (keys.size === 0) throw new Error('JWKS 中没有可用的 RSA 公钥');
  memo = { expiresAt: Date.now() + MEM_TTL_MS, keys };
}

/**
 * 按 kid 取签名公钥。取不到返回 null（调用方一律视为鉴权失败）。
 * @param {string} kid @param {any} env @returns {Promise<CryptoKey | null>}
 */
export async function getSigningKey(kid, env) {
  if (memo && memo.expiresAt > Date.now()) {
    const hit = memo.keys.get(kid);
    if (hit) return hit;
  }

  await refresh(env, false);
  const fromCache = memo?.keys.get(kid);
  if (fromCache) return fromCache;

  // kid 不认识：很可能刚刚轮换过密钥。穿透 KV 直连 Access 再拉一次。
  await refresh(env, true);
  return memo?.keys.get(kid) ?? null;
}

/** 测试用：清空 isolate 内存缓存。 */
export function resetJwksCache() { memo = null; }
