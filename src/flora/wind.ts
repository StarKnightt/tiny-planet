// Shared wind field for everything that grows (grass, flowers, trees, bushes).
// A pure function of world position and time, evaluated in vertex shaders, so the grass and the
// pines bend together under the same gusts.
//
// The air flows around a fixed tilted axis (like a trade wind circling the planet). The gust
// pattern is 3D value noise sampled in a frame that rotates with that flow, so gust patches travel
// across the surface in the wind direction at ~4.5 m/s, forming waves that roll over the hills.

/** Axis the wind circulates around (unit). */
export const WIND_AXIS: [number, number, number] = [0.2318, 0.9273, 0.2936];
/** Angular speed of the gust pattern around the axis, radians per second (x R ~ 4.5 m/s). */
export const WIND_OMEGA = 0.075;

const f = (x: number) => x.toFixed(5);
// a unit vector perpendicular to the axis (reference for the longitude of the wave fronts)
const B1 = (() => {
  const [ax, ay, az] = WIND_AXIS;
  // cross(axis, z)
  const x = ay, y = -ax, z = 0;
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
})();

/**
 * GLSL helpers. Does not declare uTime (pass time in): it is included after PLANET_GLSL in lit
 * materials, and with its own uniform in depth materials.
 */
export const WIND_GLSL = /* glsl */ `
#ifndef FLORA_WIND
#define FLORA_WIND
float flHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float flNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 g = fract(x);
  g = g * g * (3.0 - 2.0 * g);
  return mix(mix(mix(flHash(i), flHash(i + vec3(1, 0, 0)), g.x),
                 mix(flHash(i + vec3(0, 1, 0)), flHash(i + vec3(1, 1, 0)), g.x), g.y),
             mix(mix(flHash(i + vec3(0, 0, 1)), flHash(i + vec3(1, 0, 1)), g.x),
                 mix(flHash(i + vec3(0, 1, 1)), flHash(i + vec3(1, 1, 1)), g.x), g.y), g.z);
}
const vec3 FL_WIND_AXIS = vec3(${f(WIND_AXIS[0])}, ${f(WIND_AXIS[1])}, ${f(WIND_AXIS[2])});

vec3 flRotate(vec3 v, vec3 k, float a) {
  float c = cos(a), s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}

// dir: unit tangent wind direction at p (zero near the axis poles).
// gust: 0..1 strength of the travelling gust field (calm troughs, strong crests).
void flWind(vec3 p, vec3 up, float t, out vec3 dir, out float gust) {
  vec3 flow = cross(FL_WIND_AXIS, up);
  float fl = length(flow);
  dir = flow / max(fl, 1e-4);
  vec3 q = flRotate(p, FL_WIND_AXIS, -t * ${f(WIND_OMEGA)});
  float g1 = flNoise(q * 0.05);
  float g2 = flNoise(q * 0.15 + vec3(3.1, 7.7, 1.3));
  // wave fronts across the flow: bands in longitude around the wind axis (they travel with q),
  // warped and broken up by the noise so they read as gusts rather than stripes
  vec3 b1 = vec3(${f(B1[0])}, ${f(B1[1])}, ${f(B1[2])});
  vec3 b2 = cross(FL_WIND_AXIS, b1);
  float phi = atan(dot(q, b2), dot(q, b1));
  float band = 0.5 + 0.5 * sin(phi * 17.0 + g1 * 5.0 + g2 * 1.5);
  gust = smoothstep(0.3, 0.95, band) * smoothstep(0.2, 0.7, g1 * 0.85 + g2 * 0.35);
  gust *= 0.35 + 0.65 * smoothstep(0.05, 0.5, fl);
}
#endif
`;
