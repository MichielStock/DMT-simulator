// Comfort limits for camera motion (BUILD.md §4.5): no camera movement the user did not initiate,
// except slow constant-velocity drift (waiting room) with a stable horizon. Layers that move a camera
// pass their desired motion through these helpers.

/** Maximum automatic drift speed (scene units per second). */
export const MAX_DRIFT_SPEED = 0.6;
/** Maximum automatic rotation speed (radians per second). */
export const MAX_ROTATION_SPEED = 0.12;
/** Maximum change of drift velocity (units/s^2): no acceleration bursts. */
export const MAX_ACCELERATION = 0.15;
/** Maximum change of rotation speed (rad/s^2). */
export const MAX_ANGULAR_ACCELERATION = 0.05;
/** Maximum camera roll (radians): keeps the horizon stable. */
export const MAX_ROLL = 0.0;

export interface Vec3Like { x: number; y: number; z: number }

function clampLen(v: Vec3Like, max: number): Vec3Like {
  const l = Math.hypot(v.x, v.y, v.z);
  if (l <= max || l === 0) return { x: v.x, y: v.y, z: v.z };
  const s = max / l;
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

/** Next drift velocity: moves toward `desired` with bounded acceleration, capped speed. */
export function limitDriftVelocity(current: Vec3Like, desired: Vec3Like, dtS: number): Vec3Like {
  const want = clampLen(desired, MAX_DRIFT_SPEED);
  const dv = { x: want.x - current.x, y: want.y - current.y, z: want.z - current.z };
  const step = clampLen(dv, MAX_ACCELERATION * Math.max(0, dtS));
  return { x: current.x + step.x, y: current.y + step.y, z: current.z + step.z };
}

/** Next rotation speed (rad/s) with bounded angular acceleration and capped speed. */
export function limitRotationSpeed(current: number, desired: number, dtS: number): number {
  const want = Math.max(-MAX_ROTATION_SPEED, Math.min(MAX_ROTATION_SPEED, desired));
  const maxStep = MAX_ANGULAR_ACCELERATION * Math.max(0, dtS);
  return current + Math.max(-maxStep, Math.min(maxStep, want - current));
}

/** Roll is always clamped to keep the horizon level. */
export function limitRoll(_roll: number): number {
  return MAX_ROLL;
}
