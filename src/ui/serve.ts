/**
 * The local server behind `stellar-memory ui`.
 *
 * This publishes a map of somebody's private source tree, so two rules outrank
 * everything else in this file:
 *
 *   1. It listens on 127.0.0.1 and nowhere else. `HOST` is the only place an
 *      address is written, and no caller can supply one — `UiServerOptions` has
 *      no host field. `listen(port)` with no host would bind `0.0.0.0`, which on
 *      conference Wi-Fi means handing the graph to the room.
 *   2. It serves strings held in memory. Both routes are literals; nothing taken
 *      from a request ever reaches a filesystem call, so there is no path to
 *      traverse out of and no ignore-list for anyone to get wrong later.
 *
 * What it deliberately does not have is an access token. Loopback plus three
 * header checks already close the browser-side attacks: a page on another origin
 * cannot forge `Host`, cannot read a cross-origin response without the CORS
 * headers this file never sends, and cannot fake `Sec-Fetch-Site`. A token would
 * only add defence against another *user account* on this machine — who can read
 * `.stellar-memory/` off the disk anyway — and it would cost a URL nobody can
 * read off a projector or type by hand, which is the whole job here.
 *
 * Live reload is server-sent events: one direction, plain HTTP, no dependency,
 * and the browser reconnects by itself. The price is a response that never ends,
 * which is a referenced socket — so `close()` has to end those by hand or Ctrl+C
 * looks like it did nothing.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PAGE_CSP } from '../store/html.js';

/** Loopback, written once. `rg 'listen\(' src/ui` should find one call. */
const HOST = '127.0.0.1';

export interface RenderedPage {
  html: string;
  /**
   * Changes exactly when the drawing changes. The page carries the stamp it was
   * built from and reloads on any other, so this is also what decides whether a
   * reload is pushed at all.
   */
  stamp: string;
}

export interface UiServerOptions {
  /** A fixed port, or undefined for an ephemeral one. */
  port?: number;
  /** Produces the page. Called once now, and again on every `refresh()`. */
  render: () => Promise<RenderedPage>;
}

/**
 * `scan-failed` exists because without it a rescan that threw sends exactly the
 * frames a rescan that worked sends, and the window returns to its faded steady
 * state over a graph that is now older than the code.
 */
export type StreamEvent = 'scanning' | 'scanned' | 'scan-failed';

export interface UiServer {
  /** The address to open. */
  readonly url: string;
  readonly port: number;
  /** Windows currently holding the event stream open. */
  readonly clients: number;
  /**
   * Whether anything has ever asked for the page. Launching a browser only
   * proves the command returned; a request arriving is what proves a window
   * opened, so the caller has something true to say either way.
   */
  readonly served: boolean;
  /** Re-render, and push a reload only if the drawing actually changed. */
  refresh(): Promise<boolean>;
  /** Tell open windows what is happening, without changing the page. */
  announce(event: StreamEvent): void;
  close(): Promise<void>;
}

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  let page = await options.render();
  let boundPort = 0;
  let served = false;

  const streams = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    // A relative URL needs a base to parse against; this one is thrown away.
    const url = new URL(req.url ?? '/', `http://${HOST}`);

    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(res, 405, 'Method not allowed');

    /*
     * DNS rebinding: a page on evil.com whose name resolves to 127.0.0.1 can
     * reach this socket, and the browser treats the response as same-origin
     * with evil.com. What it cannot do is forge the Host header — it still says
     * evil.com. That is the whole check.
     */
    if (!hostIsLoopback(req.headers.host, boundPort)) return deny(res, 403, 'Unexpected Host header');

    // Same-origin navigations send no Origin at all, so absent has to pass;
    // anything present and foreign — including the literal "null" — does not.
    if (!originIsSelf(req.headers.origin, boundPort)) return deny(res, 403, 'Cross-origin request');

    /*
     * Fetch metadata catches what Origin does not: a `<script src>`, `<img>` or
     * link from another site sends no Origin but does say where it came from,
     * and the browser sets this header itself so a page cannot lie about it.
     * Absent means a client that does not send it — curl, an older browser — so
     * absent falls through to the checks above rather than being refused.
     */
    if (!initiatorIsSelf(header(req, 'sec-fetch-site'))) return deny(res, 403, 'Request came from another site');

    // An exact list of literals.
    if (url.pathname === '/') return sendPage(req, res);
    if (url.pathname === '/events') return openStream(res);
    return deny(res, 404, 'Not found');
  });

  function sendPage(req: http.IncomingMessage, res: http.ServerResponse): void {
    served = true;
    const body = Buffer.from(page.html, 'utf8');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': body.byteLength,
      // The whole point is that a reload shows the current scan.
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      // The same policy the page carries in a <meta>, sent as a header because
      // a header cannot be lost to whatever edits the file later.
      'content-security-policy': PAGE_CSP,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(body);
  }

  function openStream(res: http.ServerResponse): void {
    served = true;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    });
    // Without this the reload waits on Nagle, and 40ms of nothing is visible
    // when someone is demonstrating this on a projector.
    res.socket?.setNoDelay(true);

    // `retry` sets how fast the browser comes back after a drop. `hello` lets a
    // window that reconnected to a restarted server notice it is stale.
    res.write('retry: 500\n\n');
    res.write(`event: hello\ndata: ${page.stamp}\n\n`);

    streams.add(res);
    res.on('close', () => streams.delete(res));
  }

  function broadcast(event: string, data: string): void {
    for (const res of streams) {
      // A window that vanished mid-write must not throw into whatever called us.
      try {
        res.write(`event: ${event}\ndata: ${data}\n\n`);
      } catch {
        streams.delete(res);
      }
    }
  }

  // A comment line, which the EventSource spec tells the browser to ignore. It
  // keeps the socket warm and surfaces a peer that died without a FIN.
  const heartbeat = setInterval(() => {
    for (const res of streams) {
      try {
        res.write(': ping\n\n');
      } catch {
        streams.delete(res);
      }
    }
  }, 25_000);
  // An open window must never be the reason this process refuses to exit.
  heartbeat.unref();

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      reject(describeListenError(error, options.port));
    };
    const onListening = () => {
      server.removeListener('error', onError);
      // Set here rather than after the await: the Host check compares against
      // it, and a request accepted on this same tick would otherwise be
      // measured against port 0 and refused.
      boundPort = (server.address() as AddressInfo).port;
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    // The security boundary. Port 0 means any free one, so two projects can each
    // have a window open without agreeing a number in advance.
    server.listen({ host: HOST, port: options.port ?? 0 });
  });

  return {
    // The literal, never `localhost`: on a machine where localhost resolves to
    // ::1 first, that name would reach a socket this never bound.
    url: `http://${HOST}:${boundPort}/`,
    port: boundPort,
    get clients() {
      return streams.size;
    },
    get served() {
      return served;
    },

    async refresh(): Promise<boolean> {
      const next = await options.render();
      // The stamp is derived from the drawing, so a scan that found nothing new
      // costs nothing here and no window blinks.
      if (next.stamp === page.stamp) return false;
      page = next;
      broadcast('reload', next.stamp);
      return true;
    },

    announce(event: StreamEvent): void {
      broadcast(event, String(Date.now()));
    },

    async close(): Promise<void> {
      clearInterval(heartbeat);

      for (const res of streams) {
        // Say goodbye before the socket disappears. An EventSource that sees a
        // bare disconnect retries every 500ms for as long as the window stays
        // open — against a port that may by then belong to something else.
        try {
          res.write('event: bye\ndata: 0\n\n');
          res.end();
        } catch {
          // Already gone.
        }
      }
      streams.clear();

      await new Promise<void>((resolve) => {
        /*
         * `close()` stops new connections and waits for live ones. The streams
         * above are ending, but a browser holds several idle keep-alive sockets
         * and one may be mid-request. A stranded socket here is exactly what
         * makes Ctrl+C look like it did nothing, so give the graceful path a
         * moment and then take the rest down. Sweeping immediately instead
         * would destroy the socket before the `bye` had flushed.
         */
        const sweep = setTimeout(() => server.closeAllConnections(), 250);
        sweep.unref();
        server.close(() => {
          clearTimeout(sweep);
          resolve();
        });
      });
    },
  };
}

/**
 * Run `handler` on Ctrl+C, then let the loop drain on its own — `process.exit()`
 * can truncate buffered output. The watchdog only ever fires if something is
 * still holding the loop open, since an unref'd timer cannot hold it itself. A
 * second Ctrl+C is an escape hatch, not the normal path.
 */
export function onShutdown(handler: () => Promise<void>): void {
  let closing = false;

  const stop = () => {
    if (closing) process.exit(130);
    closing = true;
    handler()
      .catch(() => {
        process.exitCode = 1;
      })
      .finally(() => {
        const watchdog = setTimeout(() => process.exit(process.exitCode ?? 0), 1_000);
        watchdog.unref();
      });
  };

  // SIGBREAK exists only on Windows; listening for it elsewhere is harmless.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(signal, stop);
}

/** Header values are typed as possibly repeated; take the first and move on. */
function header(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * A client omits the port when it is the scheme's default (RFC 9110), so on
 * `--port 80` a browser sends a bare `127.0.0.1` and the address this command
 * printed would be the one address it refuses. The rebinding guard is untouched:
 * the name still has to be one of ours, and `evil.com` is not.
 */
function authorities(port: number): string[] {
  const bare = port === 80 ? [HOST, 'localhost'] : [];
  return [`${HOST}:${port}`, `localhost:${port}`, ...bare];
}

function hostIsLoopback(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  return authorities(port).includes(host);
}

function originIsSelf(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  return authorities(port).some((authority) => origin === `http://${authority}`);
}

function initiatorIsSelf(site: string | undefined): boolean {
  if (site === undefined) return true;
  return site === 'same-origin' || site === 'none';
}

function deny(res: http.ServerResponse, status: number, message: string): void {
  // No Access-Control-Allow-Origin here or anywhere else in this file: a
  // cross-origin page must not be able to read a single byte of this.
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(`${message}\n`);
}

function describeListenError(error: NodeJS.ErrnoException, wanted: number | undefined): Error {
  // A port that was asked for and is taken is not silently swapped for another.
  // Reporting a port nobody asked for is the kind of quiet misstatement this
  // tool does not make.
  if (error.code === 'EADDRINUSE') {
    return new Error(
      `Port ${wanted} is already in use. Drop --port and one will be chosen for you, ` +
        `which also lets several projects have a window open at once.`,
    );
  }
  if (error.code === 'EACCES') {
    return new Error(
      `Not allowed to listen on port ${wanted}. Ports below 1024 need privileges; pick a higher one.`,
    );
  }
  return error;
}
