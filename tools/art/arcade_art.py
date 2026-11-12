"""Pocket Arcade art pipeline.
Run:  Blender -b -P arcade_art.py -- <clay|gloss|toon> <hero|sprites|flip|thumbs|all> [only=name,name]
1 Blender unit = 100 logical game units. Orthographic cameras, 3 px per logical unit.
"""
import bpy, bmesh, math, sys, os, json, colorsys
from math import pi, sin, cos, radians
from mathutils import Vector, Matrix
import numpy as np

ROOT = '/Users/jacob/Documents/work/pocket-arcade'
argv = sys.argv[sys.argv.index('--') + 1:]
STYLE = argv[0]
TARGETS = [a for a in argv[1:] if not a.startswith('only=')]
ONLY = None
for a in argv[1:]:
    if a.startswith('only='):
        ONLY = a[5:].split(',')
OUT = f'{ROOT}/assets/{STYLE}'
OUTLINE = 0.02  # 2 logical units

# ---------------------------------------------------------------- colour
def lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

def adj(h):
    h = h.lstrip('#')
    r, g, b = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    hh, s, v = colorsys.rgb_to_hsv(r, g, b)
    if STYLE == 'clay':
        s *= 0.86; v = v * 0.9 + 0.1
        r, g, b = colorsys.hsv_to_rgb(hh, s, v)
        r, g, b = r + 0.02, g + 0.01, b * 0.96
    elif STYLE == 'gloss':
        s = min(1, s * 1.15); v = min(1, v * 1.02)
        r, g, b = colorsys.hsv_to_rgb(hh, s, v)
    else:
        s = min(1, s * 1.05)
        r, g, b = colorsys.hsv_to_rgb(hh, s, v)
    return (lin(min(r, 1)), lin(min(g, 1)), lin(min(b, 1)), 1)

# ---------------------------------------------------------------- materials
MATS = {}

def nd(nt, t, **kw):
    n = nt.nodes.new(t)
    for k, v in kw.items():
        setattr(n, k, v)
    return n

def mix_rgba(nt, fac, a, b, blend='MIX'):
    m = nd(nt, 'ShaderNodeMix', data_type='RGBA', blend_type=blend)
    if isinstance(fac, (int, float)):
        m.inputs[0].default_value = fac
    else:
        nt.links.new(fac, m.inputs[0])
    for idx, v in ((6, a), (7, b)):
        if isinstance(v, tuple):
            m.inputs[idx].default_value = v
        else:
            nt.links.new(v, m.inputs[idx])
    return m.outputs[2]

def ramp_fac(nt, src, stops, interp='LINEAR'):
    r = nd(nt, 'ShaderNodeValToRGB')
    r.color_ramp.interpolation = interp
    el = r.color_ramp.elements
    while len(el) < len(stops):
        el.new(0.5)
    for e, (p, c) in zip(el, stops):
        e.position = p; e.color = c
    nt.links.new(src, r.inputs['Fac'])
    return r.outputs['Color']

def colour_source(nt, name, hexcol):
    if name == 'pancakeA':
        tc = nd(nt, 'ShaderNodeTexCoord')
        sep = nd(nt, 'ShaderNodeSeparateXYZ'); nt.links.new(tc.outputs['Object'], sep.inputs[0])
        com = nd(nt, 'ShaderNodeCombineXYZ'); nt.links.new(sep.outputs[0], com.inputs[0]); nt.links.new(sep.outputs[1], com.inputs[1])
        ln = nd(nt, 'ShaderNodeVectorMath', operation='LENGTH'); nt.links.new(com.outputs[0], ln.inputs[0])
        rad = nd(nt, 'ShaderNodeMapRange'); nt.links.new(ln.outputs['Value'], rad.inputs['Value'])
        rad.inputs['From Min'].default_value = 0.15; rad.inputs['From Max'].default_value = 0.55
        base = mix_rgba(nt, rad.outputs['Result'], adj('#DDA14A'), adj('#B9732B'))
        n1 = nd(nt, 'ShaderNodeTexNoise'); n1.inputs['Scale'].default_value = 11; n1.inputs['Detail'].default_value = 4
        nt.links.new(tc.outputs['Object'], n1.inputs['Vector'])
        spot = ramp_fac(nt, n1.outputs['Fac'], [(0.58, (0, 0, 0, 1)), (0.64, (0.8, 0.8, 0.8, 1))])
        n2 = nd(nt, 'ShaderNodeTexNoise'); n2.inputs['Scale'].default_value = 3.5; n2.inputs['Detail'].default_value = 2
        nt.links.new(tc.outputs['Object'], n2.inputs['Vector'])
        mott = ramp_fac(nt, n2.outputs['Fac'], [(0.35, (0, 0, 0, 1)), (0.7, (0.35, 0.35, 0.35, 1))])
        c = mix_rgba(nt, spot, base, adj('#8E4C1C'))
        c = mix_rgba(nt, mott, c, adj('#A9621F'))
        return c
    if name == 'pancakeB':
        tc = nd(nt, 'ShaderNodeTexCoord')
        n1 = nd(nt, 'ShaderNodeTexNoise'); n1.inputs['Scale'].default_value = 5; n1.inputs['Detail'].default_value = 2
        nt.links.new(tc.outputs['Object'], n1.inputs['Vector'])
        mott = ramp_fac(nt, n1.outputs['Fac'], [(0.4, (0, 0, 0, 1)), (0.7, (0.3, 0.3, 0.3, 1))])
        return mix_rgba(nt, mott, adj('#F9D378'), adj('#E8AE4A'))
    rgb = nd(nt, 'ShaderNodeRGB'); rgb.outputs[0].default_value = adj(hexcol)
    return rgb.outputs[0]

def toon_ramp(nt, shader_in_socket, bands):
    s2r = nd(nt, 'ShaderNodeShaderToRGB'); nt.links.new(shader_in_socket, s2r.inputs[0])
    bw = nd(nt, 'ShaderNodeRGBToBW'); nt.links.new(s2r.outputs[0], bw.inputs[0])
    return ramp_fac(nt, bw.outputs[0], bands, 'CONSTANT')

def mat(name, hexcol, rough=None, metal=False, shine=0.0):
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(f'{STYLE}_{name}'); m.use_nodes = True; m.use_fake_user = True
    nt = m.node_tree; nt.nodes.clear()
    out = nd(nt, 'ShaderNodeOutputMaterial')
    col = colour_source(nt, name, hexcol)
    if STYLE == 'toon':
        d = nd(nt, 'ShaderNodeBsdfDiffuse')
        bands = [(0.0, (0.50, 0.46, 0.70, 1)), (0.30, (0.80, 0.78, 0.94, 1)), (0.62, (1, 1, 1, 1))]
        shade = toon_ramp(nt, d.outputs[0], bands)
        c = mix_rgba(nt, 1.0, col, shade, 'MULTIPLY')
        if shine > 0:
            g = nd(nt, 'ShaderNodeBsdfGlossy'); g.inputs['Roughness'].default_value = 0.28
            hl = toon_ramp(nt, g.outputs[0], [(0.0, (0, 0, 0, 1)), (0.8, (1, 1, 1, 1))])
            c = mix_rgba(nt, hl, c, (1, 1, 1, 1))
        em = nd(nt, 'ShaderNodeEmission'); nt.links.new(c, em.inputs['Color'])
        nt.links.new(em.outputs[0], out.inputs['Surface'])
    else:
        p = nd(nt, 'ShaderNodeBsdfPrincipled')
        nt.links.new(col, p.inputs['Base Color'])
        if STYLE == 'clay':
            p.inputs['Roughness'].default_value = rough if rough is not None else 0.82
            p.inputs['Specular IOR Level'].default_value = 0.12
        else:
            p.inputs['Roughness'].default_value = 0.22
            p.inputs['Specular IOR Level'].default_value = 0.7
            if metal:
                p.inputs['Metallic'].default_value = 1.0
                p.inputs['Roughness'].default_value = 0.18
            else:
                p.inputs['Coat Weight'].default_value = 1.0
                p.inputs['Coat Roughness'].default_value = 0.04
        nt.links.new(p.outputs[0], out.inputs['Surface'])
    MATS[name] = m
    return m

def outline_mat():
    if 'outline' in MATS:
        return MATS['outline']
    m = bpy.data.materials.new('outline'); m.use_nodes = True; m.use_fake_user = True
    nt = m.node_tree; nt.nodes.clear()
    out = nd(nt, 'ShaderNodeOutputMaterial'); em = nd(nt, 'ShaderNodeEmission')
    em.inputs['Color'].default_value = (lin(0.10), lin(0.06), lin(0.16), 1)
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    m.use_backface_culling = True
    try:
        m.use_backface_culling_shadow = True
    except Exception:
        pass
    MATS['outline'] = m
    return m

def M(k):
    t = {
        'paper_blue': ('#4A8FE7', {}), 'paper_blue_hi': ('#74AEF2', {}), 'paper_blue_lo': ('#3374CC', {}),
        'paper_pink': ('#FF7B93', {}), 'paper_pink_hi': ('#FF9BAD', {}), 'paper_pink_lo': ('#E85F7B', {}),
        'wood': ('#F0C58B', {}), 'yellow': ('#F6C327', {'shine': 1}),
        'graphite': ('#3A3A46', {'shine': 1}), 'metal': ('#C6CCD6', {'metal': True, 'shine': 1}),
        'eraser': ('#F0829B', {}), 'iron': ('#4E4C58', {'shine': 1}), 'iron_in': ('#3A3945', {'shine': 1}),
        'plate': ('#F7F5EF', {'shine': 1}), 'plate_blue': ('#3C7DDB', {'shine': 1}),
        'butter': ('#FFE070', {'shine': 1}), 'butter_pool': ('#FFEAA0', {'shine': 1}),
        'b_red': ('#EC3B3B', {'shine': 1}), 'b_blue': ('#2F7BE8', {'shine': 1}),
        'b_yellow': ('#FFC72A', {'shine': 1}), 'b_white': ('#F8F6F0', {'shine': 1}),
        'pancakeA': ('#C88', {}), 'pancakeB': ('#C88', {}), 'pancake_side': ('#F1D58F', {}),
    }[k]
    kw = dict(t[1])
    if k == 'metal' and STYLE == 'clay':
        kw = {'rough': 0.78}
    return mat(k, t[0], **kw)

# ---------------------------------------------------------------- mesh helpers
def link(o):
    bpy.context.scene.collection.objects.link(o)

def sharpen(bm, deg):
    ang = radians(deg)
    for e in bm.edges:
        if len(e.link_faces) == 2:
            e.smooth = e.calc_face_angle(0) < ang
        else:
            e.smooth = False

def mesh_obj(name, bm, mats, smooth=True, sharp=35):
    if smooth:
        for f in bm.faces:
            f.smooth = True
        sharpen(bm, sharp)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    for m in mats:
        me.materials.append(m)
    o = bpy.data.objects.new(name, me); link(o)
    return o

def bake(o):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = o.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev)
    mats = list(o.data.materials)
    o.modifiers.clear(); o.data = me
    me.materials.clear()
    for m in mats:
        me.materials.append(m)

def join(objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    return bpy.context.view_layer.objects.active

def add_outline(o):
    if STYLE != 'toon':
        return
    n = len(o.data.materials)
    om = outline_mat()
    for _ in range(n):
        o.data.materials.append(om)
    s = o.modifiers.new('outline', 'SOLIDIFY')
    s.thickness = OUTLINE; s.offset = 1.0; s.use_flip_normals = True
    s.use_even_offset = False; s.nonmanifold_thickness_mode = 'FIXED'; s.nonmanifold_boundary_mode = 'NONE'; s.material_offset = n; s.material_offset_rim = n
    s.use_rim = True

def lathe(name, prof, segmat, seg=72, mats=None, smooth=True, sharp=35):
    bm = bmesh.new()
    rings = []
    for r, z in prof:
        if r < 1e-9:
            rings.append([bm.verts.new((0, 0, z))])
        else:
            rings.append([bm.verts.new((r * cos(2 * pi * i / seg), r * sin(2 * pi * i / seg), z)) for i in range(seg)])
    for k in range(len(prof) - 1):
        a, b = rings[k], rings[k + 1]
        for i in range(seg):
            j = (i + 1) % seg
            if len(a) == 1 and len(b) == 1:
                continue
            if len(a) == 1:
                f = bm.faces.new((a[0], b[j], b[i]))
            elif len(b) == 1:
                f = bm.faces.new((a[i], a[j], b[0]))
            else:
                f = bm.faces.new((a[i], a[j], b[j], b[i]))
            f.material_index = segmat[k]
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mesh_obj(name, bm, mats, smooth, sharp)

def arc(cx, cz, rr, a0, a1, n):
    return [(cx + rr * cos(radians(a0 + (a1 - a0) * i / n)), cz + rr * sin(radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]

def empty(name='root'):
    e = bpy.data.objects.new(name, None); link(e); return e

def adopt(root, objs):
    for o in objs:
        o.parent = root

# ---------------------------------------------------------------- models
def b_pancake(R=0.55, hh=0.07, name='pancake', k=1.0):
    rho = 0.05
    top = [(0, hh + 0.006), (0.14, hh + 0.005), (0.28, hh + 0.0025), (0.40, hh)]
    top += arc(R - rho, hh - rho, rho, 90, 45, 3)[1:]
    nA = len(top) - 1
    side = arc(R - rho, hh - rho, rho, 45, 0, 3)[1:] + [(R, -(hh - rho))] + arc(R - rho, -(hh - rho), rho, 0, -45, 3)[1:]
    bot = arc(R - rho, -(hh - rho), rho, -45, -90, 3)[1:] + [(0.40, -hh), (0.0, -hh - 0.004)]
    prof = top + side + bot
    segm = [0] * nA + [1] * len(side) + [2] * len(bot)
    o = lathe(name, prof, segm, seg=72, mats=[M('pancakeA'), M('pancake_side'), M('pancakeB')], sharp=60)
    if k != 1.0:
        o.data.transform(Matrix.Diagonal((k, k, 1, 1)))
    add_outline(o)
    r = empty(name); adopt(r, [o]); return r

def b_plate():
    top = [(0, 0.012), (0.62, 0.012), (0.74, 0.020), (0.86, 0.042), (0.95, 0.056), (0.975, 0.0585),
           (1.005, 0.0605), (1.035, 0.0620), (1.055, 0.0625), (1.075, 0.0615)]
    rim = [(1.092, 0.057), (1.10, 0.048), (1.09, 0.040)]
    under = [(1.0, 0.030), (0.9, 0.020), (0.7, 0.012), (0.55, 0.006), (0.52, 0.0), (0.42, 0.0), (0.40, 0.004), (0, 0.004)]
    prof = top + rim + under
    segm = [0] * (len(prof) - 1)
    segm[5] = 1; segm[6] = 1
    o = lathe('plate', prof, segm, seg=96, mats=[M('plate'), M('plate_blue')], sharp=50)
    add_outline(o)
    r = empty('plate'); adopt(r, [o]); return r

def b_butter():
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= 0.31; v.co.y *= 0.20; v.co.z *= 0.085
    for _ in range(4):
        bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=1, use_grid_fill=True)
    for v in bm.verts:
        if v.co.z > 0.01:
            dx = (v.co.x + 0.155) / 0.31
            dy = (-v.co.y + 0.10) / 0.20
            v.co.z -= 0.014 * max(0, dx - 0.55) ** 1.5 * 4 * (0.4 + dy)
            v.co.z += 0.008 * (1 - abs(v.co.x) / 0.155) * (1 - abs(v.co.y) / 0.10)
    o1 = mesh_obj('butter', bm, [M('butter')], smooth=True, sharp=80)
    bv = o1.modifiers.new('b', 'BEVEL'); bv.width = 0.028; bv.segments = 4; bv.limit_method = 'ANGLE'
    bake(o1)
    bm2 = bmesh.new()
    bmesh.ops.create_uvsphere(bm2, u_segments=48, v_segments=16, radius=1.0)
    for v in bm2.verts:
        ux = v.co.x * 0.185; uy = v.co.y * 0.125
        a = math.atan2(uy, ux)
        k = 1 + 0.12 * sin(3 * a + 0.5) + 0.06 * sin(5 * a)
        v.co.x = 0.04 + ux * k; v.co.y = -0.035 + uy * k
        v.co.z = max(v.co.z * 0.02 - 0.040, -0.0405)
    o2 = mesh_obj('pool', bm2, [M('butter_pool')], smooth=True)
    j = join([o1, o2]); j.name = 'butter'
    j.data.transform(Matrix.Scale(0.74, 4))
    add_outline(j)
    r = empty('butter'); adopt(r, [j]); return r

def b_ball(R=0.445):
    seg, rings = 48, 36
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=R)
    for v in bm.verts:
        a = math.atan2(v.co.y, v.co.x) % (2 * pi)
        k = a / (2 * pi) * 6
        if abs(k - round(k)) < 0.01 and abs(v.co.z) < R * 0.995:
            v.co *= 0.982
    cols = ['b_red', 'b_white', 'b_blue', 'b_white', 'b_yellow', 'b_white']
    mats = [M(c) for c in cols] + [M('b_white')]
    for f in bm.faces:
        c = f.calc_center_median()
        a = math.atan2(c.y, c.x) % (2 * pi)
        f.material_index = int(a / (2 * pi) * 6) % 6
        if abs(c.z) > R * 0.975:
            f.material_index = 6
    o = mesh_obj('ball', bm, mats, smooth=True, sharp=12)
    add_outline(o)
    o.data.transform(Matrix.Rotation(radians(52), 4, 'X') @ Matrix.Rotation(radians(-10), 4, 'Y') @ Matrix.Rotation(radians(20), 4, 'Z'))
    r = empty('ball'); adopt(r, [o]); return r

def b_plane(color='blue'):
    ms = {'blue': ('paper_blue', 'paper_blue_hi', 'paper_blue_lo'), 'pink': ('paper_pink', 'paper_pink_hi', 'paper_pink_lo')}[color]
    mats = [M(ms[0]), M(ms[1]), M(ms[2])]
    N = Vector((0.28, 0, 0.0)); T = Vector((-0.28, 0, 0.012)); K = Vector((-0.28, 0, -0.125))
    bm = bmesh.new()
    def tri(a, b, c, mi):
        f = bm.faces.new([bm.verts.new(a), bm.verts.new(b), bm.verts.new(c)]); f.material_index = mi
    for s in (-1, 1):
        Mi = Vector((-0.28, s * 0.10, -0.012)); W = Vector((-0.28, s * 0.265, 0.085))
        if s == -1:
            tri(N, T, Mi, 0); tri(N, Mi, W, 1)
        else:
            tri(N, Mi, T, 0); tri(N, W, Mi, 1)
    tri(N, K, T, 2)
    o = bpy.data.objects.new('plane', bpy.data.meshes.new('plane'))
    bm.to_mesh(o.data); bm.free(); link(o)
    for m in mats:
        o.data.materials.append(m)
    sd = o.modifiers.new('thick', 'SOLIDIFY'); sd.thickness = 0.007; sd.offset = 0
    bake(o)
    for p in o.data.polygons:
        p.use_smooth = False
    add_outline(o)
    o.rotation_euler = (0, radians(-7), 0)
    bpy.context.view_layer.update()
    o.data.transform(Matrix.Scale(0.93, 4) @ o.matrix_basis); o.matrix_basis = Matrix.Identity(4)
    r = empty('plane'); adopt(r, [o]); return r

PENCIL = dict(Rc=0.24, cone=0.70, graph=0.175)

def b_pencil(L=6.0):
    Rc = PENCIL['Rc']; ap = Rc * cos(radians(30)); Lc = PENCIL['cone']; Lg = PENCIL['graph']
    N = 216
    rtip = 0.008; rbase = Rc * 1.02
    def rcone(zd):
        return rtip + (rbase - rtip) * zd / Lc if zd <= Lc else 9.0
    def rhex(th):
        t = ((th - radians(30)) % radians(60)) - radians(30)
        return ap / cos(t)
    eraser_len = 0.33; fer_len = 0.45
    zb_end = -(L - 0.02)
    z_fer_b = zb_end + eraser_len
    z_fer_t = z_fer_b + fer_len
    rows = [0.0] + [0.007 * k for k in range(1, 101)] + [0.78, -z_fer_t + 0.05]
    rows = [r for r in rows if r <= -z_fer_t + 0.05 + 1e-9]
    bm = bmesh.new()
    apex = bm.verts.new((0, 0, 0))
    vr = []
    for zd in rows[1:]:
        ring = []
        for i in range(N):
            th = 2 * pi * i / N
            rho = min(rcone(zd), rhex(th))
            ring.append(bm.verts.new((rho * cos(th), rho * sin(th), -zd)))
        vr.append(ring)
    mats = [M('wood'), M('yellow'), M('graphite'), M('metal'), M('eraser')]
    def face_mat(zd0, zd1, th):
        zc = (zd0 + zd1) / 2
        if zc <= Lg:
            return 2
        if zc > Lc:
            return 1
        return 0 if rcone(zc) < rhex(th) else 1
    for i in range(N):
        j = (i + 1) % N
        f = bm.faces.new((apex, vr[0][j], vr[0][i])); f.material_index = 2
    for k in range(len(vr) - 1):
        for i in range(N):
            j = (i + 1) % N
            f = bm.faces.new((vr[k][i], vr[k][j], vr[k + 1][j], vr[k + 1][i]))
            f.material_index = face_mat(rows[k + 1], rows[k + 2], 2 * pi * (i + 0.5) / N)
    bm.faces.new([vr[-1][i] for i in range(N)][::-1]).material_index = 1
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    body = mesh_obj('body', bm, mats, smooth=True, sharp=22)
    zt, zb = z_fer_t, z_fer_b
    fr = 0.249
    prof = [(0, zt), (fr - 0.03, zt), (fr - 0.005, zt - 0.006), (fr, zt - 0.016)]
    for zc in (zt - 0.12, zt - 0.20, zt - 0.28):
        prof += [(fr, zc + 0.016), (fr - 0.012, zc + 0.006), (fr - 0.012, zc - 0.006), (fr, zc - 0.016)]
    prof += [(fr, zb + 0.016), (fr - 0.005, zb + 0.006), (fr - 0.03, zb), (0, zb)]
    fer = lathe('fer', prof, [3] * (len(prof) - 1), seg=72, mats=mats, sharp=40)
    er = 0.205
    prof = [(0, zb + 0.05), (er, zb + 0.05), (er, zb_end + 0.07)] + arc(er - 0.07, zb_end + 0.07, 0.07, 0, -90, 6)[1:] + [(0, zb_end)]
    era = lathe('era', prof, [4] * (len(prof) - 1), seg=72, mats=mats, sharp=60)
    o = join([body, fer, era]); o.name = 'pencil'
    add_outline(o)
    r = empty('pencil'); adopt(r, [o]); return r

SK = dict(R_rim=0.80, floor=0.60, wall=0.25)

def b_skillet():
    R = SK['R_rim']; Fr = SK['floor']; H = SK['wall']
    prof = [(0, 0.0), (Fr - 0.03, 0.0), (Fr, 0.012), (Fr + 0.08, 0.05), (R - 0.06, H - 0.04), (R - 0.01, H - 0.005),
            (R, H), (R - 0.02, H + 0.008), (R - 0.05, H + 0.004), (R - 0.07, H - 0.012), (Fr - 0.01, 0.062),
            (Fr - 0.06, 0.036), (Fr - 0.09, 0.03), (0, 0.03)]
    segm = [0] * (len(prof) - 1)
    for k in range(9, len(prof) - 1):
        segm[k] = 1
    pan = lathe('pan', prof, segm, seg=96, mats=[M('iron'), M('iron_in')], sharp=45)
    hb = bmesh.new()
    bmesh.ops.create_cube(hb, size=1.0)
    for v in hb.verts:
        v.co.x *= 0.90; v.co.y *= 0.105; v.co.z *= 0.052
    for _ in range(3):
        bmesh.ops.subdivide_edges(hb, edges=hb.edges[:], cuts=1, use_grid_fill=True)
    for v in hb.verts:
        t = (0.45 - v.co.x) / 0.90
        v.co.y *= 1 - 0.30 * t
        v.co.z *= 1 - 0.15 * t
    ho = mesh_obj('handle', hb, [M('iron')], smooth=True, sharp=80)
    bv = ho.modifiers.new('b', 'BEVEL'); bv.width = 0.012; bv.segments = 3; bv.limit_method = 'ANGLE'
    cb = bmesh.new()
    bmesh.ops.create_cone(cb, cap_ends=True, segments=32, radius1=0.028, radius2=0.028, depth=0.3)
    cyl = mesh_obj('hole', cb, [M('iron')], smooth=False)
    cyl.location = (-0.34, 0, 0)
    bo = ho.modifiers.new('hole', 'BOOLEAN'); bo.operation = 'DIFFERENCE'; bo.object = cyl; bo.solver = 'EXACT'
    bpy.context.view_layer.update()
    bake(ho)
    bpy.data.objects.remove(cyl)
    ho.data.transform(Matrix.Translation((-(R + 0.30), 0, 0.15)) @ Matrix.Rotation(radians(7), 4, 'Y'))
    lb = bmesh.new()
    bmesh.ops.create_cube(lb, size=1.0)
    for v in lb.verts:
        v.co.x *= 0.10; v.co.y *= 0.14; v.co.z *= 0.035
    for _ in range(2):
        bmesh.ops.subdivide_edges(lb, edges=lb.edges[:], cuts=1, use_grid_fill=True)
    lug = mesh_obj('lug', lb, [M('iron')], smooth=True, sharp=80)
    bv2 = lug.modifiers.new('b', 'BEVEL'); bv2.width = 0.012; bv2.segments = 3; bv2.limit_method = 'ANGLE'
    bake(lug)
    lug.data.transform(Matrix.Translation((R + 0.02, 0, 0.19)))
    o = join([pan, ho, lug]); o.name = 'skillet'
    add_outline(o)
    r = empty('skillet'); adopt(r, [o]); return r

def b_stack(n=6, butter=True, seed=3):
    import random
    rnd = random.Random(seed)
    r = empty('stack')
    pl = b_plate(); pl.parent = r
    z = 0.012 + 0.066
    sp = 0.108
    for i in range(n):
        p = b_pancake(R=0.52 + rnd.uniform(-0.03, 0.02), hh=0.065)
        p.parent = r
        p.location = (rnd.uniform(-0.04, 0.04), rnd.uniform(-0.035, 0.035), z + i * sp)
        p.rotation_euler = (0, 0, rnd.uniform(0, 2 * pi))
    topz = z + (n - 1) * sp + 0.065
    if butter:
        b = b_butter(); b.parent = r
        b.location = (0.02, -0.02, topz + 0.042); b.rotation_euler = (0, 0, radians(-8))
    return r

# ---------------------------------------------------------------- scene / camera / render
def clear():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    for coll in (bpy.data.meshes, bpy.data.lights, bpy.data.cameras):
        for d in list(coll):
            if d.users == 0:
                coll.remove(d)

def sun(name, d, strength, angle, color=(1, 1, 1)):
    ld = bpy.data.lights.new(name, 'SUN'); ld.energy = strength; ld.angle = radians(angle); ld.color = color
    o = bpy.data.objects.new(name, ld); link(o)
    o.rotation_euler = Vector(d).normalized().to_track_quat('-Z', 'Y').to_euler()

def make_world(top, bottom, strength, bg=None):
    w = bpy.data.worlds.new('w'); w.use_nodes = True
    nt = w.node_tree; nt.nodes.clear()
    tc = nd(nt, 'ShaderNodeTexCoord'); sep = nd(nt, 'ShaderNodeSeparateXYZ')
    nt.links.new(tc.outputs['Generated'], sep.inputs[0])
    ma = nd(nt, 'ShaderNodeMath', operation='MULTIPLY_ADD')
    nt.links.new(sep.outputs['Z'], ma.inputs[0]); ma.inputs[1].default_value = 0.5; ma.inputs[2].default_value = 0.5
    col = ramp_fac(nt, ma.outputs[0], [(0.0, bottom), (1.0, top)])
    b = nd(nt, 'ShaderNodeBackground'); b.inputs['Strength'].default_value = strength
    nt.links.new(col, b.inputs['Color'])
    out = nd(nt, 'ShaderNodeOutputWorld')
    if bg is not None:
        lp = nd(nt, 'ShaderNodeLightPath')
        b2 = nd(nt, 'ShaderNodeBackground'); b2.inputs['Color'].default_value = bg; b2.inputs['Strength'].default_value = 1.0
        mx = nd(nt, 'ShaderNodeMixShader')
        nt.links.new(lp.outputs['Is Camera Ray'], mx.inputs[0])
        nt.links.new(b.outputs[0], mx.inputs[1]); nt.links.new(b2.outputs[0], mx.inputs[2])
        nt.links.new(mx.outputs[0], out.inputs['Surface'])
    else:
        nt.links.new(b.outputs[0], out.inputs['Surface'])
    bpy.context.scene.world = w

def lights(bg=None):
    if STYLE == 'clay':
        make_world((1.0, 0.95, 0.90, 1), (0.80, 0.72, 0.68, 1), 0.55, bg)
        sun('key', (0.55, 0.55, -0.70), 1.9, 28, (1.0, 0.94, 0.86))
        sun('fill', (-0.7, 0.4, -0.25), 0.8, 40, (0.86, 0.90, 1.0))
    elif STYLE == 'gloss':
        make_world((0.95, 0.97, 1.0, 1), (0.22, 0.20, 0.30, 1), 0.7, bg)
        sun('key', (0.55, 0.55, -0.72), 3.0, 6)
        sun('rim', (-0.60, -0.55, -0.45), 5.0, 4, (0.85, 0.92, 1.0))
        sun('fill', (-0.2, 0.9, -0.2), 0.8, 30, (1.0, 0.85, 0.9))
    else:
        make_world((1, 1, 1, 1), (0.8, 0.8, 0.9, 1), 0.35, bg)
        sun('key', (0.55, 0.55, -0.72), 3.0, 0.5)

def setup(W, H, opaque=False):
    sc = bpy.context.scene
    r = sc.render
    r.engine = 'BLENDER_EEVEE'
    r.resolution_x, r.resolution_y, r.resolution_percentage = W, H, 100
    r.film_transparent = not opaque
    r.image_settings.file_format = 'PNG'; r.image_settings.color_mode = 'RGB' if opaque else 'RGBA'
    r.image_settings.color_depth = '8'
    sc.view_settings.view_transform = 'Standard'; sc.view_settings.look = 'None'
    sc.view_settings.exposure = 0; sc.view_settings.gamma = 1
    sc.display_settings.display_device = 'sRGB'
    sc.eevee.taa_render_samples = 96
    r.filter_size = 1.2
    sc.eevee.use_shadows = True
    sc.eevee.use_raytracing = STYLE != 'toon'
    try:
        sc.eevee.use_fast_gi = True
        sc.eevee.fast_gi_method = 'AMBIENT_OCCLUSION_ONLY' if STYLE == 'clay' else 'GLOBAL_ILLUMINATION'
        sc.eevee.fast_gi_distance = 0.35
    except Exception as e:
        print('gi', e)

def proj_bbox(elev):
    e = radians(elev)
    up = Vector((0, sin(e), cos(e)))
    xs, ys = [], []
    bpy.context.view_layer.update()
    for o in bpy.context.scene.objects:
        if o.type != 'MESH':
            continue
        mw = o.matrix_world
        for v in o.data.vertices:
            p = mw @ v.co
            xs.append(p.x); ys.append(p.dot(up))
    return min(xs), max(xs), min(ys), max(ys)

def make_cam(elev, scale, shift=(0, 0)):
    cam = bpy.data.cameras.new('cam'); cam.type = 'ORTHO'; cam.ortho_scale = scale
    cam.clip_start = 0.1; cam.clip_end = 200
    co = bpy.data.objects.new('cam', cam); link(co)
    e = radians(elev)
    right = Vector((1, 0, 0)); up = Vector((0, sin(e), cos(e))); fwd = Vector((0, cos(e), -sin(e)))
    co.location = shift[0] * right + shift[1] * up - fwd * 30
    co.rotation_euler = (pi / 2 - e, 0, 0)
    bpy.context.scene.camera = co
    return co

def render(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)

def alpha_top(path):
    img = bpy.data.images.load(path)
    W, H = img.size
    a = np.array(img.pixels[:], dtype=np.float32).reshape(H, W, 4)[:, :, 3]
    bpy.data.images.remove(img)
    rows = np.where(a.max(axis=1) > 0.3)[0]
    return int(H - 1 - rows.max()) if len(rows) else None

INFO = {}

def sprite(key, fname, build, wl, hl, elev, anchor='center', scale=None):
    if ONLY and key not in ONLY:
        return
    clear(); build(); lights(); W, H = int(wl * 3), int(hl * 3); setup(W, H)
    sc = scale or max(wl, hl) / 100.0
    x0, x1, y0, y1 = proj_bbox(elev)
    cx = (x0 + x1) / 2; cy = (y0 + y1) / 2
    hv = sc * H / max(W, H); wv = sc * W / max(W, H)
    shift = (cx, y1 - hv / 2) if anchor == 'top' else (cx, cy)
    make_cam(elev, sc, shift)
    path = f'{OUT}/{fname}'
    render(path)
    if anchor == 'top':
        for _ in range(2):
            t = alpha_top(path)
            if t is None or t <= 0:
                break
            shift = (shift[0], shift[1] + t / (W / wv))
            for o in [o for o in bpy.data.objects if o.type == 'CAMERA']:
                bpy.data.objects.remove(o)
            make_cam(elev, sc, shift)
            render(path)
    info = dict(bbox=(x0, x1, y0, y1), shift=shift, scale=sc, W=W, H=H)
    INFO[key] = info
    print(f'[{STYLE}] {key}: bbox {(x1 - x0) * 100:.1f}x{(y1 - y0) * 100:.1f} in frame {wv * 100:.0f}x{hv * 100:.0f}')
    return info

def sprites():
    sprite('plane_blue', 'plane_blue.png', lambda: b_plane('blue'), 60, 40, 15)
    sprite('plane_pink', 'plane_pink.png', lambda: b_plane('pink'), 60, 40, 15)
    sprite('pencil', 'pencil.png', lambda: b_pencil(5.98), 56, 600, 0, anchor='top')
    info = sprite('skillet', 'skillet.png', b_skillet, 260, 90, 20)
    if info:
        sc = info['scale']; W = info['W']; H = info['H']
        up = Vector((0, sin(radians(20)), cos(radians(20))))
        P = Vector((0, 0, 0.03))
        ax = 0.5 + (P.x - info['shift'][0]) / sc
        ay = 0.5 - (P.dot(up) - info['shift'][1]) / (sc * H / max(W, H))
        print(f'[{STYLE}] skillet anchor ax={ax:.4f} ay={ay:.4f}')
        if STYLE == 'clay':
            mp = f'{ROOT}/assets/manifest.json'
            m = json.load(open(mp))
            m['sprites']['skillet']['ax'] = round(ax, 4); m['sprites']['skillet']['ay'] = round(ay, 4)
            json.dump(m, open(mp, 'w'), indent=2)
    sprite('pancake', 'pancake.png', lambda: b_pancake(hh=0.065, k=1.2), 140, 40, 9)
    sprite('plate', 'plate.png', b_plate, 240, 50, 10)
    sprite('butter', 'butter.png', b_butter, 36, 24, 25)
    sprite('ball', 'ball.png', b_ball, 96, 96, 0)

def flip():
    for i in range(36):
        if ONLY and str(i) not in ONLY and 'flip' not in ONLY:
            continue
        clear(); r = b_pancake(); lights(); setup(390, 390)
        r.rotation_euler = (0, radians(i * 10), 0)
        make_cam(20, 1.3, (0, 0))
        render(f'{OUT}/flip/pancake_{i:02d}.png')
    print(f'[{STYLE}] flip done')

def compose(items):
    for fn, loc, rot in items:
        r = fn(); r.location = loc; r.rotation_euler = tuple(radians(a) for a in rot)

def thumbs():
    def T(key, fname, items, elev, scale, shift=(0, 0)):
        if ONLY and key not in ONLY:
            return
        clear(); compose(items); lights(); setup(600, 400)
        make_cam(elev, scale, shift)
        render(f'{OUT}/{fname}')
        print(f'[{STYLE}] {key}')
    T('thumb_plane', 'thumb_plane.png', [
        (lambda: b_pencil(2.6), (0.10, 0, 0.27), (0, 180, 0)),
        (lambda: b_pencil(2.6), (0.10, 0, -0.27), (0, 0, 0)),
        (lambda: b_plane('blue'), (0.10, -0.40, 0.0), (0, 0, 0)),
    ], 12, 1.8, (0.10, 0.0))
    T('thumb_flip', 'thumb_flip.png', [
        (b_skillet, (0.15, 0, -0.55), (0, 0, 0)),
        (b_pancake, (0.15, 0, 0.45), (0, 140, 0)),
    ], 20, 2.9, (0.0, 0.0))
    T('thumb_stack', 'thumb_stack.png', [
        (lambda: b_stack(6), (0, 0, -0.38), (0, 0, 0)),
    ], 15, 2.5, (0, 0.0))
    T('thumb_keepup', 'thumb_keepup.png', [
        (b_ball, (0, 0, 0), (0, 0, 0)),
    ], 0, 1.7, (0, 0))

def hero():
    if ONLY and 'hero' not in ONLY:
        return
    clear()
    compose([
        (b_skillet, (-0.45, 0, 0.30), (0, 0, 0)),
        (b_pancake, (-0.45, 0, 1.75), (0, 130, 0)),
        (lambda: b_pencil(1.3), (1.55, 0, 1.85), (0, 180, 0)),
        (lambda: b_pencil(1.3), (1.55, 0, 0.55), (0, 0, 0)),
        (lambda: b_plane('pink'), (1.30, -0.05, 1.20), (0, 0, 0)),
        (lambda: b_stack(5), (-0.9, 0, -1.95), (0, 0, 0)),
        (b_ball, (1.45, 0, -1.45), (0, 0, 0)),
    ])
    bgc = {'clay': (0.93, 0.89, 0.84), 'gloss': (0.80, 0.82, 0.92), 'toon': (0.97, 0.93, 0.85)}[STYLE]
    bgc = (lin(bgc[0]), lin(bgc[1]), lin(bgc[2]), 1)
    lights(bg=bgc); setup(1080, 1080, opaque=True)
    make_cam(15, 4.7, (0, 0.0))
    render(f'{ROOT}/assets/hero_{STYLE}.png')
    print(f'[{STYLE}] hero')

# ================================================================ puzzle blocks / power-up icons / thumb_blocks
BLOCK_HEX = {
    'red': '#EE3B3B', 'orange': '#FF8A1F', 'yellow': '#FFD21F', 'green': '#4CCB3A',
    'teal': '#16C3BE', 'blue': '#2F6FEA', 'purple': '#9047E3', 'pink': '#FF6FB5', 'junk': '#8E929C',
}
HALF = 0.13   # body half-size: 27 logical body + 2x2 outline + 1 margin each side = 32 frame
CRACK = None

def crack_mat():
    global CRACK
    if CRACK:
        return CRACK
    m = bpy.data.materials.new('crack'); m.use_nodes = True; m.use_fake_user = True
    nt = m.node_tree; nt.nodes.clear()
    out = nd(nt, 'ShaderNodeOutputMaterial'); em = nd(nt, 'ShaderNodeEmission')
    em.inputs['Color'].default_value = (lin(0.17), lin(0.15), lin(0.22), 1)
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    CRACK = m
    return m

def soften(o):
    """smooth bevels, flat big faces (keeps the toon bands clean across a face)."""
    bm = bmesh.new(); bm.from_mesh(o.data)
    def flat(f):
        a = f.calc_area(); n = f.normal
        return (a > 0.002 and max(abs(n.x), abs(n.y), abs(n.z)) > 0.999) or a > 0.012
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        if len(e.link_faces) == 2:
            e.smooth = not any(flat(f) for f in e.link_faces)
        else:
            e.smooth = False
    bm.to_mesh(o.data); bm.free()

def rbox(name, sx, sy, sz, bevel, seg, mat):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= sx; v.co.y *= sy; v.co.z *= sz
    o = mesh_obj(name, bm, [mat], smooth=False)
    bv = o.modifiers.new('b', 'BEVEL'); bv.width = bevel; bv.segments = seg; bv.limit_method = 'ANGLE'; bv.profile = 0.5
    bake(o)
    return o

def chip(o, loc, rot, size):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co *= size; v.co.y *= 6
    c = bpy.data.objects.new('cutter', bpy.data.meshes.new('cutter')); bm.to_mesh(c.data); bm.free(); link(c)
    c.location = loc; c.rotation_euler = tuple(radians(a) for a in rot)
    b = o.modifiers.new('chip', 'BOOLEAN'); b.operation = 'DIFFERENCE'; b.object = c; b.solver = 'EXACT'
    bake(o)
    bpy.data.objects.remove(c)

def strip(name, pts, w, y, taper=True):
    """flat dark crack ribbon on a front face (x,z points) at depth y"""
    bm = bmesh.new()
    n = len(pts)
    L, R = [], []
    for i, (x, z) in enumerate(pts):
        a = pts[max(i - 1, 0)]; b = pts[min(i + 1, n - 1)]
        dx, dz = b[0] - a[0], b[1] - a[1]
        l = math.hypot(dx, dz) or 1
        nx, nz = -dz / l, dx / l
        k = 1.0
        if taper:
            t = i / (n - 1); k = 0.45 + 1.1 * (1 - abs(2 * t - 1)) * 0.6
        L.append(bm.verts.new((x + nx * w * k / 2, y, z + nz * w * k / 2)))
        R.append(bm.verts.new((x - nx * w * k / 2, y, z - nz * w * k / 2)))
    for i in range(n - 1):
        bm.faces.new((L[i], R[i], R[i + 1], L[i + 1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        if f.normal.y > 0:
            f.normal_flip()
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free(); me.materials.append(crack_mat())
    o = bpy.data.objects.new(name, me); link(o); return o

def b_block(col, size=HALF):
    m = mat('blk_' + col, BLOCK_HEX[col], shine=(0 if col == 'junk' else 1))
    o = rbox('block', 2 * size, 2 * size, 2 * size, 0.055 * size / HALF, 6, m)
    objs = []
    if col == 'junk':
        chip(o, (size * 0.98, 0, size * 0.98), (10, 35, 0), 0.11 * size / HALF)
        k = size / HALF
        objs.append(strip('c1', [(-0.035 * k, 0.088 * k), (-0.012 * k, 0.045 * k), (-0.052 * k, 0.005 * k), (-0.02 * k, -0.04 * k), (-0.058 * k, -0.088 * k)], 0.015 * k, -size - 0.001))
        objs.append(strip('c2', [(0.088 * k, -0.01 * k), (0.052 * k, -0.03 * k), (0.066 * k, -0.062 * k)], 0.013 * k, -size - 0.001))
        objs.append(strip('c3', [(-0.052 * k, 0.005 * k), (-0.088 * k, 0.018 * k)], 0.012 * k, -size - 0.001))
    soften(o); add_outline(o)
    r = empty('block'); adopt(r, [o] + objs); return r

def blk_render(col):
    key = 'block_' + col
    if ONLY and key not in ONLY:
        return
    clear(); b_block(col); lights(); setup(96, 96)
    make_cam(0, 0.32, (0, 0))
    render(f'{OUT}/{key}.png'); print(f'[{STYLE}] {key}')

def blocks():
    for c in BLOCK_HEX:
        blk_render(c)

# ---------------------------------------------------------------- icon models
def tube(name, pts, r, mat_, seg=10):
    bm = bmesh.new(); rings = []
    P = [Vector(p) for p in pts]
    for i, p in enumerate(P):
        t = (P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]).normalized()
        a = Vector((0, 1, 0)); nrm = t.cross(a).normalized(); bn = t.cross(nrm).normalized()
        rr = r[i] if isinstance(r, (list, tuple)) else r
        rings.append([bm.verts.new(p + (nrm * cos(2 * pi * k / seg) + bn * sin(2 * pi * k / seg)) * rr) for k in range(seg)])
    for i in range(len(P) - 1):
        for k in range(seg):
            bm.faces.new((rings[i][k], rings[i][(k + 1) % seg], rings[i + 1][(k + 1) % seg], rings[i + 1][k]))
    for ring in (rings[0], rings[-1]):
        bm.faces.new(ring)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mesh_obj(name, bm, [mat_], smooth=True, sharp=50)

def prism(name, pts, depth, mat_, bevel=0.0, seg=3):
    bm = bmesh.new()
    a = [bm.verts.new((x, -depth / 2, z)) for x, z in pts]
    b = [bm.verts.new((x, depth / 2, z)) for x, z in pts]
    n = len(pts)
    bm.faces.new(a[::-1]); bm.faces.new(b)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((a[i], a[j], b[j], b[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = mesh_obj(name, bm, [mat_], smooth=False)
    if bevel:
        bv = o.modifiers.new('b', 'BEVEL'); bv.width = bevel; bv.segments = seg; bv.limit_method = 'ANGLE'; bv.profile = 0.5
        bake(o)
    return o

def star(name, n, r1, r2, depth, mat_, rot=0):
    pts = [((r1 if i % 2 == 0 else r2) * cos(rot + pi * i / n), (r1 if i % 2 == 0 else r2) * sin(rot + pi * i / n)) for i in range(2 * n)]
    return prism(name, pts, depth, mat_)

def IM(k):
    t = {
        'bomb': ('#34344A', {'shine': 1}), 'collar': ('#B9BFCC', {'metal': True, 'shine': 1}),
        'fuse': ('#C99A5B', {}), 'spark_o': ('#FF7A1A', {}), 'spark_y': ('#FFE23A', {}), 'spark_w': ('#FFFBE0', {}),
        'wood': ('#B7773D', {'shine': 1}), 'brass': ('#EAB84A', {'shine': 1}), 'glass': ('#B9E6FA', {'shine': 1}),
        'sand': ('#FFC83D', {}), 'stone': ('#8E929C', {}), 'bolt': ('#FFD21F', {'shine': 1}),
        'frame': ('#F4B93A', {'shine': 1}), 'mirror': ('#9FDBFF', {'shine': 1}), 'mshine': ('#F2FBFF', {}),
    }[k]
    return mat('i_' + k, t[0], **t[1])

def b_bomb():
    r = 0.185
    bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=24, radius=r)
    body = mesh_obj('bomb', bm, [IM('bomb')], smooth=True, sharp=60); add_outline(body)
    body.location = (0, 0, -0.04)
    col = lathe('collar', [(0.062, 0.0), (0.075, 0.012), (0.075, 0.05), (0.06, 0.06), (0.05, 0.062)], [0, 0, 0, 0], seg=32, mats=[IM('collar')], smooth=True, sharp=50)
    col.location = (0, 0, 0.115)
    add_outline(col)
    fz = 0.175
    fuse = tube('fuse', [(0, 0, fz), (0.01, 0, fz + 0.04), (0.045, 0, fz + 0.075), (0.095, 0, fz + 0.085)], 0.024, IM('fuse'))
    add_outline(fuse)
    sp1 = star('s1', 5, 0.105, 0.048, 0.03, IM('spark_o'), rot=radians(18)); sp1.location = (0.115, -0.02, fz + 0.095)
    sp2 = star('s2', 5, 0.065, 0.03, 0.03, IM('spark_y'), rot=radians(54)); sp2.location = (0.115, -0.045, fz + 0.095)
    sp3 = star('s3', 4, 0.032, 0.016, 0.02, IM('spark_w'), rot=0); sp3.location = (0.115, -0.065, fz + 0.095)
    add_outline(sp1)
    r_ = empty('bomb'); adopt(r_, [body, col, fuse, sp1, sp2, sp3])
    return r_

def b_slow():
    wood = IM('wood'); brass = IM('brass')
    capH = 0.04
    def cap(z):
        c = rbox('cap', 0.36, 0.30, capH, 0.016, 4, brass)
        c.location = (0, 0, z); soften(c); add_outline(c); return c
    top = cap(0.215); bot = cap(-0.215)
    # glass: two bulbs
    gp = [(0.001, -0.185), (0.06, -0.185), (0.125, -0.165), (0.15, -0.12), (0.145, -0.07), (0.11, -0.03), (0.05, -0.008), (0.022, 0.0),
          (0.05, 0.008), (0.11, 0.03), (0.145, 0.07), (0.15, 0.12), (0.125, 0.165), (0.06, 0.185), (0.001, 0.185)]
    glass = lathe('glass', gp, [0] * (len(gp) - 1), seg=48, mats=[IM('glass')], smooth=True, sharp=70)
    add_outline(glass)
    def sandlathe(prof):
        s = lathe('sand', prof, [0] * (len(prof) - 1), seg=40, mats=[IM('sand')], smooth=True, sharp=40); return s
    d = 0.008
    top_sand = sandlathe([(0.001, 0.045), (0.08, 0.03), (0.122, 0.05 - 0.0), (0.145 + d, 0.07), (0.15 + d, 0.105), (0.15 + d, 0.115), (0.001, 0.115)][:0] or
                         [(0.001, 0.04), (0.052 + d, 0.012), (0.11 + d, 0.034), (0.145 + d, 0.07), (0.15 + d, 0.10), (0.001, 0.10)])
    bot_sand = sandlathe([(0.001, -0.176), (0.09, -0.176), (0.128, -0.162), (0.146 + d, -0.125), (0.14 + d, -0.1), (0.08, -0.075), (0.03, -0.04), (0.001, -0.032)])
    stream = tube('stream', [(0, 0, 0.02), (0, 0, -0.06)], 0.014, IM('sand'), seg=8)
    posts = []
    for sx in (-0.145, 0.145):
        p = tube('post', [(sx, 0.0, -0.2), (sx, 0.0, 0.2)], 0.028, wood, seg=12)
        # slight forward offset so posts sit beside the glass
        add_outline(p); posts.append(p)
    r_ = empty('slow'); adopt(r_, [top, bot, glass, top_sand, bot_sand, stream] + posts)
    return r_

def b_stone(sx=0.40, sy=0.24, sz=0.22, cracks=True):
    o = rbox('brick', sx, sy, sz, 0.042, 5, IM('stone'))
    chip(o, (sx / 2 - 0.005, sy * 0.2, sz / 2 - 0.005), (10, 35, 12), 0.115)
    soften(o); add_outline(o)
    objs = [o]
    if cracks:
        yf = -sy / 2 - 0.001
        objs.append(strip('c1', [(-0.06, 0.07), (-0.035, 0.03), (-0.085, -0.005), (-0.05, -0.05), (-0.09, -0.09)], 0.016, yf))
        objs.append(strip('c2', [(0.10, -0.01), (0.06, -0.035), (0.08, -0.07)], 0.014, yf))
        objs.append(strip('c3', [(-0.085, -0.005), (-0.15, 0.02)], 0.012, yf))
    r_ = empty('stone'); adopt(r_, objs)
    return r_

def b_rush():
    pts = [(-0.05, 0.22), (0.14, 0.22), (0.07, 0.06), (0.16, 0.06), (-0.09, -0.23), (-0.02, -0.06), (-0.14, -0.06)]
    o = prism('bolt', pts, 0.09, IM('bolt'), bevel=0.016, seg=3)
    soften(o); add_outline(o)
    r_ = empty('rush'); adopt(r_, [o]); return r_

def b_mirror():
    R = 0.165
    # lathe axis = z; rotate to face -y afterwards
    fr = lathe('frame', [(0.001, -0.03), (R - 0.02, -0.03), (R, -0.012), (R, 0.02), (R - 0.02, 0.038), (R - 0.045, 0.038), (R - 0.05, 0.02), (0.001, 0.02)],
               [0] * 7, seg=56, mats=[IM('frame')], smooth=True, sharp=50)
    gl = lathe('mglass', [(0.001, 0.027), (R - 0.047, 0.027), (R - 0.047, 0.021), (0.001, 0.021)][:2], [0], seg=56, mats=[IM('mirror')], smooth=True, sharp=50)
    for o in (fr, gl):
        o.rotation_euler = (radians(90), 0, 0)
        o.data.transform(Matrix.Identity(4))
    fr.location = (0, 0, 0.075); gl.location = (0, 0, 0.075)
    # rotating a lathe by +90 about X sends +z to -y (toward camera)
    add_outline(fr)
    h = tube('handle', [(0, 0.0, 0.075 - R + 0.01), (0, 0.0, -0.17)], [0.034, 0.042], IM('frame'), seg=14); add_outline(h)
    bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=12, radius=0.058)
    pom = mesh_obj('pom', bm, [IM('frame')], smooth=True, sharp=60); pom.location = (0, 0, -0.18); add_outline(pom)
    # shine streaks
    sh1 = prism('sh1', [(-0.07, 0.07), (-0.045, 0.1), (0.0, 0.145), (-0.012, 0.15), (-0.085, 0.085)], 0.004, IM('mshine'))
    sh1.location = (0, -0.0345, 0.075 + 0.0)
    sh1.rotation_euler = (0, 0, 0)
    r_ = empty('mirror'); adopt(r_, [fr, gl, h, pom, sh1])
    r_.rotation_euler = (0, radians(-14), 0)
    return r_

def finish_icon(builder, yaw):
    r_ = builder(); r_.rotation_euler = (r_.rotation_euler[0], r_.rotation_euler[1], radians(yaw)); return r_

def icon_render(key, builder, yaw, elev=22, pad=0.05):
    if ONLY and key not in ONLY:
        return
    clear(); finish_icon(builder, yaw); lights(); setup(144, 144)
    x0, x1, y0, y1 = proj_bbox(elev)
    sc = max(x1 - x0, y1 - y0) + 0.04 + pad
    make_cam(elev, sc, ((x0 + x1) / 2, (y0 + y1) / 2))
    render(f'{OUT}/{key}.png'); print(f'[{STYLE}] {key} span {(x1-x0)*100:.0f}x{(y1-y0)*100:.0f} frame {sc*100:.0f}')

def icons():
    icon_render('icon_bomb', b_bomb, -20)
    icon_render('icon_slow', b_slow, -28)
    icon_render('icon_junk', b_stone, -30)
    icon_render('icon_rush', b_rush, -16)
    icon_render('icon_mirror', b_mirror, -20)

def b_piece(kind, col):
    cells = {'T': [(0, 0), (1, 0), (2, 0), (1, 1)], 'L': [(0, 0), (0, 1), (0, 2), (1, 0)], 'I': [(0, 0), (1, 0), (2, 0), (3, 0)],
             'S': [(0, 0), (1, 0), (1, 1), (2, 1)], 'O': [(0, 0), (1, 0), (0, 1), (1, 1)], 'J': [(1, 0), (1, 1), (1, 2), (0, 0)]}[kind]
    sp = 0.31
    r_ = empty('piece')
    cx = sum(c[0] for c in cells) / len(cells); cz = sum(c[1] for c in cells) / len(cells)
    for (i, j) in cells:
        b = b_block(col); b.parent = r_; b.location = ((i - cx) * sp, 0, (j - cz) * sp)
    return r_

def thumb_blocks():
    if ONLY and 'thumb_blocks' not in ONLY:
        return
    clear()
    sp = 0.31
    def at(fn, x, z, rot=0, sc=1.0, y=0.0):
        r_ = fn(); r_.location = (x, y, z); r_.rotation_euler = (0, radians(rot), 0); r_.scale = (sc, sc, sc); return r_
    # stack: columns -3..3, partial rows
    rows = [
        ['red', 'orange', 'yellow', 'junk', 'green', 'teal', 'blue'],
        ['purple', 'pink', 'junk', 'red', 'yellow', 'green', None],
        [None, 'teal', 'blue', 'orange', 'pink', None, None],
        [None, None, 'purple', None, None, None, None],
    ]
    base_z = -0.80
    for rj, row in enumerate(rows):
        for ci, c in enumerate(row):
            if c:
                at(lambda c=c: b_block(c), (ci - 3) * sp + 0.0, base_z + rj * sp)
    # bomb block on the stack
    at(lambda: b_block('orange'), 0 * sp + 0.0, base_z + 4 * sp) if False else None
    at(lambda: b_block('red'), 0, base_z + 3 * sp)
    at(b_bomb, 0.0, base_z + 3 * sp + 0.01, 0, 0.62, y=-0.2)
    # falling pieces
    at(lambda: b_piece('T', 'purple'), -0.95, 0.52, 12)
    at(lambda: b_piece('L', 'green'), 0.95, 0.40, -12)
    at(lambda: b_piece('O', 'yellow'), -0.02, 0.62, 7)
    at(lambda: b_piece('S', 'pink'), 1.05, -0.02, 18, 0.9) if False else None
    lights(); setup(600, 400)
    make_cam(8, 3.0, (0.0, 0.0))
    render(f'{OUT}/thumb_blocks.png'); print(f'[{STYLE}] thumb_blocks')

def sheet_test():
    clear()
    cols = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'junk', 'red', 'blue', 'yellow']
    for i, c in enumerate(cols):
        b = b_block(c); b.location = ((i % 4 - 1.5) * 0.32, 0, (1 - i // 4) * 0.32)
    lights(); setup(96 * 4, 96 * 3)
    make_cam(0, 0.32 * 4, (0, 0))
    render(f'{ROOT}/tools/art/review/blocks_sheet.png')

# ---------------------------------------------------------------- Fort Blast
L = 0.01  # one logical unit in Blender units

def F(k):
    t = {
        'wood': ('#E3A85C', {'shine': 1}), 'wood_d': ('#9A5F2E', {}), 'wood_dd': ('#6E3F1C', {}),
        'barrel': ('#3E3D50', {'shine': 1}), 'barrel_l': ('#6A6980', {'shine': 1}), 'bronze': ('#EDB44B', {'shine': 1}),
        'gold': ('#FFC72A', {'shine': 1}), 'gem_r': ('#EC3B3B', {'shine': 1}), 'gem_b': ('#2F7BE8', {'shine': 1}),
        'velvet': ('#B8284A', {}), 'cball': ('#34344A', {'shine': 1}), 'drill': ('#C6CCD6', {'shine': 1}),
        'drill_b': ('#EC3B3B', {'shine': 1}), 'fin': ('#FFC72A', {'shine': 1}),
        'moon': ('#D2CEE6', {}), 'moon_d': ('#ABA6C6', {}), 'moon_dd': ('#BEB9D8', {}),
        'pole': ('#F4EFE2', {'shine': 1}), 'f_blue': ('#2F6FEA', {'shine': 1}), 'f_pink': ('#FF6FB5', {'shine': 1}),
        'f_blue_l': ('#74A4F5', {}), 'f_pink_l': ('#FFA3D3', {}),
        'grass': ('#58CC45', {}), 'grass_l': ('#8BE46B', {}), 'grass_d': ('#3FAF3A', {}),
        'soil': ('#B97844', {}), 'soil_l': ('#CF9158', {}), 'soil_d': ('#98602F', {}),
        'hill_far': ('#A5DDC8', {}), 'hill_near': ('#7ED48C', {}), 'cloud': ('#FFFFFF', {}),
    }[k]
    return mat('f_' + k, t[0], **t[1])

def sph(name, r, loc, m, sc=(1, 1, 1), rz=0.0, outline=True, seg=40, rings=20):
    bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=r)
    R = Matrix.Rotation(rz, 3, 'Z')
    for v in bm.verts:
        v.co = R @ Vector((v.co.x * sc[0], v.co.y * sc[1], v.co.z * sc[2])) + Vector(loc)
    o = mesh_obj(name, bm, [m], smooth=True, sharp=60)
    if outline: add_outline(o)
    return o

def cyl_y(name, r, depth, loc, m, seg=48, outline=True):
    o = lathe(name, [(0, -depth / 2), (r, -depth / 2), (r, depth / 2), (0, depth / 2)], [0, 0, 0], seg=seg, mats=[m], smooth=True, sharp=40)
    o.rotation_euler = (pi / 2, 0, 0); o.location = loc
    if outline: add_outline(o)
    return o

def flat_poly(name, pts, y, m, depth=0.002):
    o = prism(name, pts, depth, m); o.location = (0, y, 0); return o

def annulus(name, r0, r1, c, y, m, seg=48):
    bm = bmesh.new()
    a = [bm.verts.new((c[0] + r0 * cos(2 * pi * i / seg), y, c[1] + r0 * sin(2 * pi * i / seg))) for i in range(seg)]
    b = [bm.verts.new((c[0] + r1 * cos(2 * pi * i / seg), y, c[1] + r1 * sin(2 * pi * i / seg))) for i in range(seg)]
    for i in range(seg):
        j = (i + 1) % seg
        bm.faces.new((a[i], a[j], b[j], b[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        if f.normal.y > 0: f.normal_flip()
    return mesh_obj(name, bm, [m], smooth=False)

def wheel(x, z, y, R=7.5):
    objs = []
    objs.append(cyl_y('disc', R * L, 2.6 * L, (x * L, y * L, z * L), F('wood')))
    yf = (y - 1.3) * L - 0.0006
    objs.append(annulus('tire', (R - 1.7) * L, (R - 0.15) * L, (x * L, z * L), yf, F('wood_d')))
    for k in range(6):
        a = radians(k * 30 + 8)
        ca, sa = cos(a), sin(a)
        hw = 0.55
        pts = []
        for (u, w) in ((1.0, -hw), ((R - 1.6), -hw), ((R - 1.6), hw), (1.0, hw)):
            pts.append((x * L + (u * ca - w * sa) * L, z * L + (u * sa + w * ca) * L))
        objs.append(flat_poly('spoke', pts, yf - 0.0006, F('wood_dd')))
        pts2 = [(x * L - (p[0] - x * L), z * L - (p[1] - z * L)) for p in pts]
        objs.append(flat_poly('spoke2', pts2, yf - 0.0006, F('wood_dd')))
    objs.append(cyl_y('hub', 2.3 * L, 3.4 * L, (x * L, (y - 0.4) * L, z * L), F('barrel_l')))
    return objs

def b_cannon_base():
    objs = []
    pts = [(-17, 6), (17, 6), (17, 14), (11, 23), (3.8, 23)]
    for i in range(1, 8):  # small semicircular notch for the barrel trunnion
        a = pi * i / 8
        pts.append((3.8 * cos(a), 23 - 3.4 * sin(a) * 1.0))
    pts += [(-3.8, 23), (-11, 23), (-17, 14)]
    pts = [pts[0], pts[1], pts[2], pts[3], pts[4]] + [(3.8 * cos(pi * i / 8) * -1 * -1, 23 - 3.2 * sin(pi * i / 8)) for i in range(1, 8)] + pts[-3:]
    body = prism('body', [(x * L, z * L) for x, z in pts], 10 * L, F('wood'), bevel=0.012, seg=3)
    add_outline(body); objs.append(body)
    # iron strap and nails (flat decals on the front face)
    yf = -5.0 * L - 0.0008
    objs.append(flat_poly('strap', [(-16.6 * L, 17.2 * L), (16.6 * L, 17.2 * L), (16.6 * L, 19.0 * L), (-16.6 * L, 19.0 * L)], yf, F('wood_dd')))
    for xx in (-13.5, 13.5):
        objs.append(sph('nail', 1.0 * L, (xx * L, yf - 0.001, 18.1 * L), F('barrel_l'), outline=False, seg=12, rings=8))
    for xx in (-10, 10):
        objs.extend(wheel(xx, 7.5, -6.8))
    return objs

def b_cannon_barrel(theta=pi / 2, pivot_local=True):
    prof = [(0, -5.5), (1.6, -5.3), (2.4, -4.5), (2.4, -3.8), (5.2, -3.6), (6.3, -2.4), (6.5, 0), (6.0, 8), (5.4, 17),
            (5.1, 24), (6.5, 24.8), (6.5, 29.6), (5.0, 29.6), (0, 29.4)]
    segm = []
    for i in range(len(prof) - 1):
        z0 = prof[i][1]
        segm.append(1 if z0 >= 24.0 or 0 <= z0 and False else 0)
    # lighter reinforcing ring near the breech and the muzzle swell
    mats = [F('barrel'), F('barrel_l')]
    o = lathe('barrel', [(r * L, z * L) for r, z in prof], segm, seg=64, mats=mats, smooth=True, sharp=40)
    add_outline(o)
    o.rotation_euler = (0, theta, 0)
    peg = cyl_y('peg', 2.2 * L, 2.0 * L, (0, -7.0 * L, 0), F('bronze'), seg=24)
    root = empty('barrel'); adopt(root, [o, peg])
    # the peg is oriented in world already; keep it unrotated by parenting then rotating root instead
    o.rotation_euler = (0, 0, 0)
    for ch in (o,):
        ch.rotation_euler = (0, pi / 2, 0)
    root.rotation_euler = (0, theta - pi / 2, 0)
    return root

def b_crown():
    R = 8.4
    objs = []
    band = lathe('band', [(0, 0), (R * L, 0), ((R + 1.0) * L, 1.0 * L), ((R + 1.0) * L, 5.0 * L), (R * L, 6.0 * L), (0, 6.0 * L)],
                 [0, 0, 0, 0, 0], seg=64, mats=[F('gold')], smooth=True, sharp=40)
    add_outline(band); objs.append(band)
    vel = lathe('velvet', [(0, 5.4 * L), ((R - 0.8) * L, 5.4 * L), ((R - 0.8) * L, 6.15 * L), (0, 6.15 * L)], [0, 0, 0], seg=48, mats=[F('velvet')])
    objs.append(vel)
    hs = [8.0, 7.5, 7.5]
    angs = [-90, 30, 150]
    tipm = [F('gold'), F('gold'), F('gold')]
    for h, a, tm in zip(hs, angs, tipm):
        ar = radians(a); px, py = (R - 2.2) * cos(ar), (R - 2.2) * sin(ar)
        sp = lathe('spike', [(0, 0), (4.0 * L, 0), (3.4 * L, 2.0 * L), (1.6 * L, (h - 1.5) * L), (0, h * L)], [0, 0, 0, 0], seg=24, mats=[F('gold')], smooth=True, sharp=50)
        sp.location = (px * L, py * L, 5.2 * L); add_outline(sp); objs.append(sp)
        objs.append(sph('tip', 2.0 * L, (px * L, py * L, (5.2 + h + 0.8) * L), tm, seg=20, rings=12))
    for a, gm, sz in ((-90, F('gem_r'), 2.6), (-90 + 40, F('gem_b'), 2.0), (-90 - 40, F('gem_b'), 2.0)):
        ar = radians(a)
        objs.append(sph('gem', sz * L, ((R + 1.0) * cos(ar) * L, (R + 1.0) * sin(ar) * L, 3.0 * L), gm, sc=(1.0, 0.45, 1.15), rz=ar + pi / 2, seg=24, rings=12))
    r_ = empty('crown'); adopt(r_, objs)
    r_.rotation_euler = (0, 0, radians(-8))
    return r_

def b_shotball(r=3.8):
    o = sph('ball', r * L, (0, 0, 0), F('cball'), seg=48, rings=24)
    return o

def twisted(name, x0, x1, R, lobes, turns, amp, m, nr=40, seg=60, taper=True, power=0.95):
    bm = bmesh.new(); rings = []
    for i in range(nr + 1):
        t = i / nr
        x = x0 + (x1 - x0) * t
        rr = R * ((1 - t) ** power if taper else 1.0)
        if i == nr: rr = 1e-5
        ring = []
        for k in range(seg):
            th = 2 * pi * k / seg
            rk = rr * (1 + amp * cos(lobes * (th - turns * 2 * pi * t)))
            ring.append(bm.verts.new((x, rk * cos(th), rk * sin(th))))
        rings.append(ring)
    for i in range(nr):
        for k in range(seg):
            j = (k + 1) % seg
            bm.faces.new((rings[i][k], rings[i][j], rings[i + 1][j], rings[i + 1][k]))
    bm.faces.new(rings[0][::-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mesh_obj(name, bm, [m], smooth=True, sharp=70)

def b_shotdrill():
    objs = []
    tip = twisted('tip', 0.5 * L, 9.0 * L, 3.4 * L, 2, 0.75, 0.22, F('drill')); add_outline(tip); objs.append(tip)
    body = lathe('body', [(0, -8.5 * L), (2.7 * L, -8.5 * L), (2.9 * L, -7.5 * L), (2.9 * L, -1.2 * L), (3.4 * L, -0.6 * L), (3.4 * L, 0.6 * L), (0, 0.6 * L)],
                 [0, 0, 0, 1, 1, 1], seg=36, mats=[F('drill_b'), F('drill')], smooth=True, sharp=40)
    body.rotation_euler = (0, pi / 2, 0); add_outline(body); objs.append(body)
    for sgn in (1, -1):
        fin = prism('fin', [(-2.5 * L, sgn * 2.4 * L), (-8.2 * L, sgn * 3.9 * L), (-9.4 * L, sgn * 3.9 * L), (-9.4 * L, sgn * 2.4 * L)], 0.9 * L, F('fin'), bevel=0.003, seg=2)
        add_outline(fin); objs.append(fin)
    r_ = empty('drill'); adopt(r_, objs)
    return r_

CRATERS = [(-0.34, 0.30, 0.20), (0.30, 0.38, 0.13), (0.12, -0.18, 0.16), (-0.42, -0.30, 0.11), (0.45, -0.28, 0.10), (-0.02, 0.62, 0.08)]

def b_moon(R=29.5 * L):
    objs = [sph('moon', R, (0, 0, 0), F('moon'), seg=96, rings=48)]
    for (u, v, rf) in CRATERS:
        n = Vector((u, -math.sqrt(max(1 - u * u - v * v, 0.01)), v)).normalized()
        for (k, rr, off, mm) in ((0, rf, 0.004, 'moon_d'), (1, rf * 0.62, 0.007, 'moon_dd')):
            c = lathe('crater', [(0, 0), (rr * R, 0), (rr * R, 0.4 * L), (0, 0.4 * L)], [0, 0, 0], seg=40, mats=[F(mm)], smooth=False)
            c.rotation_mode = 'QUATERNION'; c.rotation_quaternion = n.to_track_quat('Z', 'Y')
            # place so the whole disc clears the surface
            d = R * math.sqrt(max(1 - rr * rr, 0.0)) + (off * R * 0.5)
            c.location = n * (R * (1 + off * 0.5)) if False else n * (R * math.cos(math.asin(min(rr, 0.95))) + 0.0003 + off * R * 0.2)
            objs.append(c)
    r_ = empty('moon'); adopt(r_, objs); return r_

def b_flag(col):
    objs = []
    pole = lathe('pole', [(0, 0), (0.8 * L, 0), (0.8 * L, 19 * L), (0, 19 * L)], [0, 0, 0], seg=16, mats=[F('pole')], smooth=True, sharp=40)
    pole.location = (0, -0.6 * L, 0); add_outline(pole); objs.append(pole)
    objs.append(sph('knob', 1.7 * L, (0, -0.6 * L, 19.6 * L), F('gold'), seg=20, rings=12))
    pts_t, pts_b = [], []
    n = 16
    for i in range(n + 1):
        x = 0.6 + 10.0 * i / n
        c = 13.4 + 1.3 * sin(0.62 * x + 0.2) - 0.18 * x
        h = 4.6 * (1 - i / n) ** 0.85 + 0.35
        pts_t.append((x * L, (c + h) * L)); pts_b.append((x * L, (c - h) * L))
    poly = pts_t + pts_b[::-1]
    cloth = prism('cloth', poly, 0.9 * L, F('f_' + col), bevel=0.003, seg=2)
    add_outline(cloth); objs.append(cloth)
    # lighter stripe decal along the cloth centre line
    st = []
    for i in range(3, n - 3):
        pass
    r_ = empty('flag'); adopt(r_, objs); return r_

def fort_sprite(key, build, wl, hl, elev=0, mode='fit', c=(0, 0), margin=1.0):
    if ONLY and key not in ONLY:
        return
    clear(); build(); lights(); W, H = int(wl * 3), int(hl * 3); setup(W, H)
    mx = max(W, H)
    if mode == 'fit':
        x0, x1, y0, y1 = proj_bbox(elev)
        w = x1 - x0 + 0.04; h = y1 - y0 + 0.04; m = margin * L
        sc = max((w + 2 * m) * mx / W, (h + 2 * m) * mx / H)
        c = ((x0 + x1) / 2, (y0 + y1) / 2)
    else:
        sc = max(wl, hl) * L
    make_cam(elev, sc, c)
    render(f'{OUT}/{key}.png'); print(f'[{STYLE}] {key}')

def fort_sprites():
    # base: wheels touch the bottom edge (frame bottom = wheel bottom - outline), centred on x
    fort_sprite('cannon_base', b_cannon_base, 40, 28, mode='exact', c=(0, -0.02 + 0.14))
    # barrel: pivot (trunnion) at 20% from the left, vertically centred
    fort_sprite('cannon_barrel', b_cannon_barrel, 40, 18, mode='exact', c=(0.12, 0.0))
    fort_sprite('crown', b_crown, 26, 20, elev=24)
    fort_sprite('shot_ball', b_shotball, 12, 12, margin=0.6)
    fort_sprite('shot_drill', b_shotdrill, 22, 12, margin=0.6)
    fort_sprite('moon', b_moon, 64, 64, mode='exact', c=(0, 0))
    fort_sprite('flag_blue', lambda: b_flag('blue'), 16, 24, mode='exact', c=(0.048, -0.02 + 0.12))
    fort_sprite('flag_pink', lambda: b_flag('pink'), 16, 24, mode='exact', c=(0.048, -0.02 + 0.12))

# ---- background ---------------------------------------------------------
def bgplane(name, x0, x1, z0, z1, y, m):
    bm = bmesh.new()
    vs = [bm.verts.new(p) for p in ((x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1))]
    bm.faces.new(vs)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        if f.normal.y > 0: f.normal_flip()
    return mesh_obj(name, bm, [m], smooth=False)

def sky_mat():
    m = bpy.data.materials.new('sky'); m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    out = nd(nt, 'ShaderNodeOutputMaterial'); em = nd(nt, 'ShaderNodeEmission')
    tc = nd(nt, 'ShaderNodeTexCoord'); sep = nd(nt, 'ShaderNodeSeparateXYZ')
    nt.links.new(tc.outputs['Generated'], sep.inputs[0])
    def c(h):
        h = h.lstrip('#'); return tuple(lin(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4)) + (1,)
    col = ramp_fac(nt, sep.outputs['Z'], [(0.0, c('#D5F3FF')), (0.14, c('#BFEAFF')), (0.55, c('#7CCBF7')), (1.0, c('#3B9EEE'))])
    nt.links.new(col, em.inputs['Color']); nt.links.new(em.outputs[0], out.inputs['Surface'])
    return m

def b_bg():
    GY = 0.80  # outline top = logical y 560 (up = 640-560 = 80 px/100)
    X0, X1 = -0.3, 3.9
    bgplane('sky', X0, X1, 0.0, 6.5, 3.0, sky_mat())
    # sun
    sph('sun', 0.17, (0.62, 2.0, 5.75), mat('f_sun', '#FFE066', shine=0), sc=(1, 0.3, 1), seg=48, rings=24)
    # clouds: flattened spheres at one depth so outlines merge
    def cloud(cx, cz, k=1.0):
        for dx, dz, r in ((-0.26, -0.02, 0.10), (-0.12, 0.05, 0.15), (0.05, 0.09, 0.19), (0.24, 0.02, 0.15), (0.38, -0.03, 0.10), (0.05, -0.06, 0.13)):
            sph('c', r * k, (cx + dx * k, 1.6, cz + dz * k), F('cloud'), sc=(1, 0.35, 0.92), seg=36, rings=18)
    cloud(0.45, 5.15, 1.0)
    cloud(3.12, 4.55, 0.85)
    cloud(0.42, 3.05, 0.7)
    cloud(1.95, 5.95, 0.6)
    cloud(3.25, 3.15, 0.55)
    # hills
    for x, rx, rz, y in ((0.35, 1.2, 0.46, 1.2), (2.0, 1.1, 0.34, 1.2), (3.5, 1.1, 0.5, 1.2)):
        sph('hf', 1.0, (x, y, GY - 0.12), F('hill_far'), sc=(rx, 0.2, rz), seg=64, rings=32)
    for x, rx, rz, y in ((1.15, 0.95, 0.28, 0.8), (2.85, 1.0, 0.26, 0.8), (-0.1, 0.85, 0.22, 0.8)):
        sph('hn', 1.0, (x, y, GY - 0.1), F('hill_near'), sc=(rx, 0.2, rz), seg=64, rings=32)
    # ground: grass plane in front, dark outline plane behind it, soil behind that (all flat)
    ot = 0.02
    bgplane('soil', X0, X1, -0.2, GY - 0.22, 0.02, F('soil'))
    bgplane('grass_ol', X0, X1, GY - 0.22 - ot, GY, 0.01, outline_mat())
    bgplane('grass', X0, X1, GY - 0.22, GY - ot, 0.0, F('grass'))
    bgplane('grass_hi', X0, X1, GY - 0.07, GY - ot, -0.001, F('grass_l'))
    bgplane('grass_lo', X0, X1, GY - 0.22, GY - 0.19, -0.001, F('grass_d'))
    # soil pebbles / stripes
    import random
    rnd = random.Random(4)
    for i in range(16):
        x = rnd.uniform(0.0, 3.6); z = rnd.uniform(-0.05, GY - 0.32)
        s = rnd.uniform(0.035, 0.06)
        sph('peb', s, (x, 0.0, z), F('soil_l' if i % 2 else 'soil_d'), sc=(1.4, 0.2, 0.8), outline=False, seg=20, rings=10)
    for i in range(7):
        x = rnd.uniform(0.1, 3.5); z = GY - 0.30 - 0.02 * (i % 3)
        bgplane('st', x, x + rnd.uniform(0.15, 0.3), z, z + 0.018, 0.0, F('soil_d'))

def bg_render():
    if ONLY and 'bg_fort' not in ONLY:
        return
    clear(); b_bg(); lights(); setup(1080, 1920, opaque=True)
    make_cam(0, 6.4, (1.8, 3.2))
    render(f'{OUT}/bg_fort.png'); print(f'[{STYLE}] bg_fort')

# ---- thumbnail ----------------------------------------------------------
def thumb_fort():
    if ONLY and 'thumb_fort' not in ONLY:
        return
    clear()
    sp = 0.31
    def fort(cx, cols, flag, side):
        zb = -0.80
        rows = [[cols[0], cols[1], cols[0], cols[2]], [cols[2], None, None, cols[1]], [cols[1], cols[0], cols[2], cols[0]]]
        if side > 0: rows = [r[::-1] for r in rows]
        for rj, row in enumerate(rows):
            for ci, c in enumerate(row):
                if c:
                    b = b_block(c); b.location = (cx + (ci - 1.5) * sp, 0, zb + rj * sp)
        outer = -1.5 if side < 0 else 1.5
        b = b_block(cols[0]); b.location = (cx + outer * sp, 0, zb + 3 * sp)
        fl = b_flag(flag); fl.location = (cx + outer * sp - 0.032 * (1 if side < 0 else -1) * 0 , -0.02, zb + 3 * sp + 0.13)
        if side > 0: fl.scale = (1, 1, 1)
        crown = b_crown(); crown.scale = (1.25, 1.25, 1.25)
        crown.location = (cx, -0.02, zb + 1 * sp - 0.13 + 0.015)
        top = zb + 2 * sp + 0.13
        cb = b_cannon_base(); rb = empty('cb'); adopt(rb, cb); rb.location = (cx - side * 0.17, 0, top)
        pv = empty('pv'); pv.location = (cx - side * 0.17, -0.0, top + 0.225)
        br = b_cannon_barrel(theta=radians(60) if side < 0 else radians(-60)); br.location = pv.location
        br.scale = (1, 1, 1)
    fort(-1.0, ['blue', 'teal', 'purple'], 'blue', -1)
    fort(1.0, ['pink', 'orange', 'red'], 'pink', 1)
    m = b_moon(0.27); m.location = (0.0, 0.45, 0.12)
    ball = b_shotball(0.05); ball.location = (-0.36, -0.1, 0.5)
    lights(); setup(600, 400)
    make_cam(8, 3.4, (0.0, 0.0))
    render(f'{OUT}/thumb_fort.png'); print(f'[{STYLE}] thumb_fort')


if __name__ == '__main__':
    T = TARGETS
    if 'all' in T:
        T = ['hero', 'sprites', 'flip', 'thumbs']
    if 'hero' in T: hero()
    if 'sprites' in T: sprites()
    if 'flip' in T: flip()
    if 'thumbs' in T: thumbs()
    if 'blocks' in T: blocks()
    if 'icons' in T: icons()
    if 'thumb_blocks' in T: thumb_blocks()
    if 'sheet' in T: sheet_test()
    if 'fort' in T:
        fort_sprites(); bg_render(); thumb_fort()
