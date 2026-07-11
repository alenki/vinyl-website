import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FICTION } from './fiction'
import { TRACKS } from './audio/composer'
import { useTurntable } from './useTurntable'
import { VinylFace } from './components/Vinyl'
import { Tonearm } from './components/Tonearm'

function fmt(sec: number) {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

const PlayGlyph = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
  </svg>
)
const StopGlyph = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" />
  </svg>
)

export default function App() {
  const rotorA = useRef<HTMLDivElement>(null)
  const rotorB = useRef<HTMLDivElement>(null)
  const armRotor = useRef<HTMLDivElement>(null)
  const flipper = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const zone = useRef<HTMLDivElement>(null)

  const [zoneSize, setZoneSize] = useState(560)
  const [jolt, setJolt] = useState(false)

  // the physics loop rotates whichever face is showing; we keep both refs and
  // point the hook at the visible one
  const activeRotor = useRef<HTMLDivElement>(null) as React.RefObject<HTMLDivElement | null>

  const tt = useTurntable(activeRotor, armRotor, flipper)
  const { state, bindZone } = tt

  // keep the active rotor pointing at the current side's face
  useEffect(() => {
    activeRotor.current = state.side === 'A' ? rotorA.current : rotorB.current
  }, [state.side])

  // bind the zone element for pointer geometry + measure it
  const measure = useCallback(() => {
    if (zone.current) setZoneSize(zone.current.getBoundingClientRect().width)
  }, [])
  useLayoutEffect(() => {
    bindZone(zone.current)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [bindZone, measure])

  // a soft settle when the needle drops into the groove
  const prevPhase = useRef(state.phase)
  useEffect(() => {
    if (state.phase === 'playing' && prevPhase.current !== 'playing' && !prefersReducedMotion()) {
      setJolt(true)
      const id = setTimeout(() => setJolt(false), 110)
      prevPhase.current = state.phase
      return () => clearTimeout(id)
    }
    prevPhase.current = state.phase
  }, [state.phase])

  const onZoneKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        tt.nudge(-1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        tt.nudge(1)
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        tt.toggleMotor()
      }
    },
    [tt],
  )

  const booting = state.phase === 'boot'
  const current = TRACKS[state.trackIndex]
  const playing = state.phase === 'playing' && state.motorOn

  return (
    <>
      <div className="paper" />

      <main
        ref={stage}
        className={`stage${jolt ? ' jolt' : ''}`}
        onPointerMove={tt.onPointerMove}
        onPointerUp={tt.endGrab}
        onPointerCancel={tt.endGrab}
      >
        {/* quiet masthead */}
        <header className="masthead">
          <h1 className="album">ESOES &amp; ÉLI</h1>
          <p className="by">
            {current.title} <span className="sep">·</span> {current.year}
          </p>
        </header>

        {/* the deck */}
        <div className="deck">
          <div
            ref={zone}
            className="vinyl-zone"
            role="slider"
            tabIndex={0}
            aria-label="Пластинка. Тяните, чтобы скретчить; стрелки подталкивают; пробел запускает и останавливает."
            aria-valuemin={-120}
            aria-valuemax={120}
            aria-valuenow={Math.round(state.rpm)}
            aria-valuetext={`${Math.abs(state.rpm).toFixed(0)} об/мин`}
            onPointerDown={tt.onPointerDown}
            onLostPointerCapture={tt.endGrab}
            onKeyDown={onZoneKeyDown}
          >
            <div className="record-shadow" />
            <div className="flip-wrap">
              <div
                className="flipper"
                ref={flipper}
                style={{ transition: 'transform 0.9s cubic-bezier(0.7,0,0.2,1)' }}
              >
                <div className="face a">
                  <VinylFace side="A" rotorRef={rotorA} held={state.held} dusty={state.dusty && state.side === 'A'} />
                </div>
                <div className="face b">
                  <VinylFace side="B" rotorRef={rotorB} held={state.held} dusty={state.dusty && state.side === 'B'} />
                </div>
              </div>
            </div>
            {state.showHint && (
              <div className="scratch-hint" aria-hidden="true">
                потяните, чтобы скретчить
              </div>
            )}
          </div>

          <div className="arm-layer">
            <Tonearm armRotorRef={armRotor} lifted={state.phase !== 'playing'} size={zoneSize} />
          </div>
        </div>

        {/* console */}
        <footer className="console">
          <div className="progress" aria-hidden="true">
            <span style={{ transform: `scaleX(${Math.max(0, Math.min(1, state.progress))})` }} />
          </div>

          <div className="transport">
            <button
              className="play"
              onClick={tt.toggleMotor}
              aria-pressed={state.motorOn}
              aria-label={state.motorOn ? 'Стоп' : 'Пуск'}
            >
              {state.motorOn ? <StopGlyph /> : <PlayGlyph />}
            </button>
            <div className="now">
              <span className="now-title">{current.title}</span>
              <span className="now-time">
                {fmt(state.elapsed)} <span className="dim">/ {fmt(state.duration)}</span>
              </span>
            </div>
          </div>

          <ol className="tracks">
            {TRACKS.map((track, i) => (
              <li key={track.id}>
                <button
                  className={`track${i === state.trackIndex ? ' current' : ''}`}
                  onClick={() => tt.selectTrack(i)}
                  aria-current={i === state.trackIndex ? 'true' : undefined}
                >
                  <span className="t-no">{track.side}</span>
                  <span className="t-title" title={track.blurb}>
                    {track.title}
                  </span>
                  <span className="t-time">{track.tempo}</span>
                </button>
              </li>
            ))}
          </ol>

          {TRACKS.some((t) => t.side.startsWith('B')) && (
            <button className="flip" onClick={tt.flipRecord}>
              перевернуть на {state.side === 'A' ? 'вторую' : 'первую'} сторону
            </button>
          )}
        </footer>

        {/* screen-reader announcement of transport state */}
        <div className="sr-only" aria-live="polite">
          {playing ? `Сейчас играет «${current.title}», 33⅓ об/мин` : state.phase === 'playing' ? 'Остановлено' : ''}
        </div>
      </main>

      {/* entry sleeve (fades away, revealing the deck) */}
      <button
        type="button"
        className={`coldboot${booting ? '' : ' lifted'}`}
        onClick={tt.startBoot}
        disabled={!booting}
        aria-hidden={!booting}
        autoFocus
        aria-label={`Слушать «${FICTION.album}», ${FICTION.artist}`}
      >
        <span className="cb-album">{FICTION.album}</span>
        <span className="cb-by">{FICTION.artistFull}</span>
        <span className="cb-play">
          <PlayGlyph /> слушать
        </span>
      </button>
    </>
  )
}
