// Small GLSL noise library shared by the terrain and ocean shaders.
// Everything is a function of 3D world position (no uv, no single-axis projection), so it wraps
// seamlessly round the sphere.

export const NOISE_GLSL = /* glsl */ `
#ifndef TP_NOISE
#define TP_NOISE
float tpHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
vec3 tpHash3(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
// value noise in [-1, 1]
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 w = fract(x);
  vec3 u = w * w * (3.0 - 2.0 * w);
  float a = tpHash(i);
  float b = tpHash(i + vec3(1, 0, 0));
  float c = tpHash(i + vec3(0, 1, 0));
  float d = tpHash(i + vec3(1, 1, 0));
  float e = tpHash(i + vec3(0, 0, 1));
  float f = tpHash(i + vec3(1, 0, 1));
  float g = tpHash(i + vec3(0, 1, 1));
  float h = tpHash(i + vec3(1, 1, 1));
  return 2.0 * mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, f, u.x), mix(g, h, u.x), u.y), u.z) - 1.0;
}
// value noise in [-1, 1] with analytic gradient: (value, d/dx, d/dy, d/dz)
vec4 vnoised(vec3 x) {
  vec3 i = floor(x);
  vec3 w = fract(x);
  vec3 u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  vec3 du = 30.0 * w * w * (w * (w - 2.0) + 1.0);
  float a = tpHash(i);
  float b = tpHash(i + vec3(1, 0, 0));
  float c = tpHash(i + vec3(0, 1, 0));
  float d = tpHash(i + vec3(1, 1, 0));
  float e = tpHash(i + vec3(0, 0, 1));
  float f = tpHash(i + vec3(1, 0, 1));
  float g = tpHash(i + vec3(0, 1, 1));
  float h = tpHash(i + vec3(1, 1, 1));
  float k0 = a, k1 = b - a, k2 = c - a, k3 = e - a;
  float k4 = a - b - c + d, k5 = a - c - e + g, k6 = a - b - e + f;
  float k7 = -a + b + c - d + e - f - g + h;
  float v = k0 + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z;
  vec3 dv = du * vec3(k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
                      k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
                      k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y);
  return vec4(2.0 * v - 1.0, 2.0 * dv);
}
// 3D simplex noise in [-1, 1] (after Ashima Arts / Stefan Gustavson, MIT). No lattice artefacts,
// so it is the one to threshold into painterly patches.
vec3 tpMod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 tpMod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 tpPermute(vec4 x) { return tpMod289(((x * 34.0) + 1.0) * x); }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = tpMod289(i);
  vec4 p = tpPermute(tpPermute(tpPermute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  vec3 ns = 0.142857142857 * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 nrm = 1.79284291400159 - 0.85373472095314 * vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3));
  p0 *= nrm.x; p1 *= nrm.y; p2 *= nrm.z; p3 *= nrm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
float fbm3n(vec3 p) {
  return 0.57 * snoise(p) + 0.29 * snoise(p * 2.03 + 11.7) + 0.14 * snoise(p * 4.07 - 5.3);
}
// cellular: x = distance to nearest feature, y = distance to second nearest, z = cell id hash
vec3 tpVoronoi(vec3 p) {
  vec3 ip = floor(p);
  vec3 fp = fract(p);
  float d1 = 8.0, d2 = 8.0, id = 0.0;
  for (int k = -1; k <= 1; k++)
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec3 o = vec3(float(i), float(j), float(k));
    vec3 r = o + tpHash3(ip + o) * 0.85 + 0.075 - fp;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = tpHash(ip + o + 7.1); }
    else if (d < d2) { d2 = d; }
  }
  return vec3(sqrt(d1), sqrt(d2), id);
}
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
#endif
`;
