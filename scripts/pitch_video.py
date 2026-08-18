#!/usr/bin/env python3
"""
Render the 3-minute Stellar-IndigoPay pitch video (motion graphics + neural VO
+ app screenshots). No burned-in captions.

Pipeline:
  1. Read scene durations from .pitch-work/audio/manifest.json (produced by pitch_tts.py).
  2. Rasterize the brand icon and wordmark from assets/logo.svg.
  3. Render a 1920x1080 motion-graphics frame sequence (24 fps), weaving in
     real app screenshots from screenshots/ during the product + engineering scenes.
  4. Assemble a master WAV (scene clips + 0.35s inter-scene pauses).
  5. Encode assets/pitch.mp4 (H.264 + AAC) with the static ffmpeg from imageio-ffmpeg.

Run:  .pitch-venv/bin/python scripts/pitch_video.py
"""

import json
import os
import subprocess
import wave

import cairosvg
import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────
W, H = 1920, 1080
FPS = 24
GAP = 0.35  # seconds of silence + hold-frame between scenes

WORK = ".pitch-work"
AUDIO_DIR = os.path.join(WORK, "audio")
FRAME_DIR = os.path.join(WORK, "frames")
OUT = "assets/pitch.mp4"

FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

BG_TOP = (13, 13, 30)
BG_BOT = (26, 21, 54)
PRIMARY = (99, 102, 241)
ACCENT = (129, 140, 248)
DEEP = (79, 70, 229)
GREEN = (16, 185, 129)
GREEN_LT = (52, 211, 153)
WHITE = (255, 255, 255)
MUTED = (158, 166, 190)
DIM = (96, 104, 128)
CARD = (30, 28, 52)

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

_font_cache = {}


def F(size, bold=True):
    key = (size, bold)
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(FONT_BOLD if bold else FONT_REG, size)
    return _font_cache[key]


def lerp(a, b, t):
    return a + (b - a) * t


def clamp01(x):
    return 0.0 if x < 0 else (1.0 if x > 1 else x)


def ease_out(t):
    t = clamp01(t)
    return 1 - (1 - t) ** 3


def ease_in_out(t):
    t = clamp01(t)
    return t * t * (3 - 2 * t)


def seg(t, a, b):
    """0..1 progress of t across the sub-interval [a, b]."""
    return clamp01((t - a) / (b - a))


def blend(c1, c2, a):
    return tuple(int(lerp(c1[i], c2[i], clamp01(a))) for i in range(3))


# ─────────────────────────────────────────────────────────────────────────────
# Background
# ─────────────────────────────────────────────────────────────────────────────
_yy = np.linspace(0.0, 1.0, H)[:, None, None]
_BASE = (np.array(BG_TOP)[None, None, :] * (1 - _yy)
         + np.array(BG_BOT)[None, None, :] * _yy)
_BASE = np.repeat(_BASE, W, axis=1)


def background(glow_cy=400.0, glow_strength=0.5):
    """Return a uint8 HxWx3 RGB background with an indigo radial glow."""
    img = _BASE.copy()
    Y, X = np.mgrid[0:H, 0:W]
    d = np.sqrt((X - 960.0) ** 2 + (Y - glow_cy) ** 2)
    m = np.clip(1 - d / 900.0, 0, 1) ** 2 * glow_strength
    img += m[..., None] * np.array([40, 38, 90], dtype=float)
    return np.clip(img, 0, 255).astype(np.uint8)


_canvas_cache = {}


def new_canvas(glow_cy=400.0, glow_strength=0.5):
    key = (glow_cy, glow_strength)
    if key not in _canvas_cache:
        _canvas_cache[key] = Image.fromarray(background(glow_cy, glow_strength))
    return _canvas_cache[key].copy()


def draw_text(d, xy, text, size, fill, bold=True, anchor="mm", max_w=None):
    """Centered text with optional wrapping to max_w pixels."""
    f = F(size, bold)
    if max_w:
        words, lines, cur = text.split(), [], ""
        for w_ in words:
            t = (cur + " " + w_).strip()
            if d.textbbox((0, 0), t, font=f)[2] <= max_w or not cur:
                cur = t
            else:
                lines.append(cur)
                cur = w_
        if cur:
            lines.append(cur)
        lines = lines or [text]
        x, y = xy
        lh = int(size * 1.25)
        total = lh * len(lines)
        y0 = y - total // 2
        for i, ln in enumerate(lines):
            d.text((x, y0 + i * lh + lh // 2), ln, font=f, fill=fill, anchor="mm")
    else:
        d.text(xy, text, font=f, fill=fill, anchor=anchor)


# ─────────────────────────────────────────────────────────────────────────────
# Assets (icon + wordmark + screenshots)
# ─────────────────────────────────────────────────────────────────────────────
ICON_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="-110 -110 220 220" fill="none">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#6366F1"/><stop offset="50%" stop-color="#818CF8"/><stop offset="100%" stop-color="#4F46E5"/>
    </linearGradient>
    <linearGradient id="lg" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0%" stop-color="#10B981"/><stop offset="100%" stop-color="#34D399"/>
    </linearGradient>
  </defs>
  <circle cx="0" cy="0" r="90" stroke="url(#bg)" stroke-width="3" fill="none" opacity="0.25"/>
  <circle cx="0" cy="0" r="82" stroke="url(#bg)" stroke-width="1.5" fill="none" opacity="0.15"/>
  <polygon points="0,-58 17,-18 58,-18 26,7 38,48 0,26 -38,48 -26,7 -58,-18 -17,-18" fill="url(#bg)" opacity="0.9"/>
  <g transform="translate(0,-4)">
    <path d="M0,36 C-22,18 -28,-8 -4,-28 L0,-20 L4,-28 C28,-8 22,18 0,36Z" fill="url(#lg)" opacity="0.85"/>
  </g>
  <circle cx="75" cy="-30" r="4" fill="#818CF8" opacity="0.7"/>
  <circle cx="-68" cy="40" r="3" fill="#6366F1" opacity="0.5"/>
</svg>"""


def build_assets():
    os.makedirs(WORK, exist_ok=True)
    icon_path = os.path.join(WORK, "icon.png")
    logo_path = os.path.join(WORK, "logo.png")
    if not os.path.exists(icon_path):
        cairosvg.svg2png(bytestring=ICON_SVG.encode(), write_to=icon_path, output_width=640)
    if not os.path.exists(logo_path):
        cairosvg.svg2png(url="assets/logo.svg", write_to=logo_path, output_width=1400)
    return Image.open(icon_path).convert("RGBA"), Image.open(logo_path).convert("RGBA")


def paste_scaled(img, asset, cx, cy, size, alpha=255):
    """Paste `asset` centered at (cx, cy) scaled so its width == size."""
    w = int(size)
    h = int(asset.height * size / asset.width)
    a = asset.resize((w, h), Image.LANCZOS)
    if alpha < 255:
        a = a.copy()
        a.putalpha(int(alpha))
    img.paste(a, (cx - w // 2, cy - h // 2), a)


_shot_cache = {}


def load_shot(name):
    if name not in _shot_cache:
        p = os.path.join("screenshots", name)
        _shot_cache[name] = Image.open(p).convert("RGB") if os.path.exists(p) else None
    return _shot_cache[name]


def paste_shot(img, name, box, inner_margin=16, alpha=1.0):
    """Fit a screenshot within `box` (centered) with a dark matte + border."""
    shot = load_shot(name)
    x0, y0, x1, y1 = box
    d = ImageDraw.Draw(img)
    d.rectangle([x0, y0, x1, y1], fill=(10, 10, 24), outline=DIM, width=2)
    if shot is None:
        return
    fit = shot.copy()
    fit.thumbnail((x1 - x0 - 2 * inner_margin, y1 - y0 - 2 * inner_margin), Image.LANCZOS)
    sx = x0 + ((x1 - x0) - fit.width) // 2
    sy = y0 + ((y1 - y0) - fit.height) // 2
    if alpha < 1.0:
        rgba = fit.convert("RGBA")
        rgba.putalpha(int(255 * alpha))
        img.paste(rgba, (sx, sy), rgba)
    else:
        img.paste(fit, (sx, sy))


# ─────────────────────────────────────────────────────────────────────────────
# Scenes
# ─────────────────────────────────────────────────────────────────────────────
def scene1(t, icon):
    img = new_canvas(glow_cy=380, glow_strength=0.7)
    d = ImageDraw.Draw(img)

    for i in range(3):
        ph = (t * 0.9 + i / 3) % 1.0
        r = 60 + ph * 480
        fade = 1 - ph
        col = blend(ACCENT, BG_TOP, 1 - fade * 0.8)
        d.ellipse([960 - r, 360 - r, 960 + r, 360 + r], outline=col, width=3)

    s = 220 + 80 * ease_out(seg(t, 0, 0.35))
    paste_scaled(img, icon, 960, 360, s)

    headline = "What if giving could be verified?"
    reveal = ease_out(seg(t, 0.35, 0.9))
    shown = headline[: int(len(headline) * reveal)]
    draw_text(d, (960, 620), shown, 58, WHITE, bold=True)

    a = int(255 * ease_out(seg(t, 0.78, 1.0)))
    draw_text(d, (960, 900), "Fund the planet. One XLM at a time.", 34,
              blend(MUTED, WHITE, a / 255), bold=False)
    return img


def scene2(t):
    img = new_canvas(glow_cy=520, glow_strength=0.35)
    d = ImageDraw.Draw(img)

    xs = [240, 660, 1080, 1500, 1680]
    labels = ["Donor", "Middleman", "Middleman", "Middleman", "Project"]
    y = 480
    bw, bh = 200, 96

    p = ease_in_out(seg(t, 0.05, 0.75))
    px = lerp(xs[0] + 60, xs[-1] + 60, p)
    packet_col = blend(GREEN, DIM, p * 0.85)
    d.ellipse([px - 14, y - 14, px + 14, y + 14], fill=packet_col)

    for i in range(len(xs) - 1):
        d.line([xs[i] + bw, y, xs[i + 1], y], fill=DIM, width=3)

    for i, (x, lab) in enumerate(zip(xs, labels)):
        outline = DIM
        if i == 0:
            outline = GREEN
        if i == len(xs) - 1:
            outline = ACCENT
        d.rounded_rectangle([x, y - bh // 2, x + bw, y + bh // 2],
                            radius=14, fill=CARD, outline=outline, width=2)
        draw_text(d, (x + bw // 2, y), lab, 26, WHITE, bold=(i in (0, len(xs) - 1)))

    if t > 0.6:
        a = ease_out(seg(t, 0.6, 0.8))
        d.rounded_rectangle([xs[-1] - 6, y - bh // 2 - 6, xs[-1] + bw + 6, y + bh // 2 + 6],
                            radius=16, fill=blend(CARD, (0, 0, 0), a), outline=DIM, width=2)
        draw_text(d, (xs[-1] + bw // 2, y), "?", 40, WHITE, bold=True)

    fee_pct = int(round(ease_out(seg(t, 0.1, 0.75)) * 19))
    draw_text(d, (960, 250), f"Fees eaten: {fee_pct}%", 46, blend(WHITE, (255, 120, 120), fee_pct / 19))

    a = int(255 * ease_out(seg(t, 0.7, 1.0)))
    draw_text(d, (960, 780), "Trust is assumed. Never verified.",
              40, blend(MUTED, WHITE, a / 255), bold=True)
    return img


def scene3(t, logo):
    img = new_canvas(glow_cy=330, glow_strength=0.6)
    d = ImageDraw.Draw(img)

    a = ease_out(seg(t, 0, 0.3))
    cw, ch = 1080, 330
    cx0, cy0 = 960 - cw // 2, 150 - ch // 2
    d.rounded_rectangle([cx0, cy0, cx0 + cw, cy0 + ch], radius=28, fill=blend(BG_TOP, (255, 255, 255), a))
    if a > 0.05:
        paste_scaled(img, logo, 960, 310, int(880 * a), alpha=int(255 * a))

    if t > 0.3:
        p = ease_out(seg(t, 0.3, 0.6))
        y = 560
        x1, x2 = 300, 1620
        ex = lerp(x1, x2, p)
        d.line([x1, y, ex, y], fill=GREEN, width=6)
        if p > 0.95:
            d.polygon([(x2, y), (x2 - 28, y - 16), (x2 - 28, y + 16)], fill=GREEN)
        for x, lab in ((x1 - 90, "Donor wallet"), (x2 + 60, "Project wallet")):
            d.rounded_rectangle([x - 90, y - 40, x + 90, y + 40], radius=12,
                                fill=CARD, outline=ACCENT, width=2)
            draw_text(d, (x, y), lab, 24, WHITE)
        if p > 0.2:
            draw_text(d, (960, y - 90), "No custodian. No middleman.", 30, GREEN_LT, bold=True)

    if t > 0.6:
        s = seg(t, 0.6, 0.82)
        scale = 2.2 - 1.2 * ease_out(s)
        draw_text(d, (960, 720), "RECORDED ON-CHAIN", int(54 * scale), GREEN, bold=True)
        bw = 560 * scale
        d.rounded_rectangle([960 - bw / 2, 720 - 44 * scale, 960 + bw / 2, 720 + 44 * scale],
                            radius=12, outline=GREEN, width=4)

    a = int(255 * ease_out(seg(t, 0.75, 1.0)))
    draw_text(d, (960, 900), "Direct. Custody-free. Verifiable.", 36,
              blend(MUTED, WHITE, a / 255), bold=True)
    return img


SCENE4_SHOTS = [
    ("01-wallet-options.png", "Multi-wallet", "Freighter · Albedo · xBull · Rabet"),
    ("02-wallet-connected.png", "Wallet connected", "Your Stellar key is your identity"),
    ("03-balance-displayed.png", "Balance", "Real-time XLM balance"),
    ("04-transaction-success.png", "Donate", "Direct to project — zero custody"),
    ("05-transaction-result.png", "On-chain proof", "Verified on Stellar Expert"),
    ("06-mobile-responsive.png", "Mobile", "Give from any device"),
]


def scene4(t):
    img = new_canvas(glow_cy=460, glow_strength=0.5)
    d = ImageDraw.Draw(img)

    draw_text(d, (960, 90), "Give from anywhere", 54, WHITE, bold=True)
    draw_text(d, (960, 152), "Web · Mobile · Extension — give in XLM or USDC", 30, MUTED)

    n = len(SCENE4_SHOTS)
    f = t * n
    idx = min(n - 1, int(f))
    local = f - idx
    name, title, sub = SCENE4_SHOTS[idx]
    a = ease_out(seg(local, 0.0, 0.18))

    bx0, by0, bx1, by1 = 240, 200, 1680, 940
    d.rounded_rectangle([bx0, by0, bx1, by1], radius=16, fill=(10, 10, 24), outline=DIM, width=2)
    paste_shot(img, name, (bx0 + 12, by0 + 12, bx1 - 12, by1 - 88), inner_margin=12, alpha=a)

    cy0 = by1 - 88
    d.rectangle([bx0, cy0, bx1, by1], fill=(8, 8, 20))
    d.line([bx0, cy0, bx1, cy0], fill=PRIMARY, width=2)
    draw_text(d, (960, cy0 + 30), title, 30, WHITE, bold=True)
    draw_text(d, (960, cy0 + 62), sub, 22, MUTED, bold=False)
    return img


SCENE5_CARDS = [
    ("IndigoPay", "donation ledger", "136"),
    ("Escrow", "milestone payouts", "62"),
    ("Attestation", "cross-chain bridge", "60"),
    ("Oracle", "XLM/USDC price feed", "50"),
]


def scene5(t):
    img = new_canvas(glow_cy=560, glow_strength=0.5)
    d = ImageDraw.Draw(img)

    draw_text(d, (960, 90), "Four Soroban contracts", 54, WHITE, bold=True)

    cw, ch, gap = 380, 170, 20
    x0 = (W - 4 * cw - 3 * gap) // 2
    y0 = 200
    for i, (name, sub, codes) in enumerate(SCENE5_CARDS):
        x = x0 + i * (cw + gap)
        a = ease_out(seg(t, 0.03 * i, 0.25 + 0.03 * i))
        if a <= 0:
            continue
        d.rounded_rectangle([x, y0, x + cw, y0 + ch], radius=16, fill=blend(BG_TOP, CARD, a),
                            outline=ACCENT, width=2)
        draw_text(d, (x + cw // 2, y0 + 40), name, 34, WHITE, bold=True)
        draw_text(d, (x + cw // 2, y0 + 78), sub, 20, MUTED, bold=False)
        n = int(round(int(codes) * ease_out(seg(t, 0.18 + 0.04 * i, 0.7 + 0.04 * i))))
        draw_text(d, (x + cw // 2, y0 + 122), f"{n} error codes", 24, GREEN_LT, bold=True)

    sy0, sy1 = 410, 800
    for i, (box, shotname, lab) in enumerate(zip(
            [(170, sy0, 950, sy1), (970, sy0, 1750, sy1)],
            ["07-ci-pipeline.png", "08-test-output.png"],
            ["CI/CD pipeline", "2,400+ tests"])):
        x0b, y0b, x1b, y1b = box
        a = ease_out(seg(t, 0.3 + 0.1 * i, 0.55 + 0.1 * i))
        if a <= 0:
            continue
        paste_shot(img, shotname, box, inner_margin=12, alpha=a)
        draw_text(d, (x0b + (x1b - x0b) // 2, y1b + 26), lab, 24, WHITE, bold=True)

    a = ease_out(seg(t, 0.55, 0.9))
    draw_text(d, (960, 880), "308 error codes  ·  2,400+ tests  ·  99.5% coverage  ·  51 KB WASM",
              34, blend(MUTED, WHITE, a), bold=True)

    if t > 0.78:
        a = ease_out(seg(t, 0.78, 0.95))
        draw_text(d, (960, 950), "Deployed on Stellar Testnet · verifiable on Stellar Expert",
                  30, blend(MUTED, GREEN_LT, a), bold=True)
    return img


INITIALS = ["AL", "KA", "MJ", "TO", "EK", "RB", "SN", "ZO", "IP", "DA",
            "CW", "GV", "MN", "YK", "JT", "PQ", "HU", "BW", "RS", "OT",
            "CK", "NP", "VD", "XS", "EM", "FA", "GL", "HM", "JQ", "LZ"]


def scene6(t):
    img = new_canvas(glow_cy=400, glow_strength=0.6)
    d = ImageDraw.Draw(img)

    draw_text(d, (960, 130), "Open community. Real momentum.", 54, WHITE, bold=True)

    cols = 10
    r0 = 52
    x0 = (W - cols * (r0 * 2 + 18)) // 2
    for i, init in enumerate(INITIALS):
        r, c = divmod(i, cols)
        x = x0 + c * (r0 * 2 + 18)
        y = 260 + r * (r0 * 2 + 18)
        thresh = 0.05 + i * 0.025
        a = ease_out(seg(t, thresh, thresh + 0.12))
        if a <= 0:
            continue
        d.ellipse([x, y, x + r0 * 2, y + r0 * 2], fill=blend(BG_TOP, PRIMARY, a), outline=ACCENT, width=2)
        draw_text(d, (x + r0, y + r0), init, 22, blend(DIM, WHITE, a), bold=True)

    c1 = int(round(89 * ease_out(seg(t, 0.35, 0.8))))
    c2 = int(round(185 * ease_out(seg(t, 0.45, 0.9))))
    draw_text(d, (700, 760), f"{c1}", 90, GREEN, bold=True)
    draw_text(d, (700, 830), "contributors", 28, MUTED, bold=False)
    draw_text(d, (1220, 760), f"{c2}", 90, WHITE, bold=True)
    draw_text(d, (1220, 830), "merged pull requests", 28, MUTED, bold=False)

    draw_text(d, (960, 960), "A living pipeline: clear issues become shipped features",
              30, blend(MUTED, WHITE, ease_out(seg(t, 0.7, 1.0))), bold=False)
    return img


def scene7(t, logo, icon):
    img = new_canvas(glow_cy=360, glow_strength=0.8)
    d = ImageDraw.Draw(img)

    ph = (t * 0.6) % 1.0
    r = 200 + ph * 360
    col = blend(ACCENT, BG_TOP, ph)
    d.ellipse([960 - r, 300 - r, 960 + r, 300 + r], outline=col, width=3)

    cw, ch = 1080, 330
    cx0, cy0 = 960 - cw // 2, 130 - ch // 2
    a = ease_out(seg(t, 0, 0.25))
    d.rounded_rectangle([cx0, cy0, cx0 + cw, cy0 + ch], radius=28, fill=blend(BG_TOP, (255, 255, 255), a))
    if a > 0.05:
        paste_scaled(img, logo, 960, 290, int(880 * a), alpha=int(255 * a))

    draw_text(d, (960, 560), "Fund the planet.", 72, WHITE, bold=True)
    draw_text(d, (960, 650), "One XLM at a time.", 56, GREEN_LT, bold=True)

    a2 = ease_out(seg(t, 0.35, 0.8))
    draw_text(d, (960, 800), "stellar-indigo-pay.vercel.app", 36, blend(MUTED, WHITE, a2), bold=True)
    draw_text(d, (960, 860), "github.com/Stellar-IndigoPay/Stellar-IndigoPay", 28,
              blend(MUTED, WHITE, a2), bold=False)

    paste_scaled(img, icon, 960, 940, 40, alpha=int(255 * a2))
    return img


SCENE_RENDERERS = {1: scene1, 2: scene2, 3: scene3, 4: scene4, 5: scene5, 6: scene6, 7: scene7}


# ─────────────────────────────────────────────────────────────────────────────
# Audio assembly
# ─────────────────────────────────────────────────────────────────────────────
def decode_wav(mp3_path, tmp_wav):
    subprocess.run([FFMPEG, "-y", "-i", mp3_path, "-ac", "1", "-ar", "44100",
                    "-f", "wav", tmp_wav], check=True, capture_output=True)
    with wave.open(tmp_wav, "rb") as w:
        n = w.getnframes()
        data = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
    return data


def build_master_audio(manifest, sr=44100):
    master = np.zeros(0, dtype=np.float32)
    for n in range(1, 8):
        if n > 1:
            master = np.concatenate([master, np.zeros(int(GAP * sr), dtype=np.float32)])
        segwav = decode_wav(manifest[str(n)]["file"], os.path.join(AUDIO_DIR, f"tmp_{n}.wav"))
        master = np.concatenate([master, segwav])
    out = os.path.join(WORK, "master.wav")
    pcm = (np.clip(master, -1, 1) * 32767).astype(np.int16)
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return out, len(master) / sr


# ─────────────────────────────────────────────────────────────────────────────
# Frame rendering + encode
# ─────────────────────────────────────────────────────────────────────────────
def render_scene_frame(n, t, icon, logo):
    r = SCENE_RENDERERS[n]
    if n == 1:
        return r(t, icon)
    if n == 3:
        return r(t, logo)
    if n == 7:
        return r(t, logo, icon)
    return r(t)


def render_frames(manifest, icon, logo):
    os.makedirs(FRAME_DIR, exist_ok=True)
    idx = 0
    total = 0
    for n in range(1, 8):
        dur = manifest[str(n)]["duration"]
        nframes = max(1, int(round(dur * FPS)))
        if n > 1:
            for _ in range(int(round(GAP * FPS))):
                frame = render_scene_frame(n, 0.0, icon, logo)
                frame.save(os.path.join(FRAME_DIR, f"frame_{idx:06d}.jpg"), quality=90)
                idx += 1
        for k in range(nframes):
            t = k / max(1, nframes - 1)
            frame = render_scene_frame(n, t, icon, logo)
            frame.save(os.path.join(FRAME_DIR, f"frame_{idx:06d}.jpg"), quality=90)
            idx += 1
            total += 1
            if total % 250 == 0:
                print(f"  ...{total} frames rendered")
    print(f"  rendered {idx} frames total")
    return idx


def encode(master_wav, nframes):
    cmd = [FFMPEG, "-y", "-loglevel", "error",
           "-framerate", str(FPS),
           "-start_number", "0",
           "-i", os.path.join(FRAME_DIR, "frame_%06d.jpg"),
           "-i", master_wav,
           "-c:v", "libx264", "-preset", "medium", "-crf", "20",
           "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "192k",
           "-shortest",
           "-movflags", "+faststart",
           OUT]
    subprocess.run(cmd, check=True)


def main():
    with open(os.path.join(AUDIO_DIR, "manifest.json")) as f:
        manifest = json.load(f)

    print("Building assets...")
    icon, logo = build_assets()

    print("Assembling master audio...")
    master_wav, total_dur = build_master_audio(manifest)
    print(f"  audio duration: {total_dur:.2f}s ({total_dur/60:.2f} min)")

    print("Rendering frames...")
    nframes = render_frames(manifest, icon, logo)

    print("Encoding MP4...")
    encode(master_wav, nframes)

    size = os.path.getsize(OUT)
    print(f"\n✅ Pitch video: {OUT} ({size/1024/1024:.1f} MB, ~{total_dur:.1f}s)")


if __name__ == "__main__":
    main()
