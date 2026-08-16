/** Test-only stub of the subagent service: the conductor fixture never spawns windows. */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'stub-subagents'

export function apply(ctx: Context): void {
  ctx.provide('subagents', {
    startContinuable: async () => {
      throw new Error('stub-subagents: the conductor-domain fixture spawns no windows')
    },
    followup: async () => {
      throw new Error('stub-subagents: the conductor-domain fixture delivers no followups')
    },
  } as never)
}
