import type { MaterialName, PlanFurniture } from '@ats/space-format';

/**
 * Which CC0 asset stands in for each generic material and furniture kind.
 * All from Poly Haven (CC0-1.0). Tints multiply the texture so one fabric can come in several
 * colours. Later, the Architect's AI picks assets per object from their photos.
 */

export interface TextureChoice {
  texture: string;
  tint?: string;
  /**
   * Keep our own palette colour and take only the texture's relief and roughness: for paint (real
   * paint is an even colour; photos add stains) and fabrics (so any colour can use the same weave).
   */
  ownColor?: boolean;
}

/** Surfaces on furniture, walls and ceilings. */
export const SURFACES: Partial<Record<MaterialName, TextureChoice>> = {
  plaster: { texture: 'painted_plaster_wall', ownColor: true },
  'plaster-warm': { texture: 'painted_plaster_wall', ownColor: true },
  'paint-sage': { texture: 'painted_plaster_wall', ownColor: true },
  'paint-sky': { texture: 'painted_plaster_wall', ownColor: true },
  oak: { texture: 'oak_veneer_01' },
  walnut: { texture: 'natural_walnut_veneer' },
  'tile-light': { texture: 'long_white_tiles' },
  'tile-dark': { texture: 'large_grey_tiles', tint: '#8a8a90' },
  concrete: { texture: 'brushed_concrete' },
  'carpet-stone': { texture: 'rough_linen', ownColor: true },
  'fabric-linen': { texture: 'rough_linen', ownColor: true },
  'fabric-indigo': { texture: 'rough_linen', ownColor: true },
  'fabric-moss': { texture: 'velour_velvet', ownColor: true },
  brick: { texture: 'red_brick_03' },
  stone: { texture: 'stacked_stone_wall' },
};

/** Floors use floor-specific textures (planks, not veneer). */
export const FLOORS: Partial<Record<MaterialName, TextureChoice>> = {
  oak: { texture: 'wood_floor' },
  walnut: { texture: 'dark_wood' },
  'tile-light': { texture: 'large_grey_tiles', tint: '#f2f0ec' },
  'tile-dark': { texture: 'floor_tiles_06' },
  concrete: { texture: 'concrete_floor' },
  'carpet-stone': { texture: 'rough_linen', ownColor: true },
  asphalt: { texture: 'asphalt_02' },
  grass: { texture: 'leafy_grass' },
  brick: { texture: 'red_brick_pavers' },
  stone: { texture: 'precast_stone_paving' },
};

export interface ModelChoice {
  model: string;
  /** Rotation (degrees) that turns the model's front towards +Z. */
  yaw: number;
}

/** Photoscanned models for furniture kinds; kinds not listed keep the simple built-in shapes. */
export const MODELS: Partial<Record<PlanFurniture['kind'], ModelChoice[]>> = {
  sofa: [{ model: 'sofa_02', yaw: 0 }],
  armchair: [{ model: 'modern_arm_chair_01', yaw: 0 }],
  table: [{ model: 'wooden_table_02', yaw: 0 }],
  'coffee-table': [{ model: 'modern_coffee_table_01', yaw: 90 }],
  chair: [{ model: 'dining_chair_02', yaw: 0 }],
  cabinet: [{ model: 'modern_wooden_cabinet', yaw: 0 }],
  shelf: [{ model: 'wooden_display_shelves_01', yaw: -90 }],
  plant: [{ model: 'potted_plant_01', yaw: 0 }],
  frame: [{ model: 'hanging_picture_frame_02', yaw: 0 }],
};

/** The sky every sample space is lit by. */
export const DEFAULT_HDRI = 'autumn_park';

/** Chooses a model for an item. */
export function modelFor(kind: PlanFurniture['kind'], _height: number): ModelChoice | null {
  return MODELS[kind]?.[0] ?? null;
}
