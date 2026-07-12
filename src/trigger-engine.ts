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

// Opt-in push categories for conversation/mentions (Settings → Notifications).
export interface PushConfig {
  enabled: boolean   // master
  mention: boolean   // your character's name spoken
  whisper: boolean
  speech:  boolean   // room "says"
  thought: boolean
}
export const DEFAULT_PUSH: PushConfig = {
  enabled: false, mention: false, whisper: false, speech: false, thought: false,
}

/** Supplies the current rule sets (read fresh each chunk so edits take effect live). */
export type RuleSource = () => {
  notifRules: NotifRule[]; triggers: Trigger[]; push: PushConfig; charName: string
}

function decodeEntities(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}
function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

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

  // Recently-pushed conversation text → timestamp, to swallow the duplicate
  // chunks DR sometimes emits (same line routed twice) within a short window.
  private readonly recentConv = new Map<string, number>()

  /** Evaluate one raw game:data chunk. */
  feed(raw: string): void {
    const { notifRules, triggers, push, charName } = this.rules()
    const alerts = notifRules.filter(r => r.enabled && (r.toast || r.desktop))
    const cmds   = this.opts.autoRunCommandTriggers ? triggers.filter(t => t.enabled) : []
    const convOn = push.enabled && (push.mention || push.whisper || push.speech || push.thought)

    if (convOn) this.pushConversation(raw, push, charName)
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

  // Conversation + mentions → push. The raw chunk still carries DR's
  // `<preset id='speech|whisper|thought'>` tags (the flush emits balanced tags),
  // which is exactly how the renderer classifies conversation. We mirror the
  // renderer's heuristic (store/game.ts): a real speech line contains a quote and
  // isn't the `Abbr: rank%` exp shape (exp data reuses the `whisper` preset) or a
  // `.lic` line — that filter keeps us from paging on skill readouts.
  private pushConversation(raw: string, push: PushConfig, charName: string): void {
    const self = charName.trim().toLowerCase()
    const re = /<preset id=['"](speech|whisper|thought)['"]>([\s\S]*?)<\/preset>/gi
    const now = Date.now()
    let m: RegExpExecArray | null
    while ((m = re.exec(raw)) !== null) {
      const kind = m[1].toLowerCase() as 'speech' | 'whisper' | 'thought'
      const text = decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim()
      if (!text) continue
      if (!text.includes('"') || /^\s*\S+:\s/.test(text) || /\.lic\b/.test(text)) continue
      if (/^you\s+(say|whisper|think|thought)/i.test(text)) continue // our own speech

      const mentioned = push.mention && !!self && new RegExp(`\\b${escapeRe(self)}\\b`, 'i').test(text)
      const kindOn = (kind === 'whisper' && push.whisper)
        || (kind === 'speech' && push.speech)
        || (kind === 'thought' && push.thought)
      if (!mentioned && !kindOn) continue

      const prev = this.recentConv.get(text)
      if (prev && now - prev < 4000) continue
      this.recentConv.set(text, now)
      if (this.recentConv.size > 64) {
        for (const [k, ts] of this.recentConv) if (now - ts > 4000) this.recentConv.delete(k)
      }

      const title = mentioned
        ? `${charName || 'You'} mentioned`
        : kind === 'whisper' ? 'Whisper' : kind === 'thought' ? 'Thought' : 'Speech'
      void notify({ title, body: text }, this.opts.userId)
    }
  }
}
