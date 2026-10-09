// Keep guards scoped to the objects this operation actually relies on.
export function expectedVersions(objects, commands) {
  const map = new Map(objects.map((e) => [e.id, e]));
  const ids = new Set();
  const need = (id) => {
    if (map.has(id)) ids.add(id);
  };
  const endpoints = (e) => {
    if (e?.kind === 'inference') [...e.data.premiseIds, e.data.conclusionId].forEach(need);
  };
  const incoming = (id) => objects.filter((e) => references(e).includes(id));
  for (const c of commands) {
    const e = map.get(c.id);
    switch (c.op) {
      case 'verification.propose':
      case 'verification.confirm':
      case 'impact.review':
        need(c.id);
        need(c.target.id);
        c.context.forEach((r) => need(r.id));
        break;
      case 'impact.adopt':
        need(c.id);
        if (e?.kind === 'inference') endpoints(e);
        else if (c.scope === 'selected') c.inferenceIds.forEach(need);
        else
          incoming(c.id)
            .filter((x) => x.kind === 'inference')
            .forEach((x) => need(x.id));
        break;
      case 'statement.create':
        break;
      case 'statement.copy':
        need(c.id);
        incoming(c.id)
          .filter((x) => x.kind === 'material_membership' && x.data.visibility === 'included')
          .forEach((x) => need(x.id));
        break;
      case 'statement.edit':
        need(c.id);
        incoming(c.id)
          .filter((x) => x.kind === 'inference')
          .forEach((x) => need(x.id));
        break;
      case 'statement.derive':
        need(c.id);
        c.inferenceIds.forEach(need);
        break;
      case 'inference.create':
        c.data.premiseIds.forEach(need);
        need(c.data.conclusionId);
        break;
      case 'inference.edit':
        need(c.id);
        endpoints(e);
        c.premiseIds.forEach(need);
        need(c.conclusionId);
        break;
      case 'stance.set':
      case 'object.adopt':
        need(c.id);
        break;
      case 'condition.create':
        c.data.targetIds.forEach(need);
        break;
      case 'condition.edit':
        need(c.id);
        e?.data.targetIds.forEach(need);
        c.data.targetIds.forEach(need);
        break;
      case 'condition.derive':
        need(c.id);
        c.targetIds.forEach(need);
        break;
      case 'source.create':
        if (c.data.reprintOf) need(c.data.reprintOf);
        break;
      case 'source.import':
        need(c.sourceId);
        break;
      case 'evidence.create':
        break;
      case 'evidence.link':
        need(c.data.evidenceId);
        need(c.data.target.id);
        endpoints(map.get(c.data.target.id));
        break;
      case 'evidence.relate':
      case 'evidence.adopt':
        need(c.id);
        need(e.data.target.id);
        endpoints(map.get(e.data.target.id));
        break;
      case 'evaluation.propose':
      case 'evaluation.confirm':
        need(c.condition.id);
        c.evidenceIds.forEach(need);
        if (c.evaluationId) need(c.evaluationId);
        break;
      case 'note.create':
        need(c.targetId);
        break;
      case 'material.attach':
        need(c.id);
        need(c.targetId);
        need(c.sourceVersionId);
        break;
      case 'material.hide':
        need(c.id);
        need(e?.data.targetId);
        break;
      case 'object.delete': {
        const queue = [c.id],
          seen = new Set();
        for (const id of queue) {
          if (seen.has(id)) continue;
          seen.add(id);
          need(id);
          for (const x of incoming(id)) {
            need(x.id);
            if (x.kind !== 'condition') queue.push(x.id);
          }
        }
        break;
      }
      default:
        throw new Error('前端尚未支持此操作的版本依赖');
    }
  }
  return Object.fromEntries([...ids].map((id) => [id, map.get(id).version]));
}
function references(e) {
  switch (e.kind) {
    case 'inference':
      return [...e.data.premiseIds, e.data.conclusionId];
    case 'condition':
      return e.data.targetIds;
    case 'evidence_link':
      return [e.data.target.id, e.data.evidenceId];
    case 'evaluation':
      return [e.data.condition.id, ...e.data.evidenceIds];
    case 'verification_node':
    case 'review':
      return [e.data.target.id];
    case 'note':
      return [e.data.targetId];
    case 'material_membership':
      return [e.data.targetId, e.data.sourceVersionId];
    default:
      return [];
  }
}
