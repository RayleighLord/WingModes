import * as THREE from "three";
import type { WingDataset } from "../types";
import { motionScale } from "./display.json";

/** Cache the actual surface and its complete modal envelope in the default view. */
export function createViewEnvelope(data: WingDataset, center: THREE.Vector3, direction: THREE.Vector3): Float32Array {
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 0, 1), direction).normalize();
  const up = new THREE.Vector3().crossVectors(direction, right).normalize();
  const axes = [right, up, direction];
  const envelope = new Float32Array(data.manifest.vertexCount * 6);
  for (let vertex = 0; vertex < data.manifest.vertexCount; vertex += 1) {
    const offset = vertex * 3;
    const x = data.positions[offset]! - center.x;
    const y = data.positions[offset + 1]! - center.y;
    const z = data.positions[offset + 2]! - center.z;
    for (const [component, axis] of axes.entries()) {
      envelope[vertex * 6 + component] = x * axis.x + y * axis.y + z * axis.z;
    }
    for (const mode of data.manifest.modes) {
      const modalOffset = (mode.index - 1) * data.positions.length + offset;
      const amplitude = mode.displayAmplitudeM * motionScale;
      const ux = data.displacements[modalOffset]! * amplitude;
      const uy = data.displacements[modalOffset + 1]! * amplitude;
      const uz = data.displacements[modalOffset + 2]! * amplitude;
      for (const [component, axis] of axes.entries()) {
        const index = vertex * 6 + 3 + component;
        envelope[index] = Math.max(envelope[index]!, Math.abs(ux * axis.x + uy * axis.y + uz * axis.z));
      }
    }
  }
  return envelope;
}

/** Fit projected vertices rather than the much larger empty corners of a world box. */
export function fitViewEnvelope(envelope: Float32Array, width: number, height: number, fovDegrees: number): number {
  const tanVertical = Math.tan(THREE.MathUtils.degToRad(fovDegrees / 2));
  const tanHorizontal = tanVertical * width / height;
  const horizontalFraction = width <= 800 ? 0.90 : 0.72;
  const verticalFraction = 0.65;
  let distance = 0;
  for (let i = 0; i < envelope.length; i += 6) {
    const front = envelope[i + 2]! + envelope[i + 5]!;
    distance = Math.max(distance,
      front + (Math.abs(envelope[i]!) + envelope[i + 3]!) / (tanHorizontal * horizontalFraction),
      front + (Math.abs(envelope[i + 1]!) + envelope[i + 4]!) / (tanVertical * verticalFraction));
  }
  return distance * 1.03;
}
