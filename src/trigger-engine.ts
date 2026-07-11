import { stripToLines } from './lib/log-store'
import { notify } from './push'

// ── Server-side trigger / alert evaluation ──────────────────────────────────────
// On the desktop, trigger + notification rules are evaluated in the renderer. That
// can't fire a push when the PWA is backgrounded or closed — a closed page runs no
// JS. So the SERVER watches the game stream here and sends Web Push when a user's
// alert rule matches. Matching semantics mirror the renderer's
// src/renderer/src/lib/automation.ts (case-insensitive substring, or regex).
//
// Command triggers (rules that fire a game command) are a separate concern with a
// double-execution risk: if BOTH the renderer and the server auto-run them, every
// command fires twice. So command auto-run is OFF by default here and the renderer
// stays authoritative while connected; flip `autoRunCommandTriggers` on only once
// the renderer stops evaluating them (the intended end state for a thin client).

export interface NotifRule {
  id: string; label: string; pattern: string; isRegex: boolean
  toast: boolean; desktop: boolean; sound: boolean; tts?: boolean; enabled: boolean
}

export interface Trigger {
  id: string; pattern: string; isRegex: boolean; command: string
  enabled: boolean; class?: string
}

/** Supplies the current rule sets (read fresh each chunk so edits take effect live). */
export type RuleSource = () => { notifRules: NotifRule[]; triggers: Trigger[] }

function matches(line: string, pattern: string, isRegex: boolean): boolean {
  if (!pattern.trim()) return false
  if (isRegex) {
    try { return new RegExp(pattern, 'i').test(line) } catch { return false }
  }
  return line.toLowerCase().includes(pattern.toLowerCase())
}

// %0 → whole match / line; %1..%9 → regex capture groups.
function subMatch(template: string, m: RegExpExecArray | null, line: string): string {
  if (!m) return template.replace(/%0/g, line).replace(/%[1-9]/g, '')
  return template.replace(/%(\d)/g, (_x, d: string) => (Number(d) === 0 ? m[0] : m[Number(d)]) ?? '')
}

export interface TriggerEngineOpts {
  /** Push targeting: only this user's subscribed devices get the notification. */
  userId: string
  /** Fire game commands from command-triggers server-side. Default false — see note above. */
  autoRunCommandTriggers?: boolean
}

export class TriggerEngine {
  constructor(
    private readonly rules: RuleSource,
    private readonly sendCommand: (cmd: string) => void,
    private readonly opts: TriggerEngineOpts,
  ) {}

  /** Evaluate one raw game:data chunk. */
  feed(raw: string): void {
    const { notifRules, triggers } = this.rules()
    const alerts = notifRules.filter(r => r.enabled && (r.toast || r.desktop))
    const cmds   = this.opts.autoRunCommandTriggers ? triggers.filter(t => t.enabled) : []
    if (alerts.length === 0 && cmds.length === 0) return

    for (const line of stripToLines(raw)) {
      if (!line) continue
      for (const r of alerts) {
        if (matches(line, r.pattern, r.isRegex)) {
          void notify({ title: r.label || r.pattern, body: line, tag: r.id }, this.opts.userId)
        }
      }
      for (const t of cmds) {
        if (!t.pattern.trim() || !t.command.trim()) continue
        if (t.isRegex) {
          let re: RegExp | null = null
          try { re = new RegExp(t.pattern, 'i') } catch { re = null }
          const m = re?.exec(line)
          if (m) this.sendCommand(subMatch(t.command, m, line))
        } else if (line.toLowerCase().includes(t.pattern.toLowerCase())) {
          this.sendCommand(subMatch(t.command, null, line))
        }
      }
    }
  }
}
