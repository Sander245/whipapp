const http = require('http');
const { WebSocketServer } = require('ws');

function startRelay(port, onReady, onError) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('whip relay is up');
  });

  const wss = new WebSocketServer({ server });
  const rooms = new Map();

  function leaveRoom(ws) {
    if (!ws.room) return;
    const set = rooms.get(ws.room);
    if (set) {
      set.delete(ws);
      if (set.size === 0) rooms.delete(ws.room);
    }
    ws.room = null;
  }

  wss.on('connection', ws => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', data => {
      if (data.length > 4096) return;
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      if (msg.type === 'join') {
        leaveRoom(ws);
        const room = String(msg.room || '').slice(0, 64);
        if (!room) return;
        ws.room = room;
        if (!rooms.has(room)) rooms.set(room, new Set());
        rooms.get(room).add(ws);
        return;
      }

      if (!ws.room) return;
      const payload = JSON.stringify(msg);
      for (const peer of rooms.get(ws.room)) {
        if (peer !== ws && peer.readyState === 1) peer.send(payload);
      }
    });

    ws.on('close', () => leaveRoom(ws));
    ws.on('error', () => {});
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);

  server.on('close', () => clearInterval(heartbeat));
  server.on('error', err => { if (onError) onError(err); });
  server.listen(port, () => { if (onReady) onReady(server); });
  return server;
}

module.exports = { startRelay };
