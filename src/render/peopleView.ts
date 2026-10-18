// Animated low-poly people driven by positions streamed from the simulation worker.

import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { PERSON_STRIDE, type PersonItem } from '../types';
import { material } from './itemMeshes';

interface Figure {
  root: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  bubble: CSS2DObject;
  bubbleUntil: number;
  target: THREE.Vector3;
  yaw: number;
  targetYaw: number;
  speed: number;
  phase: number;
  initialized: boolean;
}

const SKIN_TONES = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'];

function limb(length: number, radius: number, mat: THREE.Material): THREE.Group {
  const pivot = new THREE.Group();
  const capsule = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length - 2 * radius, 4, 10), mat);
  capsule.position.y = -length / 2;
  capsule.castShadow = true;
  pivot.add(capsule);
  return pivot;
}

export class PeopleView {
  readonly group = new THREE.Group();
  private figures = new Map<string, Figure>();

  sync(items: PersonItem[]): void {
    const keep = new Set(items.map((item) => item.id));
    for (const [id, figure] of this.figures) {
      if (!keep.has(id)) {
        figure.bubble.element.remove();
        this.group.remove(figure.root);
        this.figures.delete(id);
      }
    }
    items.forEach((item, index) => {
      const existing = this.figures.get(item.id);
      if (existing) {
        if (existing.root.userData.shirt !== item.shirtColor) this.recolor(existing, item);
        existing.root.traverse((child) => (child.userData.itemId = item.id));
        return;
      }
      this.figures.set(item.id, this.createFigure(item, index));
    });
  }

  private recolor(figure: Figure, item: PersonItem): void {
    figure.root.userData.shirt = item.shirtColor;
    figure.root.traverse((child) => {
      if (child instanceof THREE.Mesh && child.userData.part === 'shirt') child.material = material(item.shirtColor, 0.85);
    });
  }

  private createFigure(item: PersonItem, index: number): Figure {
    const root = new THREE.Group();
    root.userData.shirt = item.shirtColor;
    const skin = material(SKIN_TONES[index % SKIN_TONES.length], 0.7);
    const shirt = material(item.shirtColor, 0.85);
    const pants = material('#2f3742', 0.85);
    const hair = material(['#2b1d14', '#5a3825', '#1b1b1b', '#a87b4f', '#d9c08c'][index % 5], 0.9);

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.42, 4, 12), shirt);
    torso.position.y = 1.2;
    torso.scale.z = 0.65;
    torso.castShadow = true;
    torso.userData.part = 'shirt';
    root.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 14), skin);
    head.position.y = 1.62;
    head.castShadow = true;
    root.add(head);
    const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.115, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), hair);
    hairCap.position.y = 1.635;
    hairCap.rotation.x = -0.25;
    root.add(hairCap);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), skin);
    nose.position.set(0, 1.61, 0.105);
    root.add(nose);

    const leftLeg = limb(0.82, 0.075, pants);
    leftLeg.position.set(-0.09, 0.85, 0);
    const rightLeg = limb(0.82, 0.075, pants);
    rightLeg.position.set(0.09, 0.85, 0);
    const leftArm = limb(0.6, 0.05, shirt);
    leftArm.position.set(-0.23, 1.42, 0);
    const rightArm = limb(0.6, 0.05, shirt);
    rightArm.position.set(0.23, 1.42, 0);
    leftArm.children[0].userData.part = 'shirt';
    rightArm.children[0].userData.part = 'shirt';
    root.add(leftLeg, rightLeg, leftArm, rightArm);

    const element = document.createElement('div');
    element.className = 'thought';
    const bubble = new CSS2DObject(element);
    bubble.position.set(0, 2.0, 0);
    bubble.visible = false;
    root.add(bubble);

    root.position.set(item.x, 0, item.z);
    root.traverse((child) => (child.userData.itemId = item.id));
    this.group.add(root);
    return {
      root,
      leftLeg,
      rightLeg,
      leftArm,
      rightArm,
      bubble,
      bubbleUntil: 0,
      target: new THREE.Vector3(item.x, 0, item.z),
      yaw: item.yaw,
      targetYaw: item.yaw,
      speed: 0,
      phase: 0,
      initialized: false,
    };
  }

  /** Apply the latest worker state. */
  applyFrame(ids: string[], buffer: Float32Array): void {
    ids.forEach((id, index) => {
      const figure = this.figures.get(id);
      if (!figure) return;
      const base = index * PERSON_STRIDE;
      figure.target.set(buffer[base], 0, buffer[base + 1]);
      figure.targetYaw = buffer[base + 2];
      figure.speed = buffer[base + 3];
      figure.phase = buffer[base + 4];
      if (!figure.initialized) {
        figure.root.position.copy(figure.target);
        figure.yaw = figure.targetYaw;
        figure.initialized = true;
      }
    });
  }

  update(dt: number, realTime: number): void {
    const blend = 1 - Math.exp(-dt * 12);
    for (const figure of this.figures.values()) {
      figure.root.position.lerp(figure.target, blend);
      let delta = figure.targetYaw - figure.yaw;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      figure.yaw += delta * blend;
      figure.root.rotation.y = figure.yaw;
      const swing = Math.min(1, figure.speed / 1.1) * 0.55;
      const phase = figure.phase * Math.PI;
      figure.leftLeg.rotation.x = Math.sin(phase) * swing;
      figure.rightLeg.rotation.x = -Math.sin(phase) * swing;
      figure.leftArm.rotation.x = -Math.sin(phase) * swing * 0.8;
      figure.rightArm.rotation.x = Math.sin(phase) * swing * 0.8;
      figure.root.position.y = Math.abs(Math.cos(phase)) * 0.03 * (swing > 0.05 ? 1 : 0);
      if (figure.bubble.visible && realTime > figure.bubbleUntil) figure.bubble.visible = false;
    }
  }

  say(id: string, html: string, realTime: number, seconds = 4): void {
    const figure = this.figures.get(id);
    if (!figure) return;
    figure.bubble.element.innerHTML = html;
    figure.bubble.visible = true;
    figure.bubbleUntil = realTime + seconds;
  }

  isSpeaking(id: string, realTime: number): boolean {
    const figure = this.figures.get(id);
    return !!figure && figure.bubble.visible && realTime < figure.bubbleUntil;
  }
}
