"""Critter Clash art (toon). Imports the shared pipeline from arcade_art.py.
Run: Blender -b -P critter_art.py -- toon <critters|shots|tex|bg|thumb|variants|all> [only=key,key]
Frame convention: orthographic camera looks along +Y, +X is right, +Z is up, 1 logical unit = 0.01 Blender units.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import arcade_art as A
from arcade_art import bpy, bmesh, math, pi, sin, cos, radians, Vector, Matrix, np, L, ROOT, OUT

REVIEW = f'{ROOT}/tools/art/review'

def C(key, hexcol, **kw):
    return A.mat('cc_' + key, hexcol, **kw)

# ------------------------------------------------------------------ helpers
def ell(name, radii, loc, m, ry=0.0, rz=0.0, outline=True, seg=40, rings=20, sharp=60):
    """ellipsoid, radii (x,y,z) in logical units, loc in logical units, tilted ry about Y"""
    bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1.0)
    R = Matrix.Rotation(ry, 3, 'Y') @ Matrix.Rotation(rz, 3, 'Z')
    for v in bm.verts:
        v.co = R @ Vector((v.co.x * radii[0] * L, v.co.y * radii[1] * L, v.co.z * radii[2] * L)) + Vector(loc) * L
    o = A.mesh_obj(name, bm, [m], smooth=True, sharp=sharp)
    if outline:
        A.add_outline(o)
    return o

def poly(name, pts, y, m, depth=0.3, outline=False, scale=L):
    o = A.prism(name, [(x * scale, z * scale) for x, z in pts], depth * L, m)
    o.location = (0, y * L, 0)
    if outline:
        A.add_outline(o)
    return o

# ------------------------------------------------------------------ critter
TEAM = {
    'blue': dict(body='#A8C2F4', body_hi='#C6D8FA', belly='#FFF3DF', band='#2F6FEA', band_d='#2456C2', ear='#F59DB4'),
    'pink': dict(body='#F6B3C7', body_hi='#FBCFDC', belly='#FFF3DF', band='#FF5C93', band_d='#D93C73', ear='#F59DB4'),
}

VARIANTS = {
    # a: round hamster, big eyes, round ears
    'a': dict(rx=8.6, ry=7.0, rz=8.2, eye=(3.4, 4.0), ear=2.8, ears_x=(-3.8, 1.8), nose=1.35, snout=2.3, tilt=0.0),
    # b: chubbier pear, mole snout, small ears, huge eyes
    'b': dict(rx=9.0, ry=7.0, rz=7.6, eye=(3.6, 4.2), ear=2.4, ears_x=(-4.2, 0.8), nose=1.6, snout=2.8, tilt=0.0),
    # c: tall egg, big round ears
    'c': dict(rx=8.0, ry=6.8, rz=8.8, eye=(3.0, 3.6), ear=2.7, ears_x=(-3.2, 2.2), nose=1.3, snout=2.0, tilt=0.0),
}

def build_critter(team='blue', v='a', z0=0.0, x0=0.0, look=(0.0, 0.0)):
    """z0: height of the soles in logical units. returns the root empty."""
    t = TEAM[team]; P = VARIANTS[v]
    ink = (0.10, 0.06, 0.16, 1)
    mb = C('body_' + team, t['body']); mh = C('bodyhi_' + team, t['body_hi'])
    mbel = C('belly', t['belly']); mband = C('band_' + team, t['band'], shine=1); mbandd = C('bandd_' + team, t['band_d'])
    mear = C('ear', t['ear']); mnose = C('nose', '#E8607E', shine=1)
    meye = C('eye', '#FFFFFF', shine=1); mpup = C('pupil', '#2A1B3D', shine=1); mhl = C('hl', '#FFFFFF')
    mfoot = C('foot_' + team, '#D69B6B'); mcheek = C('cheek', '#FF8FA8')
    objs = []
    rx, ry_, rz = P['rx'], P['ry'], P['rz']
    foot_h = 1.9
    cz = z0 + foot_h * 2 + rz - 2.4         # body centre
    # feet (soles at z0), the far foot sits behind
    objs.append(ell('foot_b', (3.0, 2.2, foot_h), (-3.4, 1.8, z0 + foot_h), mfoot))
    objs.append(ell('foot_f', (3.3, 2.4, foot_h), (3.6, -2.2, z0 + foot_h), mfoot))
    # tail nub
    objs.append(ell('tail', (2.2, 2.0, 2.2), (-rx + 0.6, 1.0, cz - 2.2), mh))
    # far ear then body then near ear
    for i, ex in enumerate(P['ears_x']):
        er = P['ear']
        yy = 1.0
        objs.append(ell('ear', (er, er * 0.55, er * 1.08), (ex, yy, cz + rz - 0.6), mb))
        if False: objs.append(ell('ear_in', (er * 0.55, er * 0.2, er * 0.62), (ex + 0.3, yy - er * 0.52, cz + rz * 0.82 + 0.2), mear, outline=False, seg=24, rings=12))
    body = ell('body', (rx, ry_, rz), (0, 0, cz), mb, seg=56, rings=28)
    objs.append(body)
    # belly patch (lighter), sits low front, flat colour on the near face
    if False: objs.append(ell('belly', (rx * 0.55, ry_ * 0.30, rz * 0.34), (rx * 0.25, -ry_ * 0.82, cz - rz * 0.55), mbel, outline=False, seg=40, rings=20))
    # bandana ring around the neck (lathe ring squashed to the body section)
    bz = cz - rz * 0.10
    prof = []
    zs = [-2.1, -1.4, -0.7, 0.0, 0.7, 1.4, 2.1]
    def er(zz):
        u = (bz + zz - cz) / rz
        return rx * math.sqrt(max(0.0, 1 - u * u)) + 0.18
    prof = [(er(zs[0]) - 1.4, zs[0])] + [(er(zz), zz) for zz in zs] + [(er(zs[-1]) - 1.4, zs[-1])]
    ring = A.lathe('band', [(r * L, (z) * L) for r, z in prof], [0] * (len(prof) - 1), seg=56, mats=[mband], smooth=True, sharp=60)
    for vv in ring.data.vertices:
        vv.co.y *= ry_ / rx
    ring.location = (0, 0, bz * L)
    objs.append(ring)
    f = math.sqrt(1 - 0.10 ** 2)
    # bandana knot, trailing back
    kx, kz = -rx * f + 0.2, bz + 0.3
    objs.append(poly('knot_a', [(kx + 1.0, kz + 1.3), (kx - 2.6, kz + 3.0), (kx - 2.0, kz - 0.2), (kx + 1.0, kz - 1.3)], 1.2, mband, outline=True))
    objs.append(poly('knot_b', [(kx + 1.0, kz + 0.6), (kx - 2.4, kz - 2.4), (kx - 2.6, kz - 0.6), (kx + 1.0, kz - 1.3)], 1.0, mbandd, outline=True))
    # front bib triangle (visible team colour from the front)
    if False: objs.append(ell('bib', (3.6, 1.2, 1.8), (rx * 0.55, -ry_ * 0.74, bz - 1.2), mband, outline=False, seg=24, rings=12))
    # snout + nose
    ez = cz + rz * 0.30
    objs.append(ell('snout', (P['snout'] * 1.1, P['snout'] * 0.5, P['snout'] * 0.9), (rx * 0.80, -ry_ * 0.62, ez - 1.9), mbel, outline=False))
    objs.append(ell('nose', (P['nose'], P['nose'] * 0.85, P['nose'] * 0.8), (rx * 0.97, -ry_ * 0.30, ez - 1.0), mnose))
    # eyes: far eye behind-left of near eye, both on the front face
    ew, eh = P['eye']
    lx, lz = look
    for nm, ex, ey, s in (('far', rx * 0.06, -ry_ * 0.82, 0.88), ('near', rx * 0.62, -ry_ * 0.74, 1.0)):
        e = (ex, ey, ez + rz * 0.12)
        objs.append(ell('eye_' + nm, (ew * s, 1.5, eh * s), e, meye, seg=36, rings=18))
        px = e[0] + 0.7 + lx; pz = e[2] - 0.2 + lz
        objs.append(ell('pup_' + nm, (ew * 0.62 * s, 0.9, eh * 0.66 * s), (px, e[1] - 1.1, pz), mpup, outline=False, seg=30, rings=16))
        objs.append(ell('hl_' + nm, (0.85 * s, 0.4, 0.95 * s), (px + 0.6, e[1] - 1.7, pz + 1.3 * s), mhl, outline=False, seg=16, rings=10))
    # cheek blush
    objs.append(ell('cheek', (1.9, 0.5, 1.2), (rx * 0.80, -ry_ * 0.60, ez - 2.4), mcheek, outline=False, seg=20, rings=10))
    # paws: near arm on the front, tiny
    objs.append(ell('paw_n', (1.9, 1.7, 1.9), (rx * 0.45, -ry_ * 0.80, cz - rz * 0.66), mfoot, outline=False))
    root = A.empty('critter'); A.adopt(root, objs)
    root.location = (x0 * L, 0, 0)
    return root

def frame_critter(team, v):
    A.clear(); build_critter(team, v)
    A.lights(); A.setup(72, 72)
    # frame: 24 units square, 1.2 units of padding under the soles (anchor ay 0.95), body centred
    pad = 1.2
    A.make_cam(0, 24 * L, (0.9 * L, (12 - pad - 0.02 * 100 * 1.0 - 0.0) * L - 0.0))
    # camera shift y: centre of frame in z; frame bottom = -(pad + 2*outline) logical
    return

def render_critter(team, v, path, px=72, units=24, bottom=-2.0):
    # 3 px per logical unit. frame bottom sits at logical z=`bottom` (outer outline edge of the soles is at -2).
    A.clear(); build_critter(team, v)
    A.lights(); A.setup(px, px)
    A.make_cam(0, units * L, (-0.5 * L, (bottom + units / 2) * L))
    A.render(path)

def critters():
    for team in ('blue', 'pink'):
        if A.ONLY and 'critter_' + team not in A.ONLY: continue
        render_critter(team, CHOSEN, f'{OUT}/critter_{team}.png', px=96, units=32, bottom=CRITTER_BOTTOM)
        print('critter', team)

CHOSEN = 'a'
CRITTER_BOTTOM = -1.6   # 32x32 frame, anchor ay 0.95: sole z=0 sits 1.6 units above the bottom

def variants():
    paths = []
    for v in VARIANTS:
        for team in ('blue', 'pink'):
            p = f'{REVIEW}/critter_var_{v}_{team}.png'
            render_critter(team, v, p, px=216)   # 9x for a close look
            paths.append(p)
    # also the real size (3x) for readability
    for v in VARIANTS:
        render_critter('blue', v, f'{REVIEW}/critter_var_{v}_3x.png', px=72)

# ------------------------------------------------------------------ shots
def b_rocket():
    mb = C('rk_body', '#F4F1EA', shine=1); mn = C('rk_nose', '#EC3B3B', shine=1); mband = C('rk_band', '#2F7BE8', shine=1)
    mfin = C('rk_fin', '#FFC72A', shine=1); mfl = C('rk_flame', '#FF8A1F'); mfl2 = C('rk_flame2', '#FFE45C'); mwin = C('rk_win', '#7CCBF7', shine=1)
    objs = []
    # body along +X: lathe on Z then rotate
    prof = [(0, -5.5), (2.2, -5.3), (3.1, -4.0), (3.3, -1.0), (3.3, 2.0), (3.0, 3.5), (2.2, 5.4), (1.0, 6.7), (0, 7.1)]
    segm = [0, 0, 0, 2, 0, 1, 1, 1]
    # segment materials: 0 body, 1 nose, 2 band
    o = A.lathe('rk', [(r * L, z * L) for r, z in prof], segm, seg=48, mats=[mb, mn, mband], smooth=True, sharp=40)
    A.add_outline(o)
    o.rotation_euler = (0, pi / 2, 0)
    objs.append(o)
    # fins (top and bottom, flat in XZ) at the tail
    for s in (1, -1):
        objs.append(poly('fin', [(-5.2, 2.4 * s), (-5.6, 6.4 * s), (-1.2, 3.1 * s), (-1.0, 2.4 * s)], -0.3, mfin, outline=True))
    objs.append(poly('fin_c', [(-5.4, -1.8), (-5.4, 1.8), (-2.0, 0)], -3.0, mfin, outline=False)) if False else None
    # porthole
    objs.append(ell('win', (1.35, 0.6, 1.35), (1.3, -3.0, 0.0), mwin, seg=24, rings=12))
    # flame
    fl = A.lathe('flame', [(r * L, z * L) for r, z in [(0, -10.0), (1.1, -8.2), (2.3, -6.4), (2.5, -5.5), (0, -5.3)]], [0, 0, 0, 0], seg=32, mats=[mfl], smooth=True, sharp=40)
    A.add_outline(fl); fl.rotation_euler = (0, pi / 2, 0); objs.append(fl)
    fl2 = A.lathe('flame2', [(r * L, z * L) for r, z in [(0, -8.2), (0.8, -7.0), (1.4, -5.9), (0, -5.0)]], [0, 0, 0], seg=24, mats=[mfl2], smooth=True, sharp=40)
    fl2.rotation_euler = (0, pi / 2, 0); fl2.location = (0, -0.3 * L, 0); objs.append(fl2)
    return objs

def b_grenade():
    objs = []
    g1 = C('gr_a', '#5FA84A'); g2 = C('gr_b', '#3F8A3B'); mm = C('gr_metal', '#C6CCD6', shine=1); md = C('gr_dark', '#4E4C58', shine=1); my = C('gr_ring', '#FFC72A', shine=1)
    R = 4.0
    prof = []
    n = 16
    for i in range(n + 1):
        a = -pi / 2 + pi * i / n
        prof.append((R * cos(a) * L, R * sin(a) * L))
    prof[0] = (0, prof[0][1]); prof[-1] = (0, prof[-1][1])
    segm = [(i % 2) for i in range(n)]
    # bands: groove pattern in 3 horizontal rows
    segm = [1 if i in (3, 4, 7, 8, 11, 12) else 0 for i in range(n)]
    o = A.lathe('gren', prof, segm, seg=40, mats=[g1, g2], smooth=True, sharp=40)
    A.add_outline(o); objs.append(o)
    top = A.lathe('neck', [(r * L, z * L) for r, z in [(0, 3.4), (1.7, 3.4), (1.7, 5.4), (1.4, 5.7), (0, 5.7)]], [0, 0, 0, 0], seg=24, mats=[md], smooth=True, sharp=40)
    A.add_outline(top); objs.append(top)
    # spoon/lever flat along the side
    objs.append(poly('lever', [(1.6, 5.7), (1.6, 4.9), (5.6, 3.3), (6.0, 1.2), (5.0, 0.8), (4.4, 2.8), (1.6, 4.0)], -0.2, mm, outline=False) if False else poly('lever', [(1.2, 5.9), (1.2, 4.9), (4.0, 3.6), (5.2, 1.0), (4.0, 0.6), (3.2, 2.6), (0.6, 3.6)], -2.6, mm, outline=True))
    # pin ring
    objs.append(A.annulus('ring', 0.9 * L, 1.7 * L, (-2.5 * L, 6.4 * L), -3.2 * L, my))
    return objs

def b_cluster():
    objs = []
    sh = C('cl_shell', '#F0702A'); sh2 = C('cl_shell2', '#E85A1C'); rg = C('cl_ridge', '#3A3A46', shine=1); cap = C('cl_cap', '#C6CCD6', shine=1); mf = C('cl_fuse', '#F6E7B8'); sp = C('cl_spark', '#FFE45C')
    R = 5.6
    prof = []; segm = []
    n = 24
    lat = [-pi / 2 + pi * i / n for i in range(n + 1)]
    for a in lat:
        # raised ridges at +-30 deg and at equator
        bump = 0.0
        for c in (-0.52, 0.0, 0.52):
            bump += 0.5 * math.exp(-((a - c) / 0.07) ** 2)
        r = R + bump
        prof.append((r * cos(a) * L, r * sin(a) * L))
    prof[0] = (0, prof[0][1]); prof[-1] = (0, prof[-1][1])
    for i in range(n):
        a = (lat[i] + lat[i + 1]) / 2
        near = min(abs(a - c) for c in (-0.52, 0.0, 0.52))
        segm.append(2 if near < 0.07 else (0 if a > 0 else 1))
    o = A.lathe('shell', prof, segm, seg=48, mats=[sh, sh2, rg], smooth=True, sharp=40)
    A.add_outline(o); objs.append(o)
    cp = A.lathe('cap', [(r * L, z * L) for r, z in [(0, 5.0), (2.3, 5.0), (2.3, 6.8), (1.9, 7.2), (0, 7.2)]], [0, 0, 0, 0], seg=24, mats=[cap], smooth=True, sharp=40)
    A.add_outline(cp); objs.append(cp)
    fu = A.tube('fuse', [(0, 0, 7.0 * L), (0.4 * L, 0, 8.6 * L), (1.8 * L, 0, 9.6 * L), (3.4 * L, 0, 9.5 * L)], [0.45 * L] * 4, mf, seg=10)
    A.add_outline(fu); objs.append(fu)
    objs.append(poly('spark', [(3.4 + r * cos(pi * i / 4 + 0.3), 9.5 + r * sin(pi * i / 4 + 0.3)) for i, r in enumerate([2.0, 0.8] * 4)], -1.2, sp, outline=True))
    return objs

def shot(key, build, wl, hl, elev=0, margin=0.6):
    A.fort_sprite(key, build, wl, hl, elev=elev, margin=margin)

def shots():
    shot('shot_rocket', b_rocket, 20, 10, margin=0.5)
    shot('shot_grenade', b_grenade, 12, 12, elev=18, margin=0.5)
    shot('shot_cluster', b_cluster, 14, 14, elev=18, margin=0.5)

# ------------------------------------------------------------------ textures
def tex_setup(px, w, h, cam_c, ortho):
    A.lights(); A.setup(px[0], px[1], opaque=True)
    A.make_cam(0, ortho, cam_c)

def b_soil(P=0.64):
    import random
    rnd = random.Random(21)
    base = A.F('soil')
    m_lite = C('soil_patch_l', '#C28450'); m_dark = C('soil_patch_d', '#A96B3A')
    root_m = C('root', '#6F4020'); peb_d = C('peb_d', '#8A5329'); peb_dh = C('peb_dh', '#A8703C'); peb_l = C('peb_l', '#D9A370'); peb_lh = C('peb_lh', '#EBC095')
    bm = bmesh.new(); vs = [bm.verts.new(p) for p in ((-2, 0.5, -2), (2, 0.5, -2), (2, 0.5, 2), (-2, 0.5, 2))]
    f = bm.faces.new(vs); bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if f.normal.y > 0: f.normal_flip()
    A.mesh_obj('bg', bm, [base], smooth=False)
    offs = [(ox * P, oz * P) for ox in (-1, 0, 1) for oz in (-1, 0, 1)]
    items = []
    for i in range(6):
        items.append(('patch', rnd.uniform(-0.32, 0.32), rnd.uniform(-0.32, 0.32), rnd.uniform(0.06, 0.11), rnd.choice((m_lite, m_dark))))
    for i in range(9):
        items.append(('peb', rnd.uniform(-0.32, 0.32), rnd.uniform(-0.32, 0.32), rnd.uniform(0.026, 0.046), 'd' if i % 3 else 'l'))
    for ox, oz in offs:
        for kind, x, z, r, m in items:
            X, Z = (x + ox) / L, (z + oz) / L
            if kind == 'patch':
                ell('patch', (r / L, 0.2, r / L * 0.6), (X, 45, Z), m, outline=False, seg=32, rings=16)
            else:
                a_, b_ = (peb_d, peb_dh) if m == 'd' else (peb_l, peb_lh)
                ell('peb', (r / L * 1.25, 0.2, r / L * 0.85), (X, 20, Z), a_, outline=False, seg=28, rings=14)
                ell('pebh', (r / L * 0.7, 0.2, r / L * 0.4), (X - r / L * 0.25, 10, Z + r / L * 0.3), b_, outline=False, seg=20, rings=10)
    for ox, oz in offs:
        for (sx, sz, ang) in ((-0.17, 0.20, 0.5), (0.17, -0.18, -0.4)):
            pts = []
            for i in range(9):
                t = i / 8
                x = sx + (t - 0.5) * 0.26 * cos(ang) + 0.015 * sin(t * 9)
                z = sz + (t - 0.5) * 0.26 * sin(ang) + 0.025 * sin(t * 6 + 1)
                pts.append((x + ox, 0.08, z + oz))
            rad = [0.005 + 0.010 * (1 - i / 8) for i in range(9)]
            t_ = A.tube('root', pts, rad, root_m, seg=8)
            for vv in t_.data.vertices: vv.co.y = 0.08 + (vv.co.y - 0.08) * 0.1

def soil():
    if A.ONLY and 'tex_soil' not in A.ONLY: return
    A.clear(); b_soil(); A.lights(); A.setup(192, 192, opaque=True); bpy.context.scene.eevee.use_shadows = False
    A.make_cam(0, 0.64, (0, 0))
    A.render(f'{OUT}/tex_soil.png'); print('tex_soil')

def b_grass():
    mg = A.F('grass'); mgl = A.F('grass_l'); mgd = A.F('grass_d')
    period = 64.0
    n = 4
    tw = period / n
    lens = [4.6, 3.0, 4.2, 3.4]
    top, strap = 10.0, 6.4
    xs0 = -3 * period / 2
    xl, xr = xs0, xs0 + 3 * period
    bottom = []
    for p in range(3):
        for i, ln in enumerate(lens):
            x0 = xs0 + p * period + i * tw
            c = x0 + tw / 2
            hw = tw * 0.32
            bottom.append((c - hw - 1.4, strap))
            for k in range(8):
                a = pi * k / 7
                bottom.append((c - hw * cos(a), strap - ln * sin(a)))
            bottom.append((c + hw + 1.4, strap))
    outer = [(xl, top)] + bottom + [(xr, top)]
    objs = [poly('turf', outer, 0.0, mg, outline=True)]
    objs.append(poly('hi', [(xl, top - 0.3), (xr, top - 0.3), (xr, top - 2.5), (xl, top - 2.5)], -0.4, mgl))
    objs.append(poly('lo', [(xl, strap + 0.9), (xr, strap + 0.9), (xr, strap - 0.3), (xl, strap - 0.3)], -0.4, mgd))
    # tooth highlights
    for p in range(3):
        for i, ln in enumerate(lens):
            c = xs0 + p * period + i * tw + tw / 2
            objs.append(poly('th', [(c - 3.4, strap - 0.4), (c + 0.6, strap - 0.4), (c + 0.4, strap - ln * 0.6), (c - 2.4, strap - ln * 0.55)], -0.7, mgd) if False else None)
    return [o for o in objs if o]

def grass():
    if A.ONLY and 'tex_grass' not in A.ONLY: return
    A.clear(); b_grass(); A.lights(); A.setup(192, 36)
    A.make_cam(0, 0.64, (0, 0.06))
    bpy.context.scene.eevee.use_shadows = False
    A.render(f'{OUT}/tex_grass.png'); print('tex_grass')

def tiles():
    import numpy as np2
    def load(p):
        img = bpy.data.images.load(p); W, H = img.size
        a = np.array(img.pixels[:], dtype=np.float32).reshape(H, W, 4); bpy.data.images.remove(img); return a
    def save(a, p):
        H, W = a.shape[:2]
        img = bpy.data.images.new('t', W, H, alpha=True); img.pixels = a.flatten().tolist(); img.filepath_raw = p; img.file_format = 'PNG'; img.save()
    s = load(f'{OUT}/tex_soil.png'); save(np.tile(s, (3, 3, 1)), f'{REVIEW}/tile_soil_3x3.png')
    g = load(f'{OUT}/tex_grass.png')
    # grass on a soil background strip to see seams: composite 3x1 over sky blue
    t = np.tile(g, (1, 3, 1)); bg = np.zeros_like(t); bg[:] = (0.55, 0.8, 0.95, 1)
    al = t[:, :, 3:4]; out = t * al + bg * (1 - al); out[:, :, 3] = 1
    save(out, f'{REVIEW}/tile_grass_3x1.png')

# ------------------------------------------------------------------ backdrop
def sea_mat():
    m = bpy.data.materials.new('sea'); m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    out = A.nd(nt, 'ShaderNodeOutputMaterial'); em = A.nd(nt, 'ShaderNodeEmission')
    tc = A.nd(nt, 'ShaderNodeTexCoord'); sep = A.nd(nt, 'ShaderNodeSeparateXYZ')
    nt.links.new(tc.outputs['Generated'], sep.inputs[0])
    def c(h):
        h = h.lstrip('#'); return tuple(A.lin(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4)) + (1,)
    col = A.ramp_fac(nt, sep.outputs['Z'], [(0.0, c('#1E7FC8')), (0.45, c('#2E9CD9')), (0.85, c('#58C4E4')), (1.0, c('#86DCEB'))])
    nt.links.new(col, em.inputs['Color']); nt.links.new(em.outputs[0], out.inputs['Surface'])
    return m

def b_island_bg():
    HZ = 1.20     # logical y 520
    X0, X1 = -0.3, 3.9
    A.bgplane('sky', X0, X1, HZ - 0.05, 6.5, 3.0, A.sky_mat())
    sph = A.sph
    sph('sun', 0.20, (2.95, 2.0, 5.45), A.mat('f_sun', '#FFE066'), sc=(1, 0.3, 1), seg=48, rings=24)
    def cloud(cx, cz, k=1.0):
        for dx, dz, r in ((-0.26, -0.02, 0.10), (-0.12, 0.05, 0.15), (0.05, 0.09, 0.19), (0.24, 0.02, 0.15), (0.38, -0.03, 0.10), (0.05, -0.06, 0.13)):
            sph('c', r * k, (cx + dx * k, 1.6, cz + dz * k), A.F('cloud'), sc=(1, 0.35, 0.92), seg=36, rings=18)
    cloud(0.62, 5.55, 1.0); cloud(2.4, 4.75, 0.8); cloud(0.5, 3.75, 0.62); cloud(3.2, 3.55, 0.5); cloud(1.7, 5.95, 0.5)
    # far islands: grass mounds with a bit of beach, bottoms hidden by the sea
    def islet(x, rx, rz, tree=False):
        sph('is_soil', 1.0, (x, 1.0, HZ - 0.02), A.F('soil_l'), sc=(rx * 1.04, 0.2, rz * 0.78), seg=48, rings=24)
        sph('is_grass', 1.0, (x, 0.95, HZ + 0.0), A.F('grass'), sc=(rx, 0.2, rz), seg=48, rings=24)
        sph('is_hi', 1.0, (x - rx * 0.18, 0.9, HZ + rz * 0.22), A.F('grass_l'), sc=(rx * 0.55, 0.2, rz * 0.5), outline=False, seg=32, rings=16)
    islet(0.55, 0.30, 0.15); islet(1.45, 0.16, 0.085); islet(2.55, 0.22, 0.12); islet(3.3, 0.14, 0.07)
    # the sea, flat plane from the horizon down, with a hairline lighter edge
    A.bgplane('sea', X0, X1, -0.3, HZ, 0.4, sea_mat())
    A.bgplane('horizon_line', X0, X1, HZ - 0.012, HZ, 0.39, C('hz', '#BDEFF5'))
    import random
    rnd = random.Random(8)
    light = C('wave_l', '#9DE6F2'); deep = C('wave_d', '#1A72B8'); foam = C('wave_f', '#E8FBFF')
    for i in range(46):
        t = rnd.random() ** 0.9                      # 0 at horizon, 1 at bottom
        z = HZ - 0.06 - t * (HZ - 0.05)
        x = rnd.uniform(0.0, 3.6)
        w = 0.05 + 0.20 * t * rnd.uniform(0.6, 1.1)
        h = 0.007 + 0.012 * t
        m = foam if i % 3 == 0 else (light if i % 3 == 1 else deep)
        sph('wv', 1.0, (x, 0.3, z), m, sc=(w, 0.02, h), outline=False, seg=24, rings=10)
        sph('wv2', 1.0, (x + w * 0.7, 0.3, z - h * 2.6), m, sc=(w * 0.55, 0.02, h * 0.9), outline=False, seg=24, rings=10)

def b_island_bg_wide():
    HZ = 1.10     # logical y 250 of 360 (row 750 of 1080)
    X0, X1 = -0.3, 6.7
    A.bgplane('sky', X0, X1, HZ - 0.05, 3.9, 3.0, A.sky_mat())
    sph = A.sph
    sph('sun', 0.20, (5.9, 2.0, 2.6), A.mat('f_sun', '#FFE066'), sc=(1, 0.3, 1), seg=48, rings=24)
    def cloud(cx, cz, k=1.0):
        for dx, dz, r in ((-0.26, -0.02, 0.10), (-0.12, 0.05, 0.15), (0.05, 0.09, 0.19), (0.24, 0.02, 0.15), (0.38, -0.03, 0.10), (0.05, -0.06, 0.13)):
            sph('c', r * k, (cx + dx * k, 1.6, cz + dz * k), A.F('cloud'), sc=(1, 0.35, 0.92), seg=36, rings=18)
    cloud(0.9, 2.5, 1.0); cloud(2.0, 1.95, 0.5); cloud(3.4, 2.65, 0.55); cloud(5.0, 2.05, 0.8); cloud(6.1, 1.7, 0.45)
    # far islands: grass mounds with a bit of beach, bottoms hidden by the sea
    def islet(x, rx, rz, tree=False):
        sph('is_soil', 1.0, (x, 1.0, HZ - 0.02), A.F('soil_l'), sc=(rx * 1.04, 0.2, rz * 0.78), seg=48, rings=24)
        sph('is_grass', 1.0, (x, 0.95, HZ + 0.0), A.F('grass'), sc=(rx, 0.2, rz), seg=48, rings=24)
        sph('is_hi', 1.0, (x - rx * 0.18, 0.9, HZ + rz * 0.22), A.F('grass_l'), sc=(rx * 0.55, 0.2, rz * 0.5), outline=False, seg=32, rings=16)
    islet(0.7, 0.30, 0.15); islet(1.6, 0.16, 0.085); islet(4.9, 0.22, 0.12); islet(5.75, 0.14, 0.07)
    # the sea, flat plane from the horizon down, with a hairline lighter edge
    A.bgplane('sea', X0, X1, -0.3, HZ, 0.4, sea_mat())
    A.bgplane('horizon_line', X0, X1, HZ - 0.012, HZ, 0.39, C('hz', '#BDEFF5'))
    import random
    rnd = random.Random(8)
    light = C('wave_l', '#9DE6F2'); deep = C('wave_d', '#1A72B8'); foam = C('wave_f', '#E8FBFF')
    for i in range(84):
        t = rnd.random() ** 0.9                      # 0 at horizon, 1 at bottom
        z = HZ - 0.06 - t * (HZ - 0.05)
        x = rnd.uniform(0.0, 6.4)
        w = 0.05 + 0.20 * t * rnd.uniform(0.6, 1.1)
        h = 0.007 + 0.012 * t
        m = foam if i % 3 == 0 else (light if i % 3 == 1 else deep)
        sph('wv', 1.0, (x, 0.3, z), m, sc=(w, 0.02, h), outline=False, seg=24, rings=10)
        sph('wv2', 1.0, (x + w * 0.7, 0.3, z - h * 2.6), m, sc=(w * 0.55, 0.02, h * 0.9), outline=False, seg=24, rings=10)

def bg_wide():
    if A.ONLY and 'bg_island_wide' not in A.ONLY: return
    A.clear(); b_island_bg_wide(); A.lights(); A.setup(1920, 1080, opaque=True)
    A.make_cam(0, 6.4, (3.2, 1.8))
    A.render(f'{OUT}/bg_island_wide.png'); print('bg_island_wide')

def bg():
    if A.ONLY and 'bg_island' not in A.ONLY: return
    A.clear(); b_island_bg(); A.lights(); A.setup(1080, 1920, opaque=True)
    A.make_cam(0, 6.4, (1.8, 3.2))
    A.render(f'{OUT}/bg_island.png'); print('bg_island')

# ------------------------------------------------------------------ thumbnail
def hill_top(x):
    # surface height in logical units (x in -135..135)
    h = 52 + 20 * cos(x / 135 * pi * 0.9) + 6 * cos(x / 41.0 + 1.0)
    # crater centred at x=18
    d = (x - 18) / 30.0
    if abs(d) < 1:
        h -= 26 * (1 - d * d) ** 1.0 * (1.0 if abs(d) < 1 else 0)
    return h

def build_thumb():
    mg = A.F('grass'); mgl = A.F('grass_l'); mgd = A.F('grass_d'); ms = A.F('soil'); msd = A.F('soil_d'); mscorch = C('scorch', '#5A3A24')
    mstone = C('stone', '#D9A370')
    X = list(range(-135, 136, 3))
    top = [(x, hill_top(x)) for x in X]
    # bottom chunk outline: rounded underside
    bot = []
    for x in reversed(X):
        u = x / 135.0
        bot.append((x, -10 - 46 * math.sqrt(max(0.0, 1 - u * u)) + 46 * 0))
    soil_poly = top + bot
    objs = [poly('soil', soil_poly, 0.0, ms, outline=True)]
    # grass cap: band hugging the top profile (but not in the crater bowl)
    cap = []
    for x, h in top:
        cap.append((x, h))
    capb = [(x, h - 11 - 2.0 * math.sin(x / 9.0)) for x, h in reversed(top)]
    # split at crater
    def in_cr(x): return abs((x - 18) / 30.0) < 0.82
    seg = []
    parts = []
    for (x, h) in top:
        if in_cr(x):
            if len(seg) > 1: parts.append(seg)
            seg = []
        else:
            seg.append((x, h))
    if len(seg) > 1: parts.append(seg)
    for si, sg in enumerate(parts):
        p = sg + [(x, h - 11 - 2.0 * math.sin(x / 9.0)) for x, h in reversed(sg)]
        objs.append(poly('cap', p, -0.5, mg, outline=False))
        hp = [(x, h - 0.2) for x, h in sg] + [(x, h - 4.5) for x, h in reversed(sg)]
        objs.append(poly('cap_hi', hp, -0.8, mgl, outline=False))
    # crater scorch inside the bowl
    cr = [(x, h) for x, h in top if in_cr(x)]
    pol = cr + [(x, h - 6 - 4 * (1 - ((x - 18) / 30.0) ** 2)) for x, h in reversed(cr)]
    objs.append(poly('scorch', pol, -0.6, mscorch, outline=False))
    # pebbles in the soil
    for (x, z, r) in ((-95, 8, 6), (-60, 18, 4), (-20, 6, 5), (55, 14, 6), (95, 6, 4), (10, -12, 5), (-70, -16, 5), (78, -14, 4)):
        objs.append(ell('peb', (r * 1.2, 0.5, r * 0.8), (x, -1.0, z), mstone, outline=True, seg=20, rings=10))
    return objs

def b_thumb():
    base = build_thumb()
    hill = A.empty('hill'); A.adopt(hill, base)
    hill.location = (0, 0, 0)
    def surf(x): return hill_top(x)
    # critters on the hill surface
    cb = build_critter('blue', 'a', z0=surf(-85) - 2.0, x0=-85, look=(0.5, 0.2)); cb.scale = (1.9, 1.9, 1.9)
    # scaling about origin: keep placement by explicit location
    cb.location = (-85 * L, 0, (surf(-85) - 2.0) * L * 0 + 0)
    return hill, cb

def thumb():
    if A.ONLY and 'thumb_critters' not in A.ONLY: return
    A.clear()
    hill = build_thumb()
    root = A.empty('hill'); A.adopt(root, hill)
    S = 1.0
    # critters (scaled 1.55) standing on the grass: scale about the soles
    def place(team, x, flip, look):
        z0 = hill_top(x) - 3.0
        c = build_critter(team, 'a', z0=0, x0=0, look=look)
        k = 2.5
        c.scale = (-k if flip else k, k, k)
        c.location = (x * L, -2.0 * L, z0 * L)
        return c
    place('blue', -92, False, (0.9, 0.3))
    place('pink', 105, True, (0.9, 0.3))
    # rocket in flight, angled up-left to right descending: from blue towards pink, above the crater
    rk = A.empty('rocket'); A.adopt(rk, b_rocket()); k = 2.6
    rk.scale = (k, k, k); rk.rotation_euler = (0, radians(18), 0); rk.location = (-40 * L, -4 * L, 118 * L)
    # explosion puff at the crater
    mx = C('ex_o', '#FF8A1F'); my = C('ex_y', '#FFD84A'); mw = C('ex_w', '#FFFFFF'); ms = C('sm', '#E9E4F2')
    ex = hill_top(18) + 6
    sm = [(-10, 14, 11), (30, 22, 13), (6, 36, 10), (42, 4, 9)]
    for dx, dz, r in sm:
        ell('smoke', (r, 2.0, r * 0.9), (18 + dx, -6, ex + dz + 8), ms, seg=28, rings=14)
    st = poly('boom', [((24 if i % 2 == 0 else 13) * cos(0.2 + pi * i / 9), (24 if i % 2 == 0 else 13) * sin(0.2 + pi * i / 9)) for i in range(18)], -9, mx, outline=True)
    st.location = (18 * L, -9 * L, (ex + 14) * L)
    st2 = poly('boom2', [((15 if i % 2 == 0 else 8) * cos(0.5 + pi * i / 7), (15 if i % 2 == 0 else 8) * sin(0.5 + pi * i / 7)) for i in range(14)], -12, my, outline=False)
    st2.location = (18 * L, -12 * L, (ex + 14) * L)
    ell('core', (6, 1, 6), (18, -14, ex + 14), mw, outline=False)
    A.lights(); A.setup(600, 400); bpy.context.scene.eevee.use_shadows = False
    # frame 600x400 px -> 200x133 logical units at 3x ... scale: ortho 2.0 (200 units) wide
    A.make_cam(0, 2.9, (0.0, 0.36))
    A.render(f'{OUT}/thumb_critters.png'); print('thumb_critters')


# ------------------------------------------------------------------ props (side-view decoration, base on the bottom edge, 3 px / unit)
def prop_frame(key, W, H, build):
    """frame: W x H logical units, frame bottom = z 0 (props sink a little below so the base is cropped flat), x centred on 0"""
    if A.ONLY and key not in A.ONLY: return
    A.clear(); build(); A.lights(); A.setup(W * 3, H * 3)
    A.make_cam(0, max(W, H) * L, (0, H / 2 * L))
    A.render(f'{OUT}/{key}.png'); print(key)

def leaf(name, cx, cz, ang, length, wid, droop, y, m, n=12, outline=True):
    a = radians(ang); sp = []
    for i in range(n + 1):
        t = i / n; s = t * length
        sp.append((cx + cos(a) * s, cz + sin(a) * s - droop * t * t * length, t))
    up, lo = [], []
    for i, (x, z, t) in enumerate(sp):
        x0, z0, _ = sp[max(i - 1, 0)]; x1, z1, _ = sp[min(i + 1, n)]
        dx, dz = x1 - x0, z1 - z0; d = math.hypot(dx, dz) or 1.0
        nx, nz = -dz / d, dx / d
        w = wid * (sin(pi * min(t * 1.08, 1.0)) ** 0.55) * (1.0 - 0.25 * t)
        up.append((x + nx * w, z + nz * w)); lo.append((x - nx * w, z - nz * w))
    return poly(name, up + lo[::-1], y, m, depth=0.3, outline=outline)

def b_palm():
    mt = C('trunk', '#C9925A'); mtd = C('trunk_d', '#9A6338'); mf1 = C('frond_f', '#4CC24A'); mf2 = C('frond_b', '#2FA043')
    mfd = C('frond_m', '#3AB045'); mco = C('coco', '#8A5A2E', shine=1)
    N = 14; pts = []; rad = []
    for i in range(N + 1):
        t = i / N
        pts.append((6.0 * sin(t * pi * 0.75) * L, 0, (-3 + 61 * t) * L)); rad.append((4.3 - 1.9 * t) * L)
    tr = A.tube('trunk', pts, rad, mt, seg=16); A.add_outline(tr)
    for i in range(2, N, 2):
        t = i / N; x, _, z = pts[i]
        th = math.atan2(pts[i + 1][0] - pts[i - 1][0], pts[i + 1][2] - pts[i - 1][2])
        ell('ring', (rad[i] / L + 0.25, rad[i] / L * 0.9, 0.7), (x / L, -0.4, z / L), mtd, ry=th, outline=False, seg=24, rings=10)
    cx, cz = pts[-1][0] / L, 57.5
    for i, (a, ln, dr, y, m) in enumerate([(138, 22, 0.55, 2.0, mf2), (45, 19, 0.5, 2.5, mf2), (92, 18, 0.1, 3.0, mf2),
                                           (172, 26, 0.95, 0.0, mf1), (8, 22, 0.95, -0.5, mf1), (212, 18, 0.6, -1.5, mfd)]):
        leaf('frond%d' % i, cx, cz, a, ln, 3.9, dr, y, m)
    ell('crown', (3.6, 3.2, 2.6), (cx, -0.5, cz - 0.5), mf2)
    for (x, z, y) in ((cx - 3.2, cz - 5.2, -3.0), (cx + 1.6, cz - 6.2, -3.2), (cx + 4.4, cz - 4.2, 2.5)):
        ell('coco', (3.1, 3.1, 3.1), (x, y, z), mco)

def b_bush():
    mg = C('bush', '#46BE4C'); mgl = C('bush_l', '#6FDA5E'); mgd = C('bush_d', '#33A042')
    for nm, r, c, m in (('l', (9.5, 6.5, 8.5), (-9.0, 1.5, 7.2), mgd), ('r', (9.5, 6.5, 8.8), (9.0, 1.2, 7.4), mgd),
                        ('c', (11.5, 7.0, 11.0), (0.0, 0.0, 10.0), mg), ('t', (6.5, 5.0, 6.0), (-2.0, -1.5, 15.5), mgl)):
        ell('b' + nm, r, c, m, seg=36, rings=18)
    mp = C('fl_p', '#FF6FB5', shine=1); my = C('fl_y', '#FFD84A', shine=1); mw = C('fl_w', '#FFFFFF', shine=1); mo = C('fl_o', '#FF9A3C', shine=1)
    for (x, z, m) in ((-8.5, 12.0, mp), (6.5, 17.0, mo), (10.5, 8.0, mw)):
        ell('fl', (2.7, 1.4, 2.7), (x, -6.6, z), m, seg=20, rings=10)
        ell('flc', (1.1, 0.8, 1.1), (x, -7.9, z), my, outline=False, seg=14, rings=8)

def b_rock():
    mr = C('rock', '#A6A9BC'); mrh = C('rock_h', '#C4C7D6'); mrd = C('rock_d', '#858AA2'); mm = C('moss', '#58BE45'); mmd = C('moss_d', '#3FA23A')
    ell('r_main', (16.2, 10.0, 17.0), (0, 0, 6.0), mr, seg=44, rings=22, sharp=40)
    ell('r_side', (9.0, 7.0, 9.5), (9.5, -4.0, 4.5), mrh, seg=32, rings=16)
    ell('r_dent', (6.5, 6.0, 7.0), (-9.5, -5.0, 6.0), mrd, seg=28, rings=14)
    ell('moss1', (8.0, 7.0, 4.0), (-3.5, -2.0, 19.5), mm, seg=32, rings=14)
    ell('moss2', (4.2, 4.0, 3.0), (3.0, -4.0, 21.0), mmd, seg=24, rings=12)
    ell('moss3', (3.0, 3.0, 2.4), (-11.5, -6.5, 12.5), mm, seg=20, rings=10)

def b_mushroom():
    ms = C('stem', '#FFF1D6'); msd = C('stem_d', '#E8D2AE'); mc = C('cap', '#EE3B3B', shine=1); mw = C('spot', '#FFFFFF')
    ell('stem', (6.4, 5.4, 14.5), (0, 0, 8.5), ms, seg=32, rings=16)
    ell('stem_s', (2.2, 1.0, 9.0), (-3.0, -4.8, 9.0), msd, outline=False, seg=16, rings=10)
    z0, Rr, Hh = 20.0, 15.0, 15.5
    prof = [(0.0, z0), (Rr * 0.97, z0)]
    for k in range(1, 15):
        a = (pi / 2) * k / 14
        prof.append((Rr * cos(a) * (1.0 if k > 0 else 1), z0 + 1.2 + (Hh - 1.2) * sin(a)))
    prof = [(r * L, z * L) for r, z in prof]
    cap = A.lathe('cap', prof, [0] * (len(prof) - 1), seg=56, mats=[mc], smooth=True, sharp=60)
    for vv in cap.data.vertices: vv.co.y *= 0.78
    A.add_outline(cap)
    def cap_y(x, z):
        u = (z - z0 - 1.2) / (Hh - 1.2); r = Rr * math.sqrt(max(0.0, 1 - u * u))
        return -0.78 * math.sqrt(max(0.0, r * r - x * x))
    for (x, z, sx, sz) in ((-6.5, 28.5, 3.3, 2.6), (3.5, 31.5, 3.0, 2.3), (8.5, 25.0, 2.6, 2.4), (-1.0, 24.0, 2.0, 1.6), (-10.5, 23.5, 1.8, 1.8)):
        ell('spot', (sx, 1.2, sz), (x, cap_y(x, z) - 0.2, z), mw, outline=False, seg=24, rings=12)

def b_crate():
    mw = F_('wood'); md = F_('wood_d'); mdd = F_('wood_dd')
    o = A.prism('crate', [(x * L, z * L) for x, z in [(-11, 0), (11, 0), (11, 22), (-11, 22)]], 6 * L, mw, bevel=0.01, seg=2)
    A.add_outline(o)
    T = 3.2; yb = -3.2
    for nm, pts in (('l', [(-11, 0), (-11 + T, 0), (-11 + T, 22), (-11, 22)]), ('r', [(11 - T, 0), (11, 0), (11, 22), (11 - T, 22)]),
                    ('t', [(-11, 22 - T), (11, 22 - T), (11, 22), (-11, 22)]), ('b', [(-11, 0), (11, 0), (11, T), (-11, T)])):
        poly('fr' + nm, pts, yb, md, depth=0.4)
    d = 1.9; a = 11 - T * 0.6; b = 22 - T * 0.6
    poly('diag', [(-11 + T, T + d), (-11 + T + d * 1.4, T), (11 - T, 22 - T - d), (11 - T - d * 1.4, 22 - T)], yb, md, depth=0.4)
    for (x, z) in ((-7.4, 3.4), (7.4, 3.4), (-7.4, 18.6), (7.4, 18.6)):
        ell('nail', (0.9, 0.5, 0.9), (x, yb - 0.5, z), mdd, outline=False, seg=12, rings=8)

def F_(k): return A.F(k)

def props():
    prop_frame('prop_palm', 56, 84, b_palm)
    prop_frame('prop_bush', 40, 26, b_bush)
    prop_frame('prop_rock', 36, 28, b_rock)
    prop_frame('prop_mushroom', 34, 40, b_mushroom)
    prop_frame('prop_crate', 26, 26, b_crate)

# ------------------------------------------------------------------ main
if __name__ == '__main__':
    T = A.TARGETS
    if 'all' in T: T = ['critters', 'shots', 'tex', 'bg', 'thumb']
    if 'variants' in T: variants()
    if 'critters' in T: critters()
    if 'shots' in T: shots()
    if 'tex' in T: soil(); grass(); tiles()
    if 'tiles' in T: tiles()
    if 'bg' in T: bg()
    if 'bgwide' in T: bg_wide()
    if 'thumb' in T: thumb()
    if 'props' in T: props()
