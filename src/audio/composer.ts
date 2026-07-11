/**
 * The pressing plant. Tracks with a `src` are pre-recorded files, decoded and
 * handed straight to the turntable worklet. A track may instead carry a
 * `build` synthesizer, rendered offline into a stereo buffer ("cutting the
 * lacquer") — kept as the fallback path, though every current track is a
 * recording. Either way the worklet plays the buffer back like a stylus in a
 * groove.
 */

type Ctx = OfflineAudioContext

// track definitions

export interface TrackDef {
  id: string
  title: string
  /** The year the song was created — shown in the masthead alongside the title. */
  year: string
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

const asset = (name: string) => `${import.meta.env.BASE_URL}tracks/${name}`

export const TRACKS: TrackDef[] = [
  {
    id: 'gasnet-svet',
    title: 'Гаснет Свет',
    year: '2026',
    side: 'A1',
    tempo: '2:56',
    blurb: 'ESOES & ÉLI · Гаснет Свет',
    loopSeconds: 176,
    src: asset('gasnet-svet.mp3'),
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
