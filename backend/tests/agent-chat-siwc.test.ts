import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { codexProxyEnvironment } from '../src/agent-chat/mac-proxy.js';
import { ChatGptAuthorization } from '../src/agent-chat/siwc.js';

const issuer = 'https://auth.openai.com';
const origin = 'http://127.0.0.1:4173';
const clientId = 'oaiapp_test';
const callbackPath = '/auth/callback';
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const directories: string[] = [];
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let keys: { keys: unknown[] };

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  keys = {
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'kid-test', alg: 'RS256', use: 'sig' }],
  };
});

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-siwc-'));
  directories.push(directory);
  const request = vi.fn<NonNullable<ConstructorParameters<typeof ChatGptAuthorization>[2]>>();
  const service = new ChatGptAuthorization(directory, origin, request);
  return { service, request, directory };
}

function callback(authorization: URL, extra: Record<string, string> = {}): URL {
  const url = new URL(callbackPath, origin);
  url.search = new URLSearchParams({
    state: authorization.searchParams.get('state')!,
    code: 'code-test',
    client_id: clientId,
    ...extra,
  }).toString();
  return url;
}

async function approved(authorization: URL, claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const idToken = await new SignJWT({
    nonce: authorization.searchParams.get('nonce'),
    iss: issuer,
    aud: clientId,
    sub: 'subject-test',
    exp: now + 3600,
    iat: now,
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'kid-test' })
    .sign(privateKey);
  return {
    id_token: idToken,
    access_token: 'access-test',
    token_type: 'Bearer',
    refresh_token: 'refresh-test',
    expires_in: 3600,
    scope: scopes,
  };
}

describe('ChatGPT plan authorization', () => {
  it('uses fresh proofs and rejects wrong callbacks, denied consent, and replay before exchanging a code', async () => {
    const { service, request } = fixture();
    expect(service.status()).toMatchObject({ authorized: false });
    await expect(service.token()).rejects.toMatchObject({ status: 401 });
    const url = new URL(service.begin());
    expect(url.origin + url.pathname).toBe(issuer + '/api/accounts/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      agent_name_hint: '见岔（Forkwise）',
      client_id: 'dynamic_agent_client',
      redirect_uri: origin + callbackPath,
      code_challenge_method: 'S256',
      response_type: 'code',
      resource: 'https://api.openai.com/v1',
      scope: scopes,
    });
    expect(url.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
    await expect(service.finish(callback(url, { state: 'wrong' }))).rejects.toMatchObject({
      status: 400,
    });
    const wrongPath = callback(url);
    wrongPath.pathname = '/callback';
    await expect(service.finish(wrongPath)).rejects.toMatchObject({ status: 400 });
    await expect(
      service.finish(
        callback(url, { error: 'access_denied', error_description: 'private-detail' }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(service.status().message).toContain('取消');
    expect(service.status().message).not.toContain('private-detail');
    await expect(service.finish(callback(url))).rejects.toMatchObject({ status: 400 });
    expect(request).not.toHaveBeenCalled();

    vi.useFakeTimers();
    const second = new URL(service.begin());
    expect(second.searchParams.get('ext_agent_host_id')).toBe(
      url.searchParams.get('ext_agent_host_id'),
    );
    for (const name of ['state', 'nonce', 'code_challenge']) {
      expect(second.searchParams.get(name)).not.toBe(url.searchParams.get(name));
    }
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await expect(service.finish(callback(second))).rejects.toMatchObject({ status: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it('validates a signed identity, exchanges the exact callback and stores only a private credential file', async () => {
    const { service, request, directory } = fixture();
    const url = new URL(service.begin());
    request
      .mockResolvedValueOnce({ status: 200, body: await approved(url) })
      .mockResolvedValueOnce({ status: 200, body: keys });
    await service.finish(callback(url));
    const form = request.mock.calls[0]?.[1];
    expect(form && Object.fromEntries(form)).toMatchObject({
      client_id: clientId,
      code: 'code-test',
      grant_type: 'authorization_code',
      redirect_uri: origin + callbackPath,
      resource: 'https://api.openai.com/v1',
    });
    expect(createHash('sha256').update(form!.get('code_verifier')!).digest('base64url')).toBe(
      url.searchParams.get('code_challenge'),
    );
    expect(request.mock.calls[1]).toEqual([issuer + '/.well-known/jwks.json']);
    expect(service.status()).toEqual({ authorized: true });
    await expect(service.token()).resolves.toBe('access-test');
    expect(readdirSync(directory)).toEqual(['siwc.json']);
    const path = join(directory, 'siwc.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const restarted = new ChatGptAuthorization(directory, 'http://127.0.0.1:4174', request);
    await expect(restarted.token()).resolves.toBe('access-test');
    const returning = new URL(restarted.begin());
    expect(returning.searchParams.get('ext_agent_host_id')).toBe(
      url.searchParams.get('ext_agent_host_id'),
    );
    expect(returning.searchParams.get('client_id')).toBe(clientId);
    expect(returning.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:4174/auth/callback');
    expect(returning.searchParams.has('agent_name_hint')).toBe(false);
    expect(returning.searchParams.has('id_token_hint')).toBe(false);
    chmodSync(path, 0o644);
    const unsafeStorage = new ChatGptAuthorization(directory, origin, request);
    await expect(unsafeStorage.token()).rejects.toMatchObject({ status: 401 });
  });

  it('does not grant plan use from callback scopes or a mismatched nonce', async () => {
    const { service, request } = fixture();
    const mismatched = new URL(service.begin());
    request
      .mockResolvedValueOnce({ status: 200, body: await approved(mismatched, { nonce: 'wrong' }) })
      .mockResolvedValueOnce({ status: 200, body: keys });
    await expect(service.finish(callback(mismatched))).rejects.toMatchObject({
      code: 'CHATGPT_IDENTITY_INVALID',
    });
    await expect(service.token()).rejects.toMatchObject({ status: 401 });

    const url = new URL(service.begin());
    request
      .mockResolvedValueOnce({
        status: 200,
        body: { ...(await approved(url)), scope: 'openid resource.invoke' },
      })
      .mockResolvedValueOnce({ status: 200, body: keys });
    await expect(service.finish(callback(url, { scope: scopes }))).rejects.toMatchObject({
      code: 'CHATGPT_PLAN_PERMISSION_REQUIRED',
      status: 403,
    });
    await expect(service.token()).rejects.toMatchObject({ status: 403 });
    const retry = new URL(service.begin());
    expect(retry.searchParams.get('client_id')).toBe(clientId);
    expect(retry.searchParams.get('prompt')).toBe('consent');
    const changedClient = callback(retry, { client_id: 'oaiapp_wrong' });
    await expect(service.finish(changedClient)).rejects.toMatchObject({ status: 400 });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('preserves a verified registration when a returning sign-in carries a different audience or subject', async () => {
    const { service, request } = fixture();
    const first = new URL(service.begin());
    request
      .mockResolvedValueOnce({ status: 200, body: await approved(first) })
      .mockResolvedValueOnce({ status: 200, body: keys });
    await service.finish(callback(first));

    for (const claims of [{ aud: 'oaiapp_other' }, { sub: 'subject-other' }]) {
      const returning = new URL(service.begin());
      request
        .mockResolvedValueOnce({
          status: 200,
          body: { ...(await approved(returning, claims)), access_token: 'access-rejected' },
        })
        .mockResolvedValueOnce({ status: 200, body: keys });
      const returned = callback(returning);
      returned.searchParams.delete('client_id');
      await expect(service.finish(returned)).rejects.toMatchObject({
        code: 'CHATGPT_IDENTITY_INVALID',
      });
      await expect(service.token()).resolves.toBe('access-test');
    }
  });

  it('rotates a single renewable session for concurrent sends and retains the registration after revocation', async () => {
    const { service, request, directory } = fixture();
    const url = new URL(service.begin());
    request
      .mockResolvedValueOnce({ status: 200, body: { ...(await approved(url)), expires_in: 1 } })
      .mockResolvedValueOnce({ status: 200, body: keys });
    await service.finish(callback(url));
    request.mockResolvedValueOnce({
      status: 200,
      body: {
        access_token: 'access-next',
        refresh_token: 'refresh-next',
        expires_in: 1,
        token_type: 'Bearer',
      },
    });
    await expect(Promise.all([service.token(), service.token()])).resolves.toEqual([
      'access-next',
      'access-next',
    ]);
    expect(request).toHaveBeenCalledTimes(3);
    const firstRefresh = request.mock.calls[2]?.[1];
    expect(firstRefresh && Object.fromEntries(firstRefresh)).toEqual({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: 'refresh-test',
      resource: 'https://api.openai.com/v1',
    });

    const restarted = new ChatGptAuthorization(directory, origin, request);
    request.mockResolvedValueOnce({ status: 400, body: { error: 'invalid_grant' } });
    await expect(restarted.token()).rejects.toMatchObject({ status: 401 });
    expect(request.mock.calls[3]?.[1]?.get('refresh_token')).toBe('refresh-next');
    expect(restarted.status()).toMatchObject({ authorized: false });
    expect(new URL(restarted.begin()).searchParams.get('client_id')).toBe(clientId);
  });
});

it('fills missing Mac proxy variables without replacing shell or bypass settings', () => {
  const settings = () => `<dictionary> {
    ExceptionsList : <array> {
      0 : *.local
      1 : 10.0.0.0/8
      2 : <local>
    }
    HTTPEnable : 1
    HTTPProxy : 127.0.0.1
    HTTPPort : 7897
    HTTPSEnable : 1
    HTTPSProxy : ::1
    HTTPSPort : 8443
  }`;
  const detected = codexProxyEnvironment({}, 'darwin', settings);
  expect(detected).toMatchObject({
    http_proxy: 'http://127.0.0.1:7897',
    https_proxy: 'http://[::1]:8443',
    NO_PROXY: 'localhost,127.0.0.1,::1,.local,10.0.0.0/8',
  });
  const shell = { https_proxy: 'http://proxy.example:8080', no_proxy: 'custom.example' };
  expect(codexProxyEnvironment(shell, 'darwin', settings)).toMatchObject(shell);
  expect(codexProxyEnvironment(shell, 'linux', settings)).toEqual(shell);
  const all = { ALL_PROXY: 'http://proxy.example:8080' };
  expect(codexProxyEnvironment(all, 'darwin', settings)).toEqual(all);
});
