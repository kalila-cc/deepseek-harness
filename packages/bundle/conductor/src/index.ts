/**
 * Portable conductor-mode bundle: Host runtime plus a managed user preset.
 * @module @deepseek-ai/dsh-conductor-bundle
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import ConductorService from '@deepseek-ai/dsh-conductor'
import type { Config as ConductorConfig } from '@deepseek-ai/dsh-conductor'
import * as conductorRoundDriver from '@deepseek-ai/dsh-conductor-round-driver'
import type { Config as RoundDriverConfig } from '@deepseek-ai/dsh-conductor-round-driver'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'

export const name = 'conductor-bundle'

const PRESET_ID = 'conductor'
const PRESET_ROOT = fileURLToPath(new URL('../agent-presets/conductor', import.meta.url))
const MANAGED_MARKER = '.dsh-conductor-bundle-managed'
const PRESET_FILES = ['agent.cordis.yml', 'preset.yml'] as const

/** Runtime policy forwarded to the service and automatic round driver. */
export interface Config {
  conductor?: ConductorConfig
  roundDriver?: RoundDriverConfig
}

export const Config: z<Config> = z.object({
  conductor: ConductorService.Config.default({}),
  roundDriver: conductorRoundDriver.Config.default({}),
})

/**
 * Install or refresh the bundle-owned preset without overwriting a preset
 * authored independently by the user.
 * @returns the managed preset directory.
 */
export function materializePreset(): string {
  const target = dshHomePath('.agent-presets', PRESET_ID)
  const marker = join(target, MANAGED_MARKER)
  if (existsSync(target) && !existsSync(marker)) {
    throw new Error(`conductor-bundle: refusing to overwrite unmanaged preset at ${target}`)
  }
  mkdirSync(target, { recursive: true })
  for (const filename of PRESET_FILES) {
    writeFileSync(join(target, filename), readFileSync(join(PRESET_ROOT, filename)))
  }
  writeFileSync(marker, 'managed by @deepseek-ai/dsh-conductor-bundle\n', 'utf8')
  return target
}

/** Mount the complete conductor Host runtime from one profile row. */
export function apply(ctx: Context, config: Config = {}): void {
  // Official builds do not know an out-of-tree plugin event type. Register it
  // before any conductor session is opened so persistence can replay boards.
  ;(KNOWN_SESSION_EVENT_TYPES as Set<string>).add('conductor/change')
  const presetPath = materializePreset()
  ctx.logger.info(`conductor-bundle: preset ready at ${presetPath}`)
  ctx.plugin(ConductorService, config.conductor ?? {})
  ctx.plugin(conductorRoundDriver, config.roundDriver ?? {})
}
