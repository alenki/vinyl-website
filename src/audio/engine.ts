import { renderTrack, type TrackDef } from './composer'

// Old iOS/Android (and any browser missing unprefixed Web Audio) expose only the
// webkit-prefixed constructor; a browser could also lack Web Audio entirely, so
// this may be undefined and we fall back to a bare <audio> element.
const AudioCtx: typeof AudioContext | undefined =
  typeof window !== 'undefined'
    ? window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    : undefined

/** The full AudioWorklet path exists (iOS Safari 14.5+, Chrome 66+, etc.). */
function workletUsable(ctx: AudioContext): boolean {
  return (
    typeof AudioWorkletNode !== 'undefined' &&
    !!ctx.audioWorklet &&
    typeof ctx.audioWorklet.addModule === 'function'
  )
}

/** Reject if a promise (an in-app WKWebView addModule can hang) outlives `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error('audio worklet module load timed out')), ms)
    p.then(
      (v) => {
        clearTimeout(id)
        resolve(v)
      },
      (e) => {
        clearTimeout(id)
        reject(e)
      },
    )
  })
}

/** iPhone/iPad, including iPadOS 13+ which reports itself as desktop Safari. */
function isAppleTouch(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  return /iP(hone|od|ad)/.test(ua) || (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document)
}

// A short, genuinely-silent WAV as a data URI (built once). On iOS, an actually-
// playing HTMLMediaElement — even a silent one — is the only web-side lever that
// promotes a WKWebView's audio session onto the media channel, so a Web Audio
// graph becomes audible inside in-app browsers (Telegram, Instagram) and with the
// hardware silent switch on. See WebKit #167788 / #237322.
let cachedSilentClip = ''
function silentClip(): string {
  if (cachedSilentClip) return cachedSilentClip
  const rate = 8000
  const samples = Math.floor(rate * 0.25)
  const size = 44 + samples
  const buf = new ArrayBuffer(size)
  const dv = new DataView(buf)
  const ascii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  dv.setUint32(4, size - 8, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  dv.setUint32(16, 16, true) // PCM header size
  dv.setUint16(20, 1, true) // format = PCM
  dv.setUint16(22, 1, true) // mono
  dv.setUint32(24, rate, true)
  dv.setUint32(28, rate, true) // byte rate (8-bit mono)
  dv.setUint16(32, 1, true) // block align
  dv.setUint16(34, 8, true) // bits per sample
  ascii(36, 'data')
  dv.setUint32(40, samples, true)
  for (let i = 0; i < samples; i++) dv.setUint8(44 + i, 128) // 8-bit PCM: 128 = silence
  const u8 = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i])
  cachedSilentClip = 'data:audio/wav;base64,' + btoa(bin)
  return cachedSilentClip
}

/**
 * The deck. Owns the realtime audio graph around the turntable worklet:
 *
 *   worklet out0 (music) → scratch filter → needle gain → analyser (VU tap)
 *                        → master → destination
 *   mechanical sfx → master (joins at the output, clear of the music)
 *
 * The music path is deliberately flat: the artist hands us a finished master,
 * so nothing here re-EQs, drives, or compresses it. The scratch filter is a
 * velocity-mapped lowpass that only bites when you scrub slowly (fully open at
 * speed); the needle gain is the stylus gate. The platter physics drives
 * `setRate` every frame; everything audible follows from that one number.
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

  // Fallback path. When the AudioWorklet is unavailable (old iOS < 14.5) or its
  // module fails to load, the record plays through a plain <audio> element
  // instead — no scratch/reverse, but the music plays and grabbing still
  // silences it instantly (pause). `primer` is a silent looping element that
  // keeps the iOS audio session on the audible channel (see silentClip()).
  private mode: 'worklet' | 'element' = 'worklet'
  private initialized = false
  private music: HTMLAudioElement | null = null
  private primer: HTMLAudioElement | null = null
  private needleDown = false
  private trackLoaded = false // a real (non-silent) src is on the music element

  onPosition: ((seconds: number, duration: number) => void) | null = null
  onEnded: (() => void) | null = null

  get ready() {
    return this.mode === 'element' ? this.music !== null : this.worklet !== null
  }

  get sampleRate() {
    return this.ctx?.sampleRate ?? 44100
  }

  /** Must be called from a user gesture (autoplay policy). Idempotent. */
  async init(): Promise<void> {
    // Re-entry (e.g. changing tracks): keep the session promoted and the
    // context awake, then bail — the graph/element is already built.
    if (this.initialized) {
      this.promoteAudioSession()
      this.startPrimer()
      if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume()
      return
    }

    // Everything up to the first `await` runs inside the click gesture. Promote
    // the audio session FIRST, synchronously, so it takes hold while the gesture
    // is still current — this is what makes sound audible in Telegram / in-app
    // WKWebViews and with the iOS silent switch on.
    this.promoteAudioSession()
    this.startPrimer()

    // No Web Audio, or no AudioWorklet (old iOS < 14.5): play the record through
    // a plain <audio> element. It needs no worklet and, being a real media
    // element, is audible where bare Web Audio is silenced. This branch is
    // reached synchronously, so the element is unlocked inside the gesture.
    if (!AudioCtx || typeof AudioWorkletNode === 'undefined') {
      this.startElementMode()
      this.initialized = true
      return
    }

    const ctx = new AudioCtx({ latencyHint: 'interactive' })
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

    try {
      if (!workletUsable(ctx)) throw new Error('AudioWorklet unavailable')
      // A WKWebView can hang on addModule; fall back rather than wait forever.
      await withTimeout(ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}turntable-processor.js`), 8000)
      this.buildWorkletGraph(ctx)
      this.mode = 'worklet'
    } catch (err) {
      console.warn('[deck] AudioWorklet path unavailable — using <audio> fallback:', err)
      this.startElementMode()
    }

    if (this.mode === 'worklet' && ctx.state !== 'running') await ctx.resume()
    this.initialized = true
  }

  /** Wire the realtime worklet graph (the full-fidelity, scratchable path). */
  private buildWorkletGraph(ctx: AudioContext) {
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

    // The music stays flat — the artist's master is reproduced as-is: no EQ,
    // no tape-drive shaping, no compression. The only things between the groove
    // and the speakers are the scratch lowpass (transparent at speed) and the
    // stylus gate above, then a transparent VU tap. (An earlier "warmth chain"
    // shelved the bass up and glued the mix louder — that re-mastered the
    // artist's track, so it's gone.)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.5
    this.analyser = analyser
    this.analyserData = new Uint8Array(analyser.fftSize)

    const master = ctx.createGain()
    master.gain.value = 1

    // music: stylus gate → VU tap → master → out (the analyser passes audio
    // through unchanged, so the record reaches the speakers untouched)
    needleGain.connect(analyser)
    analyser.connect(master)
    master.connect(ctx.destination)

    // mechanical sfx (needle drops, switch clunks) join at the master, so they
    // stay audible but never colour or compress the music — and no longer move
    // the VU meter, which now reads the record itself
    const sfxBus = ctx.createGain()
    sfxBus.gain.value = 0.9
    this.sfxBus = sfxBus
    sfxBus.connect(master)
  }

  /**
   * Opt the page's audio session onto the media/"playback" channel so Web Audio
   * ignores the iOS silent switch (iOS 17+; a no-op elsewhere). The silent
   * primer below covers older iOS that lacks this API.
   */
  private promoteAudioSession() {
    try {
      const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession
      if (session && session.type !== 'playback') session.type = 'playback'
    } catch {
      /* not supported */
    }
  }

  /**
   * Keep a short silent media element looping (iOS only). Actually playing an
   * HTMLMediaElement is what flips a WKWebView's audio session to the audible
   * channel, so the worklet — or the <audio> fallback — is heard inside Telegram
   * and with the silent switch on. Paused while the page is hidden.
   */
  private startPrimer() {
    if (!isAppleTouch()) return
    let a = this.primer
    if (!a) {
      a = new Audio(silentClip())
      a.loop = true
      a.setAttribute('playsinline', '')
      a.setAttribute('webkit-playsinline', '')
      this.primer = a
      document.addEventListener('visibilitychange', () => {
        const el = this.primer
        if (!el) return
        if (document.hidden) el.pause()
        else void el.play().catch(() => {})
      })
    }
    void a.play().catch(() => {})
  }

  /** Switch to the <audio> fallback and unlock the element inside the gesture. */
  private startElementMode() {
    if (this.mode !== 'element') console.warn('[deck] AudioWorklet unavailable — playing via <audio> fallback')
    this.mode = 'element'
    const a = this.ensureMusicElement()
    // The first play() must happen in a user gesture on strict iOS; bless the
    // element now with the silent clip. loadTrack swaps in the real src, and
    // `trackLoaded` keeps this priming from firing onEnded/onPosition.
    if (!a.src) a.src = silentClip()
    void a.play().catch(() => {})
  }

  private ensureMusicElement(): HTMLAudioElement {
    if (this.music) return this.music
    const a = new Audio()
    a.preload = 'auto'
    a.setAttribute('playsinline', '')
    a.setAttribute('webkit-playsinline', '')
    const emitPos = () => {
      if (this.trackLoaded && a.duration > 0.1) this.onPosition?.(a.currentTime, a.duration)
    }
    a.addEventListener('timeupdate', emitPos)
    a.addEventListener('durationchange', emitPos)
    a.addEventListener('ended', () => {
      if (this.trackLoaded) this.onEnded?.()
    })
    this.music = a
    return a
  }

  /**
   * Render a track ("cut the lacquer") and put it on the platter.
   * Guarded by a generation counter — a stale render never wins.
   */
  async loadTrack(def: TrackDef): Promise<boolean> {
    if (this.mode === 'element') return this.loadTrackElement(def)
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
    // synthesized lacquers are seamless loops; a recorded song ends at the run-out
    this.worklet.port.postMessage({ type: 'load', left, right, loop: !def.src }, [left.buffer, right.buffer])
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

  /** Fallback loader: point the <audio> element at the recorded file. */
  private async loadTrackElement(def: TrackDef): Promise<boolean> {
    const generation = ++this.renderGeneration
    if (!def.src) {
      // The element fallback can only play recorded files; the synth path
      // ("cut the lacquer") needs the worklet. No current track hits this.
      console.warn(`[deck] "${def.id}" has no recorded src; the <audio> fallback can't synthesize it`)
      return false
    }
    const a = this.ensureMusicElement()
    this.trackLoaded = false
    a.loop = false // a recorded song ends at the run-out (onEnded), like the worklet path
    a.src = def.src
    a.load()
    if (generation !== this.renderGeneration) return false
    this.trackLoaded = true
    return true
  }

  /** Signed playback rate; 1 = 33⅓ RPM. Called every frame by the physics. */
  setRate(rate: number) {
    this.currentRate = rate
    if (this.mode === 'element') return this.setRateElement(rate)
    if (!this.ctx || !this.worklet) return
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

  /**
   * Fallback rate handling: a plain <audio> element can't scrub or reverse, so
   * the signed platter rate collapses to play/pause + a coarse speed. Planting a
   * finger (rate → 0) or lifting the stylus pauses instantly — the essential
   * "grab silences the record" feel survives; reverse-scratch audio does not.
   */
  private setRateElement(rate: number) {
    const a = this.music
    if (!a || !this.trackLoaded) return
    const shouldPlay = this.needleDown && rate > 0.06 // reverse/stopped → pause
    if (!shouldPlay) {
      if (!a.paused) a.pause()
      return
    }
    const pr = Math.min(2, Math.max(0.5, Math.abs(rate))) // Safari mutes outside ~[0.5, 2]
    if (Math.abs(a.playbackRate - pr) > 0.02) a.playbackRate = pr
    if (a.paused) void a.play().catch(() => {})
  }

  setNeedle(down: boolean) {
    this.needleDown = down
    if (this.mode === 'element') {
      // lift = immediate silence; drop lets the next setRate resume playback
      if (!down && this.music && !this.music.paused) this.music.pause()
      return
    }
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
    if (this.mode === 'element') {
      if (this.music && this.trackLoaded) {
        try {
          this.music.currentTime = seconds
        } catch {
          /* not seekable yet */
        }
      }
      return
    }
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
