import { renderTrack, type TrackDef } from './composer'

/**
 * The deck. Owns the realtime audio graph around the turntable worklet:
 *
 *   worklet out0 (music) → scratch filter → needle gain → warmth chain
 *   mechanical sfx → compressor (joins the chain, skips the shaper)
 *
 * warmth chain: low shelf → mid dip → high shelf → tanh shaper → compressor
 * → analyser → master → destination. The platter physics drives `setRate`
 * every frame; everything audible follows from that one number.
 *
 * (The worklet can also emit procedural surface crackle on a second output;
 * the deck leaves it unwired — this pressing plays clean, no background static.)
 */
export class TurntableAudio {
  private ctx: AudioContext | null = null
  private worklet: AudioWorkletNode | null = null
  private scratchFilter: BiquadFilterNode | null = null
  private needleGain: GainNode | null = null
  private sfxBus: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private analyserData: Uint8Array<ArrayBuffer> | null = null
  private currentRate = 0
  private lastSentRate = 999
  private lastCutoff = 0
  private renderGeneration = 0

  onPosition: ((seconds: number, duration: number) => void) | null = null
  onEnded: (() => void) | null = null

  get ready() {
    return this.worklet !== null
  }

  get sampleRate() {
    return this.ctx?.sampleRate ?? 44100
  }

  /** Must be called from a user gesture (autoplay policy). Idempotent. */
  async init(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state !== 'running') await this.ctx.resume()
      return
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    this.ctx = ctx
    // resume synchronously inside the gesture, before any await (iOS)
    void ctx.resume()

    // iOS can move the context to a non-standard 'interrupted' state
    const revive = () => {
      if (ctx.state !== 'running') void ctx.resume()
    }
    ctx.addEventListener('statechange', revive)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) revive()
    })

    await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}turntable-processor.js`)

    const worklet = new AudioWorkletNode(ctx, 'turntable', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    })
    this.worklet = worklet
    worklet.port.onmessage = (e) => {
      const d = e.data
      if (d.type === 'pos') this.onPosition?.(d.frame / ctx.sampleRate, d.length / ctx.sampleRate)
      else if (d.type === 'ended') this.onEnded?.()
    }

    // music path: velocity-mapped lowpass (slow scrubs sound muffled), then stylus gate
    const scratchFilter = ctx.createBiquadFilter()
    scratchFilter.type = 'lowpass'
    scratchFilter.frequency.value = 20000
    scratchFilter.Q.value = 0.5
    this.scratchFilter = scratchFilter

    const needleGain = ctx.createGain()
    needleGain.gain.value = 0
    this.needleGain = needleGain
    worklet.connect(scratchFilter, 0)
    scratchFilter.connect(needleGain)

    // ————— warmth chain —————
    const lowShelf = ctx.createBiquadFilter()
    lowShelf.type = 'lowshelf'
    lowShelf.frequency.value = 110
    lowShelf.gain.value = 2

    const midDip = ctx.createBiquadFilter()
    midDip.type = 'peaking'
    midDip.frequency.value = 3800
    midDip.Q.value = 0.7
    midDip.gain.value = -1.5

    const highShelf = ctx.createBiquadFilter()
    highShelf.type = 'highshelf'
    highShelf.frequency.value = 9500
    highShelf.gain.value = -3

    const shaper = ctx.createWaveShaper()
    const curve = new Float32Array(4096)
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1
      // gentler tape drive — warmth without grit (the composer master already
      // glued the mix, so this only needs to round the very peaks)
      curve[i] = Math.tanh(x * 1.25) / Math.tanh(1.25)
    }
    shaper.curve = curve
    shaper.oversample = '4x'

    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -20
    comp.knee.value = 18
    comp.ratio.value = 1.8
    comp.attack.value = 0.014
    comp.release.value = 0.3

    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.5
    this.analyser = analyser
    this.analyserData = new Uint8Array(analyser.fftSize)

    const master = ctx.createGain()
    master.gain.value = 0.85

    needleGain.connect(lowShelf)
    lowShelf.connect(midDip)
    midDip.connect(highShelf)
    highShelf.connect(shaper)
    shaper.connect(comp)
    comp.connect(analyser)
    analyser.connect(master)
    master.connect(ctx.destination)

    // mechanical sfx (needle drops, switch clunks) skip the shaper
    const sfxBus = ctx.createGain()
    sfxBus.gain.value = 0.9
    this.sfxBus = sfxBus
    sfxBus.connect(comp)

    if (ctx.state !== 'running') await ctx.resume()
  }

  /**
   * Render a track ("cut the lacquer") and put it on the platter.
   * Guarded by a generation counter — a stale render never wins.
   */
  async loadTrack(def: TrackDef): Promise<boolean> {
    if (!this.worklet || !this.ctx) throw new Error('audio not initialized')
    const generation = ++this.renderGeneration
    // A `src` track is a pre-recorded file we decode; otherwise we synthesize
    // one ("cut the lacquer") from raw oscillators. If a file fails to decode,
    // fall back to the synthesizer when the track carries one.
    let buffer: AudioBuffer
    if (def.src) {
      try {
        buffer = await this.decodeFile(def.src)
      } catch (err) {
        if (!def.build) throw err
        console.warn(`[deck] falling back to synth for "${def.id}":`, err)
        buffer = await renderTrack(def, this.ctx.sampleRate)
      }
    } else {
      buffer = await renderTrack(def, this.ctx.sampleRate)
    }
    if (generation !== this.renderGeneration) return false
    const left = new Float32Array(buffer.length)
    const right = new Float32Array(buffer.length)
    buffer.copyFromChannel(left, 0)
    // mono files feed the same channel to both sides
    buffer.copyFromChannel(right, buffer.numberOfChannels > 1 ? 1 : 0)
    this.worklet.port.postMessage({ type: 'load', left, right }, [left.buffer, right.buffer])
    return true
  }

  /** Fetch and decode a recorded track to the live context's sample rate. */
  private async decodeFile(url: string): Promise<AudioBuffer> {
    if (!this.ctx) throw new Error('audio not initialized')
    const res = await fetch(url)
    if (!res.ok) throw new Error(`failed to load track: ${url} (${res.status})`)
    const bytes = await res.arrayBuffer()
    return await this.ctx.decodeAudioData(bytes)
  }

  /** Signed playback rate; 1 = 33⅓ RPM. Called every frame by the physics. */
  setRate(rate: number) {
    if (!this.ctx || !this.worklet) return
    this.currentRate = rate
    if (Math.abs(rate - this.lastSentRate) > 0.0004) {
      this.lastSentRate = rate
      this.worklet.port.postMessage({ type: 'rate', value: rate })
    }

    const t = this.ctx.currentTime
    const speed = Math.abs(rate)

    // scratch filter: fully open at speed, muffled when scrubbed slowly
    if (this.scratchFilter) {
      const cutoff = 420 + 19500 * Math.pow(Math.min(speed, 1), 1.3)
      if (Math.abs(cutoff - this.lastCutoff) > this.lastCutoff * 0.06) {
        this.lastCutoff = cutoff
        this.scratchFilter.frequency.setTargetAtTime(cutoff, t, 0.03)
      }
    }
  }

  setNeedle(down: boolean) {
    if (!this.ctx || !this.needleGain) return
    const t = this.ctx.currentTime
    if (down) {
      this.needleGain.gain.setTargetAtTime(1, t + 0.04, 0.05)
      this.playNeedleDrop()
    } else {
      this.needleGain.gain.setTargetAtTime(0, t, 0.025)
      this.playLift()
    }
  }

  /** Wear system: 1 = clean copy, higher = dustier (denser, louder crackle). */
  setDustiness(d: number) {
    this.worklet?.port.postMessage({ type: 'dust', value: d })
  }

  seekToSeconds(seconds: number) {
    if (!this.ctx || !this.worklet) return
    this.worklet.port.postMessage({ type: 'seek', frame: Math.floor(seconds * this.ctx.sampleRate) })
  }

  /** RMS level 0..1 off the mix bus, for the VU meters. */
  getLevel(): number {
    if (!this.analyser || !this.analyserData) return 0
    this.analyser.getByteTimeDomainData(this.analyserData)
    let sum = 0
    for (let i = 0; i < this.analyserData.length; i++) {
      const v = (this.analyserData[i] - 128) / 128
      sum += v * v
    }
    return Math.sqrt(sum / this.analyserData.length)
  }

  private playNeedleDrop() {
    const ctx = this.ctx
    if (!ctx || !this.sfxBus) return
    const t = ctx.currentTime
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(62, t)
    o.frequency.exponentialRampToValueAtTime(36, t + 0.12)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.45, t + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24)
    o.connect(g)
    g.connect(this.sfxBus)
    o.start(t)
    o.stop(t + 0.3)

    const len = Math.floor(ctx.sampleRate * 0.09)
    const nb = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = nb.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len)
    const src = ctx.createBufferSource()
    src.buffer = nb
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 2400
    const ng = ctx.createGain()
    ng.gain.value = 0.16
    src.connect(lp)
    lp.connect(ng)
    ng.connect(this.sfxBus)
    src.start(t)
  }

  private playLift() {
    const ctx = this.ctx
    if (!ctx || !this.sfxBus) return
    const t = ctx.currentTime
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(170, t)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.005)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05)
    o.connect(g)
    g.connect(this.sfxBus)
    o.start(t)
    o.stop(t + 0.08)
  }

  /** Letterpress chunk for switches, stamps and hovers. */
  playClick(bright = false) {
    const ctx = this.ctx
    if (!ctx || !this.sfxBus) return
    const t = ctx.currentTime
    const len = Math.floor(ctx.sampleRate * 0.03)
    const nb = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = nb.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len)
    const src = ctx.createBufferSource()
    src.buffer = nb
    const f = ctx.createBiquadFilter()
    f.type = 'bandpass'
    f.frequency.value = bright ? 3000 : 1100
    f.Q.value = 1.4
    const g = ctx.createGain()
    g.gain.value = bright ? 0.14 : 0.2
    src.connect(f)
    f.connect(g)
    g.connect(this.sfxBus)
    src.start(t)
  }

  /** The soft thud of a record landing on the platter after a flip. */
  playThud() {
    const ctx = this.ctx
    if (!ctx || !this.sfxBus) return
    const t = ctx.currentTime
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(95, t)
    o.frequency.exponentialRampToValueAtTime(42, t + 0.09)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.4, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28)
    o.connect(g)
    g.connect(this.sfxBus)
    o.start(t)
    o.stop(t + 0.32)
  }

  getRate() {
    return this.currentRate
  }
}

export const deck = new TurntableAudio()
