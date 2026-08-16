/** Test-only Loader plugin that creates a conductor board at the first real step edge. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-conductor'

export const name = 'seed-conductor'
export const inject = ['conductor']

export function apply(ctx: Context): void {
  ctx.on('agent/pre-step', ({ agent }, next) => {
    if (ctx.conductor.get(agent) === undefined) {
      const board = ctx.conductor.init(agent, {
        objective: 'Prove the composed conductor board survives in the session log',
        planOutline: 'seed one task',
      })
      ctx.conductor.createTask(agent, { id: board.id, revision: board.revision }, {
        title: 'prove persistence',
        description: 'write the board and one task',
      })
    }
    return next()
  })
}
