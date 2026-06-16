// Cloudflare Access JWT validation. Defense-in-depth: even if Access is
// misconfigured at the edge ("Allow Everyone"), this Worker rejects unauthenticated
// requests by validating the JWT signature against Access's JWKS.

interface JWK {
  kid: string;
  kty: string;
  alg: string;
  use: string;
  n: string;
  e: string;
}

interface JWKS {
  keys: JWK[];
}

interface AccessJwtPayload {
  sub: string;
  email?: string;
  iat: number;
  exp: number;
  aud: string | string[];
}

let cachedJwks: { jwks: JWKS; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function getJwks(teamDomain: string): Promise<JWKS> {
  if (cachedJwks && Date.now() - cachedJwks.fetchedAt < JWKS_TTL_MS) {
    return cachedJwks.jwks;
  }
  const url = `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`access: failed to fetch JWKS (${res.status})`);
  const jwks = (await res.json()) as JWKS;
  cachedJwks = { jwks, fetchedAt: Date.now() };
  return jwks;
}

function base64UrlToUint8Array(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJwtSegments(jwt: string): {
  header: any;
  payload: AccessJwtPayload;
  signedData: Uint8Array;
  signature: Uint8Array;
} {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  const [h, p, s] = parts as [string, string, string];
  const header = JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(h)));
  const payload = JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(p)));
  const signedData = new TextEncoder().encode(`${h}.${p}`);
  const signature = base64UrlToUint8Array(s);
  return { header, payload, signedData, signature };
}

async function importRsaKey(jwk: JWK): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg, use: jwk.use, ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

export interface AccessIdentity {
  email: string;
  sub: string;
}

export class AccessError extends Error {
  constructor(message: string, public status = 403) {
    super(message);
    this.name = "AccessError";
  }
}

export async function validateAccessJwt(
  req: Request,
  teamDomain: string,
  expectedAud: string,
): Promise<AccessIdentity> {
  const jwt = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) throw new AccessError("missing Cf-Access-Jwt-Assertion header");

  const { header, payload, signedData, signature } = decodeJwtSegments(jwt);

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new AccessError("token expired");

  const audOk = Array.isArray(payload.aud)
    ? payload.aud.includes(expectedAud)
    : payload.aud === expectedAud;
  if (!audOk) throw new AccessError("audience mismatch");

  const jwks = await getJwks(teamDomain);
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new AccessError("unknown signing key (kid)");
  const key = await importRsaKey(jwk);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature as BufferSource,
    signedData as BufferSource,
  );
  if (!ok) throw new AccessError("invalid signature");

  if (!payload.email) throw new AccessError("token missing email");
  return { email: payload.email, sub: payload.sub };
}
