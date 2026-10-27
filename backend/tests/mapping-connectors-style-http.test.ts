import { expect, it } from 'vitest';
import { lifecycleFixture } from './connector-lifecycle-fixture.js';
import { connectorTransport } from './connector-transport-fixture.js';

it('真实HTTP按项目授权写入连线样式标签并保留原命令幂等和版本冲突', async () => {
  const f = lifecycleFixture({}, '连线HTTP样式'), http = connectorTransport(f);
  try {
    let line = f.connector('line', f.free(0, 0), f.free(200, 120));
    await http.start();
    const readOnly = f.mapping.access.issue('agent', ['p']);
    const post = (command: unknown, token = f.token) => fetch(http.origin + '/api/mapping/execute', {
      method: 'POST', headers: { Origin: http.origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command),
    });
    const style = { commandId: 'style', projectId: 'p', type: 'connector.style', expected: line.versionId,
      payload: { id: line.id, style: { endMarker: 'triangle', color: '#123456' } } };
    const before = f.state();
    expect((await post(style, readOnly)).status).toBe(403);
    expect(f.state()).toEqual(before);
    const response = await post(style), receipt = await response.json();
    expect(response.status).toBe(200);
    line = f.state().connectors![0]!;
    expect(line.style).toMatchObject({ endMarker: 'triangle', color: '#123456' });
    const label = { text: '多行\n标签', position: 0.75, fontSize: 16, color: '#403b36', bold: false };
    expect((await post({ commandId: 'label', projectId: 'p', type: 'connector.label', expected: line.versionId, payload: { id: line.id, label } })).status).toBe(200);
    const saved = f.state(), history = f.history();
    expect(saved.connectors![0]!.label).toEqual(label);
    expect(await (await post(style)).json()).toEqual(receipt);
    expect(f.state()).toEqual(saved); expect(f.history()).toEqual(history);
    expect((await post({ ...style, commandId: 'stale-style' })).status).toBe(409);
    expect(f.state()).toEqual(saved); expect(f.history()).toEqual(history);
    const version = await http.get(`/api/mapping/projects/p/versions/connector/line/${saved.connectors![0]!.versionId}`);
    expect(version.status).toBe(200); expect(await version.json()).toEqual(saved.connectors![0]);
  } finally { await http.close(); f.close(); }
});
