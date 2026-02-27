import { existsSync, unlinkSync } from "fs";

// Controller -> Browser messages
export type ControllerMessage =
  | { type: "close" }
  | { type: "ping" }
  | { type: "refresh" }
  | { type: "setCwd"; cwd: string };

// Browser -> Controller messages
export type BrowserMessage =
  | { type: "ready" }
  | { type: "pong" }
  | { type: "fileSelected"; path: string };

export function getSocketPath(id: string): string {
  return `/tmp/file-browser-${id}.sock`;
}

export interface IPCServer {
  broadcast: (msg: BrowserMessage) => void;
  close: () => void;
}

export async function createIPCServer(options: {
  socketPath: string;
  onMessage: (msg: ControllerMessage) => void;
  onClientConnect?: () => void;
  onClientDisconnect?: () => void;
}): Promise<IPCServer> {
  const { socketPath, onMessage, onClientConnect, onClientDisconnect } = options;

  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }

  const clients = new Set<any>();

  const server = Bun.listen({
    unix: socketPath,
    socket: {
      open(socket) {
        clients.add(socket);
        onClientConnect?.();
      },
      data(_socket, data) {
        const lines = data.toString().split("\n");
        for (const line of lines) {
          if (line.trim()) {
            try {
              onMessage(JSON.parse(line) as ControllerMessage);
            } catch {}
          }
        }
      },
      close(socket) {
        clients.delete(socket);
        onClientDisconnect?.();
      },
      error() {},
    },
  });

  return {
    broadcast(msg: BrowserMessage) {
      const data = JSON.stringify(msg) + "\n";
      for (const client of clients) {
        client.write(data);
      }
    },
    close() {
      server.stop();
      if (existsSync(socketPath)) {
        try { unlinkSync(socketPath); } catch {}
      }
    },
  };
}

export async function sendCommand(socketPath: string, msg: ControllerMessage): Promise<BrowserMessage | null> {
  return new Promise((resolve) => {
    let buffer = "";
    const timeout = setTimeout(() => resolve(null), 3000);

    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(JSON.stringify(msg) + "\n");
        },
        data(_socket, data) {
          buffer += data.toString();
          const lines = buffer.split("\n");
          for (const line of lines) {
            if (line.trim()) {
              try {
                clearTimeout(timeout);
                resolve(JSON.parse(line) as BrowserMessage);
                return;
              } catch {}
            }
          }
        },
        close() {
          clearTimeout(timeout);
          resolve(null);
        },
        error() {
          clearTimeout(timeout);
          resolve(null);
        },
      },
    }).catch(() => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}
