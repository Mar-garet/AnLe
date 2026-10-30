#!/usr/bin/env python3
"""Convert the transparent dog illustration into terminal-sized pixel grids."""

import json
import struct
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets' / 'an-le-pixel.png'
OUTPUT = ROOT / 'src' / 'pet-sprites.js'


def lab(rgb):
    channels = [value / 255 for value in rgb]
    red, green, blue = [value / 12.92 if value <= .04045 else ((value + .055) / 1.055) ** 2.4 for value in channels]
    x = (.4124564 * red + .3575761 * green + .1804375 * blue) / .95047
    y = .2126729 * red + .7151522 * green + .0721750 * blue
    z = (.0193339 * red + .119192 * green + .9503041 * blue) / 1.08883

    def transform(value):
        return value ** (1 / 3) if value > .008856 else 7.787 * value + 16 / 116

    x, y, z = map(transform, (x, y, z))
    return 116 * y - 16, 500 * (x - y), 200 * (y - z)


GREYS = [((0, 0, 0), 16)] + [((value, value, value), 232 + index) for index, value in enumerate(range(8, 239, 10))] + [((255, 255, 255), 231)]
WARM = GREYS + [((135, 95, 95), 95), ((175, 135, 95), 137), ((215, 175, 135), 180), ((255, 215, 175), 223), ((255, 255, 215), 230)]
WARM_LAB = [(lab(rgb), code) for rgb, code in WARM]


def ansi_color(rgb, grey_only):
    if grey_only or max(rgb) - min(rgb) < 18:
        luminance = round(.2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2])
        return min(GREYS, key=lambda item: abs(item[0][0] - luminance))[1]
    target = lab(rgb)
    return min(WARM_LAB, key=lambda item: sum((item[0][i] - target[i]) ** 2 for i in range(3)))[1]


def read_rgba_png(path):
    data = path.read_bytes()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('Expected a PNG image')
    offset = 8
    compressed = []
    while offset < len(data):
        length = struct.unpack_from('>I', data, offset)[0]
        kind = data[offset + 4:offset + 8]
        chunk = data[offset + 8:offset + 8 + length]
        offset += length + 12
        if kind == b'IHDR':
            width, height, depth, color_type, compression, filtering, interlace = struct.unpack('>IIBBBBB', chunk)
            if (depth, color_type, compression, filtering, interlace) != (8, 6, 0, 0, 0):
                raise ValueError('Expected an 8-bit, non-interlaced RGBA PNG')
        elif kind == b'IDAT':
            compressed.append(chunk)
        elif kind == b'IEND':
            break
    raw = zlib.decompress(b''.join(compressed))
    stride = width * 4
    pixels = bytearray(height * stride)
    previous = bytearray(stride)
    for y in range(height):
        position = y * (stride + 1)
        filter_type = raw[position]
        row = bytearray(raw[position + 1:position + 1 + stride])
        for i in range(stride):
            left = row[i - 4] if i >= 4 else 0
            above = previous[i]
            upper_left = previous[i - 4] if i >= 4 else 0
            if filter_type == 0:
                predictor = 0
            elif filter_type == 1:
                predictor = left
            elif filter_type == 2:
                predictor = above
            elif filter_type == 3:
                predictor = (left + above) // 2
            elif filter_type == 4:
                estimate = left + above - upper_left
                distances = (abs(estimate - left), abs(estimate - above), abs(estimate - upper_left))
                predictor = (left, above, upper_left)[distances.index(min(distances))]
            else:
                raise ValueError(f'Unsupported PNG filter: {filter_type}')
            row[i] = (row[i] + predictor) & 255
        pixels[y * stride:(y + 1) * stride] = row
        previous = row
    return width, height, pixels


def dog_bounds(width, height, pixels, side):
    left = width
    right = 0
    top = height
    bottom = 0
    start = 0 if side == 0 else width // 2
    end = width // 2 if side == 0 else width
    for y in range(height):
        for x in range(start, end):
            if pixels[(y * width + x) * 4 + 3] >= 128:
                left = min(left, x)
                right = max(right, x + 1)
                top = min(top, y)
                bottom = max(bottom, y + 1)
    if right <= left or bottom <= top:
        raise ValueError(f'No dog found in image half {side}')
    return left, top, right, bottom


def sample_dog(width, pixels, bounds, target_height):
    left, top, right, bottom = bounds
    target_width = max(1, round((right - left) * target_height / (bottom - top)))
    result = []
    for y in range(target_height):
        y0 = top + (bottom - top) * y // target_height
        y1 = top + (bottom - top) * (y + 1) // target_height
        row = []
        for x in range(target_width):
            x0 = left + (right - left) * x // target_width
            x1 = left + (right - left) * (x + 1) // target_width
            area = (x1 - x0) * (y1 - y0)
            alpha_sum = red = green = blue = 0
            for source_y in range(y0, y1):
                for source_x in range(x0, x1):
                    index = (source_y * width + source_x) * 4
                    alpha = pixels[index + 3]
                    if alpha < 48:
                        continue
                    alpha_sum += alpha
                    red += pixels[index] * alpha
                    green += pixels[index + 1] * alpha
                    blue += pixels[index + 2] * alpha
            if alpha_sum < area * 255 * .28:
                row.append(None)
            else:
                row.append(tuple(round(channel / alpha_sum) for channel in (red, green, blue)))
        result.append(row)
    return result


def compose_pair(width, pixels, bounds, height, gap):
    dogs = [sample_dog(width, pixels, box, height) for box in bounds]
    unit = max(len(dog[0]) for dog in dogs)
    rows = []
    for y in range(height):
        parts = []
        for dog in dogs:
            left = (unit - len(dog[0])) // 2
            parts.append([None] * left + dog[y] + [None] * (unit - len(dog[0]) - left))
        rows.append(parts[0] + [None] * gap + parts[1])

    # A muted edge keeps Le's dark fur visible on both light and dark themes.
    original = [row[:] for row in rows]
    for y in range(height):
        for x in range(unit + gap, len(rows[0])):
            if original[y][x] is not None:
                continue
            if any(0 <= y + dy < height and 0 <= x + dx < len(rows[0]) and original[y + dy][x + dx] is not None
                   for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                rows[y][x] = (104, 93, 105)
    return rows


def main():
    width, height, pixels = read_rgba_png(SOURCE)
    bounds = [dog_bounds(width, height, pixels, side) for side in (0, 1)]
    full = compose_pair(width, pixels, bounds, 20, 3)
    compact = compose_pair(width, pixels, bounds, 14, 1)
    palette = [None]
    lookup = {None: 0}

    def encode(rows, gap):
        output = []
        unit = (len(rows[0]) - gap) // 2
        for row in rows:
            encoded = []
            for x, rgb in enumerate(row):
                # Subtle quantization keeps the color table small without
                # adding a runtime image-processing dependency.
                quantized = None if rgb is None else tuple(min(255, (c // 8) * 8 + 4) for c in rgb)
                key = None if quantized is None else (quantized, x >= unit + gap)
                if key not in lookup:
                    lookup[key] = len(palette)
                    palette.append(['#%02x%02x%02x' % quantized, ansi_color(quantized, key[1])])
                encoded.append(lookup[key])
            output.append(encoded)
        return output

    full_pixels = encode(full, 3)
    compact_pixels = encode(compact, 1)
    contents = '// Generated from assets/an-le-pixel.png by scripts/build-pet-art.py.\n'
    contents += f'export const PET_PALETTE = {json.dumps(palette, separators=(",", ":"))};\n'
    for name, rows in (('FULL_PET_PIXELS', full_pixels), ('COMPACT_PET_PIXELS', compact_pixels)):
        contents += f'export const {name} = [\n'
        contents += ''.join(f'  {json.dumps(row, separators=(",", ":"))},\n' for row in rows)
        contents += '];\n'
    OUTPUT.write_text(contents)


if __name__ == '__main__':
    main()
