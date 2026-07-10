/**
 * Platter physics. One simulation drives everything: the visual rotation of
 * the record, the audio playback rate, the strobe feel of spin-up and
 * power-off coast, and the hand-on-vinyl scratch behavior.
 *
 * While the hand is on the record ("clutch engaged") the platter angle is
 * slaved 1:1 to the pointer's angle around the spindle — no springs, no lag,
 * exactly like putting your finger on a real record. Velocity is estimated
 * from a short history window so the release flick feels right.
 */

export const NOMINAL_RPM = 100 / 3
export const NOMINAL_OMEGA = (NOMINAL_RPM / 60) * Math.PI * 2 // ≈ 3.49 rad/s

const SPIN_UP_TAU = 0.55 // motor pull time constant (belt-drive lazy start)
const COAST_TAU = 1.5 // power-off free coast
const STOP_EPSILON = 0.02 // rad/s — call it stopped below this
const VELOCITY_WINDOW = 0.09 // s of pointer history used for the release flick
const MAX_RELEASE_OMEGA = NOMINAL_OMEGA * 6.5
const WOW_DEPTH = 0.003 // ±0.3% at 0.55 Hz — audible warble, just barely
const FLUTTER_DEPTH = 0.0009

interface PointerSample {
  t: number
  a: number // unwrapped cumulative pointer angle (rad)
}

export class Platter {
  angle = 0 // rad, unbounded
  omega = 0 // rad/s
  motorOn = false
  scratching = false

  private time = 0
  private nowSec = 0
  private grabPlatterAngle = 0
  private pointerAccum = 0
  private pointerAccumAtGrab = 0
  private lastRawPointerAngle = 0
  private samples: PointerSample[] = []
  private scratchOmega = 0

  /**
   * Advance the simulation by dt seconds (call once per animation frame).
   * `nowSec` is a wall clock (performance.now()/1000) shared with the pointer
   * samples, so the velocity estimate can age even when no pointer events fire.
   */
  update(dt: number, nowSec: number) {
    this.time += dt
    this.nowSec = nowSec
    if (dt <= 0) return
    const step = Math.min(dt, 0.05) // clamp huge frame gaps (tab switch)

    if (this.scratching) {
      this.angle = this.grabPlatterAngle + (this.pointerAccum - this.pointerAccumAtGrab)
      // smooth the velocity estimate toward the sampled slope
      const slope = this.sampleSlope()
      const alpha = 1 - Math.exp(-step / 0.045)
      this.scratchOmega += (slope - this.scratchOmega) * alpha
      this.omega = this.scratchOmega
      return
    }

    if (this.motorOn) {
      // exponential pull toward nominal speed — same law for spin-up and
      // for recovering after a scratch, which is what a real motor does
      this.omega = NOMINAL_OMEGA + (this.omega - NOMINAL_OMEGA) * Math.exp(-step / SPIN_UP_TAU)
    } else {
      this.omega *= Math.exp(-step / COAST_TAU)
      if (Math.abs(this.omega) < STOP_EPSILON) this.omega = 0
    }
    this.angle += this.omega * step
  }

  /** Hand down on the record. rawAngle = atan2 of pointer around the spindle. */
  beginScratch(rawAngle: number, now: number) {
    this.scratching = true
    this.grabPlatterAngle = this.angle
    this.lastRawPointerAngle = rawAngle
    this.pointerAccumAtGrab = this.pointerAccum
    this.samples = [{ t: now, a: this.pointerAccum }]
    // a planted finger stops the record dead: the angle is slaved 1:1 to the
    // pointer from this instant, so the audible speed must drop to zero with it
    this.scratchOmega = 0
    this.omega = 0
  }

  /** Pointer moved while holding. Unwraps the ±π seam. */
  moveScratch(rawAngle: number, now: number) {
    if (!this.scratching) return
    let delta = rawAngle - this.lastRawPointerAngle
    if (delta > Math.PI) delta -= Math.PI * 2
    else if (delta < -Math.PI) delta += Math.PI * 2
    this.lastRawPointerAngle = rawAngle
    this.pointerAccum += delta
    this.samples.push({ t: now, a: this.pointerAccum })
    // keep only the recent window
    const cutoff = now - VELOCITY_WINDOW * 2
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift()
  }

  /** Hand off the record — release with the flick velocity. */
  endScratch() {
    if (!this.scratching) return
    this.scratching = false
    const v = this.sampleSlope()
    this.omega = Math.max(-MAX_RELEASE_OMEGA, Math.min(MAX_RELEASE_OMEGA, v))
  }

  /** Impart a signed angular-velocity impulse (keyboard scratch). */
  bump(deltaOmega: number) {
    if (this.scratching) return
    this.omega = Math.max(-MAX_RELEASE_OMEGA, Math.min(MAX_RELEASE_OMEGA, this.omega + deltaOmega))
  }

  private sampleSlope(): number {
    const s = this.samples
    if (s.length < 1) return 0
    // Anchor the window at NOW (not at the last moved sample) using the current
    // accumulated angle. When the finger holds still, `now` keeps advancing while
    // the last real sample ages out of the window, so the slope decays to 0 —
    // the record stops turning, the audio stops, and release doesn't fling.
    const latestT = this.nowSec
    const latestA = this.pointerAccum
    let first = s[0]
    for (let i = s.length - 1; i >= 0; i--) {
      first = s[i]
      if (latestT - s[i].t >= VELOCITY_WINDOW) break
    }
    const dt = latestT - first.t
    if (dt < 0.004) return this.scratchOmega
    return (latestA - first.a) / dt
  }

  /**
   * Audio rate for the worklet: 1.0 = 33⅓ RPM. Includes wow & flutter so the
   * record sounds like vinyl even at steady speed.
   */
  audioRate(): number {
    const wow =
      1 +
      WOW_DEPTH * Math.sin(2 * Math.PI * 0.55 * this.time) +
      FLUTTER_DEPTH * Math.sin(2 * Math.PI * 6.3 * this.time + 1.7)
    const rate = (this.omega / NOMINAL_OMEGA) * wow
    return Math.max(-7.5, Math.min(7.5, rate))
  }

  /** True when the platter is effectively at rest. */
  get stopped() {
    return !this.scratching && this.omega === 0
  }
}
