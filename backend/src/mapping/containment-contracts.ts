import { z } from 'zod';
const Id = z.string().min(1).max(160);
export const MembershipExpected = z.object({
  group: z.object({ id: Id, versionId: Id }).strict(), containment: Id,
}).strict();
export type MembershipDependency = z.infer<typeof MembershipExpected>;
