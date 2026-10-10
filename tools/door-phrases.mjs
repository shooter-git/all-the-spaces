// The lines shown on the door into a creation: short, well-documented sayings from many languages,
// each in an authentic hand for its script, with its exact meaning and source. Written out here as
// outlines (shaped by HarfBuzz, so every script joins and stacks correctly), so the app never
// downloads these fonts.
//   node tools/door-phrases.mjs
//
// Only lines whose original wording and meaning are settled belong here. Where a well-known line
// exists in more than one version, the note says which one is used.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as hb from 'harfbuzzjs';

const { decompress } = createRequire(import.meta.url)('wawoff2');

/** Fonts (SIL Open Font License), by the hand each script is written in. */
const HANDS = {
  // Persian: Nastaliq, the flowing hand of Persian poetry.
  nastaliq: { family: 'noto-nastaliq-urdu', weight: 400, style: 'normal', size: 34 },
  // Chinese: kaishu, the regular brush hand (traditional characters).
  kai: { family: 'lxgw-wenkai-tc', weight: 400, style: 'normal', size: 40 },
  // Japanese: a brush hand.
  syuku: { family: 'yuji-syuku', weight: 400, style: 'normal', size: 40 },
  // Korean: a brush hand.
  brushKo: { family: 'nanum-brush-script', weight: 400, style: 'normal', size: 52 },
  // Sanskrit: Devanagari, set for Sanskrit.
  deva: { family: 'tiro-devanagari-sanskrit', weight: 400, style: 'normal', size: 42 },
  // Hebrew, with its vowel points.
  hebrew: { family: 'noto-serif-hebrew', weight: 400, style: 'normal', size: 44 },
  // Ancient Greek.
  greek: { family: 'gfs-didot', weight: 400, style: 'normal', size: 44 },
  // Tamil.
  tamil: { family: 'noto-serif-tamil', weight: 400, style: 'normal', size: 40 },
  // Latin-script and Cyrillic languages: a classical italic.
  serif: { family: 'eb-garamond', weight: 400, style: 'italic', size: 40 },
};

/**
 * lines: one string per line (or, for vertical, per column, read right to left).
 * vertical: written top to bottom (Chinese and Japanese).
 */
const PHRASES = [
  {
    hand: 'nastaliq',
    lines: ['بشنو از نی چون حکایت می‌کند'],
    en: 'Listen to the reed, how it tells a tale',
    source: 'Rumi, Masnavi, I.1 (Persian)',
    note: 'Nicholson’s edition; other manuscripts read “بشنو این نی”, “listen to this reed”.',
  },
  {
    hand: 'nastaliq',
    lines: ['بنی‌آدم اعضای یکدیگرند'],
    en: 'The children of Adam are limbs of one another',
    source: 'Saadi, Golestan, I.10 (Persian)',
    note: 'Yusofi’s critical edition; the well-known variant reads “یک پیکرند”, “of one body”.',
  },
  {
    hand: 'kai',
    vertical: true,
    lines: ['千里之行', '始於足下'],
    en: 'A journey of a thousand li begins beneath one’s feet',
    source: 'Laozi, Tao Te Ching, 64 (Classical Chinese)',
  },
  {
    hand: 'kai',
    vertical: true,
    lines: ['鑿戶牖以為室', '當其無', '有室之用'],
    en: 'Cut doors and windows to make a room: where they are empty, the room is of use',
    source: 'Laozi, Tao Te Ching, 11 (Classical Chinese)',
  },
  {
    hand: 'kai',
    vertical: true,
    lines: ['昔者莊周', '夢為胡蝶'],
    en: 'Once, Zhuang Zhou dreamt he was a butterfly',
    source: 'Zhuangzi, 2 (Classical Chinese)',
  },
  {
    hand: 'kai',
    vertical: true,
    lines: ['有朋自遠方來', '不亦樂乎'],
    en: 'To have friends come from afar: is that not a joy?',
    source: 'Confucius, Analects, I.1 (Classical Chinese)',
  },
  {
    hand: 'syuku',
    vertical: true,
    lines: ['一期一会'],
    en: 'One time, one meeting',
    source: 'Tea-ceremony saying (Japanese)',
  },
  {
    hand: 'syuku',
    vertical: true,
    lines: ['古池や', '蛙飛びこむ', '水の音'],
    en: 'An old pond; a frog jumps in: the sound of water',
    source: 'Matsuo Bashō, 1686 (Japanese)',
  },
  {
    hand: 'brushKo',
    lines: ['시작이 반이다'],
    en: 'Beginning is half the work',
    source: 'Proverb (Korean)',
  },
  {
    hand: 'deva',
    lines: ['वसुधैव कुटुम्बकम्'],
    en: 'The world is one family',
    source: 'Maha Upanishad, VI.71 (Sanskrit)',
  },
  {
    hand: 'deva',
    lines: ['एकं सद्विप्रा बहुधा वदन्ति'],
    en: 'Truth is one; the wise speak of it in many ways',
    source: 'Rigveda, I.164.46 (Sanskrit)',
  },
  {
    hand: 'hebrew',
    lines: ['לֶךְ־לְךָ'],
    en: 'Go forth',
    source: 'Genesis 12:1 (Hebrew)',
  },
  {
    hand: 'greek',
    lines: ['γνῶθι σεαυτόν'],
    en: 'Know yourself',
    source: 'Inscription at Delphi (Ancient Greek)',
  },
  {
    hand: 'greek',
    lines: ['πάντα ῥεῖ'],
    en: 'Everything flows',
    source: 'After Heraclitus (Ancient Greek)',
  },
  {
    hand: 'serif',
    lines: ['Carpe diem'],
    en: 'Pluck the day',
    source: 'Horace, Odes, I.11 (Latin)',
  },
  {
    hand: 'serif',
    lines: ['Festina lente'],
    en: 'Make haste slowly',
    source: 'Proverb (Latin)',
  },
  {
    hand: 'serif',
    lines: ['Per aspera ad astra'],
    en: 'Through hardships to the stars',
    source: 'Proverb (Latin)',
  },
  {
    hand: 'serif',
    lines: ['Nel mezzo del cammin', 'di nostra vita'],
    en: 'In the middle of the journey of our life',
    source: 'Dante, Inferno, I.1 (Italian)',
  },
  {
    hand: 'serif',
    lines: ['l’amor che move il sole', 'e l’altre stelle'],
    en: 'The love that moves the sun and the other stars',
    source: 'Dante, Paradiso, XXXIII.145 (Italian)',
  },
  {
    hand: 'serif',
    lines: ['Caminante, no hay camino,', 'se hace camino al andar'],
    en: 'Traveller, there is no road; the road is made by walking',
    source: 'Antonio Machado, Proverbios y cantares, XXIX (Spanish)',
  },
  {
    hand: 'serif',
    lines: ['La vida es sueño'],
    en: 'Life is a dream',
    source: 'Pedro Calderón de la Barca (Spanish)',
  },
  {
    hand: 'serif',
    lines: ['Que sais-je ?'],
    en: 'What do I know?',
    source: 'Michel de Montaigne, Essais (French)',
  },
  {
    hand: 'serif',
    lines: ['Voll Verdienst, doch dichterisch,', 'wohnet der Mensch auf dieser Erde'],
    en: 'Full of merit, yet poetically, man dwells on this earth',
    source: 'Friedrich Hölderlin, In lieblicher Bläue (German)',
  },
  {
    hand: 'serif',
    lines: ['Navegar é preciso;', 'viver não é preciso'],
    en: 'To sail is necessary; to live is not necessary',
    source: 'Fernando Pessoa, after an ancient saying (Portuguese)',
  },
  {
    hand: 'serif',
    lines: ['Ní neart go cur le chéile'],
    en: 'There is no strength without unity',
    source: 'Proverb (Irish)',
  },
  {
    hand: 'serif',
    lines: ['Haba na haba', 'hujaza kibaba'],
    en: 'Little by little fills the measure',
    source: 'Proverb (Swahili)',
  },
  {
    hand: 'serif',
    lines: ['Мир спасёт красота'],
    en: 'Beauty will save the world',
    source: 'Fyodor Dostoevsky, The Idiot (Russian)',
  },
  {
    hand: 'serif',
    lines: ['Gość w dom, Bóg w dom'],
    en: 'A guest in the house, God in the house',
    source: 'Proverb (Polish)',
  },
  {
    hand: 'serif',
    lines: ['Світ ловив мене,', 'та не спіймав'],
    en: 'The world chased me, but did not catch me',
    source: 'Hryhorii Skovoroda, his epitaph (Ukrainian)',
  },
  {
    hand: 'tamil',
    lines: ['யாதும் ஊரே', 'யாவரும் கேளிர்'],
    en: 'Every town is our town; everyone is our kin',
    source: 'Kaniyan Pungundranar, Purananuru, 192 (Tamil)',
  },
  {
    hand: 'serif',
    lines: ['E komo mai'],
    en: 'Come in; welcome',
    source: 'Greeting (Hawaiian)',
  },
  // In English, the line speaks for itself: only its source is shown.
  {
    hand: 'serif',
    lines: ['We are such stuff', 'As dreams are made on'],
    en: 'We are such stuff as dreams are made on',
    source: 'William Shakespeare, The Tempest, IV.1 (English)',
  },
  {
    hand: 'serif',
    lines: ['To see a World in a Grain of Sand', 'And a Heaven in a Wild Flower'],
    en: 'To see a World in a Grain of Sand, and a Heaven in a Wild Flower',
    source: 'William Blake, Auguries of Innocence (English)',
  },
  {
    hand: 'serif',
    lines: ['I dwell in Possibility –'],
    en: 'I dwell in Possibility',
    source: 'Emily Dickinson (English)',
  },
  {
    hand: 'serif',
    lines: ['I am large, I contain multitudes.'],
    en: 'I am large, I contain multitudes',
    source: 'Walt Whitman, Song of Myself, 51 (English)',
  },
];

// ---- Fonts --------------------------------------------------------------------------------------

/** Every subset file of a font, decompressed and ready for HarfBuzz. */
const loaded = new Map();
async function filesOf(hand) {
  const h = HANDS[hand];
  if (loaded.has(hand)) return loaded.get(hand);
  const dir = `node_modules/@fontsource/${h.family}/files`;
  const names = readdirSync(dir).filter((f) => f.endsWith(`-${h.weight}-${h.style}.woff2`));
  const fonts = [];
  for (const name of names) {
    const ttf = await decompress(readFileSync(`${dir}/${name}`));
    const face = new hb.Face(new hb.Blob(ttf));
    fonts.push({ name, face, font: new hb.Font(face), upem: face.upem });
  }
  loaded.set(hand, fonts);
  return fonts;
}

/** Glyphs in visual order: id, advance and offsets (font units). */
function shape(f, text) {
  const buffer = new hb.Buffer();
  buffer.addText(text);
  buffer.guessSegmentProperties();
  hb.shape(f.font, buffer);
  const infos = buffer.getGlyphInfos();
  const pos = buffer.getGlyphPositions();
  return infos.map((info, i) => ({
    g: info.codepoint,
    ax: pos[i].xAdvance,
    dx: pos[i].xOffset,
    dy: pos[i].yOffset,
  }));
}
const covers = (f, text) => shape(f, text).every((g) => g.g !== 0);

/** The one subset file that has the whole run (complex scripts must be shaped in one piece). */
function fileFor(files, text) {
  const f = files.find((x) => covers(x, text));
  if (f) return f;
  return null;
}

/** HarfBuzz's outline for a glyph (font units, y up), moved and scaled into place (y down). */
function placed(f, g, x, y, scale) {
  const n = (v) => v.toFixed(1);
  return f.font
    .glyphToJson(g)
    .map(({ type, values }) => {
      const pts = [];
      for (let i = 0; i < values.length; i += 2)
        pts.push(`${n(x + values[i] * scale)} ${n(y - values[i + 1] * scale)}`);
      return `${type}${pts.join(' ')}`;
    })
    .join('');
}

/** A line, set horizontally from x=0 on a baseline; returns its outline and width. */
function setLine(files, text, size, baseline) {
  // Shape in one piece when one file has everything; otherwise character by character (fine for
  // the simple scripts that are split across files: Greek, accented Latin).
  const whole = fileFor(files, text);
  const runs = whole
    ? [{ f: whole, text }]
    : [...text].map((ch) => ({ f: fileFor(files, ch), text: ch }));
  let x = 0;
  let d = '';
  for (const run of runs) {
    if (!run.f) throw new Error(`No glyph for “${run.text}”`);
    const scale = size / run.f.upem;
    for (const g of shape(run.f, run.text)) {
      d += placed(run.f, g.g, x + g.dx * scale, baseline - g.dy * scale, scale);
      x += g.ax * scale;
    }
  }
  return { d, width: x };
}

/** Columns of characters, top to bottom, right to left (Chinese and Japanese). */
function setVertical(files, columns, size) {
  const step = size * 1.08;
  const gap = size * 1.3;
  let d = '';
  columns.forEach((col, c) => {
    const cx = (columns.length - 1 - c) * gap + size / 2;
    [...col].forEach((ch, i) => {
      const f = fileFor(files, ch);
      if (!f) throw new Error(`No glyph for “${ch}”`);
      const scale = size / f.upem;
      const [g] = shape(f, ch);
      d += placed(f, g.g, cx - (g.ax * scale) / 2, i * step + size * 0.88, scale);
    });
  });
  return {
    d,
    width: (columns.length - 1) * gap + size,
    height: Math.max(...columns.map((c) => [...c].length)) * step,
  };
}

/** Language tags (BCP 47), for screen readers. */
const LANG = {
  '(Persian)': 'fa',
  '(Classical Chinese)': 'lzh',
  '(Japanese)': 'ja',
  '(Korean)': 'ko',
  '(Sanskrit)': 'sa',
  '(Hebrew)': 'he',
  '(Ancient Greek)': 'grc',
  '(Latin)': 'la',
  '(Italian)': 'it',
  '(Spanish)': 'es',
  '(French)': 'fr',
  '(German)': 'de',
  '(Portuguese)': 'pt',
  '(Irish)': 'ga',
  '(Swahili)': 'sw',
  '(Russian)': 'ru',
  '(Polish)': 'pl',
  '(Ukrainian)': 'uk',
  '(Tamil)': 'ta',
  '(Hawaiian)': 'haw',
  '(English)': 'en',
};

const escapeXml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const OUT = 'apps/web/public/doors';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const out = [];
for (const p of PHRASES) {
  const files = await filesOf(p.hand);
  const size = HANDS[p.hand].size;
  let shaped;
  if (p.vertical) shaped = setVertical(files, p.lines, size);
  else {
    const lead = size * (p.hand === 'nastaliq' ? 1.9 : 1.25);
    const lines = p.lines.map((l, i) =>
      setLine(files, l, size, size * (p.hand === 'nastaliq' ? 1.25 : 0.95) + i * lead),
    );
    const width = Math.max(...lines.map((l) => l.width));
    // Each line set flush right (where the phrase sits on the door).
    const d = lines
      .map((l) =>
        l.d.replace(
          /(-?\d+\.\d) (-?\d+\.\d)/g,
          (_, a, b) => `${(Number(a) + width - l.width).toFixed(1)} ${b}`,
        ),
      )
      .join('');
    shaped = {
      d,
      width,
      height: size * (p.hand === 'nastaliq' ? 1.7 : 1.2) + (p.lines.length - 1) * lead,
    };
  }
  const language = p.source.match(/\(([^)]+)\)$/)?.[1] ?? '';
  const file = `${String(out.length + 1).padStart(2, '0')}.svg`;
  const width = Number(shaped.width.toFixed(1));
  const height = Number(shaped.height.toFixed(1));
  writeFileSync(
    `${OUT}/${file}`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><title>${escapeXml(p.lines.join(' '))}</title><path d="${shaped.d}" fill="#2E2C33"/></svg>\n`,
  );
  out.push({
    file,
    text: (p.vertical ? p.lines : p.lines).join(p.vertical ? '' : ' '),
    lang: LANG[`(${language})`] ?? 'und',
    language,
    en: p.en,
    source: p.source.replace(/\s*\([^)]+\)$/, ''),
    vertical: Boolean(p.vertical),
    width,
    height,
  });
}

writeFileSync(
  'apps/web/src/lib/door-phrases.ts',
  `// Generated by tools/door-phrases.mjs: sayings for the door into a creation. Each is drawn in
// public/doors/ (fonts under the SIL Open Font License; see docs/licensing.md). Don't edit by hand.
export interface DoorPhrase {
  /** Its drawing, in /doors/. */
  file: string;
  /** The saying itself, as written. */
  text: string;
  /** Language tag (BCP 47), and the language's name. */
  lang: string;
  language: string;
  /** What it says, exactly. */
  en: string;
  /** Who wrote it, and where. */
  source: string;
  /** Written top to bottom. */
  vertical: boolean;
  /** The drawing's size (its viewBox). */
  width: number;
  height: number;
}

export const DOOR_PHRASES: DoorPhrase[] = ${JSON.stringify(out, null, 2)};
`,
);
console.log(`${out.length} phrases written to ${OUT}.`);
