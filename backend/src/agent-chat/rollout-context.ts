import { createHash } from 'node:crypto';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { z } from 'zod';
import { codexChatModel } from './codex.js';
import type { RolloutRecord } from './rollout-text.js';

// The read-only, stock Codex 0.172.0 bootstrap. These hashes cover complete
// contents, including tool parameters, skill descriptions and instructions.
const stock = {
  tools: 'c89ddf44323b2ec03b7af5cb34ec7bdd8f8ebfa6b8d606f9ea6955773e2a2d22',
  skills: '4cd32eea31892476d0d1c7d729233bacca9b0b5c384f255df322c4899d12303a',
  permissions: '70795d16a20d94f7c0859fa5e86b7e434d116e75324b3bb8a3e5a41f7448f215',
  collaboration: 'bec8e7b5358a20b4cd552dae768b3a65ebf4ea9fb2645220085b84d60ee3fe81',
};
// Codex 0.172.0's bundled Luna instructions and corresponding world state,
// excluding the environment and host skills that are checked separately.
const noPersonality = '574a0b1edc53d397e0611563645e1f9b2b0ec91a84246d44fc97c124a8cf960a';
export const bundledLunaWorld = new Map([
  ['e52174f354e3970ad8de5935fff8d04ddf2890a35659283d163befb56490198c',
    '99686e9500a9ecaba7aac9e7333fb95b8802db85a9eea6e4d1782815bc0eeafb'],
  [noPersonality, '1d76bf8cec94bb38e54335999cc6d673e6aca86f8427756e5a5a30f7e0fc97c5'],
]);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const effortName = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const openedThread = z.object({
  thread: z.object({ id: z.string(), cliVersion: z.literal('0.172.0'), path: z.string(),
    cwd: z.string(), model: z.literal(codexChatModel), modelProvider: z.string(), environments: z.unknown() }),
  model: z.literal(codexChatModel), modelProvider: z.string().min(1), cwd: z.string().min(1),
  reasoningEffort: effortName.nullable(), runtimeWorkspaceRoots: z.unknown(), instructionSources: z.tuple([]),
  disabledPluginIds: z.tuple([]), approvalPolicy: z.literal('on-request'), approvalsReviewer: z.literal('user'),
  sandbox: z.strictObject({ type: z.literal('readOnly'), networkAccess: z.literal(false) }),
  activePermissionProfile: z.strictObject({ id: z.literal(':read-only'), extends: z.null() }),
  collaborationMode: z.unknown().optional(),
});
// Keep only the observed settings for a possible retry. A resume response
// can also contain the entire conversation, which the verifier does not use.
export function rolloutOpenSettings(result: unknown, cwd: string) {
  const opened = openedThread.safeParse(result);
  if (opened.success && opened.data.cwd === cwd) return opened.data;
}
export type RolloutOpenSettings = ReturnType<typeof rolloutOpenSettings>;

const stockTools = z.strictObject({
  type: z.literal('additional_tools'), id: z.templateLiteral(['at_', z.uuidv7()]),
  role: z.literal('developer'), tools: z.array(z.unknown()),
});
const stockMessage = z.strictObject({
  type: z.literal('message'), id: z.templateLiteral(['msg_', z.uuidv7()]), role: z.enum(['developer', 'user']),
  content: z.array(z.strictObject({ type: z.literal('input_text'), text: z.string() })),
  internal_chat_message_metadata_passthrough: z.strictObject({
    turn_id: z.string(), create_time: z.number().nonnegative(),
    content_item_kinds: z.array(z.string()), content_item_metadata: z.array(z.unknown()),
  }),
});
const worldState = z.strictObject({
  full: z.literal(true),
  // Keep every native key in the hashed remainder, including unknown JSON keys.
  state: z.custom<Record<string, unknown>>(state => typeof state === 'object' && state !== null && !Array.isArray(state)),
});
const permissionProfile = {
  type: 'managed', file_system: { type: 'restricted', entries: [
    { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
  ] }, network: 'restricted',
};
const collaboration = (effort: string | null) => ({
  mode: 'default', settings: { model: codexChatModel, reasoning_effort: effort, developer_instructions: null },
});
const harness = { provenance: { type: 'harness', hook: false } };
const messageKinds = [
  ['model.base_instructions'],
  ['host_skills.instructions', 'permissions.instructions', 'collaboration_mode.instructions'],
  ['environments.environment_context'],
];
const provenances = [[harness], [{ provenance: { type: 'skills' } }, harness, harness], [harness]];

const fixedShellPaths = new Map([
  ['zsh', ['/bin/zsh']], ['bash', ['/bin/bash', '/usr/bin/bash']], ['sh', ['/bin/sh']],
  ['powershell', ['/usr/local/bin/pwsh']], ['cmd', []],
]);

// Match Codex 0.172.0's Unix passwd lookup and shell fallback order.
function nativeUnixShell(cwd: string) {
  // Node looks up the effective UID. Codex looks up the real UID.
  if (process.getuid?.() !== process.geteuid?.()) return;
  let loginShell = '';
  try { loginShell = userInfo().shell ?? ''; } catch { /* The passwd entry is optional. */ }
  const loginCommand = basename(loginShell).split('.', 1)[0];
  const loginKind = loginCommand === 'pwsh' ? 'powershell' : loginCommand;
  const pathEntries = process.env.PATH?.split(delimiter) ?? [];
  const isFile = (path: string, executable = false) => {
    try {
      if (executable) accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch { return false; }
  };
  const fallback = process.platform === 'darwin' ? ['zsh', 'bash'] : ['bash', 'zsh'];
  for (const kind of [...(loginKind ? [loginKind] : []), ...fallback]) {
    const fixedPaths = fixedShellPaths.get(kind);
    if (!fixedPaths) continue;
    const commands = kind === 'powershell' ? ['pwsh', 'powershell'] : [kind];
    if ((kind === loginKind && isFile(resolve(cwd, loginShell))) ||
        commands.some(command => pathEntries.some(path => isFile(resolve(cwd, path, command), true))) ||
        fixedPaths.some(path => isFile(path))) return kind;
  }
  return 'sh';
}

const unavailable = Object.assign(() => false, { complete: () => true });

// The caller binds open to its own no-project directory, checks every ordinal
// and keeps these records outside the submitted question and answer.
export function createRolloutContextVerifier(open: RolloutOpenSettings, threadId: string, turnId: string,
  effort: string | undefined, firstTurn: boolean, baseInstructions: string | undefined) {
  if (!open) return unavailable;
  const { thread, cwd, modelProvider, reasoningEffort } = open;
  const roots = [cwd];
  if (thread.id !== threadId || thread.cwd !== cwd || thread.modelProvider !== modelProvider ||
      !equal(open.runtimeWorkspaceRoots, roots) ||
      !equal(thread.environments, [{ environmentId: 'local', cwd, runtimeWorkspaceRoots: roots }]) ||
      (open.collaborationMode !== undefined && !equal(open.collaborationMode, collaboration(reasoningEffort))) ||
      (effort !== undefined && !effortName.safeParse(effort).success)) return unavailable;

  const instructionDigest = baseInstructions && hash(baseInstructions);
  const turnEffort = effort ?? reasoningEffort;
  const common = { cwd, model: codexChatModel, approval_policy: 'on-request', approvals_reviewer: 'user',
    permission_profile: permissionProfile, active_permission_profile: { id: ':read-only' }, disabled_plugin_ids: [] };
  const turnContext = { ...common, turn_id: turnId, root_turn_id: turnId,
    ...(turnEffort === null ? {} : { effort: turnEffort }), comp_hash: '3000',
    collaboration_mode: collaboration(turnEffort), multi_agent_version: 'disabled', realtime_active: false,
    summary: 'none', sandbox_policy: { type: 'read-only' } };
  const settings = (settingsEffort: string | null) => ({ type: 'thread_settings_applied', thread_id: threadId,
    thread_settings: { ...common, model_provider_id: modelProvider, requested_approvals_reviewer: 'user',
      runtime_workspace_roots: roots, ...(settingsEffort === null ? {} : { reasoning_effort: settingsEffort }),
      ...(instructionDigest === noPersonality ? { personality: 'none' } : {}), collaboration_mode: collaboration(settingsEffort) } });
  const appliedSettings = settings(turnEffort);
  // A resumed writer can persist the opening settings or the settings applied by turn/start.
  const resumedSettings = !firstTurn && reasoningEffort !== turnEffort ? settings(reasoningEffort) : undefined;

  // The no-project root and installed system-skills root are the only paths
  // permitted in the stock instructions. Derive the latter from native open.
  const sessions = thread.path.match(/^(.*)\/sessions\/\d{4}\/\d\d\/\d\d\/rollout-[^/]+\.jsonl$/);
  const skillsRoot = sessions && thread.path.endsWith(`-${threadId}.jsonl`)
    ? join(sessions[1]!, 'skills', '.system') : undefined;
  const xmlCwd = cwd.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  const filesystem = `<filesystem><workspace_roots><root>${xmlCwd}</root></workspace_roots>` +
    '<permission_profile type="managed"><file_system type="restricted"><entry access="read">' +
    '<special>:root</special></entry></file_system></permission_profile></filesystem>';
  let skillsBody: string | undefined;
  let environment: unknown;
  let setupCount = 0;
  let sawContext = false;
  let sawSettings = false;
  const messageIds = new Set<string>();

  const accept = ({ type, metadata, payload, timestamp }: RolloutRecord) => {
    if (type === 'turn_context') {
      if (metadata !== undefined || sawContext || (setupCount !== 0 && setupCount !== 5) || !equal(payload, turnContext))
        return false;
      sawContext = true;
      return true;
    }
    if (type === 'event_msg') {
      if (metadata !== undefined || sawSettings || sawContext !== firstTurn ||
          (!equal(payload, appliedSettings) && !(resumedSettings && equal(payload, resumedSettings)))) return false;
      sawSettings = true;
      return true;
    }
    if (!firstTurn || sawContext || sawSettings) return false;
    if (type === 'world_state') {
      if (metadata !== undefined || setupCount !== 4) return false;
      const world = worldState.safeParse(payload);
      if (!world.success) return false;
      const { host_skills, environments, ...fixed } = world.data.state;
      if (!instructionDigest || hash(JSON.stringify(fixed)) !== bundledLunaWorld.get(instructionDigest) || !equal(environments, environment) ||
          !equal(host_skills, { body: skillsBody, includeInstructions: true })) return false;
      setupCount++;
      return true;
    }
    if (type !== 'response_item' || setupCount >= 4 || !equal(metadata, {
      history_sequence: setupCount + 1, sampled_through_sequence: 0, client_authored: false,
      ...(setupCount === 0 ? { mcp_attribution: { status: 'none' } } : {}), model_search_state: 'unused',
    })) return false;
    if (setupCount === 0) {
      const tools = stockTools.safeParse(payload);
      if (!tools.success || hash(JSON.stringify(tools.data.tools)) !== stock.tools) return false;
    } else {
      const message = stockMessage.safeParse(payload);
      if (!message.success) return false;
      const { role, content, id, internal_chat_message_metadata_passthrough: meta } = message.data;
      const kinds = messageKinds[setupCount - 1]!;
      if (meta.turn_id !== turnId || role !== (setupCount === 3 ? 'user' : 'developer') || messageIds.has(id) ||
          !equal(meta.content_item_kinds, kinds) || !equal(meta.content_item_metadata, provenances[setupCount - 1]) ||
          content.length !== kinds.length) return false;
      const text = content[0]!.text;
      if (setupCount === 1 && text !== baseInstructions) return false;
      if (setupCount === 2) {
        if (!skillsRoot || !text.includes(skillsRoot) || text.includes('[SYSTEM_SKILLS]') ||
            hash(text.replace(skillsRoot, '[SYSTEM_SKILLS]')) !== stock.skills ||
            hash(content[1]!.text) !== stock.permissions || hash(content[2]!.text) !== stock.collaboration) return false;
        skillsBody = text.slice('<skills_instructions>'.length, -'</skills_instructions>'.length);
      }
      if (setupCount === 3) {
        const shell = nativeUnixShell(cwd);
        if (!shell) return false;
        // The native app-server does not inherit the workbench's TZ override.
        let zone: string | undefined;
        try { zone = realpathSync('/etc/localtime').split('/zoneinfo/')[1]; } catch { /* zoneinfo link is optional */ }
        zone ??= process.env.TZ ? undefined : Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (!zone) return false;
        const date = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit',
          day: '2-digit' }).format(new Date(timestamp));
        const expected = ['<environment_context>', `  <cwd>${xmlCwd}</cwd>`, `  <shell>${shell}</shell>`,
          `  <current_date>${date}</current_date>`, `  <timezone>${zone}</timezone>`,
          `  ${filesystem}`, '</environment_context>'].join('\n');
        if (text !== expected) return false;
        environment = { environments: { local: { cwd, status: 'available', shell } },
          current_date: date, timezone: zone, filesystem };
      }
      messageIds.add(id);
    }
    setupCount++;
    return true;
  };
  return Object.assign(accept, { complete: () => setupCount === 0 || (setupCount === 5 && sawContext && sawSettings) });
}
