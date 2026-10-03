import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { animationCycleSeconds } from "../math/timing";
import type { WingDataset } from "../types";
import { createBerlinTexture } from "./berlin";
import { createViewEnvelope, fitViewEnvelope } from "./camera";

const TWO_PI = 2 * Math.PI;
// The lower skin carries the strongest local motion in this wing's 24 modes.
const DEFAULT_DIRECTION = new THREE.Vector3(1.1, -1.25, -1.45).normalize();
const MAX_BUFFER_PIXELS = 2_500_000;

export interface WingRendererOptions {
  readonly onContextLost?: () => void;
  readonly onContextRestored?: () => void;
}

/** Static geometry and one retained displacement attribute; only phase changes each frame. */
export class WingRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(34, 1, 0.05, 120);
  private readonly controls: OrbitControls;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly displacement: THREE.BufferAttribute;
  private readonly material: THREE.ShaderMaterial;
  private readonly berlin = createBerlinTexture();
  private readonly rootGeometry: THREE.BoxGeometry;
  private readonly rootEdges: THREE.EdgesGeometry;
  private readonly rootMaterial = new THREE.MeshBasicMaterial({ color: 0x172330, transparent: true, opacity: 0.8 });
  private readonly rootLineMaterial = new THREE.LineBasicMaterial({ color: 0xa9b9cf, transparent: true, opacity: 0.8 });
  private readonly center = new THREE.Vector3();
  private readonly viewEnvelope: Float32Array;
  private readonly observer: ResizeObserver | null;
  private readonly uniforms = {
    uPhase: { value: 0 },
    uAmplitude: { value: 0 },
    uColorMax: { value: 1 },
    uComponent: { value: new THREE.Vector3(0, 0, 1) },
    uBerlin: { value: this.berlin }
  };
  private mode = 1;
  private phase = 0;
  private playing = false;
  private pageVisible = true;
  private contextLost = false;
  private destroyed = false;
  private raf = 0;
  private previousTime: number | null = null;
  private frames = 0;
  private fittedDistance = 12;

  constructor(private readonly host: HTMLElement, private readonly data: WingDataset,
    private readonly options: WingRendererOptions = {}) {
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "high-performance" });
    this.renderer.setClearColor(0, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    this.renderer.domElement.dataset.wingCanvas = "true";
    host.replaceChildren(this.renderer.domElement);

    this.geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
    this.geometry.setAttribute("uv", new THREE.BufferAttribute(data.uvs, 2));
    this.geometry.setIndex(new THREE.BufferAttribute(data.triangles, 1));
    this.displacement = new THREE.BufferAttribute(new Float32Array(data.manifest.vertexCount * 3), 3);
    this.displacement.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("displacement", this.displacement);
    this.geometry.computeBoundingBox();
    this.geometry.boundingBox!.getCenter(this.center);
    this.viewEnvelope = createViewEnvelope(data, this.center, DEFAULT_DIRECTION);
    this.material = new THREE.ShaderMaterial({
      name: "wing-signed-displacement-berlin", uniforms: this.uniforms,
      vertexShader: VERTEX_SHADER, fragmentShader: FRAGMENT_SHADER,
      side: THREE.DoubleSide, toneMapped: false
    });
    const wing = new THREE.Mesh(this.geometry, this.material);
    wing.frustumCulled = false;
    this.scene.add(wing);

    const rootBounds = new THREE.Box3();
    for (const index of data.manifest.rootVertices) rootBounds.expandByPoint(new THREE.Vector3().fromArray(data.positions, index * 3));
    const rootSize = rootBounds.getSize(new THREE.Vector3());
    const rootCenter = rootBounds.getCenter(new THREE.Vector3());
    this.rootGeometry = new THREE.BoxGeometry(rootSize.x + 0.06, 0.09, rootSize.z + 0.06);
    this.rootEdges = new THREE.EdgesGeometry(this.rootGeometry);
    const root = new THREE.Mesh(this.rootGeometry, this.rootMaterial);
    const edges = new THREE.LineSegments(this.rootEdges, this.rootLineMaterial);
    rootCenter.y -= 0.05;
    root.position.copy(rootCenter);
    edges.position.copy(rootCenter);
    this.scene.add(root, edges);

    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.enablePan = false;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 50;
    this.controls.rotateSpeed = 0.68;
    this.controls.zoomSpeed = 0.8;
    this.controls.target.copy(this.center);
    this.controls.addEventListener("change", this.requestFrame);
    this.controls.addEventListener("change", this.updateCameraData);
    this.renderer.domElement.addEventListener("webglcontextlost", this.handleContextLost);
    this.renderer.domElement.addEventListener("webglcontextrestored", this.handleContextRestored);
    this.observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.resize());
    this.observer?.observe(host);
    window.addEventListener("resize", this.resize);
    this.host.dataset.status = "ready";
    this.host.dataset.frame = "0";
    this.host.dataset.playing = "false";
    this.host.dataset.pageVisible = "true";
    this.applyMode();
    this.resize();
    this.resetView();
  }

  setMode(mode: number): void {
    if (!Number.isInteger(mode) || mode < 1 || mode > this.data.manifest.modeCount) throw new RangeError("Invalid wing mode.");
    if (this.destroyed || mode === this.mode) return;
    this.mode = mode;
    this.applyMode();
  }

  private applyMode(): void {
    const count = this.data.manifest.vertexCount * 3;
    const mode = this.data.manifest.modes[this.mode - 1]!;
    (this.displacement.array as Float32Array).set(this.data.displacements.subarray((this.mode - 1) * count, this.mode * count));
    this.displacement.needsUpdate = true;
    this.uniforms.uAmplitude.value = mode.displayAmplitudeM;
    this.uniforms.uColorMax.value = mode.colorMax;
    this.uniforms.uComponent.value.set(mode.colorComponent === 0 ? 1 : 0, mode.colorComponent === 1 ? 1 : 0, mode.colorComponent === 2 ? 1 : 0);
    this.phase = 0;
    this.previousTime = null;
    this.uniforms.uPhase.value = 0;
    this.host.dataset.phase = "0";
    this.host.dataset.mode = `${this.mode}`;
    this.host.dataset.frequencyHz = `${mode.frequencyHz}`;
    this.host.dataset.colorComponent = `${mode.colorComponent}`;
    this.host.dataset.cycleSeconds = `${animationCycleSeconds(this.data.manifest.modes, this.mode)}`;
    this.host.dataset.amplitude = `${mode.displayAmplitudeM}`;
    this.requestFrame();
  }

  setPlaying(playing: boolean): void {
    if (this.destroyed || this.playing === playing) return;
    this.playing = playing;
    this.previousTime = null;
    this.host.dataset.playing = `${playing}`;
    this.requestFrame();
  }

  setPageVisible(visible: boolean): void {
    if (this.destroyed) return;
    this.pageVisible = visible;
    this.previousTime = null;
    this.host.dataset.pageVisible = `${visible}`;
    if (visible) this.requestFrame();
    else this.cancelFrame();
  }

  resetView(): void {
    if (this.destroyed) return;
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.target.copy(this.center);
    this.camera.position.copy(this.center).addScaledVector(DEFAULT_DIRECTION, this.fittedDistance);
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(this.center);
    this.controls.update();
    this.controls.enableDamping = true;
    this.updateCameraData();
    this.requestFrame();
  }

  handleKeyboard(event: KeyboardEvent): boolean {
    if (this.destroyed || event.altKey || event.ctrlKey || event.metaKey) return false;
    switch (event.key) {
      case "ArrowLeft": this.controls.rotateLeft(0.1); break;
      case "ArrowRight": this.controls.rotateLeft(-0.1); break;
      case "ArrowUp": this.controls.rotateUp(0.075); break;
      case "ArrowDown": this.controls.rotateUp(-0.075); break;
      case "+": case "=": this.zoomBy(0.88); break;
      case "-": case "_": this.zoomBy(1.14); break;
      case "Home": case "0": this.resetView(); break;
      default: return false;
    }
    event.preventDefault();
    this.controls.update();
    this.requestFrame();
    return true;
  }

  private zoomBy(scale: number): void {
    const offset = this.camera.position.clone().sub(this.center);
    offset.setLength(THREE.MathUtils.clamp(offset.length() * scale, this.controls.minDistance, this.controls.maxDistance));
    this.camera.position.copy(this.center).add(offset);
  }

  readonly resize = (): void => {
    if (this.destroyed) return;
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_BUFFER_PIXELS / (width * height)));
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    const oldDistance = this.fittedDistance;
    // Preserve the user's orbit and zoom while fitting the complete modal envelope.
    const distance = fitViewEnvelope(this.viewEnvelope, width, height, this.camera.fov);
    this.fittedDistance = distance;
    const offset = this.camera.position.clone().sub(this.center);
    if (offset.lengthSq() > 0) this.camera.position.copy(this.center).add(offset.multiplyScalar(distance / oldDistance));
    this.controls.update();
    this.host.dataset.pixelRatio = ratio.toFixed(3);
    this.updateCameraData();
    this.requestFrame();
  };

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelFrame();
    this.observer?.disconnect();
    window.removeEventListener("resize", this.resize);
    this.controls.removeEventListener("change", this.requestFrame);
    this.controls.removeEventListener("change", this.updateCameraData);
    this.controls.dispose();
    this.renderer.domElement.removeEventListener("webglcontextlost", this.handleContextLost);
    this.renderer.domElement.removeEventListener("webglcontextrestored", this.handleContextRestored);
    for (const resource of [this.geometry, this.material, this.berlin, this.rootGeometry, this.rootEdges, this.rootMaterial, this.rootLineMaterial]) resource.dispose();
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.host.dataset.status = "destroyed";
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    this.previousTime = null;
    this.cancelFrame();
    this.host.dataset.status = "context-lost";
    this.options.onContextLost?.();
  };

  private readonly handleContextRestored = (): void => {
    if (this.destroyed) return;
    this.contextLost = false;
    this.previousTime = null;
    this.host.dataset.status = "ready";
    this.options.onContextRestored?.();
    this.requestFrame();
  };

  private readonly requestFrame = (): void => {
    if (this.destroyed || this.contextLost || !this.pageVisible || this.raf) return;
    this.raf = requestAnimationFrame(this.renderFrame);
  };

  private readonly renderFrame = (time: number): void => {
    this.raf = 0;
    if (this.destroyed || this.contextLost || !this.pageVisible) return;
    if (this.playing) {
      if (this.previousTime !== null) {
        const elapsed = Math.min(0.1, Math.max(0, (time - this.previousTime) / 1000));
        this.phase = (this.phase + elapsed * TWO_PI / animationCycleSeconds(this.data.manifest.modes, this.mode)) % TWO_PI;
        this.uniforms.uPhase.value = this.phase;
        this.host.dataset.phase = this.phase.toFixed(6);
      }
      this.previousTime = time;
    } else this.previousTime = null;
    const moving = this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.frames += 1;
    this.host.dataset.frame = `${this.frames}`;
    this.host.dataset.geometryCount = `${this.renderer.info.memory.geometries}`;
    this.host.dataset.textureCount = `${this.renderer.info.memory.textures}`;
    this.host.dataset.programCount = `${this.renderer.info.programs?.length ?? 0}`;
    if (this.playing || moving) this.requestFrame();
  };

  private readonly updateCameraData = (): void => {
    this.host.dataset.camera = this.camera.position.toArray().map((v) => v.toFixed(4)).join(",");
  };

  private cancelFrame(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}

const VERTEX_SHADER = /* glsl */ `
  attribute vec3 displacement;
  uniform float uPhase;
  uniform float uAmplitude;
  uniform float uColorMax;
  uniform vec3 uComponent;
  varying vec2 vUv;
  varying float vDisplacement;
  varying vec3 vViewPosition;
  void main() {
    float temporal = cos(uPhase);
    vec3 displaced = position + displacement * uAmplitude * temporal;
    vec4 viewPosition = modelViewMatrix * vec4(displaced, 1.0);
    vViewPosition = viewPosition.xyz;
    vDisplacement = dot(displacement, uComponent) * temporal / uColorMax;
    vUv = uv;
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uBerlin;
  varying vec2 vUv;
  varying float vDisplacement;
  varying vec3 vViewPosition;
  float surfaceGrid(float coordinate, float divisions) {
    float gridCoordinate = coordinate * divisions;
    float cell = fract(gridCoordinate);
    float distance = min(cell, 1.0 - cell);
    float pixel = max(fwidth(gridCoordinate), 0.00001);
    return 1.0 - smoothstep(0.25 * pixel, 0.9 * pixel, distance);
  }
  void main() {
    float paletteCoordinate = clamp(vDisplacement * 0.5 + 0.5, 0.0, 1.0);
    vec3 color = texture2D(uBerlin, vec2(paletteCoordinate, 0.5)).rgb;
    // Derivatives follow the actual, fully displaced triangular surface.
    vec3 normal = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
    float diffuse = 0.5 + 0.5 * max(0.0, dot(normal, normalize(vec3(0.28, 0.78, 0.56))));
    color *= 0.88 + 0.12 * diffuse;
    float grid = max(surfaceGrid(vUv.x, 16.0), surfaceGrid(vUv.y, 32.0));
    vec3 gridColor = sRGBTransferEOTF(vec4(0.72, 0.78, 0.85, 1.0)).rgb;
    color = mix(color, gridColor, grid * 0.28);
    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;
