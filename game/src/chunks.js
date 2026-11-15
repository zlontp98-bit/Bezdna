import * as THREE from '../vendor/three.min.js';

// Меш куска скалы с мировыми координатами в вершинах (шейдер скалы берёт position как мировую точку).
// Объект ставим в центр куска: по нему three.js сортирует непрозрачное «от ближнего к дальнему»
// (дальние пиксели отбрасываются тестом глубины — меньше перерисовки дорогим шейдером), а сферу
// для отсечения по камере задаём вокруг этого центра — куски вне кадра не рисуются вовсе.
export function chunkMesh(geo, material) {
  geo.computeBoundingSphere();
  const c = geo.boundingSphere.center.clone(), r = geo.boundingSphere.radius;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), r);
  const m = new THREE.Mesh(geo, material);
  m.position.copy(c);
  m.updateMatrix(); m.updateMatrixWorld(true);
  m.matrixAutoUpdate = false;
  return m;
}
