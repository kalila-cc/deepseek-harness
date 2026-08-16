/** Runtime constructors and protocol constants for the conductor domain. */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ConductorId as ConductorIdType, TaskId as TaskIdType } from './types.ts'
import type { ConductorErrorCode } from './domain.ts'

/** Version of the durable conductor change payload. */
export const CONDUCTOR_CHANGE_VERSION = 1

/**
 * Brand a string as a conductor board id.
 * @param id - raw board identifier.
 * @returns the same string with the compile-time brand.
 */
export function ConductorId(id: string): ConductorIdType {
  return id as ConductorIdType
}

/**
 * Brand a string as a task id.
 * @param id - raw task identifier.
 * @returns the same string with the compile-time brand.
 */
export function TaskId(id: string): TaskIdType {
  return id as TaskIdType
}

/** Error returned by the conductor domain boundary. */
export class ConductorError extends HarnessError {
  /**
   * @param message - human-readable rejection reason.
   * @param code - stable machine-routable classification.
   */
  // Keep the constructor to narrow HarnessError's string code at this boundary.
  // oxlint-disable-next-line typescript/no-useless-constructor -- type-only narrowing
  constructor(message: string, code: ConductorErrorCode) {
    super(message, code)
  }
}
