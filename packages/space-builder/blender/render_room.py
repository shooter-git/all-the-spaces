"""Renders a room as someone standing in it would see it, to compare with photos of the real one.

Run by `ats space render` (headless, CPU only):
    blender -b --factory-startup --python render_room.py -- room.glb input.json out_dir

input.json (metres, +Y up, as the builder writes it):
  cameras: [{name, position: [x,y,z], target: [x,y,z], lens}]
  lights:  [{center: [x,y,z], size: [w, d], power: watts, color: [r,g,b]}]   ceiling lights
  hdri:    path to an HDR sky (optional), hdriRotation (radians)
  width, height, samples, engine ("CYCLES" | "BLENDER_EEVEE" | "BLENDER_WORKBENCH")

Output in out_dir: <camera name>.png for each camera.
"""

import json
import math
import os
import sys

import bpy
import mathutils


def to_blender(p):
    # Our +Y up (x east, z south) to Blender's +Z up (x east, y north).
    return mathutils.Vector((p[0], -p[2], p[1]))


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    src, input_path, out_dir = argv[0], argv[1], argv[2]
    with open(input_path) as f:
        data = json.load(f)
    engine = data.get("engine", "CYCLES")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
    scene = bpy.context.scene

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
    else:
        background.inputs["Color"].default_value = (0.75, 0.82, 0.92, 1)
    background.inputs["Strength"].default_value = 1.0
    scene.world = world

    for i, light in enumerate(data.get("lights", [])):
        l = bpy.data.lights.new(f"ceiling{i}", type="AREA")
        l.shape = "RECTANGLE"
        l.size, l.size_y = light["size"]
        l.energy = light["power"]
        l.color = light["color"]
        obj = bpy.data.objects.new(f"ceiling{i}", l)
        obj.location = to_blender(light["center"])  # area lights point down (-Z) by default
        scene.collection.objects.link(obj)

    scene.render.engine = engine
    scene.render.resolution_x = int(data.get("width", 960))
    scene.render.resolution_y = int(data.get("height", 640))
    if engine == "CYCLES":
        scene.cycles.device = "CPU"
        scene.cycles.samples = int(data.get("samples", 64))
        scene.cycles.max_bounces = 4
        # Less speckle indoors (no denoiser in this build): clamp bright bounces, soften glossy
        # ones, and skip caustics.
        scene.cycles.sample_clamp_indirect = 3.0
        scene.cycles.blur_glossy = 1.0
        scene.cycles.caustics_reflective = False
        scene.cycles.caustics_refractive = False
        scene.cycles.use_denoising = False
    elif engine == "BLENDER_WORKBENCH":
        shading = scene.display.shading
        shading.light = "STUDIO"
        shading.color_type = "TEXTURE"
        shading.show_shadows = True

    os.makedirs(out_dir, exist_ok=True)
    for cam in data["cameras"]:
        camera = bpy.data.objects.new(cam["name"], bpy.data.cameras.new(cam["name"]))
        camera.data.lens = cam.get("lens", 20)
        camera.data.clip_start = 0.05
        scene.collection.objects.link(camera)
        camera.location = to_blender(cam["position"])
        target = to_blender(cam["target"])
        camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
        scene.camera = camera
        scene.render.filepath = os.path.join(out_dir, f"{cam['name']}.png")
        bpy.ops.render.render(write_still=True)


main()
