import {PIXEL_PETS, PIXEL_PETS_WIDTH} from './brand.js';

export const PET_SCENE_WIDTH = 21;
export const PET_COMPACT_WIDTH = PIXEL_PETS_WIDTH;
export const PET_SCENE_HEIGHT = PIXEL_PETS.length;
export const PET_FRAME_MS = 250;
export const PET_FRAME_COUNT = 32;

const an = PIXEL_PETS.map(row => row.slice(0, 5));
const le = PIXEL_PETS.map(row => row.slice(6, 11));

// Keep the scene's width and height fixed while the dogs approach, play-fight,
// and go back to opposite sides. A narrow scene clips their outer edges only.
export function petFrame(frameIndex, sceneWidth = PET_SCENE_WIDTH) {
  const width = Math.max(PET_COMPACT_WIDTH, Math.floor(sceneWidth));
  const tick = ((Math.floor(frameIndex) % PET_FRAME_COUNT) + PET_FRAME_COUNT) % PET_FRAME_COUNT;
  const center = Math.floor((width - PIXEL_PETS_WIDTH) / 2);
  const spread = width === PET_COMPACT_WIDTH ? 1 : Math.min(5, center);
  let phase = 'apart';
  let distance = spread;
  if (tick >= 4 && tick <= 7) {
    phase = 'approaching';
    distance = Math.round(spread * (8 - tick) / 5);
  } else if (tick >= 8 && tick <= 17) {
    phase = 'fighting';
    distance = tick % 3 === 0 ? 1 : 0;
  } else if (tick >= 18 && tick <= 22) {
    phase = 'leaving';
    distance = Math.round(spread * (tick - 17) / 5);
  }
  const anX = center - distance;
  const leX = center + 6 + distance;
  const cells = Array.from({length: 3}, () => Array.from({length: width}, () => ({text: ' ', color: null})));
  const moving = phase !== 'apart' && tick % 2 === 0;
  function draw(sprite, x, color, step) {
    sprite.forEach((row, y) => {
      const pixels = y === 2 && moving ? step : row;
      for (let i = 0; i < pixels.length; i++) {
        const at = x + i;
        if (at >= 0 && at < width && pixels[i] !== ' ') cells[y][at] = {text: pixels[i], color};
      }
    });
  }
  draw(an, anX, 'an', ' ▄█▀ ');
  draw(le, leX, 'le', ' ▀█▄ ');
  if (phase === 'fighting') cells[tick % 3][center + 5] = {text: tick % 2 ? '*' : '+', color: 'hit'};
  const rows = cells.map(row => {
    const runs = [];
    for (const pixel of row) {
      const previous = runs.at(-1);
      if (previous?.color === pixel.color) previous.text += pixel.text;
      else runs.push({...pixel});
    }
    return runs;
  });
  return {phase, anX, leX, rows};
}
