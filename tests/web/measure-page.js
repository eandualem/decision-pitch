// Frame time and draw calls of the running page, GPU included. Paste into the browser's
// console on the match page (or run it through a browser tool); it resolves after
// `seconds` with the frame times (median, p95, p99, worst), the frame rate, and the draw
// calls per frame (fewest, median, most: the camera culls what is out of view). Frames
// the browser skips while the window is hidden show as `paused`, not as slow frames.
(async (seconds = 10) => {
  const gl = document.querySelector('#game canvas').getContext('webgl2');
  let calls = 0;
  const originals = {};
  for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements']) {
    originals[name] = gl[name];
    gl[name] = function (...args) { calls++; return originals[name].apply(this, args); };
  }
  const times = [];
  const draws = [];
  await new Promise((resolve) => {
    const start = performance.now();
    (function frame(now) {
      times.push(now);
      draws.push(calls);
      calls = 0;
      if (now - start < seconds * 1000) requestAnimationFrame(frame);
      else resolve();
    })(start);
  });
  Object.assign(gl, originals);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const shown = gaps.filter(g => g < 250).sort((a, b) => a - b);
  const counted = draws.slice(2).sort((a, b) => a - b);
  const at = (list, q) => list[Math.min(list.length - 1, Math.floor(list.length * q))];
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    fps: +(shown.length / (shown.reduce((a, b) => a + b, 0) / 1000)).toFixed(1),
    frameMs: { median: at(shown, 0.5), p95: at(shown, 0.95), p99: at(shown, 0.99), worst: shown.at(-1) },
    paused: gaps.filter(g => g >= 250).length,
    drawCalls: { fewest: counted[0], median: at(counted, 0.5), most: counted.at(-1) },
    window: [innerWidth, innerHeight, devicePixelRatio],
    gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
  };
})();
