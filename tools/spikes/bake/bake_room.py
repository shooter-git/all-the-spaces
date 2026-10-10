"""Spike S3: how long does a CPU-only lightmap bake take for one typical room?

Builds a furnished 5 x 4 m room with a window and a doorway (closed door, as the privacy design
requires), joins the static geometry, packs a lightmap UV atlas and bakes diffuse lighting
(direct + indirect) with Cycles on the CPU.

    blender -b -t 4 --python tools/spikes/bake/bake_room.py -- --size 1024 --samples 128 --out /tmp/x.png
"""

import argparse
import sys
import time

import bpy


def args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--size", type=int, default=1024)
    p.add_argument("--samples", type=int, default=128)
    p.add_argument("--out", default="/tmp/lightmap.png")
    p.add_argument("--detail", type=int, default=0, help="extra high-poly props (~4k triangles each)")
    return p.parse_args(argv)


def box(name, loc, size):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    o = bpy.context.object
    o.name = name
    o.scale = (size[0] / 2, size[1] / 2, size[2] / 2)
    bpy.ops.object.transform_apply(scale=True)
    return o


def cylinder(name, loc, r, h, verts=24):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=h, location=loc)
    o = bpy.context.object
    o.name = name
    return o


def build_room(detail=0):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    W, D, H, T = 5.0, 4.0, 2.7, 0.15
    parts = [
        box("floor", (0, 0, -T / 2), (W, D, T)),
        box("ceiling", (0, 0, H + T / 2), (W, D, T)),
        box("wall_n", (0, D / 2 + T / 2, H / 2), (W, T, H)),
        box("wall_e", (W / 2 + T / 2, 0, H / 2), (T, D, H)),
        box("wall_w", (-W / 2 - T / 2, 0, H / 2), (T, D, H)),
        # South wall with a window (two pieces around a 1.6 x 1.2 m opening) and a closed door.
        box("wall_s_left", (-1.7, -D / 2 - T / 2, H / 2), (1.6, T, H)),
        box("wall_s_right", (1.7, -D / 2 - T / 2, H / 2), (1.6, T, H)),
        box("wall_s_below", (0, -D / 2 - T / 2, 0.45), (1.8, T, 0.9)),
        box("wall_s_above", (0, -D / 2 - T / 2, 2.4), (1.8, T, 0.6)),
        box("door_closed", (W / 2 + T / 2 - 0.01, -1.2, 1.0), (T, 0.9, 2.0)),
        # Furniture: sofa, table, shelves, bed-sized block, chairs, lamp, books.
        box("sofa_base", (-1.2, 1.4, 0.25), (2.0, 0.9, 0.5)),
        box("sofa_back", (-1.2, 1.8, 0.6), (2.0, 0.2, 0.7)),
        box("table", (-1.2, 0.2, 0.4), (1.2, 0.6, 0.05)),
        box("shelf", (2.2, 1.0, 1.0), (0.4, 1.6, 2.0)),
        box("desk", (1.4, -1.4, 0.75), (1.4, 0.7, 0.05)),
        cylinder("lamp_pole", (-2.2, -1.5, 0.8), 0.03, 1.6),
        cylinder("lamp_shade", (-2.2, -1.5, 1.65), 0.2, 0.3, 32),
    ]
    for i in range(4):
        parts.append(box(f"chair_{i}", (-1.8 + i * 0.4, -0.5, 0.45), (0.4, 0.4, 0.9)))
    for i in range(24):
        parts.append(box(f"book_{i}", (2.2, 0.3 + i * 0.06, 1.3 + (i % 3) * 0.35), (0.25, 0.04, 0.3)))

    # Stand-ins for detailed furniture models (plants, vases, cushions, ornaments).
    for i in range(detail):
        bpy.ops.mesh.primitive_uv_sphere_add(
            segments=64, ring_count=32, radius=0.12,
            location=(-2.3 + (i % 10) * 0.5, -1.7 + (i // 10) * 0.8, 0.12 + (i % 3) * 0.6),
        )
        parts.append(bpy.context.object)

    mat = bpy.data.materials.new("plaster")
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.85, 0.82, 0.78, 1)
    for o in parts:
        o.data.materials.append(mat)

    bpy.ops.object.select_all(action="DESELECT")
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    room = bpy.context.object

    # Lighting: a sun through the window, a warm area light, a sky world.
    bpy.ops.object.light_add(type="SUN", location=(0, -6, 5))
    sun = bpy.context.object
    sun.data.energy = 4
    sun.rotation_euler = (1.1, 0, 0.3)
    bpy.ops.object.light_add(type="AREA", location=(0, 0, H - 0.05))
    bpy.context.object.data.energy = 250
    bpy.context.object.data.size = 1.2
    world = bpy.data.worlds.new("sky")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.6, 0.7, 0.85, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.6
    bpy.context.scene.world = world
    return room


def bake(room, size, samples, out):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False

    bpy.ops.object.select_all(action="DESELECT")
    room.select_set(True)
    bpy.context.view_layer.objects.active = room
    uv = room.data.uv_layers.new(name="lightmap")
    room.data.uv_layers.active = uv
    t0 = time.perf_counter()
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.lightmap_pack(PREF_CONTEXT="ALL_FACES", PREF_MARGIN_DIV=0.2)
    bpy.ops.object.mode_set(mode="OBJECT")
    t_uv = time.perf_counter() - t0

    img = bpy.data.images.new("lightmap", width=size, height=size, float_buffer=True)
    for m in room.data.materials:
        node = m.node_tree.nodes.new("ShaderNodeTexImage")
        node.image = img
        m.node_tree.nodes.active = node

    t0 = time.perf_counter()
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, margin=4, use_clear=True)
    t_bake = time.perf_counter() - t0

    img.filepath_raw = out
    img.file_format = "PNG"
    img.save()
    tris = sum(len(p.vertices) - 2 for p in room.data.polygons)
    print(
        f"RESULT threads={bpy.context.scene.render.threads} size={size} samples={samples} "
        f"triangles={tris} uv_seconds={t_uv:.1f} bake_seconds={t_bake:.1f}"
    )


opts = args()
bake(build_room(opts.detail), opts.size, opts.samples, opts.out)
