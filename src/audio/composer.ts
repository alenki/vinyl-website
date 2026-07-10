/**
 * The pressing plant. Tracks with a `src` are pre-recorded files, decoded and
 * handed straight to the turntable worklet. Tracks without one are synthesized
 * from raw oscillators and noise, arranged and rendered offline into a stereo
 * buffer ("cutting the lacquer") — the same code also serves as the fallback if
 * a recorded file ever fails to decode. Either way the worklet plays the buffer
 * back like a stylus in a groove.
 */

// ————— deterministic humanization (same pressing every visit) —————
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12)

type Ctx = OfflineAudioContext

interface Buses {
  dry: GainNode
  verb: GainNode // send
  echo: GainNode // send
  rand: () => number
}

// ————— shared color: a generated impulse response (no files) —————
function makeReverb(ctx: Ctx, seconds: number, decay: number): ConvolverNode {
  const len = Math.floor(ctx.sampleRate * seconds)
  const ir = ctx.createBuffer(2, len, ctx.sampleRate)
  const rnd = mulberry32(0xbeef)
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch)
    // one-pole lowpass over the noise tail: a warm, dark room instead of a
    // bright fizzy wash. This single filter is the biggest reverb-quality win.
    let lp = 0
    for (let i = 0; i < len; i++) {
      const white = (rnd() * 2 - 1) * Math.pow(1 - i / len, decay)
      lp += (white - lp) * 0.26
      d[i] = lp * 1.9 // makeup for the energy the lowpass removed
    }
  }
  const conv = ctx.createConvolver()
  conv.buffer = ir
  return conv
}

function makeNoiseBuffer(ctx: Ctx, seconds = 2): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  const rnd = mulberry32(0xfeed)
  for (let i = 0; i < len; i++) d[i] = rnd() * 2 - 1
  return buf
}

function makeBuses(ctx: Ctx, seed: number, echoTime: number): Buses {
  const master = ctx.createDynamicsCompressor()
  // gentle glue, not a squash — the realtime warmth chain compresses again
  master.threshold.value = -13
  master.knee.value = 26
  master.ratio.value = 1.8
  master.attack.value = 0.012
  master.release.value = 0.25

  const trim = ctx.createGain()
  trim.gain.value = 0.9
  master.connect(trim)
  trim.connect(ctx.destination)

  const dry = ctx.createGain()
  dry.connect(master)

  const conv = makeReverb(ctx, 2.0, 3.2)
  const verbReturn = ctx.createGain()
  verbReturn.gain.value = 0.4
  const verb = ctx.createGain()
  verb.connect(conv)
  conv.connect(verbReturn)
  verbReturn.connect(master)

  const delay = ctx.createDelay(2)
  delay.delayTime.value = echoTime
  const fb = ctx.createGain()
  fb.gain.value = 0.28
  const damp = ctx.createBiquadFilter()
  damp.type = 'lowpass'
  damp.frequency.value = 2100
  const echoReturn = ctx.createGain()
  echoReturn.gain.value = 0.28
  const echo = ctx.createGain()
  echo.connect(delay)
  delay.connect(damp)
  damp.connect(fb)
  fb.connect(delay)
  damp.connect(echoReturn)
  echoReturn.connect(master)

  return { dry, verb, echo, rand: mulberry32(seed) }
}

// ————— instruments —————

/** Warm electric piano: a low-ratio FM bark over a sine body — Rhodes, not a
 *  bright DX bell. Ratio 3 keeps the sidebands on low harmonics (2f, 4f, 5f)
 *  so the tone stays woody instead of clangy. */
function ep(ctx: Ctx, b: Buses, t: number, midi: number, dur: number, vel: number, pan = 0, sends = 0.12) {
  const f = mtof(midi)
  const out = ctx.createGain()
  const p = ctx.createStereoPanner()
  p.pan.value = pan
  out.connect(p)

  const car = ctx.createOscillator()
  car.type = 'sine'
  car.frequency.value = f
  const mod = ctx.createOscillator()
  mod.type = 'sine'
  mod.frequency.value = f * 3
  const modGain = ctx.createGain()
  // gentler index, harder velocity scaling — soft notes stay pure, hard notes
  // get a touch of bark
  modGain.gain.setValueAtTime(f * (0.7 + 1.1 * vel * vel), t)
  modGain.gain.exponentialRampToValueAtTime(0.01, t + 0.16)
  mod.connect(modGain)
  modGain.connect(car.frequency)

  const body = ctx.createOscillator()
  body.type = 'sine'
  body.frequency.value = f * 2
  const bodyGain = ctx.createGain()
  bodyGain.gain.setValueAtTime(0.17 * vel, t)
  bodyGain.gain.exponentialRampToValueAtTime(0.001, t + 0.55)
  body.connect(bodyGain)
  bodyGain.connect(out)

  const env = ctx.createGain()
  env.gain.setValueAtTime(0.0001, t)
  env.gain.exponentialRampToValueAtTime(0.5 * vel, t + 0.005)
  env.gain.exponentialRampToValueAtTime(0.18 * vel, t + Math.max(0.2, dur * 0.6))
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.45)
  car.connect(env)
  env.connect(out)

  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 3400
  lp.Q.value = 0.4
  p.connect(lp)
  lp.connect(b.dry)
  const sendGain = ctx.createGain()
  sendGain.gain.value = sends
  lp.connect(sendGain)
  sendGain.connect(b.verb)

  car.start(t)
  mod.start(t)
  body.start(t)
  const end = t + dur + 0.6
  car.stop(end)
  mod.stop(end)
  body.stop(end)
}

/** Round, slightly driven bass: triangle + sine sub through a lazy lowpass. */
function bass(ctx: Ctx, b: Buses, t: number, midi: number, dur: number, vel: number) {
  const f = mtof(midi)
  const tri = ctx.createOscillator()
  tri.type = 'triangle'
  tri.frequency.value = f
  const sub = ctx.createOscillator()
  sub.type = 'sine'
  sub.frequency.value = f
  const subGain = ctx.createGain()
  subGain.gain.value = 0.55
  sub.connect(subGain)

  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.setValueAtTime(900, t)
  lp.frequency.exponentialRampToValueAtTime(320, t + Math.max(0.15, dur))
  lp.Q.value = 0.8

  const env = ctx.createGain()
  env.gain.setValueAtTime(0.0001, t)
  env.gain.exponentialRampToValueAtTime(0.5 * vel, t + 0.012)
  env.gain.setValueAtTime(0.5 * vel, t + Math.max(0.02, dur - 0.06))
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.08)

  tri.connect(lp)
  subGain.connect(lp)
  lp.connect(env)
  env.connect(b.dry)
  tri.start(t)
  sub.start(t)
  tri.stop(t + dur + 0.2)
  sub.stop(t + dur + 0.2)
}

/** Clav-ish funk pluck: filtered saw with a snapping envelope. */
function pluck(ctx: Ctx, b: Buses, t: number, midi: number, vel: number, pan = 0) {
  const f = mtof(midi)
  const saw = ctx.createOscillator()
  saw.type = 'sawtooth'
  saw.frequency.value = f
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.setValueAtTime(f * 4, t)
  bp.frequency.exponentialRampToValueAtTime(f * 1.5, t + 0.12)
  bp.Q.value = 2.2
  const env = ctx.createGain()
  env.gain.setValueAtTime(0.0001, t)
  env.gain.exponentialRampToValueAtTime(0.27 * vel, t + 0.004)
  env.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
  const p = ctx.createStereoPanner()
  p.pan.value = pan
  saw.connect(bp)
  bp.connect(env)
  env.connect(p)
  p.connect(b.dry)
  const sendGain = ctx.createGain()
  sendGain.gain.value = 0.1
  p.connect(sendGain)
  sendGain.connect(b.echo)
  saw.start(t)
  saw.stop(t + 0.25)
}

/** Analog string machine: detuned saws under a slow-breathing lowpass. */
function strings(ctx: Ctx, b: Buses, t: number, midis: number[], dur: number, vel: number) {
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.setValueAtTime(700, t)
  lp.frequency.linearRampToValueAtTime(1500, t + dur * 0.6)
  lp.frequency.linearRampToValueAtTime(800, t + dur)
  const env = ctx.createGain()
  env.gain.setValueAtTime(0.0001, t)
  env.gain.linearRampToValueAtTime(0.062 * vel, t + Math.min(0.8, dur * 0.3))
  env.gain.setValueAtTime(0.062 * vel, t + dur - 0.4)
  env.gain.linearRampToValueAtTime(0.0001, t + dur + 0.8)
  lp.connect(env)
  env.connect(b.dry)
  const sendGain = ctx.createGain()
  sendGain.gain.value = 0.3
  env.connect(sendGain)
  sendGain.connect(b.verb)

  for (const m of midis) {
    for (const det of [-6, 5]) {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = mtof(m)
      o.detune.value = det + (b.rand() * 4 - 2)
      o.connect(lp)
      o.start(t)
      o.stop(t + dur + 1)
    }
  }
}

/** Vibraphone: sine + shimmer partial with a slow tremolo, drowned in reverb. */
function vibes(ctx: Ctx, b: Buses, t: number, midi: number, dur: number, vel: number, pan = 0) {
  const f = mtof(midi)
  const o1 = ctx.createOscillator()
  o1.type = 'sine'
  o1.frequency.value = f
  const o2 = ctx.createOscillator()
  o2.type = 'sine'
  o2.frequency.value = f * 4
  const g2 = ctx.createGain()
  g2.gain.setValueAtTime(0.12 * vel, t)
  g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.5)
  o2.connect(g2)

  const trem = ctx.createOscillator()
  trem.frequency.value = 4.6
  const tremDepth = ctx.createGain()
  tremDepth.gain.value = 0.32
  const tremBase = ctx.createGain()
  tremBase.gain.value = 0.68
  trem.connect(tremDepth)

  const env = ctx.createGain()
  env.gain.setValueAtTime(0.0001, t)
  env.gain.exponentialRampToValueAtTime(0.32 * vel, t + 0.005)
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur + 1.6)

  const tremGain = ctx.createGain()
  tremGain.gain.value = 0
  tremDepth.connect(tremGain.gain)
  tremBase.connect(tremGain.gain)

  const p = ctx.createStereoPanner()
  p.pan.value = pan
  o1.connect(env)
  g2.connect(env)
  env.connect(tremGain)
  tremGain.connect(p)
  p.connect(b.dry)
  const sendGain = ctx.createGain()
  sendGain.gain.value = 0.32
  p.connect(sendGain)
  sendGain.connect(b.verb)

  o1.start(t)
  o2.start(t)
  trem.start(t)
  const end = t + dur + 1.8
  o1.stop(end)
  o2.stop(end)
  trem.stop(end)
}

// ————— drums (all noise + oscillators) —————

interface Kit {
  noise: AudioBuffer
}

function kick(ctx: Ctx, b: Buses, _k: Kit, t: number, vel: number) {
  const o = ctx.createOscillator()
  o.type = 'sine'
  o.frequency.setValueAtTime(150, t)
  o.frequency.exponentialRampToValueAtTime(43, t + 0.09)
  const env = ctx.createGain()
  env.gain.setValueAtTime(0.0001, t)
  env.gain.exponentialRampToValueAtTime(0.85 * vel, t + 0.004)
  env.gain.exponentialRampToValueAtTime(0.0001, t + 0.3)
  o.connect(env)
  env.connect(b.dry)
  o.start(t)
  o.stop(t + 0.35)
}

function snare(ctx: Ctx, b: Buses, k: Kit, t: number, vel: number, brush = false) {
  const src = ctx.createBufferSource()
  src.buffer = k.noise
  src.loop = true
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = brush ? 3400 : 1900
  bp.Q.value = 0.7
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 6800
  const env = ctx.createGain()
  const dur = brush ? 0.22 : 0.16
  env.gain.setValueAtTime(0.0001, t)
  env.gain.exponentialRampToValueAtTime((brush ? 0.14 : 0.3) * vel, t + (brush ? 0.02 : 0.004))
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  src.connect(bp)
  bp.connect(lp)
  lp.connect(env)
  env.connect(b.dry)
  const sendGain = ctx.createGain()
  sendGain.gain.value = brush ? 0.1 : 0.14
  env.connect(sendGain)
  sendGain.connect(b.verb)

  if (!brush) {
    const tone = ctx.createOscillator()
    tone.type = 'triangle'
    tone.frequency.value = 186
    const tEnv = ctx.createGain()
    tEnv.gain.setValueAtTime(0.22 * vel, t)
    tEnv.gain.exponentialRampToValueAtTime(0.0001, t + 0.06)
    tone.connect(tEnv)
    tEnv.connect(b.dry)
    tone.start(t)
    tone.stop(t + 0.1)
  }
  src.start(t, b.rand() * 1.2)
  src.stop(t + dur + 0.05)
}

function hat(ctx: Ctx, b: Buses, k: Kit, t: number, vel: number, open = false) {
  const src = ctx.createBufferSource()
  src.buffer = k.noise
  src.loop = true
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 7400
  const env = ctx.createGain()
  const dur = open ? 0.34 : 0.05
  env.gain.setValueAtTime(0.0001, t)
  env.gain.exponentialRampToValueAtTime(0.1 * vel, t + 0.002)
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  src.connect(hp)
  hp.connect(env)
  env.connect(b.dry)
  src.start(t, b.rand() * 1.2)
  src.stop(t + dur + 0.05)
}

function shaker(ctx: Ctx, b: Buses, k: Kit, t: number, vel: number) {
  const src = ctx.createBufferSource()
  src.buffer = k.noise
  src.loop = true
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 5600
  bp.Q.value = 1.4
  const env = ctx.createGain()
  env.gain.setValueAtTime(0.0001, t)
  env.gain.linearRampToValueAtTime(0.055 * vel, t + 0.02)
  env.gain.exponentialRampToValueAtTime(0.0001, t + 0.09)
  src.connect(bp)
  bp.connect(env)
  env.connect(b.dry)
  src.start(t, b.rand() * 1.2)
  src.stop(t + 0.12)
}

// ————— track definitions —————

export interface TrackDef {
  id: string
  title: string
  side: string
  tempo: string
  blurb: string
  /**
   * Initial duration hint in seconds, used only for the UI before the track
   * has loaded. Once decoded, the worklet reports the true length back.
   */
  loopSeconds: number
  /** URL of a pre-recorded track to decode and play. */
  src?: string
  /** Fallback synthesizer, used when `src` is absent ("cut the lacquer"). */
  build?: (ctx: Ctx) => void
}

/**
 * A1 — lo-fi soul at 74 BPM. IV–iii–ii–V in C, boom-bap drums with swung
 * hats, EP comping, and a sparse pentatonic lead on the second pass.
 */
function buildGoldOnTheDial(ctx: Ctx) {
  const b = makeBuses(ctx, 0xa11ce, (60 / 74) * 0.75)
  const kit: Kit = { noise: makeNoiseBuffer(ctx) }
  const beat = 60 / 74
  const swing = beat * 0.09
  const bars = 16
  const t0 = 0

  // Fmaj7 · Em7 · Dm7 · G13 — two bars each
  const chords = [
    { ep: [53, 57, 60, 64], root: 41 },
    { ep: [52, 55, 59, 62], root: 40 },
    { ep: [50, 53, 57, 60], root: 38 },
    { ep: [47, 53, 57, 64], root: 43 },
  ]

  for (let bar = 0; bar < bars; bar++) {
    const bt = t0 + bar * 4 * beat
    const ch = chords[Math.floor((bar % 8) / 2)]
    const pass2 = bar >= 8

    // EP comping: downbeat pad, answered on the and-of-two
    const hum = () => (b.rand() - 0.5) * 0.014
    ch.ep.forEach((m, i) =>
      ep(ctx, b, bt + hum() + i * 0.012, m, 1.6, 0.75 + b.rand() * 0.1, (i - 1.5) * 0.2),
    )
    if (bar % 2 === 1) {
      ch.ep.slice(1).forEach((m, i) =>
        ep(ctx, b, bt + 2.5 * beat + swing + hum() + i * 0.01, m, 0.9, 0.5, (i - 1) * 0.25),
      )
    }

    // bass
    bass(ctx, b, bt, ch.root, beat * 1.4, 0.95)
    bass(ctx, b, bt + 1.5 * beat, ch.root, beat * 0.4, 0.7)
    bass(ctx, b, bt + 2.5 * beat, ch.root + 7, beat * 0.6, 0.8)
    if (bar % 2 === 1) {
      const next = chords[Math.floor(((bar + 1) % 8) / 2)]
      bass(ctx, b, bt + 3.5 * beat, next.root + (next.root > ch.root ? -1 : 1), beat * 0.45, 0.75)
    }

    // drums — boom-bap with swing
    kick(ctx, b, kit, bt, 1)
    kick(ctx, b, kit, bt + 2.5 * beat + swing, 0.8)
    if (bar % 4 === 3) kick(ctx, b, kit, bt + 3.75 * beat, 0.6)
    snare(ctx, b, kit, bt + 1 * beat, 0.9)
    snare(ctx, b, kit, bt + 3 * beat, 0.95)
    for (let e = 0; e < 8; e++) {
      const off = e % 2 === 1 ? swing : 0
      hat(ctx, b, kit, bt + e * 0.5 * beat + off, e % 2 === 0 ? 0.8 : 0.45 + b.rand() * 0.15)
    }
    if (bar % 4 === 3) hat(ctx, b, kit, bt + 3.5 * beat + swing, 0.7, true)
    if (pass2) for (let e = 0; e < 16; e++) shaker(ctx, b, kit, bt + e * 0.25 * beat, e % 4 === 2 ? 0.9 : 0.5)

    // lead enters on the second pass — F major pentatonic, sparse
    if (pass2) {
      const phrases: Array<Array<[number, number, number]>> = [
        [[0, 69, 0.8], [1.5, 67, 0.7], [2.5, 64, 1.2]],
        [[0.5, 65, 0.6], [2, 62, 0.9], [3, 60, 1.0]],
        [[0, 64, 0.7], [1, 67, 0.6], [2, 69, 0.7], [3, 72, 1.1]],
        [],
      ]
      for (const [pb, m, d] of phrases[bar % 4]) {
        ep(ctx, b, bt + pb * beat + swing * (pb % 1 === 0.5 ? 1 : 0), m, d, 0.62, 0.15, 0.4)
      }
    }
  }
}

/**
 * B1 — disco-funk at 108 BPM. Am7–D9 dorian vamp: four-on-the-floor,
 * offbeat open hats, sixteenth-note bass, clav stabs, string machine.
 */
function buildChromeCanyon(ctx: Ctx) {
  const b = makeBuses(ctx, 0xd15c0, (60 / 108) * 0.75)
  const kit: Kit = { noise: makeNoiseBuffer(ctx) }
  const beat = 60 / 108
  const six = beat / 4
  const bars = 24
  const t0 = 0

  // 16-step bass lines, [step, midi, lengthInSteps]
  const bassA: Array<[number, number, number]> = [
    [0, 33, 3], [3, 45, 1], [6, 43, 2], [8, 33, 2], [11, 45, 1], [12, 40, 2], [14, 43, 2],
  ]
  const bassD: Array<[number, number, number]> = [
    [0, 38, 3], [3, 50, 1], [6, 48, 2], [8, 38, 2], [11, 50, 1], [12, 45, 2], [14, 41, 2],
  ]

  for (let bar = 0; bar < bars; bar++) {
    const bt = t0 + bar * 4 * beat
    const isD = bar % 4 >= 2 // two bars Am7, two bars D9
    const line = isD ? bassD : bassA

    for (const [s, m, len] of line) bass(ctx, b, bt + s * six, m, six * len * 0.9, 0.9)

    // drums
    for (let q = 0; q < 4; q++) kick(ctx, b, kit, bt + q * beat, 0.95)
    snare(ctx, b, kit, bt + 1 * beat, 0.85)
    snare(ctx, b, kit, bt + 3 * beat, 0.9)
    for (let e = 0; e < 8; e++) {
      if (e % 2 === 1) hat(ctx, b, kit, bt + e * 0.5 * beat, 0.85, true)
      else hat(ctx, b, kit, bt + e * 0.5 * beat, 0.5)
    }
    for (let s = 0; s < 16; s++) if (s % 2 === 0) hat(ctx, b, kit, bt + s * six + six * 0.5, 0.22)

    // clav enters after 8 bars
    if (bar >= 8) {
      const notes = isD ? [50, 54, 57, 60] : [57, 60, 64, 67]
      const pattern = [0, 3, 4, 7, 10, 11, 14]
      pattern.forEach((s, i) => {
        if (b.rand() > 0.15) pluck(ctx, b, bt + s * six, notes[i % 4], 0.7 + b.rand() * 0.25, (i % 3 - 1) * 0.3)
      })
    }

    // string machine
    if (bar % 4 === 0) {
      strings(ctx, b, bt, bar % 8 < 4 ? [57, 60, 64, 71] : [57, 62, 66, 69], 4 * beat * 4 - 0.5, 1)
    }
    // octave disco line, last stretch
    if (bar >= 16) {
      const melo: Array<[number, number]> = [[0, 69], [1, 67], [2, 69], [3.5, 72]]
      for (const [pb, m] of melo) {
        vibes(ctx, b, bt + pb * beat, m, 0.5, 0.5, 0.2)
        vibes(ctx, b, bt + pb * beat, m + 12, 0.5, 0.3, -0.2)
      }
    }
  }
}

/**
 * C1 — a 3/4 dream-waltz at 84 BPM. Cmaj7 · Am7 · Fmaj7 · G7, EP arpeggios,
 * brushed snare, and a tremolo vibraphone lead swimming in reverb.
 */
function buildVelvetStatic(ctx: Ctx) {
  const b = makeBuses(ctx, 0x5107, (60 / 84) * 1.5)
  const kit: Kit = { noise: makeNoiseBuffer(ctx) }
  const beat = 60 / 84
  const bars = 24
  const t0 = 0

  const chords = [
    { arp: [48, 55, 59, 64], root: 36, pad: [60, 64, 67, 71] },
    { arp: [45, 52, 57, 60], root: 33, pad: [57, 60, 64, 67] },
    { arp: [41, 48, 53, 57], root: 29, pad: [57, 60, 65, 69] },
    { arp: [43, 50, 53, 59], root: 31, pad: [55, 59, 62, 65] },
  ]

  const melody: Array<Array<[number, number, number]>> = [
    [[0, 76, 2.2]],
    [[0, 74, 1.4], [2, 72, 0.9]],
    [[0, 69, 2.2], [2, 72, 0.9]],
    [[0, 67, 2.8]],
    [[0, 76, 1.4], [1, 79, 1.4]],
    [[0, 77, 2.2]],
    [[0, 72, 1.4], [2, 74, 0.9]],
    [[0, 72, 2.8]],
  ]

  for (let bar = 0; bar < bars; bar++) {
    const bt = t0 + bar * 3 * beat
    const ch = chords[bar % 4]
    const pass = Math.floor(bar / 8)

    // waltz bass: root on 1
    bass(ctx, b, bt, ch.root + 12, beat * 2.4, 0.8)

    // EP arpeggio, broken eighths
    ch.arp.forEach((m, i) => {
      ep(ctx, b, bt + i * 0.5 * beat, m, 0.7, 0.42 + b.rand() * 0.08, (i - 1.5) * 0.22, 0.32)
    })
    ep(ctx, b, bt + 2 * beat, ch.arp[2] + 12, 0.8, 0.34, 0.3, 0.32)

    // brushes
    kick(ctx, b, kit, bt, 0.55)
    snare(ctx, b, kit, bt + 1 * beat, 0.7, true)
    snare(ctx, b, kit, bt + 2 * beat, 0.5, true)
    hat(ctx, b, kit, bt + 0.5 * beat, 0.2)
    hat(ctx, b, kit, bt + 1.5 * beat, 0.25)
    hat(ctx, b, kit, bt + 2.5 * beat, 0.2)

    // pads from second pass
    if (pass >= 1 && bar % 2 === 0) {
      strings(ctx, b, bt, ch.pad, 6 * beat - 0.3, 0.75)
    }

    // vibraphone melody from pass 2 (and a hint at the end of pass 1)
    if (pass >= 2 || bar >= 6) {
      const phrase = melody[bar % 8]
      for (const [pb, m, d] of phrase) {
        vibes(ctx, b, bt + pb * beat, m, d * beat, 0.72, 0.1)
      }
    }
  }
}

const asset = (name: string) => `${import.meta.env.BASE_URL}tracks/${name}`

export const TRACKS: TrackDef[] = [
  {
    id: 'straight-outta-compton',
    title: 'Straight Outta Compton',
    side: 'A1',
    tempo: 'N.W.A',
    blurb: 'N.W.A — Straight Outta Compton, 1988.',
    loopSeconds: 259,
    src: asset('straight-outta-compton.mp3'),
    build: buildGoldOnTheDial,
  },
  {
    id: 'cream',
    title: 'C.R.E.A.M.',
    side: 'A2',
    tempo: 'Wu-Tang Clan',
    blurb: 'Wu-Tang Clan — Enter the Wu-Tang (36 Chambers), 1993.',
    loopSeconds: 255,
    src: asset('cream.mp3'),
    build: buildChromeCanyon,
  },
  {
    id: '8-ball-remix',
    title: '8 Ball (Remix)',
    side: 'B1',
    tempo: 'Eazy-E',
    blurb: 'N.W.A / Eazy-E — 8 Ball (Remix).',
    loopSeconds: 292,
    src: asset('8-ball-remix.mp3'),
    build: buildVelvetStatic,
  },
]

const TAIL_SECONDS = 3.5

/**
 * Render a track to a seamless-loop stereo buffer — "cutting the lacquer".
 *
 * Renders at the live context's sample rate (the worklet reads raw frames; a
 * mismatched rate would repitch everything). Renders one loop PLUS a tail, then
 * folds the tail (reverb/delay ringing out past the loop point) back into the
 * head so the seam is inaudible. Finally normalizes to −16 dBFS RMS, peak ≤ −3.
 */
export async function renderTrack(def: TrackDef, sampleRate: number): Promise<AudioBuffer> {
  const loopLen = Math.round(def.loopSeconds * sampleRate)
  const tailLen = Math.round(TAIL_SECONDS * sampleRate)
  const ctx = new OfflineAudioContext(2, loopLen + tailLen, sampleRate)
  if (!def.build) throw new Error(`track ${def.id} has no synthesizer to render`)
  def.build(ctx)
  const rendered = await ctx.startRendering()

  const out = new OfflineAudioContext(2, loopLen, sampleRate) // just to mint a buffer
  const buf = out.createBuffer(2, loopLen, sampleRate)

  let sumSq = 0
  let peak = 0
  for (let ch = 0; ch < 2; ch++) {
    const src = rendered.getChannelData(ch)
    const dst = buf.getChannelData(ch)
    for (let i = 0; i < loopLen; i++) {
      // fold the tail that rang out past the loop point back onto the head
      const tail = i < tailLen ? src[loopLen + i] : 0
      const v = src[i] + tail
      dst[i] = v
      sumSq += v * v
      const a = v < 0 ? -v : v
      if (a > peak) peak = a
    }
  }

  const rms = Math.sqrt(sumSq / (loopLen * 2))
  if (rms > 0.0001) {
    let gain = 0.158 / rms // −16 dBFS
    if (peak * gain > 0.708) gain = 0.708 / peak // cap at −3 dBFS
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch)
      for (let i = 0; i < loopLen; i++) d[i] *= gain
    }
  }
  return buf
}
