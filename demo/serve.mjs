// Zero-dependency dev server for the ferrite.js demo.
//
//  - Sets COOP/COEP/CORP so the document is crossOriginIsolated — MANDATORY: ferrite.wasm will not
//    instantiate without SharedArrayBuffer, and the software decode threads need it.
//  - Serves the built ./dist (run `npm run build` first), the vendored ./assets engine, and ./demo.
//  - /proxy?url=<stream> pipes a cross-origin IPTV stream same-origin so COEP can't block the fetch.
//
//   npm run build && npm run demo      # → http://localhost:8650/
import http from 'node:http';
import { readFile, appendFile } from 'node:fs/promises';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 8650;

// recovery fault injection (/faux-live?fault=…): a fault is delivered ONCE per type, then auto-
// re-arms so the player RECOVERS on its reconnect (conn1 faults → conn2 clean → recover), and a later
// fresh play faults again. Keyed by fault type; a server-global toggle (good enough for manual + headless
// recovery tests). Cleared on the clean serve so each play→reconnect cycle is deterministic.
const faultDelivered = new Set();

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.map': 'application/json', '.wasm': 'application/wasm',
  '.json': 'application/json', '.svg': 'image/svg+xml',
  '.ts': 'video/mp2t', '.m2ts': 'video/mp2t', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
};
// VOD media served from assets/ → range-capable (the player's range AVIO issues a 0-0 size probe + on-demand
// Range GETs; the static reply must be 206 + Content-Range + Accept-Ranges, exactly like a real VOD origin).
const MEDIA_EXT = new Set(['.mp4', '.mov', '.mkv', '.m2ts']);

function isolate(res, type) {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Type', type);
}

// Map a URL path to a real file. '/' → the demo page; otherwise only the public dirs are served
// (dist/, assets/, demo/) — never the rest of the repo (src, node_modules, package.json…).
// Path-traversal is rejected (the served file must stay inside the allowed roots).
const SERVE_DIRS = ['dist', 'assets', 'demo'].map((d) => path.join(ROOT, d) + path.sep);
function resolveFile(pathname) {
  const rel = pathname === '/' ? 'demo/index.html' : pathname.replace(/^\/+/, '');
  const abs = path.join(ROOT, rel);
  if (!SERVE_DIRS.some((d) => abs.startsWith(d))) return null;
  if (existsSync(abs) && statSync(abs).isFile()) return abs;
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    // SELF-CONTAINED live test source. Streams a fixture .ts as a PLAIN CHUNKED HTTP response (NO
    // Range, NO Content-Length, NO Accept-Ranges) so the player's LiveSourcePort (fetch + ReadableStream)
    // ingests it exactly like a CDN-paced live stream — push, not pull. `?file=` picks the fixture (only
    // the vendored assets are reachable); `?rateKBps=` paces the push (default ~uncapped = stream as fast
    // as the socket drains, which the demux ring's low-water gate then backpressures). The connection is
    // aborted cleanly when the client disconnects (Stop/teardown), so no orphaned read keeps draining.
    if (url.pathname === '/faux-live') {
      const rel = (url.searchParams.get('file') || 'assets/fixture_lab_2160_10_50.ts').replace(/^\/+/, '');
      const abs = path.join(ROOT, rel);
      if (!abs.startsWith(path.join(ROOT, 'assets') + path.sep) || !existsSync(abs) || !statSync(abs).isFile()) {
        res.statusCode = 404; return res.end('faux-live: fixture not found');
      }
      // Crucially: do NOT set Content-Length / Accept-Ranges → the browser/engine treat it as an
      // open-ended live body. COEP/CORP headers stay (the page is crossOriginIsolated). chunked is implicit.
      isolate(res, 'video/mp2t');

      // RECOVERY FAULT MODES (manual/browser verification of the error controller):
      //   ?fault=drop    → after `faultMs`, abruptly DESTROY the socket (a network drop → the ingest catch
      //                    classifies `network-drop` → reconnect). The reconnect (conn2) serves CLEAN → recover.
      //   ?fault=silence → after `faultMs`, STOP sending bytes but keep the socket OPEN (a wedged upstream →
      //                    the adaptive silence watchdog fires → `upstream-silence` → reconnect). conn2 clean → recover.
      // A fault is delivered ONCE then auto-re-arms (so the reconnect recovers); paced ~1× so `faultMs` ≈
      // real streamed seconds. `faultMs` default 3000.
      const fault = url.searchParams.get('fault');
      const faultMs = +(url.searchParams.get('faultMs') || 3000);
      const faulting = !!fault && !faultDelivered.has(fault);
      if (fault && !faulting) faultDelivered.delete(fault); // this is the recovery connection → re-arm for next play
      // Pace at ~1× by default when faulting (so faultMs maps to real seconds); else honour ?rateKBps.
      const rateKBps = +(url.searchParams.get('rateKBps') || (faulting ? 3500 : 0));
      const stream = createReadStream(abs, { highWaterMark: 64 * 1024 });
      res.on('close', () => stream.destroy()); // client gone (Stop) → stop reading the file
      const startMs = Date.now();
      let faultFired = false;
      const maybeFault = () => {
        if (!faulting || faultFired || Date.now() - startMs < faultMs) return false;
        faultFired = true;
        faultDelivered.add(fault); // mark delivered → the reconnect serves clean
        stream.destroy();
        if (fault === 'drop') { try { res.destroy(); } catch { /* ignore */ } } // abrupt RST → network drop
        // fault === 'silence': leave `res` OPEN, send no more bytes → the client's silence watchdog trips.
        return true;
      };
      if (rateKBps > 0) {
        // Pace the push: write a chunk, then wait so the average rate ≈ rateKBps (a coarse live cadence).
        stream.on('data', (chunk) => {
          if (maybeFault()) return;
          stream.pause();
          if (res.writableEnded) { stream.destroy(); return; }
          res.write(chunk);
          setTimeout(() => stream.resume(), (chunk.length / 1024) / rateKBps * 1000);
        });
        stream.on('end', () => res.end());
        stream.on('error', () => { try { res.end(); } catch { /* ignore */ } });
      } else {
        stream.pipe(res); // socket backpressure + the demux low-water gate pace it
        stream.on('error', () => { try { res.end(); } catch { /* ignore */ } });
      }
      return;
    }

    if (url.pathname === '/proxy') {
      // Robust target extraction: take EVERYTHING after the first `url=` in the RAW query, NOT
      // searchParams.get('url') — which keeps only the first `&`-pair and so TRUNCATES a cross-origin
      // target that carries its own query string (`…/live?token=abc&user=42` → `…/live?token=abc`), the
      // root cause of "can't play live via /proxy". Decode once: the demo percent-encodes the target (no
      // literal `&` survives to confuse the split); a legacy hand-pasted raw URL has no %xx and decodes
      // to itself. Either entry form now reaches the origin intact.
      const q = req.url.indexOf('url=');
      let target = q >= 0 ? req.url.slice(q + 4) : null;
      if (target) { try { target = decodeURIComponent(target); } catch { /* malformed % — use the raw tail */ } }
      if (!target) { res.statusCode = 400; return res.end('missing url'); }
      // Abort the upstream fetch when the client disconnects (reconnect / Stop / tab nav). Without this
      // the upstream keeps draining the origin after the player is gone, so the origin bridge never
      // drops the subscriber — one player then shows as 2+ subscribers.
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      // Forward the client's Range header so VOD/file playback STREAMS (the ferrite range AVIO issues
      // Range GETs on demand + a size-probe Range 0-0); without this the proxy swallowed Range and the
      // player could only whole-file-prefetch. Stays a dumb same-origin CORS/COEP bridge otherwise.
      const fwd = { 'User-Agent': 'ferrite.js-demo' };
      if (req.headers['range']) fwd['Range'] = req.headers['range'];
      const upstream = await fetch(target, { signal: ac.signal, headers: fwd });
      isolate(res, upstream.headers.get('content-type') || 'application/octet-stream');
      // Pass through the byte-range response metadata so the browser/engine see a real 206 (Content-Range
      // carries the total size the size-probe parses; Accept-Ranges advertises seekability).
      for (const h of ['content-range', 'accept-ranges', 'content-length']) {
        const v = upstream.headers.get(h);
        if (v !== null) res.setHeader(h, v);
      }
      res.statusCode = upstream.status; // 206 for a satisfied Range, else 200
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || res.writableEnded) break;
          res.write(value);
        }
      } catch (e) {
        if (!ac.signal.aborted) throw e; // client-gone abort is expected; anything else propagates
      } finally {
        reader.cancel().catch(() => {});
      }
      return res.end();
    }

    // Stats sink — the demo POSTs one folded getStats() record ~1×/sec while playing (?debug != 0);
    // appended to buildlog.jsonl so the smoothness/leak signal is readable server-side. Gitignored.
    if (url.pathname === '/buildlog' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      await appendFile(path.join(ROOT, 'buildlog.jsonl'), JSON.stringify({ rx: new Date().toISOString(), ...JSON.parse(body || '{}') }) + '\n');
      res.statusCode = 204; return res.end();
    }

    const file = resolveFile(url.pathname);
    if (!file) { res.statusCode = 404; return res.end('not found'); }
    const ext = path.extname(file);
    isolate(res, MIME[ext] || 'application/octet-stream');
    // Dev-loop cache discipline: dist/ + demo/ change every build, so NEVER let the browser cache them
    // (a stale dist/worker.js silently runs old code → fake "fix didn't work" results). The engine
    // (assets/, ferrite.{mjs,wasm}) stays cacheable (compile-warm perf — do NOT no-store it).
    if (file.includes(`${path.sep}dist${path.sep}`) || file.includes(`${path.sep}demo${path.sep}`)) {
      res.setHeader('Cache-Control', 'no-store');
    }
    // VOD media → honour HTTP Range (a 206 byte-slice) so the player's range AVIO can size-probe + seek;
    // advertise Accept-Ranges on the full reply too. Streamed (not whole-file-read) so a 100 MB MKV doesn't
    // buffer into memory per request.
    if (MEDIA_EXT.has(ext)) {
      const size = statSync(file).size;
      res.setHeader('Accept-Ranges', 'bytes');
      const range = req.headers['range'];
      const mm = range && /^bytes=(\d*)-(\d*)$/.exec(range);
      if (mm) {
        let start = mm[1] === '' ? NaN : parseInt(mm[1], 10);
        let end = mm[2] === '' ? size - 1 : parseInt(mm[2], 10);
        if (Number.isNaN(start)) { start = size - end; end = size - 1; } // suffix range (bytes=-N)
        if (start > end || start < 0 || end >= size) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${size}`); return res.end(); }
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Content-Length', end - start + 1);
        const s = createReadStream(file, { start, end });
        res.on('close', () => s.destroy());
        return s.pipe(res);
      }
      res.setHeader('Content-Length', size);
      const s = createReadStream(file);
      res.on('close', () => s.destroy());
      return s.pipe(res);
    }
    res.end(await readFile(file));
  } catch (err) {
    res.statusCode = 500;
    res.end('error: ' + err);
  }
});

server.listen(PORT, () => {
  if (!existsSync(path.join(ROOT, 'dist', 'index.js'))) {
    console.warn('⚠  dist/ not found — run `npm run build` first.');
  }
  console.log(`ferrite.js demo: http://localhost:${PORT}/`);
});
