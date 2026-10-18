// Room shell (floor, inward-facing walls, ceiling) and the meshes of all layout items.

import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { getSourceType } from '../chem/sourceTypes';
import type { FanItem, Layout } from '../types';
import { buildItemView, type ItemView } from './itemMeshes';

function floorTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext('2d')!;
  const plankHeight = 64;
  for (let row = 0; row < 512 / plankHeight; row++) {
    let x = -((row * 137) % 256);
    while (x < 512) {
      const length = 180 + ((row * 53 + x) % 140);
      const tone = 150 + ((row * 31 + x * 7) % 30);
      context.fillStyle = `rgb(${tone + 25}, ${tone - 5}, ${tone - 45})`;
      context.fillRect(x, row * plankHeight, length, plankHeight);
      for (let grain = 0; grain < 14; grain++) {
        context.strokeStyle = `rgba(90, 60, 30, ${0.05 + (grain % 3) * 0.03})`;
        context.beginPath();
        const gy = row * plankHeight + 4 + grain * 4.3;
        context.moveTo(x, gy);
        context.bezierCurveTo(x + length * 0.3, gy + 2, x + length * 0.6, gy - 2, x + length, gy + 1);
        context.stroke();
      }
      context.fillStyle = 'rgba(40, 25, 10, 0.55)';
      context.fillRect(x, row * plankHeight, 2, plankHeight);
      x += length;
    }
    context.fillStyle = 'rgba(40, 25, 10, 0.6)';
    context.fillRect(0, row * plankHeight, 512, 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

export class RoomView {
  readonly group = new THREE.Group();
  private shell = new THREE.Group();
  private items = new THREE.Group();
  views = new Map<string, ItemView>();
  private labelObjects: CSS2DObject[] = [];
  private floorMap = floorTexture();
  labelsVisible = true;
  ceiling: THREE.Mesh | null = null;

  constructor() {
    this.group.add(this.shell, this.items);
  }

  build(layout: Layout, fanDirection: (fan: FanItem, time: number) => [number, number, number]): void {
    this.buildShell(layout);
    for (const label of this.labelObjects) label.element.remove();
    this.labelObjects = [];
    this.items.clear();
    this.views.clear();
    const height = layout.room.height;
    for (const item of layout.items) {
      const view = buildItemView(item, height, fanDirection);
      if (!view) continue;
      this.items.add(view.object);
      this.views.set(item.id, view);
      if (item.type === 'source') {
        const type = getSourceType(item.sourceType);
        const element = document.createElement('div');
        element.className = 'source-label' + (item.emitting ? '' : ' off');
        element.innerHTML = `<span class="dot" style="background:${type.color}"></span>${item.name}`;
        const label = new CSS2DObject(element);
        label.position.set(0, item.y + type.size[1] + 0.12, 0);
        label.layers.set(1);
        label.visible = this.labelsVisible;
        view.object.add(label);
        this.labelObjects.push(label);
      }
    }
  }

  private buildShell(layout: Layout): void {
    this.shell.clear();
    const { width, depth, height } = layout.room;
    this.floorMap.repeat.set(width / 2.4, depth / 2.4);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), new THREE.MeshStandardMaterial({ map: this.floorMap, roughness: 0.65, metalness: 0 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(width / 2, 0, depth / 2);
    floor.receiveShadow = true;
    floor.userData.floor = true;
    this.shell.add(floor);

    // Inward-facing walls: back-face culling hides whichever walls face the camera from outside.
    const wallMaterial = new THREE.MeshStandardMaterial({ color: '#ece7df', roughness: 0.95 });
    const walls: [number, number, number, number, number][] = [
      [width / 2, depth, width, 0, Math.PI], // far wall (z = depth), faces -z
      [width / 2, 0, width, 0, 0], // near wall (z = 0), faces +z
      [0, depth / 2, depth, Math.PI / 2, 0], // x = 0 wall, faces +x
      [width, depth / 2, depth, -Math.PI / 2, 0], // x = width wall, faces -x
    ];
    for (const [x, z, length, yaw, extraYaw] of walls) {
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(length, height), wallMaterial);
      wall.position.set(x, height / 2, z);
      wall.rotation.y = yaw + extraYaw;
      wall.receiveShadow = true;
      this.shell.add(wall);
    }
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), new THREE.MeshStandardMaterial({ color: '#f4f2ee', roughness: 0.95 }));
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(width / 2, height, depth / 2);
    this.shell.add(ceiling);
    this.ceiling = ceiling;

    // Baseboards and a top outline keep the room readable when walls are culled.
    const trim = new THREE.MeshStandardMaterial({ color: '#cfc8bd', roughness: 0.6 });
    const t = 0.03;
    const boards: [number, number, number, number][] = [
      [width / 2, t / 2, width, t],
      [width / 2, depth - t / 2, width, t],
      [t / 2, depth / 2, t, depth],
      [width - t / 2, depth / 2, t, depth],
    ];
    for (const [x, z, w, d] of boards) {
      const board = new THREE.Mesh(new THREE.BoxGeometry(w, 0.09, d), trim);
      board.position.set(x, 0.045, z);
      board.receiveShadow = true;
      this.shell.add(board);
    }
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(width, height, depth)),
      new THREE.LineBasicMaterial({ color: '#8aa0b8', transparent: true, opacity: 0.35 }),
    );
    outline.position.set(width / 2, height / 2, depth / 2);
    outline.layers.set(1);
    this.shell.add(outline);
  }

  update(realTime: number, simTime: number, dt: number): void {
    for (const view of this.views.values()) view.update?.(realTime, simTime, dt);
  }

  setLabelsVisible(visible: boolean): void {
    this.labelsVisible = visible;
    for (const label of this.labelObjects) label.visible = visible;
  }

  pickables(): THREE.Object3D[] {
    return [...this.items.children];
  }

  floorMesh(): THREE.Object3D | undefined {
    return this.shell.children.find((child) => child.userData.floor);
  }
}
