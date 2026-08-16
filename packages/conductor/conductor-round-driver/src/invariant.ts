/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-conductor-round-driver`.
 * @module @deepseek-ai/dsh-conductor-round-driver/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-conductor-round-driver'

/** Cordis companion plugin name. */
export const name = 'conductor-round-driver-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the driver owns no durable state or event protocol of
 * its own; every accepted mutation is committed and validated by the conductor
 * domain, and scheduling behavior is package-tested.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
