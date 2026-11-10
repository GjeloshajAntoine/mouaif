#!/usr/bin/env python3
# Regenerates the Parchment theme textures in frontend/public/themes/:
#   parchment-mottle.png  cloudy tone changes and sparse foxing spots (256 px, shown at 640 px)
#   parchment-grain.png   fine pulp grain (128 px)
# Both tile seamlessly and vary only in alpha over a fixed brown, stored as an
# 8-bit palette so they stay small. Needs Pillow. Output is deterministic.
import os
import random
from PIL import Image, ImageFilter
random.seed(7)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend", "public", "themes") + os.sep

def noise(n):
    im = Image.new('L', (n, n))
    im.putdata([random.randint(0, 255) for _ in range(n * n)])
    return im

def tile_blur(im, r):
    n = im.size[0]
    big = Image.new('L', (n * 3, n * 3))
    for x in range(3):
        for y in range(3):
            big.paste(im, (x * n, y * n))
    big = big.filter(ImageFilter.GaussianBlur(r))
    return big.crop((n, n, 2 * n, 2 * n))

def stretch(im):
    lo, hi = im.getextrema()
    return im.point(lambda v: int((v - lo) * 255 / max(1, hi - lo)))


def save_alpha_palette(img, path, levels, c0, c1):
    alphas = [a for *_, a in img.getdata()]
    top = max(alphas) or 1
    idx = [round(a / top * (levels - 1)) for a in alphas]
    pal, trns = [], []
    for i in range(levels):
        t = i / (levels - 1)
        pal += [round(c0[k] * (1 - t) + c1[k] * t) for k in range(3)]
        trns.append(round(t * top))
    p = Image.new('P', img.size); p.putdata(idx); p.putpalette(pal)
    p.save(path, optimize=True, transparency=bytes(trns))

N = 256
# Cloudy mottling: two octaves of blurred noise.
coarse = stretch(tile_blur(noise(48), 4).resize((N, N), Image.BICUBIC))
mid = stretch(tile_blur(noise(128), 4).resize((N, N), Image.BICUBIC))
mottle = Image.blend(coarse, mid, 0.4)
mottle = stretch(mottle)
# Foxing: small, sparse soft spots.
spots = stretch(tile_blur(noise(N), 2.2))
spots = spots.point(lambda v: 0 if v < 196 else min(255, (v - 196) * 6))
spots = tile_blur(spots, 1.2)

px = []
m, s = mottle.load(), spots.load()
for y in range(N):
    for x in range(N):
        a1 = max(0, (m[x, y] - 90)) / 165 * 0.16   # cloudy tone, up to ~0.20
        a2 = s[x, y] / 255 * 0.30                  # foxing, up to ~0.30
        a = 1 - (1 - a1) * (1 - a2)
        # foxing leans orange, mottling leans umber
        w = a2 / a if a > 0 else 0
        r = int(118 * (1 - w) + 150 * w)
        g = int(80 * (1 - w) + 92 * w)
        b = int(28 * (1 - w) + 30 * w)
        px.append((r, g, b, int(a * 255)))
img = Image.new('RGBA', (N, N)); img.putdata(px)
save_alpha_palette(img, OUT + 'parchment-mottle.png', 48, (118, 80, 28), (150, 92, 30))

# Fine pulp grain.
G = 128
gr = noise(G).filter(ImageFilter.GaussianBlur(0.5))
gr = stretch(gr)
px = []
for v in gr.getdata():
    a = max(0, v - 120) / 135 * 0.11
    px.append((70, 48, 18, int(a * 255)))
img = Image.new('RGBA', (G, G)); img.putdata(px)
save_alpha_palette(img, OUT + 'parchment-grain.png', 16, (70, 48, 18), (70, 48, 18))
