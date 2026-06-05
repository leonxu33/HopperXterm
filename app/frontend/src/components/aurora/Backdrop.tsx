// Backdrop — the layered radial-gradient + blob + dot-pattern + noise
// background that sits behind the glass chrome. Mirrors the Backdrop
// component in hopperterm-core.jsx:172, preset 'a'.
import { BACKDROP } from '../../theme';

export function Backdrop() {
  const p = BACKDROP;
  const baseGradient = `radial-gradient(140% 100% at 20% 0%, ${p.c1} 0%, ${p.c2} 45%, ${p.c3} 100%)`;
  // SVG turbulence-noise for film-grain overlay; tiny inline asset.
  const noiseUrl =
    'url("data:image/svg+xml;utf8,<svg xmlns=%27http://www.w3.org/2000/svg%27 width=%27160%27 height=%27160%27><filter id=%27n%27><feTurbulence type=%27fractalNoise%27 baseFrequency=%270.9%27 numOctaves=%272%27/></filter><rect width=%27100%25%27 height=%27100%25%27 filter=%27url(%23n)%27/></svg>")';

  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        zIndex: 0,
        background: baseGradient,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: '-12%',
          left: '58%',
          width: 520,
          height: 520,
          background: `radial-gradient(closest-side, ${p.blob1} 0%, transparent 70%)`,
          opacity: 0.28,
          filter: 'blur(40px)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          bottom: '-15%',
          left: '-8%',
          width: 560,
          height: 560,
          background: `radial-gradient(closest-side, ${p.blob2} 0%, transparent 70%)`,
          opacity: 0.22,
          filter: 'blur(50px)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage:
            'radial-gradient(rgba(255,255,255,0.045) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
          opacity: 0.5,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          // Plain alpha composite, NOT mix-blend-mode: 'overlay'. A
          // full-window blend layer forces the compositor to re-blend on
          // every repaint underneath (scroll / typing), which was a measured
          // source of lag in WebView2. Normal blend stays cached.
          opacity: 0.07,
          backgroundImage: noiseUrl,
        }}
      />
    </div>
  );
}
