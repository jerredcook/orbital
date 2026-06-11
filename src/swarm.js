// swarm.js — one-draw-call GPU point cloud for the whole catalog.
//
// PointPrimitiveCollection re-validates per-point state on every position
// write, which is fine at 14k objects but not where this catalog is headed.
// This primitive owns its vertex buffers directly: each worker tick costs two
// bufferSubData uploads (position high/low halves) and a single gl.POINTS
// draw for every object on orbit.
//
// Positions are encoded as high/low float32 pairs and reassembled with
// czm_translateRelativeToEye so dots stay jitter-free at close zoom even
// though the GPU only has 32-bit floats.  Per-point visibility lives in the
// color alpha; hidden points are parked outside clip space in the vertex
// shader so they cost no fill and are unpickable.
//
// Uses Cesium renderer internals (DrawCommand, ShaderProgram, …).  They are
// exported but undocumented, so treat Cesium upgrades as API-break suspects.

import {
  BoundingSphere, Buffer, BufferUsage, Cartesian3, ComponentDatatype,
  DrawCommand, Matrix4, Pass, PrimitiveType, RenderState, ShaderProgram,
  VertexArray,
} from 'cesium';

const ATTRIBUTE_LOCATIONS = {
  positionHigh: 0,
  positionLow: 1,
  color: 2,
  size: 3,
  pickColor: 4,
};

const VS = /* glsl */ `
in vec3 positionHigh;
in vec3 positionLow;
in vec4 color;
in float size;
in vec4 pickColor;
out vec4 v_color;
out vec4 v_pickColor;

void main() {
  if (color.a == 0.0) {            // hidden or failed propagation
    gl_Position = vec4(-2.0, -2.0, -2.0, 1.0);
    gl_PointSize = 0.0;
    v_color = vec4(0.0);
    v_pickColor = vec4(0.0);
    return;
  }
  vec4 p = czm_translateRelativeToEye(positionHigh, positionLow);
  vec4 positionEC = czm_modelViewRelativeToEye * p;
  gl_Position = czm_projection * positionEC;

  // Same feel as the old scaleByDistance NearFarScalar(2.0e6, 2.2, 6.0e7, 1.0):
  // size is the far-distance pixel size, scaled up 2.2x when the camera is close.
  float t = clamp((length(positionEC.xyz) - 2.0e6) / (6.0e7 - 2.0e6), 0.0, 1.0);
  gl_PointSize = size * mix(2.2, 1.0, t) * czm_pixelRatio;

  v_color = color;
  v_pickColor = pickColor;
}
`;

const FS = /* glsl */ `
in vec4 v_color;
in vec4 v_pickColor;

void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  if (dot(d, d) > 0.25) discard;   // round sprite
  out_FragColor = v_color;
}
`;

export class SatSwarm {
  constructor(count) {
    this._count = count;
    this.show = true;

    this._high = new Float32Array(count * 3);
    this._low = new Float32Array(count * 3);
    this._colors = new Uint8Array(count * 4);   // RGBA, A doubles as show
    this._sizes = new Float32Array(count);
    this._alive = new Uint8Array(count);        // propagation succeeded
    this._visible = new Uint8Array(count).fill(1);
    this._suppressed = -1;                      // index hidden during selection

    this._posDirty = false;
    this._colorDirty = false;
    this._va = null;
    this._sp = null;
    this._command = null;
    this._pickIds = [];
  }

  /** Base color (Cesium Color) and pixel size for one point. Init-time only. */
  setStyle(i, color, size) {
    const c = i * 4;
    this._colors[c] = color.red * 255;
    this._colors[c + 1] = color.green * 255;
    this._colors[c + 2] = color.blue * 255;
    this._sizes[i] = size;
    this._refreshAlpha(i);
  }

  /** New ECF positions for the whole catalog (Float64Array, meters, NaN = dead). */
  updatePositions(buf) {
    const n = Math.min(this._count, buf.length / 3 | 0);
    for (let i = 0; i < n; i++) {
      const x = buf[i * 3];
      if (Number.isNaN(x)) {
        if (this._alive[i]) { this._alive[i] = 0; this._refreshAlpha(i); }
        continue;
      }
      if (!this._alive[i]) { this._alive[i] = 1; this._refreshAlpha(i); }
      for (let k = 0; k < 3; k++) {
        const v = buf[i * 3 + k];
        const high = v >= 0
          ? Math.floor(v / 65536) * 65536
          : -(Math.floor(-v / 65536) * 65536);
        this._high[i * 3 + k] = high;
        this._low[i * 3 + k] = v - high;
      }
    }
    this._posDirty = true;
  }

  setVisible(i, visible) {
    this._visible[i] = visible ? 1 : 0;
    this._refreshAlpha(i);
  }

  /** Hide one point (the selection overlay replaces it); -1 to clear. */
  setSuppressed(index) {
    const prev = this._suppressed;
    this._suppressed = index;
    if (prev >= 0) this._refreshAlpha(prev);
    if (index >= 0) this._refreshAlpha(index);
  }

  _refreshAlpha(i) {
    this._colors[i * 4 + 3] =
      this._alive[i] && this._visible[i] && i !== this._suppressed ? 255 : 0;
    this._colorDirty = true;
  }

  update(frameState) {
    if (this._count === 0) return;
    const context = frameState.context;
    if (!this._va) this._createResources(context);

    if (this._posDirty) {
      this._highBuffer.copyFromArrayView(this._high);
      this._lowBuffer.copyFromArrayView(this._low);
      this._posDirty = false;
    }
    if (this._colorDirty) {
      this._colorBuffer.copyFromArrayView(this._colors);
      this._colorDirty = false;
    }

    if (!this.show) return;
    if (frameState.passes.render || frameState.passes.pick) {
      frameState.commandList.push(this._command);
    }
  }

  _createResources(context) {
    const n = this._count;

    // Pick IDs: scene.pick resolves the pick-buffer color back to the object
    // registered here, so main.js sees { id: catalogIndex } like before.
    const pickBytes = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const pickId = context.createPickId({ primitive: this, id: i });
      this._pickIds.push(pickId);
      const c = pickId.color;
      pickBytes[i * 4] = c.red * 255;
      pickBytes[i * 4 + 1] = c.green * 255;
      pickBytes[i * 4 + 2] = c.blue * 255;
      pickBytes[i * 4 + 3] = c.alpha * 255;
    }

    const vb = (typedArray, usage) =>
      Buffer.createVertexBuffer({ context, typedArray, usage });
    this._highBuffer = vb(this._high, BufferUsage.STREAM_DRAW);
    this._lowBuffer = vb(this._low, BufferUsage.STREAM_DRAW);
    this._colorBuffer = vb(this._colors, BufferUsage.DYNAMIC_DRAW);

    this._va = new VertexArray({
      context,
      attributes: [
        { index: ATTRIBUTE_LOCATIONS.positionHigh, vertexBuffer: this._highBuffer,
          componentsPerAttribute: 3, componentDatatype: ComponentDatatype.FLOAT },
        { index: ATTRIBUTE_LOCATIONS.positionLow, vertexBuffer: this._lowBuffer,
          componentsPerAttribute: 3, componentDatatype: ComponentDatatype.FLOAT },
        { index: ATTRIBUTE_LOCATIONS.color, vertexBuffer: this._colorBuffer,
          componentsPerAttribute: 4, componentDatatype: ComponentDatatype.UNSIGNED_BYTE,
          normalize: true },
        { index: ATTRIBUTE_LOCATIONS.size,
          vertexBuffer: vb(this._sizes, BufferUsage.STATIC_DRAW),
          componentsPerAttribute: 1, componentDatatype: ComponentDatatype.FLOAT },
        { index: ATTRIBUTE_LOCATIONS.pickColor,
          vertexBuffer: vb(pickBytes, BufferUsage.STATIC_DRAW),
          componentsPerAttribute: 4, componentDatatype: ComponentDatatype.UNSIGNED_BYTE,
          normalize: true },
      ],
    });

    this._sp = ShaderProgram.fromCache({
      context,
      vertexShaderSource: VS,
      fragmentShaderSource: FS,
      attributeLocations: ATTRIBUTE_LOCATIONS,
    });

    this._command = new DrawCommand({
      vertexArray: this._va,
      shaderProgram: this._sp,
      renderState: RenderState.fromCache({ depthTest: { enabled: true } }),
      primitiveType: PrimitiveType.POINTS,
      pass: Pass.OPAQUE,
      modelMatrix: Matrix4.IDENTITY,
      // Generous: covers GEO and every HEO apogee in the public catalog.
      boundingVolume: new BoundingSphere(Cartesian3.ZERO, 6.0e8),
      owner: this,
      count: n,
      pickId: 'v_pickColor',
    });
  }

  isDestroyed() {
    return false;
  }

  destroy() {
    this._va = this._va && this._va.destroy();           // destroys its buffers
    this._sp = this._sp && this._sp.destroy();
    for (const p of this._pickIds) p.destroy();
    this._pickIds.length = 0;
    return undefined;
  }
}
