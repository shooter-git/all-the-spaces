"""Renders a model from four sides, so whoever made it can see it as it will look.

Run by `ats model` (headless, CPU only):
    blender -b --factory-startup --python render_model.py -- model.glb out_dir [settings.json]

Settings (all optional): {"size": 512, "samples": 48, "engine": "CYCLES" | "BLENDER_EEVEE" |
"BLENDER_WORKBENCH"}

Output in out_dir: front.png, three-quarter.png, side.png, top.png
"""

import json
import math
import os
import sys

import bpy
import mathutils


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    src, out_dir = argv[0], argv[1]
    settings = {}
    if len(argv) > 2:
        with open(argv[2]) as f:
            settings = json.load(f)
    size = int(settings.get("size", 512))
    engine = settings.get("engine", "CYCLES")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
    scene = bpy.context.scene
    meshes = [o for o in scene.objects if o.type == "MESH"]
    if not meshes:
        raise SystemExit("The model has nothing to show.")
    corners = [o.matrix_world @ mathutils.Vector(c) for o in meshes for c in o.bound_box]
    lo = mathutils.Vector([min(p[i] for p in corners) for i in range(3)])
    hi = mathutils.Vector([max(p[i] for p in corners) for i in range(3)])
    centre = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 0.01)

    # A soft studio: a pale floor for a contact shadow, sky light and a key light.
    bpy.ops.mesh.primitive_plane_add(size=radius * 12, location=(centre.x, centre.y, lo.z))
    floor_mat = bpy.data.materials.new("floor")
    floor_mat.use_nodes = True
    floor_mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.8, 0.8, 0.8, 1)
    floor_mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9
    bpy.context.object.data.materials.append(floor_mat)

    world = bpy.data.worlds.new("studio")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.85, 0.86, 0.88, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
    scene.world = world
    sun = bpy.data.objects.new("key", bpy.data.lights.new("key", "SUN"))
    sun.data.energy = 3.0
    sun.data.angle = math.radians(8)
    sun.rotation_euler = (math.radians(50), 0, math.radians(-35))
    scene.collection.objects.link(sun)

    camera = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
    camera.data.lens = 50
    camera.data.clip_start = radius / 100
    camera.data.clip_end = radius * 100
    scene.collection.objects.link(camera)
    scene.camera = camera

    scene.render.engine = engine
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.film_transparent = False
    if engine == "CYCLES":
        scene.cycles.device = "CPU"
        scene.cycles.samples = int(settings.get("samples", 48))
        scene.cycles.max_bounces = 4
        scene.cycles.use_denoising = False
    elif engine == "BLENDER_WORKBENCH":
        shading = scene.display.shading
        shading.light = "STUDIO"
        shading.color_type = "MATERIAL"
        shading.show_shadows = True
        shading.show_cavity = True

    # glTF's front (+Z) is Blender's -Y: "front" looks at the model from -Y.
    views = {
        "front": (0, -1, 0.15),
        "three-quarter": (-0.75, -0.9, 0.5),
        "side": (1, 0, 0.15),
        "top": (0.001, -0.02, 1),
    }
    os.makedirs(out_dir, exist_ok=True)
    distance = radius / math.tan(camera.data.angle / 2) * 1.12
    for name, direction in views.items():
        d = mathutils.Vector(direction).normalized()
        camera.location = centre + d * distance
        camera.rotation_euler = (centre - camera.location).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(out_dir, f"{name}.png")
        bpy.ops.render.render(write_still=True)


main()
