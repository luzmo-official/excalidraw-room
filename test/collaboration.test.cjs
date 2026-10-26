const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const net = require("node:net");
const { after, before, test } = require("node:test");
// Optional module path allows verifying the frontend's pinned client separately
// without retaining an older client in this server's dependency tree.
const { io } = require(
  process.env.SOCKET_IO_CLIENT_MODULE || "socket.io-client",
);

let server;
let url;
let output = "";
const clients = new Set();

function event(socket, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(name, handler);
      reject(new Error(`Timed out waiting for ${name}; server: ${output}`));
    }, 5000);
    function handler(...args) {
      clearTimeout(timer);
      resolve(args);
    }
    socket.once(name, handler);
  });
}

async function connect(transport) {
  const socket = io(url, {
    autoConnect: false,
    transports: [transport],
    reconnection: false,
  });
  clients.add(socket);
  const initialized = event(socket, "init-room");
  socket.connect();
  await initialized;
  assert.equal(socket.io.engine.transport.name, transport);
  return socket;
}

before(async () => {
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  url = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["dist/index.js"], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (data) => (output += data));
  server.stderr.on("data", (data) => (output += data));
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /collaboration server is up/);
      return;
    } catch {
      if (server.exitCode !== null) throw new Error(output);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Server did not start: ${output}`);
});

after(async () => {
  for (const socket of clients) socket.disconnect();
  if (server && server.exitCode === null) {
    server.kill();
    await once(server, "exit");
  }
});

for (const transport of ["websocket", "polling"]) {
  test(`${transport}: collaboration, binary relay, follow and reconnect`, async () => {
    const alice = await connect(transport);
    const bob = await connect(transport);
    const room = `smoke-${transport}`;
    const first = event(alice, "first-in-room");
    alice.emit("join-room", room);
    await first;
    const newUser = event(alice, "new-user");
    const users = event(bob, "room-user-change");
    bob.emit("join-room", room);
    assert.deepEqual(await newUser, [bob.id]);
    assert.deepEqual((await users)[0].sort(), [alice.id, bob.id].sort());

    const data = Buffer.from([0, 255, 42, 10]);
    const iv = Buffer.from([8, 6, 4]);
    const broadcast = event(bob, "client-broadcast");
    alice.emit("server-broadcast", room, data, iv);
    const [receivedData, receivedIv] = await broadcast;
    assert.deepEqual(Buffer.from(receivedData), data);
    assert.deepEqual(Buffer.from(receivedIv), iv);

    // Volatile delivery may intentionally drop while a polling response is busy.
    // Retry sending to exercise the event without requiring reliable delivery.
    const volatile = event(bob, "client-broadcast");
    const repeat = setInterval(() => {
      alice.emit("server-volatile-broadcast", room, data, iv);
    }, 50);
    try {
      assert.deepEqual(Buffer.from((await volatile)[0]), data);
    } finally {
      clearInterval(repeat);
    }

    const payload = { userToFollow: { socketId: alice.id, username: "Alice" } };
    const followed = event(alice, "user-follow-room-change");
    bob.emit("user-follow", { ...payload, action: "FOLLOW" });
    assert.deepEqual(await followed, [[bob.id]]);
    const unfollowed = event(alice, "user-follow-room-change");
    bob.emit("user-follow", { ...payload, action: "UNFOLLOW" });
    assert.deepEqual(await unfollowed, [[]]);

    const oldId = bob.id;
    const departed = event(alice, "room-user-change");
    bob.disconnect();
    assert.deepEqual(await departed, [[alice.id]]);
    const initialized = event(bob, "init-room");
    bob.connect();
    await initialized;
    assert.notEqual(bob.id, oldId);
    const rejoined = event(alice, "new-user");
    bob.emit("join-room", room);
    assert.deepEqual(await rejoined, [bob.id]);

    const followedAgain = event(alice, "user-follow-room-change");
    bob.emit("user-follow", { ...payload, action: "FOLLOW" });
    await followedAgain;
    const stoppedFollowing = event(alice, "broadcast-unfollow");
    bob.disconnect();
    await stoppedFollowing;
    alice.disconnect();
  });
}

for (const transport of ["websocket", "polling"]) {
  test(`${transport}: rejects malformed events and unauthorized rooms`, async () => {
    const alice = await connect(transport);
    const bob = await connect(transport);
    const outsider = await connect(transport);
    const room = `security-${transport}`;
    const first = event(alice, "first-in-room");
    alice.emit("join-room", room);
    await first;
    const users = event(bob, "room-user-change");
    bob.emit("join-room", room);
    await users;

    let relayed = 0;
    let followed = 0;
    const onRelay = () => relayed++;
    const onFollow = () => followed++;
    bob.on("client-broadcast", onRelay);
    alice.on("user-follow-room-change", onFollow);
    for (const invalid of [
      null,
      {},
      { userToFollow: null },
      { action: "FOLLOW", userToFollow: {} },
    ]) {
      outsider.emit("user-follow", invalid);
    }
    for (const invalid of [
      null,
      {},
      [room],
      "",
      "x".repeat(257),
      `follow@${alice.id}`,
    ]) {
      outsider.emit("join-room", invalid);
    }
    outsider.emit("user-follow", {
      action: "FOLLOW",
      userToFollow: { socketId: alice.id },
    });
    outsider.emit("user-follow", {
      action: "UNFOLLOW",
      userToFollow: { socketId: alice.id },
    });
    outsider.emit("server-broadcast", room, Buffer.from([1]), Buffer.from([2]));
    outsider.emit(
      "server-volatile-broadcast",
      room,
      Buffer.from([1]),
      Buffer.from([2]),
    );
    alice.emit("server-broadcast", room, {}, Buffer.from([2]));
    alice.emit("server-broadcast", room, Buffer.from([1]), null);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(relayed, 0);
    assert.equal(followed, 0);
    assert.equal(server.exitCode, null);
    bob.off("client-broadcast", onRelay);
    alice.off("user-follow-room-change", onFollow);

    let privateNotifications = 0;
    outsider.on("user-follow-room-change", () => privateNotifications++);
    const collisionRoom = event(outsider, "first-in-room");
    outsider.emit("join-room", alice.id);
    await collisionRoom;

    const legitimateFollow = event(alice, "user-follow-room-change");
    bob.emit("user-follow", {
      action: "FOLLOW",
      userToFollow: { socketId: alice.id },
    });
    await legitimateFollow;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(privateNotifications, 0);
    bob.on("client-broadcast", onRelay);
    outsider.emit(
      "server-broadcast",
      `follow@${alice.id}`,
      Buffer.from([1]),
      Buffer.from([2]),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(relayed, 0);
    bob.off("client-broadcast", onRelay);
    const viewport = event(bob, "client-broadcast");
    alice.emit(
      "server-broadcast",
      `follow@${alice.id}`,
      Buffer.from([9]),
      Buffer.from([8]),
    );
    assert.deepEqual(Buffer.from((await viewport)[0]), Buffer.from([9]));
    alice.disconnect();
    bob.disconnect();
    outsider.disconnect();
  });
}
