// Points use [x, z, floor]. The two lake tunnels always enter the same connected network.
export function galleryPlan(chasm, entrances, random) {
  const legs = [], rooms = [], ribs = [], landings = [];
  const jitter = magnitude => (random() * 2 - 1) * magnitude;
  function point(angle, radius, floor) {
    return [chasm.x + Math.cos(angle) * radius, chasm.z + Math.sin(angle) * radius * .91, floor];
  }
  function passage(a, b, hw, H, kind = 'side') {
    legs.push({a, b, hw, H, kind});
  }
  function room(p, r, h, theme) {
    rooms.push({p, r, h, theme});
    return p;
  }
  const floors = [-202,-236,-273,-310,-350];
  let angle = -2.04;
  for (let tier = 0; tier < floors.length; tier++) {
    angle += tier ? .55+jitter(.38) : jitter(.31);
    const y = floors[tier];
    const ends = [0,1].map(side => room(point(angle + side*Math.PI, 71+jitter(3), y),
      10+random()*3, 12+random()*4, tier < 2 ? 'frost' : 'iron'));
    landings.push(ends);
    // Natural bridge: the bow is high above the next crossing. Both roots
    // extend into carved adits. The rock narrows toward its unsupported centre.
    if (tier < 4) {
      const skew = jitter(.56);
      const mouths = ends.map((p,side) => {
        const root = point(angle+side*Math.PI+skew, 60, y);
        passage(p,root,7,12);
        passage(root,point(angle+side*Math.PI+skew,46,y),8,13);
        return root;
      });
      ribs.push({a:mouths[0],b:mouths[1],bend:jitter(10),rise:2+random()*5,gap:tier === 1 || (tier === 2 && random()<.5),width:2.5+random()*2.6});
    }
    if (tier === 0) {
      passage(entrances[0], ends[0], 7, 12, 'main');
      const detour = [-49,-134,entrances[1][2]-2];
      passage(entrances[1],[-136,-68,entrances[1][2]],6,9,'main');
      passage([-136,-68,entrances[1][2]],detour,7,11,'main');
      passage(detour,ends[0],8,14,'main');
      const crown = room(point(angle-.62,104,-170),12,9,'frost');
      const rise = point(angle-1.18,113,-185);
      passage(ends[0],rise,5,9); passage(rise,crown,6,11);
    }
    if (!tier) continue;
    for (let side=0;side<2;side++) {
      const start=landings[tier-1][side], finish=ends[1-side];
      const direction = tier%2 ? 1 : -1;
      const bearing = Math.atan2((start[1]-chasm.z)/.91,start[0]-chasm.x);
      const arcEnd = Math.atan2((finish[1]-chasm.z)/.91,finish[0]-chasm.x);
      const sweep = direction*((direction*(arcEnd-bearing)+Math.PI*4)%(Math.PI*2));
      const near = point(bearing+sweep*(.23+jitter(.035)),78+jitter(7),floors[tier-1]-9);
      const mid = point(bearing+sweep*(.50+jitter(.045)),85+jitter(9),y+19);
      const far = point(bearing+sweep*(.77+jitter(.035)),80+jitter(6),y+8);
      const avenue = side===tier%2 ? 'main' : 'rough';
      passage(start,near,6.8,11,avenue); passage(near,mid,10,17,avenue);
      passage(mid,far,6.4,13,avenue); passage(far,finish,6.7,10,avenue);
      // A second loop passes behind a spine of intact stone; the brood and
      // seam chambers open from different sides on different world seeds.
      const nest = side === (tier%2);
      const chamber = room(point(bearing+sweep*(.46+jitter(.05)),119+jitter(8),y+15),
        nest ? 13 : 10, nest ? 12 : 9,nest ? 'brood' : 'iron');
      const outlet = point(bearing+sweep*(.67+jitter(.035)),113+jitter(5),y+12);
      passage(near,chamber,3.1,5); passage(chamber,outlet,3.6,6);
      passage(outlet,far,3.0,5.4);
      const spur=room(point(bearing+sweep*(.55+jitter(.04)),125+jitter(3),y+11),6.5,6,'vein');
      passage(chamber,spur,2.7,4.8);
      if(random()<.56) passage(mid,chamber,3.4,5.5);
    }
  }
  return {legs,rooms,ribs};
}
