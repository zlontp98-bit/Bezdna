import * as THREE from '../vendor/three.min.js';
import { buildModel } from './player.js';

export function createTitleStage(canvas) {
  const renderer = new THREE.WebGLRenderer({canvas, alpha:true, antialias:true, powerPreference:'low-power'});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setClearColor(0, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-2, 2, 1.2, -1.2, .1, 15);
  camera.position.set(0, 1.85, 5);
  camera.lookAt(0, .94, 0);
  scene.add(new THREE.HemisphereLight(0xf0fbff, 0x80919f, 1.55));
  const key = new THREE.DirectionalLight(0xffedca, 1.7);
  key.position.set(-2, 4, 3);
  scene.add(key);
  const glint = new THREE.PointLight(0x92eeff, 5, 6);
  scene.add(glint);
  const skin = new THREE.MeshStandardMaterial({vertexColors:true, roughness:.82});
  let hero, angle = -.18;

  function setLook(look) {
    if (hero) {
      scene.remove(hero.root);
      hero.root.traverse(part => { if (part.isMesh) part.geometry.dispose(); });
    }
    hero = buildModel(look);
    hero.root.traverse(part => { if (part.isMesh) part.material = skin; });
    hero.tools.pickaxe.visible = true;
    scene.add(hero.root);
  }

  const crystal = new THREE.MeshPhysicalMaterial({
    color:0x309eff, emissive:0x074dac, emissiveIntensity:.48,
    roughness:.16, metalness:.16, clearcoat:1, flatShading:true
  });
  // Unequal hexagonal prisms with a long body and a sharply tapered crown.
  const tips = [];
  for (const [x,z,h,r,tilt] of [[.86,.13,.83,.14,-.21],[.68,.17,.47,.105,.23],[1,.09,.38,.08,-.48],[-.88,-.22,.46,.105,.27],[-.73,-.19,.28,.082,-.22]]) {
    const group = new THREE.Group();
    group.position.set(x, .01, z);
    group.rotation.z = tilt;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(r,r*.64,h*.69,6), crystal);
    body.position.y = h*.345;
    const crown = new THREE.Mesh(new THREE.ConeGeometry(r,h*.31,6), crystal);
    crown.position.y = h*.845;
    group.add(body,crown);
    scene.add(group);
    tips.push(group.localToWorld(new THREE.Vector3(0,h,0)));
  }
  const count = 40;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count*3);
  const opacity = new Float32Array(count);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions,3));
  geometry.setAttribute('opacity', new THREE.BufferAttribute(opacity,1));
  const sparks = new THREE.Points(geometry, new THREE.ShaderMaterial({
    uniforms:{scale:{value:4}}, transparent:true, depthWrite:false, blending:THREE.AdditiveBlending,
    vertexShader:'attribute float opacity;varying float alpha;uniform float scale;void main(){alpha=opacity;gl_PointSize=scale*(0.6+opacity);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader:'varying float alpha;void main(){float d=length(gl_PointCoord-.5)*2.;gl_FragColor=vec4(.48,.91,1.,alpha*(1.-smoothstep(.12,1.,d)));}'
  }));
  sparks.frustumCulled = false;
  scene.add(sparks);
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w,h,false);
    camera.right = Math.max(1.16,1.13*w/h);
    camera.left = -camera.right;
    camera.top = camera.right*h/w;
    camera.bottom = -camera.top;
    camera.updateProjectionMatrix();
    sparks.material.uniforms.scale.value = Math.max(2, h/96)*renderer.getPixelRatio();
  }
  new ResizeObserver(resize).observe(canvas);
  resize();
  let pointer = null, lastX;
  canvas.addEventListener('pointerdown', e => {
    if (pointer !== null || e.button !== 0) return;
    pointer = e.pointerId;
    lastX = e.clientX;
    canvas.setPointerCapture(pointer);
  });
  canvas.addEventListener('pointermove', e => {
    if (e.pointerId !== pointer) return;
    angle += (e.clientX-lastX)*Math.PI*2/Math.max(120,canvas.clientWidth*.7);
    lastX = e.clientX;
  });
  canvas.addEventListener('lostpointercapture', e => { if (pointer === e.pointerId) pointer = null; });
  canvas.addEventListener('keydown', e => {
    if (!['ArrowLeft','ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    angle += e.key === 'ArrowRight' ? .18 : -.18;
  });
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let lastFrame = -100;
  function draw(now) {
    if (!hero || now-lastFrame < 32 || document.hidden) return;
    lastFrame = now;
    const time = motion.matches ? 0 : now/1000;
    hero.root.rotation.y = angle;
    hero.head.rotation.z = Math.sin(time*1.4)*.019;
    glint.position.set(Math.cos(time*.8)*1.4,1+.3*Math.sin(time),1.2);
    for (let i=0;i<count;i++) {
      const tip = tips[i%tips.length];
      const age = (time*(.42+.03*(i%7))+i*.618034)%1;
      const drift = i*2.4+age*2;
      positions[3*i] = tip.x + age*.17*Math.sin(drift);
      positions[3*i+1] = tip.y + age*(.36+.06*(i%5));
      positions[3*i+2] = tip.z + age*.13*Math.cos(drift);
      opacity[i] = Math.sin(Math.PI*age);
    }
    geometry.attributes.position.needsUpdate = geometry.attributes.opacity.needsUpdate = true;
    renderer.render(scene,camera);
  }
  return {setLook,draw};
}
