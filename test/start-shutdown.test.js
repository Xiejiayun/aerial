import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

process.env.AERIAL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-start-shutdown-"));
process.env.AERIAL_API_KEY = "synthetic-start-key";
const { runStartCli } = await import("../src/cli/commands/start.js");

for (const [signal, expectedCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  test(`start waits for server cleanup before exiting on ${signal}`, () => {
    const signals = new EventEmitter();
    const server = new EventEmitter();
    const exits = [];
    let callback, closeCalls = 0, connectionCloseCalls = 0;
    server.close = done => { closeCalls++; callback = done; };
    server.closeAllConnections = () => { connectionCloseCalls++; };
    assert.equal(runStartCli([], { start: () => server, signals, exit: code => exits.push(code) }), server);
    signals.emit(signal);
    signals.emit(signal);
    assert.equal(closeCalls, 1);
    assert.equal(connectionCloseCalls, 1);
    assert.deepEqual(exits, []);
    server.emit("close");
    callback();
    assert.deepEqual(exits, [expectedCode]);
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
  });
}
