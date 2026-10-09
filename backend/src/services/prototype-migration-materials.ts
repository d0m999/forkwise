import { z } from 'zod';

const ref = z
  .object({ source: z.string().min(1).max(200), version: z.number().int().positive() })
  .passthrough();
const refs = z.array(ref).max(10000);
/** Match the prototype material window: explicit files + origin + evidence, then exclusions. */
export function prototypeMaterialMemberships(node: {
  materials?: unknown;
  materialExclusions?: unknown;
  sourceRef?: unknown;
  evidence: Record<string, unknown>[];
}) {
  const combined = [
    ...refs.parse(node.materials === undefined ? [] : node.materials),
    ...(node.sourceRef ? [ref.parse(node.sourceRef)] : []),
    ...node.evidence.filter((e) => e.ref).map((e) => ref.parse(e.ref)),
  ];
  const memberships = new Map<
    string,
    { source: string; version: number; visibility: 'included' | 'excluded' }
  >();
  for (const r of combined)
    memberships.set(JSON.stringify([r.source, r.version]), {
      source: r.source,
      version: r.version,
      visibility: 'included',
    });
  for (const r of refs.parse(node.materialExclusions === undefined ? [] : node.materialExclusions))
    memberships.set(JSON.stringify([r.source, r.version]), {
      source: r.source,
      version: r.version,
      visibility: 'excluded',
    });
  return [...memberships.values()];
}
