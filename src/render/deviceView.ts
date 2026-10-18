// 3D model of the handheld e-nose with a live LCD, glowing snout and side inlet.
//
// Local frame: the snout points along -Z, the screen faces +Y.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

const BODY = { w: 0.105, h: 0.05, d: 0.23 };
const SNOUT_LENGTH = 0.07;
export const SNOUT_TIP_LOCAL = new THREE.Vector3(0, 0, -(BODY.d / 2 + SNOUT_LENGTH));
export const SIDE_INLET_LOCAL = new THREE.Vector3(-BODY.w / 2 - 0.004, 0, -0.04);

export interface ScreenState {
  title: string;
  status: string;
  progress: number; // 0..1, < 0 hides the bar
  lines: string[];
  pump: 'snout' | 'side' | 'none';
}

export class DeviceView {
  readonly group = new THREE.Group();
  private screenCanvas = document.createElement('canvas');
  private screenTexture: THREE.CanvasTexture;
  private snoutRing: THREE.Mesh;
  private sideInlet: THREE.Mesh;
  private ringMaterial: THREE.MeshBasicMaterial;
  private sideMaterial: THREE.MeshBasicMaterial;
  private intakeParticles: THREE.Points;
  private intakePositions: Float32Array;
  private lastScreenKey = '';
  readonly camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.005, 30);
  // world-space helpers that make the small device easy to find in a big room
  readonly locator = new THREE.Group();
  readonly rig = new THREE.Group(); // camera mount on top of the instrument
  private locatorLine: THREE.Line;
  private locatorRing: THREE.Mesh;
  private locatorTag: CSS2DObject;
  pump: 'snout' | 'side' | 'none' = 'side';

  constructor() {
    const body = new THREE.Mesh(new RoundedBoxGeometry(BODY.w, BODY.h, BODY.d, 5, 0.018), new THREE.MeshStandardMaterial({ color: '#30353d', roughness: 0.55, metalness: 0.1 }));
    body.castShadow = true;
    this.group.add(body);
    const grip = new THREE.Mesh(new RoundedBoxGeometry(BODY.w * 1.02, BODY.h * 0.55, BODY.d * 0.45, 4, 0.012), new THREE.MeshStandardMaterial({ color: '#1d2126', roughness: 0.9 }));
    grip.position.set(0, -BODY.h * 0.12, BODY.d * 0.2);
    this.group.add(grip);
    const band = new THREE.Mesh(new THREE.BoxGeometry(BODY.w * 1.01, 0.008, BODY.d * 0.98), new THREE.MeshStandardMaterial({ color: '#f2b134', roughness: 0.5 }));
    band.position.y = -BODY.h * 0.05;
    this.group.add(band);

    // screen
    this.screenCanvas.width = 320;
    this.screenCanvas.height = 220;
    this.screenTexture = new THREE.CanvasTexture(this.screenCanvas);
    this.screenTexture.colorSpace = THREE.SRGBColorSpace;
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(0.078, 0.004, 0.064), new THREE.MeshStandardMaterial({ color: '#111418', roughness: 0.3 }));
    bezel.position.set(0, BODY.h / 2 + 0.001, -0.005);
    this.group.add(bezel);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.055), new THREE.MeshBasicMaterial({ map: this.screenTexture, toneMapped: false }));
    screen.rotation.x = -Math.PI / 2;
    screen.position.set(0, BODY.h / 2 + 0.0035, -0.005);
    this.group.add(screen);

    // buttons
    const buttonColors = ['#5fd38d', '#9aa4b1', '#9aa4b1', '#ff6b6b'];
    buttonColors.forEach((color, index) => {
      const button = new THREE.Mesh(new THREE.CylinderGeometry(0.0065, 0.0065, 0.004, 16), new THREE.MeshStandardMaterial({ color, roughness: 0.4 }));
      button.position.set(-0.03 + index * 0.02, BODY.h / 2 + 0.002, 0.05);
      this.group.add(button);
    });

    // snout: tapered nozzle with a glowing tip ring
    const snout = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.011, SNOUT_LENGTH, 20), new THREE.MeshStandardMaterial({ color: '#c7ccd3', roughness: 0.25, metalness: 0.9 }));
    snout.rotation.x = Math.PI / 2;
    snout.position.z = -(BODY.d / 2 + SNOUT_LENGTH / 2);
    snout.castShadow = true;
    this.group.add(snout);
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.018, 0.012, 24), new THREE.MeshStandardMaterial({ color: '#1d2126', roughness: 0.6 }));
    collar.rotation.x = Math.PI / 2;
    collar.position.z = -(BODY.d / 2 + 0.004);
    this.group.add(collar);
    this.ringMaterial = new THREE.MeshBasicMaterial({ color: '#4cf2ff', toneMapped: false });
    this.snoutRing = new THREE.Mesh(new THREE.TorusGeometry(0.0055, 0.0018, 8, 20), this.ringMaterial);
    this.snoutRing.position.copy(SNOUT_TIP_LOCAL);
    this.group.add(this.snoutRing);

    // side purge/baseline inlet
    this.sideMaterial = new THREE.MeshBasicMaterial({ color: '#ffd166', toneMapped: false });
    this.sideInlet = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.004, 16), this.sideMaterial);
    this.sideInlet.rotation.z = Math.PI / 2;
    this.sideInlet.position.copy(SIDE_INLET_LOCAL);
    this.group.add(this.sideInlet);
    const exhaust = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.003, 0.012), new THREE.MeshStandardMaterial({ color: '#111', roughness: 0.8 }));
    exhaust.position.set(0, -BODY.h / 2 - 0.001, BODY.d / 2 - 0.03);
    this.group.add(exhaust);

    // small camera on top, looking down the snout (like a capture rig)
    const cameraBody = new THREE.Mesh(new RoundedBoxGeometry(0.04, 0.009, 0.02, 3, 0.003), new THREE.MeshStandardMaterial({ color: '#d9dde2', roughness: 0.35, metalness: 0.4 }));
    cameraBody.position.set(0, BODY.h / 2 + 0.03, -0.07);
    cameraBody.rotation.x = 0.5;
    this.rig.add(cameraBody);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.03, 8), new THREE.MeshStandardMaterial({ color: '#888', metalness: 0.8, roughness: 0.3 }));
    mast.position.set(0, BODY.h / 2 + 0.015, -0.06);
    this.rig.add(mast);
    this.group.add(this.rig);
    this.camera.position.set(0, BODY.h / 2 + 0.03, -0.09);
    this.camera.lookAt(SNOUT_TIP_LOCAL.clone().add(new THREE.Vector3(0, -0.03, -0.06)));
    this.group.add(this.camera);

    // little stream of particles drawn into the active inlet
    const count = 40;
    this.intakePositions = new Float32Array(count * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.intakePositions, 3));
    this.intakeParticles = new THREE.Points(geometry, new THREE.PointsMaterial({ color: '#bff6ff', size: 0.004, transparent: true, opacity: 0.8, depthWrite: false }));
    this.intakeParticles.frustumCulled = false;
    this.intakeParticles.layers.set(1);
    this.group.add(this.intakeParticles);

    this.group.traverse((child) => {
      child.userData.device = true;
    });

    this.locatorLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]),
      new THREE.LineDashedMaterial({ color: '#f2b134', dashSize: 0.06, gapSize: 0.05, transparent: true, opacity: 0.8 }),
    );
    this.locatorRing = new THREE.Mesh(
      new THREE.RingGeometry(0.12, 0.15, 40),
      new THREE.MeshBasicMaterial({ color: '#f2b134', transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.locatorRing.rotation.x = -Math.PI / 2;
    const tag = document.createElement('div');
    tag.className = 'device-tag';
    tag.textContent = 'E-NOSE';
    this.locatorTag = new CSS2DObject(tag);
    this.locator.add(this.locatorLine, this.locatorRing, this.locatorTag);
    this.locator.traverse((child) => {
      child.layers.set(1);
      child.userData.device = true;
    });
  }

  snoutTipWorld(target = new THREE.Vector3()): THREE.Vector3 {
    return target.copy(SNOUT_TIP_LOCAL).applyMatrix4(this.group.matrixWorld);
  }

  sideInletWorld(target = new THREE.Vector3()): THREE.Vector3 {
    return target.copy(SIDE_INLET_LOCAL).applyMatrix4(this.group.matrixWorld);
  }

  update(realTime: number): void {
    const tip = this.snoutTipWorld();
    const top = new THREE.Vector3().setFromMatrixPosition(this.group.matrixWorld);
    const positions = this.locatorLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    positions.setXYZ(0, tip.x, 0.01, tip.z);
    positions.setXYZ(1, tip.x, tip.y, tip.z);
    positions.needsUpdate = true;
    this.locatorLine.computeLineDistances();
    this.locatorRing.position.set(tip.x, 0.012, tip.z);
    const scale = 1 + 0.15 * Math.sin(realTime * 3);
    this.locatorRing.scale.set(scale, scale, scale);
    this.locatorTag.position.set(top.x, top.y + 0.12, top.z);
    const pulse = 0.55 + 0.45 * Math.sin(realTime * 6);
    this.ringMaterial.color.set(this.pump === 'snout' ? '#4cf2ff' : '#24414a').multiplyScalar(this.pump === 'snout' ? 0.6 + pulse : 1);
    this.sideMaterial.color.set(this.pump === 'side' ? '#ffd166' : '#4a4030').multiplyScalar(this.pump === 'side' ? 0.6 + pulse : 1);
    const target = this.pump === 'snout' ? SNOUT_TIP_LOCAL : SIDE_INLET_LOCAL;
    const outward = this.pump === 'snout' ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(-1, 0, 0);
    const count = this.intakePositions.length / 3;
    for (let index = 0; index < count; index++) {
      const phase = (realTime * 0.8 + index / count) % 1;
      const radius = 0.05 * (1 - phase);
      const angle = index * 2.399 + realTime * 0.5;
      const spread = new THREE.Vector3(Math.cos(angle), Math.sin(angle), Math.cos(angle * 1.3)).multiplyScalar(radius * 0.5);
      const position = target.clone().addScaledVector(outward, radius).add(spread);
      this.intakePositions[index * 3] = position.x;
      this.intakePositions[index * 3 + 1] = position.y;
      this.intakePositions[index * 3 + 2] = position.z;
    }
    this.intakeParticles.visible = this.pump !== 'none';
    (this.intakeParticles.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  drawScreen(state: ScreenState): void {
    const key = JSON.stringify(state);
    if (key === this.lastScreenKey) return;
    this.lastScreenKey = key;
    const context = this.screenCanvas.getContext('2d')!;
    const { width, height } = this.screenCanvas;
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#b9d98c');
    gradient.addColorStop(1, '#9fc271');
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#1f2a14';
    context.font = 'bold 22px monospace';
    context.fillText(state.title, 12, 30);
    context.fillRect(12, 38, width - 24, 2);
    context.font = 'bold 26px monospace';
    context.fillText(state.status, 12, 74);
    if (state.progress >= 0) {
      context.strokeStyle = '#1f2a14';
      context.lineWidth = 2;
      context.strokeRect(12, 86, width - 24, 18);
      context.fillRect(15, 89, (width - 30) * Math.min(1, state.progress), 12);
    }
    context.font = '20px monospace';
    state.lines.slice(0, 4).forEach((line, index) => context.fillText(line, 12, 132 + index * 24));
    context.font = 'bold 16px monospace';
    context.fillText(state.pump === 'snout' ? 'PUMP: SNOUT' : state.pump === 'side' ? 'PUMP: SIDE' : 'PUMP: OFF', width - 140, 30);
    this.screenTexture.needsUpdate = true;
  }
}
