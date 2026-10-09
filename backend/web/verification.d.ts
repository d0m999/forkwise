import type { AnyEntity, Entity } from '../src/contracts/entities.js';
type Scope = {
  target: { id: string; versionId: string };
  context: { id: string; versionId: string }[];
};
export function verificationScope(objects: AnyEntity[], target: AnyEntity): Scope;
export function currentVerification(
  objects: AnyEntity[],
  target: AnyEntity,
): {
  confirmed: Entity<'verification_node'> | undefined;
  candidates: Entity<'verification_node'>[];
  matches(node: AnyEntity): boolean;
  scope: Scope;
};
