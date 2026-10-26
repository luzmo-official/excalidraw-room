import debug from "debug";
import dotenv from "dotenv";
import express from "express";
import http from "http";
import { Server as SocketIO } from "socket.io";

type UserToFollow = {
  socketId: string;
  username: string;
};
type OnUserFollowedPayload = {
  userToFollow: UserToFollow;
  action: "FOLLOW" | "UNFOLLOW";
};

// Keep client-controlled collaboration names separate from Socket.IO's private
// socket rooms and our follow rooms.
const collaborationPrefix = "collaboration@";
const collaborationRoom = (roomID: unknown): string | null =>
  typeof roomID === "string" &&
  roomID.length > 0 &&
  roomID.length <= 256 &&
  !roomID.startsWith("follow@")
    ? `${collaborationPrefix}${roomID}`
    : null;
const isBinary = (value: unknown) =>
  value instanceof ArrayBuffer || ArrayBuffer.isView(value);

function isFollowPayload(value: unknown): value is OnUserFollowedPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<OnUserFollowedPayload>;
  return (
    (payload.action === "FOLLOW" || payload.action === "UNFOLLOW") &&
    !!payload.userToFollow &&
    typeof payload.userToFollow.socketId === "string" &&
    payload.userToFollow.socketId.length > 0 &&
    payload.userToFollow.socketId.length <= 256
  );
}

const serverDebug = debug("server");
const ioDebug = debug("io");
const socketDebug = debug("socket");

dotenv.config(
  process.env.NODE_ENV !== "development"
    ? { path: ".env.production" }
    : { path: ".env.development" },
);

const app = express();
const port =
  process.env.PORT || (process.env.NODE_ENV !== "development" ? 8080 : 3002); // default port to listen

app.use(express.static("public"));

app.get("/", (req, res) => {
  res.send("Excalidraw collaboration server is up :)");
});

const server = http.createServer(app);

server.listen(port, () => {
  serverDebug(`listening on port: ${port}`);
});

try {
  const io = new SocketIO(server, {
    transports: ["websocket", "polling"],
    cors: {
      allowedHeaders: ["Content-Type", "Authorization"],
      origin: process.env.CORS_ORIGIN || "*",
      credentials: true,
    },
    allowEIO3: true,
  });

  io.on("connection", (socket) => {
    const broadcastRoom = (roomID: unknown) => {
      if (roomID === `follow@${socket.id}`) {
        return Array.from(socket.rooms).some((room) =>
          room.startsWith(collaborationPrefix),
        )
          ? roomID
          : null;
      }
      const room = collaborationRoom(roomID);
      return room && socket.rooms.has(room) ? room : null;
    };
    ioDebug("connection established!");
    io.to(`${socket.id}`).emit("init-room");
    socket.on("join-room", async (roomID) => {
      const room = collaborationRoom(roomID);
      if (!room) return;
      roomID = room;
      socketDebug(`${socket.id} has joined ${roomID}`);
      await socket.join(roomID);
      const sockets = await io.in(roomID).fetchSockets();
      if (sockets.length <= 1) {
        io.to(`${socket.id}`).emit("first-in-room");
      } else {
        socketDebug(`${socket.id} new-user emitted to room ${roomID}`);
        socket.broadcast.to(roomID).emit("new-user", socket.id);
      }

      io.in(roomID).emit(
        "room-user-change",
        sockets.map((socket) => socket.id),
      );
    });

    socket.on(
      "server-broadcast",
      (roomID: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
        const room = broadcastRoom(roomID);
        if (!room || !isBinary(encryptedData) || !isBinary(iv)) return;
        roomID = room;
        socketDebug(`${socket.id} sends update to ${roomID}`);
        socket.broadcast.to(roomID).emit("client-broadcast", encryptedData, iv);
      },
    );

    socket.on(
      "server-volatile-broadcast",
      (roomID: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
        const room = broadcastRoom(roomID);
        if (!room || !isBinary(encryptedData) || !isBinary(iv)) return;
        roomID = room;
        socketDebug(`${socket.id} sends volatile update to ${roomID}`);
        socket.volatile.broadcast
          .to(roomID)
          .emit("client-broadcast", encryptedData, iv);
      },
    );

    socket.on("user-follow", async (payload: unknown) => {
      if (!isFollowPayload(payload)) return;
      const roomID = `follow@${payload.userToFollow.socketId}`;
      if (payload.action === "FOLLOW") {
        const target = io.sockets.sockets.get(payload.userToFollow.socketId);
        const sharesRoom =
          target &&
          Array.from(socket.rooms).some(
            (room) =>
              room.startsWith(collaborationPrefix) && target.rooms.has(room),
          );
        if (!sharesRoom) return;
      }

      switch (payload.action) {
        case "FOLLOW": {
          await socket.join(roomID);

          const sockets = await io.in(roomID).fetchSockets();
          const followedBy = sockets.map((socket) => socket.id);

          io.to(payload.userToFollow.socketId).emit(
            "user-follow-room-change",
            followedBy,
          );

          break;
        }
        case "UNFOLLOW": {
          if (!socket.rooms.has(roomID)) return;
          await socket.leave(roomID);

          const sockets = await io.in(roomID).fetchSockets();
          const followedBy = sockets.map((socket) => socket.id);

          io.to(payload.userToFollow.socketId).emit(
            "user-follow-room-change",
            followedBy,
          );

          break;
        }
      }
    });

    socket.on("disconnecting", async () => {
      socketDebug(`${socket.id} has disconnected`);
      for (const roomID of Array.from(socket.rooms)) {
        const otherClients = (await io.in(roomID).fetchSockets()).filter(
          (_socket) => _socket.id !== socket.id,
        );

        const isFollowRoom = roomID.startsWith("follow@");

        if (!isFollowRoom && otherClients.length > 0) {
          socket.broadcast.to(roomID).emit(
            "room-user-change",
            otherClients.map((socket) => socket.id),
          );
        }

        if (isFollowRoom && otherClients.length === 0) {
          const socketId = roomID.replace("follow@", "");
          io.to(socketId).emit("broadcast-unfollow");
        }
      }
    });

    socket.on("disconnect", () => {
      socket.removeAllListeners();
      socket.disconnect();
    });
  });
} catch (error) {
  console.error(error);
}
