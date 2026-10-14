// Records the match page served by tests/web/motion_replay.py while switching the probe's
// cameras on a plan and measuring the same frames (tests/web/motion-probe.mjs): the
// evidence for issue #58. A tool for looking, not a test; node --test does not collect it.
//
//   uv run python tests/web/motion_replay.py --port 8796 --live --ref <commit>
//   <chrome> --headless=new --remote-debugging-port=9222 --window-size=1600,900 \
//       --user-data-dir=<a new folder> --use-angle=metal --enable-gpu --ignore-gpu-blocklist
//   node tests/web/motion-record.mjs <out folder> [plan.json] [--cdp 9222] [--url http://127.0.0.1:8796/?hud=0]
//
// It writes each screencast frame with its time (frames.ffconcat), what the probe measured
// over the whole run (measure.json: foot sliding by clip and player, lockstep, the frame
// rate), and what the followed player's figure showed every 0.2 s (followed.json, for
// picking stills), then prints the ffmpeg command that makes a 30 fps video of it.
//
// A plan is a list of shots, each { view: 'game' | 'follow' | 'overview' | 'station',
// id: player id or 'play', side: 'fixed' | 'side' | 'front' | 'behind', distance, seconds }.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args.splice(at, 2)[1] : fallback;
};
const port = option('--cdp', '9222');
const url = option('--url', 'http://127.0.0.1:8796/?hud=0');
const [out, planFile] = args;
if (!out) {
  console.error('usage: node tests/web/motion-record.mjs <out folder> [plan.json] [--cdp 9222] [--url URL]');
  process.exit(2);
}

// Three minutes of a match: the broadcast shot, and close-ups on the player nearest the
// ball (dribbling, turning, cutting, stopping) and on players keeping their shape facing
// the ball (sideways, diagonal and backwards steps, a goalkeeper's shuffle).
const PLAN = [
  { view: 'game', seconds: 30 },
  { view: 'follow', id: 'play', side: 'side', distance: 6, seconds: 20 },
  { view: 'game', seconds: 20 },
  { view: 'follow', id: 4, side: 'fixed', distance: 8, seconds: 15 },
  { view: 'game', seconds: 20 },
  { view: 'follow', id: 'play', side: 'front', distance: 7, seconds: 20 },
  { view: 'follow', id: 1, side: 'fixed', distance: 9, seconds: 10 },
  { view: 'game', seconds: 15 },
  { view: 'follow', id: 'play', side: 'fixed', distance: 8, seconds: 20 },
  { view: 'follow', id: 15, side: 'side', distance: 7, seconds: 10 },
];
const plan = planFile ? JSON.parse(readFileSync(planFile, 'utf8')) : PLAN;
mkdirSync(out, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(t => t.type === 'page');
if (!page) throw new Error(`no page to drive on port ${port}`);
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const waiting = new Map();
const frames = [];
socket.onmessage = (message) => {
  const data = JSON.parse(message.data);
  if (data.id && waiting.has(data.id)) {
    waiting.get(data.id)(data);
    waiting.delete(data.id);
  }
  if (data.method === 'Page.screencastFrame') {
    const file = `f${String(frames.length).padStart(5, '0')}.jpg`;
    writeFileSync(`${out}/${file}`, Buffer.from(data.params.data, 'base64'));
    frames.push([file, data.params.metadata.timestamp]);
    send('Page.screencastFrameAck', { sessionId: data.params.sessionId });
  }
};
function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++sequence;
    waiting.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
}
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// A fresh match from its kick-off, with the probe loaded.
await send('Page.enable');
await send('Page.navigate', { url });
for (let tries = 0; !(await evaluate('Boolean(window.__motion && window.__pitch?.actors)')); tries++) {
  if (tries > 100) throw new Error('the page has no probe: is it served by tests/web/motion_replay.py?');
  await sleep(200);
}
await sleep(2000);

const seconds = plan.reduce((sum, shot) => sum + shot.seconds, 0);
const measuring = send('Runtime.evaluate', {
  expression: `__motion.measure(${seconds}).then(result => JSON.stringify(result))`, awaitPromise: true, returnByValue: true,
});
await send('Page.startScreencast', { format: 'jpeg', quality: 82, everyNthFrame: 1 });
const followed = [];
for (const [index, shot] of plan.entries()) {
  const { view, ...options } = shot;
  await evaluate(`__motion.view(${JSON.stringify(view)}, ${JSON.stringify(options)})`);
  const until = Date.now() + shot.seconds * 1000;
  while (Date.now() < until) {
    const now = await evaluate('JSON.stringify(__motion.followed())');
    followed.push({ t: Date.now() / 1000, shot: index, view, followed: now ? JSON.parse(now) : null });
    await sleep(200);
  }
}
await send('Page.stopScreencast');
const measured = await measuring;
writeFileSync(`${out}/measure.json`, measured.result?.result?.value ?? JSON.stringify({ error: measured.error ?? measured.result }));
writeFileSync(`${out}/followed.json`, JSON.stringify(followed));
writeFileSync(`${out}/times.json`, JSON.stringify(frames));
let list = 'ffconcat version 1.0\n';
for (let i = 0; i < frames.length; i++) {
  const next = frames[i + 1]?.[1] ?? frames[i][1] + 1 / 60;
  list += `file ${frames[i][0]}\nduration ${(next - frames[i][1]).toFixed(5)}\n`;
}
writeFileSync(`${out}/frames.ffconcat`, list);
console.log(`${frames.length} frames over ${(frames.at(-1)[1] - frames[0][1]).toFixed(1)} s in ${out}`);
console.log(`ffmpeg -f concat -safe 0 -i ${out}/frames.ffconcat -vf "fps=30,crop=iw:ih-mod(ih\\,2):0:0,scale=1280:-2" `
  + '-c:v libx264 -pix_fmt yuv420p -crf 32 -preset slow -movflags +faststart match.mp4');
socket.close();
process.exit(0);
