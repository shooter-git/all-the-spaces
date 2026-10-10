import { MARK_SHEETS } from '@ats/ui';
import { type CSSProperties, useState } from 'react';
import { DOOR_PHRASES } from '../lib/door-phrases.ts';

/**
 * Where the saying sits, in the art's 640 × 340 frame: right of the washi, and above the bottom
 * third, which is kept for its meaning and source.
 */
const FRAME = { w: 640, h: 340 };
const BOX = { x: 292, y: 18, w: 322, h: 196 };

/**
 * The top of the door into a creation: the washi mark on the left and, on the right, a saying in
 * its own language and hand, with exactly what it means and who said it. A different one each
 * time; none of them says anything about what's inside.
 */
export function DoorArt() {
  const [phrase] = useState(
    () => DOOR_PHRASES[Math.floor(Math.random() * DOOR_PHRASES.length)] ?? null,
  );
  // Custom properties, so a card of another shape (a phone held sideways) can place it its own way.
  let fit: { '--door-left': string; '--door-top': string; '--door-width': string } | null = null;
  if (phrase) {
    const h = phrase.vertical ? BOX.h - 28 : BOX.h - 12;
    const s = Math.min(BOX.w / phrase.width, h / phrase.height, phrase.vertical ? 1.15 : 1.3);
    const w = phrase.width * s;
    // As percentages of the frame, so it scales with the card.
    fit = {
      '--door-left': `${((BOX.x + BOX.w - w) / FRAME.w) * 100}%`,
      '--door-top': `${((BOX.y + (h - phrase.height * s) / 2) / FRAME.h) * 100}%`,
      '--door-width': `${(w / FRAME.w) * 100}%`,
    };
  }

  return (
    <figure className="door-art">
      {/* The picture in its own frame: the saying is placed in it, however tall the card is. */}
      <div className="door-frame">
        <svg
          viewBox={`0 0 ${FRAME.w} ${FRAME.h}`}
          preserveAspectRatio="xMidYMid slice"
          aria-hidden="true"
        >
          <g transform="translate(-6 50) scale(0.5)">
            {MARK_SHEETS.map((s, i) => (
              <path
                key={s.fill}
                className={`door-sheet door-sheet--${i}`}
                d={s.d}
                fill={s.fill}
                fillOpacity={s.opacity * 0.5}
              />
            ))}
          </g>
        </svg>
        {phrase && fit && (
          <img
            className={phrase.vertical ? 'door-saying door-saying--vertical' : 'door-saying'}
            src={`/doors/${phrase.file}`}
            alt={phrase.text}
            lang={phrase.lang}
            style={fit as CSSProperties}
          />
        )}
      </div>
      {phrase && fit && (
        <figcaption>
          {/* An English line speaks for itself. */}
          {phrase.lang !== 'en' && <span className="door-meaning">{phrase.en}</span>}
          <span className="door-source">
            {phrase.source}
            <span className="visually-hidden"> ({phrase.language})</span>
          </span>
        </figcaption>
      )}
    </figure>
  );
}
