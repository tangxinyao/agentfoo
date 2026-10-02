import { describe, it, expect } from 'vitest'
import { takeOption } from '../src/cli-args.js'

/**
 * The agentfoo-only flags (`-a/--agent`, `--env-file`) must be stripped from the
 * argv before it reaches vitest, which would reject them outright. The rest of the
 * argv has to survive byte-for-byte: it carries path filters and vitest's own
 * flags (`-t`, `--reporter`, …).
 */
describe('takeOption', () => {
  it('returns undefined and the argv untouched when the flag is absent', () => {
    const { value, args } = takeOption(['run', 'skills/frontend', '-t', 'name'], ['-a', '--agent'])
    expect(value).toBeUndefined()
    expect(args).toEqual(['run', 'skills/frontend', '-t', 'name'])
  })

  it('takes a space-separated value and removes both tokens', () => {
    const { value, args } = takeOption(['run', '-a', 'opencode', '-t', 'x'], ['-a', '--agent'])
    expect(value).toBe('opencode')
    expect(args).toEqual(['run', '-t', 'x'])
  })

  it('takes an =-joined value on either alias', () => {
    expect(takeOption(['--agent=opencode'], ['-a', '--agent']).value).toBe('opencode')
    expect(takeOption(['-a=opencode'], ['-a', '--agent']).value).toBe('opencode')
  })

  it('keeps a value that itself contains an = sign', () => {
    // Only the first `=` separates flag from value.
    expect(takeOption(['--env-file=../a=b/.env'], ['--env-file']).value).toBe('../a=b/.env')
  })

  it('lets the last occurrence win', () => {
    expect(takeOption(['-a', 'hermes', '-a', 'opencode'], ['-a', '--agent']).value).toBe('opencode')
  })

  it('yields "" for a trailing flag instead of swallowing a following argument', () => {
    // The caller turns "" into a usage error. The dangerous alternative would be
    // consuming a path filter as the agent name.
    const { value, args } = takeOption(['run', '-a'], ['-a', '--agent'])
    expect(value).toBe('')
    expect(args).toEqual(['run'])
  })

  it('does not match a flag that merely starts with the same characters', () => {
    const { value, args } = takeOption(['--agentfoo-thing', '-ab'], ['-a', '--agent'])
    expect(value).toBeUndefined()
    expect(args).toEqual(['--agentfoo-thing', '-ab'])
  })

  it('leaves an unrelated option alone when extracting another', () => {
    const { value, args } = takeOption(
      ['run', '--env-file', '../.env', '-a', 'opencode'],
      ['--env-file'],
    )
    expect(value).toBe('../.env')
    expect(args).toEqual(['run', '-a', 'opencode'])
  })
})
