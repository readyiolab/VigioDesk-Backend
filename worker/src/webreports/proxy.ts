import http from 'node:http';
import net from 'node:net';
import { authorizeProxyTarget, type DnsResolver, UrlSafetyError } from '../../../shared/webreports/urlSafety';

/**
 * Chromium is pointed at this proxy so it cannot resolve hostnames itself.
 * Every CONNECT and forward is checked, then the socket is opened to the
 * validated address. Request interception in the browser is only a backup.
 */
export async function startSsrfProxy(resolve: DnsResolver): Promise<{ port: number; close: () => Promise<void> }> {
const sockets = new Set<{ destroy(): void }>();
  const server = http.createServer((req, res) => {
    const target = req.url || '';
    authorizeProxyTarget(target, resolve)
      .then((decision) => {
        const proxyReq = http.request(
          {
            host: decision.address,
            port: decision.port || 80,
            method: req.method,
            path: new URL(target).pathname + new URL(target).search,
            headers: { ...req.headers, host: decision.hostname },
          },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
            proxyRes.pipe(res);
          }
        );
        proxyReq.on('error', () => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        req.pipe(proxyReq);
      })
      .catch(() => {
        res.writeHead(403);
        res.end('blocked');
      });
  });

  server.on('clientError', (_err, socket) => {
    socket.destroy();
  });

  server.on('error', () => {
    // Suppress unhandled server listen errors
  });

  server.on('connect', (req, clientSocket, head) => {
    sockets.add(clientSocket);
    clientSocket.on('error', () => {
      sockets.delete(clientSocket);
      clientSocket.destroy();
    });

    authorizeProxyTarget(req.url || '', resolve)
      .then((decision) => {
        const upstream = net.connect(decision.port, decision.address, () => {
          sockets.add(upstream);
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head?.length) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        upstream.on('error', () => {
          sockets.delete(upstream);
          clientSocket.destroy();
        });
        upstream.on('close', () => sockets.delete(upstream));
      })
      .catch((err: unknown) => {
        const message = err instanceof UrlSafetyError ? 'blocked' : 'blocked';
        try {
          clientSocket.write(`HTTP/1.1 403 ${message}\r\n\r\n`);
        } catch {
          // Socket might already be closed
        }
        clientSocket.destroy();
      });
    clientSocket.on('close', () => sockets.delete(clientSocket));
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    close: () =>
      new Promise((resolveClose) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolveClose());
      }),
  };
}
