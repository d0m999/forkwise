import { expectedVersions } from './operation-versions.js';
import { researchSummary, researchLabel } from './research-results.js';

const stable = (value) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
const stanceNames = { pending: '待研究', accepted: '认可', questioned: '质疑', rejected: '不认可' };
const origins = { user: '用户', author: '来源', ai: 'AI' };
export function canvasSnapshot(state, layout, selected, session = 1, overview = null) {
  const objects = state?.objects ?? [],
    cards = [],
    links = [];
  for (const [index, e] of objects
    .filter((e) => ['statement', 'inference'].includes(e.kind))
    .entries()) {
    const d = e.data,
      p = layout.data.positions[e.id] ?? {
        x: 80 + (index % 3) * 380,
        y: 80 + Math.floor(index / 3) * 240,
      };
    const research = researchLabel(researchSummary(state, overview, e.id));
    cards.push({
      id: e.id,
      kind: e.kind === 'statement' ? 'claim' : 'inference',
      text: e.kind === 'statement' ? d.text : d.reason,
      origin: origins[d.origin],
      stance: stanceNames[d.stance.value],
      checked: d.citations.some(
        (c) => objects.find((v) => v.id === c.sourceVersionId)?.data.textOrigin === 'ocr',
      )
        ? '引用含未核对转写'
        : d.citations.length
          ? '有材料定位'
          : '尚未引用材料',
      verification: research.status,
      verificationSummary: research.explanation,
      version: e.version,
      ...p,
      width: p.width ?? 300,
      height: p.height ?? 180,
      compact: false,
      affected: false,
      children: objects.filter((i) => i.kind === 'inference' && i.data.premiseIds.includes(e.id))
        .length,
      sources: d.citations.map((c) => {
        const version = objects.find((v) => v.id === c.sourceVersionId),
          source = objects.find((s) => s.id === version?.data.sourceId);
        return {
          ref:
            c.kind === 'image'
              ? { ...c, source: c.sourceVersionId, version: version?.version ?? 1 }
              : {
                  kind: 'text',
                  source: c.sourceVersionId,
                  version: version?.version ?? 1,
                  start: c.start,
                  end: c.end,
                  quote: c.quote,
                },
          label: c.kind === 'image' ? '原图区域' : '原文引用',
          title: source?.data.title ?? '来源',
          author: source?.data.publisher ?? '',
          published: version?.data.publishedAt ?? '未记录',
          period: '见材料版本',
          access: source?.data.rights ?? 'unknown',
          coverage: version?.data.coverage ?? 'unknown',
          available: !c.unavailableReason,
        };
      }),
      sourceNote: d.lineage ? '内容来历保留在修改历史中' : '按具体材料版本和原文位置回查',
      researchUse: d.participation === 'personal' ? 'research' : 'reference',
      canCorrectSource: false,
      ...(e.kind === 'inference'
        ? {
            combination: {
              independent: '单一前提',
              joint_required: '共同依赖',
              unspecified: '组合待说明',
            }[d.combination],
          }
        : {}),
    });
    if (e.kind === 'inference') {
      const ports = layout.data.ports?.[e.id];
      for (const id of d.premiseIds)
        links.push({
          id: `${e.id}-from-${id}`,
          relationId: e.id,
          from: id,
          to: e.id,
          ...(ports?.premises[id] ? { fromSide: ports.premises[id] } : {}),
        });
      links.push({
        id: `${e.id}-to`,
        relationId: e.id,
        from: e.id,
        to: d.conclusionId,
        ...(ports?.conclusion ? { toSide: ports.conclusion } : {}),
      });
    }
  }
  return {
    projectId: state?.project.id ?? 'empty',
    session,
    mode: 'mine',
    cards,
    links,
    selected,
    linkFrom: null,
    backend: true,
    directCanvas: true,
    simpleLinks: true,
    semanticDensity: 2,
    canvasState: layout.data.canvas ?? {
      scenes: {},
      annotations: { elements: [], files: {} },
      drafts: {},
    },
    history: { undoLabel: null, redoLabel: null },
  };
}

export function attachCanvas({
  frame,
  getState,
  getLayout,
  getSelected,
  isBusy,
  write,
  select,
  task,
  message,
  refresh,
  getHistory = () => null,
  getResearchOverview = () => null,
  travel,
  recovery,
  recoveryChanged,
}) {
  let ready = false,
    session = 0,
    projectId = null,
    restoreRevision = 0,
    lastLayoutVersion = -1,
    tail = Promise.resolve(),
    pending = 0;
  const post = (data) =>
    frame.contentWindow?.postMessage({ channel: 'forkwise-study', ...data }, location.origin);
  const publish = (force = false) => {
    const state = getState(),
      layout = getLayout();
    if (projectId !== state?.project.id) {
      projectId = state?.project.id;
      lastAcknowledgedLayout = null;
      session++;
      lastLayoutVersion = -1;
      restoreRevision++;
    }
    if (!ready) return;
    if (force || (layout.version !== lastLayoutVersion && pending === 0)) restoreRevision++;
    lastLayoutVersion = layout.version;
    post({
      type: 'state',
      engine: 'excalidraw',
      snapshot: {
        ...canvasSnapshot(state, layout, getSelected(), session, getResearchOverview()),
        canvasRestoreRevision: restoreRevision,
        history: {
          undoLabel: getHistory()?.undo?.label ?? null,
          redoLabel: getHistory()?.redo?.label ?? null,
        },
      },
    });
  };
  const command = (command, id) =>
    post({ type: 'command', engine: 'excalidraw', session, projectId, command, id });
  async function act(action, base, baseLayout) {
    if (!base) throw new Error('请先新建研究项目');
    const objects = base.objects,
      map = new Map(objects.map((e) => [e.id, e]));
    const data = structuredClone(baseLayout.data),
      commands = [];
    if (action.state) data.canvas = action.state;
    if (action.canvasState) data.canvas = action.canvasState;
    const addRelation = (from, to, fromSide, toSide) => {
      const id = crypto.randomUUID();
      commands.push({
        op: 'inference.create',
        id,
        data: {
          premiseIds: [from],
          conclusionId: to,
          reason: '',
          combination: 'independent',
          origin: 'user',
          participation: 'personal',
          stance: { value: 'pending', reason: '' },
          citations: [],
        },
      });
      data.ports ??= {};
      data.ports[id] = {
        premises: fromSide ? { [from]: fromSide } : {},
        ...(toSide ? { conclusion: toSide } : {}),
      };
    };
    switch (action.type) {
      case 'canvas-state':
        if (!action.commit) {
          // Native continuous events include in-progress drawings. Persist only
          // navigation/forms until the engine emits the gesture's explicit commit.
          const saved = baseLayout.data.canvas ?? {
            scenes: {},
            annotations: { elements: [], files: {} },
          };
          const transient = structuredClone(saved);
          for (const [id, scene] of Object.entries(action.state.scenes))
            if (scene.view) (transient.scenes[id] ??= { styles: {} }).view = scene.view;
          if (action.state.drafts) transient.drafts = action.state.drafts;
          if (action.state.returnViews) transient.returnViews = action.state.returnViews;
          data.canvas = transient;
        }
        break;
      case 'commit':
        for (const p of action.positions ?? [])
          data.positions[p.id] = {
            ...data.positions[p.id],
            x: p.x,
            y: p.y,
            ...action.sizes?.[p.id],
          };
        if (action.drop) addRelation(action.drop.parent, action.drop.child);
        break;
      case 'create': {
        const id = crypto.randomUUID();
        commands.push({
          op: 'statement.create',
          id,
          data: {
            text: action.text,
            origin: 'user',
            participation: 'personal',
            stance: { value: 'pending', reason: '' },
            citations: [],
          },
        });
        let position = { x: action.x, y: action.y };
        const occupied = canvasSnapshot(base, baseLayout, null).cards.filter(
          (c) => c.kind === 'claim',
        );
        for (let attempt = 0; attempt < occupied.length + 1; attempt++) {
          if (
            !occupied.some(
              (c) => Math.abs(c.x - position.x) < 320 && Math.abs(c.y - position.y) < 200,
            )
          )
            break;
          position = {
            x: action.x + 360 * ((attempt + 1) % 3),
            y: action.y + 240 * Math.floor((attempt + 1) / 3),
          };
        }
        data.positions[id] = position;
        if (action.conversion) {
          const canvas = data.canvas,
            ids = action.conversion.ids;
          const originals = ids.map((id) =>
            canvas?.annotations.elements.find((e) => e.id === id && !e.isDeleted),
          );
          const signature = JSON.stringify(
            originals.map((e) =>
              e
                ? [
                    e.id,
                    e.x,
                    e.y,
                    e.width,
                    e.height,
                    e.angle,
                    e.frameId,
                    e.type === 'text' ? e.originalText : null,
                  ]
                : null,
            ),
          );
          if (signature !== action.conversion.signature)
            throw new Error('原绘图已改变，转换未执行。请重新选择');
          canvas.annotations.elements = canvas.annotations.elements.filter(
            (e) => !ids.includes(e.id),
          );
          const scene = (canvas.scenes.mine ??= { styles: {} });
          scene.styles ??= {};
          if (action.conversion.style)
            scene.styles[`forkwise:${base.project.id}:mine:card:${id}`] = action.conversion.style;
        }
        if (data.canvas?.drafts) delete data.canvas.drafts.mine;
        break;
      }
      case 'connect':
      case 'convert-arrow':
        addRelation(action.from, action.to, action.fromSide, action.toSide);
        if (action.type === 'convert-arrow' && data.canvas)
          data.canvas.annotations.elements = data.canvas.annotations.elements.filter(
            (e) => !action.ids.includes(e.id),
          );
        break;
      case 'reconnect': {
        const e = map.get(action.id);
        if (e?.kind !== 'inference') throw new Error('推导已不存在，请重新读取');
        const same =
          action.end === 'premise'
            ? action.previous === action.target
            : e.data.conclusionId === action.target;
        if (!same)
          commands.push({
            op: 'inference.edit',
            id: e.id,
            premiseIds:
              action.end === 'premise'
                ? e.data.premiseIds.map((id) => (id === action.previous ? action.target : id))
                : e.data.premiseIds,
            conclusionId: action.end === 'conclusion' ? action.target : e.data.conclusionId,
            reason: e.data.reason,
            combination: e.data.combination,
          });
        data.ports ??= {};
        const ports = (data.ports[e.id] ??= { premises: {} });
        if (action.end === 'premise') {
          delete ports.premises[action.previous];
          ports.premises[action.target] = action.side ?? 'right';
        } else ports.conclusion = action.side ?? 'left';
        break;
      }
      case 'duplicate-card': {
        const id = crypto.randomUUID();
        commands.push({ op: 'statement.copy', id: action.id, newId: id });
        const p = data.positions[action.id] ?? { x: 80, y: 80 };
        data.positions[id] = { x: p.x + 80, y: p.y + 80 };
        break;
      }
      case 'delete': {
        const ids = [...new Set(action.ids ?? [action.id])];
        // Deleting a premise already deletes its dependent inferences in this batch.
        for (const id of ids)
          if (
            map.get(id)?.kind !== 'inference' ||
            !ids.some(
              (x) => map.get(id).data.premiseIds.includes(x) || map.get(id).data.conclusionId === x,
            )
          )
            commands.push({ op: 'object.delete', id });
        const deleted = new Set([
          ...ids,
          ...objects
            .filter(
              (e) =>
                e.kind === 'inference' &&
                [...e.data.premiseIds, e.data.conclusionId].some((id) => ids.includes(id)),
            )
            .map((e) => e.id),
        ]);
        for (const id of deleted) {
          delete data.positions[id];
          if (data.ports) delete data.ports[id];
        }
        if (data.canvas?.attachments)
          data.canvas.attachments = Object.fromEntries(
            Object.entries(data.canvas.attachments).filter(([, a]) => !deleted.has(a.target)),
          );
        break;
      }
      default:
        throw new Error('此画布操作尚未接通后端，请从右侧研究面板操作');
    }
    if (!commands.length && stable(data) === stable(baseLayout.data)) return;
    await write(commands, {
      expected: expectedVersions(objects, commands),
      layout: { expectedVersion: baseLayout.version, data },
    });
  }
  window.addEventListener('message', (event) => {
    if (
      event.origin !== location.origin ||
      event.source !== frame.contentWindow ||
      event.data?.channel !== 'forkwise-canvas'
    )
      return;
    if (event.data.ready) {
      ready = true;
      publish(true);
      return;
    }
    if (event.data.projectId !== projectId || event.data.session !== session) return;
    const action = event.data.event;
    if (!action) return;
    if (action.type === 'notice') {
      message(action.message);
      return;
    }
    if (action.type === 'overlay') return;
    if (action.type === 'select') {
      select(action.id);
      return;
    }
    if (action.type === 'image-material') {
      const originProject = projectId,
        expectedTargetVersion = getState()?.objects.find((e) => e.id === action.id)?.version;
      tail
        .then(() => {
          if (getState()?.project.id === originProject) task({ ...action, expectedTargetVersion });
        })
        .catch((error) => message(error.message));
      return;
    }
    if (['task', 'details', 'source'].includes(action.type)) {
      task(action);
      return;
    }
    // Capture the graph versions seen at dispatch; never rebase research writes silently.
    const base = getState(),
      atLayout = getLayout(),
      eventProject = projectId;
    pending++;
    tail = tail
      .then(async () => {
        while (isBusy()) await new Promise((r) => setTimeout(r, 25));
        if (getState()?.project.id !== eventProject)
          throw new Error('项目已切换，旧画布操作未提交');
        // Consecutive presentation events from this canvas compose in order. A remote
        // layout update requires explicit recovery, never silently replaces it.
        const layout = getLayout();
        const ownAcknowledgment =
          layout === lastAcknowledgedLayout ||
          (layout.version === lastAcknowledgedLayout?.version &&
            stable(layout.data) === stable(lastAcknowledgedLayout.data));
        if (layout.version !== atLayout.version && !ownAcknowledgment)
          throw new Error('布局已被其他入口修改，本地画布草稿保留，请重新读取');
        if (action.type === 'history') {
          await travel(action.direction);
          publish(true);
        } else await act(action, base, layout);
        lastAcknowledgedLayout = getLayout();
        if (action.type === 'convert-arrow' || action.conversion) publish(true);
        if (action.requestId)
          post({ type: 'commit-result', requestId: action.requestId, ok: true });
      })
      .catch((error) => {
        if (action.type === 'history') {
          message(error.message, true);
          publish(true);
          return;
        }
        const saved = recovery.add(eventProject, {
          action,
          layout: atLayout,
          baseRevision: base?.project.revision,
          expected: Object.fromEntries((base?.objects ?? []).map((e) => [e.id, e.version])),
          at: new Date().toISOString(),
          error: error.message,
        });
        recoveryChanged();
        message(
          `${error.message}。${saved.persisted ? '本次操作已保存到画布恢复草稿，可查看并导出。' : '浏览器空间不足，恢复副本仅在当前页面，请立即导出。'}`,
          true,
        );
        if (action.requestId)
          post({
            type: 'commit-result',
            requestId: action.requestId,
            ok: false,
            message: error.message,
          });
        if (!action.requestId) publish(true);
      })
      .finally(() => {
        pending--;
      });
  });
  let lastAcknowledgedLayout = null;
  return { publish, command, pending: () => pending > 0 };
}
