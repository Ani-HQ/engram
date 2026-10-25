// The published snapshot and stream carry the same filtered public payload.
// Keep reconnection/pause behavior separate from the profile's DOM.
export function watchPublicActivity(url, { snapshot, state, closed, interrupted }, options = {}) {
  const Source = options.EventSourceClass || globalThis.EventSource;
  const fetcher = options.fetcher || globalThis.fetch;
  const retryMs = options.retryMs || 5000;
  let source, retry, stopped = false, paused = false, generation = 0, checking = 0;
  const clearRetry = () => { clearTimeout(retry); retry = null; };
  function finish(reason) {
    stopped = true; ++generation; clearRetry(); source?.close(); source = null;
    state("closed"); closed(reason);
  }
  async function verify(version) {
    if (checking === version || stopped || paused) return;
    checking = version;
    try {
      const response = await fetcher(url.replace(/\/stream$/, ""), { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (version !== generation || stopped || paused) return;
      if (response.status === 404 || response.status === 410) { finish("unpublished"); return; }
      if (response.ok) {
        const data = await response.json();
        if (version !== generation || stopped || paused) return;
        // Publication checks also carry the current public scope. Apply a
        // reduced snapshot immediately while the stream is reconnecting.
        // A successful GET does not mean that SSE itself is connected.
        if (data?.profile && data?.stats && data?.live) snapshot(data);
      }
    } catch { /* A network outage does not imply that publication was revoked. */ }
    finally { if (checking === version) checking = 0; }
    if (version === generation && !stopped && !paused && (!source || source.readyState === 2)) {
      clearRetry(); retry = setTimeout(connect, retryMs);
    }
  }
  function connect() {
    if (stopped || paused) return;
    clearRetry(); source?.close();
    const version = ++generation;
    state("connecting");
    if (!Source) { state("unsupported"); return; }
    source = new Source(url, { withCredentials: false });
    source.addEventListener("open", () => { if (version === generation && !stopped && !paused) state("live"); });
    source.addEventListener("snapshot", event => {
      if (version !== generation || stopped || paused) return;
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (!data?.profile || !data?.stats || !data?.live) return;
      state("live"); snapshot(data);
    });
    source.addEventListener("closed", event => {
      if (version !== generation) return;
      let reason = "unpublished";
      try { if (JSON.parse(event.data).reason === "unavailable") reason = "unavailable"; } catch {}
      if (reason === "unavailable") {
        ++generation; clearRetry(); source?.close(); source = null;
        state("reconnecting"); interrupted?.(); void verify(generation);
        return;
      }
      finish(reason);
    });
    source.addEventListener("error", () => {
      if (version !== generation || stopped || paused) return;
      state("reconnecting"); void verify(version);
    });
  }
  connect();
  return {
    pause() { if (stopped || paused) return; paused = true; ++generation; clearRetry(); source?.close(); source = null; state("paused"); },
    resume() { if (stopped || !paused) return; paused = false; connect(); },
    stop() { stopped = true; ++generation; clearRetry(); source?.close(); source = null; },
  };
}
