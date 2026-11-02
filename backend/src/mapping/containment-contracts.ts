import { ContainerEndpointExpected } from './container-endpoints.js';
import { z } from 'zod';
const Id = z.string().min(1).max(160);
export const MembershipExpected = z.union([
  z.object({ endpoints: ContainerEndpointExpected.optional(), group: z.object({ id: Id, versionId: Id }).strict(), containment: Id, parentContainment: Id.nullable().optional() }).strict(),
  z.object({ frame: z.object({ id: Id, versionId: Id }).strict(), containment: Id }).strict(),
]);
export type MembershipDependency = z.infer<typeof MembershipExpected>;
