// An original ambient "floating in space" soundtrack for the reels (user, 2026-11-25: every
// reel gets music with an atmospheric space vibe, to match the spinning globe). Instagram's
// API can't add songs from its library, and copyrighted songs aren't ours to use, so the
// track is synthesised here: slow detuned pads on a minor-ninth chord, a deep drone, soft
// high sparkles and a long stereo echo. Every frequency, swell and echo repeats exactly
// once per reel, so the sound loops as seamlessly as the video. The seed (the post key)
// picks the key, the chord voicing and the sparkle melody, so reels don't all sound alike.
//
//   node scripts/ambient.mjs mux <video.mp4> [seed]   adds the track to the video in place
//                                                    (mixed under any sound it already has)
//   node scripts/ambient.mjs wav <out.wav> <seconds> [seed]
import { writeFileSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SR = 44_100;

export function ambient(seconds, seedText = 'landmarked') {
  let seed = [...String(seedText)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 11);
  const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) >>> 0) / 2 ** 32);
  const n = Math.round(seconds * SR), T = n / SR;
  const snap = (f) => Math.max(1, Math.round(f * T)) / T; // a whole number of cycles per loop
  const L = new Float32Array(n), R = new Float32Array(n);
  const TAU = Math.PI * 2;

  // Key and chord: a low root between C2 and G2, minor with an added ninth (open, unresolved).
  const root = 65.41 * 2 ** ([0, 2, 3, 5, 7][Math.floor(rand() * 5)] / 12);
  const voicings = [[0, 7, 12, 15, 19, 26], [0, 7, 14, 15, 22, 26], [0, 12, 14, 19, 24, 27]];
  const chord = voicings[Math.floor(rand() * voicings.length)].map((s) => root * 2 ** (s / 12));

  // Pads: each note as three slightly detuned sines per side, swelling slowly.
  for (const [i, f0] of chord.entries()) {
    const amp = 0.16 / (1 + i * 0.35);
    const swell = 1 + Math.floor(rand() * 2), ph = rand() * TAU;
    for (const [side, buf, det] of [[0, L, [-2, 0, 3]], [1, R, [-3, 0, 2]]]) {
      const fs = det.map((d) => snap(f0) + d / T);
      const phs = fs.map(() => rand() * TAU);
      for (let k = 0; k < n; k++) {
        const t = k / SR;
        const env = 0.55 + 0.45 * Math.sin(TAU * swell * t / T + ph + side * 0.9);
        let v = 0;
        for (let j = 0; j < 3; j++) v += Math.sin(TAU * fs[j] * t + phs[j]);
        buf[k] += amp * env * v / 3;
      }
    }
  }
  // Drone: the root itself, barely moving (an octave lower is lost on phone speakers).
  const fd = snap(root);
  for (let k = 0; k < n; k++) { const t = k / SR, v = 0.07 * Math.sin(TAU * fd * t) * (0.8 + 0.2 * Math.sin(TAU * t / T)); L[k] += v; R[k] += v; }

  // Sparkles: a few soft bell notes high up, from the chord's pentatonic scale, wrapping round the loop.
  const scale = [0, 3, 5, 7, 10].map((s) => root * 8 * 2 ** (s / 12));
  const count = 4 + Math.floor(rand() * 3);
  for (let i = 0; i < count; i++) {
    const f = snap(scale[Math.floor(rand() * scale.length)] * (rand() < 0.3 ? 2 : 1));
    const at = Math.floor(((i + rand() * 0.6) / count) * n), pan = 0.25 + rand() * 0.5, amp = 0.05 + rand() * 0.03;
    for (let j = 0; j < SR * 3; j++) {
      const t = j / SR, e = Math.exp(-t / 0.9) * Math.min(1, t / 0.01);
      const v = amp * e * (Math.sin(TAU * f * t) + 0.25 * Math.sin(TAU * f * 2.01 * t));
      const k = (at + j) % n;
      L[k] += v * (1 - pan); R[k] += v * pan;
    }
  }
  // Air: a faint high shimmer (noise band-passed to roughly 2–6 kHz), swelling once per loop.
  const lo = [0, 0], hi = [0, 0];
  for (let k = 0; k < n; k++) {
    const e = 0.5 + 0.5 * Math.sin(TAU * (k / n) - 1);
    for (const [s, buf] of [[0, L], [1, R]]) {
      const x = rand() * 2 - 1;
      hi[s] += 0.25 * (x - hi[s]);            // drops the hiss above ~6 kHz
      lo[s] += 0.045 * (hi[s] - lo[s]);       // the rumble below ~2 kHz, taken out next
      buf[k] += 0.02 * e * (hi[s] - lo[s]);
    }
  }
  // Space: long feedback echoes, different on each side, run round the loop until they settle.
  const echo = (buf, d, g) => {
    const D = Math.round(d * SR), y = Float32Array.from(buf);
    for (let pass = 0; pass < 6; pass++) for (let k = 0; k < n; k++) y[k] = buf[k] + g * y[(k - D + n * 4) % n];
    return y;
  };
  const wetL = echo(echo(L, 0.43, 0.55), 0.071, 0.4), wetR = echo(echo(R, 0.61, 0.55), 0.053, 0.4);
  for (let k = 0; k < n; k++) { L[k] = 0.55 * L[k] + 0.45 * wetL[k] * 0.6; R[k] = 0.55 * R[k] + 0.45 * wetR[k] * 0.6; }

  // Roll off the rumble under ~40 Hz (one-pole high-pass, run round the loop twice).
  for (const buf of [L, R]) {
    const a = 1 / (1 + TAU * 40 / SR);
    let y = 0, x1 = buf[n - 1];
    const out = new Float32Array(n);
    for (let pass = 0; pass < 2; pass++) for (let k = 0; k < n; k++) { y = a * (y + buf[k] - x1); x1 = buf[k]; if (pass) out[k] = y; }
    buf.set(out);
  }
  // Level: peaks at about -4 dBFS.
  let peak = 0;
  for (let k = 0; k < n; k++) peak = Math.max(peak, Math.abs(L[k]), Math.abs(R[k]));
  const gain = 0.63 / (peak || 1);
  const pcm = Buffer.alloc(44 + n * 4);
  pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + n * 4, 4); pcm.write('WAVEfmt ', 8);
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(2, 22); pcm.writeUInt32LE(SR, 24);
  pcm.writeUInt32LE(SR * 4, 28); pcm.writeUInt16LE(4, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(n * 4, 40);
  for (let k = 0; k < n; k++) {
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[k] * gain)) * 32767), 44 + k * 4);
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[k] * gain)) * 32767), 46 + k * 4);
  }
  return pcm;
}

const probe = (file, what) => execFileSync('ffprobe', ['-v', 'error', ...what, '-of', 'default=nw=1:nk=1', file]).toString().trim();

/** Adds the ambient track to a video in place; any sound it already has (ticks, a ding) stays on top. */
export function mux(video, seedText) {
  const seconds = Number(probe(video, ['-show_entries', 'format=duration']));
  const hasAudio = probe(video, ['-select_streams', 'a', '-show_entries', 'stream=index']) !== '';
  const wav = `${video}.ambient.wav`, out = `${video}.tmp.mp4`;
  writeFileSync(wav, ambient(seconds, seedText ?? video));
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', video, '-i', wav,
    ...(hasAudio
      ? ['-filter_complex', '[1:a]volume=0.7[bed];[0:a][bed]amix=inputs=2:duration=first:normalize=0[a]', '-map', '0:v', '-map', '[a]']
      : ['-map', '0:v', '-map', '1:a']),
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out]);
  rmSync(wav);
  renameSync(out, video);
}

const [cmd, a, b, c] = process.argv.slice(2);
if (cmd === 'mux') { mux(a, b); console.log(`${a}: ambient soundtrack added`); }
else if (cmd === 'wav') { writeFileSync(a, ambient(Number(b), c)); console.log(`wrote ${a}`); }
