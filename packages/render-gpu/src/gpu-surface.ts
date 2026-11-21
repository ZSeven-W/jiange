/**
 * GpuSurface: WebGPU (primary) -> WebGL2 (automatic fallback) -> Headless backend.
 *
 * STRICTLY ZERO Canvas 2D rendering context usage anywhere in this engine.
 * Supports all 4 RFC instanced GPU pipelines (Rect, Line, Arc, GlyphAtlas),
 * multi-pass scissor regions (4-quadrant frozen panes), DPI-aware resizing,
 * dirty-frame RAF scheduling, and per-frame telemetry.
 */

import { GlyphAtlas } from "./glyph-atlas.js";
import {
  ARC_STRIDE,
  GLYPH_STRIDE,
  InstanceBatch,
  LINE_STRIDE,
  RECT_STRIDE,
  type RgbaTuple,
} from "./instance-buffer.js";
import {
  GLSL300_ARC_FS,
  GLSL300_ARC_VS,
  GLSL300_GLYPH_FS,
  GLSL300_GLYPH_VS,
  GLSL300_LINE_FS,
  GLSL300_LINE_VS,
  GLSL300_RECT_FS,
  GLSL300_RECT_VS,
  WGSL_ARC_SHADER,
  WGSL_GLYPH_SHADER,
  WGSL_LINE_SHADER,
  WGSL_RECT_SHADER,
} from "./shaders.js";

export type GpuBackendKind = "webgpu" | "webgl2" | "headless";

export interface GpuFrameStats {
  backend: GpuBackendKind;
  drawCalls: number;
  rectInstances: number;
  lineInstances: number;
  arcInstances: number;
  glyphInstances: number;
  frameTimeMs: number;
}

export interface GpuCanvasLike {
  width: number;
  height: number;
  style?: { width?: string; height?: string };
  getContext(contextId: "webgpu"): unknown;
  getContext(contextId: "webgl2", options?: Record<string, unknown>): unknown;
}

export interface GpuBackend {
  readonly kind: GpuBackendKind;
  readonly glyphAtlas: GlyphAtlas;
  resize(widthPx: number, heightPx: number, dpr: number): void;
  render(batches: readonly InstanceBatch[], clearColor: RgbaTuple): GpuFrameStats;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Minimal structural WebGPU types (avoids @webgpu/types runtime/dev dependency)
// ---------------------------------------------------------------------------

interface WebGpuBufferLike {
  destroy(): void;
}

interface WebGpuTextureLike {
  createView(): unknown;
  destroy(): void;
}

interface WebGpuRenderPassLike {
  setViewport(x: number, y: number, w: number, h: number, minD: number, maxD: number): void;
  setScissorRect(x: number, y: number, w: number, h: number): void;
  setPipeline(pipeline: unknown): void;
  setBindGroup(idx: number, bg: unknown): void;
  setVertexBuffer(slot: number, buf: WebGpuBufferLike): void;
  draw(vertexCount: number, instanceCount?: number): void;
  end(): void;
}

interface WebGpuCommandEncoderLike {
  beginRenderPass(desc: Record<string, unknown>): WebGpuRenderPassLike;
  finish(): unknown;
}

interface WebGpuDeviceLike {
  queue: {
    writeBuffer(buf: WebGpuBufferLike, offset: number, data: ArrayBufferView): void;
    writeTexture(
      dest: { texture: WebGpuTextureLike },
      data: ArrayBufferView,
      dataLayout: { bytesPerRow: number; rowsPerImage?: number },
      size: { width: number; height: number },
    ): void;
    submit(cmds: unknown[]): void;
  };
  createShaderModule(desc: { code: string }): unknown;
  createRenderPipeline(desc: Record<string, unknown>): unknown;
  createBuffer(desc: { size: number; usage: number }): WebGpuBufferLike;
  createTexture(desc: {
    size: { width: number; height: number };
    format: string;
    usage: number;
  }): WebGpuTextureLike;
  createSampler(desc?: Record<string, unknown>): unknown;
  createBindGroup(desc: Record<string, unknown>): unknown;
  createCommandEncoder(): WebGpuCommandEncoderLike;
  destroy?(): void;
}

interface WebGpuContextLike {
  configure(desc: Record<string, unknown>): void;
  getCurrentTexture(): { createView(): unknown };
}

const GPU_USAGE_VERTEX = 0x0020;
const GPU_USAGE_UNIFORM = 0x0040;
const GPU_USAGE_COPY_DST = 0x0008;
const GPU_TEX_USAGE_COPY_DST = 0x0002;
const GPU_TEX_USAGE_TEXTURE_BINDING = 0x0004;

/** WebGPU instanced SDF + glyph atlas backend. */
export class WebGPUBackend implements GpuBackend {
  readonly kind: GpuBackendKind = "webgpu";
  readonly glyphAtlas: GlyphAtlas;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private uniformScratch = new Float32Array(8);
  private uniformBuffer: WebGpuBufferLike;
  private rectBuffer: WebGpuBufferLike;
  private lineBuffer: WebGpuBufferLike;
  private arcBuffer: WebGpuBufferLike;
  private glyphBuffer: WebGpuBufferLike;
  private rectBufBytes: number;
  private lineBufBytes: number;
  private arcBufBytes: number;
  private glyphBufBytes: number;
  private rectPipeline: unknown;
  private linePipeline: unknown;
  private arcPipeline: unknown;
  private glyphPipeline: unknown;
  private rectBindGroup: unknown;
  private lineBindGroup: unknown;
  private arcBindGroup: unknown;
  private glyphBindGroup: unknown;
  private atlasTexture: WebGpuTextureLike;
  private atlasSampler: unknown;

  constructor(
    private readonly device: WebGpuDeviceLike,
    private readonly context: WebGpuContextLike,
    format: string,
    glyphAtlas: GlyphAtlas = new GlyphAtlas(),
  ) {
    this.glyphAtlas = glyphAtlas;
    this.context.configure({ device, format, alphaMode: "premultiplied" });
    this.uniformBuffer = device.createBuffer({ size: 32, usage: GPU_USAGE_UNIFORM | GPU_USAGE_COPY_DST });
    this.rectBufBytes = 1024 * RECT_STRIDE * 4;
    this.lineBufBytes = 1024 * LINE_STRIDE * 4;
    this.arcBufBytes = 256 * ARC_STRIDE * 4;
    this.glyphBufBytes = 1024 * GLYPH_STRIDE * 4;
    this.rectBuffer = device.createBuffer({ size: this.rectBufBytes, usage: GPU_USAGE_VERTEX | GPU_USAGE_COPY_DST });
    this.lineBuffer = device.createBuffer({ size: this.lineBufBytes, usage: GPU_USAGE_VERTEX | GPU_USAGE_COPY_DST });
    this.arcBuffer = device.createBuffer({ size: this.arcBufBytes, usage: GPU_USAGE_VERTEX | GPU_USAGE_COPY_DST });
    this.glyphBuffer = device.createBuffer({ size: this.glyphBufBytes, usage: GPU_USAGE_VERTEX | GPU_USAGE_COPY_DST });

    const blend = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };

    const rectMod = device.createShaderModule({ code: WGSL_RECT_SHADER });
    this.rectPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: rectMod,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: RECT_STRIDE * 4,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x4" },
              { shaderLocation: 1, offset: 16, format: "float32x4" },
              { shaderLocation: 2, offset: 32, format: "float32x4" },
              { shaderLocation: 3, offset: 48, format: "float32x4" },
            ],
          },
        ],
      },
      fragment: { module: rectMod, entryPoint: "fs_main", targets: [{ format, blend }] },
      primitive: { topology: "triangle-list" },
    });

    const lineMod = device.createShaderModule({ code: WGSL_LINE_SHADER });
    this.linePipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: lineMod,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: LINE_STRIDE * 4,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x4" },
              { shaderLocation: 1, offset: 16, format: "float32x4" },
              { shaderLocation: 2, offset: 32, format: "float32x4" },
            ],
          },
        ],
      },
      fragment: { module: lineMod, entryPoint: "fs_main", targets: [{ format, blend }] },
      primitive: { topology: "triangle-list" },
    });

    const arcMod = device.createShaderModule({ code: WGSL_ARC_SHADER });
    this.arcPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: arcMod,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: ARC_STRIDE * 4,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x4" },
              { shaderLocation: 1, offset: 16, format: "float32x4" },
              { shaderLocation: 2, offset: 32, format: "float32x4" },
            ],
          },
        ],
      },
      fragment: { module: arcMod, entryPoint: "fs_main", targets: [{ format, blend }] },
      primitive: { topology: "triangle-list" },
    });

    const glyphMod = device.createShaderModule({ code: WGSL_GLYPH_SHADER });
    this.glyphPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: glyphMod,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: GLYPH_STRIDE * 4,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x4" },
              { shaderLocation: 1, offset: 16, format: "float32x4" },
              { shaderLocation: 2, offset: 32, format: "float32x4" },
            ],
          },
        ],
      },
      fragment: { module: glyphMod, entryPoint: "fs_main", targets: [{ format, blend }] },
      primitive: { topology: "triangle-list" },
    });

    this.atlasTexture = device.createTexture({
      size: { width: this.glyphAtlas.width, height: this.glyphAtlas.height },
      format: "r8unorm",
      usage: GPU_TEX_USAGE_TEXTURE_BINDING | GPU_TEX_USAGE_COPY_DST,
    });
    this.atlasSampler = device.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    const getLayout = (pipe: unknown) =>
      typeof (pipe as { getBindGroupLayout?: (i: number) => unknown })?.getBindGroupLayout === "function"
        ? (pipe as { getBindGroupLayout(i: number): unknown }).getBindGroupLayout(0)
        : undefined;

    this.rectBindGroup = device.createBindGroup({
      layout: getLayout(this.rectPipeline),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
    this.lineBindGroup = device.createBindGroup({
      layout: getLayout(this.linePipeline),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
    this.arcBindGroup = device.createBindGroup({
      layout: getLayout(this.arcPipeline),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
    this.glyphBindGroup = device.createBindGroup({
      layout: getLayout(this.glyphPipeline),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.atlasSampler },
        { binding: 2, resource: this.atlasTexture.createView() },
      ],
    });
  }

  resize(widthPx: number, heightPx: number, dpr: number): void {
    this.width = Math.max(1, Math.floor(widthPx));
    this.height = Math.max(1, Math.floor(heightPx));
    this.dpr = Math.max(1, dpr);
  }

  private growBuffer(
    current: WebGpuBufferLike,
    currentBytes: number,
    neededBytes: number,
  ): { buf: WebGpuBufferLike; bytes: number } {
    if (neededBytes <= currentBytes) {
      return { buf: current, bytes: currentBytes };
    }
    current.destroy();
    const bytes = Math.max(neededBytes, currentBytes * 2);
    const buf = this.device.createBuffer({ size: bytes, usage: GPU_USAGE_VERTEX | GPU_USAGE_COPY_DST });
    return { buf, bytes };
  }

  render(batches: readonly InstanceBatch[], clearColor: RgbaTuple): GpuFrameStats {
    const t0 = performance.now();
    const encoder = this.device.createCommandEncoder();
    const view = this.context.getCurrentTexture().createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { r: clearColor[0], g: clearColor[1], b: clearColor[2], a: clearColor[3] },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });

    const physW = Math.max(1, Math.round(this.width * this.dpr));
    const physH = Math.max(1, Math.round(this.height * this.dpr));
    pass.setViewport(0, 0, physW, physH, 0, 1);

    let drawCalls = 0;
    let rectInstances = 0;
    let lineInstances = 0;
    let arcInstances = 0;
    let glyphInstances = 0;

    for (const batch of batches) {
      batch.camera.writeUniform(this.uniformScratch, this.width, this.height, this.dpr);
      this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformScratch);

      if (batch.scissor) {
        const sx = Math.max(0, Math.min(physW - 1, Math.floor(batch.scissor.x * this.dpr)));
        const sy = Math.max(0, Math.min(physH - 1, Math.floor(batch.scissor.y * this.dpr)));
        const sw = Math.max(1, Math.min(physW - sx, Math.ceil(batch.scissor.w * this.dpr)));
        const sh = Math.max(1, Math.min(physH - sy, Math.ceil(batch.scissor.h * this.dpr)));
        pass.setScissorRect(sx, sy, sw, sh);
      } else {
        pass.setScissorRect(0, 0, physW, physH);
      }

      if (batch.rects > 0) {
        const data = batch.rectView();
        const grown = this.growBuffer(this.rectBuffer, this.rectBufBytes, data.byteLength);
        this.rectBuffer = grown.buf;
        this.rectBufBytes = grown.bytes;
        this.device.queue.writeBuffer(this.rectBuffer, 0, data);
        pass.setPipeline(this.rectPipeline);
        pass.setBindGroup(0, this.rectBindGroup);
        pass.setVertexBuffer(0, this.rectBuffer);
        pass.draw(6, batch.rects);
        drawCalls++;
        rectInstances += batch.rects;
      }

      if (batch.lines > 0) {
        const data = batch.lineView();
        const grown = this.growBuffer(this.lineBuffer, this.lineBufBytes, data.byteLength);
        this.lineBuffer = grown.buf;
        this.lineBufBytes = grown.bytes;
        this.device.queue.writeBuffer(this.lineBuffer, 0, data);
        pass.setPipeline(this.linePipeline);
        pass.setBindGroup(0, this.lineBindGroup);
        pass.setVertexBuffer(0, this.lineBuffer);
        pass.draw(6, batch.lines);
        drawCalls++;
        lineInstances += batch.lines;
      }

      if (batch.arcs > 0) {
        const data = batch.arcView();
        const grown = this.growBuffer(this.arcBuffer, this.arcBufBytes, data.byteLength);
        this.arcBuffer = grown.buf;
        this.arcBufBytes = grown.bytes;
        this.device.queue.writeBuffer(this.arcBuffer, 0, data);
        pass.setPipeline(this.arcPipeline);
        pass.setBindGroup(0, this.arcBindGroup);
        pass.setVertexBuffer(0, this.arcBuffer);
        pass.draw(6, batch.arcs);
        drawCalls++;
        arcInstances += batch.arcs;
      }

      if (batch.glyphs > 0) {
        if (this.glyphAtlas.dirty) {
          this.device.queue.writeTexture(
            { texture: this.atlasTexture },
            this.glyphAtlas.data,
            { bytesPerRow: this.glyphAtlas.width, rowsPerImage: this.glyphAtlas.height },
            { width: this.glyphAtlas.width, height: this.glyphAtlas.height },
          );
          this.glyphAtlas.markClean();
        }
        const data = batch.glyphView();
        const grown = this.growBuffer(this.glyphBuffer, this.glyphBufBytes, data.byteLength);
        this.glyphBuffer = grown.buf;
        this.glyphBufBytes = grown.bytes;
        this.device.queue.writeBuffer(this.glyphBuffer, 0, data);
        pass.setPipeline(this.glyphPipeline);
        pass.setBindGroup(0, this.glyphBindGroup);
        pass.setVertexBuffer(0, this.glyphBuffer);
        pass.draw(6, batch.glyphs);
        drawCalls++;
        glyphInstances += batch.glyphs;
      }
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
    return {
      backend: this.kind,
      drawCalls,
      rectInstances,
      lineInstances,
      arcInstances,
      glyphInstances,
      frameTimeMs: performance.now() - t0,
    };
  }

  dispose(): void {
    this.uniformBuffer.destroy();
    this.rectBuffer.destroy();
    this.lineBuffer.destroy();
    this.arcBuffer.destroy();
    this.glyphBuffer.destroy();
    this.atlasTexture.destroy();
    this.device.destroy?.();
  }
}

// ---------------------------------------------------------------------------
// WebGL2 Backend (automatic fallback when WebGPU is unavailable)
// ---------------------------------------------------------------------------

interface WebGL2Like {
  VERTEX_SHADER: number;
  FRAGMENT_SHADER: number;
  COMPILE_STATUS: number;
  LINK_STATUS: number;
  ARRAY_BUFFER: number;
  DYNAMIC_DRAW: number;
  FLOAT: number;
  TRIANGLES: number;
  BLEND: number;
  ONE: number;
  ONE_MINUS_SRC_ALPHA: number;
  COLOR_BUFFER_BIT: number;
  SCISSOR_TEST: number;
  TEXTURE_2D: number;
  TEXTURE0: number;
  TEXTURE_MIN_FILTER: number;
  TEXTURE_MAG_FILTER: number;
  TEXTURE_WRAP_S: number;
  TEXTURE_WRAP_T: number;
  NEAREST: number;
  CLAMP_TO_EDGE: number;
  UNPACK_ALIGNMENT: number;
  R8: number;
  RED: number;
  UNSIGNED_BYTE: number;
  createShader(type: number): unknown;
  shaderSource(shader: unknown, src: string): void;
  compileShader(shader: unknown): void;
  getShaderParameter(shader: unknown, pname: number): unknown;
  getShaderInfoLog(shader: unknown): string | null;
  deleteShader(shader: unknown): void;
  createProgram(): unknown;
  attachShader(prog: unknown, shader: unknown): void;
  linkProgram(prog: unknown): void;
  getProgramParameter(prog: unknown, pname: number): unknown;
  getProgramInfoLog(prog: unknown): string | null;
  deleteProgram(prog: unknown): void;
  useProgram(prog: unknown): void;
  getUniformLocation(prog: unknown, name: string): unknown;
  uniform4f(loc: unknown, x: number, y: number, z: number, w: number): void;
  uniform1i(loc: unknown, v: number): void;
  createVertexArray(): unknown;
  bindVertexArray(vao: unknown): void;
  deleteVertexArray(vao: unknown): void;
  createBuffer(): unknown;
  bindBuffer(target: number, buf: unknown): void;
  bufferData(target: number, data: ArrayBufferView | number, usage: number): void;
  deleteBuffer(buf: unknown): void;
  createTexture(): unknown;
  activeTexture(unit: number): void;
  bindTexture(target: number, tex: unknown): void;
  texParameteri(target: number, pname: number, param: number): void;
  pixelStorei(pname: number, param: number): void;
  texImage2D(
    target: number,
    level: number,
    internalformat: number,
    width: number,
    height: number,
    border: number,
    format: number,
    type: number,
    pixels: ArrayBufferView | null,
  ): void;
  deleteTexture(tex: unknown): void;
  enableVertexAttribArray(idx: number): void;
  vertexAttribPointer(idx: number, size: number, type: number, norm: boolean, stride: number, offset: number): void;
  vertexAttribDivisor(idx: number, divisor: number): void;
  enable(cap: number): void;
  disable(cap: number): void;
  blendFunc(sfactor: number, dfactor: number): void;
  viewport(x: number, y: number, w: number, h: number): void;
  scissor(x: number, y: number, w: number, h: number): void;
  clearColor(r: number, g: number, b: number, a: number): void;
  clear(mask: number): void;
  drawArraysInstanced(mode: number, first: number, count: number, instanceCount: number): void;
}

interface GlPipeline {
  program: unknown;
  vao: unknown;
  vbo: unknown;
  uCam0: unknown;
  uCam1: unknown;
}

/** WebGL2 instanced SDF + glyph atlas backend (automatic fallback for Safari/Firefox/older GPUs). */
export class WebGL2Backend implements GpuBackend {
  readonly kind: GpuBackendKind = "webgl2";
  readonly glyphAtlas: GlyphAtlas;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private uniformScratch = new Float32Array(8);
  private rectPipe: GlPipeline;
  private linePipe: GlPipeline;
  private arcPipe: GlPipeline;
  private glyphPipe: GlPipeline;
  private glyphAtlasLoc: unknown;
  private atlasTexture: unknown;

  constructor(private readonly gl: WebGL2Like, glyphAtlas: GlyphAtlas = new GlyphAtlas()) {
    this.glyphAtlas = glyphAtlas;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.rectPipe = this.buildPipeline(GLSL300_RECT_VS, GLSL300_RECT_FS, RECT_STRIDE, [0, 16, 32, 48]);
    this.linePipe = this.buildPipeline(GLSL300_LINE_VS, GLSL300_LINE_FS, LINE_STRIDE, [0, 16, 32]);
    this.arcPipe = this.buildPipeline(GLSL300_ARC_VS, GLSL300_ARC_FS, ARC_STRIDE, [0, 16, 32]);
    this.glyphPipe = this.buildPipeline(GLSL300_GLYPH_VS, GLSL300_GLYPH_FS, GLYPH_STRIDE, [0, 16, 32]);
    this.glyphAtlasLoc = gl.getUniformLocation(this.glyphPipe.program, "uAtlas");

    this.atlasTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      this.glyphAtlas.width,
      this.glyphAtlas.height,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      this.glyphAtlas.data,
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private compileShader(type: number, src: string): unknown {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? "shader compile failed";
      gl.deleteShader(shader);
      throw new Error(`WebGL2 shader error: ${log}`);
    }
    return shader;
  }

  private buildPipeline(vsSrc: string, fsSrc: string, strideFloats: number, offsets: number[]): GlPipeline {
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, vsSrc);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSrc);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? "program link failed";
      gl.deleteProgram(program);
      throw new Error(`WebGL2 link error: ${log}`);
    }
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const strideBytes = strideFloats * 4;
    offsets.forEach((off, loc) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, strideBytes, off);
      gl.vertexAttribDivisor(loc, 1);
    });
    gl.bindVertexArray(null);
    return {
      program,
      vao,
      vbo,
      uCam0: gl.getUniformLocation(program, "uCamera0"),
      uCam1: gl.getUniformLocation(program, "uCamera1"),
    };
  }

  resize(widthPx: number, heightPx: number, dpr: number): void {
    this.width = Math.max(1, Math.floor(widthPx));
    this.height = Math.max(1, Math.floor(heightPx));
    this.dpr = Math.max(1, dpr);
  }

  private drawPipe(pipe: GlPipeline, data: Float32Array, instanceCount: number, bindAtlas = false): void {
    const gl = this.gl;
    const u = this.uniformScratch;
    gl.useProgram(pipe.program);
    gl.uniform4f(pipe.uCam0, u[0], u[1], u[2], u[3]);
    gl.uniform4f(pipe.uCam1, u[4], u[5], u[6], u[7]);
    if (bindAtlas) {
      gl.uniform1i(this.glyphAtlasLoc, 0);
    }
    gl.bindVertexArray(pipe.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, pipe.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, instanceCount);
    gl.bindVertexArray(null);
  }

  render(batches: readonly InstanceBatch[], clearColor: RgbaTuple): GpuFrameStats {
    const t0 = performance.now();
    const gl = this.gl;
    const physW = Math.max(1, Math.round(this.width * this.dpr));
    const physH = Math.max(1, Math.round(this.height * this.dpr));
    gl.viewport(0, 0, physW, physH);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);

    let drawCalls = 0;
    let rectInstances = 0;
    let lineInstances = 0;
    let arcInstances = 0;
    let glyphInstances = 0;

    for (const batch of batches) {
      batch.camera.writeUniform(this.uniformScratch, this.width, this.height, this.dpr);

      if (batch.scissor) {
        gl.enable(gl.SCISSOR_TEST);
        const sx = Math.max(0, Math.floor(batch.scissor.x * this.dpr));
        const sw = Math.max(0, Math.ceil(batch.scissor.w * this.dpr));
        const sh = Math.max(0, Math.ceil(batch.scissor.h * this.dpr));
        // WebGL scissor origin is bottom-left
        const sy = Math.max(0, physH - Math.ceil((batch.scissor.y + batch.scissor.h) * this.dpr));
        gl.scissor(sx, sy, sw, sh);
      } else {
        gl.disable(gl.SCISSOR_TEST);
      }

      if (batch.rects > 0) {
        this.drawPipe(this.rectPipe, batch.rectView(), batch.rects);
        drawCalls++;
        rectInstances += batch.rects;
      }
      if (batch.lines > 0) {
        this.drawPipe(this.linePipe, batch.lineView(), batch.lines);
        drawCalls++;
        lineInstances += batch.lines;
      }
      if (batch.arcs > 0) {
        this.drawPipe(this.arcPipe, batch.arcView(), batch.arcs);
        drawCalls++;
        arcInstances += batch.arcs;
      }
      if (batch.glyphs > 0) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
        if (this.glyphAtlas.dirty) {
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.R8,
            this.glyphAtlas.width,
            this.glyphAtlas.height,
            0,
            gl.RED,
            gl.UNSIGNED_BYTE,
            this.glyphAtlas.data,
          );
          this.glyphAtlas.markClean();
        }
        this.drawPipe(this.glyphPipe, batch.glyphView(), batch.glyphs, true);
        drawCalls++;
        glyphInstances += batch.glyphs;
      }
    }

    gl.disable(gl.SCISSOR_TEST);
    return {
      backend: this.kind,
      drawCalls,
      rectInstances,
      lineInstances,
      arcInstances,
      glyphInstances,
      frameTimeMs: performance.now() - t0,
    };
  }

  dispose(): void {
    const gl = this.gl;
    for (const pipe of [this.rectPipe, this.linePipe, this.arcPipe, this.glyphPipe]) {
      gl.deleteBuffer(pipe.vbo);
      gl.deleteVertexArray(pipe.vao);
      gl.deleteProgram(pipe.program);
    }
    gl.deleteTexture(this.atlasTexture);
  }
}

/** Deterministic zero-GPU backend for Node.js, SSR, and automated testing. */
export class HeadlessNullBackend implements GpuBackend {
  readonly kind: GpuBackendKind = "headless";
  readonly glyphAtlas: GlyphAtlas;
  lastWidth = 1;
  lastHeight = 1;
  lastDpr = 1;
  lastBatches: readonly InstanceBatch[] = [];

  constructor(glyphAtlas: GlyphAtlas = new GlyphAtlas()) {
    this.glyphAtlas = glyphAtlas;
  }

  resize(widthPx: number, heightPx: number, dpr: number): void {
    this.lastWidth = Math.max(1, Math.floor(widthPx));
    this.lastHeight = Math.max(1, Math.floor(heightPx));
    this.lastDpr = Math.max(1, dpr);
  }

  render(batches: readonly InstanceBatch[]): GpuFrameStats {
    const t0 = performance.now();
    this.lastBatches = batches;
    let drawCalls = 0;
    let rectInstances = 0;
    let lineInstances = 0;
    let arcInstances = 0;
    let glyphInstances = 0;
    for (const b of batches) {
      if (b.rects > 0) { drawCalls++; rectInstances += b.rects; }
      if (b.lines > 0) { drawCalls++; lineInstances += b.lines; }
      if (b.arcs > 0) { drawCalls++; arcInstances += b.arcs; }
      if (b.glyphs > 0) { drawCalls++; glyphInstances += b.glyphs; }
    }
    return {
      backend: this.kind,
      drawCalls,
      rectInstances,
      lineInstances,
      arcInstances,
      glyphInstances,
      frameTimeMs: performance.now() - t0,
    };
  }

  dispose(): void {
    this.lastBatches = [];
  }
}

export interface GpuSurfaceOptions {
  prefer?: "webgpu" | "webgl2" | "headless";
  clearColor?: RgbaTuple;
  dpr?: number;
  glyphAtlas?: GlyphAtlas;
  navigatorGpu?: {
    requestAdapter(): Promise<{ requestDevice(): Promise<WebGpuDeviceLike> } | null>;
    getPreferredCanvasFormat?(): string;
  };
}

/**
 * Unified GPU Surface managing WebGPU -> WebGL2 -> Headless backend lifecycle,
 * shared GlyphAtlas, DPI resize, dirty-frame RAF scheduling, and batch submission.
 */
export class GpuSurface {
  readonly backend: GpuBackend;
  readonly glyphAtlas: GlyphAtlas;
  private clearColor: RgbaTuple;
  private width = 1;
  private height = 1;
  private dpr: number;
  private dirty = false;
  private rafId: number | null = null;
  private frameCallback: (() => readonly InstanceBatch[]) | null = null;
  private lastStats: GpuFrameStats | null = null;
  private disposed = false;

  private constructor(
    private readonly canvas: GpuCanvasLike | null,
    backend: GpuBackend,
    clearColor: RgbaTuple,
    dpr: number,
  ) {
    this.backend = backend;
    this.glyphAtlas = backend.glyphAtlas;
    this.clearColor = clearColor;
    this.dpr = Math.max(1, dpr);
  }

  static async create(canvas: GpuCanvasLike | null, options: GpuSurfaceOptions = {}): Promise<GpuSurface> {
    const clearColor: RgbaTuple = options.clearColor ?? [1, 1, 1, 1];
    const dpr = options.dpr ?? (typeof globalThis.devicePixelRatio === "number" ? globalThis.devicePixelRatio : 1);
    const prefer = options.prefer ?? "webgpu";
    const glyphAtlas = options.glyphAtlas ?? new GlyphAtlas();

    if (canvas && prefer !== "headless") {
      // 1. Try WebGPU primary backend
      if (prefer === "webgpu") {
        const navGpu =
          options.navigatorGpu ??
          (typeof navigator !== "undefined" ? (navigator as unknown as { gpu?: GpuSurfaceOptions["navigatorGpu"] }).gpu : undefined);
        if (navGpu) {
          try {
            const adapter = await navGpu.requestAdapter();
            const device = adapter ? await adapter.requestDevice() : null;
            const ctx = device ? (canvas.getContext("webgpu") as WebGpuContextLike | null) : null;
            if (device && ctx) {
              const fmt = navGpu.getPreferredCanvasFormat?.() ?? "bgra8unorm";
              return new GpuSurface(canvas, new WebGPUBackend(device, ctx, fmt, glyphAtlas), clearColor, dpr);
            }
          } catch {
            // Fall through to WebGL2
          }
        }
      }

      // 2. Fallback to WebGL2 (never Canvas 2D!)
      try {
        const gl = canvas.getContext("webgl2", {
          alpha: true,
          antialias: true,
          premultipliedAlpha: true,
          powerPreference: "high-performance",
        }) as WebGL2Like | null;
        if (gl) {
          return new GpuSurface(canvas, new WebGL2Backend(gl, glyphAtlas), clearColor, dpr);
        }
      } catch {
        // Fall through to HeadlessNullBackend
      }
    }

    return new GpuSurface(canvas, new HeadlessNullBackend(glyphAtlas), clearColor, dpr);
  }

  get backendKind(): GpuBackendKind {
    return this.backend.kind;
  }

  get stats(): GpuFrameStats | null {
    return this.lastStats;
  }

  setClearColor(color: RgbaTuple): void {
    this.clearColor = color;
  }

  resize(widthPx: number, heightPx: number, dpr = this.dpr): void {
    this.width = Math.max(1, Math.floor(widthPx));
    this.height = Math.max(1, Math.floor(heightPx));
    this.dpr = Math.max(1, dpr);
    if (this.canvas) {
      this.canvas.width = Math.round(this.width * this.dpr);
      this.canvas.height = Math.round(this.height * this.dpr);
      if (this.canvas.style) {
        this.canvas.style.width = `${this.width}px`;
        this.canvas.style.height = `${this.height}px`;
      }
    }
    this.backend.resize(this.width, this.height, this.dpr);
  }

  /** Render batches immediately and return frame telemetry. */
  render(batches: readonly InstanceBatch[]): GpuFrameStats {
    if (this.disposed) {
      return {
        backend: this.backend.kind,
        drawCalls: 0,
        rectInstances: 0,
        lineInstances: 0,
        arcInstances: 0,
        glyphInstances: 0,
        frameTimeMs: 0,
      };
    }
    this.dirty = false;
    this.lastStats = this.backend.render(batches, this.clearColor);
    return this.lastStats;
  }

  /** Bind a lazy batch producer for dirty-frame RAF rendering. */
  setFrameProducer(producer: () => readonly InstanceBatch[]): void {
    this.frameCallback = producer;
  }

  /** Coalesce multiple mutations into a single GPU render pass on the next animation frame. */
  markDirty(): void {
    if (this.disposed || this.dirty) return;
    this.dirty = true;
    const raf = typeof globalThis.requestAnimationFrame === "function"
      ? globalThis.requestAnimationFrame
      : (cb: () => void) => setTimeout(cb, 0) as unknown as number;
    this.rafId = raf(() => {
      this.rafId = null;
      if (!this.disposed && this.dirty && this.frameCallback) {
        this.render(this.frameCallback());
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.rafId !== null && typeof globalThis.cancelAnimationFrame === "function") {
      globalThis.cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
    this.frameCallback = null;
    this.backend.dispose();
  }
}
