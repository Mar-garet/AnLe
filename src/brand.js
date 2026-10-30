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

// An has cream fur; Le has dark fur and a silver muzzle.
const PALETTE = {
  k: '#4c434d', d: '#706775', g: '#b9adb0', n: '#211c23',
  e: '#ac917e', c: '#eee7d8', t: '#cbbba8', m: '#fbf7eb',
};

// Each pair of pixels becomes one terminal cell. Background colors are used
// only when the upper and lower halves have different colors.
function pixelRows(pixels, indent = '  ', palette = PALETTE) {
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

// Small portraits for narrow inboxes, where they fit beside the heading.
const miniAn = ['.eee.', 'tccct', 'tncnt', 'tcmct', '.ene.', '.eee.'];
const miniLe = ['k...k', 'kdddk', 'kngnk', 'kgggk', '.knk.', '.kgk.'];
const miniPixels = miniAn.map((row, index) => `${row}.${miniLe[index]}`);
export const MINI_INBOX_PETS = pixelRows(miniPixels, '');
export const MINI_INBOX_PETS_WIDTH = miniPixels[0].length;
