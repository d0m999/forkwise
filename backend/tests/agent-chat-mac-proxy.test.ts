import { expect, it } from 'vitest';
import { codexProxyEnvironment } from '../src/agent-chat/mac-proxy.js';

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
