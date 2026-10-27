import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const port = 32123;
const server = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
process.once('exit', () => { if (server.exitCode === null) server.kill(); });
let health, deadline = Date.now() + 5000;
while (!health && Date.now() < deadline) { try { const response = await fetch('http://127.0.0.1:' + port + '/health'); if (response.ok) health = await response.json(); } catch {} if (!health) await new Promise(r => setTimeout(r, 50)); }
assert.equal(health?.status, 'ok');
const pageResponse = await fetch('http://127.0.0.1:' + port + '/'); assert.equal(pageResponse.status, 200); assert.match(await pageResponse.text(), /Echoes of Betrayal/);
for (const asset of ['/styles.css', '/app.js']) assert.equal((await fetch('http://127.0.0.1:' + port + asset)).status, 200);
const appSource = await (await fetch('http://127.0.0.1:' + port + '/app.js')).text();
assert.match(appSource, /Choose your entry point/);
assert.match(appSource, /data-form="create-room"/);
assert.match(appSource, /data-form="join-room"/);
assert.match(appSource, /placeholder="HY36B"/);
const base = 'ws://127.0.0.1:' + port + '/ws';
const sockets = [];
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base), client = { ws, messages: [] };
    sockets.push(ws);
    const timer = setTimeout(() => reject(new Error('WebSocket connect timeout')), 4000);
    ws.addEventListener('open', () => { clearTimeout(timer); ws.addEventListener('message', e => { try { client.messages.push(JSON.parse(e.data)); } catch {} }); resolve(client); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket connect failed')); }, { once: true });
  });
}
function take(c, type, predicate = () => true, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const end = Date.now() + timeoutMs;
    const poll = () => {
      const i = c.messages.findIndex(m => m.type === type && predicate(m));
      if (i >= 0) return resolve(c.messages.splice(i, 1)[0]);
      if (Date.now() > end) return reject(new Error('Timed out waiting for ' + type));
      setTimeout(poll, 15);
    };
    poll();
  });
}
const send = (c, type, data = {}) => c.ws.send(JSON.stringify({ type, ...data }));
const latestRoom = (c, predicate) => take(c, 'state', m => predicate(m.room));
try {
  const crew = await Promise.all([connect(), connect(), connect()]);
  send(crew[0], 'create', { name: 'Captain' });
  const created = await take(crew[0], 'state', m => m.room.phase === 'lobby' && m.room.players.length === 1);
  const code = created.room.code;
  assert.match(code, /^[A-HJ-NP-Z2-9]{5}$/);
  const hostAuth = await take(crew[0], 'private', m => !!m.token);
  const roomsBeforeInvalidJoin = (await (await fetch('http://127.0.0.1:' + port + '/health')).json()).rooms;
  send(crew[1], 'join', { code: 'BAD!!', name: 'Orion' });
  const malformedCode = await take(crew[1], 'error');
  assert.match(malformedCode.message, /invalid room code/i);
  const missingCode = code === 'AAAAA' ? 'BBBBB' : 'AAAAA';
  send(crew[1], 'join', { code: missingCode, name: 'Orion' });
  const unknownCode = await take(crew[1], 'error');
  assert.match(unknownCode.message, /room code not found/i);
  assert.equal((await (await fetch('http://127.0.0.1:' + port + '/health')).json()).rooms, roomsBeforeInvalidJoin, 'invalid joins must not create rooms');
  send(crew[1], 'join', { code, name: 'Orion' });
  const firstAuth = await take(crew[1], 'private', m => !!m.token);
  const firstJoinedRoom = await latestRoom(crew[1], r => r.code === code && r.players.length === 2);
  assert.deepEqual(firstJoinedRoom.room.players.map(p => p.name), ['Captain', 'Orion']);
  send(crew[0], 'start', { code, token: hostAuth.token });
  const premature = await take(crew[0], 'error');
  assert.match(premature.message, /at least three crew/i);
  const stillWaiting = await latestRoom(crew[0], r => r.phase === 'lobby' && r.players.length === 2);
  assert.equal(stillWaiting.room.code, code);
  send(crew[2], 'join', { code, name: 'Nova' });
  const secondAuth = await take(crew[2], 'private', m => !!m.token);
  const lobby = await latestRoom(crew[0], r => r.players.length === 3);
  assert.equal(lobby.room.players.length, 3);
  const auth = [hostAuth, firstAuth, secondAuth];
  send(crew[0], 'start', { code, token: auth[0].token });
  const started = await latestRoom(crew[0], r => r.phase === 'echo');
  assert.equal(started.room.players.some(p => 'role' in p || 'clue' in p), false, 'public room state must not contain private roles or clues');
  const secrets = await Promise.all(crew.map(c => take(c, 'private', m => m.role === 'crew' || m.role === 'saboteur')));
  assert.equal(secrets.filter(x => x.role === 'saboteur').length, 1);
  assert.equal(secrets.filter(x => x.role === 'crew').length, 2);
  for (let i = 0; i < crew.length; i++) assert.ok(crew[i].messages.filter(m => m.type === 'private').every(m => m.id === secrets[i].id), 'a client must only receive its own private role and clue');
  const previousId = secrets[2].id, previousRole = secrets[2].role;
  crew[2].ws.close();
  await latestRoom(crew[0], r => r.players.some(p => p.id === previousId && !p.connected));
  const returning = await connect(); send(returning, 'reconnect', { code, token: secrets[2].token });
  const restored = await take(returning, 'private', m => !!m.role);
  assert.equal(restored.id, previousId); assert.equal(restored.role, previousRole);
  await latestRoom(returning, r => r.players.some(p => p.id === previousId && p.connected));
  crew[2] = returning;
  const hints = secrets.map((x, i) => {
    const match = x.clue.match(/relay (\d+) frequency is (\d+)/i);
    assert.ok(match, 'each of the first three crew must receive a private signal fragment');
    return { index: Number(match[1]) - 1, value: Number(match[2]), player: crew[i] };
  });
  const sabIndex = secrets.findIndex(x => x.role === 'saboteur');
  for (const h of hints) send(h.player, 'set-frequency', { code, token: secrets[crew.indexOf(h.player)].token, index: h.index, value: h.value });
  await latestRoom(crew[0], r => r.phase === 'investigation');
  const crewIndex = (secrets.findIndex(x => x.role === 'saboteur') + 1) % 3;
  send(crew[crewIndex], 'tamper', { code, token: secrets[crewIndex].token, cardId: 'relay' });
  await take(crew[crewIndex], 'error', m => /role/i.test(m.message));
  const tamperRole = crew[sabIndex], sab = secrets[sabIndex];
  send(tamperRole, 'tamper', { code, token: sab.token, cardId: 'relay' });
  const altered = await latestRoom(crew[0], r => r.evidence.some(e => e.id === 'relay' && e.altered));
  assert.equal(altered.room.evidence.find(e => e.id === 'relay').text, 'A single-pulse echo came from the east relay.');
  send(tamperRole, 'tamper', { code, token: sab.token, cardId: 'clock' });
  await take(tamperRole, 'error', m => /spent/i.test(m.message));
  send(crew[0], 'advance', { code, token: secrets[0].token });
  await latestRoom(crew[0], r => r.phase === 'discussion');
  send(crew[1], 'theory', { code, token: secrets[1].token, text: 'The reroute and the seven-second drift share a timeline.' });
  await latestRoom(crew[0], r => r.theories.length === 1);
  send(crew[0], 'advance', { code, token: secrets[0].token });
  await latestRoom(crew[0], r => r.phase === 'voting');
  const sabId = started.room.players[sabIndex].id;
  const fallbackId = started.room.players[sabIndex === 0 ? 1 : 0].id;
  for (let i = 0; i < 2; i++) send(crew[i], 'vote', { code, token: secrets[i].token, targetId: i === sabIndex ? fallbackId : sabId });
  const partial = await latestRoom(crew[0], r => r.phase === 'voting' && r.votesSubmitted === 2);
  assert.equal('votes' in partial.room, false, 'ballots stay private before reveal');
  send(crew[2], 'vote', { code, token: secrets[2].token, targetId: 2 === sabIndex ? fallbackId : sabId });
  const result = await latestRoom(crew[0], r => r.phase === 'reveal');
  assert.equal(result.room.result.caught, true);
  assert.equal(result.room.result.saboteur, started.room.players[sabIndex].name);
  console.log('PASS: 3-player room, protected roles, private puzzle fragments, cooperative relay validation, role-checked one-time evidence tamper, shared theory, secret ballots, final reveal.');

  const group = await Promise.all(Array.from({ length: 9 }, () => connect()));
  send(group[0], 'create', { name: 'Capacity 1' });
  const newRoom = await take(group[0], 'state', m => m.room.phase === 'lobby' && m.room.players.length === 1);
  const capCode = newRoom.room.code;
  await take(group[0], 'private', m => !!m.token);
  for (let i = 1; i < 8; i++) {
    send(group[i], 'join', { code: capCode, name: 'Capacity ' + (i + 1) });
    await take(group[i], 'private', m => !!m.token);
  }
  const atLimit = await latestRoom(group[0], r => r.players.length === 8);
  send(group[8], 'join', { code: capCode, name: 'Ninth Player' });
  await take(group[8], 'error', m => /full|8/i.test(m.message));
  assert.equal(atLimit.room.players.length, 8);
  console.log('PASS: 8-player room capacity and ninth-player rejection.');

  const handoff = await Promise.all([connect(), connect(), connect()]);
  send(handoff[0], 'create', { name: 'Handoff 1' });
  const handoffRoom = await take(handoff[0], 'state', m => m.room.phase === 'lobby' && m.room.players.length === 1);
  const handoffCode = handoffRoom.room.code; await take(handoff[0], 'private', m => !!m.token);
  send(handoff[1], 'join', { code: handoffCode, name: 'Handoff 2' }); await take(handoff[1], 'private', m => !!m.token);
  send(handoff[2], 'join', { code: handoffCode, name: 'Handoff 3' }); await take(handoff[2], 'private', m => !!m.token);
  const fullHandoff = await latestRoom(handoff[1], r => r.players.length === 3);
  const oldCaptain = fullHandoff.room.players[0].id, nextCaptain = fullHandoff.room.players[1].id;
  handoff[0].ws.close();
  const transferred = await latestRoom(handoff[1], r => r.hostId === nextCaptain && r.players.some(p => p.id === oldCaptain && !p.connected));
  assert.equal(transferred.room.hostId, nextCaptain);
  console.log('PASS: reconnect restores the same private role; captain transfers when the host disconnects.');
} finally {
  for (const ws of sockets) try { ws.close(); } catch {}
  server.kill();
}
