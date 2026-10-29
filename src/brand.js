// A six-pixel-wide S, drawn with half blocks for a compact terminal mark.
export const SEREIN_MARK = ['▄█▀▀█▄', '▀█▄▄▄ ', '▄▄  ██', ' ▀▀▀▀ '];

const DOG_PALETTE = {P: '#c1561e', E: '#8c4932', K: '#282128', M: '#f2c58f'};

// Each pair of pixels becomes one terminal cell. Background colors are used
// only when the upper and lower halves have different colors.
function pixelRows(pixels) {
  const rows = [];
  for (let y = 0; y < pixels.length; y += 2) {
    const runs = [{text: '    '}];
    for (let x = 0; x < pixels[y].length; x++) {
      const top = DOG_PALETTE[pixels[y][x]];
      const bottom = DOG_PALETTE[pixels[y + 1]?.[x]];
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

export const EMPTY_INBOX_PET = pixelRows([
  '...PPPPPPPPP....',
  '..PPPPPPPPPPP...',
  '.EEPPPPPPPPPEE..',
  '.EEPPKPPPKPPEE..',
  '.EEPPKPPPKPPEE..',
  '.EEPPMMMMMPPEE..',
  '.EEPPMMKMPPPEE..',
  '..EPPMMMMMPPE...',
  '...PPPPPPPPP....',
  '....PPPPPPP..PP.',
  '....PPPPPPPPPPP.',
  '....PP....PP....',
]);

export const COMPACT_INBOX_PET = pixelRows([
  '...PPPPPPPPP....',
  '.EEPPKPPPKPPEE..',
  '.EEPPMMMMMPPEE..',
  '..EPPMMKMPPPE...',
  '...PPPPPPPPP.PP.',
  '....PP...PPPPPP.',
]);
