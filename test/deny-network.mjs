import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';

const deny = () => { throw new Error('network forbidden by test guard'); };
globalThis.fetch = deny;
net.Socket.prototype.connect = deny;
net.createConnection = deny;
net.connect = deny;
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
dns.lookup = deny;
dns.resolve = deny;
