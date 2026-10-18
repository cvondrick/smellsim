// Rendering pipeline:
//   1. the scene (room, furniture, people, device, particles) renders into an HDR multisampled
//      target with a depth texture;
//   2. a full-screen pass ray-marches the odor/air volume up to the scene depth, composites it,
//      applies tone mapping, and restores depth;
//   3. an overlay scene (gizmos, selection) renders on top with depth testing.

import * as THREE from 'three';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const compositeVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const compositeFragment = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler3D tVolume;
uniform mat4 uInvViewProj;
uniform vec3 uCameraPos;
uniform vec3 uRoomSize;
uniform bool uVolumeOn;
uniform bool uSliceOn;
uniform float uSliceY;
uniform float uSliceOpacity;
uniform float uDensity;
uniform float uThreshold;
uniform float uMaxOpacity;
uniform float uStep;
uniform float uBrightness;
uniform float uExposure;
uniform float uTime;
varying vec2 vUv;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime) * 43758.5453);
}

vec3 aces(vec3 x) {
  const float a = 2.51; const float b = 0.03; const float c = 2.43; const float d = 0.59; const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

vec4 sampleVolume(vec3 p) {
  vec4 s = texture(tVolume, p / uRoomSize);
  s.rgb = pow(s.rgb, vec3(2.2));
  return s;
}

void main() {
  vec4 scene = texture(tScene, vUv);
  float depth = texture(tDepth, vUv).r;
  vec4 farPoint = uInvViewProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  farPoint /= farPoint.w;
  vec3 dir = normalize(farPoint.xyz - uCameraPos);
  float tScene = 1e9;
  if (depth < 1.0) {
    vec4 hit = uInvViewProj * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    hit /= hit.w;
    tScene = length(hit.xyz - uCameraPos);
  }
  vec3 inv = 1.0 / dir;
  vec3 t0 = (vec3(0.0) - uCameraPos) * inv;
  vec3 t1 = (uRoomSize - uCameraPos) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float tNear = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
  float tFar = min(min(tmax.x, tmax.y), tmax.z);
  tFar = min(tFar, tScene);

  vec3 acc = vec3(0.0);
  float alpha = 0.0;
  if (tFar > tNear) {
    float tSlice = -1.0;
    if (uSliceOn && abs(dir.y) > 1e-5) tSlice = (uSliceY - uCameraPos.y) / dir.y;
    bool sliceDone = !(uSliceOn && tSlice > tNear && tSlice < tFar);
    if (uVolumeOn) {
      float t = tNear + hash(gl_FragCoord.xy) * uStep;
      for (int i = 0; i < 480; i++) {
        if (t > tFar || alpha > 0.985) break;
        if (!sliceDone && tSlice <= t) {
          vec4 s = sampleVolume(uCameraPos + dir * tSlice);
          float a = smoothstep(0.0, 0.35, s.a) * uSliceOpacity;
          acc += (1.0 - alpha) * a * s.rgb * 1.4;
          alpha += (1.0 - alpha) * a;
          sliceDone = true;
        }
        vec4 s = sampleVolume(uCameraPos + dir * t);
        float d = max(0.0, s.a - uThreshold) / (1.0 - uThreshold);
        float a = 1.0 - exp(-d * d * uDensity * uStep);
        acc += (1.0 - alpha) * a * s.rgb * uBrightness;
        alpha += (1.0 - alpha) * a;
        t += uStep;
      }
    }
    if (!sliceDone) {
      vec4 s = sampleVolume(uCameraPos + dir * tSlice);
      float a = smoothstep(0.0, 0.35, s.a) * uSliceOpacity;
      acc += (1.0 - alpha) * a * s.rgb * 1.4;
      alpha += (1.0 - alpha) * a;
    }
  }
  // cap the fog so the room underneath always stays visible
  if (alpha > uMaxOpacity) {
    acc *= uMaxOpacity / alpha;
    alpha = uMaxOpacity;
  }
  vec3 color = scene.rgb * (1.0 - alpha) + acc;
  color = aces(color * uExposure);
  gl_FragColor = vec4(linearToSrgb(color), 1.0);
  gl_FragDepth = depth;
}
`;

export interface VolumeSettings {
  volumeOn: boolean;
  sliceOn: boolean;
  sliceY: number;
  sliceOpacity: number;
  density: number;
  threshold: number;
  maxOpacity: number;
  brightness: number;
}

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly overlay = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly labels: CSS2DRenderer;
  readonly sun: THREE.DirectionalLight;
  private target: THREE.WebGLRenderTarget;
  private compositeScene = new THREE.Scene();
  private compositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private compositeMaterial: THREE.ShaderMaterial;
  private volumeTexture: THREE.Data3DTexture | null = null;
  private roomSize = new THREE.Vector3(1, 1, 1);
  readonly volume: VolumeSettings = {
    volumeOn: true,
    sliceOn: false,
    sliceY: 1.2,
    sliceOpacity: 0.85,
    density: 10,
    threshold: 0.08,
    maxOpacity: 0.7,
    brightness: 1.2,
  };
  private container: HTMLElement;
  private viewTargets: { hdr: THREE.WebGLRenderTarget; ldr: THREE.WebGLRenderTarget } | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'label-layer';
    container.appendChild(this.labels.domElement);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.03, 200);
    this.camera.layers.enable(1);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    this.scene.background = new THREE.Color('#151922');

    const hemi = new THREE.HemisphereLight('#dfe8ff', '#3a3226', 0.6);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight('#fff1dc', 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);

    this.target = this.createTarget(1, 1);
    this.compositeMaterial = new THREE.ShaderMaterial({
      vertexShader: compositeVertex,
      fragmentShader: compositeFragment,
      uniforms: {
        tScene: { value: null },
        tDepth: { value: null },
        tVolume: { value: null },
        uInvViewProj: { value: new THREE.Matrix4() },
        uCameraPos: { value: new THREE.Vector3() },
        uRoomSize: { value: this.roomSize },
        uVolumeOn: { value: true },
        uSliceOn: { value: false },
        uSliceY: { value: 1.2 },
        uSliceOpacity: { value: 0.85 },
        uDensity: { value: 6 },
        uThreshold: { value: 0.15 },
        uMaxOpacity: { value: 0.7 },
        uStep: { value: 0.05 },
        uBrightness: { value: 1.25 },
        uExposure: { value: 1.0 },
        uTime: { value: 0 },
      },
      depthTest: false,
      depthWrite: true,
      toneMapped: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMaterial);
    quad.frustumCulled = false;
    this.compositeScene.add(quad);

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  private createTarget(width: number, height: number): THREE.WebGLRenderTarget {
    const depthTexture = new THREE.DepthTexture(width, height);
    depthTexture.type = THREE.FloatType;
    return new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      samples: 4,
      depthTexture,
      depthBuffer: true,
    });
  }

  resize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const ratio = this.renderer.getPixelRatio();
    this.renderer.setSize(width, height, false);
    this.renderer.domElement.style.width = `${width}px`;
    this.renderer.domElement.style.height = `${height}px`;
    this.labels.setSize(width, height);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.target.setSize(Math.floor(width * ratio), Math.floor(height * ratio));
    (this.target.depthTexture as THREE.DepthTexture).image.width = Math.floor(width * ratio);
    (this.target.depthTexture as THREE.DepthTexture).image.height = Math.floor(height * ratio);
  }

  /** Allocate the volume texture for a room (interior cell counts). */
  setRoom(roomSize: [number, number, number], dims: [number, number, number], cellSize: number): void {
    this.roomSize.set(roomSize[0], roomSize[1], roomSize[2]);
    this.volumeTexture?.dispose();
    const data = new Uint8Array(dims[0] * dims[1] * dims[2] * 4);
    const texture = new THREE.Data3DTexture(data, dims[0], dims[1], dims[2]);
    texture.format = THREE.RGBAFormat;
    texture.type = THREE.UnsignedByteType;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = texture.wrapT = texture.wrapR = THREE.ClampToEdgeWrapping;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    this.volumeTexture = texture;
    this.compositeMaterial.uniforms.tVolume.value = texture;
    this.compositeMaterial.uniforms.uStep.value = cellSize * 0.4;

    const extent = Math.max(roomSize[0], roomSize[2]);
    this.sun.position.set(roomSize[0] * 0.3, roomSize[1] + extent * 1.2, roomSize[2] * 0.15);
    this.sun.target.position.set(roomSize[0] / 2, 0, roomSize[2] / 2);
    const shadowCamera = this.sun.shadow.camera;
    shadowCamera.left = -extent;
    shadowCamera.right = extent;
    shadowCamera.top = extent;
    shadowCamera.bottom = -extent;
    shadowCamera.near = 0.5;
    shadowCamera.far = roomSize[1] + extent * 3;
    shadowCamera.updateProjectionMatrix();
  }

  updateVolume(data: Uint8Array): void {
    if (!this.volumeTexture) return;
    const image = this.volumeTexture.image as { data: Uint8Array };
    if (image.data.length !== data.length) return;
    image.data.set(data);
    this.volumeTexture.needsUpdate = true;
  }

  render(time: number): void {
    const uniforms = this.compositeMaterial.uniforms;
    const camera = this.camera;
    camera.updateMatrixWorld();
    const viewProjection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    uniforms.uInvViewProj.value.copy(viewProjection).invert();
    uniforms.uCameraPos.value.setFromMatrixPosition(camera.matrixWorld);
    uniforms.uVolumeOn.value = this.volume.volumeOn;
    uniforms.uSliceOn.value = this.volume.sliceOn;
    uniforms.uSliceY.value = this.volume.sliceY;
    uniforms.uSliceOpacity.value = this.volume.sliceOpacity;
    uniforms.uDensity.value = this.volume.density;
    uniforms.uThreshold.value = this.volume.threshold;
    uniforms.uMaxOpacity.value = this.volume.maxOpacity;
    uniforms.uBrightness.value = this.volume.brightness;
    uniforms.uTime.value = time % 100;

    const renderer = this.renderer;
    renderer.autoClear = true;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, camera);
    renderer.setRenderTarget(null);
    uniforms.tScene.value = this.target.texture;
    uniforms.tDepth.value = this.target.depthTexture;
    renderer.render(this.compositeScene, this.compositeCamera);
    renderer.autoClear = false;
    renderer.render(this.overlay, camera);
    renderer.autoClear = true;
    this.labels.render(this.scene, camera);
  }

  /** Render the scene (no volume, no visualization layer) from another camera into pixels. */
  renderView(camera: THREE.PerspectiveCamera, width: number, height: number): ImageData {
    if (!this.viewTargets || this.viewTargets.hdr.width !== width || this.viewTargets.hdr.height !== height) {
      this.viewTargets?.hdr.dispose();
      this.viewTargets?.ldr.dispose();
      this.viewTargets = {
        hdr: this.createTarget(width, height),
        ldr: new THREE.WebGLRenderTarget(width, height, { type: THREE.UnsignedByteType }),
      };
    }
    const { hdr, ldr } = this.viewTargets;
    const renderer = this.renderer;
    const uniforms = this.compositeMaterial.uniforms;
    renderer.setRenderTarget(hdr);
    renderer.render(this.scene, camera);
    const volumeOn = uniforms.uVolumeOn.value;
    const sliceOn = uniforms.uSliceOn.value;
    uniforms.uVolumeOn.value = false;
    uniforms.uSliceOn.value = false;
    uniforms.tScene.value = hdr.texture;
    uniforms.tDepth.value = hdr.depthTexture;
    renderer.setRenderTarget(ldr);
    renderer.render(this.compositeScene, this.compositeCamera);
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(ldr, 0, 0, width, height, pixels);
    renderer.setRenderTarget(null);
    uniforms.uVolumeOn.value = volumeOn;
    uniforms.uSliceOn.value = sliceOn;
    const flipped = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      flipped.set(pixels.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
    }
    return new ImageData(flipped, width, height);
  }
}
