import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { decodeConductorChange } from '@deepseek-ai/dsh-conductor'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const binScript = fileURLToPath(new URL('../../../../examples/headless-agent/tests/fixtures/headless-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL(
  '../../../../examples/headless-agent/tests/fixtures/conductor-domain/cordis.yml',
  import.meta.url,
))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return paths.flat()
}

describe('conductor domain through a real cordis.yml and headless process', () => {
  it('persists the Loader-mounted board and task without starting a worker', async () => {
    let events: SessionEvent[] = []
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'conductor-domain',
      tempDirPrefix: 'conductor-domain-e2e-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'prove the persisted conductor domain'],
      tsconfigPath: repoTsconfig,
      inspect: async (cwd) => {
        const logs = await jsonlFiles(join(cwd, '.sessions'))
        expect(logs).toHaveLength(1)
        const lines = (await readFile(logs[0] as string, 'utf8')).trimEnd().split('\n')
        events = lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
      },
    })
    expect(stderr).toBe('')
    const result = JSON.parse(stdout.trimEnd().split('\n').at(-1) ?? '') as Record<string, unknown>
    expect(result).toMatchObject({
      type: 'result',
    })
    expect(result['output']).toBeTypeOf('string')
    expect(result['output']).toContain('CLI tool round trip complete')
    expect(events.filter(event => event.type === 'turn/end')).toHaveLength(1)

    const changes = events.filter(event => event.type === 'conductor/change')
    expect(changes).toHaveLength(2)
    const init = changes[0]
    if (init?.type !== 'conductor/change') throw new Error('expected durable conductor change')
    const decoded = decodeConductorChange(init.data)
    if (decoded === undefined || decoded.operation === 'clear') throw new Error('expected a board snapshot change')
    expect(decoded).toMatchObject({
      operation: 'init',
      board: {
        revision: 1,
        objective: 'Prove the composed conductor board survives in the session log',
        phase: 'active',
        mode: 'serial',
        maxParallelWorkers: 5,
        handoverCount: 0,
      },
    })
    const created = changes[1]
    if (created?.type !== 'conductor/change') throw new Error('expected the task-create change')
    const createdDecoded = decodeConductorChange(created.data)
    if (createdDecoded === undefined || createdDecoded.operation === 'clear') {
      throw new Error('expected a task-create change')
    }
    expect(createdDecoded.operation).toBe('task-create')
    expect(createdDecoded.board.tasks).toHaveLength(1)
    expect(createdDecoded.board.tasks[0]).toMatchObject({
      title: 'prove persistence',
      status: 'todo',
    })
    // No worker was spawned: the fixture has no subagent service.
    expect(events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'conductor-driver')).toHaveLength(0)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
