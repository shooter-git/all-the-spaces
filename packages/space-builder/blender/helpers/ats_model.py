# SPDX-License-Identifier: MIT
# MIT, unlike the rest of this package: Architects' own model scripts import it, and what they make
# is theirs (see LICENSE beside it and docs/licensing.md).
"""Helpers for making a model in Blender with `ats model build`. Use them or don't: any script
that exports a .glb to the path after `--` works.

    import ats_model as m
    m.start()                                  # an empty scene
    suit = m.material("suit", "#e8e6df", roughness=0.6)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.035, location=(0, 0, 0.145))
    m.use(bpy.context.object, suit, smooth=True)
    m.finish()                                 # exports to the path `ats model` gave

Conventions: metres; Blender's +Z is up; the model's front faces -Y (what Blender's Front view
shows). Where its origin is doesn't matter: it's stood on the floor and centred where it goes.
"""

import sys

import bpy


def output_path():
    """Where to export (given by `ats model build`)."""
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not argv:
        raise SystemExit("No output path: run this with `ats model build <script>`.")
    return argv[0]


def start():
    """An empty scene (nothing from Blender's default startup file)."""
    bpy.ops.wm.read_factory_settings(use_empty=True)


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def material(name, color="#ffffff", roughness=0.5, metallic=0.0, emission=None, emission_strength=1.0, alpha=1.0):
    """A material from a hex colour (as you'd pick it from a photo)."""
    c = color.lstrip("#")
    rgb = [srgb_to_linear(int(c[i:i + 2], 16) / 255) for i in (0, 2, 4)]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if alpha < 1:
        bsdf.inputs["Alpha"].default_value = alpha
        mat.blend_method = "BLEND"
    if emission:
        e = emission.lstrip("#")
        erg = [srgb_to_linear(int(e[i:i + 2], 16) / 255) for i in (0, 2, 4)]
        key = "Emission Color" if "Emission Color" in bsdf.inputs else "Emission"
        bsdf.inputs[key].default_value = (*erg, 1)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


def use(obj, mat, smooth=False):
    """Gives an object a material (and optionally smooth shading). Returns the object."""
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    if smooth:
        for poly in obj.data.polygons:
            poly.use_smooth = True
    return obj


def finish(path=None):
    """Exports everything in the scene as one .glb (modifiers applied, glTF's +Y up)."""
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=path or output_path(),
        export_format="GLB",
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
    )
