/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-conductor-bundle`.
 * @module @deepseek-ai/dsh-conductor-bundle/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-conductor-bundle'

/** Cordis companion plugin name. */
export const name = 'conductor-bundle-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: the bundle is a static patch-list carrier. The
// conductor service and round-driver packages own their runtime relations.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
