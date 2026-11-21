/**
 * Dual WGSL (WebGPU) & GLSL 300 es (WebGL2) instanced SDF shaders for `@jiange/render-gpu`.
 * Renders anti-aliased rounded rectangles with crisp borders, thick/dashed lines,
 * and ellipses/pie arcs in a single instanced draw call per primitive type.
 */

export const WGSL_RECT_SHADER = /* wgsl */ `
struct CameraUniform {
  viewport: vec2<f32>,
  camPos: vec2<f32>,
  zoom: f32,
  dpr: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> uCam: CameraUniform;

struct RectIn {
  @location(0) rect: vec4<f32>,       // x, y, w, h
  @location(1) fill: vec4<f32>,       // r, g, b, a
  @location(2) style: vec4<f32>,      // radius, borderW, rotRad, flags
  @location(3) borderColor: vec4<f32> // br, bg, bb, ba
};

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) localPx: vec2<f32>,
  @location(1) halfSize: vec2<f32>,
  @location(2) fill: vec4<f32>,
  @location(3) borderColor: vec4<f32>,
  @location(4) radius: f32,
  @location(5) borderW: f32,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32, inst: RectIn) -> VsOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0)
  );
  let uv = corners[vid];
  let size = inst.rect.zw;
  let center = inst.rect.xy + size * 0.5;
  let local = (uv - vec2<f32>(0.5, 0.5)) * size;
  let c = cos(inst.style.z);
  let s = sin(inst.style.z);
  let rotLocal = vec2<f32>(local.x * c - local.y * s, local.x * s + local.y * c);
  let world = center + rotLocal;
  let screen = (world - uCam.camPos) * uCam.zoom;
  let ndc = vec2<f32>(
    (screen.x / uCam.viewport.x) * 2.0 - 1.0,
    1.0 - (screen.y / uCam.viewport.y) * 2.0
  );
  var out: VsOut;
  out.pos = vec4<f32>(ndc, 0.0, 1.0);
  out.localPx = local * uCam.zoom;
  out.halfSize = size * 0.5 * uCam.zoom;
  out.fill = inst.fill;
  out.borderColor = inst.borderColor;
  out.radius = inst.style.x * uCam.zoom;
  out.borderW = inst.style.y * uCam.zoom;
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let r = min(in.radius, min(in.halfSize.x, in.halfSize.y));
  let q = abs(in.localPx) - (in.halfSize - vec2<f32>(r, r));
  let dist = length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
  let aa = max(fwidth(dist), 0.5);
  let outerAlpha = 1.0 - smoothstep(-aa, aa, dist);
  if (outerAlpha <= 0.001) { discard; }
  var col = in.fill;
  if (in.borderW > 0.0) {
    let innerAlpha = 1.0 - smoothstep(-aa, aa, dist + in.borderW);
    col = mix(in.borderColor, in.fill, innerAlpha);
  }
  return vec4<f32>(col.rgb * col.a * outerAlpha, col.a * outerAlpha);
}
`;

export const WGSL_LINE_SHADER = /* wgsl */ `
struct CameraUniform {
  viewport: vec2<f32>,
  camPos: vec2<f32>,
  zoom: f32,
  dpr: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> uCam: CameraUniform;

struct LineIn {
  @location(0) endpoints: vec4<f32>, // x1, y1, x2, y2
  @location(1) color: vec4<f32>,     // r, g, b, a
  @location(2) params: vec4<f32>,    // thickness, dashLen, gapLen, flags
};

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) along: f32,
  @location(2) across: f32,
  @location(3) dashLen: f32,
  @location(4) gapLen: f32,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32, inst: LineIn) -> VsOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, -0.5), vec2<f32>(1.0, -0.5), vec2<f32>(0.0, 0.5),
    vec2<f32>(1.0, -0.5), vec2<f32>(1.0, 0.5), vec2<f32>(0.0, 0.5)
  );
  let uv = corners[vid];
  let p1 = (inst.endpoints.xy - uCam.camPos) * uCam.zoom;
  let p2 = (inst.endpoints.zw - uCam.camPos) * uCam.zoom;
  let delta = p2 - p1;
  let segLen = max(length(delta), 0.0001);
  let dir = delta / segLen;
  let normal = vec2<f32>(-dir.y, dir.x);
  let thick = max(inst.params.x * uCam.zoom, 1.0);
  let screen = p1 + dir * (uv.x * segLen) + normal * (uv.y * thick);
  let ndc = vec2<f32>(
    (screen.x / uCam.viewport.x) * 2.0 - 1.0,
    1.0 - (screen.y / uCam.viewport.y) * 2.0
  );
  var out: VsOut;
  out.pos = vec4<f32>(ndc, 0.0, 1.0);
  out.color = inst.color;
  out.along = uv.x * segLen;
  out.across = abs(uv.y * 2.0);
  out.dashLen = inst.params.y * uCam.zoom;
  out.gapLen = inst.params.z * uCam.zoom;
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  if (in.dashLen > 0.0 && in.gapLen > 0.0) {
    let period = in.dashLen + in.gapLen;
    let phase = in.along - floor(in.along / period) * period;
    if (phase > in.dashLen) { discard; }
  }
  let aa = max(fwidth(in.across), 0.1);
  let alpha = (1.0 - smoothstep(1.0 - aa, 1.0, in.across)) * in.color.a;
  return vec4<f32>(in.color.rgb * alpha, alpha);
}
`;

export const GLSL300_RECT_VS = `#version 300 es
precision highp float;
uniform vec4 uCamera0; // viewportW, viewportH, camX, camY
uniform vec4 uCamera1; // zoom, dpr, 0, 0
layout(location = 0) in vec4 aRect;
layout(location = 1) in vec4 aFill;
layout(location = 2) in vec4 aStyle0; // radius, borderW, br, bg
layout(location = 3) in vec4 aStyle1; // bb, ba, rotRad, flags
out vec2 vLocalPx;
out vec2 vHalfSize;
out vec4 vFill;
out vec4 vBorderColor;
out float vRadius;
out float vBorderW;
void main() {
  const vec2 corners[6] = vec2[6](
    vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
    vec2(1.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0)
  );
  vec2 uv = corners[gl_VertexID];
  vec2 size = aRect.zw;
  vec2 center = aRect.xy + size * 0.5;
  vec2 local = (uv - 0.5) * size;
  float c = cos(aStyle1.z);
  float s = sin(aStyle1.z);
  vec2 rotLocal = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec2 screen = (center + rotLocal - uCamera0.zw) * uCamera1.x;
  vec2 ndc = vec2((screen.x / uCamera0.x) * 2.0 - 1.0, 1.0 - (screen.y / uCamera0.y) * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  vLocalPx = local * uCamera1.x;
  vHalfSize = size * 0.5 * uCamera1.x;
  vFill = aFill;
  vBorderColor = vec4(aStyle0.zw, aStyle1.xy);
  vRadius = aStyle0.x * uCamera1.x;
  vBorderW = aStyle0.y * uCamera1.x;
}
`;

export const GLSL300_RECT_FS = `#version 300 es
precision highp float;
in vec2 vLocalPx;
in vec2 vHalfSize;
in vec4 vFill;
in vec4 vBorderColor;
in float vRadius;
in float vBorderW;
out vec4 outColor;
void main() {
  float r = min(vRadius, min(vHalfSize.x, vHalfSize.y));
  vec2 q = abs(vLocalPx) - (vHalfSize - vec2(r));
  float dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  float aa = max(fwidth(dist), 0.5);
  float outerA = 1.0 - smoothstep(-aa, aa, dist);
  if (outerA <= 0.001) discard;
  vec4 col = vFill;
  if (vBorderW > 0.0) {
    float innerA = 1.0 - smoothstep(-aa, aa, dist + vBorderW);
    col = mix(vBorderColor, vFill, innerA);
  }
  float a = col.a * outerA;
  outColor = vec4(col.rgb * a, a);
}
`;

export const GLSL300_LINE_VS = `#version 300 es
precision highp float;
uniform vec4 uCamera0;
uniform vec4 uCamera1;
layout(location = 0) in vec4 aEndpoints; // x1, y1, x2, y2
layout(location = 1) in vec4 aColorThick; // thickness, r, g, b
layout(location = 2) in vec4 aParams; // a, dashLen, gapLen, flags
out vec4 vColor;
out float vAlong;
out float vAcross;
out float vDash;
out float vGap;
void main() {
  const vec2 corners[6] = vec2[6](
    vec2(0.0, -0.5), vec2(1.0, -0.5), vec2(0.0, 0.5),
    vec2(1.0, -0.5), vec2(1.0, 0.5), vec2(0.0, 0.5)
  );
  vec2 uv = corners[gl_VertexID];
  vec2 p1 = (aEndpoints.xy - uCamera0.zw) * uCamera1.x;
  vec2 p2 = (aEndpoints.zw - uCamera0.zw) * uCamera1.x;
  vec2 delta = p2 - p1;
  float segLen = max(length(delta), 0.0001);
  vec2 dir = delta / segLen;
  vec2 norm = vec2(-dir.y, dir.x);
  float thick = max(aColorThick.x * uCamera1.x, 1.0);
  vec2 screen = p1 + dir * (uv.x * segLen) + norm * (uv.y * thick);
  vec2 ndc = vec2((screen.x / uCamera0.x) * 2.0 - 1.0, 1.0 - (screen.y / uCamera0.y) * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  vColor = vec4(aColorThick.yzw, aParams.x);
  vAlong = uv.x * segLen;
  vAcross = abs(uv.y * 2.0);
  vDash = aParams.y * uCamera1.x;
  vGap = aParams.z * uCamera1.x;
}
`;

export const GLSL300_LINE_FS = `#version 300 es
precision highp float;
in vec4 vColor;
in float vAlong;
in float vAcross;
in float vDash;
in float vGap;
out vec4 outColor;
void main() {
  if (vDash > 0.0 && vGap > 0.0) {
    float period = vDash + vGap;
    float phase = mod(vAlong, period);
    if (phase > vDash) discard;
  }
  float aa = max(fwidth(vAcross), 0.1);
  float a = (1.0 - smoothstep(1.0 - aa, 1.0, vAcross)) * vColor.a;
  outColor = vec4(vColor.rgb * a, a);
}
`;

export const GLSL300_ARC_VS = `#version 300 es
precision highp float;
uniform vec4 uCamera0;
uniform vec4 uCamera1;
layout(location = 0) in vec4 aGeom;   // cx, cy, rx, ry
layout(location = 1) in vec4 aAngles; // start, end, innerRatio, r
layout(location = 2) in vec4 aColor;  // g, b, a, borderW
out vec2 vUnit;
out vec4 vColor;
out vec3 vAngles;
void main() {
  const vec2 corners[6] = vec2[6](
    vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0),
    vec2(1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0)
  );
  vec2 u = corners[gl_VertexID];
  vec2 world = aGeom.xy + u * aGeom.zw;
  vec2 screen = (world - uCamera0.zw) * uCamera1.x;
  vec2 ndc = vec2((screen.x / uCamera0.x) * 2.0 - 1.0, 1.0 - (screen.y / uCamera0.y) * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  vUnit = u;
  vColor = vec4(aAngles.w, aColor.xyz);
  vAngles = aAngles.xyz;
}
`;

export const GLSL300_ARC_FS = `#version 300 es
precision highp float;
in vec2 vUnit;
in vec4 vColor;
in vec3 vAngles;
out vec4 outColor;
void main() {
  float r = length(vUnit);
  if (r > 1.0 || r < vAngles.z) discard;
  float ang = atan(vUnit.y, vUnit.x);
  if (ang < 0.0) ang += 6.28318530718;
  float startA = mod(vAngles.x, 6.28318530718);
  float sweep = vAngles.y - vAngles.x;
  if (sweep < 6.282) {
    float rel = mod(ang - startA + 6.28318530718, 6.28318530718);
    if (rel > sweep) discard;
  }
  float aa = max(fwidth(r), 0.02);
  float edgeA = 1.0 - smoothstep(1.0 - aa, 1.0, r);
  float a = vColor.a * edgeA;
  outColor = vec4(vColor.rgb * a, a);
}
`;
