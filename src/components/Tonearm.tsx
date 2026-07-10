import { memo, type RefObject } from 'react'

/**
 * The tonearm. Pivots from a base just off the top-right of the record; its
 * angle is driven imperatively (`armRotorRef`) so it can creep inward with
 * playback without re-rendering React.
 *
 * Geometry lives in the same size-square space as the record. The pivot sits
 * at `pivot`, the arm reaches length `L`, and the stylus tip is anchored at
 * exactly local (L, 0) from the pivot — so the arc the angle in useTurntable
 * computes lands the tip in the groove at every viewport size.
 */

interface TonearmProps {
  armRotorRef: RefObject<HTMLDivElement | null>
  lifted: boolean
  size: number // px, the deck square
}

function TonearmImpl({ armRotorRef, lifted, size }: TonearmProps) {
  const pivot = { x: size * 0.9, y: size * 0.08 }
  const L = size * 0.58
  const baseR = size * 0.055
  const tube = Math.max(3, size * 0.0125)

  const back = size * 0.12 // counterweight tail behind the pivot
  const svgW = L + back + size * 0.05
  const svgH = size * 0.14
  const originX = back // pivot x within the svg
  const cy = svgH / 2

  return (
    <div
      className={`arm-assembly${lifted ? ' lifted' : ''}`}
      style={{ left: 0, top: 0, width: size, height: size }}
    >
      {/* pivot base */}
      <div
        className="arm-base"
        style={{ left: pivot.x - baseR, top: pivot.y - baseR, width: baseR * 2, height: baseR * 2 }}
      />
      <div
        className="arm-rotor"
        ref={armRotorRef}
        style={{ left: pivot.x, top: pivot.y, width: 0, height: 0, transformOrigin: '0 0' }}
      >
        <svg
          className="arm-svg"
          width={svgW}
          height={svgH}
          viewBox={`0 0 ${svgW} ${svgH}`}
          style={{ position: 'absolute', left: -originX, top: -cy }}
        >
          <g className="arm-shadow" transform="translate(2,6)">
            <ArmShape originX={originX} L={L} back={back} cy={cy} tube={tube} shadow />
          </g>
          <g className="arm-body">
            <ArmShape originX={originX} L={L} back={back} cy={cy} tube={tube} />
          </g>
        </svg>
      </div>
    </div>
  )
}

export const Tonearm = memo(TonearmImpl)

function ArmShape({
  originX,
  L,
  back,
  cy,
  tube,
  shadow,
}: {
  originX: number
  L: number
  back: number
  cy: number
  tube: number
  shadow?: boolean
}) {
  const dark = shadow ? '#1b1713' : '#2a251e'
  const chrome = shadow ? '#1b1713' : '#aca595'
  const px = originX // pivot x
  const sx = originX + L // stylus x — local (L, 0)
  const bendX = originX + L * 0.82

  return (
    <>
      {/* counterweight tail behind the pivot */}
      <rect x={px - back} y={cy - tube * 0.6} width={back * 0.86} height={tube * 1.2} rx={tube * 0.6} fill={dark} />
      <circle cx={px - back} cy={cy} r={tube * 1.55} fill={shadow ? '#1b1713' : '#1d1811'} />

      {/* main tube */}
      <rect x={px} y={cy - tube * 0.5} width={L * 0.82} height={tube} rx={tube * 0.5} fill={dark} />
      {!shadow && (
        <rect x={px + tube} y={cy - tube * 0.5} width={L * 0.78} height={tube * 0.3} rx={tube * 0.15} fill="rgba(255,255,255,0.16)" />
      )}

      {/* slight headshell bend */}
      <rect
        x={bendX}
        y={cy - tube * 0.44}
        width={L * 0.2}
        height={tube * 0.88}
        rx={tube * 0.44}
        transform={`rotate(9 ${bendX} ${cy})`}
        fill={dark}
      />
      {/* headshell block, wrapping the tip */}
      <rect
        x={sx - tube * 1.9}
        y={cy - tube * 1.0}
        width={tube * 2.4}
        height={tube * 2.0}
        rx={tube * 0.5}
        transform={`rotate(9 ${sx} ${cy})`}
        fill={shadow ? '#1b1713' : '#332d25'}
      />

      {/* pivot hub */}
      <circle cx={px} cy={cy} r={tube * 1.5} fill={chrome} />
      <circle cx={px} cy={cy} r={tube * 0.55} fill={dark} />

      {/* stylus tip — anchored at local (L, 0) so it meets the groove */}
      {!shadow && <circle cx={sx} cy={cy} r={Math.max(1.6, tube * 0.5)} fill="var(--accent)" />}
    </>
  )
}
