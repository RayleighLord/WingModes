import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { WingDataset, WingManifest } from "../types";
import { createViewEnvelope, fitViewEnvelope } from "../wing/camera";
import { motionScale } from "../wing/display.json";

describe("camera framing of three-dimensional modal motion", () => {
  it("keeps every oscillation phase inside the desktop and mobile viewport", () => {
    const positions = new Float32Array([-1, 0, -0.1, 1, 0, 0.1, 1.5, 6, 0.5]);
    const displacements = new Float32Array([
      0, 0, 0, 0.2, -0.1, 0.3, 0.3, 0.1, 0.9,
      0, 0, 0, -0.1, 0.2, -0.3, -0.7, -0.2, 0.1
    ]);
    const descriptor = { url: "test.bin", length: 0, sha256: "0".repeat(64) };
    const manifest: WingManifest = {
      schemaVersion: 1, model: { name: "Camera fixture", semispanM: 6 },
      vertexCount: 3, triangleCount: 1, modeCount: 2, rootVertices: [0],
      buffers: { positions: descriptor, uvs: descriptor, triangles: descriptor, displacements: descriptor },
      modes: [
        { index: 1, frequencyHz: 1, colorComponent: 2, colorMax: 1, displayAmplitudeM: 0.36 },
        { index: 2, frequencyHz: 2, colorComponent: 0, colorMax: 1, displayAmplitudeM: 0.2 }
      ]
    };
    const data: WingDataset = { manifest, positions, displacements, uvs: new Float32Array(6), triangles: new Uint32Array([0, 1, 2]) };
    const center = new THREE.Vector3(0.25, 3, 0.2);
    const direction = new THREE.Vector3(1.1, -1.25, -1.45).normalize();
    const envelope = createViewEnvelope(data, center, direction);
    for (const [width, height] of [[1440, 900], [390, 844], [844, 390]]) {
      const camera = new THREE.PerspectiveCamera(34, width! / height!, 0.05, 120);
      camera.up.set(0, 0, 1);
      camera.position.copy(center).addScaledVector(direction, fitViewEnvelope(envelope, width!, height!, 34));
      camera.lookAt(center);
      camera.updateMatrixWorld();
      for (const mode of manifest.modes) for (let phase = 0; phase < 32; phase += 1) {
        for (let vertex = 0; vertex < 3; vertex += 1) {
          const point = new THREE.Vector3().fromArray(positions, vertex * 3);
          const displacement = new THREE.Vector3().fromArray(displacements, (mode.index - 1) * positions.length + vertex * 3);
          point.addScaledVector(displacement, mode.displayAmplitudeM * motionScale * Math.cos(phase * Math.PI / 16));
          point.project(camera);
          expect(Math.abs(point.x)).toBeLessThan(width! <= 800 ? 0.9 : 0.72);
          expect(Math.abs(point.y)).toBeLessThan(0.65);
          expect(point.z).toBeGreaterThan(-1);
          expect(point.z).toBeLessThan(1);
        }
      }
    }
  });
});
