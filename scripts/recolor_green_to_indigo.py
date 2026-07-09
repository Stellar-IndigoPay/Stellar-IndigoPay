from pathlib import Path
import colorsys
from PIL import Image

root = Path(__file__).resolve().parent.parent
png_files = list((root / 'extension' / 'store-assets').glob('*.png'))
svg_files = list((root / 'docs' / 'backend' / 'assets').glob('*.svg'))

print('Found PNG files:', [p.name for p in png_files])
print('Found SVG files:', [p.name for p in svg_files])

INDIGO_HUE = 250 / 360.0

def is_green(r, g, b):
    if r + g + b == 0:
        return False
    h, l, s = colorsys.rgb_to_hls(r / 255.0, g / 255.0, b / 255.0)
    return 60 / 360.0 <= h <= 170 / 360.0 and s >= 0.15 and l >= 0.08

for p in png_files:
    with Image.open(p).convert('RGBA') as im:
        data = list(im.getdata())
        changed = []
        new_data = []
        for (r, g, b, a) in data:
            if a < 16:
                new_data.append((r, g, b, a))
                continue
            if is_green(r, g, b):
                h, l, s = colorsys.rgb_to_hls(r / 255.0, g / 255.0, b / 255.0)
                new_h = INDIGO_HUE
                new_s = max(0.25, min(1.0, s * 0.9))
                new_l = min(0.9, max(0.1, l * 0.95))
                nr, ng, nb = colorsys.hls_to_rgb(new_h, new_l, new_s)
                new_data.append((int(nr * 255), int(ng * 255), int(nb * 255), a))
                changed.append((r, g, b, a))
            else:
                new_data.append((r, g, b, a))
        if changed:
            im.putdata(new_data)
            im.save(p)
            print(f'Updated {p.name}: {len(changed)} green pixels recolored')
        else:
            print(f'No green pixels found in {p.name}')

for svg in svg_files:
    text = svg.read_text(encoding='utf-8')
    original = text
    replacements = {
        '#008000': '#4B0082',
        '#00A000': '#4B0082',
        '#228B22': '#4B0082',
        'green': 'indigo',
        'ForestGreen': 'Indigo',
        'forestgreen': 'indigo',
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    if text != original:
        svg.write_text(text, encoding='utf-8')
        print(f'Updated SVG colors in {svg.name}')
    else:
        print(f'No SVG changes needed for {svg.name}')
