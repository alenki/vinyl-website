/**
 * TurntableProcessor — the stylus.
 *
 * Output 0 (stereo): the record. A rendered buffer read at a signed, variable
 * rate, exactly like a needle riding a groove. The main thread posts the
 * platter's rate each animation frame; a per-sample one-pole smoother makes
 * the motion zipper-free regardless of message jitter.
 *
 * Output 1 (mono): the medium. Procedural crackle — Poisson dust ticks whose
 * density and loudness ride the groove speed, plus two deterministic "groove
 * scars" at fixed revolution phases (they stutter and reverse when you
 * scratch — the single most physical detail on the site), plus surface hiss.
 *
 * Musical reverb/delay are baked INTO the record buffer, so scratching plays
 * their tails in reverse. The crackle is the physical medium and never
 * reverses; it only follows speed.
 */

const REV_SECONDS = 1.8 // one revolution at 33 1/3 RPM
const SCAR_PHASES = [0.23, 0.71]

class TurntableProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.left = null
    this.right = null
    this.length = 0
    this.pos = 0
    this.wraps = 0 // net loop count, so the reported playhead is monotonic-ish
    this.targetRate = 0
    this.rate = 0
    // one-pole rate smoothing, tau = 12 ms
    this.rateAlpha = 1 - Math.exp(-1 / (0.012 * sampleRate))
    // DC blockers (rate 0 holds a constant sample = DC offset)
    this.dcL = { x1: 0, y1: 0 }
    this.dcR = { x1: 0, y1: 0 }
    // needle/seek gain ramp (15 ms) to avoid clicks on drops and buffer swaps
    this.ramp = 0
    this.rampStep = 1 / (0.015 * sampleRate)
    this.rampTarget = 1
    // a staged buffer swap: fade the old groove out, swap at silence, fade in
    this.pendingLeft = null
    this.pendingRight = null
    this.pendingLength = 0
    // crackle state
    this.revPhase = 0
    this.tickEnv = 0
    this.tickLp = 0
    this.dustiness = 1 // condition multiplier, raised by the wear system
    this.hissLp = 0
    this.blockCount = 0

    this.port.onmessage = (e) => {
      const d = e.data
      switch (d.type) {
        case 'load':
          if (this.left) {
            // a groove is already playing: stage the swap and fade the old out
            this.pendingLeft = d.left
            this.pendingRight = d.right
            this.pendingLength = d.left.length
            this.rampTarget = 0
          } else {
            this.ramp = 0
            this.rampTarget = 1
            this.left = d.left
            this.right = d.right
            this.length = d.left.length
            this.pos = 0
          }
          break
        case 'seek':
          if (this.length > 0) {
            this.ramp = 0
            this.pos = ((d.frame % this.length) + this.length) % this.length
          }
          break
        case 'rate':
          this.targetRate = d.value
          break
        case 'dust':
          this.dustiness = d.value
          break
        case 'clear':
          this.left = null
          this.right = null
          this.length = 0
          this.pos = 0
          break
      }
    }
  }

  process(inputs, outputs) {
    const music = outputs[0]
    const L = music[0]
    const R = music[1] || music[0]
    const crackle = outputs[1] ? outputs[1][0] : null
    const n = L.length
    const revStep = 1 / (REV_SECONDS * sampleRate)

    for (let i = 0; i < n; i++) {
      this.rate += (this.targetRate - this.rate) * this.rateAlpha
      const r = this.rate
      const speed = Math.abs(r)

      // ————— the record —————
      // The buffer is a seamless loop (musical tails folded into the head), so
      // the playhead wraps modulo length in either direction. There is no
      // "end" — a record on a running turntable plays until you lift the arm.
      let l = 0
      let rr = 0
      if (this.left && this.length > 1) {
        const len = this.length
        this.pos += r
        if (this.pos >= len) this.pos -= len
        else if (this.pos < 0) this.pos += len
        // guard against a huge single-frame jump (e.g. a violent flick)
        if (this.pos >= len || this.pos < 0) this.pos = ((this.pos % len) + len) % len
        const i0 = this.pos | 0
        const i1 = i0 + 1 >= len ? 0 : i0 + 1
        const frac = this.pos - i0
        l = this.left[i0] + (this.left[i1] - this.left[i0]) * frac
        rr = this.right[i0] + (this.right[i1] - this.right[i0]) * frac
      }

      // click-free ramp after load/seek; bidirectional so a staged swap can
      // fade the old groove to silence, swap buffers, then fade the new one in
      if (this.ramp < this.rampTarget) {
        this.ramp = Math.min(this.rampTarget, this.ramp + this.rampStep)
      } else if (this.ramp > this.rampTarget) {
        this.ramp = Math.max(this.rampTarget, this.ramp - this.rampStep)
        if (this.ramp <= 0 && this.pendingLeft) {
          this.left = this.pendingLeft
          this.right = this.pendingRight
          this.length = this.pendingLength
          this.pos = 0
          this.pendingLeft = null
          this.pendingRight = null
          this.rampTarget = 1
        }
      }
      l *= this.ramp
      rr *= this.ramp

      // DC blockers: y[n] = x[n] - x[n-1] + 0.9975 y[n-1]
      const dl = this.dcL
      let y = l - dl.x1 + 0.9975 * dl.y1
      dl.x1 = l
      dl.y1 = y
      L[i] = y
      const dr = this.dcR
      y = rr - dr.x1 + 0.9975 * dr.y1
      dr.x1 = rr
      dr.y1 = y
      R[i] = y

      // ————— the medium —————
      if (crackle) {
        // platter phase advances with rate even when pos is pinned (run-out)
        const prevPhase = this.revPhase
        this.revPhase += r * revStep
        if (this.revPhase >= 1) this.revPhase -= 1
        else if (this.revPhase < 0) this.revPhase += 1

        // deterministic groove scars — fire once per real crossing in EITHER
        // direction. lo/hi + a wrap test makes this direction-agnostic and
        // correct across the 0/1 phase seam (a naive a<b test double-fires and
        // roars in reverse).
        if (speed > 0.02) {
          const a = prevPhase
          const b = this.revPhase
          const lo = a < b ? a : b
          const hi = a < b ? b : a
          const wrapped = hi - lo > 0.5
          for (let s = 0; s < SCAR_PHASES.length; s++) {
            const p = SCAR_PHASES[s]
            const crossed = wrapped ? p <= lo || p > hi : p > lo && p <= hi
            if (crossed) this.tickEnv = Math.min(1, this.tickEnv + 0.5)
          }
        }

        // Poisson dust: density and gain ride the groove speed
        const density = 11 * (0.25 + 0.75 * Math.min(speed, 2)) * this.dustiness
        if (speed > 0.015 && Math.random() < density / sampleRate) {
          const big = Math.random() < 0.018
          const amp = (big ? 2.6 : 1) * (0.12 + Math.pow(Math.random(), 2.2) * 0.55)
          this.tickEnv = Math.min(1.6, this.tickEnv + amp)
        }

        let c = 0
        if (this.tickEnv > 0.0005) {
          const impulse = (Math.random() * 2 - 1) * this.tickEnv
          // 30% "dusty" ticks are darker: blend through a one-pole lowpass
          this.tickLp += (impulse - this.tickLp) * 0.35
          c = impulse * 0.7 + this.tickLp * 0.5
          this.tickEnv *= 0.9985 - Math.min(speed, 2) * 0.01
        }
        // surface hiss, gently lowpassed, only when the groove moves
        const hissAmt = 0.006 * Math.min(speed, 1.2) * this.dustiness
        this.hissLp += ((Math.random() * 2 - 1) - this.hissLp) * 0.18
        c += this.hissLp * hissAmt
        crackle[i] = c
      }
    }

    if (++this.blockCount >= 4) {
      // every 512 samples ≈ 86 Hz
      this.blockCount = 0
      this.port.postMessage({ type: 'pos', frame: this.pos, length: this.length })
    }
    return true
  }
}

registerProcessor('turntable', TurntableProcessor)
