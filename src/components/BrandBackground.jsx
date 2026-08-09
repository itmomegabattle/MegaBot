import { useEffect, useRef } from "react";
import "../styles/brand-background.css";

const DESKTOP_FPS = 30;
const MOBILE_FPS = 24;
const CURSOR_RESPONSE = 2.15;

const VERTEX_SHADER = `#version 300 es
in vec2 position;

void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uMouse;
uniform float uMouseActive;
uniform float uMouseStrength;
uniform float uThickness;
uniform vec3 uBackgroundTop;
uniform vec3 uBackgroundBottom;
uniform vec3 uLineColor;
uniform vec3 uPulseColor;

out vec4 fragColor;

#define ROOT_COUNT 4
#define MERGE_COUNT 2
#define BRANCH_COUNT 3
#define TOP_LEFT_BRANCH_COUNT 1

float saturate(float value) {
  return clamp(value, 0.0, 1.0);
}

float easeInOut(float value) {
  float x = saturate(value);
  return x * x * (3.0 - 2.0 * x);
}

float wrappedDistance(float a, float b) {
  float direct = abs(a - b);
  return min(direct, 1.0 - direct);
}

float rootY(float index, float x, float time) {
  float base = 0.13 + index * 0.246;
  float phase = index * 1.73;
  float longArc = sin((x * 0.92 + index * 0.11) * 3.14159265) * (0.012 + index * 0.002);
  float sCurve = sin(x * 4.7 + phase + time * 0.115) * 0.012;
  float softWave = sin(x * x * 3.3 - phase * 0.36 - time * 0.072) * 0.008;
  float slope = (index - 1.5) * (x - 0.5) * 0.011;
  float y = base + longArc + sCurve + softWave + slope;

  // Give every main route its own large-scale direction. Only short sections
  // around deliberate splits remain parallel to one another.
  if (index < 0.5) {
    y += x * 0.135 + sin(x * 3.14159265) * 0.024;
  } else if (index < 1.5) {
    y += sin(x * 6.2831853) * 0.035;
  } else if (index < 2.5) {
    y -= x * 0.165;
    y += sin(x * 3.14159265) * 0.035;
  } else {
    y -= sin(x * 3.14159265) * 0.095 + x * 0.02;
  }

  // Fan the first third of the routes apart so their entry tangents do not
  // read as three parallel rails.
  float leftFan = sin(easeInOut(x / 0.36) * 3.14159265);
  if (index > 0.5 && index < 1.5) {
    y += leftFan * 0.018;
  } else if (index > 1.5 && index < 2.5) {
    y -= leftFan * 0.024;
  } else if (index > 2.5) {
    y += leftFan * 0.032;
  }

  // Break the left-to-right rail effect: the lowest route enters from the
  // bottom, while the highest route leaves through the top.
  if (index < 0.5) {
    float bottomEntrance = 1.0 - easeInOut(x / 0.22);
    y -= bottomEntrance * 0.285;
  } else if (index > 2.5) {
    float topExit = easeInOut((x - 0.7) / 0.3);
    y += topExit * 0.245;
  }

  float dx = (x - uMouse.x) / 0.3;
  float dy = (y - uMouse.y) / 0.27;
  float influence = exp(-(dx * dx + dy * dy));
  float curl = sin((x - uMouse.x) * 5.2 + index * 0.5) * 0.22;
  float pull = (uMouse.y - y) * 0.38;
  float smoothSide = smoothstep(-0.075, 0.075, y - uMouse.y) * 2.0 - 1.0;
  float separation = smoothSide * 0.09;
  y += (curl + pull + separation) * influence * uMouseStrength * uMouseActive;

  return y;
}

float branchStart(float index) {
  if (index < 0.5) return 0.2;
  if (index < 1.5) return 0.45;
  return 0.68;
}

float mergePoint(float index) {
  return index < 0.5 ? 0.23 : 0.38;
}

float incomingY(float index, float x, float time, float mergeAt) {
  float parent = rootY(1.0, x, time);
  float progress = easeInOut(x / max(mergeAt, 0.001));
  float direction = index < 0.5 ? -1.0 : 1.0;
  float openingSize = index < 0.5 ? 0.52 : 0.74;
  float opening = direction * openingSize * (1.0 - progress);
  float approachArc = direction * sin(progress * 3.14159265) * 0.017;
  float fineWave = sin(x * 3.8 + index * 2.4 + time * 0.07) * 0.004 * (1.0 - progress);
  return parent + opening + approachArc + fineWave;
}

float branchRoot(float index) {
  if (index < 0.5) return 0.0;
  return 2.0;
}

float branchDirection(float index) {
  if (index < 0.5) return -1.0;
  if (index < 1.5) return -1.0;
  return 1.0;
}

float branchProfile(float index, float progress) {
  float shaped = easeInOut(progress);

  if (index < 0.5) {
    return shaped + sin(shaped * 3.14159265) * 0.085;
  }

  if (index < 1.5) {
    return shaped - sin(shaped * 3.14159265) * 0.065;
  }

  return shaped + sin(shaped * 6.2831853) * 0.04;
}

float branchY(float index, float x, float time, float start) {
  float parent = rootY(branchRoot(index), x, time);
  float progress = branchProfile(index, (x - start) / max(0.001, 1.0 - start));
  float direction = branchDirection(index);

  float mouseDx = (x - uMouse.x) / 0.27;
  float mouseDy = (parent - uMouse.y) / 0.3;
  float mouseInfluence = exp(-(mouseDx * mouseDx + mouseDy * mouseDy)) * uMouseActive;

  float baseSeparation = index > 1.5 ? 0.5 : (index < 0.5 ? 0.3 : 0.116);
  float separation = baseSeparation * (1.0 + mouseInfluence * 0.22);
  float sculptedBend = sin(progress * 6.2831853) * 0.014 * progress;
  float independentWave = sin(x * 3.15 + index * 2.1 - time * 0.095) * 0.007 * progress;

  return parent + direction * (separation * progress + sculptedBend) + independentWave;
}

float returningBranchY(float x, float time, float start, float mergeAt) {
  float source = rootY(2.0, x, time);
  float destination = rootY(1.0, x, time);
  float progress = easeInOut((x - start) / max(mergeAt - start, 0.001));
  float approach = sin(progress * 3.14159265) * 0.024;
  return mix(source, destination, progress) - approach;
}

float topLeftBranchY(float x, float time, float start) {
  float parent = rootY(3.0, x, time);
  float rawProgress = saturate((x - start) / max(1.0 - start, 0.001));
  float progress = easeInOut(pow(rawProgress, 0.72));
  float longArc = sin(progress * 3.14159265) * 0.014;
  float fineWave = sin(x * 3.45 + time * 0.065) * 0.004 * progress;
  return parent - 0.132 * progress - longArc + fineWave;
}

float lineCore(float distanceToLine, float width) {
  return smoothstep(width * 1.18, width * 0.28, distanceToLine);
}

float lineHalo(float distanceToLine, float width) {
  return exp(-distanceToLine / max(width * 3.8, 0.0001));
}

float pulseAt(float x, float time, float phase, float speed) {
  float position = fract(phase + time * speed);
  float distanceToPulse = wrappedDistance(x, position);
  return exp(-pow(distanceToPulse / 0.064, 2.0));
}

void accumulateThread(
  inout vec3 color,
  vec2 uv,
  float y,
  float width,
  float pulse,
  float visibility,
  float variation
) {
  float distanceToLine = abs(uv.y - y);
  float core = lineCore(distanceToLine, width) * visibility;
  float halo = lineHalo(distanceToLine, width) * visibility;
  float quietLight = 0.72 + 0.08 * sin(uTime * 0.24 + variation);
  float hoverX = (uv.x - uMouse.x) / 0.105;
  float hoverY = (y - uMouse.y) / 0.115;
  float hoverSegment = exp(-(hoverX * hoverX + hoverY * hoverY)) * uMouseActive;

  color += uLineColor * (core * quietLight + halo * 0.075);
  color += mix(uLineColor, uPulseColor, 0.84) * core * pulse * 1.55;
  color += uPulseColor * halo * pulse * 0.13;
  color += mix(uLineColor, uPulseColor, 0.92) * core * hoverSegment * 1.55;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution.xy;
  float width = uThickness / uResolution.y;

  float verticalShade = smoothstep(0.0, 1.0, uv.y);
  vec3 color = mix(uBackgroundBottom, uBackgroundTop, verticalShade);

  float edge = distance(uv, vec2(0.5));
  color *= 1.0 - smoothstep(0.38, 0.82, edge) * 0.13;

  for (int merge = 0; merge < MERGE_COUNT; merge++) {
    float index = float(merge);
    float mergeAt = mergePoint(index);
    float visibility = 1.0 - smoothstep(mergeAt - 0.008, mergeAt + 0.024, uv.x);
    float y = incomingY(index, uv.x, uTime, mergeAt);
    float pulse = pulseAt(uv.x, uTime, 1.0 * 0.233 + 0.08, 0.027 + 0.0017);
    accumulateThread(color, uv, y, width, pulse, visibility, 9.6 + index);
  }

  for (int root = 0; root < ROOT_COUNT; root++) {
    float index = float(root);
    float y = rootY(index, uv.x, uTime);
    float pulse = pulseAt(uv.x, uTime, index * 0.233 + 0.08, 0.027 + index * 0.0017);
    accumulateThread(color, uv, y, width, pulse, 1.0, index * 1.37);
  }

  for (int topBranch = 0; topBranch < TOP_LEFT_BRANCH_COUNT; topBranch++) {
    float start = 0.035;
    float visibility = smoothstep(start - 0.006, start + 0.022, uv.x);
    float y = topLeftBranchY(uv.x, uTime, start);
    float pulse = pulseAt(uv.x, uTime, 3.0 * 0.233 + 0.08, 0.027 + 3.0 * 0.0017);
    accumulateThread(color, uv, y, width, pulse, visibility, 11.8);
  }

  for (int branch = 0; branch < BRANCH_COUNT; branch++) {
    float index = float(branch);
    float start = branchStart(index);
    float visibility = smoothstep(start - 0.006, start + 0.022, uv.x);
    bool returnsToNetwork = index > 0.5 && index < 1.5;
    float mergeAt = 0.82;

    if (returnsToNetwork) {
      visibility *= 1.0 - smoothstep(mergeAt - 0.008, mergeAt + 0.024, uv.x);
    }

    float y = returnsToNetwork
      ? returningBranchY(uv.x, uTime, start, mergeAt)
      : branchY(index, uv.x, uTime, start);
    float parentIndex = branchRoot(index);
    float pulse = pulseAt(uv.x, uTime, parentIndex * 0.233 + 0.08, 0.027 + parentIndex * 0.0017);
    accumulateThread(color, uv, y, width, pulse, visibility, 4.8 + index);
  }

  fragColor = vec4(color, 1.0);
}
`;

const DARK_PALETTE = {
  backgroundTop: [0.006, 0.016, 0.035],
  backgroundBottom: [0.001, 0.004, 0.011],
  line: [0.0, 0.11, 0.28],
  pulse: [0.025, 0.34, 0.86],
};

const LIGHT_PALETTE = {
  backgroundTop: [0.925, 0.945, 0.975],
  backgroundBottom: [0.855, 0.895, 0.955],
  line: [0.0, 0.22, 0.55],
  pulse: [0.0, 0.36, 0.9],
};

function setVector(target, values) {
  target[0] = values[0];
  target[1] = values[1];
  target[2] = values[2];
}

function isLightTheme() {
  return !document.documentElement.classList.contains("dark-theme");
}

export default function Background() {
  const containerRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    let disposed = false;
    let destroyRenderer = null;

    const setup = async () => {
      const { Mesh, Program, Renderer, Triangle } = await import("ogl");
      if (disposed) return;

      let renderer;

      try {
        renderer = new Renderer({
          webgl: 2,
          alpha: false,
          antialias: false,
          depth: false,
          stencil: false,
          dpr: 1,
          powerPreference: "low-power",
        });
      } catch {
        container.dataset.renderer = "fallback";
        return;
      }

      const gl = renderer.gl;
      const canvas = gl.canvas;
      canvas.className = "brand-background__canvas";
      container.appendChild(canvas);

      const geometry = new Triangle(gl);
      const program = new Program(gl, {
        vertex: VERTEX_SHADER,
        fragment: FRAGMENT_SHADER,
        uniforms: {
          uResolution: { value: new Float32Array([1, 1]) },
          uTime: { value: 0 },
          uMouse: { value: new Float32Array([0.5, 0.5]) },
          uMouseActive: { value: 0 },
          uMouseStrength: { value: 0.085 },
          uThickness: { value: 3.2 },
          uBackgroundTop: { value: new Float32Array(3) },
          uBackgroundBottom: { value: new Float32Array(3) },
          uLineColor: { value: new Float32Array(3) },
          uPulseColor: { value: new Float32Array(3) },
        },
      });
      const mesh = new Mesh(gl, { geometry, program });

      const targetMouse = [0.5, 0.5];
      const currentMouse = [0.5, 0.5];
      let targetMouseActive = 0;
      let currentMouseActive = 0;
      let pendingPointer = null;
      let frameId = 0;
      let lastRenderTime = 0;
      let visible = true;
      let pageVisible = !document.hidden;

      const mobileQuery = window.matchMedia("(max-width: 768px)");
      const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

      const applyTheme = () => {
        const palette = isLightTheme() ? LIGHT_PALETTE : DARK_PALETTE;
        setVector(program.uniforms.uBackgroundTop.value, palette.backgroundTop);
        setVector(program.uniforms.uBackgroundBottom.value, palette.backgroundBottom);
        setVector(program.uniforms.uLineColor.value, palette.line);
        setVector(program.uniforms.uPulseColor.value, palette.pulse);
      };

      const render = (time) => {
        program.uniforms.uTime.value = time * 0.001;
        renderer.render({ scene: mesh });
      };

      const resize = () => {
        const bounds = container.getBoundingClientRect();
        const width = Math.max(1, Math.round(bounds.width));
        const height = Math.max(1, Math.round(bounds.height));
        renderer.setSize(width, height);
        program.uniforms.uResolution.value[0] = gl.drawingBufferWidth;
        program.uniforms.uResolution.value[1] = gl.drawingBufferHeight;
        program.uniforms.uThickness.value = mobileQuery.matches ? 2.7 : 3.2;
        render(performance.now());
      };

      const stop = () => {
        if (frameId) cancelAnimationFrame(frameId);
        frameId = 0;
      };

      const loop = (time) => {
        frameId = 0;
        if (!visible || !pageVisible || reducedMotionQuery.matches) return;

        const fps = mobileQuery.matches ? MOBILE_FPS : DESKTOP_FPS;
        const frameDuration = 1000 / fps;

        if (time - lastRenderTime >= frameDuration) {
          const delta = Math.min(0.1, (time - lastRenderTime) / 1000 || frameDuration / 1000);

          if (pendingPointer) {
            targetMouse[0] = pendingPointer.x;
            targetMouse[1] = pendingPointer.y;
            targetMouseActive = 1;
            pendingPointer = null;
          }

          const easing = 1 - Math.exp(-CURSOR_RESPONSE * delta);
          currentMouse[0] += (targetMouse[0] - currentMouse[0]) * easing;
          currentMouse[1] += (targetMouse[1] - currentMouse[1]) * easing;
          currentMouseActive += (targetMouseActive - currentMouseActive) * easing;

          program.uniforms.uMouse.value[0] = currentMouse[0];
          program.uniforms.uMouse.value[1] = currentMouse[1];
          program.uniforms.uMouseActive.value = currentMouseActive;

          render(time);
          lastRenderTime = time;
        }

        frameId = requestAnimationFrame(loop);
      };

      const start = () => {
        stop();
        if (visible && pageVisible && !reducedMotionQuery.matches) {
          lastRenderTime = 0;
          frameId = requestAnimationFrame(loop);
        } else {
          render(performance.now());
        }
      };

      const onPointerMove = (event) => {
        if (event.pointerType === "touch") return;
        pendingPointer = {
          x: Math.min(1, Math.max(0, event.clientX / window.innerWidth)),
          y: 1 - Math.min(1, Math.max(0, event.clientY / window.innerHeight)),
        };
      };

      const onPointerLeave = () => {
        pendingPointer = null;
        targetMouseActive = 0;
      };

      const onVisibilityChange = () => {
        pageVisible = !document.hidden;
        start();
      };

      const onMotionChange = () => start();
      const onMobileChange = () => resize();

      const resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(container);

      const intersectionObserver = new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        start();
      });
      intersectionObserver.observe(container);

      const themeObserver = new MutationObserver(() => {
        applyTheme();
        render(performance.now());
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "data-theme"],
      });

      window.addEventListener("pointermove", onPointerMove, { passive: true });
      window.addEventListener("pointerleave", onPointerLeave);
      window.addEventListener("blur", onPointerLeave);
      document.addEventListener("visibilitychange", onVisibilityChange);
      mobileQuery.addEventListener?.("change", onMobileChange);
      reducedMotionQuery.addEventListener?.("change", onMotionChange);

      applyTheme();
      resize();
      start();
      container.dataset.renderer = "webgl";

      destroyRenderer = () => {
        stop();
        resizeObserver.disconnect();
        intersectionObserver.disconnect();
        themeObserver.disconnect();
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerleave", onPointerLeave);
        window.removeEventListener("blur", onPointerLeave);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        mobileQuery.removeEventListener?.("change", onMobileChange);
        reducedMotionQuery.removeEventListener?.("change", onMotionChange);
        canvas.remove();
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      };
    };

    setup().catch(() => {
      if (!disposed) container.dataset.renderer = "fallback";
    });

    return () => {
      disposed = true;
      destroyRenderer?.();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="brand-background"
      aria-hidden="true"
    />
  );
}
