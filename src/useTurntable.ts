import { useCallback, useEffect, useRef, useState } from 'react'
import { Platter, NOMINAL_OMEGA, NOMINAL_RPM } from './physics/platter'
import { deck } from './audio/engine'
import { TRACKS } from './audio/composer'

export type Phase = 'boot' | 'pressing' | 'playing'

export interface TurntableState {
  phase: Phase
  trackIndex: number
  side: 'A' | 'B'
  motorOn: boolean
  progress: number // 0..1 of current track
  elapsed: number
  duration: number
  rpm: number // signed, live platter speed for the machine-data readout
  locked: boolean // strobe locked at exact 33⅓
  locking: boolean
  held: boolean
  dusty: boolean
  showHint: boolean // "grab · drag · scratch" idle affordance
  condition: 'M-' | 'VG+' | 'VG' | 'G'
}

const CONDITION_STEPS: TurntableState['condition'][] = ['M-', 'VG+', 'VG', 'G']
const HINT_DELAY = 3.4 // s of untouched playback before we invite a scratch

/**
 * The whole machine, as one hook. Owns the platter physics simulation, the
 * rAF loop that drives the record rotation + tonearm + audio rate, all
 * pointer interaction (grab / scratch / flick / flip), and the wear system.
 *
 * Visual rotation and the tonearm are updated imperatively through refs; only
 * coarse state (phase, progress for the meter/index) flows through React.
 */
export function useTurntable(
  rotorRef: React.RefObject<HTMLDivElement | null>,
  armRotorRef: React.RefObject<HTMLDivElement | null>,
  flipperRef: React.RefObject<HTMLDivElement | null>,
) {
  const [state, setState] = useState<TurntableState>({
    phase: 'boot',
    trackIndex: 0,
    side: 'A',
    motorOn: false,
    progress: 0,
    elapsed: 0,
    duration: TRACKS[0].loopSeconds,
    rpm: 0,
    locked: false,
    locking: false,
    held: false,
    dusty: false,
    showHint: false,
    condition: 'M-',
  })

  const platter = useRef(new Platter()).current
  const raf = useRef(0)
  const lastT = useRef(0)
  const flipAngle = useRef(0) // accumulated Y flip (deg)
  const wear = useRef(0) // 0..3 fractional
  const idleSince = useRef(0)
  const dustyRef = useRef(false)
  const durationRef = useRef(TRACKS[0].loopSeconds)
  const progressRef = useRef(0)
  const phaseRef = useRef<Phase>('boot')
  const sideRef = useRef<'A' | 'B'>('A')
  const motorRef = useRef(false)
  const endedRef = useRef(false) // the needle is resting in the run-out groove
  const lockedRef = useRef(false)
  const lockingRef = useRef(false)
  const rpmShownRef = useRef(0)
  const interactedRef = useRef(false)
  const hintShownRef = useRef(false)
  const reduceMotion = useRef(
    typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null,
  )

  // pointer scratch bookkeeping
  const grabbing = useRef(false)
  const activePointer = useRef<number | null>(null)
  const zoneRef = useRef<HTMLElement | null>(null)
  const center = useRef({ x: 0, y: 0 })

  const setPartial = useCallback((p: Partial<TurntableState>) => {
    setState((s) => ({ ...s, ...p }))
  }, [])

  // audio position → progress (tonearm + index)
  useEffect(() => {
    deck.onPosition = (seconds, dur) => {
      if (dur > 0.1) {
        durationRef.current = dur
        progressRef.current = Math.min(1, seconds / dur)
        // scratched well clear of the run-out: playing resumes from here
        if (endedRef.current && seconds < dur - 0.5) endedRef.current = false
      }
    }
    // the song reached the run-out: cut the motor, keep the needle in the groove
    deck.onEnded = () => {
      endedRef.current = true
      motorRef.current = false
      platter.motorOn = false
      setPartial({ motorOn: false })
    }
    return () => {
      deck.onPosition = null
      deck.onEnded = null
    }
  }, [platter, setPartial])

  const armAngle = useRef(90)
  const progAccum = useRef(0)

  // the loop
  const frame = useCallback(
    (t: number) => {
      raf.current = requestAnimationFrame(frame)
      if (!lastT.current) lastT.current = t
      let dt = (t - lastT.current) / 1000
      lastT.current = t
      if (dt > 0.05) dt = 0.05 // tab-switch clamp

      platter.motorOn = motorRef.current
      platter.update(dt, t / 1000)

      // rotate the record
      const rotor = rotorRef.current
      if (rotor) {
        const deg = (platter.angle * 180) / Math.PI
        rotor.style.transform = `rotate(${deg}deg)`
      }

      // audio rate slaved to platter (skip while cold/pressing)
      if (deck.ready && phaseRef.current !== 'boot' && phaseRef.current !== 'pressing') {
        deck.setRate(platter.audioRate())
      }

      // strobe lock detection
      const omega = platter.omega
      const err = Math.abs(omega - NOMINAL_OMEGA) / NOMINAL_OMEGA
      const nowLocked = motorRef.current && !platter.scratching && err < 0.012
      const nowLocking = motorRef.current && !nowLocked && !platter.scratching && omega > NOMINAL_OMEGA * 0.4
      if (nowLocked !== lockedRef.current || nowLocking !== lockingRef.current) {
        lockedRef.current = nowLocked
        lockingRef.current = nowLocking
        setPartial({ locked: nowLocked, locking: nowLocking })
      }

      // tonearm: follow track progress; creep inward as the side plays
      const arm = armRotorRef.current
      if (arm) {
        const playing = phaseRef.current === 'playing'
        // rest angle (parked) vs playing sweep from lead-in to run-out
        const p = progressRef.current
        // arc lands the stylus on the outer groove at lead-in and creeps toward
        // the label; rest parks it just off the record edge (see Tonearm.tsx)
        const restDeg = 90
        const leadIn = 93
        const leadOut = 115
        let target = restDeg
        if (playing) target = leadIn + (leadOut - leadIn) * p
        // underdamped follow + micro-sway (off-center pressing), frozen under reduced motion
        const sway = playing && !reduceMotion.current?.matches ? Math.sin((t / 1000) * 1.3) * 0.3 : 0
        armAngle.current += (target + sway - armAngle.current) * Math.min(1, dt * 6)
        arm.style.transform = `rotate(${armAngle.current}deg)`
      }

      // progress + live RPM → React (throttled to ~10 Hz)
      progAccum.current += dt
      if (progAccum.current > 0.1) {
        progAccum.current = 0
        const dur = durationRef.current
        const rpm = (omega / NOMINAL_OMEGA) * NOMINAL_RPM
        const progress = progressRef.current
        const elapsed = progress * dur
        const rpmChanged = Math.abs(rpm - rpmShownRef.current) > 0.3
        if (rpmChanged) rpmShownRef.current = rpm
        // idle scratch hint: invite interaction after a few untouched seconds
        let hint = hintShownRef.current
        if (
          !interactedRef.current &&
          phaseRef.current === 'playing' &&
          !platter.scratching &&
          t / 1000 - idleSince.current / 1000 > HINT_DELAY
        ) {
          hint = true
        }
        setState((s) => {
          const pChanged = Math.abs(progress - s.progress) >= 0.002 || s.duration !== dur
          const hChanged = hint !== s.showHint
          if (!pChanged && !rpmChanged && !hChanged) return s
          if (hChanged) hintShownRef.current = hint
          return { ...s, progress, elapsed, duration: dur, rpm, showHint: hint }
        })
      }

      // wear + dust
      if (platter.scratching && Math.abs(platter.audioRate()) > 1.4) {
        wear.current = Math.min(3, wear.current + dt * 0.25)
        const cond = CONDITION_STEPS[Math.min(3, Math.floor(wear.current))]
        setState((s) => (s.condition === cond ? s : { ...s, condition: cond }))
        deck.setDustiness(1 + wear.current * 0.9)
        idleSince.current = t
      }
      // dust settles after ~18s idle with the needle down
      if (phaseRef.current === 'playing' && !platter.scratching) {
        if (t - idleSince.current > 18000 && !dustyRef.current) {
          dustyRef.current = true
          deck.setDustiness(1 + wear.current * 0.9 + 1.1)
          setPartial({ dusty: true })
        }
      } else if (platter.scratching) {
        idleSince.current = t
      }
    },
    [platter, rotorRef, armRotorRef, setPartial],
  )

  useEffect(() => {
    raf.current = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf.current)
  }, [frame])

  // pointer geometry
  const pointerAngle = useCallback((clientX: number, clientY: number) => {
    return Math.atan2(clientY - center.current.y, clientX - center.current.x)
  }, [])

  const recomputeCenter = useCallback(() => {
    const zone = zoneRef.current
    if (!zone) return
    const r = zone.getBoundingClientRect()
    center.current = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, [])

  const markInteracted = useCallback(() => {
    interactedRef.current = true
    if (hintShownRef.current) {
      hintShownRef.current = false
      setPartial({ showHint: false })
    }
  }, [setPartial])

  // window-level fallback so a grab can never stick if capture is lost without
  // a pointerup reaching the scene (focus theft, drag-out-and-release, blur).
  // Ignores non-owner pointers so a second finger lifting can't end the scratch.
  const releaseGrab = useCallback(
    (e?: Event) => {
      if (!grabbing.current) return
      if (e && 'pointerId' in e && (e as PointerEvent).pointerId !== activePointer.current) return
      grabbing.current = false
      activePointer.current = null
      platter.endScratch()
      setPartial({ held: false })
      window.removeEventListener('pointerup', releaseGrab)
      window.removeEventListener('pointercancel', releaseGrab)
      window.removeEventListener('blur', releaseGrab)
    },
    [platter, setPartial],
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (phaseRef.current === 'boot' || phaseRef.current === 'pressing') return
      if (e.button !== 0) return // primary button / touch / pen only
      if (activePointer.current !== null) return // one finger owns the platter
      recomputeCenter()
      activePointer.current = e.pointerId
      const zone = zoneRef.current
      if (zone) (zone as HTMLElement).setPointerCapture?.(e.pointerId)
      grabbing.current = true
      markInteracted()
      platter.beginScratch(pointerAngle(e.clientX, e.clientY), performance.now() / 1000)
      // push rate 0 to the worklet right now instead of waiting for the next
      // animation frame — a planted finger must silence the groove instantly
      if (deck.ready) deck.setRate(platter.audioRate())
      idleSince.current = performance.now()
      // clean the dust off when you touch the record (anti-static wipe)
      if (dustyRef.current) {
        dustyRef.current = false
        wear.current = Math.max(0, wear.current - 0.5)
        deck.setDustiness(1 + wear.current * 0.9)
        setPartial({ dusty: false, condition: CONDITION_STEPS[Math.min(3, Math.floor(wear.current))] })
      }
      setPartial({ held: true })
      window.addEventListener('pointerup', releaseGrab)
      window.addEventListener('pointercancel', releaseGrab)
      window.addEventListener('blur', releaseGrab)
    },
    [platter, pointerAngle, recomputeCenter, setPartial, markInteracted, releaseGrab],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!grabbing.current || e.pointerId !== activePointer.current) return
      // consume coalesced moves so per-event angle deltas stay well under π,
      // which keeps the ±π unwrap correct even for fast scratches near the spindle
      const evs = e.nativeEvent.getCoalescedEvents?.() ?? []
      const now = performance.now() / 1000
      if (evs.length) {
        for (const pt of evs) platter.moveScratch(pointerAngle(pt.clientX, pt.clientY), now)
      } else {
        platter.moveScratch(pointerAngle(e.clientX, e.clientY), now)
      }
    },
    [platter, pointerAngle],
  )

  const endGrab = useCallback(
    (e?: React.PointerEvent) => {
      releaseGrab(e?.nativeEvent)
    },
    [releaseGrab],
  )

  /** Keyboard scratch for non-pointer users: a brief signed speed impulse. */
  const nudge = useCallback(
    (dir: number) => {
      if (phaseRef.current !== 'playing') return
      markInteracted()
      platter.bump(dir * NOMINAL_OMEGA * 0.9)
    },
    [platter, markInteracted],
  )

  /**
   * Jump the playhead to a fraction (0..1) of the track — the progress bar as a
   * position control. Moves the audio, the tonearm and the time readout in one
   * step; there's no live scrub-audio (the record itself is where you scratch),
   * so seeking stays clean. Clamps a hair shy of the run-out because at exactly
   * 1.0 the worklet's `frame % length` wraps the seek back to the very start.
   */
  const seek = useCallback(
    (fraction: number) => {
      if (phaseRef.current !== 'playing') return
      markInteracted()
      const dur = durationRef.current
      const f = Math.max(0, Math.min(dur > 0 ? 1 - 0.06 / dur : 0, fraction))
      progressRef.current = f
      // leaving the run-out re-arms playback: a finished record resumes from the
      // new spot when the motor is next started, instead of pinning at the end
      endedRef.current = false
      deck.seekToSeconds(f * dur)
      idleSince.current = performance.now()
      setPartial({ progress: f, elapsed: f * dur })
    },
    [markInteracted, setPartial],
  )

  // public controls

  const startBoot = useCallback(async () => {
    setPartial({ phase: 'pressing' })
    phaseRef.current = 'pressing'
    try {
      await deck.init()
      const ok = await deck.loadTrack(TRACKS[0])
      if (!ok) throw new Error('track failed to load')
      deck.setNeedle(true)
      motorRef.current = true
      platter.motorOn = true
      phaseRef.current = 'playing'
      idleSince.current = performance.now()
      setPartial({ phase: 'playing', motorOn: true })
    } catch (err) {
      // Audio couldn't start (e.g. a browser with no usable audio at all). Roll
      // the sleeve back so it's not stuck lifted and the listener can retry,
      // instead of leaving an uncaught rejection and a dead deck.
      console.error('[turntable] audio failed to start:', err)
      phaseRef.current = 'boot'
      setPartial({ phase: 'boot' })
    }
  }, [platter, setPartial])

  const toggleMotor = useCallback(() => {
    // START/STOP is the motor. The stylus stays in the groove either way — when
    // the motor stops, the record coasts to a halt and the music slows with it.
    const on = !motorRef.current
    // restarting a finished record puts the needle back at the lead-in
    if (on && endedRef.current) {
      endedRef.current = false
      progressRef.current = 0
      deck.seekToSeconds(0)
    }
    motorRef.current = on
    platter.motorOn = on
    deck.playClick()
    setPartial({ motorOn: on })
  }, [platter, setPartial])

  const selectTrack = useCallback(
    async (index: number) => {
      const track = TRACKS[index]
      const targetSide: 'A' | 'B' = track.side.startsWith('B') ? 'B' : 'A'
      deck.playClick(true)
      // lift the stylus so the buffer swap can't click, then drop it after render
      deck.setNeedle(false)
      setPartial({ phase: 'pressing', trackIndex: index })
      phaseRef.current = 'pressing'
      progressRef.current = 0
      endedRef.current = false
      // flip the record if the side changed
      if (targetSide !== sideRef.current) {
        sideRef.current = targetSide
        flipAngle.current += 180
        const flip = flipperRef.current
        if (flip) flip.style.transform = `rotateY(${flipAngle.current}deg)`
        deck.playThud()
        setPartial({ side: targetSide })
      }
      await deck.init()
      const ok = await deck.loadTrack(track)
      if (!ok) return
      deck.setNeedle(true)
      motorRef.current = true
      platter.motorOn = true
      wear.current = 0
      dustyRef.current = false
      deck.setDustiness(1)
      idleSince.current = performance.now()
      phaseRef.current = 'playing'
      setPartial({ phase: 'playing', motorOn: true, duration: track.loopSeconds, dusty: false, condition: 'M-' })
    },
    [platter, flipperRef, setPartial],
  )

  const flipRecord = useCallback(() => {
    // manual flip → jump to the other side's first track
    const target = sideRef.current === 'A' ? TRACKS.findIndex((x) => x.side.startsWith('B')) : 0
    if (target >= 0) void selectTrack(target)
  }, [selectTrack])

  const bindZone = useCallback((el: HTMLElement | null) => {
    zoneRef.current = el
  }, [])

  useEffect(() => {
    const onResize = () => recomputeCenter()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [recomputeCenter])

  return {
    state,
    bindZone,
    onPointerDown,
    onPointerMove,
    endGrab,
    nudge,
    seek,
    startBoot,
    toggleMotor,
    selectTrack,
    flipRecord,
  }
}
