import { expect, it } from 'vitest';
import { lifecycleFixture } from './connector-lifecycle-fixture.js';
import { connectorTransport } from './connector-transport-fixture.js';

it('真实HTTP读取普通连线不可变版本且编辑删除撤销重开不改旧值', async () => {
  const f = lifecycleFixture(), http = connectorTransport(f);
  try {
    const a = f.card('a'), b = f.card('b');
    const original = f.connector('线/特殊? #🧠', f.bound(a.item.id, 'right'), f.bound(b.item.id, 'left'));
    await http.start();
    const assertOriginal = async () => {
      const response = await http.get(`/api/mapping/projects/p/versions/connector/${encodeURIComponent(original.id)}/${original.versionId}`);
      expect(response.status).toBe(200); expect(await response.json()).toEqual(original);
      expect(f.mapping.read({ type: 'version', projectId: 'p', domain: 'connector', id: original.id, versionId: original.versionId }, f.human)).toEqual(original);
    };
    await assertOriginal();
    f.run({ type: 'connector.path', expected: original.versionId, payload: { id: original.id, path: 'curve' } });
    const edited = f.state().connectors![0]!; await assertOriginal();
    f.run({ type: 'connector.reconnect', expected: edited.versionId, payload: { id: original.id, endpoint: 'end', value: f.free(240, -80) } });
    const reconnected = f.state().connectors![0]!; await assertOriginal();
    expect(reconnected.versionId).not.toBe(edited.versionId);
    f.run({ type: 'connector.delete', expected: reconnected.versionId, payload: { id: original.id } });
    expect(f.state().connectors).toEqual([]); await assertOriginal();
    f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
    const restored = f.state().connectors![0]!;
    expect(restored).toEqual({ ...reconnected, versionId: expect.any(String) });
    expect(restored.versionId).not.toBe(reconnected.versionId); await assertOriginal();
    await http.close(); f.reopen(); await http.start();
    expect(f.state().connectors).toEqual([restored]); await assertOriginal();
    const editedResponse = await http.get(`/api/mapping/projects/p/versions/connector/${encodeURIComponent(original.id)}/${edited.versionId}`);
    expect(editedResponse.status).toBe(200); expect(await editedResponse.json()).toEqual(edited);
  } finally { await http.close(); f.close(); }
});
