// CLI output is retained server-side. Catch up on SSE open/reconnect and
// periodically while the modal is attached: a proxy can buffer a healthy-looking
// stream indefinitely. Sequence numbers keep replay and live output exactly once.
import { fetchJson } from '../../api.js';

export function subscribeCliOutput({ id, onOutput, onEnded, onDropped }) {
  let closed = false;
  let ended = false;
  let seq = 0;
  let timer = null;
  let inFlight = null;
  let refreshAgain = false;
  let replaying = true;
  const pending = [];
  const source = new EventSource('/events');

  function deliver(chunk) {
    if (closed || !chunk) return;
    if (typeof chunk.seq === 'number') {
      if (chunk.seq <= seq) return;
      seq = chunk.seq;
    }
    if (chunk.stream === 'exit') ended = true;
    onOutput(chunk.data, chunk.stream);
  }

  function refresh() {
    if (closed || ended) return Promise.resolve();
    if (inFlight) { refreshAgain = true; return inFlight; }
    clearTimeout(timer);
    replaying = true;
    inFlight = (async () => {
      try {
        const r = await fetchJson('/api/tools/cli/output?id=' + encodeURIComponent(id) + '&since=' + seq);
        if (closed) return;
        if (r.status === 200 && r.body) {
          if (r.body.dropped && onDropped) onDropped();
          for (const chunk of r.body.chunks || []) deliver(chunk);
          if (r.body.running === false) ended = true;
        } else if (r.status === 404) {
          ended = true;
        }
      } catch { /* keep live frames; the next catch-up retries */ }
      finally {
        replaying = false;
        if (!closed) {
          pending.sort((a, b) => (a.seq || 0) - (b.seq || 0));
          for (const chunk of pending.splice(0)) deliver(chunk);
          if (ended && onEnded) onEnded();
        }
        inFlight = null;
      }
    })().then(() => {
      if (closed || ended) return;
      if (refreshAgain) {
        refreshAgain = false;
        return refresh();
      }
      timer = setTimeout(refresh, 1500);
    });
    return inFlight;
  }

  source.addEventListener('cli_output', (event) => {
    let chunk;
    try { chunk = JSON.parse(event.data); } catch { return; }
    if (closed || !chunk || chunk.id !== id) return;
    if (replaying) pending.push(chunk);
    else deliver(chunk);
  });
  source.addEventListener('open', refresh);
  source.addEventListener('error', refresh);

  return {
    ready: refresh(),
    refresh,
    close() {
      closed = true;
      clearTimeout(timer);
      pending.length = 0;
      source.close();
    }
  };
}
