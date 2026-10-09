import type { AnyEntity } from '../src/contracts/entities.js';
import type { CommandInput } from '../src/contracts/commands.js';
export function expectedVersions(
  objects: AnyEntity[],
  commands: CommandInput[],
): Record<string, number>;
