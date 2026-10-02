import type { Agent, RunOptions } from './agent/types.js'
import type { Trace } from './types.js'

/**
 * Scripted multi-turn conversations (TODO §P3, docs/02-fixtures-dsl §5).
 *
 * Interactive skills — brainstorming, interviews, anything that asks a question
 * and stops — assume a person answers. A single `agent.run()` only ever tests
 * their opening move. `converse` plays the user: after each agent turn it asks a
 * responder what to say next, and stops when the responder has nothing to add
 * or `maxTurns` is hit. Turns continue the same session, exactly like repeated
 * `run()` calls.
 */

export interface ConversationTurn {
  /** 0-based index of the agent turn just completed. */
  index: number
  trace: Trace
  /** Shorthand for `trace.finalMessage`. */
  reply: string
}

/**
 * What the simulated user says after an agent turn: return the next message,
 * or `undefined` to end the conversation. An array of strings is sugar for
 * "answer with these, in order, then stop".
 */
export type Responder =
  | readonly string[]
  | ((turn: ConversationTurn) => string | undefined | Promise<string | undefined>)

export interface ConverseOptions extends RunOptions {
  /** Hard cap on agent turns, so a responder that never stops can't loop forever. Default 8. */
  maxTurns?: number
}

export interface Conversation {
  /** The user messages sent, in order (the opening prompt first). */
  userMessages: string[]
  /** One trace per agent turn. */
  turns: Trace[]
  stoppedBy: 'responder' | 'maxTurns'
  /**
   * The dialogue as alternating `User:` / `Agent:` blocks of final messages —
   * no tool calls or tool results, so grading it can't credit files the agent
   * read (the same reason `toSatisfy` grades `finalMessage` by default).
   */
  dialogue(): string
}

export async function converse(
  agent: Agent,
  prompt: string,
  responder: Responder,
  opts: ConverseOptions = {},
): Promise<Conversation> {
  const maxTurns = opts.maxTurns ?? 8
  const respond =
    typeof responder === 'function'
      ? responder
      : (({ index }: ConversationTurn) => (responder as readonly string[])[index])
  const userMessages: string[] = []
  const turns: Trace[] = []
  let next: string | undefined = prompt
  let stoppedBy: Conversation['stoppedBy'] = 'maxTurns'

  while (next !== undefined && turns.length < maxTurns) {
    userMessages.push(next)
    const trace = await agent.run(next, { timeout: opts.timeout })
    turns.push(trace)
    next = await respond({ index: turns.length - 1, trace, reply: trace.finalMessage })
    if (next === undefined) stoppedBy = 'responder'
  }

  return {
    userMessages,
    turns,
    stoppedBy,
    dialogue: () =>
      turns
        .map((t, i) => `User: ${userMessages[i]}\n\nAgent: ${t.finalMessage}`)
        .join('\n\n---\n\n'),
  }
}
