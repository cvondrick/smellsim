// Interactive room editing in the 3D view: select, move, rotate, place, draw walls, delete.

import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { createBlock, createItem, newId, restsOnSurface } from '../room/layoutUtils';
import { surfaceHeightAt } from '../room/voxelize';
import type { BlockKind, Item, ItemType } from '../types';
import type { App } from '../app';

export type Placement = { type: ItemType; variant?: string } | { type: 'wall-draw' };

export class Editor {
  private app: App;
  readonly transform: TransformControls;
  selectedId: string | null = null; // item id or 'device'
  placing: Placement | null = null;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private ghost: THREE.Mesh;
  private wallStart: THREE.Vector3 | null = null;
  private wallPreview: THREE.Mesh;
  private dragging = false;
  private lastLiveUpdate = 0;
  private downAt = { x: 0, y: 0 };
  private selectionBox: THREE.BoxHelper;

  constructor(app: App) {
    this.app = app;
    const renderer = app.renderer;
    this.raycaster.layers.enableAll();
    this.transform = new TransformControls(renderer.camera, renderer.renderer.domElement);
    this.transform.setSize(0.8);
    renderer.overlay.add(this.transform.getHelper());
    this.transform.addEventListener('dragging-changed', (event) => {
      const dragging = (event as unknown as { value: boolean }).value;
      this.dragging = dragging;
      app.orbit.enabled = !dragging;
      if (!dragging) this.commitTransform();
    });
    this.transform.addEventListener('objectChange', () => this.onObjectChange());

    this.ghost = new THREE.Mesh(
      new THREE.CylinderGeometry(0.25, 0.25, 0.02, 32),
      new THREE.MeshBasicMaterial({ color: '#4cf2ff', transparent: true, opacity: 0.5, depthTest: false }),
    );
    this.ghost.visible = false;
    renderer.overlay.add(this.ghost);
    this.wallPreview = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: '#4cf2ff', transparent: true, opacity: 0.35 }));
    this.wallPreview.visible = false;
    renderer.overlay.add(this.wallPreview);
    this.selectionBox = new THREE.BoxHelper(new THREE.Object3D(), '#4cf2ff');
    this.selectionBox.visible = false;
    renderer.overlay.add(this.selectionBox);

    const canvas = renderer.renderer.domElement;
    canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
    canvas.addEventListener('pointerup', (event) => this.onPointerUp(event));
    window.addEventListener('keydown', (event) => this.onKeyDown(event));
  }

  private setPointer(event: PointerEvent): void {
    const rect = this.app.renderer.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.app.renderer.camera);
  }

  private floorPoint(): THREE.Vector3 | null {
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.floorPlane, point)) return null;
    const room = this.app.layout.room;
    point.x = Math.min(room.width - 0.05, Math.max(0.05, point.x));
    point.z = Math.min(room.depth - 0.05, Math.max(0.05, point.z));
    return point;
  }

  startPlacing(placement: Placement | null): void {
    this.placing = placement;
    this.ghost.visible = false;
    this.wallStart = null;
    this.wallPreview.visible = false;
    this.app.setHint(
      placement
        ? placement.type === 'wall-draw'
          ? 'Drag on the floor to draw a wall. Esc to cancel.'
          : 'Click on the floor to place. Esc to cancel.'
        : null,
    );
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || this.app.cameraMode === 'walk') return;
    this.downAt = { x: event.clientX, y: event.clientY };
    this.setPointer(event);
    if (this.placing?.type === 'wall-draw') {
      const point = this.floorPoint();
      if (point) {
        this.wallStart = point;
        this.app.orbit.enabled = false;
      }
    }
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.app.cameraMode === 'walk') return;
    this.setPointer(event);
    if (!this.placing) return;
    const point = this.floorPoint();
    if (!point) return;
    if (this.placing.type === 'wall-draw') {
      if (this.wallStart) {
        const wall = this.wallFromDrag(this.wallStart, point);
        this.wallPreview.visible = true;
        this.wallPreview.position.set(wall.x, wall.h / 2, wall.z);
        this.wallPreview.rotation.y = wall.yaw;
        this.wallPreview.scale.set(wall.w, wall.h, wall.d);
      }
      return;
    }
    this.ghost.visible = true;
    this.ghost.position.set(point.x, surfaceHeightAt(this.app.layout, point.x, point.z) + 0.01, point.z);
  }

  private onPointerUp(event: PointerEvent): void {
    if (event.button !== 0 || this.app.cameraMode === 'walk') return;
    const moved = Math.hypot(event.clientX - this.downAt.x, event.clientY - this.downAt.y) > 5;
    this.setPointer(event);
    if (this.placing?.type === 'wall-draw') {
      if (this.wallStart) {
        const point = this.floorPoint();
        if (point && point.distanceTo(this.wallStart) > 0.2) {
          const wall = this.wallFromDrag(this.wallStart, point);
          const item = createBlock('wall', wall.x, wall.z, { w: wall.w, d: wall.d, h: wall.h, yaw: wall.yaw });
          this.app.layout.items.push(item);
          this.app.commitLayout();
          this.select(item.id);
        }
        this.wallStart = null;
        this.wallPreview.visible = false;
        this.app.orbit.enabled = true;
      }
      return;
    }
    if (moved || this.dragging) return;
    if (this.placing) {
      const point = this.floorPoint();
      if (point) this.place(point, event.shiftKey);
      return;
    }
    this.pick();
  }

  private wallFromDrag(start: THREE.Vector3, end: THREE.Vector3): { x: number; z: number; w: number; d: number; h: number; yaw: number } {
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    let angle = Math.atan2(-dz, dx); // yaw so that local +x runs along the drag
    const snap = Math.PI / 12;
    angle = Math.round(angle / snap) * snap;
    const length = Math.hypot(dx, dz);
    return {
      x: start.x + Math.cos(angle) * (length / 2),
      z: start.z - Math.sin(angle) * (length / 2),
      w: length,
      d: 0.12,
      h: this.app.layout.room.height,
      yaw: angle,
    };
  }

  /** Place the pending item; holding shift keeps placing more of the same. */
  private place(point: THREE.Vector3, keepPlacing: boolean): void {
    if (!this.placing || this.placing.type === 'wall-draw') return;
    const item = createItem(this.placing.type, point.x, point.z, this.placing.variant);
    if (restsOnSurface(item) && 'y' in item) (item as { y: number }).y = surfaceHeightAt(this.app.layout, point.x, point.z);
    if (item.type === 'pillar') item.h = this.app.layout.room.height;
    if (item.type === 'block' && (item.kind === 'wall' || item.kind === 'partition')) item.h = Math.min(item.h, this.app.layout.room.height);
    this.app.layout.items.push(item);
    this.app.commitLayout();
    this.select(item.id);
    if (!keepPlacing) this.startPlacing(null);
  }

  private pick(): void {
    const app = this.app;
    const targets: THREE.Object3D[] = [...app.roomView.pickables(), app.peopleView.group, app.deviceView.group];
    const hits = this.raycaster.intersectObjects(targets, true);
    for (const hit of hits) {
      let object: THREE.Object3D | null = hit.object;
      while (object) {
        if (object.userData.device) {
          this.select('device');
          return;
        }
        if (object.userData.itemId) {
          this.select(object.userData.itemId as string);
          return;
        }
        object = object.parent;
      }
    }
    this.select(null);
  }

  select(id: string | null): void {
    this.selectedId = id;
    this.transform.detach();
    this.selectionBox.visible = false;
    if (id) {
      const object = id === 'device' ? this.app.deviceView.group : this.app.objectForItem(id);
      if (object) {
        this.transform.attach(object);
        this.configureGizmo();
        this.selectionBox.setFromObject(object);
        this.selectionBox.visible = id !== 'device';
      }
    }
    this.app.onSelectionChanged(id);
  }

  private configureGizmo(): void {
    const id = this.selectedId;
    const mode = this.transform.getMode();
    if (id === 'device') {
      this.transform.showX = this.transform.showY = this.transform.showZ = true;
      if (mode === 'rotate') this.transform.setSpace('local');
      return;
    }
    if (mode === 'rotate') {
      this.transform.showX = false;
      this.transform.showY = true;
      this.transform.showZ = false;
    } else {
      const item = this.selectedItem();
      const vertical = item?.type === 'source' || item?.type === 'fan';
      this.transform.showX = true;
      this.transform.showZ = true;
      this.transform.showY = vertical;
    }
  }

  selectedItem(): Item | undefined {
    return this.app.layout.items.find((item) => item.id === this.selectedId);
  }

  /** Re-attach after the views were rebuilt. */
  refreshAttachment(): void {
    if (!this.selectedId || this.selectedId === 'device') return;
    const object = this.app.objectForItem(this.selectedId);
    if (!object) {
      this.select(null);
      return;
    }
    this.transform.attach(object);
    this.configureGizmo();
    this.selectionBox.setFromObject(object);
  }

  private onObjectChange(): void {
    const app = this.app;
    if (this.selectedId === 'device') {
      app.onDeviceMoved();
      return;
    }
    const item = this.selectedItem();
    const object = this.transform.object;
    if (!item || !object) return;
    this.applyObjectToItem(item, object);
    this.selectionBox.setFromObject(object);
    const now = performance.now();
    if (now - this.lastLiveUpdate > 200) {
      this.lastLiveUpdate = now;
      app.sendLayoutToSim();
    }
  }

  private applyObjectToItem(item: Item, object: THREE.Object3D): void {
    const room = this.app.layout.room;
    const x = Math.min(room.width - 0.02, Math.max(0.02, object.position.x));
    const z = Math.min(room.depth - 0.02, Math.max(0.02, object.position.z));
    if (item.type === 'hvac') {
      item.rx += x - item.x;
      item.rz += z - item.z;
    }
    item.x = x;
    item.z = z;
    if (item.type !== 'hvac') item.yaw = object.rotation.y;
    if (item.type === 'source') {
      const surface = surfaceHeightAt(this.app.layout, item.x, item.z);
      if (Math.abs(object.position.y) > 0.005) {
        // user dragged vertically: offset from the resting height
        item.y = Math.max(0, item.y + object.position.y);
        object.position.y = 0;
      } else if (!this.dragging) {
        item.y = surface;
      }
    }
    if (item.type === 'fan' && Math.abs(object.position.y) > 0.005) {
      item.y = Math.min(room.height - 0.3, Math.max(0.3, item.y + object.position.y));
      object.position.y = 0;
    }
  }

  private commitTransform(): void {
    if (this.selectedId === 'device') return;
    const item = this.selectedItem();
    if (item?.type === 'source') {
      item.y = surfaceHeightAt(this.app.layout, item.x, item.z, item.id) || item.y;
    }
    this.app.commitLayout();
  }

  deleteSelected(): void {
    if (!this.selectedId || this.selectedId === 'device') return;
    this.app.layout.items = this.app.layout.items.filter((item) => item.id !== this.selectedId);
    this.select(null);
    this.app.commitLayout();
  }

  duplicateSelected(): void {
    const item = this.selectedItem();
    if (!item) return;
    const copy = JSON.parse(JSON.stringify(item)) as Item;
    copy.id = newId(item.type);
    copy.x = Math.min(this.app.layout.room.width - 0.1, item.x + 0.4);
    copy.z = Math.min(this.app.layout.room.depth - 0.1, item.z + 0.4);
    if (copy.type === 'hvac' && item.type === 'hvac') {
      copy.rx = item.rx + 0.4;
      copy.rz = item.rz + 0.4;
    }
    this.app.layout.items.push(copy);
    this.app.commitLayout();
    this.select(copy.id);
  }

  private onKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
    if (this.app.cameraMode === 'walk') return;
    switch (event.key) {
      case 'Escape':
        this.startPlacing(null);
        this.select(null);
        break;
      case 'Delete':
      case 'Backspace':
        this.deleteSelected();
        event.preventDefault();
        break;
      case 'r':
      case 'R':
        if (this.selectedId) {
          this.transform.setMode(this.transform.getMode() === 'rotate' ? 'translate' : 'rotate');
          this.configureGizmo();
        }
        break;
      case 'd':
      case 'D':
        if (event.metaKey || event.ctrlKey) {
          this.duplicateSelected();
          event.preventDefault();
        }
        break;
    }
  }

  update(): void {
    if (this.selectionBox.visible && this.transform.object) this.selectionBox.setFromObject(this.transform.object);
  }
}

export const PALETTE: { label: string; type: ItemType; variant?: BlockKind | string }[] = [
  { label: 'Partition', type: 'block', variant: 'partition' },
  { label: 'Table', type: 'table' },
  { label: 'Shelf', type: 'block', variant: 'shelf' },
  { label: 'Counter', type: 'block', variant: 'counter' },
  { label: 'Sofa', type: 'block', variant: 'sofa' },
  { label: 'Cabinet', type: 'block', variant: 'cabinet' },
  { label: 'Box', type: 'block', variant: 'box' },
  { label: 'Pillar', type: 'pillar' },
  { label: 'Fan', type: 'fan' },
  { label: 'Ceiling fan', type: 'ceilingFan' },
  { label: 'Heater', type: 'heater' },
  { label: 'HVAC loop', type: 'hvac' },
  { label: 'Purifier', type: 'purifier' },
  { label: 'Person', type: 'person' },
];
