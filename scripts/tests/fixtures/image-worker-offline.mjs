import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

const denyNetwork = () => {
  throw new Error("Network disabled in image worker test");
};

globalThis.fetch = denyNetwork;
http.request = http.get = denyNetwork;
https.request = https.get = denyNetwork;
net.connect = net.createConnection = net.Socket.prototype.connect = denyNetwork;
tls.connect = denyNetwork;
syncBuiltinESMExports();

await import("../../moderation-image-worker.mjs");
