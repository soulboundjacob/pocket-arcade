"""Puck Duel art (toon, top-down). Imports the shared pipeline from arcade_art.py.
Run: Blender -b -P hockey_art.py -- toon <rink|mallets|puck|thumb|all> [only=key,key]
Frame convention: ORTHOGRAPHIC camera looks straight down -Z, +X is right, +Y is up in the image,
1 logical unit = 0.01 Blender units, 3 px per logical unit.  Table logical coords have y DOWN (game coords):
  Blender (X, Y) = ((x - ORG.x) * L, (ORG.y - y) * L)
Outlines are drawn as explicit ink discs/rings (exactly 2 logical units), because the inverted hull is
invisible on vertical walls seen from straight above.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import arcade_art as A
from arcade_art import bpy, bmesh, math, pi, sin, cos, radians, Vector, Matrix, np, L, ROOT, OUT

ORG = [180.0, 320.0]
INK_W = 2.0

def H(key, hexcol, **kw):
    return A.mat('hk_' + key, hexcol, **kw)

def MP(x, y):
    return ((x - ORG[0]) * L, (ORG[1] - y) * L)

# ------------------------------------------------------------------ polygons (logical, y down)
def arcpts(cx, cy, r, a0, a1, n=14):
    return [(cx + r * cos(radians(a0 + (a1 - a0) * i / n)), cy + r * sin(radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]

def rrect_pts(x0, y0, x1, y1, r, slots=None):
    """rounded rect, clockwise on screen. slots = (sx0, sx1, depth) cuts channels through top & bottom edges."""
    p = []
    p += arcpts(x0 + r, y0 + r, r, 180, 270)
    if slots:
        sx0, sx1, d = slots
        p += [(sx0, y0), (sx0, y0 - d), (sx1, y0 - d), (sx1, y0)]
    p += arcpts(x1 - r, y0 + r, r, -90, 0)
    p += arcpts(x1 - r, y1 - r, r, 0, 90)
    if slots:
        p += [(sx1, y1), (sx1, y1 + d), (sx0, y1 + d), (sx0, y1)]
    p += arcpts(x0 + r, y1 - r, r, 90, 180)
    return p

def cutter_pts(g=0.0):
    """the playing-surface opening (inner shape + the two goal slots) grown by g units"""
    return rrect_pts(14 - g, 14 - g, 346 + g, 626 + g, 40 + g, slots=(120 - g, 240 + g, 20 + g))

def slab(name, pts, z0, z1, m, ox=None):
    mp = [MP(x, y) for x, y in pts]
    area = sum(mp[i][0] * mp[(i + 1) % len(mp)][1] - mp[(i + 1) % len(mp)][0] * mp[i][1] for i in range(len(mp)))
    if area < 0:
        mp = mp[::-1]
    bm = bmesh.new()
    a = [bm.verts.new((x, y, z0 * L)) for x, y in mp]
    b = [bm.verts.new((x, y, z1 * L)) for x, y in mp]
    n = len(mp)
    bm.faces.new(a[::-1]); bm.faces.new(b)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((a[i], a[j], b[j], b[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return A.mesh_obj(name, bm, [m], smooth=False)

def diff(o, cutters):
    for k, c in enumerate(cutters):
        md = o.modifiers.new(f'b{k}', 'BOOLEAN'); md.operation = 'DIFFERENCE'; md.object = c; md.solver = 'EXACT'
    A.bake(o)
    for c in cutters:
        bpy.data.objects.remove(c)
    return o

def region(name, add, subs, z0, z1, m):
    o = slab(name, add, z0, z1, m)
    if subs:
        o = diff(o, [slab(name + '_c%d' % i, s, z0 - 5, z1 + 5, m) for i, s in enumerate(subs)])
    return o

def circle_pts(cx, cy, r, n=64, half=None):
    if half is None:
        return [(cx + r * cos(2 * pi * i / n), cy + r * sin(2 * pi * i / n)) for i in range(n)]
    sgn = 1 if half == 'down' else -1
    return [(cx + r * cos(pi * i / n), cy + sgn * r * sin(pi * i / n)) for i in range(n + 1)]

# ------------------------------------------------------------------ table
INKM = None
def ink():
    return A.outline_mat()

def build_table():
    rail = H('rail', '#1B2A6B'); rail_hi = H('rail_hi', '#4A66C4')
    floor = H('slot', '#0A1030'); surf = H('ice', '#EAF5FF'); hole = H('hole', '#D3E5F5')
    shade = H('shade', '#D2E5F6'); red = H('red', '#E5484D')
    cr_edge = H('cr_edge', '#3F86D6'); cr_fill = H('cr_fill', '#A4D3F8')
    # dark floor (visible only through the goal slots)
    slab('floor', [(0, 0), (360, 0), (360, 640), (0, 640)], -9, -8, floor)
    # playing surface
    surface = rrect_pts(14, 14, 346, 626, 40)
    slab('surface', surface, -1, 0, surf)
    # soft shade just inside the rails (reads as depth), cut away at the goal mouths
    region('shade', rrect_pts(14, 14, 346, 626, 40), [rrect_pts(20, 20, 340, 620, 34), [(120, 0), (240, 0), (240, 640), (120, 640)]], 0, 0.1, shade)
    # faint grid of air holes
    bm = bmesh.new()
    inner = rrect_pts(14 + 5, 14 + 5, 346 - 5, 626 - 5, 35, None)
    def inside(x, y):
        # point-in-rounded-rect test (inset 5)
        x0, y0, x1, y1, r = 19, 19, 341, 621, 35
        cx = min(max(x, x0 + r), x1 - r); cy = min(max(y, y0 + r), y1 - r)
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    gx = [14 + 9 + 14 * i for i in range(24)]
    gy = [14 + 9 + 14 * j for j in range(44)]
    for x in gx:
        for y in gy:
            if not inside(x, y):
                continue
            c = MP(x, y)
            vs = [bm.verts.new((c[0] + 0.9 * L * cos(2 * pi * k / 8), c[1] + 0.9 * L * sin(2 * pi * k / 8), 0.12 * L)) for k in range(8)]
            bm.faces.new(vs)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    A.mesh_obj('holes', bm, [hole], smooth=False)
    # goal creases: semicircles r70 on each goal mouth, dark edge then light fill
    for nm, cy, half in (('top', 14, 'down'), ('bot', 626, 'up')):
        slab('cr_edge_' + nm, circle_pts(180, cy, 70, 64, half), 0.2, 0.3, cr_edge)
        slab('cr_fill_' + nm, circle_pts(180, cy, 66.5, 64, half), 0.3, 0.4, cr_fill)
    # red markings
    slab('centerline', [(14, 318), (346, 318), (346, 322), (14, 322)], 0.5, 0.6, red)
    ring = region('centercircle', circle_pts(180, 320, 61.2), [circle_pts(180, 320, 58.8)], 0.5, 0.6, red)
    slab('faceoff', circle_pts(180, 320, 7), 0.5, 0.6, red)
    # ink outline of the rail edge: 2 units, on the surface side of the rails
    region('ink', cutter_pts(INK_W), [cutter_pts(0)], 5.2, 5.3, ink())   # on the rail side, so the opening is exact
    # the raised rails: outer rect minus the opening
    outer = [(0, 0), (360, 0), (360, 640), (0, 640)]
    r = slab('rail', outer, -3, 5, rail)
    diff(r, [slab('rail_cut', cutter_pts(0), -10, 12, rail)])
    # lighter highlight along the rail tops
    region('rail_hi', cutter_pts(8.5), [cutter_pts(5.5)], 5, 5.1, rail_hi)

# ------------------------------------------------------------------ small parts
def disc(name, r, z0, z1, loc, m, seg=72):
    o = A.lathe(name, [(0, z0 * L), (r * L, z0 * L), (r * L, z1 * L), (0, z1 * L)], [0, 0, 0], seg=seg, mats=[m], smooth=False)
    o.location = (loc[0], loc[1], 0)
    return o

def dome(name, r, h, z0, loc, m, n=16):
    prof = [(0, z0 * L)]
    for i in range(n + 1):
        t = (pi / 2) * i / n
        prof.append((r * cos(t) * L if i < n else 0, (z0 + h * sin(t)) * L))
    prof[1] = (r * L, z0 * L)
    # profile: centre bottom, equator, ... top
    o = A.lathe(name, prof, [0] * (len(prof) - 1), seg=72, mats=[m], smooth=True, sharp=60)
    o.location = (loc[0], loc[1], 0)
    return o

def hl_ellipse(name, c, z, rx, ry, rot, m):
    bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=20, v_segments=10, radius=1.0)
    R = Matrix.Rotation(rot, 3, 'Z')
    for v in bm.verts:
        v.co = R @ Vector((v.co.x * rx * L, v.co.y * ry * L, v.co.z * 0.5 * L)) + Vector((c[0], c[1], z * L))
    return A.mesh_obj(name, bm, [m], smooth=True, sharp=60)

TEAM = {
    'blue': dict(base='#3B7BEA', groove='#2456C2', knob='#7DAEFB', hl='#FFFFFF'),
    'pink': dict(base='#FF5C93', groove='#D93C73', knob='#FF9DBF', hl='#FFFFFF'),
}

def build_mallet(team, loc=(0.0, 0.0), s=1.0):
    t = TEAM[team]
    mbase = H('mb_' + team, t['base']); mg = H('mg_' + team, t['groove']); mk = H('mk_' + team, t['knob'], shine=1)
    mw = H('hl', '#FFFFFF')
    R = 28.0
    disc('m_ink', R * s, -1, 0.2, loc, ink())
    prof = [(0, 0), (26, 0), (26, 2.0), (25.2, 3.4), (23.5, 4.2), (0, 4.2)]
    o = A.lathe('m_base', [(r * s * L, z * s * L) for r, z in prof], [0] * 5, seg=96, mats=[mbase], smooth=True, sharp=40)
    o.location = (loc[0], loc[1], 0)
    disc('m_groove', 20 * s, 4.2, 4.35, loc, mg, seg=96)
    disc('m_groove2', 17.6 * s, 4.3, 4.45, loc, mbase, seg=96)
    disc('k_ink', 13.0 * s, 4.4, 4.5, loc, ink())
    dome('k_dome', 11.0 * s, 8.5 * s, 4.45 * s, loc, mk)
    hl_ellipse('k_hl', (loc[0] - 3.9 * s * L, loc[1] - 3.9 * s * L), 4.45 * s + 8.5 * s * 0.84 + 0.2, 2.6 * s, 1.3 * s, radians(45), mw)

def build_puck(loc=(0.0, 0.0), s=1.0):
    mb = H('pk_body', '#232E66', shine=1); mr = H('pk_ring', '#6477CC'); mc = H('pk_core', '#2F3C86'); mw = H('hl', '#FFFFFF')
    disc('p_ink', 18 * s, -1, 0.2, loc, ink())
    prof = [(0, 0), (16, 0), (16, 3.0), (14.6, 4.3), (0, 4.3)]
    o = A.lathe('p_body', [(r * s * L, z * s * L) for r, z in prof], [0] * 4, seg=96, mats=[mb], smooth=True, sharp=40)
    o.location = (loc[0], loc[1], 0)
    disc('p_ring', 11.6 * s, 4.3, 4.4, loc, mr, seg=96)
    disc('p_core', 9.0 * s, 4.4, 4.5, loc, mc, seg=96)
    hl_ellipse('p_hl', (loc[0] - 6.6 * s * L, loc[1] - 6.6 * s * L), 4.9, 2.4 * s, 1.1 * s, radians(45), mw)

# ------------------------------------------------------------------ camera / render
def top_cam(cx, cy, scale_units, rz=0.0):
    cam = bpy.data.cameras.new('cam'); cam.type = 'ORTHO'; cam.ortho_scale = scale_units * L
    cam.clip_start = 0.3; cam.clip_end = 3.0
    co = bpy.data.objects.new('cam', cam); A.link(co)
    co.location = (cx, cy, 1.0); co.rotation_euler = (0, 0, rz)
    bpy.context.scene.camera = co

def frame(path, W, H_, build, opaque=False, cam=None):
    A.clear(); build(); A.lights(); A.setup(W, H_, opaque=opaque)
    bpy.context.scene.eevee.use_shadows = False   # flat top-down: shadows only make ragged rim edges
    top_cam(*cam)
    A.render(path)
    print('wrote', path, W, H_)

def rink():
    ORG[:] = [180.0, 320.0]
    frame(f'{OUT}/table_rink.png', 1080, 1920, build_table, opaque=True, cam=(0, 0, 640))

def mallets():
    ORG[:] = [0.0, 0.0]
    for team in ('blue', 'pink'):
        frame(f'{OUT}/mallet_{team}.png', 168, 168, lambda: build_mallet(team), cam=(0, 0, 56))

def puck():
    ORG[:] = [0.0, 0.0]
    frame(f'{OUT}/puck.png', 108, 108, build_puck, cam=(0, 0, 36))

# ------------------------------------------------------------------ thumb
def icon_plane(path, loc, size, rot):
    img = bpy.data.images.load(path); img.alpha_mode = 'STRAIGHT'
    m = bpy.data.materials.new('icon'); m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    out = A.nd(nt, 'ShaderNodeOutputMaterial'); tex = A.nd(nt, 'ShaderNodeTexImage'); tex.image = img; tex.interpolation = 'Linear'
    em = A.nd(nt, 'ShaderNodeEmission'); tr = A.nd(nt, 'ShaderNodeBsdfTransparent'); mx = A.nd(nt, 'ShaderNodeMixShader')
    nt.links.new(tex.outputs['Color'], em.inputs['Color'])
    nt.links.new(tex.outputs['Alpha'], mx.inputs[0]); nt.links.new(tr.outputs[0], mx.inputs[1]); nt.links.new(em.outputs[0], mx.inputs[2])
    nt.links.new(mx.outputs[0], out.inputs['Surface'])
    bm = bmesh.new(); h = size * L / 2
    vs = [bm.verts.new(p) for p in ((-h, -h, 0), (h, -h, 0), (h, h, 0), (-h, h, 0))]
    f = bm.faces.new(vs)
    uv = bm.loops.layers.uv.new('uv')
    for lp, uvp in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        lp[uv].uv = uvp
    o = A.mesh_obj('icon', bm, [m], smooth=False)
    o.location = (loc[0], loc[1], 16 * L); o.rotation_euler = (0, 0, rot)
    return o

def ellipse_slab(name, c, rx, ry, rot, z0, z1, m):
    pts = [(c[0] + rx * cos(2 * pi * i / 48) * cos(rot) - ry * sin(2 * pi * i / 48) * sin(rot),
            c[1] + rx * cos(2 * pi * i / 48) * sin(rot) + ry * sin(2 * pi * i / 48) * cos(rot)) for i in range(48)]
    return slab(name, pts, z0, z1, m)

def build_thumb():
    build_table()
    sh = H('shadow', '#B5CFE6'); trail = H('trail', '#F4FAFF')
    # table-coordinate placements (y down)
    pz = (126, 70)
    # puck trail (tapered streak behind the puck, shot toward the goal at (180, 14))
    d = Vector((pz[0] - 96, pz[1] - 108)).normalized(); n = Vector((-d.y, d.x))
    p0 = Vector(pz) - d * 62; p1 = Vector(pz) - d * 8
    slab('trail1', [tuple(p0 + n * 1), tuple(p0 - n * 1), tuple(p1 - n * 11), tuple(p1 + n * 11)], 0.9, 1.0, H('trail', '#C9E4FA'))
    slab('trail2', [tuple(p0 + d * 14 + n * 0.5), tuple(p0 + d * 14 - n * 0.5), tuple(p1 - n * 8), tuple(p1 + n * 8)], 1.0, 1.1, trail)
    items = [('pink', (184, 56), 1.0), ('blue', (66, 122), 1.0)]
    for team, (x, y), s in items:
        ellipse_slab('sh_' + team, (x + 3.5, y - 3.5), 27 * s, 27 * s, 0, 0.5, 0.6, sh)
        b = MP(x, y); build_mallet(team, b, s)
    ellipse_slab('sh_puck', (pz[0] + 3, pz[1] - 3), 17, 17, 0, 0.5, 0.6, sh)
    build_puck(MP(*pz), 1.0)
    ellipse_slab('sh_icon', (128, 118), 15, 8, 0.5, 0.5, 0.6, sh)
    b = MP(124, 106)
    icon_plane(f'{OUT}/icon_rush.png', b, 48, radians(-8))

def thumb():
    ORG[:] = [180.0, 320.0]
    cx, cy = MP(THUMB_C[0], THUMB_C[1])
    frame(f'{OUT}/thumb_hockey.png', 600, 400, build_thumb, cam=(cx, cy, 250, THUMB_ROT))

THUMB_C = (122, 84)
THUMB_ROT = radians(-16)

if __name__ == '__main__':
    T = A.TARGETS
    if 'all' in T: T = ['rink', 'mallets', 'puck', 'thumb']
    if 'rink' in T: rink()
    if 'mallets' in T: mallets()
    if 'puck' in T: puck()
    if 'thumb' in T: thumb()
