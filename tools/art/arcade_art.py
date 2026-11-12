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

if __name__ == '__main__':
    T = TARGETS
    if 'all' in T:
        T = ['hero', 'sprites', 'flip', 'thumbs']
    if 'hero' in T: hero()
    if 'sprites' in T: sprites()
    if 'flip' in T: flip()
    if 'thumbs' in T: thumbs()
