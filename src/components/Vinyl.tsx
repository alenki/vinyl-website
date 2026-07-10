import { memo, type RefObject } from 'react'
import { FICTION } from '../fiction'

/**
 * One face of the pressing. The `.rotor` (grooves, scuffs, strobe dots,
 * label, dust) is rotated by the physics loop via `rotorRef`; the sheen
 * stays fixed because the light in the room doesn't spin.
 */

function LabelSVG({ side }: { side: 'A' | 'B' }) {
  const isA = side === 'A'
  const paper = isA ? 'var(--ochre)' : 'var(--blue)'
  const ink = isA ? 'var(--ink)' : 'var(--cream)'
  const accent = isA ? '#8a5f1d' : 'rgba(243,236,221,0.55)'

  return (
    <svg className="label-svg" viewBox="0 0 200 200" aria-hidden="true" style={{ display: 'block', width: '100%', height: '100%' }}>
      <defs>
        <path id={`arc-top-${side}`} d="M 26 100 A 74 74 0 0 1 174 100" fill="none" />
        <path id={`arc-bot-${side}`} d="M 172 100 A 72 72 0 0 0 28 100" fill="none" />
      </defs>

      {/* paper */}
      <circle cx="100" cy="100" r="100" fill={paper} />
      {/* slight ring shading so the label reads as pasted paper */}
      <circle cx="100" cy="100" r="99" fill="none" stroke="rgba(0,0,0,0.28)" strokeWidth="2" />
      <circle cx="100" cy="100" r="96" fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="1" />

      {/* the deep groove — the pressing-ring this record is named for */}
      <circle cx="100" cy="100" r="60" fill="none" stroke="rgba(0,0,0,0.30)" strokeWidth="2.6" />
      <circle cx="100" cy="100" r="58.4" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="0.9" />

      {/* curved masthead */}
      <text
        fontFamily="var(--font-mono)"
        fontSize="10.5"
        fontWeight="700"
        letterSpacing="2.6"
        fill={ink}
      >
        <textPath href={`#arc-top-${side}`} startOffset="50%" textAnchor="middle">
          {FICTION.label}
        </textPath>
      </text>
      <text fontFamily="var(--font-mono)" fontSize="7" letterSpacing="1.8" fill={accent}>
        <textPath href={`#arc-bot-${side}`} startOffset="50%" textAnchor="middle">
          LONG PLAYING · MICROGROOVE · HIGH FIDELITY
        </textPath>
      </text>

      {/* center block */}
      <text
        x="100"
        y="64"
        textAnchor="middle"
        fontFamily="var(--font-display)"
        fontSize="21"
        letterSpacing="1"
        fill={ink}
      >
        {FICTION.album}
      </text>
      <text x="100" y="74" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="6.4" letterSpacing="1.1" fill={ink}>
        {FICTION.artistFull.toUpperCase()}
      </text>

      {isA ? (
        <>
          <text x="100" y="132" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="6.6" letterSpacing="0.8" fill={ink}>
            1. SLOW COAST (MARROW)
          </text>
          <text x="100" y="141" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="6.6" letterSpacing="0.8" fill={ink}>
            2. CROSSTOWN LOCAL (MARROW–LAVEAU)
          </text>
        </>
      ) : (
        <>
          <text x="100" y="132" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="6.6" letterSpacing="0.8" fill={ink}>
            1. VELVET STATIC (MARROW)
          </text>
          <text x="100" y="141" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="6.4" letterSpacing="0.8" fill={accent}>
            A WALTZ · RECORDED AFTER HOURS
          </text>
        </>
      )}

      {/* machine data flanking the spindle */}
      <text x="44" y="103" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="6.6" fontWeight="700" fill={ink}>
        {FICTION.catNo}
      </text>
      <text x="157" y="99" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="6.2" fill={ink}>
        33⅓ RPM
      </text>
      <text x="157" y="107" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="6.2" fontWeight="700" fill={ink}>
        SIDE {isA ? 'ONE' : 'TWO'}
      </text>
      <text x="100" y="156" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="5.6" letterSpacing="1.4" fill={accent}>
        {FICTION.labelCity} · {FICTION.year} · STEREO
      </text>

      {/* spindle */}
      <circle cx="100" cy="100" r="4.6" fill="var(--cream)" />
      <circle cx="100" cy="100" r="4.6" fill="none" stroke="rgba(0,0,0,0.45)" strokeWidth="1" />
      <circle cx="100" cy="100" r="2.1" fill="#0c0906" />
    </svg>
  )
}

interface VinylFaceProps {
  side: 'A' | 'B'
  rotorRef: RefObject<HTMLDivElement | null>
  held: boolean
  dusty: boolean
}

function VinylFaceImpl({ side, rotorRef, held, dusty }: VinylFaceProps) {
  return (
    <div className={`record${held ? ' held' : ''}`}>
      <div className="rotor" ref={rotorRef}>
        <div className="strobe-ring" />
        <div className="label-disc">
          <LabelSVG side={side} />
        </div>
        <div className="dust-layer" style={{ opacity: dusty ? 1 : 0 }} />
      </div>
      {/* fixed light: the room's reflection doesn't spin with the record */}
      <div className="sheen" />
      <div className="glint" />
      <div className="hotspot" />
    </div>
  )
}

export const VinylFace = memo(VinylFaceImpl)
