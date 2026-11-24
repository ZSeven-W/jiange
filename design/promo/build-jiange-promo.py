#!/usr/bin/env python3
"""Jiange Launch Promo — a 30 s, 1920x1080 native OpenPencil v0.8.6 .op motion film.

Usage:
  python3 design/promo/build-jiange-promo.py <shots_dir> <out.op>

Export via OpenPencil v0.8.6 native MP4 exporter:
  zz_export_promo <out.op> promo <out.mp4> 1.0 30 30000
"""
import base64
import json
import os
import random
import re
import sys

W, H = 1920, 1080
T = 30000

BLUE = "#3370FF"
SAPPHIRE = "#174EF0"
CYAN = "#4096FF"
SKY = "#38BDF8"
VIOLET = "#8B5CF6"
EMERALD = "#10B981"
ORANGE = "#F97316"
PINK = "#EC4899"
MONO = "Menlo"
SANS = "Inter"
DISPLAY = "Outfit"

random.seed(20261124)
_ids = [0]


def nid(prefix="n"):
    _ids[0] += 1
    return f"{prefix}{_ids[0]}"


def solid(color, opacity=1):
    return [{"type": "solid", "color": color, "opacity": opacity}]


def glow(color, blur):
    return [{"type": "shadow", "offsetX": 0, "offsetY": 0, "blur": blur, "spread": 0, "color": color}]


def ease_out(t):
    return 1 - (1 - t) ** 3


def ease_in_out(t):
    return 4 * t * t * t if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2


def back_out(t):
    c1, c3 = 1.70158, 2.70158
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2


class Track:
    """Piecewise property track on the global 30 s clip clock."""

    def __init__(self, **start):
        self.start = dict(start)
        self.segments = []

    def to(self, t0, t1, ease=ease_out, **values):
        cur = self.value_at_end()
        self.segments.append((t0, t1, {k: (cur.get(k, v), v) for k, v in values.items()}, ease))
        return self

    def value_at_end(self):
        cur = dict(self.start)
        for _, _, vals, _ in self.segments:
            for k, (_, b) in vals.items():
                cur[k] = b
        return cur

    def keyframes(self, steps=7):
        props = set(self.start)
        for _, _, vals, _ in self.segments:
            props |= set(vals)
        times = {0, T}
        for t0, t1, _, _ in self.segments:
            for i in range(steps + 1):
                times.add(round(t0 + (t1 - t0) * i / steps))
        samples = []
        for t in sorted(times):
            samples.append({"offset": round(t / T, 6), "values": self.sample(t, props)})
        return samples

    def sample(self, t, props):
        cur = {p: self.start.get(p) for p in props}
        for t0, t1, vals, ease in self.segments:
            for k, (a, b) in vals.items():
                if t >= t1:
                    cur[k] = b
                elif t > t0:
                    u = ease((t - t0) / (t1 - t0))
                    cur[k] = round(a + (b - a) * u, 3)
                elif cur.get(k) is None:
                    cur[k] = a
        return {k: v for k, v in cur.items() if v is not None}

    def animation(self):
        return {"trigger": "mount", "durationMs": T, "easing": "linear", "keyframes": self.keyframes()}


def animate(node, track):
    anim = track.animation()
    props = {k for kf in anim["keyframes"] for k in kf["values"]}
    if "opacity" in props:
        node.setdefault("opacity", 1)
    if "rotation" in props:
        node.setdefault("rotation", 0)
    node.setdefault("animations", []).append(anim)
    return node


def loop(node, duration, keyframes, delay=0):
    node.setdefault("opacity", 1)
    node.setdefault("animations", []).append({
        "trigger": "mount",
        "durationMs": duration,
        "delayMs": delay,
        "easing": "easeInOut",
        "iterations": "infinite",
        "keyframes": keyframes,
    })
    return node


def rect(x, y, w, h, fill=None, radius=0, stroke=None, effects=None, name="rect"):
    n = {
        "id": nid("r"),
        "type": "rectangle",
        "name": name,
        "x": x,
        "y": y,
        "width": w,
        "height": h,
        "cornerRadius": radius,
    }
    if fill:
        n["fill"] = fill
    if stroke:
        n["stroke"] = stroke
    if effects:
        n["effects"] = effects
    return n


def ellipse(x, y, w, h, fill=None, stroke=None, effects=None, name="ellipse"):
    n = {"id": nid("e"), "type": "ellipse", "name": name, "x": x, "y": y, "width": w, "height": h}
    if fill:
        n["fill"] = fill
    if stroke:
        n["stroke"] = stroke
    if effects:
        n["effects"] = effects
    return n


def text(
    x,
    y,
    w,
    h,
    content,
    size,
    color="#F4F8FC",
    weight=600,
    family=DISPLAY,
    align="left",
    spacing=0,
    effects=None,
    name=None,
):
    n = {
        "id": nid("t"),
        "type": "text",
        "name": name or content[:24],
        "x": x,
        "y": y,
        "width": w,
        "height": h,
        "content": content,
        "fontFamily": family,
        "fontSize": size,
        "fontWeight": weight,
        "lineHeight": 1.15,
        "letterSpacing": spacing,
        "textGrowth": "fixed-width-height",
        "textAlign": align,
        "fill": solid(color),
    }
    if effects:
        n["effects"] = effects
    return n


def frame(x, y, w, h, children, name="group", clip=False):
    return {
        "id": nid("f"),
        "type": "frame",
        "name": name,
        "x": x,
        "y": y,
        "width": w,
        "height": h,
        "layout": "none",
        "clipContent": clip,
        "children": children,
    }


def path(x, y, w, h, d, fill=None, stroke=None, effects=None, closed=True, name="path"):
    n = {
        "id": nid("p"),
        "type": "path",
        "name": name,
        "x": x,
        "y": y,
        "width": w,
        "height": h,
        "d": d,
        "closed": closed,
    }
    if fill:
        n["fill"] = fill
    if stroke:
        n["stroke"] = stroke
    if effects:
        n["effects"] = effects
    return n


def shader_rect(x, y, w, h, preset, uniforms, name):
    return {
        "id": nid("s"),
        "type": "rectangle",
        "name": name,
        "x": x,
        "y": y,
        "width": w,
        "height": h,
        "cornerRadius": 0,
        "fill": [{"type": "shader", "preset": preset, "uniforms": uniforms}],
    }


def centred(s, w, h):
    return (1 - s) * w / 2, (1 - s) * h / 2


def window(node, t_in, t_out, fade=320, dy=0, dx=0, scale=None):
    s0 = {"scaleX": scale, "scaleY": scale} if scale else {}
    cx, cy = centred(scale, node["width"], node["height"]) if scale else (0, 0)
    tr = Track(opacity=0, translateY=dy + cy, translateX=dx + cx, **s0)
    v = dict(opacity=1, translateY=0, translateX=0)
    if scale:
        v.update(scaleX=1, scaleY=1)
    tr.to(t_in, t_in + fade, back_out if scale else ease_out, **v)
    tr.to(t_out - fade, t_out, ease_in_out, opacity=0)
    return animate(node, tr)


def appear(node, t, dur=500, dy=24, dx=0, scale=None):
    if scale:
        cx, cy = centred(scale, node["width"], node["height"])
        dx, dy = dx + cx, dy + cy
    tr = Track(opacity=0, translateY=dy, translateX=dx, **({"scaleX": scale, "scaleY": scale} if scale else {}))
    vals = dict(opacity=1, translateY=0, translateX=0)
    if scale:
        vals.update(scaleX=1, scaleY=1)
    tr.to(t, t + dur, back_out if scale else ease_out, **vals)
    return animate(node, tr)


def flash(t, strength=0.45):
    f = rect(0, 0, W, H, solid("#E2EEFF"), name="Flash cut")
    animate(f, Track(opacity=0).to(t, t + 50, ease_out, opacity=strength).to(t + 50, t + 360, ease_out, opacity=0))
    return f


def burst(start_s, ox, oy, tint, speed=460, gravity=165):
    return shader_rect(
        0,
        0,
        W,
        H,
        "spark_burst",
        {"origin": [ox, oy], "burst": [start_s, 1.5, speed, gravity], "tint": tint},
        f"Spark burst {start_s}s",
    )


def ring(cx, cy, t, size=220, color=CYAN, to=3.6):
    r = ellipse(
        cx - size / 2,
        cy - size / 2,
        size,
        size,
        stroke={"thickness": 3, "fill": solid(color)},
        name="Pulse ring",
    )
    a0, b0 = centred(0.25, size, size)
    a1, b1 = centred(to, size, size)
    return animate(
        r,
        Track(opacity=0, scaleX=0.25, scaleY=0.25, translateX=a0, translateY=b0)
        .to(t, t + 60, ease_out, opacity=1)
        .to(t + 60, t + 1100, ease_out, opacity=0, scaleX=to, scaleY=to, translateX=a1, translateY=b1),
    )


def scale_svg_path(d, s, ox=0.0, oy=0.0):
    """Scale absolute M/L/H/V/C/Q/Z SVG path commands cleanly."""
    tokens = re.findall(r"[A-Za-z]|-?\d+(?:\.\d+)?", d)
    out = []
    cmd = ""
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok.isalpha():
            cmd = tok
            out.append(cmd)
            i += 1
            continue
        if cmd == "H":
            out.append(f"{(float(tok) - ox) * s:.2f}")
            i += 1
        elif cmd == "V":
            out.append(f"{(float(tok) - oy) * s:.2f}")
            i += 1
        elif cmd in ("M", "L"):
            x, y = float(tokens[i]), float(tokens[i + 1])
            out.append(f"{(x - ox) * s:.2f} {(y - oy) * s:.2f}")
            i += 2
        elif cmd == "Q":
            x1, y1, x2, y2 = [float(tokens[i + k]) for k in range(4)]
            out.append(
                f"{(x1 - ox) * s:.2f} {(y1 - oy) * s:.2f} {(x2 - ox) * s:.2f} {(y2 - oy) * s:.2f}"
            )
            i += 4
        elif cmd == "C":
            vals = [float(tokens[i + k]) for k in range(6)]
            pts = " ".join(
                f"{(vals[k] - ox) * s:.2f} {(vals[k + 1] - oy) * s:.2f}" for k in (0, 2, 4)
            )
            out.append(pts)
            i += 6
        else:
            i += 1
    return " ".join(out)


def build_jiange_mark(scale_factor=4.2, animated=True):
    """Build Jiange's official geometric mark from apps/web/public/brand/jiange-mark.svg.

    OpenPencil fits each path's own bbox into the node's (width, height), so each
    path uses its exact tight viewBox bounds and shifted local coordinates.
    """
    s = scale_factor
    box = round(64 * s, 2)
    outer_d = (
        "M28 3 H45 C53 3 59 9 59 17 V41 C59 53 52 61 40 61 H19 "
        "C8 61 3 55 3 47 V46 C3 43 5 42 8 42 H14 C17 42 19 44 19 46 "
        "C19 49 21 50 25 50 V34 H14 V23 H22 C26 23 28 21 28 17 Z"
    )
    fold_d = "M26 4 L10 21 H22 C24.5 21 26 19.5 26 17 Z"

    body = path(
        round(3 * s, 2),
        round(3 * s, 2),
        round(56 * s, 2),
        round(58 * s, 2),
        scale_svg_path(outer_d, s, ox=3.0, oy=3.0),
        fill=[{
            "type": "linear_gradient",
            "angle": 135,
            "stops": [{"offset": 0, "color": "#2563EB"}, {"offset": 1, "color": SAPPHIRE}],
        }],
        effects=glow("#3370FFBB", 30 if animated else 12),
        name="Jiange mark body",
    )
    fold = path(
        round(10 * s, 2),
        round(4 * s, 2),
        round(16 * s, 2),
        round(17 * s, 2),
        scale_svg_path(fold_d, s, ox=10.0, oy=4.0),
        fill=[{
            "type": "linear_gradient",
            "angle": 135,
            "stops": [{"offset": 0, "color": "#60B5FF"}, {"offset": 1, "color": CYAN}],
        }],
        effects=glow("#4096FFCC", 24 if animated else 10),
        name="Jiange mark fold",
    )

    grid_cells = []
    for idx, (gx, gy) in enumerate(((32, 25), (43, 25), (32, 36), (43, 36))):
        cell = rect(
            round(gx * s, 2),
            round(gy * s, 2),
            round(8 * s, 2),
            round(7 * s, 2),
            solid("#EAF4FF", 0.96),
            round(1.8 * s, 2),
            effects=glow("#93C5FD", 12 if animated else 5),
            name=f"Jiange grid cell {idx + 1}",
        )
        grid_cells.append(cell)

    if animated:
        bc0, bd0 = centred(0.32, body["width"], body["height"])
        animate(
            body,
            Track(opacity=0, translateX=-440 + bc0, translateY=180 + bd0, rotation=-42, scaleX=0.32, scaleY=0.32)
            .to(150, 1250, back_out, opacity=1, translateX=0, translateY=0, rotation=0, scaleX=1, scaleY=1),
        )
        body_ghost = json.loads(json.dumps(body))
        body_ghost["id"] = nid("g")
        body_ghost["fill"] = solid(BLUE, 0.25)
        body_ghost["animations"] = []
        animate(
            body_ghost,
            Track(opacity=0, translateX=-560 + bc0, translateY=240 + bd0, rotation=-55, scaleX=0.32, scaleY=0.32)
            .to(260, 1250, ease_out, opacity=0.55, translateX=0, translateY=0, rotation=0, scaleX=1, scaleY=1)
            .to(1250, 1650, ease_out, opacity=0),
        )

        fc0, fd0 = centred(0.32, fold["width"], fold["height"])
        animate(
            fold,
            Track(opacity=0, translateX=420 + fc0, translateY=-220 + fd0, rotation=50, scaleX=0.32, scaleY=0.32)
            .to(350, 1350, back_out, opacity=1, translateX=0, translateY=0, rotation=0, scaleX=1, scaleY=1),
        )
        for idx, cell in enumerate(grid_cells):
            appear(cell, 980 + idx * 90, 380, dy=0, scale=0.2)
        nodes = [body_ghost, body, fold, *grid_cells]
    else:
        nodes = [body, fold, *grid_cells]

    return box, nodes


def top_first(node):
    kids = node.get("children")
    if kids:
        kids.reverse()
        for k in kids:
            top_first(k)
    return node


def wrap_animated_leaves(node):
    kids = node.get("children")
    if not kids:
        return
    for i, k in enumerate(kids):
        if k.get("type") != "frame" and k.get("animations"):
            anims = k.pop("animations")
            k.pop("opacity", None)
            wrapper = frame(k["x"], k["y"], k["width"], k["height"], [k], name=f"{k.get('name', 'leaf')} motion")
            wrapper["animations"] = anims
            wrapper["opacity"] = 1
            k["x"], k["y"] = 0, 0
            kids[i] = wrapper
        else:
            wrap_animated_leaves(k)


def main():
    shots_dir = sys.argv[1]
    out_path = sys.argv[2]
    children = []

    def add(*nodes):
        children.extend(nodes)
        return nodes[0] if len(nodes) == 1 else nodes

    def shot(name):
        with open(os.path.join(shots_dir, name + ".jpg"), "rb") as f:
            data = base64.b64encode(f.read()).decode()
        return [{"type": "image", "url": "data:image/jpeg;base64," + data, "mode": "fill"}]

    # ================================================================== background stage
    add(rect(0, 0, W, H, solid("#040814"), name="Background"))
    for (x, y, s, col, dx, dy) in (
        (-380, -560, 1480, "#174EF03A", 260, 130),
        (1040, 340, 1320, "#7C3AED2B", -280, -150),
        (480, 560, 960, "#38BDF820", 140, -210),
    ):
        g = ellipse(
            x,
            y,
            s,
            s,
            [{"type": "radial_gradient", "radius": 0.5, "stops": [{"offset": 0, "color": col}, {"offset": 1, "color": col[:7] + "00"}]}],
            name="Ambient glow",
        )
        add(animate(g, Track(translateX=0, translateY=0).to(0, T, ease_in_out, translateX=dx, translateY=dy)))

    # perspective floor + scanline
    VX, VY = 960, 615
    floor = []
    for i in range(-15, 16):
        x_end = VX + i * 165
        x0, wv = min(VX, x_end), max(abs(x_end - VX), 1)
        floor.append(
            path(
                x0,
                VY,
                wv,
                H - VY,
                f"M {VX - x0:.1f} 0 L {x_end - x0:.1f} {H - VY}",
                stroke={"thickness": 1.2, "fill": solid(CYAN, 0.2)},
                closed=False,
                name="Grid ray",
            )
        )
    for j in range(1, 12):
        y = VY + (H - VY) * (j / 11) ** 2.2
        floor.append(rect(0, y, W, 1.2, solid(CYAN, 0.05 + 0.2 * (j / 11)), name="Grid row"))
    beam = rect(
        0,
        VY,
        W,
        56,
        [{"type": "linear_gradient", "angle": 0, "stops": [
            {"offset": 0, "color": "#4096FF00"},
            {"offset": 0.5, "color": "#4096FF58"},
            {"offset": 1, "color": "#4096FF00"},
        ]}],
        name="Floor scan",
    )
    loop(
        beam,
        3000,
        [
            {"offset": 0, "values": {"translateY": 0, "opacity": 0}},
            {"offset": 0.16, "values": {"translateY": 38, "opacity": 1}},
            {"offset": 1, "values": {"translateY": H - VY, "opacity": 0}},
        ],
    )
    floor.append(beam)
    grid = frame(0, 0, W, H, floor, name="Grid floor")
    add(
        animate(
            grid,
            Track(opacity=0)
            .to(150, 1200, ease_out, opacity=1)
            .to(4100, 4700, ease_in_out, opacity=0.25)
            .to(24200, 24900, ease_in_out, opacity=1),
        )
    )

    # stars & rising particles
    atmos = []
    for _ in range(72):
        sz = random.uniform(1.5, 3.6)
        st = ellipse(
            random.uniform(0, W),
            random.uniform(0, VY - 30),
            sz,
            sz,
            solid("#D6E9FF"),
            effects=glow("#7FD3FF", 6),
            name="Star",
        )
        loop(
            st,
            random.randint(1700, 4000),
            [
                {"offset": 0, "values": {"opacity": random.uniform(0.12, 0.35)}},
                {"offset": 0.5, "values": {"opacity": 1}},
                {"offset": 1, "values": {"opacity": random.uniform(0.12, 0.35)}},
            ],
            delay=random.randint(0, 2000),
        )
        atmos.append(st)
    for _ in range(30):
        sz = random.uniform(3, 6.5)
        p = ellipse(
            random.uniform(0, W),
            random.uniform(H * 0.45, H),
            sz,
            sz,
            solid(random.choice([BLUE, CYAN, VIOLET, EMERALD])),
            effects=glow(CYAN, 10),
            name="Particle",
        )
        rise = random.uniform(240, 560)
        loop(
            p,
            random.randint(4800, 8200),
            [
                {"offset": 0, "values": {"translateY": 0, "opacity": 0}},
                {"offset": 0.22, "values": {"opacity": 0.85}},
                {"offset": 1, "values": {"translateY": -rise, "opacity": 0}},
            ],
            delay=random.randint(0, 3500),
        )
        atmos.append(p)
    add(frame(0, 0, W, H, atmos, name="Atmosphere"))

    # Finale iridescent orb placed BEHIND the Jiange Logo so the mark stays crisp on top
    orb = shader_rect(
        960 - 270,
        345 - 270,
        540,
        540,
        "iridescent_glass",
        {"sphere": [0.5, 0.5, 0.42, 1.6]},
        "Iridescent orb",
    )
    ox, oy = centred(0.5, 540, 540)
    add(
        animate(
            orb,
            Track(opacity=0, scaleX=0.5, scaleY=0.5, translateX=ox, translateY=oy)
            .to(24500, 25600, back_out, opacity=0.72, scaleX=1, scaleY=1, translateX=0, translateY=0),
        )
    )

    # ================================================================== Act 1: Brand Reveal (0.0 - 4.3 s)
    mark_box, mark_nodes = build_jiange_mark(scale_factor=4.2, animated=True)
    logo = frame(960 - mark_box / 2, 355 - mark_box / 2, mark_box, mark_box, mark_nodes, name="Jiange Logo")
    add(
        animate(
            logo,
            Track(opacity=1, translateY=0)
            .to(3900, 4350, ease_in_out, opacity=0, translateY=-48)
            .to(24500, 25300, ease_out, opacity=1, translateY=-10),
        )
    )
    add(ring(960, 365, 1400, 210, CYAN, 3.8), ring(960, 365, 1580, 170, VIOLET, 4.4))
    add(burst(1.42, 0.5, 0.34, [0.20, 0.44, 1.0]))

    add(
        window(
            text(
                460,
                530,
                1000,
                148,
                "Jiange",
                132,
                "#FFFFFF",
                700,
                DISPLAY,
                "center",
                -2.5,
                effects=glow("#3370FF88", 28),
                name="Wordmark",
            ),
            1550,
            4200,
            fade=500,
            dy=50,
        )
    )
    underline = rect(
        960,
        686,
        4,
        4,
        [{"type": "linear_gradient", "angle": 0, "stops": [
            {"offset": 0, "color": "#3370FF00"},
            {"offset": 0.5, "color": CYAN},
            {"offset": 1, "color": "#3370FF00"},
        ]}],
        2,
        effects=glow(CYAN, 14),
        name="Underline",
    )
    add(
        animate(
            underline,
            Track(width=4, translateX=0, opacity=0)
            .to(1950, 2750, ease_out, width=740, translateX=-370, opacity=1)
            .to(3850, 4200, ease_in_out, opacity=0),
        )
    )
    add(
        window(
            text(
                240,
                714,
                1440,
                44,
                "OPEN-SOURCE FEISHU SUITE  ·  AI-NATIVE  ·  SELF-HOSTABLE",
                24,
                SKY,
                600,
                MONO,
                "center",
                3.2,
                name="Tagline",
            ),
            2150,
            4150,
            fade=300,
            dy=16,
        )
    )
    pill = rect(
        960 - 270,
        792,
        540,
        52,
        solid(BLUE, 0.16),
        26,
        {"thickness": 1.5, "fill": solid(CYAN)},
        glow("#3370FF88", 18),
        "Suite pill",
    )
    add(
        window(pill, 2600, 4150, scale=0.6),
        window(
            text(960 - 270, 804, 540, 30, "DOCS · SHEETS · BASE · SLIDES · BOARD", 17, "#FFFFFF", 700, MONO, "center", 1.2),
            2650,
            4150,
            scale=0.6,
        ),
    )
    add(flash(4280, 0.42))

    # Helper for Acts 2-4 full-stage hero product showcases
    def showcase_act(t_in, t_out, kicker, headline, shot_name, accent, chips):
        SX, SY, SW, SH = 320, 210, 1280, 800
        add(window(text(140, 74, 1200, 32, kicker, 20, accent, 600, MONO, spacing=3), t_in + 80, t_out - 150, dx=-30))
        add(
            window(
                text(140, 112, 1620, 68, headline, 48, "#F8FBFF", 700, DISPLAY, spacing=-1),
                t_in + 180,
                t_out - 150,
                dy=22,
            )
        )
        gl = rect(
            SX - 6,
            SY - 6,
            SW + 12,
            SH + 12,
            solid(accent, 0.1),
            22,
            {"thickness": 2, "fill": solid(accent)},
            glow(accent + "AA", 46),
            f"{shot_name} glow",
        )
        scr = rect(SX, SY, SW, SH, shot(shot_name), 16, name=f"{shot_name} shot")
        for n in (gl, scr):
            a0, b0 = centred(0.84, n["width"], n["height"])
            add(
                animate(
                    n,
                    Track(opacity=0, translateY=220 + b0, translateX=a0, scaleX=0.84, scaleY=0.84, rotation=-3.5)
                    .to(t_in + 150, t_in + 1050, back_out, opacity=1, translateY=0, translateX=0, scaleX=1, scaleY=1, rotation=0)
                    .to(t_out - 420, t_out, ease_in_out, opacity=0, translateY=-36),
                )
            )
        sweep = rect(
            SX - 380,
            SY - 70,
            190,
            SH + 140,
            [{"type": "linear_gradient", "angle": 90, "stops": [
                {"offset": 0, "color": "#FFFFFF00"},
                {"offset": 0.5, "color": "#FFFFFF55"},
                {"offset": 1, "color": "#FFFFFF00"},
            ]}],
            name=f"{shot_name} sweep",
        )
        sweep["rotation"] = 14
        add(
            animate(
                sweep,
                Track(opacity=0, translateX=0)
                .to(t_in + 1000, t_in + 1120, ease_out, opacity=1)
                .to(t_in + 1120, t_in + 2050, ease_in_out, translateX=SW + 700)
                .to(t_in + 2050, t_in + 2200, ease_out, opacity=0),
            )
        )
        for idx, (lbl, cx, cy) in enumerate(chips):
            cw = 34 + 12 * len(lbl)
            chip = rect(
                cx,
                cy,
                cw,
                36,
                solid("#071124", 0.92),
                18,
                {"thickness": 1.5, "fill": solid(accent)},
                glow(accent + "88", 14),
            )
            add(
                window(chip, t_in + 1250 + idx * 120, t_out - 200, scale=0.6),
                window(
                    text(cx, cy + 9, cw, 20, lbl, 15, "#F0F7FF", 700, MONO, "center", 1),
                    t_in + 1300 + idx * 120,
                    t_out - 200,
                ),
            )
        add(flash(t_out - 40, 0.34))

    # ================================================================== Act 2: Cloud Doc (4.3 - 8.3 s)
    showcase_act(
        4300,
        8300,
        "01 / CLOUD DOC  ·  CUSTOM CRDT ENGINE",
        "Real-Time Docs, Inline Track Changes & Interactive Blocks",
        "doc",
        CYAN,
        [
            ("CRDT SYNC", 120, 330),
            ("TRACK CHANGES", 1590, 290),
            ("POLL · TABS · MEDIA", 105, 760),
            ("DOCX & MD IMPORT", 1560, 790),
        ],
    )

    # ================================================================== Act 3: Sheet (8.3 - 12.3 s)
    showcase_act(
        8300,
        12300,
        "02 / SPREADSHEET  ·  WEBGPU + 148 FORMULAS",
        "Million-Row Grid, Modern Formulas, Sparklines & AI Assist",
        "sheet",
        EMERALD,
        [
            ("LET · LAMBDA · QUERY", 90, 320),
            ("LIVE CHARTS", 1620, 300),
            ("SPARKLINES & GROUPS", 85, 770),
            ("VERSIONS & XLSX", 1580, 790),
        ],
    )

    # ================================================================== Act 4: Base (12.3 - 16.3 s)
    showcase_act(
        12300,
        16300,
        "03 / BASE  ·  23 FIELD TYPES · 7 VIEWS",
        "Multi-Dimensional Tables, Hierarchy Tree & AI Batch Fill",
        "base",
        VIOLET,
        [
            ("HIERARCHY & GANTT", 95, 320),
            ("AI COLUMN FILL", 1600, 300),
            ("MULTI-ROLE RBAC", 105, 770),
            ("AUTOMATIONS", 1610, 790),
        ],
    )

    # ================================================================== Act 5: Creative & AI Triptych (16.3 - 20.6 s)
    add(
        window(
            text(
                120,
                92,
                1680,
                34,
                "04 / CREATIVE SUITE & WORKSPACE AI",
                20,
                SKY,
                600,
                MONO,
                "center",
                3.2,
            ),
            16380,
            20450,
            dy=16,
        )
    )
    add(
        window(
            text(
                100,
                134,
                1720,
                84,
                "Slides. Whiteboard. MindMap. Workspace AI RAG.",
                56,
                "#FFFFFF",
                700,
                DISPLAY,
                "center",
                -1.2,
                effects=glow("#3370FF66", 24),
            ),
            16480,
            20450,
            dy=26,
        )
    )
    CW, CH = 530, 332
    cards = [
        ("slides", "WebGPU Slides & Live Follow", ORANGE, "Master Brand Kit · Charts · PPTX"),
        ("board", "Whiteboard & MindMap", EMERALD, "Stickies · Voting · Outline Sync"),
        ("ai", "Workspace AI Knowledge Q&A", BLUE, "Permission-Safe RAG · Citations"),
    ]
    for i, (img, title_lbl, col, sub_lbl) in enumerate(cards):
        cx = 115 + i * (CW + 50)
        cy = 310
        t0 = 16650 + i * 210
        cg = rect(
            cx - 5,
            cy - 5,
            CW + 10,
            CH + 10,
            solid(col, 0.12),
            20,
            {"thickness": 2, "fill": solid(col)},
            glow(col + "99", 34),
            f"Card glow {img}",
        )
        cd = rect(cx, cy, CW, CH, shot(img), 15, name=f"Card {img}")
        for n in (cg, cd):
            add(
                animate(
                    n,
                    Track(opacity=0, translateY=170, rotation=6 - i * 3)
                    .to(t0, t0 + 820, back_out, opacity=1, translateY=0, rotation=0)
                    .to(20100, 20550, ease_in_out, opacity=0, translateY=-50),
                )
            )
        add(
            window(rect(cx, cy + CH + 28, 18, 18, solid(col), 5, effects=glow(col, 12)), t0 + 260, 20450, scale=0.4),
            window(text(cx + 30, cy + CH + 21, CW - 30, 34, title_lbl, 24, "#F8FBFF", 700, SANS), t0 + 300, 20450, dy=14),
            window(text(cx + 30, cy + CH + 58, CW - 30, 26, sub_lbl, 17, "#93A8C3", 500, MONO), t0 + 360, 20450, dy=12),
        )
    add(flash(20580, 0.38))

    # ================================================================== Act 6: Architecture & Enterprise Security (20.6 - 24.5 s)
    mini_box, mini_nodes = build_jiange_mark(scale_factor=0.9, animated=False)
    add(
        window(frame(68, 48, mini_box, mini_box, mini_nodes, name="Corner mark"), 20650, 24400, fade=350),
        window(text(68 + mini_box + 14, 56, 260, 40, "Jiange", 32, "#FFFFFF", 700, DISPLAY), 20700, 24400, dx=-16),
    )

    add(
        window(text(130, 260, 620, 34, "05 / BUILT FROM SCRATCH", 20, CYAN, 600, MONO, spacing=2.5), 20700, 24350, dx=-35),
        window(text(130, 312, 680, 220, "Zero Canvas 2D.\nEnterprise Ready.", 76, "#FFFFFF", 700, DISPLAY, spacing=-1.8), 20800, 24350, dx=-55),
        window(
            text(
                130,
                555,
                670,
                140,
                "Custom RGA/Fugue CRDT, WebGPU/WebGL2 SDF engine,\nzero-dep Go 1.23 SDK + MCP Server, SSO/MFA, PAT,\nWebhooks, External Alerts & IndexedDB Offline.",
                23,
                "#9CB2CC",
                400,
                SANS,
            ),
            20980,
            24350,
            dx=-35,
        ),
    )
    lbar = rect(130, 730, 4, 4, solid(CYAN), 2, effects=glow(CYAN, 12))
    add(
        animate(
            lbar,
            Track(width=4, opacity=0)
            .to(20900, 23800, ease_in_out, width=540, opacity=1)
            .to(24000, 24350, ease_out, opacity=0),
        )
    )

    PX, PY, PW, PH = 870, 200, 920, 650
    panel = rect(
        PX,
        PY,
        PW,
        PH,
        solid("#081428", 0.92),
        28,
        {"thickness": 1.5, "fill": solid(CYAN, 0.45)},
        glow("#3370FF44", 40),
        "Architecture panel",
    )
    add(
        animate(
            panel,
            Track(opacity=0, translateX=120)
            .to(20680, 21300, ease_out, opacity=1, translateX=0)
            .to(24050, 24450, ease_in_out, opacity=0, translateX=70),
        )
    )

    pnodes = [text(44, 34, 620, 30, "FULL-STACK MONOREPO  ·  ZERO BLOAT", 18, "#7FA1C8", 600, MONO, spacing=2)]
    pillars = [
        ("WebGPU UI", "13 Zero-Dep SDKs", BLUE),
        ("Go 1.23 + PG", "19 Tested Packages", SKY),
        ("SSO & MFA", "OIDC · TOTP · Audit", VIOLET),
        ("Open Platform", "PAT · Webhooks · Bots", EMERALD),
        ("Deep Offline", "PWA · IndexedDB Sync", ORANGE),
        ("AI + MCP CLI", "RAG · Single Binary", PINK),
    ]
    for idx, (pt, pd, pcol) in enumerate(pillars):
        bx = 44 + (idx % 3) * 284
        by = 98 + (idx // 3) * 182
        card_bg = rect(
            bx,
            by,
            262,
            152,
            solid(pcol, 0.14),
            20,
            {"thickness": 1.8, "fill": solid(pcol)},
            glow(pcol + "55", 16),
        )
        pnodes.append(appear(card_bg, 20900 + idx * 130, 420, dy=0, scale=0.6))
        pnodes.append(appear(text(bx + 20, by + 38, 222, 36, pt, 27, "#FFFFFF", 700, DISPLAY), 20960 + idx * 130, 400, dy=10))
        pnodes.append(appear(text(bx + 20, by + 88, 222, 28, pd, 17, "#C8DCF2", 500, MONO), 21020 + idx * 130, 400, dy=8))

    pnodes.append(rect(44, 500, 832, 16, solid("#FFFFFF", 0.08), 8))
    pbar = rect(
        44,
        500,
        832,
        16,
        [{"type": "linear_gradient", "angle": 0, "stops": [{"offset": 0, "color": BLUE}, {"offset": 1, "color": EMERALD}]}],
        8,
        effects=glow(BLUE, 14),
    )
    animate(pbar, Track(width=8).to(21550, 23600, ease_in_out, width=832))
    pnodes.append(pbar)
    pnodes.append(
        appear(
            text(44, 542, 832, 36, "✓  1,756 Web Tests · 19 Go Pkgs · 13 SDKs · 0 Canvas 2D", 20, "#A7F3D0", 600, MONO),
            22900,
            350,
            dy=0,
        )
    )
    pframe = frame(PX, PY, PW, PH, pnodes, name="Architecture panel content", clip=True)
    add(
        animate(
            pframe,
            Track(opacity=0)
            .to(20750, 21200, ease_out, opacity=1)
            .to(24050, 24450, ease_in_out, opacity=0),
        )
    )
    add(flash(24450, 0.42))

    # ================================================================== Act 7: Finale (24.5 - 30.0 s)
    add(
        ring(960, 345, 24900, 240, CYAN, 4.2),
        ring(960, 345, 25150, 190, VIOLET, 4.8),
        ring(960, 345, 25400, 280, EMERALD, 3.6),
    )
    for st_, ox_, oy_, tint in (
        (24.95, 0.50, 0.32, [0.20, 0.44, 1.0]),
        (25.35, 0.32, 0.30, [0.55, 0.36, 0.96]),
        (25.75, 0.68, 0.34, [0.06, 0.73, 0.51]),
    ):
        add(burst(st_, ox_, oy_, tint, speed=500, gravity=175))

    add(
        window(
            text(
                260,
                612,
                1400,
                136,
                "Jiange",
                114,
                "#FFFFFF",
                700,
                DISPLAY,
                "center",
                -2.2,
                effects=glow("#3370FF88", 30),
            ),
            25250,
            29700,
            fade=650,
            dy=44,
        )
    )
    add(
        window(
            text(
                140,
                746,
                1640,
                44,
                "Docs · Sheets · Slides · Whiteboard · Base · AI-Native SDKs",
                27,
                SKY,
                600,
                MONO,
                "center",
                1.2,
            ),
            25650,
            29700,
            dy=18,
        )
    )
    add(
        window(
            rect(960 - 330, 818, 660, 56, solid("#FFFFFF", 0.07), 14, {"thickness": 1.2, "fill": solid("#FFFFFF", 0.28)}),
            26150,
            29700,
            scale=0.82,
        ),
        window(
            text(
                960 - 330,
                833,
                660,
                30,
                "$ docker compose up -d && go run ./cmd/jiange",
                21,
                "#EAF4FF",
                500,
                MONO,
                "center",
            ),
            26200,
            29700,
        ),
    )
    add(
        window(
            text(160, 906, 1600, 32, "github.com/ZSeven-W/jiange", 22, "#7C97B5", 500, MONO, "center", 2),
            26600,
            29700,
        )
    )

    # ================================================================== Corner HUD & Fade Out
    hud = []
    for (x, y, sx, sy) in ((40, 40, 1, 1), (W - 40, 40, -1, 1), (40, H - 40, 1, -1), (W - 40, H - 40, -1, -1)):
        hud.append(rect(x if sx > 0 else x - 56, y if sy > 0 else y - 2, 56, 2, solid(CYAN, 0.7)))
        hud.append(rect(x if sx > 0 else x - 2, y if sy > 0 else y - 56, 2, 56, solid(CYAN, 0.7)))
    rec = ellipse(W - 216, 56, 11, 11, solid("#FF4D6D"), effects=glow("#FF4D6D", 10), name="REC dot")
    loop(rec, 1000, [{"offset": 0, "values": {"opacity": 1}}, {"offset": 0.5, "values": {"opacity": 0.15}}, {"offset": 1, "values": {"opacity": 1}}])
    hud += [
        rec,
        text(W - 196, 50, 170, 24, "REC  ·  .op", 16, "#CFE8FF", 600, MONO),
        text(58, H - 72, 920, 24, "JIANGE SUITE  ·  MOTION BY OPENPENCIL v0.8.6  ·  BGM BY H3-MUSIC", 15, "#6F8BA6", 500, MONO, spacing=1),
    ]
    hud_frame = frame(0, 0, W, H, hud, name="HUD")
    add(animate(hud_frame, Track(opacity=0).to(500, 1400, ease_out, opacity=0.85).to(29100, 29700, ease_in_out, opacity=0)))
    add(animate(rect(0, 0, W, H, solid("#000000"), name="Fade out"), Track(opacity=0).to(29350, 30000, ease_in_out, opacity=1)))

    board = frame(0, 0, W, H, children, name="Jiange Launch Promo", clip=True)
    board["id"] = "promo"
    board["fill"] = solid("#040814")
    wrap_animated_leaves(board)
    top_first(board)

    doc = {
        "version": "1.0.0",
        "name": "Jiange — Launch Promo (OpenPencil v0.8.6)",
        "pages": [{"id": "promo-page", "name": "Promo", "children": [board]}],
    }
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False)
    print(f"wrote {out_path} ({_ids[0]} nodes, {os.path.getsize(out_path) // 1024} KB)")


if __name__ == "__main__":
    main()
