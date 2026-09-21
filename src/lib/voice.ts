import { BRIDGE_HTTP_URL } from '../config'
import { getMic, releaseMic } from './audio'
import { speakingNow, speakingSince } from './tts'
import { startVad, type Vad } from './vad'
import { caps } from './capabilities'

/**
 * The voice loop.
 *
 * One recogniser, running for the life of the page. It is never torn down for
 * a turn, and that single fact is most of what separates this from a kiosk:
 * the microphone is still open while JARVIS is talking, so you can cut him off
 * the way you would cut off a person.
 *
 * The obvious design — one recogniser hunting for the wake word, a second one
 * capturing the command, stopping the first to start the second because the
 * browser only hands out one at a time — is what this replaces. It works, but
 * nothing is listening during an answer, so barge-in is impossible, and every
 * restart leaves a quarter-second of deafness that eats whole wake words.
 *
 * Keeping the mic open costs one thing: JARVIS hears himself through the
 * speakers. That is handled here in text rather than in acoustics — see
 * `isEcho` — because the browser gives SpeechRecognition its own capture and
 * won't let us put a canceller in front of it.
 */

export type VoiceMode =
  /** Powered down. Only his name matters. */
  | 'wake'
  /** He is expecting you to speak. Everything is a command. */
  | 'command'
  /** He is thinking or talking. Anything you say is an interruption. */
  | 'guard'
  /** Something is playing that must not be transcribed at all. */
  | 'deaf'

export type VoiceHandlers = {
  /** Read fresh on every result, so the app never has to re-subscribe. */
  mode: () => VoiceMode
  /** Fired on his name, from a partial — waiting for endpointing feels slow.
   *  `trailing` is whatever followed it, so "Jarvis, what's the weather" is
   *  one breath rather than two turns. */
  onWake: (trailing: string) => void
  /** The user has genuinely started talking. This is the barge-in trigger. */
  onSpeechStart: () => void
  /** Live transcript, for the caption under the reactor. */
  onPartial: (text: string) => void
  /** A complete, endpointed utterance. */
  onUtterance: (text: string) => void
  /** The recogniser is unusable. Distinct from the user saying nothing. */
  onError: (message: string) => void
}

export type Voice = {
  stop: () => void
  /** True while a recogniser is actually running. */
  live: () => boolean
  /** A real mute: releases the actual recogniser/capture on true, and
   *  re-acquires it on false. Not the same as mode 'deaf', which only
   *  changes what is done with results while capture stays live. */
  setMuted: (muted: boolean) => void
}

// ---------------------------------------------------------------------------
// Endpointing
// ---------------------------------------------------------------------------

/** One utterance often produces several partials containing his name. */
const WAKE_DEBOUNCE = 1500

/**
 * His name, matched by sound rather than by spelling.
 *
 * An enumerated list of mishears chases a moving target — every accent and
 * every speech engine mangles a name differently — so instead this matches
 * anything within a couple of edits of "aslan" (arslan, aslaan, azlan and
 * the like), the same way the previous English name was matched against
 * "jarvis".
 *
 * "Aslan" is an ordinary Turkish word ("lion"), not a made-up name like the
 * one before it, so it will wake on more than just his name — "aslanım"
 * used affectionately, "aslan gibi" and so on. That trade was made on
 * purpose when the name was chosen; if it turns out to be too trigger-happy
 * in practice, the fix is narrowing WAKE_MAX_DISTANCE below, not widening it.
 *
 * The possessive guard ("Aslan's job" should not wake him) has to be
 * re-checked here rather than left to a regex lookahead, since word-boundary
 * splitting on punctuation already separates the name from "'s".
 */
const WAKE_NAME = 'aslan'
const WAKE_MAX_DISTANCE = 2
const WAKE_WORD_RE = /\p{L}+/gu

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) dp[i][0] = i
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp[a.length][b.length]
}

/** Finds the wake word by sound. Returns where it ends, or null. */
function findWake(text: string): { end: number } | null {
  WAKE_WORD_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WAKE_WORD_RE.exec(text))) {
    const word = m[0].toLowerCase()
    // Short words (hi, ok, is, a...) sit within two edits of almost anything
    // six letters long, so they're excluded rather than treated as misses.
    if (word.length < 4) continue
    if (levenshtein(word, WAKE_NAME) > WAKE_MAX_DISTANCE) continue
    const end = m.index + m[0].length
    if (/^['’]s\b/.test(text.slice(end))) continue // "Jarvis's job" — not a wake
    return { end }
  }
  return null
}

/** Everything after the wake phrase, which is usually the actual command. */
function afterWake(text: string): string {
  const hit = findWake(text)
  if (!hit) return ''
  return text
    .slice(hit.end)
    .replace(/^[\s,.:;!?-]+/, '')
    .trim()
}

// ---------------------------------------------------------------------------
// Assembling one utterance out of several segments
// ---------------------------------------------------------------------------

/**
 * Why this exists.
 *
 * The voice-activity detector is an energy gate, and energy is a fact about the
 * room rather than about the sentence. It ends a segment after a fixed quiet
 * gap, so "what's the weather in — " *pause* " — London" is two segments, two
 * transcripts and, before this, two turns: the first one asking the model a
 * truncated question, the second arriving as a bare noun with no question left
 * to attach it to. People pause. They pause to think of the word, to look at
 * something, mid-list, before the important part. An assistant that treats the
 * first gap as the end of the thought is one you have to talk to carefully, and
 * having to talk carefully is the whole failure.
 *
 * So the segment is no longer the turn. Transcripts accumulate here, and the
 * turn fires only when the text looks finished AND the room has gone quiet.
 *
 * Crucially this costs nothing in the common case. A complete sentence with no
 * one speaking fires immediately — `holdFor` returns 0 — so the latency of an
 * ordinary question is exactly what it was. The waiting only happens when there
 * is a reason to wait.
 */

/**
 * Ending on one of these means the sentence is not over, whatever the silence
 * says. Function words only: they are closed-class, so the list is complete in
 * a way a content-word list could never be, and none of them is a plausible
 * last word of a real request.
 */
const CONTINUES =
  /\b(ve|veya|ya da|ama|fakat|ancak|çünkü|eğer|ki|ile|için|gibi|kadar|göre|rağmen|üzere|diye|de|da|ben|sen|biz|siz|bu|şu|o|bir|çok|daha|en|nasıl|neden|niçin|hangi)$/i

/** Trailing punctuation a transcriber emits mid-thought. */
const TRAILS = /[,;:–—-]$/

/**
 * A barge-in this soon after he starts a sentence is him, not you.
 *
 * Echo cancellation and the raised guard threshold stop most of his playback
 * reaching the detector, but the attack of the very first syllable is the
 * loudest, least-cancelled thing in the whole answer — it arrives before the
 * canceller has adapted to it. Without this, a long answer could interrupt
 * itself on its own first word, which reads as JARVIS refusing to speak.
 *
 * Kept short deliberately. This is the one window where a genuine interruption
 * is also least likely: the user has not yet heard enough to want to stop him.
 */
const SELF_GUARD_MS = 350

/**
 * A quiet gap this long with a finished-looking sentence ends the turn.
 *
 * Small on purpose: by the time a transcript reaches the assembler the detector
 * has already sat through SILENCE_MS of quiet and the transcriber has taken its
 * own few hundred milliseconds, so roughly a second of real silence has passed
 * already. All this window has to catch is someone drawing breath to add one
 * more clause. Making it generous here is what would make every ordinary
 * question feel slow.
 */
const SETTLE_MS = 250
/** ...and this long when the sentence is plainly unfinished. */
const CONTINUE_MS = 1600
/**
 * Nothing is held longer than this in total. A ceiling rather than a timer:
 * without it, someone who ends every clause on "and" could hold a turn open
 * for ever, and the assistant would look like it had stopped listening.
 */
const MAX_HOLD_MS = 6000

/**
 * How long to keep waiting, given what has been said so far.
 * 0 means "this is a complete thought, send it now".
 */
function holdFor(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return CONTINUE_MS
  // An explicit terminator is the speaker telling us they are done.
  if (/[.!?]$/.test(text)) return 0
  if (TRAILS.test(text.trim())) return CONTINUE_MS
  if (CONTINUES.test(words[words.length - 1])) return CONTINUE_MS
  // One or two words is usually the start of something, not the whole of it —
  // except for the short commands that genuinely are complete.
  if (words.length <= 2 && !OVERRIDE.test(text)) return CONTINUE_MS
  return SETTLE_MS
}

type Assembler = {
  /** Add a transcript. `active` is true if the user is audibly still going. */
  feed: (text: string, active: boolean) => void
  /** Send whatever is held right now, if anything. */
  flush: () => void
  /** Throw away whatever is held — used when he stands down. */
  cancel: () => void
  held: () => string
}

function makeAssembler(h: {
  emit: (text: string) => void
  partial: (text: string) => void
}): Assembler {
  let held = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstAt = 0

  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const fire = () => {
    clear()
    const text = held.trim()
    held = ''
    firstAt = 0
    if (text) h.emit(text)
  }

  return {
    feed(text, active) {
      if (!text.trim()) return
      held = `${held} ${text}`.replace(/\s+/g, ' ').trim()
      if (!firstAt) firstAt = Date.now()
      // The caption shows the whole thought as it assembles, not just the
      // fragment that happened to arrive last.
      h.partial(held)
      diag.holding = held
      clear()

      // Already talking again. Decide nothing now — the next transcript is
      // part of this same sentence and will bring more of it.
      if (active) {
        timer = setTimeout(fire, MAX_HOLD_MS)
        return
      }

      const wait = Math.min(
        holdFor(held),
        Math.max(0, MAX_HOLD_MS - (Date.now() - firstAt)),
      )
      diag.waitedMs = wait
      if (wait === 0) {
        fire()
        return
      }
      timer = setTimeout(fire, wait)
    },
    flush: fire,
    cancel() {
      clear()
      held = ''
      firstAt = 0
      diag.holding = ''
    },
    held: () => held,
  }
}

// ---------------------------------------------------------------------------
// Hearing himself
// ---------------------------------------------------------------------------

const norm = (s: string) =>
  s
    .toLocaleLowerCase('tr-TR')
    .replace(/[^a-z0-9ışğüöç' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Short words that must always cut through, even when they collide with what
 * he happens to be saying. Suppressing "stop" because he just said "stop"
 * would be the single most infuriating failure this file could have.
 */
const OVERRIDE =
  /\b(dur|bekle|aslan|iptal|yeter|sessiz|sus|boşver|unut|hayır)\b/i

/**
 * Words too common to be evidence of anything.
 *
 * This set is the difference between a usable filter and an infuriating one.
 * "What about the second one?" is a perfectly ordinary follow-up, and every
 * word in it is likely to appear somewhere in the answer it follows — so a
 * naive bag-of-words match suppresses the user's real question as an echo.
 * Only distinctive words count as proof he is hearing himself.
 */
const STOP = new Set(
  ('bir ve veya ama fakat ancak çünkü de da ki mi mı mu mü bu şu o ben sen biz ' +
    'siz onlar benim senin bizim sizin onun bana sana ona bize size onlara ne ' +
    'nasıl niçin neden niye kim hangi nerede ya evet hayır tamam efendim şimdi ' +
    'burada orada çok gibi için üzere ile var yok oldu etti değil diye kadar ' +
    'sonra önce şey işte bile daha en çünkü hem').split(' '),
)

/**
 * Is this the microphone hearing the speakers?
 *
 * Compared as bags of words rather than by string distance: the recogniser
 * mangles its own playback badly enough that a substring match rarely holds,
 * but the *words* survive.
 */
function isEcho(heard: string, spoken: string): boolean {
  if (!spoken) return false
  if (OVERRIDE.test(heard)) return false

  const all = norm(heard).split(' ').filter(Boolean)
  if (!all.length) return true

  const mine = norm(spoken).split(' ').filter(Boolean)
  const content = all.filter((w) => !STOP.has(w))

  // An interim result catches a word mid-syllable — "konuş" for
  // "konuşmanın" — while it is still being spoken. That is his own voice
  // just as much as the finished word is, so a truncated word counts as a
  // match against anything it is a prefix of, in either direction, not only
  // an exact string. Guarded to 3+ letters so short words don't prefix-match
  // everything.
  const matches = (w: string) =>
    mine.some((m) => w === m || (w.length >= 3 && (m.startsWith(w) || w.startsWith(m))))

  // Nothing distinctive was said at all, so there is no strong evidence either
  // way. Demand a total match before discarding it — the cost of dropping a
  // real question is much higher than the cost of one stray echo getting in.
  if (content.length < 2) {
    if (all.length < 2) return false
    return all.every(matches)
  }

  // A short echoed fragment routinely picks up one garbled noise word at its
  // edge — "an iyiyim efendim" for "İyiyim efendim..." — and with only two or
  // three content words, a 60% ratio demands every one of them match, which
  // one bit of noise defeats every time. One genuine, distinctive hit is
  // already strong evidence at this size; the ratio only earns its keep once
  // there are enough words that a single miss can't dominate it.
  if (content.length <= 3) {
    return content.some(matches)
  }

  let hits = 0
  for (const w of content) if (matches(w)) hits++
  return hits / content.length >= 0.6
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Live state of the voice loop, published on `window.__voice`.
 *
 * When someone says the wake word and nothing happens there are only a handful
 * of possible causes — the recogniser never started, it started and died, it is
 * running but hearing silence, or it is hearing you and transcribing the name
 * as something else. From outside the page those are indistinguishable, which
 * makes the failure impossible to report and impossible to fix. This tells them
 * apart in one glance.
 */
export const diag = {
  /** Which input engine is running: 'elevenlabs' (VAD+Scribe) or 'browser'. */
  engine: 'browser',
  /** Whether the microphone pipeline is live. */
  running: false,
  /** Speech segments captured since load. */
  sessions: 0,
  /** The most recent transcript, whatever the mode. */
  heard: '',
  heardAt: 0,
  /** Last failure — a transcription error, or a capture error. */
  lastError: '',
  /** Times the wake word matched. */
  wakes: 0,
  /** Current mode, as the app last reported it. */
  mode: '',
  /** Why the last transcript was ignored — '' when it was accepted. */
  dropped: '',
  /** Transcripts accepted and passed to the app. */
  accepted: 0,
  /** Text assembled but not yet sent, because the thought looks unfinished. */
  holding: '',
  /** How long the assembler decided to wait before sending, in ms. */
  waitedMs: 0,
  /** Barge-ins suppressed because he had only just started the sentence. */
  selfGuarded: 0,
  /** Transcription failures (network, or the bridge speech proxy). */
  restarts: 0,
  /** Milliseconds the last transcription round-trip took. */
  idleMs: 0,
}

/** Record why a transcript went nowhere. Silence always has a reason; this is
 *  the difference between debugging it and speculating about it. */
function drop(why: string) {
  diag.dropped = why
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__voice = diag
}

/**
 * Pick the voice engine and start it.
 *
 * Two engines, chosen by what the bridge reported at boot (see capabilities.ts):
 *   - ElevenLabs available -> local voice-activity detection for instant
 *     barge-in, and ElevenLabs Scribe for the words. The reliable path.
 *   - nothing configured -> the browser's own SpeechRecognition, so a student
 *     with no keys still has a working assistant. Less robust, but free and
 *     zero-setup, and guarded by a heartbeat so its silent death is recovered.
 *
 * The microphone is opened once here so a denied permission is reported loudly
 * rather than surfacing later as an unexplained deafness, whichever engine runs.
 */
export async function startVoice(h: VoiceHandlers): Promise<Voice> {
  try {
    await getMic()
  } catch (err) {
    diag.lastError = 'mic'
    h.onError(
      err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Microphone access denied — voice input is unavailable.'
        : 'No microphone available.',
    )
    return { stop: () => {}, live: () => false, setMuted: () => {} }
  }
  diag.engine = caps().stt ? 'elevenlabs' : 'browser'
  return caps().stt ? startElevenVoice(h) : startBrowserVoice(h)
}

/** VAD + ElevenLabs Scribe. */
async function startElevenVoice(h: VoiceHandlers): Promise<Voice> {
  let lastWake = 0
  let vad: Vad | null = null

  /**
   * Falling back is for real quota/auth trouble, not one dropped request —
   * a stray network blip shouldn't strand someone on the worse engine for
   * the rest of the session, so this only trips after two 401s in a row.
   * `doFallback` is assigned its real body once the VAD/guardPoll below
   * exist; `transcribe` closes over the `let` and calls whatever it points
   * to by the time it actually runs.
   */
  let consecutive401s = 0
  let fallbackVoice: Voice | null = null
  let doFallback: (reason: string) => void = () => {}

  /**
   * Segments waiting for the transcriber, oldest first.
   *
   * This was a boolean — `if (transcribing) return` — and that single line was
   * the worst bug in the pause story. Segments arrive faster than Scribe
   * answers whenever someone speaks in bursts, which is exactly what pausing
   * mid-sentence looks like, so the second half of the thought was not merely
   * mis-timed, it was silently discarded. Queue instead: nothing a person says
   * out loud gets thrown away because the network was busy.
   *
   * Order is preserved because the drain is single-flight, which matters —
   * "London" arriving before "what's the weather in" is worse than either.
   */
  const pendingAudio: Blob[] = []
  let draining = false

  /**
   * Transcripts become turns here rather than one-per-segment.
   * See makeAssembler for why.
   */
  const assemble = makeAssembler({
    emit: (text) => {
      diag.dropped = ''
      diag.accepted++
      diag.holding = ''
      h.onUtterance(text)
    },
    partial: (text) => h.onPartial(text),
  })

  /**
   * Send one captured segment to the bridge and act on the words.
   *
   * The mode is re-read here, not at capture time, because a barge-in flips the
   * machine from 'guard' to 'listening' between the segment starting and its
   * transcript arriving — and the transcript belongs to the mode the user is in
   * now, not the one they interrupted.
   */
  const transcribe = async (blob: Blob) => {
    const mode = h.mode()
    if (mode === 'deaf') return
    const t0 = performance.now()
    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/stt`, {
        method: 'POST',
        headers: { 'content-type': blob.type || 'audio/webm' },
        body: blob,
      })
      diag.idleMs = Math.round(performance.now() - t0)
      if (!res.ok) {
        diag.restarts++
        diag.lastError = `stt ${res.status}`
        if (res.status === 401) {
          consecutive401s++
          if (consecutive401s >= 2) {
            doFallback(`elevenlabs auth/quota exhausted (${res.status})`)
          }
        } else {
          consecutive401s = 0
        }
        drop(`transcription failed (${res.status})`)
        return
      }
      consecutive401s = 0
      const { text } = (await res.json()) as { text?: string }
      const said = (text ?? '').trim()
      diag.lastError = ''

      if (!said) {
        drop('nothing intelligible in the segment')
        return
      }

      // His own voice, come back through the microphone. The raised guard
      // threshold stops most of it at the door; this catches the rest.
      if (isEcho(said, speakingNow())) {
        drop('echo of his own voice')
        return
      }

      diag.heard = said
      diag.heardAt = Date.now()

      if (mode === 'wake') {
        if (findWake(said) && Date.now() - lastWake > WAKE_DEBOUNCE) {
          lastWake = Date.now()
          diag.wakes++
          diag.dropped = ''
          diag.accepted++
          h.onWake(afterWake(said))
        } else {
          drop(`heard "${said.slice(-40)}" — not his name`)
        }
        return
      }

      // Not a turn yet — a piece of one. The assembler decides when the thought
      // is finished, reading the words and whether the room is still noisy.
      assemble.feed(said, vad?.meter().speaking ?? false)
    } catch (err) {
      diag.restarts++
      diag.lastError = String(err)
      drop('could not reach the speech service')
    }
  }

  /** One transcription at a time, in the order the segments were spoken. */
  const drain = async () => {
    if (draining) return
    draining = true
    try {
      while (pendingAudio.length) {
        await transcribe(pendingAudio.shift()!)
      }
    } finally {
      draining = false
    }
  }

  // Pulled out so setMuted can rebuild the same VAD instance on unmute —
  // muting actually releases the microphone track (see below), and a
  // released MediaStreamTrack cannot be restarted, only replaced.
  const vadConfig = () => ({
    onStart: () => {
      const mode = h.mode()
      diag.mode = mode
      diag.sessions++
      if (mode === 'deaf') return
      // Standing down mid-thought throws the thought away with it. Otherwise
      // held text would surface as the opening of the *next* conversation.
      if (mode === 'wake') assemble.cancel()
      // The barge-in. In guard mode the user has started talking over him, and
      // because the guard threshold is high this is a real interruption rather
      // than leaked playback — so cut him off now, do not wait for the words.
      if (mode === 'guard') {
        const since = speakingSince()
        if (since && Date.now() - since < SELF_GUARD_MS) {
          diag.selfGuarded++
          return
        }
        h.onSpeechStart()
      }
    },
    onEnd: (blob: Blob) => {
      pendingAudio.push(blob)
      void drain()
    },
    onLevel: (v: number) => {
      // Only paint the live level while actually listening for a command, so a
      // dormant reactor stays calm and does not twitch at every room noise.
      const mode = h.mode()
      if (mode !== 'command') return
      // Never over the assembled text. This used to run unconditionally and
      // overwrote a half-built sentence with an ellipsis sixty times a second,
      // so a pause looked like the interface had forgotten what you just said.
      if (assemble.held()) return
      h.onPartial(v > 0.04 ? '…' : '')
    },
    onError: (message: string) => {
      diag.lastError = 'capture'
      diag.running = false
      h.onError(message)
    },
  })

  vad = await startVad(vadConfig())
  diag.running = vad.live()

  // Raise the trigger bar exactly while he speaks. The mode is polled rather
  // than pushed because nothing in the app pushes phase changes here, and a
  // 200ms lag on the echo gate is imperceptible.
  let guardPoll = setInterval(() => {
    const mode = h.mode()
    vad?.setGuard(mode === 'guard')
    // He has stood down — by Escape, by the idle timeout, or by dropping back
    // to the wake word. Anything half-said belonged to a conversation that is
    // over, and letting the hold expire later would open the next one with a
    // fragment of the last.
    if ((mode === 'wake' || mode === 'deaf') && assemble.held()) assemble.cancel()
  }, 200)

  let muted = false

  let fallingBack = false
  doFallback = (reason) => {
    if (fallbackVoice || fallingBack) return // already switched, or switching
    fallingBack = true
    diag.lastError = reason
    diag.engine = 'browser'
    clearInterval(guardPoll)
    assemble.cancel()
    vad?.stop()
    void startBrowserVoice(h).then((v) => {
      fallbackVoice = v
    })
  }

  return {
    stop: () => {
      if (fallbackVoice) {
        fallbackVoice.stop()
        return
      }
      clearInterval(guardPoll)
      assemble.cancel()
      vad?.stop()
      diag.running = false
    },
    live: () => fallbackVoice?.live() ?? vad?.live() ?? false,
    setMuted: (m) => {
      if (fallbackVoice) {
        fallbackVoice.setMuted(m)
        return
      }
      if (m === muted) return
      muted = m
      if (m) {
        clearInterval(guardPoll)
        assemble.cancel()
        vad?.stop()
        vad = null
        diag.running = false
        // The real release — a stopped VAD leaves the underlying
        // MediaStreamTrack live, which is the whole bug this exists to fix.
        releaseMic()
      } else {
        void (async () => {
          vad = await startVad(vadConfig())
          diag.running = vad.live()
          guardPoll = setInterval(() => {
            const mode = h.mode()
            vad?.setGuard(mode === 'guard')
            if ((mode === 'wake' || mode === 'deaf') && assemble.held()) assemble.cancel()
          }, 200)
        })()
      }
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Browser fallback: SpeechRecognition                                        */
/* -------------------------------------------------------------------------- */

/**
 * The keyless path. Uses the browser's own SpeechRecognition for both detection
 * and transcription, so a student who has configured nothing still gets voice.
 *
 * It is the flakier engine — Chrome throttles it and it can go silent with no
 * event to catch — so a heartbeat watches it and forces a fresh session
 * whenever it stops showing signs of life. That single guard is the difference
 * between "the wake word stopped working halfway through the lesson" and an
 * assistant that keeps listening.
 */
async function startBrowserVoice(h: VoiceHandlers): Promise<Voice> {
  const Ctor =
    (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
  if (!Ctor) {
    h.onError('This browser has no speech recognition — use Chrome or Edge, or add an ElevenLabs key.')
    return { stop: () => {}, live: () => false, setMuted: () => {} }
  }

  /**
   * The barge-in problem this engine has always had: SpeechRecognition hands
   * back text with no idea how loud it was, so telling a real interruption
   * from his own voice leaking back through the speakers came down to
   * guessing from word count and timing — and a real answer routinely has
   * two or more words in it, so that guess was never going to hold up.
   *
   * `startVad` already solves exactly this, with a noise floor that adapts to
   * the room and a threshold that rises while he's talking — it just does it
   * to decide when to *record*, for Scribe. Here it is used for nothing but
   * that same decision: its `onStart` fires on real, confirmed loudness, and
   * that is what triggers the barge-in below, in guard mode, instead of
   * anything read out of the transcript. The audio it captures is thrown
   * away — Chrome's own recogniser is already transcribing in parallel — so
   * this is pure judgement, not a second speech-to-text path.
   */
  const vadConfig = () => ({
    onStart: () => {
      if (h.mode() !== 'guard') return
      // Chrome's recogniser has been accumulating the whole time his own
      // reply was leaking back in, waiting for the energy gate to confirm
      // anything — so by the time it does, `settled` already holds a run of
      // his own words with nothing to mark where they end and the real
      // question begins. Discarding it here is safe precisely because it is
      // confirmed to be leaked echo, not a real sentence in progress.
      reset()
      h.onSpeechStart()
    },
    onEnd: () => {},
    onLevel: () => {},
    onError: () => {}, // no VAD is a downgrade, not a failure — text heuristics still run
  })
  let vad: Vad | null = null
  try {
    vad = await startVad(vadConfig())
  } catch {
    vad = null
  }

  let stopped = false
  let running = false
  let muted = false
  let rec: any = null
  let settled = ''
  let interim = ''
  let started = false
  let barged = false
  let lastWake = 0
  let lastAlive = Date.now()
  let silenceTimer: ReturnType<typeof setTimeout> | null = null

  /** Same assembly rules as the premium path — a pause is not a full stop. */
  const assemble = makeAssembler({
    emit: (text) => {
      diag.dropped = ''
      diag.accepted++
      diag.holding = ''
      h.onUtterance(text)
    },
    partial: (text) => h.onPartial(text),
  })

  const touch = () => {
    lastAlive = Date.now()
  }

  const clearSilence = () => {
    if (silenceTimer) clearTimeout(silenceTimer)
    silenceTimer = null
  }

  const reset = () => {
    clearSilence()
    settled = ''
    interim = ''
    started = false
    barged = false
  }

  const emit = () => {
    const text = `${settled} ${interim}`.replace(/\s+/g, ' ').trim()
    const mode = h.mode()
    reset()
    if (!text || mode === 'deaf') return
    if (isEcho(text, speakingNow())) {
      drop('echo of his own voice')
      return
    }
    diag.heard = text
    diag.heardAt = Date.now()
    if (mode === 'wake') {
      assemble.cancel()
      if (findWake(text) && Date.now() - lastWake > WAKE_DEBOUNCE) {
        lastWake = Date.now()
        diag.wakes++
        diag.dropped = ''
        diag.accepted++
        h.onWake(afterWake(text))
      } else {
        drop(`heard "${text.slice(-40)}" — not his name`)
      }
      return
    }
    // The recogniser has already endpointed on its own 900ms gap; the assembler
    // decides whether that gap actually ended the thought. `false` because a
    // result only reaches here once the recogniser has gone quiet.
    assemble.feed(text, false)
  }

  const bumpSilence = () => {
    clearSilence()
    // Endpoint on a short quiet gap; the ElevenLabs path tunes this more
    // finely, but a fixed window is plenty for the fallback.
    silenceTimer = setTimeout(emit, 900)
  }

  const onResult = (e: any) => {
    touch()
    const mode = h.mode()
    diag.mode = mode
    if (mode === 'deaf') {
      interim = ''
      return
    }
    let fresh = ''
    interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const chunk = e.results[i][0].transcript as string
      if (e.results[i].isFinal) fresh += chunk
      else interim += chunk
    }
    const heard = `${settled}${fresh} ${interim}`.replace(/\s+/g, ' ').trim()
    if (!heard) return
    if (isEcho(`${fresh} ${interim}`, speakingNow())) {
      interim = ''
      return
    }

    if (mode === 'wake') {
      settled += fresh
      if (findWake(heard) && Date.now() - lastWake > WAKE_DEBOUNCE) {
        lastWake = Date.now()
        diag.wakes++
        const trailing = afterWake(heard)
        reset()
        h.onWake(trailing)
      } else if (settled.length > 400) {
        settled = ''
      }
      return
    }

    settled += fresh
    const full = `${settled} ${interim}`.replace(/\s+/g, ' ').trim()
    if (!started || (mode === 'guard' && !barged)) {
      // Real interruptions are confirmed by the VAD instance above, on
      // energy — not guessed from word count the way this used to work, since
      // a genuine two-word reply reads identically to two words of his own
      // echo leaking back in. Text keeps exactly one vote here: an explicit
      // override word cuts through immediately even if it was spoken too
      // quietly for the energy gate to have already caught it.
      if (mode === 'guard' && !OVERRIDE.test(full)) return
      started = true
      if (mode === 'guard') barged = true
      h.onSpeechStart()
    }
    diag.dropped = ''
    // Show the whole thought, not just the fragment being spoken now — there
    // may be an earlier half of it held by the assembler.
    const carried = assemble.held()
    h.onPartial(carried ? `${carried} ${full}` : full)
    bumpSilence()
  }

  const spin = () => {
    if (stopped || running || muted) return
    rec = new Ctor()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'tr-TR'
    rec.onstart = () => {
      running = true
      diag.running = true
      diag.sessions++
      touch()
    }
    rec.onresult = onResult
    rec.onerror = (ev: any) => {
      diag.lastError = String(ev.error ?? '')
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        stopped = true
        diag.running = false
        h.onError('Microphone access was refused — voice input is unavailable.')
      }
    }
    rec.onend = () => {
      running = false
      diag.running = false
      touch()
      rec = null
      if (!stopped && !muted) setTimeout(spin, 80)
    }
    try {
      rec.start()
    } catch {
      running = false
      setTimeout(spin, 250)
    }
  }

  spin()

  // Raise the VAD's trigger bar exactly while he speaks — same reasoning as
  // the premium path's identical poll.
  const guardPoll = setInterval(() => {
    vad?.setGuard(h.mode() === 'guard')
  }, 200)

  // The heartbeat. If nothing has been heard from the engine for a while it has
  // gone quiet on us — tear it down and build a fresh one.
  const health = setInterval(() => {
    if (stopped || muted) return
    const idle = Date.now() - lastAlive
    diag.idleMs = idle
    if (idle < 15000) return
    diag.restarts++
    try {
      rec?.abort()
    } catch {
      /* already gone */
    }
    rec = null
    running = false
    diag.running = false
    touch()
    spin()
  }, 5000)

  return {
    stop: () => {
      stopped = true
      clearInterval(health)
      clearInterval(guardPoll)
      clearSilence()
      assemble.cancel()
      diag.running = false
      vad?.stop()
      try {
        rec?.abort()
      } catch {
        /* noop */
      }
    },
    live: () => running,
    setMuted: (m) => {
      if (m === muted) return
      muted = m
      if (m) {
        try {
          rec?.abort()
        } catch {
          /* noop */
        }
        diag.running = false
        vad?.stop()
        vad = null
        // This engine's own capture is internal to the browser and releases
        // itself on abort(); the shared getMic() stream (the level meter,
        // the VAD energy gate above, and the premium path when it is active)
        // does not, so it needs the explicit release to actually drop the OS
        // mic indicator.
        releaseMic()
      } else {
        spin()
        void startVad(vadConfig()).then((v) => {
          vad = v
        })
      }
    },
  }
}
