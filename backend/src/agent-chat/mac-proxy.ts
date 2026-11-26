import { execFileSync } from 'node:child_process';
import { isIP } from 'node:net';

function readSystemProxy(): string {
  try {
    return execFileSync('/usr/sbin/scutil', ['--proxy'], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

export function codexProxyEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  readSettings: () => string = readSystemProxy,
): NodeJS.ProcessEnv {
  const env = { ...inherited };
  const protocols = [
    { setting: 'HTTP', variable: 'http_proxy' },
    { setting: 'HTTPS', variable: 'https_proxy' },
  ] as const;
  if (platform !== 'darwin' || env.all_proxy || env.ALL_PROXY) return env;

  const missing = protocols.filter(
    ({ variable }) => !env[variable] && !env[variable.toUpperCase()],
  );
  if (missing.length === 0) return env;

  const settings = readSettings();
  let foundSystemProxy = false;
  for (const { setting, variable } of missing) {
    if (!new RegExp(`^\\s*${setting}Enable\\s*:\\s*1\\s*$`, 'm').test(settings)) continue;
    const host = settings.match(new RegExp(`^\\s*${setting}Proxy\\s*:\\s*(\\S+)\\s*$`, 'm'))?.[1];
    const rawPort = settings.match(new RegExp(`^\\s*${setting}Port\\s*:\\s*(\\d+)\\s*$`, 'm'))?.[1];
    const port = Number(rawPort);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) continue;
    const address = host.replace(/^\[(.*)\]$/, '$1');
    const ipv6 = isIP(address) === 6;
    if (!ipv6 && !/^[a-z\d.-]+$/i.test(address)) continue;

    const proxy = `http://${ipv6 ? `[${address}]` : address}:${port}`;
    env[variable] = proxy;
    env[variable.toUpperCase()] = proxy;
    foundSystemProxy = true;
  }
  if (foundSystemProxy && !env.no_proxy && !env.NO_PROXY) {
    const exceptionList = settings.match(/ExceptionsList\s*:\s*<array>\s*\{([^}]+)\}/)?.[1] ?? '';
    const exceptions = [...exceptionList.matchAll(/^\s*\d+\s*:\s*(\S+)\s*$/gm)]
      .map((entry) => (entry[1] ?? '').replace(/^\*\./, '.'))
      .filter((entry) => /^[a-z\d.:/-]+$/i.test(entry));
    const bypass = [...new Set(['localhost', '127.0.0.1', '::1', ...exceptions])].join(',');
    env.no_proxy = bypass;
    env.NO_PROXY = bypass;
  }
  return env;
}
