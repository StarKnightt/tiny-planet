// Stand-in ground for testing the flora before/without the real terrain system.
// Only used by grass.ts in shot mode when `?only=` excludes terrain.
import * as THREE from 'three';
import { applyPlanetLighting } from '../core/lighting';
import { biomeAt, heightAt, R } from '../core/terrain';

export function makeDebugGround(): THREE.Mesh {
  const g = new THREE.SphereGeometry(1, 360, 240);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const d = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    d.fromBufferAttribute(pos, i).normalize();
    const h = heightAt(d);
    pos.setXYZ(i, d.x * (R + h), d.y * (R + h), d.z * (R + h));
    if (h < 0) c.setRGB(0.1, 0.35, 0.45);
    else {
      const b = biomeAt(d);
      c.setRGB(0.36, 0.5, 0.17).lerp(new THREE.Color(0.85, 0.75, 0.55), b.sand).lerp(new THREE.Color(0.5, 0.48, 0.45), b.rock);
    }
    c.convertSRGBToLinear();
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, applyPlanetLighting(new THREE.MeshLambertMaterial({ vertexColors: true })));
  m.receiveShadow = true;
  m.castShadow = true;
  return m;
}
