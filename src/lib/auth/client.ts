/**
 * @conversora/auth-client — Lightweight RFC 9449 DPoP & Multi-Tenant Auth Client
 *
 * Designed for thousands of merchant storefronts connecting to auth.conversora.io:
 * 1. Generates and stores non-extractable ECDSA P-256 key pairs in IndexedDB ('conversora_auth_vault')
 * 2. Scopes cryptographic key pairs & sessions strictly by tenantId (prevents cross-tenant leaks)
 * 3. Handles OAuth 2.1 PKCE authorization code generation
 * 4. Signs fresh per-request DPoP proofs with RFC 7638 thumbprints (cnf.jkt)
 * 5. Provides zero-cost synchronous bootstrap profile hydration from JWT claims
 * 6. Executes deterministic hard-logout (wiping IndexedDB keys & sessions)
 */

export interface AuthClientConfig {
  authServerUrl?: string; // Defaults to 'https://auth.conversora.io'
  tenantId: string;       // Tenant/merchant slug (e.g., 'maison', 'axo')
  redirectUri?: string;   // Callback URL (defaults to window.location.origin + '/auth/callback')
}

export interface UserProfileClaims {
  id: string;             // sub
  name: string;           // u_name
  emailMasked?: string;   // u_email_masked
  tier: string;           // u_tier (e.g., 'standard', 'vip_gold')
  currency: string;       // u_curr (e.g., 'USD', 'BDT')
  tenantId: string;       // tenant_id
  scope?: string;
  points?: number;        // u_pts
}

export interface StoredSession {
  tokenType: 'DPoP';
  accessToken: string;
  expiresAt: number;      // Epoch ms
  scope: string;
  user: UserProfileClaims;
}

export interface StoredKeyPair {
  tenantId: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  jwk: JsonWebKey;
  jkt: string;            // SHA-256 base64url thumbprint (RFC 7638)
  createdAt: number;
}

const DB_NAME = 'conversora_auth_vault';
const DB_VERSION = 1;
const STORE_KEYS = 'keys';
const STORE_SESSIONS = 'sessions';

/**
 * Base64url encoding helpers
 */
function base64UrlEncode(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function stringToBase64Url(str: string): string {
  return base64UrlEncode(new TextEncoder().encode(str));
}

function base64UrlDecodeToString(base64url: string): string {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return atob(base64);
}

/**
 * IndexedDB Promise wrapper for multi-tenant storage
 */
function openAuthDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available in this environment'));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_KEYS)) {
        db.createObjectStore(STORE_KEYS, { keyPath: 'tenantId' });
      }
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: 'tenantId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet<T>(storeName: string, key: string): Promise<T | null> {
  const db = await openAuthDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut<T>(storeName: string, val: T): Promise<void> {
  const db = await openAuthDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put(val);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(storeName: string, key: string): Promise<void> {
  const db = await openAuthDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Calculates RFC 7638 JWK Thumbprint for ECDSA P-256 public key
 */
async function computeJwkThumbprint(jwk: JsonWebKey): Promise<string> {
  // RFC 7638 required canonical member order for EC keys: crv, kty, x, y
  const canonical = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return base64UrlEncode(hash);
}

export class ConversoraAuthClient {
  public readonly authServerUrl: string;
  public readonly tenantId: string;
  public readonly redirectUri: string;

  constructor(config: AuthClientConfig) {
    this.authServerUrl = (config.authServerUrl || 'https://auth.conversora.io').replace(/\/+$/, '');
    this.tenantId = config.tenantId;
    this.redirectUri = config.redirectUri || (typeof window !== 'undefined' ? `${window.location.origin}/auth/callback` : '');
  }

  /**
   * Retrieves or creates a non-extractable ECDSA P-256 key pair scoped to this tenant
   */
  async getOrCreateKeyPair(): Promise<StoredKeyPair> {
    const existing = await idbGet<StoredKeyPair>(STORE_KEYS, this.tenantId);
    if (existing) {
      return existing;
    }

    const keyPair = (await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, // non-extractable: Private key can NEVER be stolen via XSS export!
      ['sign', 'verify']
    )) as CryptoKeyPair;

    const publicJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey;
    const jkt = await computeJwkThumbprint(publicJwk);

    const stored: StoredKeyPair = {
      tenantId: this.tenantId,
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
      jwk: publicJwk,
      jkt,
      createdAt: Date.now(),
    };

    await idbPut(STORE_KEYS, stored);
    return stored;
  }

  /**
   * Builds the OAuth 2.1 PKCE authorization redirect URL with dpop_jkt binding
   */
  async createAuthorizationUrl(options: { returnPath?: string } = {}): Promise<string> {
    const keyRecord = await this.getOrCreateKeyPair();

    // 1. Generate random PKCE verifier & challenge
    const verifierBytes = new Uint8Array(32);
    crypto.getRandomValues(verifierBytes);
    const codeVerifier = base64UrlEncode(verifierBytes);

    const challengeBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
    const codeChallenge = base64UrlEncode(challengeBuffer);

    // 2. State with return path
    const stateObj = {
      csrf: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
      returnPath: options.returnPath || '/',
    };
    const state = base64UrlEncode(new TextEncoder().encode(JSON.stringify(stateObj)));

    // 3. Store PKCE state in sessionStorage
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(`conv_auth_pkce_${this.tenantId}`, JSON.stringify({
        codeVerifier,
        state,
        createdAt: Date.now(),
      }));
    }

    const url = new URL(`${this.authServerUrl}/authorize`);
    url.searchParams.set('client_id', this.tenantId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('dpop_jkt', keyRecord.jkt);
    url.searchParams.set('state', state);

    return url.toString();
  }

  /**
   * Signs an RFC 9449 DPoP Proof JWT for an outgoing request
   */
  async createDPoPProof(method: string, url: string, accessToken?: string): Promise<string> {
    const keyRecord = await this.getOrCreateKeyPair();

    // Normalized HTTP URI without query string or hash
    const targetUrl = new URL(url);
    const htu = `${targetUrl.origin}${targetUrl.pathname}`;

    const header = {
      typ: 'dpop+jwt',
      alg: 'ES256',
      jwk: {
        kty: 'EC',
        crv: 'P-256',
        x: keyRecord.jwk.x,
        y: keyRecord.jwk.y,
      },
    };

    const payload: Record<string, any> = {
      jti: 'dpop_' + base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
      htm: method.toUpperCase(),
      htu,
      iat: Math.floor(Date.now() / 1000),
    };

    // If an access token is provided, bind its hash (ath)
    if (accessToken) {
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken));
      payload.ath = base64UrlEncode(hash);
    }

    const encodedHeader = stringToBase64Url(JSON.stringify(header));
    const encodedPayload = stringToBase64Url(JSON.stringify(payload));
    const message = `${encodedHeader}.${encodedPayload}`;

    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      keyRecord.privateKey,
      new TextEncoder().encode(message)
    );

    return `${message}.${base64UrlEncode(signature)}`;
  }

  /**
   * Returns the direct redirection URL to centralized auth.conversora.io/signin
   * Automatically embeds device RFC 7638 dpop_jkt public thumbprint
   */
  async getSignInUrl(options: { returnPath?: string; storeName?: string } = {}): Promise<string> {
    const keyRecord = await this.getOrCreateKeyPair();
    const callbackUrl = encodeURIComponent(this.redirectUri);
    const store = encodeURIComponent(options.storeName || this.tenantId);
    const origin = typeof window !== 'undefined' ? encodeURIComponent(window.location.origin) : '';
    return `${this.authServerUrl}/signin?origin=${origin}&callbackURL=${callbackUrl}&store=${store}&tenantId=${this.tenantId}&dpop_jkt=${encodeURIComponent(keyRecord.jkt)}`;
  }

  /**
   * Direct token ingestion from URL hash fragment (#access_token=...)
   */
  async handleDirectToken(accessToken: string, expiresIn = 2592000): Promise<StoredSession> {
    const claims = this.decodeJwtClaims(accessToken);

    const session: StoredSession = {
      tokenType: 'DPoP',
      accessToken,
      expiresAt: Date.now() + expiresIn * 1000,
      scope: claims.scope || 'catalog:read cart:write orders:read profile:write',
      user: {
        id: claims.sub || 'usr_unknown',
        name: claims.u_name || 'Patron',
        emailMasked: claims.u_email_masked || '',
        tier: claims.u_tier || 'standard',
        currency: claims.u_curr || 'BDT',
        tenantId: claims.tenant_id || this.tenantId,
        points: claims.u_pts || 0,
      },
    };

    await idbPut(STORE_SESSIONS, {
      ...session,
      tenantId: this.tenantId,
    });

    return session;
  }

  /**
   * Exchanges an authorization code or session token for a 30-day DPoP-bound JWT
   */
  async handleCallback(code: string, state?: string | null): Promise<StoredSession> {
    // 1. Verify PKCE state from sessionStorage (if state provided)
    let codeVerifier = '';
    let returnPath = '/';

    if (state && typeof sessionStorage !== 'undefined') {
      const saved = sessionStorage.getItem(`conv_auth_pkce_${this.tenantId}`);
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (parsed.state === state) {
            codeVerifier = parsed.codeVerifier;
          }
        } catch {}
        sessionStorage.removeItem(`conv_auth_pkce_${this.tenantId}`);
      }
    }

    if (state) {
      try {
        const decodedState = JSON.parse(base64UrlDecodeToString(state));
        returnPath = decodedState.returnPath || '/';
      } catch {}
    }

    const tokenUrl = `${this.authServerUrl}/oauth/token`;
    const dpopProof = await this.createDPoPProof('POST', tokenUrl);

    // Strip HMAC signature if code contains cookie format (.signature)
    const cleanCode = code.split('.')[0];

    const bodyParams = new URLSearchParams({
      grant_type: 'authorization_code',
      code: cleanCode,
      redirect_uri: this.redirectUri,
      client_id: this.tenantId,
    });
    if (codeVerifier) {
      bodyParams.set('code_verifier', codeVerifier);
    }

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'DPoP': dpopProof,
      },
      body: bodyParams.toString(),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Token exchange failed (${response.status}): ${err}`);
    }

    const data = (await response.json()) as any;
    const accessToken = data.access_token;
    const expiresIn = data.expires_in || 2592000; // 30 days fallback

    // Decode unverified JWT claims for instant local UI hydration
    const claims = this.decodeJwtClaims(accessToken);

    const session: StoredSession = {
      tokenType: 'DPoP',
      accessToken,
      expiresAt: Date.now() + expiresIn * 1000,
      scope: data.scope || claims.scope || 'catalog:read cart:write orders:read profile:write',
      user: {
        id: claims.sub || 'usr_unknown',
        name: claims.u_name || (data.user && data.user.name) || 'Patron',
        emailMasked: claims.u_email_masked || '',
        tier: claims.u_tier || 'standard',
        currency: claims.u_curr || 'USD',
        tenantId: claims.tenant_id || this.tenantId,
        points: claims.u_pts || 0,
      },
    };

    await idbPut(STORE_SESSIONS, {
      ...session,
      tenantId: this.tenantId,
    });

    return session;
  }

  /**
   * Retrieves the active session from IndexedDB if not expired
   */
  async getSession(): Promise<StoredSession | null> {
    const session = await idbGet<StoredSession & { tenantId: string }>(STORE_SESSIONS, this.tenantId);
    if (!session) return null;

    if (Date.now() >= session.expiresAt) {
      await this.signOut();
      return null;
    }

    return session;
  }

  /**
   * Authenticated fetch helper: Automatically attaches Authorization and RFC 9449 DPoP proof
   */
  async fetchWithDPoP(url: string, init: RequestInit = {}): Promise<Response> {
    const session = await this.getSession();
    if (!session) {
      throw new Error('No active authenticated session');
    }

    const method = init.method || 'GET';
    const dpopProof = await this.createDPoPProof(method, url, session.accessToken);

    const headers = new Headers(init.headers || {});
    headers.set('Authorization', `DPoP ${session.accessToken}`);
    headers.set('DPoP', dpopProof);

    const res = await fetch(url, {
      ...init,
      headers,
    });

    // Unified Hard Logout on 401 Unauthorized
    if (res.status === 401) {
      await this.signOut();
    }

    return res;
  }

  /**
   * Deterministic Hard Logout: Permanently purges session and private CryptoKey for this tenant
   */
  async signOut(): Promise<void> {
    try {
      await idbDelete(STORE_SESSIONS, this.tenantId);
      await idbDelete(STORE_KEYS, this.tenantId);
    } catch {}
  }

  /**
   * Helper to inspect JWT claims payload without full cryptographic verification
   */
  private decodeJwtClaims(jwt: string): Record<string, any> {
    try {
      const parts = jwt.split('.');
      if (parts.length >= 2) {
        return JSON.parse(base64UrlDecodeToString(parts[1]));
      }
    } catch {}
    return {};
  }
}
