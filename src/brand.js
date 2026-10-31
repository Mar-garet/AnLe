import {COMPACT_PET_PIXELS, FULL_PET_PIXELS, PET_PALETTE} from './pet-sprites.js';

const colorDepth = process.stdout.getColorDepth?.() ?? 8;
const petPalette = PET_PALETTE.map(color => color && (colorDepth >= 24 ? color[0] : `ansi256(${color[1]})`));

// Three terminal rows form a larger AnLe wordmark. Capitals are six pixels
// tall; the lowercase letters start lower and share the same baseline.
export const ANLE_WORDMARK = [
  ['▄▀▀▄      ', '█     ▄▄ '],
  ['█▄▄█ █▀▀▄ ', '█    █▄▄█'],
  ['█  █ █  █ ', '█▄▄▄ ▀▄▄▄'],
];
export const ANLE_WORDMARK_WIDTH = 19;

// Each pair of pixels becomes one terminal cell. Background colors are used
// only when the upper and lower halves have different colors.
function pixelRows(pixels, indent, palette) {
  const rows = [];
  for (let y = 0; y < pixels.length; y += 2) {
    const runs = [{text: indent}];
    for (let x = 0; x < pixels[y].length; x++) {
      const top = palette[pixels[y][x]];
      const bottom = palette[pixels[y + 1]?.[x]];
      let text = ' ';
      let color;
      let backgroundColor;
      if (top && bottom) {
        text = top === bottom ? '█' : '▀';
        color = top;
        if (top !== bottom) backgroundColor = bottom;
      } else if (top) { text = '▀'; color = top; }
      else if (bottom) { text = '▄'; color = bottom; }
      const previous = runs.at(-1);
      if (previous.color === color && previous.backgroundColor === backgroundColor) previous.text += text;
      else runs.push({text, color, backgroundColor});
    }
    rows.push(runs);
  }
  return rows;
}

export const EMPTY_INBOX_PETS = pixelRows(FULL_PET_PIXELS, '  ', petPalette);
export const COMPACT_INBOX_PETS = pixelRows(COMPACT_PET_PIXELS, ' ', petPalette);
export const EMPTY_INBOX_PETS_WIDTH = FULL_PET_PIXELS[0].length + 2;
export const COMPACT_INBOX_PETS_WIDTH = COMPACT_PET_PIXELS[0].length + 1;

// Preserve the dogs' original silhouettes while reducing their detailed
// portraits to four warm and four neutral shades for the smaller console.
const simplePetPalette = [null, '#604738', '#aa7e43', '#d3b07b', '#f1dfb9', '#403b40', '#807680', '#b1a4a5', '#e2d5ca'];
const simplePetPixels = COMPACT_PET_PIXELS.map(row => row.map((index, x) => {
  if (!index) return 0;
  const hex = PET_PALETTE[index][0];
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
  if (x < 13) return 1 + (luminance < 95 ? 0 : luminance < 160 ? 1 : luminance < 220 ? 2 : 3);
  return 5 + (luminance < 45 ? 0 : luminance < 115 ? 1 : luminance < 180 ? 2 : 3);
}));
export const SIMPLE_INBOX_PETS = pixelRows(simplePetPixels, ' ', simplePetPalette);
export const SIMPLE_INBOX_PETS_WIDTH = simplePetPixels[0].length + 1;

// Small portraits for narrow inboxes, where they fit beside the heading.
const miniAn = ['.eee.', 'tccct', 'tncnt', 'tcmct', '.ene.', '.eee.'];
const miniLe = ['k...k', 'kdddk', 'kngnk', 'kgggk', '.knk.', '.kgk.'];
const miniPixels = miniAn.map((row, index) => `${row}.${miniLe[index]}`);
const miniPetPalette = {e: '#aa7e43', c: '#f1dfb9', t: '#d3b07b', m: '#e6d4b0', k: '#807680', d: '#403b40', g: '#b1a4a5', n: '#211c23'};
export const MINI_INBOX_PETS = pixelRows(miniPixels, '', miniPetPalette);
export const MINI_INBOX_PETS_WIDTH = miniPixels[0].length;

// The compact monochrome portraits are kept as terminal characters so they
// look the same as the command preview on light and dark backgrounds.
export const PIXEL_PETS = ['▄▀▀▀▄ █▄▄▄█', '█▀▀▀█ █▀█▀█', ' █▀█   █▀█ '];
export const PIXEL_PETS_WIDTH = 11;
