import { useState } from 'react'

/**
 * A PIN gate in front of the whole app.
 *
 * This is a deterrent, not a lock: the PIN ships in the bundled JS, so anyone
 * who opens dev tools can read it. What it actually stops is the realistic
 * case — someone else picking up an unlocked Mac and opening the tab out of
 * curiosity. Nothing here mounts App (no mic, no wake word, no tool access)
 * until the PIN is entered, so there is no app running underneath to attack.
 *
 * With no VITE_JARVIS_PIN set, this gate is skipped entirely rather than
 * locking the owner out of their own machine.
 */
const PIN = import.meta.env.VITE_JARVIS_PIN as string | undefined

export function Lock({ children }: { children: (justUnlocked: boolean) => React.ReactNode }) {
  // 'skip' — no PIN configured, nothing to gate. 'unlocked' — a PIN was just
  // typed correctly, which also means the page just got a real user gesture,
  // passed on as `justUnlocked` so the app behind it can boot straight
  // through instead of waiting for a second click on the ignition button.
  const [state, setState] = useState<'locked' | 'unlocked' | 'skip'>(PIN ? 'locked' : 'skip')
  const [value, setValue] = useState('')
  const [shake, setShake] = useState(false)

  if (state !== 'locked') return <>{children(state === 'unlocked')}</>

  const submit = (entered: string) => {
    if (entered === PIN) {
      setState('unlocked')
      return
    }
    setShake(true)
    setValue('')
    setTimeout(() => setShake(false), 400)
  }

  return (
    <div className="lock">
      <input
        className={`lock-input${shake ? ' lock-shake' : ''}`}
        type="password"
        inputMode="numeric"
        autoFocus
        maxLength={PIN?.length ?? 4}
        value={value}
        placeholder="••••"
        onChange={(e) => {
          const next = e.target.value.replace(/\D/g, '')
          setValue(next)
          if (PIN && next.length === PIN.length) submit(next)
        }}
      />
      <span className="lock-sub">enter pin</span>
    </div>
  )
}
