// Visualization-layer objects: tracer particles and air-flow arrows (layer 1, hidden from the
// device camera).

import * as THREE from 'three';

const MAX_COLORS = 48;

const particleVertex = /* glsl */ `
attribute float attr;
uniform vec3 uColors[${MAX_COLORS}];
uniform float uSize;
uniform float uMode; // 0 odor, 1 air
uniform float uPixelRatio;
varying vec3 vColor;
varying float vAlpha;
void main() {
  if (attr < 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    return;
  }
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  if (uMode < 0.5) {
    int index = int(floor(attr));
    float age = fract(attr);
    vColor = uColors[index];
    vAlpha = smoothstep(0.0, 0.03, age) * (1.0 - smoothstep(0.6, 1.0, age));
  } else {
    float t = clamp(attr / 1.5, 0.0, 1.0);
    vColor = mix(vec3(0.25, 0.55, 1.0), vec3(1.0, 0.85, 0.3), t);
    vAlpha = 0.25 + 0.75 * t;
  }
  gl_PointSize = uSize * uPixelRatio * (2.5 / -mv.z);
}
`;

const particleFragment = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c);
  if (d > 0.25) discard;
  float soft = 1.0 - d * 4.0;
  gl_FragColor = vec4(vColor * 1.15, vAlpha * soft * 0.85);
}
`;

export class ParticlesView {
  readonly points: THREE.Points;
  private geometry = new THREE.BufferGeometry();
  private material: THREE.ShaderMaterial;
  private capacity = 0;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: particleVertex,
      fragmentShader: particleFragment,
      uniforms: {
        uColors: { value: Array.from({ length: MAX_COLORS }, () => new THREE.Color(1, 1, 1)) },
        uSize: { value: 7 },
        uMode: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.layers.set(1);
  }

  setColors(colors: [number, number, number][]): void {
    const uniform = this.material.uniforms.uColors.value as THREE.Color[];
    colors.slice(0, MAX_COLORS).forEach((color, index) => uniform[index].setRGB(color[0], color[1], color[2], THREE.SRGBColorSpace));
  }

  setMode(mode: 'odor' | 'air' | 'off', size: number): void {
    this.material.uniforms.uMode.value = mode === 'air' ? 1 : 0;
    this.material.uniforms.uSize.value = size;
    this.points.visible = mode !== 'off';
  }

  update(data: Float32Array): void {
    const count = data.length / 4;
    if (count !== this.capacity) {
      this.capacity = count;
      this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      this.geometry.setAttribute('attr', new THREE.BufferAttribute(new Float32Array(count), 1));
    }
    const positions = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const attributes = this.geometry.getAttribute('attr') as THREE.BufferAttribute;
    const p = positions.array as Float32Array;
    const a = attributes.array as Float32Array;
    for (let index = 0; index < count; index++) {
      p[index * 3] = data[index * 4];
      p[index * 3 + 1] = data[index * 4 + 1];
      p[index * 3 + 2] = data[index * 4 + 2];
      a[index] = data[index * 4 + 3];
    }
    positions.needsUpdate = true;
    attributes.needsUpdate = true;
  }
}

/** Instanced arrows showing the air velocity on a horizontal plane. */
export class FlowArrows {
  readonly mesh: THREE.InstancedMesh;
  private readonly maxInstances = 6000;
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  height = 1.2;

  constructor() {
    const geometry = new THREE.ConeGeometry(0.035, 0.16, 6);
    geometry.rotateX(Math.PI / 2); // point along +z
    this.mesh = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial({ toneMapped: false }), this.maxInstances);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(1);
  }

  update(data: Float32Array, dims: [number, number, number], cellSize: number): void {
    const [dx, dy, dz] = dims;
    // snapshot sample (i, j, k) is grid cell 1 + 2i, centered at (2i + 0.5) * cellSize
    const layer = Math.min(dy - 1, Math.max(0, Math.round((this.height / cellSize - 0.5) / 2)));
    let count = 0;
    const forward = new THREE.Vector3(0, 0, 1);
    const direction = new THREE.Vector3();
    for (let k = 0; k < dz; k++) {
      for (let i = 0; i < dx; i++) {
        if (count >= this.maxInstances) break;
        const o = (i + dx * (layer + dy * k)) * 3;
        direction.set(data[o], data[o + 1], data[o + 2]);
        const speed = direction.length();
        if (speed < 0.015) continue;
        direction.divideScalar(speed);
        this.dummy.position.set((2 * i + 0.5) * cellSize, (2 * layer + 0.5) * cellSize, (2 * k + 0.5) * cellSize);
        this.dummy.quaternion.setFromUnitVectors(forward, direction);
        const scale = Math.min(2.2, 0.35 + speed * 1.4);
        this.dummy.scale.set(scale * 0.8, scale * 0.8, scale);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(count, this.dummy.matrix);
        const t = Math.min(1, speed / 1.5);
        this.color.setHSL(0.6 - 0.6 * t, 0.85, 0.55);
        this.mesh.setColorAt(count, this.color);
        count++;
      }
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
