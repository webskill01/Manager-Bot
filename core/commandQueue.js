// Slow commands run one at a time. Quick ones never wait behind them.
//
// The problem this fixes: the Telegram poll loop used to `await handleUpdate(u)` before
// asking Telegram for the next update. `approve` paces 12 group adds at 8-12s apart, so for
// two solid minutes the transport fetched nothing at all — `find`, `status`, `digest`, even
// `drip stop` were not merely queued, they were never collected from Telegram. From the
// operator's side the bot had simply stopped answering, and the only cure was waiting.
//
// Unblocking that loop creates the opposite hazard, which is why this file exists rather
// than just deleting an `await`. Two `approve`s running concurrently would issue group
// operations at twice the rate `rateLimits.groupOpGapMinMs` is there to hold, and half the
// point of that pacing is that it is the whole account's rate, not one command's. Same for
// two sheet writers racing on the same row.
//
// So: one chain, strictly sequential, for anything isSlowCommand() names — exactly the set
// that does sheet writes, group operations, or member DMs. Everything else is a read and
// runs the moment it arrives, which is the half the operator actually noticed was broken.
//
// ponytail: one chain, not a worker pool with a concurrency limit. Concurrency is the thing
// that must not happen here; the queue exists only so the fast path can skip it.
export function createCommandQueue(log) {
  let chain = Promise.resolve();
  let running = null;
  const waiting = [];
  // Everything still in flight, serialized or not. The quick commands are not queued — that
  // is the point of them — but "nothing is running" has to include them, or a shutdown cuts
  // a reply in half mid-chunk and a test asserts on output that has not been sent yet.
  const inFlight = new Set();

  // Register a promise as in-flight for idle()'s purposes, and hand it straight back.
  function track(p) {
    inFlight.add(p);
    // .finally() returns a NEW promise that inherits p's rejection, and nothing handles that
    // one — which is an unhandled rejection, i.e. a crashed bot, every time a command throws.
    // Swallow it here; the original p is what the caller gets and what carries the outcome.
    p.finally(() => inFlight.delete(p)).catch(() => {});
    return p;
  }

  // Returns a promise that settles when THIS command finishes — callers may await it or
  // let it run, but the transport must not await it on the receive path.
  function enqueue(label, fn) {
    waiting.push(label);
    const done = chain.then(async () => {
      waiting.shift();
      running = label;
      try {
        return await fn();
      } finally {
        running = null;
      }
    });
    // The chain must never inherit a rejection. One command throwing would otherwise leave
    // every command queued behind it — for the rest of the process's life — unrun and
    // unexplained, which is a far worse failure than the one that started it.
    //
    // The SETTLED promise is what goes back to the caller too, not `done`. No call site cares
    // why a command failed — the log line above is the record — and handing out a rejecting
    // promise that nobody awaits is an unhandled rejection dressed up as an API.
    const settled = done.catch((err) => {
      log?.error?.(`❌ Queued command "${label}" failed: ${err.message}`);
    });
    chain = settled;
    return track(settled);
  }

  // What the operator is waiting for, so a receipt can say "queued behind approve 98…"
  // rather than "working on…" when it is doing no such thing yet.
  function status() {
    return { running, waiting: [...waiting] };
  }

  // Resolves when nothing is queued or running, quick commands included. The receive path
  // must never await this — that would restore the very block this file removes — but a
  // graceful shutdown should, and the tests must, because handleUpdate no longer waits for
  // the work it started.
  //
  // Loops because settling one batch can start the next: a queued command only begins when
  // the one in front of it ends, so a single allSettled would return with work still to do.
  async function idle() {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  }

  return { enqueue, track, status, idle };
}
