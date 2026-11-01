/**
 * The page curl: the turning sheet bent round a cylinder, drawn with WebGL
 * on a canvas over the page pictures. Only the moving sheet and the shadows
 * it casts are drawn here. Pages lying flat are ordinary <img>s underneath,
 * so they stay exactly as sharp as the browser draws them, and the canvas
 * is clear whenever nothing is turning.
 *
 * For each pixel the shader works out which point of the paper is on top
 * there: the part that has curled all the way over and lies back on top
 * (its back shows), the curl itself (back on the outside, front on the
 * inside), or the part still flat in place. It lights that point by how it
 * faces the light, and where no paper is it lays down the shadow the sheet
 * casts. The fold itself comes from ./book-layout.js foldOf.
 *
 * createCurl(canvas) → null when WebGL isn't there; otherwise
 *   { resize(w, h, dpr), draw(opts), clear(), destroy(), lost }
 */

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_res;        // the canvas, device pixels
uniform float u_dpr;
uniform vec2 u_origin;     // the spine's top, CSS pixels from the canvas's top left
uniform vec2 u_page;       // the page's width and height
uniform vec2 u_axis;       // a point on the fold line
uniform vec2 u_n;          // unit normal from the fold toward the free edge
uniform float u_R;         // the radius the paper bends round
uniform sampler2D u_front;
uniform sampler2D u_back;
uniform float u_frontOn;   // 0..1: the picture has arrived (paper until then)
uniform float u_backOn;
uniform float u_seeThrough; // 1: no facing page, so the back is paper with the front's ink faintly through it
uniform vec3 u_paper;
uniform float u_shade;     // how strong the shadows are: none while the sheet lies flat
uniform float u_alpha;     // the whole sheet's opacity (one page at a time, it fades as it leaves)
uniform vec2 u_floor;      // the pages lying underneath, from x to x (shadows fall only on paper)
uniform float u_mirror;    // 1: a left-hand page turning right; the sheet's x runs right to left

const float PI = 3.14159265;

float boxDist(vec2 p) {
  vec2 d = abs(p - 0.5 * u_page) - 0.5 * u_page;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
// Where on its picture a point of the sheet is: x from the spine, flipped for a mirrored sheet's front
vec2 frontUv(vec2 p) { return vec2(u_mirror > 0.5 ? 1.0 - p.x / u_page.x : p.x / u_page.x, p.y / u_page.y); }
vec3 frontAt(vec2 p) {
  return mix(u_paper, texture2D(u_front, frontUv(p)).rgb, u_frontOn);
}
vec3 backAt(vec2 p) {
  if (u_seeThrough > 0.5) return mix(u_paper, texture2D(u_front, frontUv(p)).rgb, 0.09 * u_frontOn);
  return mix(u_paper, texture2D(u_back, vec2(u_mirror > 0.5 ? p.x / u_page.x : 1.0 - p.x / u_page.x, p.y / u_page.y)).rgb, u_backOn);
}
void put(inout vec3 rgb, inout float a, vec3 c, float cover) {
  rgb += (1.0 - a) * cover * c;
  a += (1.0 - a) * cover;
}

void main() {
  vec2 q = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y) / u_dpr - u_origin;
  if (u_mirror > 0.5) q.x = -q.x;
  float aa = 1.0 / u_dpr;
  float R = max(u_R, 0.0001);
  float d = dot(q - u_axis, u_n);
  vec3 rgb = vec3(0.0);
  float a = 0.0;

  // The shadow the curled-over part casts on what's under it
  float flap = 0.0;
  if (d < 0.0) {
    vec2 p = q + (PI * R - 2.0 * d) * u_n;
    float soft = 3.0 + 0.5 * R + 10.0 * u_shade;
    flap = 0.3 * u_shade * (1.0 - smoothstep(0.0, soft, boxDist(p)));
  }

  // 1. Curled all the way over, lying back on top: its back shows
  if (d < 0.0) {
    vec2 p = q + (PI * R - 2.0 * d) * u_n;
    float cover = clamp(0.5 - boxDist(p) / aa, 0.0, 1.0);
    if (cover > 0.0) put(rgb, a, backAt(p) * 0.985, cover);
  }

  // 2 and 3. The curl: its upper half shows the back, the lower half the front from inside
  if (d >= 0.0 && d <= R + aa) {
    float s = clamp(d / R, 0.0, 1.0);
    float rim = clamp((R - d) / aa + 0.5, 0.0, 1.0);
    float up = PI - asin(s);
    vec2 pu = q + (R * up - d) * u_n;
    float cu = clamp(0.5 - boxDist(pu) / aa, 0.0, 1.0) * rim;
    if (cu > 0.0) {
      float lit = 0.62 + 0.38 * (-cos(up)) + 0.06 * exp(-pow((up - 0.8 * PI) / 0.12, 2.0));
      put(rgb, a, backAt(pu) * lit, cu);
    }
    float lo = asin(s);
    vec2 pl = q + (R * lo - d) * u_n;
    float cl = clamp(0.5 - boxDist(pl) / aa, 0.0, 1.0) * rim;
    if (cl > 0.0) {
      float lit = 0.88 * (0.52 + 0.48 * cos(lo));
      put(rgb, a, frontAt(pl) * lit, cl);
    }
  }

  // 4. Still flat in place, darkening a touch where it starts to lift, under the flap's shadow
  if (d < 0.0) {
    float cover = clamp(0.5 - boxDist(q) / aa, 0.0, 1.0);
    if (cover > 0.0) {
      float lit = (1.0 - 0.1 * u_shade * exp(d / (0.45 * R + 1.0))) * (1.0 - flap);
      put(rgb, a, frontAt(q) * lit, cover);
    }
  }

  // Where no paper is: the flap's shadow, and the curl's along its far side
  float shadow = flap;
  if (d > 0.0) {
    vec2 edge = q - (d - R) * u_n;
    vec2 pe = edge + (R * 0.5 * PI - R) * u_n;
    float ends = 1.0 - smoothstep(-2.0, 10.0 + 0.4 * R, boxDist(pe));
    float fall = exp(-max(d - R, 0.0) / (3.0 + 0.3 * R + 8.0 * u_shade));
    shadow = max(shadow, 0.36 * u_shade * fall * ends);
  }
  // Only paper catches it: none on the space around the book
  float edgeDist = min(min(q.x - u_floor.x, u_floor.y - q.x), min(q.y, u_page.y - q.y));
  shadow *= clamp(edgeDist / aa + 0.5, 0.0, 1.0);
  float alpha = a + (1.0 - a) * shadow;
  gl_FragColor = vec4(rgb, alpha) * u_alpha;
}
`;

export function createCurl(canvas) {
  const opts = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'default' };
  let gl = null;
  let gl2 = false;
  try {
    gl = canvas.getContext('webgl2', opts);
    gl2 = !!gl;
    if (!gl) gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
  } catch { gl = null; }
  if (!gl) return null;

  let prog, loc, buf;
  const textures = new Map(); // <img> → { tex, used }
  let blank = null;
  let size = { w: 0, h: 0, dpr: 1 };
  const api = { lost: false };

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  }
  function init() {
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
    gl.useProgram(prog);
    loc = {};
    for (const name of ['u_res', 'u_dpr', 'u_origin', 'u_page', 'u_axis', 'u_n', 'u_R', 'u_front', 'u_back', 'u_frontOn', 'u_backOn', 'u_seeThrough', 'u_paper', 'u_shade', 'u_alpha', 'u_floor', 'u_mirror']) loc[name] = gl.getUniformLocation(prog, name);
    // One triangle over the whole canvas
    buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const at = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(loc.u_front, 0);
    gl.uniform1i(loc.u_back, 1);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    // A 1×1 paper texture stands in until a picture arrives
    blank = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, blank);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  }
  try { init(); } catch (e) {
    console.warn('[flipbook] WebGL unavailable:', e?.message || e);
    return null;
  }

  canvas.addEventListener('webglcontextlost', onLost, false);
  canvas.addEventListener('webglcontextrestored', onRestored, false);
  function onLost(e) { e.preventDefault(); api.lost = true; textures.clear(); }
  function onRestored() {
    try { init(); api.lost = false; resize(size.w, size.h, size.dpr); api.onRestore?.(); } catch { /* stays lost: the book turns without the curl */ }
  }

  /** The picture as a texture, uploaded once; null until it has loaded */
  function textureOf(img) {
    if (!img || !img.complete || !img.naturalWidth) return null;
    let t = textures.get(img);
    if (t) { t.used = performance.now(); return t.tex; }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    } catch (e) {
      // A picture that wasn't sent for CORS can't be read: the sheet draws as paper
      gl.deleteTexture(tex);
      return null;
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (gl2) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    textures.set(img, { tex, used: performance.now() });
    // Keep a handful: a turn needs two, each way
    if (textures.size > 10) {
      const old = [...textures.entries()].sort((x, y) => x[1].used - y[1].used).slice(0, textures.size - 10);
      for (const [k, v] of old) { gl.deleteTexture(v.tex); textures.delete(k); }
    }
    return tex;
  }

  function resize(w, h, dpr) {
    size = { w, h, dpr };
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    if (!api.lost) gl.viewport(0, 0, W, H);
  }

  function clear() {
    if (api.lost) return;
    gl.disable(gl.SCISSOR_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /**
   * opts: origin {x, y} (the spine's top in canvas CSS pixels), W, H, fold
   * {ax, ay, nx, ny, R} in the sheet's own coordinates, mirror (a left-hand
   * page: those run right to left), front and back (<img>s or null), seeThrough,
   * shade 0..1, frontOn and backOn 0..1, alpha, paper [r, g, b] 0..1,
   * floor [x0, x1]: the pages lying under it (its shadow falls only on
   * them), and reach: how far past the page the sheet can go.
   */
  function draw(o) {
    if (api.lost) return false;
    const front = textureOf(o.front);
    const back = o.seeThrough ? front : textureOf(o.back);
    clear();
    // Only the pixels the sheet and its shadow can reach
    const { dpr } = size;
    const reach = o.reach ?? Math.max(40, o.H * 0.25);
    const x0 = Math.max(0, Math.floor((o.origin.x - o.W - reach) * dpr));
    const x1 = Math.min(canvas.width, Math.ceil((o.origin.x + o.W + reach) * dpr));
    const yTop = Math.max(0, Math.floor((o.origin.y - reach) * dpr));
    const yBot = Math.min(canvas.height, Math.ceil((o.origin.y + o.H + reach) * dpr));
    if (x1 <= x0 || yBot <= yTop) return true;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x0, canvas.height - yBot, x1 - x0, yBot - yTop);
    gl.useProgram(prog);
    gl.uniform2f(loc.u_res, canvas.width, canvas.height);
    gl.uniform1f(loc.u_dpr, dpr);
    gl.uniform2f(loc.u_origin, o.origin.x, o.origin.y);
    gl.uniform2f(loc.u_page, o.W, o.H);
    gl.uniform2f(loc.u_axis, o.fold.ax, o.fold.ay);
    gl.uniform2f(loc.u_n, o.fold.nx, o.fold.ny);
    gl.uniform1f(loc.u_R, o.fold.R);
    gl.uniform1f(loc.u_frontOn, front ? (o.frontOn ?? 1) : 0);
    gl.uniform1f(loc.u_backOn, back ? (o.backOn ?? 1) : 0);
    gl.uniform1f(loc.u_seeThrough, o.seeThrough ? 1 : 0);
    const paper = o.paper || [1, 1, 1];
    gl.uniform3f(loc.u_paper, paper[0], paper[1], paper[2]);
    gl.uniform1f(loc.u_shade, o.shade ?? 1);
    gl.uniform1f(loc.u_alpha, o.alpha ?? 1);
    const floor = o.floor || [-o.W, o.W];
    gl.uniform2f(loc.u_floor, floor[0], floor[1]);
    gl.uniform1f(loc.u_mirror, o.mirror ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, front || blank);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, back || blank);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  /** Is this picture ready to draw (loaded, and readable)? */
  const ready = (img) => !!(img && img.complete && img.naturalWidth);

  function destroy() {
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    if (!api.lost) {
      for (const v of textures.values()) gl.deleteTexture(v.tex);
      textures.clear();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  }

  return Object.assign(api, { resize, draw, clear, destroy, ready, upload: textureOf });
}
