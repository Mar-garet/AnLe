import stringWidth from 'string-width';
import {safeTerminalText} from './history.js';

const graphemes = new Intl.Segmenter(undefined, {granularity: 'grapheme'});

// The compact header contains four brand rows inside the top border.
export const COMPACT_CONTENT_TOP = 6;
export const COMPACT_PICKER_TOP = COMPACT_CONTENT_TOP + 2;
export function compactContentRows(height) {
  return Math.max(1, Math.max(10, height) - 11);
}

export function directoryLines(cwd, width) {
  const path = cwd ? safeTerminalText(cwd).replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t') : 'Directory unavailable';
  const limit = Math.max(1, width);
  const lines = [];
  let line = '';
  let used = 0;
  for (const {segment} of graphemes.segment(path)) {
    const size = stringWidth(segment);
    if (line && used + size > limit) { lines.push(line); line = ''; used = 0; }
    line += segment;
    used += size;
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

// Lay out the list in terminal rows, not node count: directories may wrap.
export function sidebarNodeWindow({nodes, selection, innerWidth, rowCapacity, indent = 2, scrollShift = 0}) {
  const rows = [];
  for (const [index, node] of nodes.entries()) {
    if (node.thread_id !== 'human') {
      directoryLines(node.cwd, innerWidth - indent).forEach((text, part) => rows.push({index, node, type: 'path', text, part}));
    }
    rows.push({index, node, type: 'name', part: 0});
  }
  const count = Math.max(1, Math.floor(rowCapacity));
  const first = rows.findIndex(row => row.index === selection);
  let end = first < 0 ? 0 : first + 1;
  while (end < rows.length && rows[end].index === selection) end++;
  // Keep the selected directory and its session name visible where possible.
  const maxStart = Math.max(0, rows.length - count);
  let start = Math.min(maxStart, Math.max(0, Math.min(first < 0 ? 0 : first, end - count)));
  // Do not leave part of an unrelated entry at the top of the list.
  while (start > 0 && start < first && rows[start - 1]?.index === rows[start]?.index) start++;
  const scrollLimit = Math.max(maxStart, start);
  start = Math.max(0, Math.min(scrollLimit, start + Math.trunc(scrollShift)));
  return {rows: rows.slice(start, start + count), start, total: rows.length, scrollLimit};
}

export function compactNodeAt({x, y, width, height, selection, nodes, scrollShift = 0}) {
  if (x < 2 || x >= width || y < COMPACT_CONTENT_TOP) return null;
  const rowCapacity = compactContentRows(height);
  const {rows} = sidebarNodeWindow({nodes, selection, innerWidth: Math.max(8, width - 4), rowCapacity, scrollShift});
  return rows[y - COMPACT_CONTENT_TOP]?.index ?? null;
}
