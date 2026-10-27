import { afterEach, expect, it } from 'vitest';
import { groupFixture, closeGroupFixtures } from './group-fixture.js';
import { groupHttp } from './group-protocol-fixture.js';
afterEach(closeGroupFixtures);

it('HTTP严格版本白名单读取Group与containment不可变记录，变更undo重开和权限仍保持原值', async () => {
  const f = groupFixture(), a = f.card(), b = f.shape(), group = f.group([a.item.id, b.item.id]), state = f.state();
  expect(group.memberItemIds).toEqual([a.item.id, b.item.id]);
  const record = { id: group.id, itemId: group.itemId, versionId: group.versionId, createdOrder: group.createdOrder };
  const membership = state.containment!.find(c => c.id === a.item.id)!;
  expect(f.mapping.read({ type: 'version', projectId: 'p', domain: 'group', id: group.id, versionId: group.versionId }, f.human)).toEqual(record);
  expect(f.mapping.read({ type: 'version', projectId: 'p', domain: 'containment', id: membership.id, versionId: membership.versionId }, f.human)).toEqual(membership);
  const http = groupHttp(f);
  try {
    await http.start();
    expect((await http.get(`/api/mapping/projects/p/versions/pose/${a.item.id}/${a.item.versionId}`)).status).toBe(200);
    const root = await (await http.get('/api/mapping/projects/p/map?view=index')).json();
    const checks = async () => {
      for (const [domain, id, version, expected] of [['group', group.id, group.versionId, record], ['containment', membership.id, membership.versionId, membership]] as const) {
        const response = await http.get(`/api/mapping/projects/p/versions/${domain}/${encodeURIComponent(id)}/${version}`);
        expect(response.status).toBe(200); expect(await response.json()).toEqual(expected);
      }
    };
    await checks();
    f.execute({ type: 'group.remove-member', expected: { group: group.versionId, containment: membership.versionId }, payload: { id: group.id, itemId: a.item.id } });
    await checks();
    const pinned = await (await http.get('/api/mapping/projects/p/map?' + new URLSearchParams({ view: 'group-index', snapshot: root.snapshot }))).json();
    expect(pinned).toMatchObject({ revision: root.revision, snapshot: root.snapshot, items: [{ id: group.id, memberCount: 2 }] });
    f.travel('history.undo'); await checks();
    await http.close(); f.reopen(); await http.start(); await checks();
    const foreign = f.mapping.access.issue('agent', ['q']);
    expect((await http.get(`/api/mapping/projects/p/versions/group/${group.id}/${group.versionId}`, foreign)).status).toBe(403);
    expect((await http.get(`/api/mapping/projects/p/versions/not-a-domain/${group.id}/${group.versionId}`)).status).toBe(400);
  } finally { await http.close(); }
});
