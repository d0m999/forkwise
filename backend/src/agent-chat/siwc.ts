import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { DomainError, requireThat } from '../domain/errors.js';
import { codexProxyEnvironment } from './mac-proxy.js';

const ISSUER = 'https://auth.openai.com';
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const JWKS = `${ISSUER}/.well-known/jwks.json`;
const RESOURCE = 'https://api.openai.com/v1';
const DYNAMIC_CLIENT = 'dynamic_agent_client';
const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
const RESOURCE_SCOPE = 'resource.invoke';
const SCOPES = ['openid', 'profile', 'email', 'offline_access', RESOURCE_SCOPE, DIRECT_SCOPE];
const ATTEMPT_LIFETIME = 10 * 60_000;
const RENEWAL_WINDOW = 30_000;
const SIGN_IN_MESSAGE = '请先使用 ChatGPT 登录，并允许见岔使用你的套餐额度。';
const CONSENT_MESSAGE = '当前登录尚未允许见岔使用 ChatGPT 套餐额度。请重新授权并允许该权限。';
const STORAGE_MESSAGE = '无法读取或保存见岔的 ChatGPT 凭据。请检查本机凭据文件权限后重试。';
const REFRESH_ERRORS = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

const token = z.string().min(1);
const bearerToken = z.string().regex(/^[A-Za-z0-9._~+/-]+=*$/);
const issuedClient = z
  .string()
  .regex(/^[A-Za-z0-9._~-]{1,255}$/)
  .refine((value) => value !== DYNAMIC_CLIENT);
const grantSchema = z.object({
  accessToken: bearerToken,
  refreshToken: token.optional(),
  expiresAt: z.number().positive(),
  earliestRefreshAt: z.number().positive().optional(),
  scopes: z.array(z.string()),
});
const registrationSchema = z.object({
  clientId: issuedClient,
  subject: token,
  idToken: token.optional(),
  grant: grantSchema.optional(),
  needsConsent: z.boolean(),
});
const localStateSchema = z.object({
  hostId: z.string().regex(/^urn:uuid:[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i),
  registration: registrationSchema.optional(),
});
const tokenResponseSchema = z.object({
  id_token: token.optional(),
  access_token: bearerToken.optional(),
  refresh_token: token.optional(),
  expires_in: z.number().int().positive().optional(),
  earliest_refresh_at: z.union([z.number().positive(), z.string()]).optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});
const jwksSchema = z.object({ keys: z.array(z.looseObject({ kty: z.string() })) });
const oauthErrorSchema = z.object({ error: z.string() });

type Grant = z.infer<typeof grantSchema>;
type Registration = z.infer<typeof registrationSchema>;
type LocalState = z.infer<typeof localStateSchema>;
type TokenResponse = z.infer<typeof tokenResponseSchema>;
type Attempt = {
  state: string;
  hostId: string;
  verifier: string;
  nonce: string;
  expiresAt: number;
  registration?: Registration | undefined;
};
type OpenAIRequest = (
  url: string,
  form?: URLSearchParams,
) => Promise<{ status: number; body: unknown }>;

function requestOpenAI(url: string, form?: URLSearchParams): ReturnType<OpenAIRequest> {
  const args = [
    '-q',
    '--proto',
    '=https',
    '--no-insecure',
    '--silent',
    '--connect-timeout',
    '10',
    '--max-time',
    '30',
    '--max-filesize',
    '1048576',
    '--header',
    'Accept: application/json',
    '--write-out',
    '\n%{http_code}',
  ];
  if (form) {
    args.push('--header', 'Content-Type: application/x-www-form-urlencoded', '--data-binary', '@-');
  }
  args.push('--url', url);
  const proxy = codexProxyEnvironment();
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    env[name] = proxy[name];
    env[name.toUpperCase()] = proxy[name.toUpperCase()];
  }
  return new Promise((resolve, reject) => {
    const unavailable = () =>
      new DomainError(
        'CHATGPT_NETWORK_UNAVAILABLE',
        '无法连接 OpenAI 授权服务。请检查网络或系统代理后重试。',
        503,
      );
    const child = execFile(
      '/usr/bin/curl',
      args,
      { env, maxBuffer: 1_050_000 },
      (error, stdout) => {
        if (error) {
          reject(unavailable());
          return;
        }
        const boundary = stdout.lastIndexOf('\n');
        const status = Number(stdout.slice(boundary + 1));
        let body: unknown;
        try {
          body = JSON.parse(stdout.slice(0, boundary));
        } catch {
          body = null;
        }
        resolve({ status, body });
      },
    );
    child.stdin?.on('error', () => reject(unavailable()));
    child.stdin?.end(form?.toString());
  });
}

function hasPlanPermission(scopes: readonly string[]): boolean {
  return scopes.includes(DIRECT_SCOPE) && scopes.includes(RESOURCE_SCOPE);
}

function readGrant(response: TokenResponse, scopes: string[], receivedAt: number): Grant {
  requireThat(
    response.token_type?.toLowerCase() === 'bearer' && response.access_token && response.expires_in,
    'CHATGPT_TOKEN_INVALID',
    'OpenAI 返回的授权凭据不完整，请重新授权。',
    503,
  );
  const earliest = response.earliest_refresh_at;
  const earliestRefreshAt =
    typeof earliest === 'number' ? earliest * 1_000 : earliest ? Date.parse(earliest) : NaN;
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: receivedAt + response.expires_in * 1_000,
    earliestRefreshAt: earliestRefreshAt > 0 ? earliestRefreshAt : undefined,
    scopes,
  };
}

export class ChatGptAuthorization {
  readonly #path: string;
  readonly #redirectUri: string;
  #localState: LocalState | undefined;
  #storageFailed = false;
  #attempt: Attempt | undefined;
  #finishing: Promise<void> | undefined;
  #refreshing: Promise<string> | undefined;
  #notice: string | undefined;

  constructor(
    directory: string,
    origin: string,
    private readonly request: OpenAIRequest = requestOpenAI,
  ) {
    const parsed = new URL(origin);
    requireThat(
      parsed.origin === origin && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1',
      'CHATGPT_CALLBACK_UNAVAILABLE',
      '当前工作台地址不支持 ChatGPT 本机授权。',
      503,
    );
    this.#redirectUri = `${origin}/auth/callback`;
    this.#path = join(directory, 'siwc.json');
    try {
      const descriptor = openSync(
        this.#path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const file = fstatSync(descriptor);
        if (
          !file.isFile() ||
          file.nlink !== 1 ||
          (file.mode & 0o077) !== 0 ||
          file.uid !== process.getuid?.()
        ) {
          throw new Error('invalid credential permissions');
        }
        this.#localState = localStateSchema.parse(JSON.parse(readFileSync(descriptor, 'utf8')));
      } finally {
        closeSync(descriptor);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#storageFailed = true;
    }
  }

  begin(): string {
    requireThat(!this.#storageFailed, 'CHATGPT_CREDENTIAL_STORAGE', STORAGE_MESSAGE, 503);
    requireThat(
      !this.#finishing,
      'CHATGPT_AUTHORIZATION_PENDING',
      '见岔正在完成 ChatGPT 授权，请稍候。',
      409,
    );
    const state = this.#localState ?? { hostId: `urn:uuid:${randomUUID()}` };
    if (!this.#localState) this.#save(state);
    const registration = state.registration;
    const attempt = {
      state: randomBytes(32).toString('base64url'),
      hostId: state.hostId,
      verifier: randomBytes(32).toString('base64url'),
      nonce: randomBytes(32).toString('base64url'),
      expiresAt: Date.now() + ATTEMPT_LIFETIME,
      registration,
    };
    const authorization = new URL(AUTHORIZE);
    authorization.search = new URLSearchParams({
      client_id: registration?.clientId ?? DYNAMIC_CLIENT,
      ext_agent_host_id: state.hostId,
      response_type: 'code',
      redirect_uri: this.#redirectUri,
      scope: SCOPES.join(' '),
      resource: RESOURCE,
      state: attempt.state,
      nonce: attempt.nonce,
      code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    if (!registration) authorization.searchParams.set('agent_name_hint', '见岔（Forkwise）');
    if (registration?.needsConsent) authorization.searchParams.set('prompt', 'consent');

    this.#notice = undefined;
    this.#attempt = attempt;
    return authorization.href;
  }

  async finish(url: URL): Promise<void> {
    const attempt = this.#attempt;
    const query = url.searchParams;
    requireThat(
      `${url.origin}${url.pathname}` === this.#redirectUri &&
        attempt &&
        attempt.expiresAt > Date.now() &&
        query.getAll('state').length === 1 &&
        query.get('state') === attempt.state,
      'CHATGPT_CALLBACK_INVALID',
      'ChatGPT 授权已过期或无法匹配。请从见岔重新发起授权。',
      400,
    );
    this.#attempt = undefined;

    if (query.has('error')) {
      this.#notice =
        query.get('error') === 'access_denied'
          ? '已取消 ChatGPT 授权。需要时可以从见岔重新发起。'
          : 'ChatGPT 授权未完成。请从见岔重新发起。';
      throw new DomainError('CHATGPT_AUTHORIZATION_REJECTED', this.#notice, 403);
    }
    const code = query.get('code');
    const clientId = issuedClient.safeParse(
      query.get('client_id') ?? attempt.registration?.clientId,
    );
    requireThat(
      code &&
        query.getAll('code').length === 1 &&
        query.getAll('client_id').length <= 1 &&
        clientId.success &&
        (!attempt.registration || clientId.data === attempt.registration.clientId),
      'CHATGPT_CALLBACK_INVALID',
      'ChatGPT 授权回调不完整。请从见岔重新发起授权。',
      400,
    );

    const completion = this.#complete(attempt, code, clientId.data);
    this.#finishing = completion;
    try {
      await completion;
    } catch (error) {
      const failure =
        error instanceof DomainError
          ? error
          : new DomainError(
              'CHATGPT_CALLBACK_INVALID',
              '无法完成 ChatGPT 授权。请从见岔重新发起。',
              400,
            );
      this.#notice = failure.message;
      throw failure;
    } finally {
      this.#finishing = undefined;
    }
  }

  status(): { authorized: boolean; message?: string } {
    const registration = this.#localState?.registration;
    const grant = registration?.grant;
    if (
      grant &&
      hasPlanPermission(grant.scopes) &&
      (grant.expiresAt > Date.now() ||
        (grant.refreshToken && (grant.earliestRefreshAt ?? 0) <= Date.now()))
    ) {
      return { authorized: true };
    }
    return {
      authorized: false,
      message:
        this.#notice ??
        (this.#storageFailed
          ? STORAGE_MESSAGE
          : registration?.needsConsent
            ? CONSENT_MESSAGE
            : SIGN_IN_MESSAGE),
    };
  }

  async token(): Promise<string> {
    await this.#finishing?.catch(() => undefined);
    const state = this.#localState;
    const registration = state?.registration;
    const grant = registration?.grant;
    if (!state || !grant || !hasPlanPermission(grant.scopes)) {
      const { message } = this.status();
      throw new DomainError(
        'CHATGPT_AUTHORIZATION_REQUIRED',
        message ?? SIGN_IN_MESSAGE,
        registration?.needsConsent ? 403 : 401,
      );
    }
    const now = Date.now();
    if (grant.expiresAt > now + RENEWAL_WINDOW) return grant.accessToken;
    if (!grant.refreshToken || (grant.earliestRefreshAt ?? 0) > now) {
      if (grant.expiresAt > now) return grant.accessToken;
      throw new DomainError(
        'CHATGPT_AUTHORIZATION_REQUIRED',
        'ChatGPT 授权已过期。请回到见岔重新授权。',
        401,
      );
    }

    this.#refreshing ??= this.#refresh(
      state.hostId,
      registration,
      grant,
      grant.refreshToken,
    ).finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #complete(attempt: Attempt, code: string, clientId: string): Promise<void> {
    await this.#refreshing?.catch(() => undefined);
    const result = await this.request(
      TOKEN,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        code_verifier: attempt.verifier,
        redirect_uri: this.#redirectUri,
        resource: RESOURCE,
      }),
    );
    const receivedAt = Date.now();
    requireThat(
      result.status === 200,
      'CHATGPT_TOKEN_EXCHANGE_FAILED',
      'ChatGPT 授权交换失败。请检查网络，或从见岔重新发起授权。',
      result.status >= 500 || result.status === 429 ? 503 : 403,
    );
    const parsed = tokenResponseSchema.safeParse(result.body);
    requireThat(
      parsed.success && parsed.data.id_token,
      'CHATGPT_TOKEN_INVALID',
      'OpenAI 未返回有效的登录凭据，请重新授权。',
      403,
    );
    const response = parsed.data;
    const idToken = parsed.data.id_token;
    const keys = await this.request(JWKS);
    const jwks = jwksSchema.safeParse(keys.body);
    requireThat(
      keys.status === 200 && jwks.success,
      'CHATGPT_SIGNING_KEYS_UNAVAILABLE',
      '无法取得 OpenAI 登录验证信息。请检查网络后重试。',
      503,
    );

    let subject: string;
    try {
      const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks.data), {
        issuer: ISSUER,
        audience: clientId,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
        clockTolerance: 5,
      });
      const authorizedPartyMatches =
        (payload.azp === undefined || payload.azp === clientId) &&
        (!Array.isArray(payload.aud) || payload.aud.length === 1 || payload.azp === clientId);
      const accessTokenMatches =
        payload.at_hash === undefined ||
        (response.access_token &&
          payload.at_hash ===
            createHash('sha256')
              .update(response.access_token)
              .digest()
              .subarray(0, 16)
              .toString('base64url'));
      if (
        !payload.sub?.trim() ||
        payload.nonce !== attempt.nonce ||
        !authorizedPartyMatches ||
        !accessTokenMatches ||
        (attempt.registration && payload.sub !== attempt.registration.subject)
      ) {
        throw new Error('invalid identity claims');
      }
      subject = payload.sub;
    } catch {
      throw new DomainError(
        'CHATGPT_IDENTITY_INVALID',
        'ChatGPT 账号验证失败。请从见岔重新授权。',
        403,
      );
    }

    const scopes = response.scope?.split(/\s+/).filter(Boolean) ?? [];
    const needsConsent = !hasPlanPermission(scopes);
    const grant = needsConsent ? undefined : readGrant(response, scopes, receivedAt);
    this.#save({
      hostId: attempt.hostId,
      registration: { clientId, subject, idToken, grant, needsConsent },
    });
    if (needsConsent) {
      throw new DomainError('CHATGPT_PLAN_PERMISSION_REQUIRED', CONSENT_MESSAGE, 403);
    }
  }

  async #refresh(
    hostId: string,
    registration: Registration,
    grant: Grant,
    refreshToken: string,
  ): Promise<string> {
    const result = await this.request(
      TOKEN,
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: registration.clientId,
        refresh_token: refreshToken,
        resource: RESOURCE,
      }),
    );
    const receivedAt = Date.now();
    if (result.status !== 200) {
      const error = oauthErrorSchema.safeParse(result.body);
      if (error.success && REFRESH_ERRORS.has(error.data.error)) {
        this.#save({
          hostId,
          registration: { ...registration, grant: undefined, idToken: undefined },
        });
        throw new DomainError(
          'CHATGPT_AUTHORIZATION_REQUIRED',
          'ChatGPT 授权已失效。请回到见岔重新授权。',
          401,
        );
      }
      if (error.success && error.data.error === 'invalid_client') {
        throw new DomainError(
          'CHATGPT_CLIENT_INVALID',
          'OpenAI 未接受见岔的 ChatGPT 客户端登记。请检查授权配置。',
          403,
        );
      }
      throw new DomainError(
        'CHATGPT_REFRESH_FAILED',
        '暂时无法续期 ChatGPT 授权，请稍后重试。',
        503,
      );
    }

    const parsed = tokenResponseSchema.safeParse(result.body);
    requireThat(
      parsed.success,
      'CHATGPT_TOKEN_INVALID',
      'OpenAI 返回的续期凭据无效，请重新授权。',
      503,
    );
    const response = parsed.data;
    const scopes = response.scope?.split(/\s+/).filter(Boolean) ?? grant.scopes;
    if (!hasPlanPermission(scopes)) {
      this.#save({
        hostId,
        registration: { ...registration, grant: undefined, needsConsent: true },
      });
      throw new DomainError('CHATGPT_PLAN_PERMISSION_REQUIRED', CONSENT_MESSAGE, 403);
    }
    requireThat(
      response.refresh_token,
      'CHATGPT_TOKEN_INVALID',
      'OpenAI 未返回新的续期凭据，请重新授权。',
      503,
    );
    const replacement = readGrant(response, scopes, receivedAt);
    this.#save({ hostId, registration: { ...registration, grant: replacement } });
    return replacement.accessToken;
  }

  #save(state: LocalState): void {
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    let created = false;
    try {
      const descriptor = openSync(temporary, 'wx', 0o600);
      created = true;
      try {
        writeFileSync(descriptor, JSON.stringify(state));
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporary, this.#path);
      this.#localState = state;
    } catch {
      if (created) {
        try {
          unlinkSync(temporary);
        } catch {
          // A failed cleanup must not disclose the private path or credential content.
        }
      }
      throw new DomainError('CHATGPT_CREDENTIAL_STORAGE', STORAGE_MESSAGE, 503);
    }
  }
}
