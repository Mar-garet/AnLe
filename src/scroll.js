export function scrollbarGeometry(total, visible, position, trackLength) {
  const track = Math.max(1, Math.floor(trackLength));
  const viewport = Math.max(1, Math.floor(visible));
  const count = Math.max(0, Math.floor(total));
  const max = Math.max(0, count - viewport);
  const current = Math.max(0, Math.min(max, Math.floor(position)));
  const thumbLength = max ? Math.max(1, Math.min(track, Math.ceil(track * viewport / count))) : track;
  const travel = track - thumbLength;
  const thumbStart = max && travel ? Math.round(current * travel / max) : 0;
  return {trackLength: track, thumbLength, thumbStart, maxPosition: max};
}

export function positionForScrollbarRow(geometry, row, grabOffset = 0) {
  const travel = geometry.trackLength - geometry.thumbLength;
  if (!travel || !geometry.maxPosition) return 0;
  const thumbStart = Math.max(0, Math.min(travel, row - grabOffset));
  return Math.round(thumbStart * geometry.maxPosition / travel);
}

// Parse SGR mouse reports while ignoring normal keys and bracketed paste.
export class MouseSequenceParser {
  constructor() { this.pending = ''; this.inPaste = false; }

  push(chunk) {
    const startPaste = '\x1b[200~';
    const endPaste = '\x1b[201~';
    const text = this.pending + String(chunk);
    const events = [];
    this.pending = '';
    let index = 0;
    while (index < text.length) {
      if (this.inPaste) {
        const end = text.indexOf(endPaste, index);
        if (end < 0) {
          this.pending = suffixPrefix(text.slice(index), endPaste);
          break;
        }
        this.inPaste = false;
        index = end + endPaste.length;
        continue;
      }
      const escape = text.indexOf('\x1b', index);
      if (escape < 0) break;
      const rest = text.slice(escape);
      if (startPaste.startsWith(rest) || '\x1b[<'.startsWith(rest)) { this.pending = rest; break; }
      if (rest.startsWith(startPaste)) { this.inPaste = true; index = escape + startPaste.length; continue; }
      const match = rest.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
      if (match) {
        events.push({button: Number(match[1]), x: Number(match[2]), y: Number(match[3]), release: match[4] === 'm'});
        index = escape + match[0].length;
      } else if (/^\x1b\[<\d*(?:;\d*){0,2}$/.test(rest)) {
        this.pending = rest;
        break;
      } else index = escape + 1;
    }
    return events;
  }
}

function suffixPrefix(value, marker) {
  for (let size = Math.min(marker.length - 1, value.length); size > 0; size--) {
    if (marker.startsWith(value.slice(-size))) return value.slice(-size);
  }
  return '';
}
