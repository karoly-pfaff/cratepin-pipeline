// Loaded with `node --import` before the CLI: fetch, socket and TLS connections, HTTP(S)
// requests and every DNS function (also on Resolver instances) fail. Each attempt also writes
// NETWORK_ATTEMPT to stderr, so a test sees it even when the command handles the error.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

function refuse(what) {
  process.stderr.write(`NETWORK_ATTEMPT ${what}\n`);
  const error = new Error(`Network use is blocked in this test: ${what}`);
  error.code = 'ENETUNREACH';
  throw error;
}

function refusing(what) {
  return () => refuse(what);
}

function isNameService(name) {
  return name.startsWith('resolve') || name.startsWith('lookup') || name === 'reverse';
}

/** Replaces every DNS function of `target`, e.g. `dns` or `dns.Resolver.prototype`. */
function blockNameService(target, label) {
  const names = Object.getOwnPropertyNames(target).filter(
    (name) => isNameService(name) && typeof target[name] === 'function',
  );
  Object.assign(
    target,
    Object.fromEntries(names.map((name) => [name, refusing(`${label}.${name}`)])),
  );
}

globalThis.fetch = async () => refuse('fetch');
net.connect = refusing('net.connect');
net.createConnection = refusing('net.createConnection');
net.Socket.prototype.connect = refusing('socket.connect');
tls.connect = refusing('tls.connect');
http.request = refusing('http.request');
http.get = refusing('http.get');
https.request = refusing('https.request');
https.get = refusing('https.get');
blockNameService(dns, 'dns');
blockNameService(dns.Resolver.prototype, 'dns.Resolver');
blockNameService(dns.promises, 'dns.promises');
blockNameService(dns.promises.Resolver.prototype, 'dns.promises.Resolver');
syncBuiltinESMExports();
