export const MODE_COUNT = 24;

export interface WingMode {
  readonly index: number;
  readonly frequencyHz: number;
  readonly colorComponent: 0 | 1 | 2;
  readonly colorMax: number;
  readonly displayAmplitudeM: number;
}

export interface BufferDescriptor {
  readonly url: string;
  readonly sha256: string;
  /** Number of scalars, not bytes. All buffers use little-endian 32-bit scalars. */
  readonly length: number;
}

export interface WingManifest {
  readonly schemaVersion: 1;
  readonly model: { readonly name: string; readonly semispanM: number };
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly modeCount: number;
  readonly rootVertices: readonly number[];
  readonly modes: readonly WingMode[];
  readonly buffers: Readonly<Record<"positions" | "uvs" | "triangles" | "displacements", BufferDescriptor>>;
}

export interface WingDataset {
  readonly manifest: WingManifest;
  readonly positions: Float32Array;
  readonly uvs: Float32Array;
  readonly triangles: Uint32Array;
  readonly displacements: Float32Array;
}

export interface ControllerState {
  readonly mode: number;
  readonly isPlaying: boolean;
  readonly isUiVisible: boolean;
  readonly prefersReducedMotion: boolean;
}
