"""Bakes one room's lightmap with Cycles on the CPU.

Run by the space builder:
    blender -b --factory-startup --python bake_room.py -- input.json out_dir

Input (metres, +Y up, as produced by bake.ts):
  receiver:  {positions: [x,y,z,...], faces: [[i,...]], faceGroup: [g,...], groups: [{albedo: [r,g,b]}]}
  occluders: {positions, faces}    furniture and closed doorways: cast shadows, receive nothing
  lights:    [{center: [x,y,z], size: [w, d], power: watts, color: [r,g,b]}]
  hdri, hdriStrength, hdriRotation (radians), resolution, samples, margin

Output in out_dir:
  uv2.f32       lightmap UV per receiver vertex (u, v), v measured from the top (glTF style)
  lightmap.f32  RGBA float pixels, rows from the TOP of the image
  meta.json     {width, height, seconds}
"""

import array
import json
import math
import os
import sys
import time

import bpy


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    src, out_dir = argv[0], argv[1]
    with open(src) as f:
        data = json.load(f)
    started = time.time()

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene

    def to_blender(p):
        # Our +Y up (x east, z south) to Blender's +Z up (x east, y north).
        return (p[0], -p[2], p[1])

    def mesh_object(name, mesh_data):
        pos = mesh_data["positions"]
        verts = [to_blender(pos[i:i + 3]) for i in range(0, len(pos), 3)]
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(verts, [], mesh_data["faces"])
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        scene.collection.objects.link(obj)
        return obj

    # --- Receiver: the room's walls, floor, ceiling, trim and stairs --------------------------
    receiver = mesh_object("receiver", data["receiver"])
    for i, group in enumerate(data["receiver"]["groups"]):
        mat = bpy.data.materials.new(f"g{i}")
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes["Principled BSDF"]
        bsdf.inputs["Base Color"].default_value = (*group["albedo"], 1)
        bsdf.inputs["Roughness"].default_value = 0.85
        receiver.data.materials.append(mat)
    for poly, g in zip(receiver.data.polygons, data["receiver"]["faceGroup"]):
        poly.material_index = g

    # --- Occluders (furniture, closed doorways) -------------------------------------------------
    if data["occluders"]["positions"]:
        occ = mesh_object("occluders", data["occluders"])
        mat = bpy.data.materials.new("occluder")
        mat.use_nodes = True
        mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.45, 0.42, 0.38, 1)
        occ.data.materials.append(mat)

    # --- Lights --------------------------------------------------------------------------------
    world = bpy.data.worlds.new("sky")
    world.use_nodes = True
    nodes = world.node_tree.nodes
    background = nodes["Background"]
    if data.get("hdri") and os.path.exists(data["hdri"]):
        env = nodes.new("ShaderNodeTexEnvironment")
        env.image = bpy.data.images.load(data["hdri"])
        coord = nodes.new("ShaderNodeTexCoord")
        mapping = nodes.new("ShaderNodeMapping")
        mapping.inputs["Rotation"].default_value = (0, 0, data.get("hdriRotation", 0.0))
        world.node_tree.links.new(coord.outputs["Generated"], mapping.inputs["Vector"])
        world.node_tree.links.new(mapping.outputs["Vector"], env.inputs["Vector"])
        world.node_tree.links.new(env.outputs["Color"], background.inputs["Color"])
        background.inputs["Strength"].default_value = data.get("hdriStrength", 1.0)
    else:
        background.inputs["Color"].default_value = (0.75, 0.82, 0.92, 1)
        background.inputs["Strength"].default_value = 1.0
    scene.world = world

    for i, light in enumerate(data["lights"]):
        l = bpy.data.lights.new(f"ceiling{i}", type="AREA")
        l.shape = "RECTANGLE"
        l.size, l.size_y = light["size"]
        l.energy = light["power"]
        l.color = light["color"]
        obj = bpy.data.objects.new(f"ceiling{i}", l)
        obj.location = to_blender(light["center"])  # area lights point down (-Z) by default
        scene.collection.objects.link(obj)

    # --- Lightmap UVs --------------------------------------------------------------------------
    res = int(data["resolution"])
    bpy.context.view_layer.objects.active = receiver
    receiver.select_set(True)
    uv = receiver.data.uv_layers.new(name="lightmap")
    receiver.data.uv_layers.active = uv
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.lightmap_pack(
        PREF_CONTEXT="ALL_FACES",
        PREF_PACK_IN_ONE=True,
        PREF_NEW_UVLAYER=False,
        PREF_BOX_DIV=12,
        PREF_MARGIN_DIV=0.3,
    )
    bpy.ops.object.mode_set(mode="OBJECT")
    # Leaving edit mode rebuilds the mesh data: look the UV layer up again.
    uv = receiver.data.uv_layers["lightmap"]

    # --- Bake ----------------------------------------------------------------------------------
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = int(data["samples"])
    scene.cycles.use_denoising = False
    scene.cycles.sample_clamp_indirect = 8.0
    scene.cycles.max_bounces = 6
    scene.render.bake.margin = int(data["margin"])
    image = bpy.data.images.new("lightmap", width=res, height=res, float_buffer=True, alpha=False)
    for mat in receiver.data.materials:
        tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
        tex.image = image
        mat.node_tree.nodes.active = tex
    bpy.ops.object.select_all(action="DESELECT")
    receiver.select_set(True)
    bpy.context.view_layer.objects.active = receiver
    # Direct + indirect light arriving at each surface, without its own colour.
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, margin=int(data["margin"]), use_clear=True)

    # --- Write results -------------------------------------------------------------------------
    os.makedirs(out_dir, exist_ok=True)
    vertex_uv = array.array("f", [0.0]) * (len(receiver.data.vertices) * 2)
    uv_data = receiver.data.uv_layers["lightmap"].data
    for loop in receiver.data.loops:
        u, v = uv_data[loop.index].uv
        vertex_uv[loop.vertex_index * 2] = u
        vertex_uv[loop.vertex_index * 2 + 1] = 1.0 - v  # glTF measures v from the top
    with open(os.path.join(out_dir, "uv2.f32"), "wb") as f:
        vertex_uv.tofile(f)

    pixels = array.array("f", [0.0]) * (res * res * 4)
    image.pixels.foreach_get(pixels)
    row = res * 4
    with open(os.path.join(out_dir, "lightmap.f32"), "wb") as f:
        for y in range(res - 1, -1, -1):  # Blender stores rows bottom-up
            pixels[y * row:(y + 1) * row].tofile(f)

    with open(os.path.join(out_dir, "meta.json"), "w") as f:
        json.dump({"width": res, "height": res, "seconds": round(time.time() - started, 1)}, f)


main()
