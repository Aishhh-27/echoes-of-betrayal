import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
const port = 32123;
const reconnectGraceMs = 3000;
const server = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], { env: { ...process.env, PORT: String(port), ROOM_RECONNECT_GRACE_MS: String(reconnectGraceMs) }, stdio: 'ignore' });
process.once('exit', () => { if (server.exitCode === null) server.kill(); });
let health, deadline = Date.now() + 5000;
while (!health && Date.now() < deadline) { try { const response = await fetch('http://127.0.0.1:' + port + '/health'); if (response.ok) health = await response.json(); } catch {} if (!health) await new Promise(r => setTimeout(r, 50)); }
assert.equal(health?.status, 'ok');
const pageResponse = await fetch('http://127.0.0.1:' + port + '/'); assert.equal(pageResponse.status, 200); const indexSource = await pageResponse.text(); assert.match(indexSource, /Echoes of Betrayal/);
assert.doesNotMatch(indexSource, /id="audio-toggle"/, 'audio control is removed because the game has no ambient audio implementation');
assert.match(indexSource, /id="announcer"[^>]*aria-live="polite"/, 'important game updates have a dedicated screen-reader live region');
console.log('PASS: unimplemented audio control removed; screen-reader announcement region is present.');
for (const asset of ['/styles.css', '/app.js']) assert.equal((await fetch('http://127.0.0.1:' + port + asset)).status, 200);
const appSource = await (await fetch('http://127.0.0.1:' + port + '/app.js')).text();
assert.match(appSource, /Choose your entry point/);
assert.match(appSource, /data-form="create-room"/);
assert.match(appSource, /data-form="join-room"/);
assert.match(appSource, /placeholder="HY36B"/);

function makeClientHarness(source, initialValues = {}) {
  const values = new Map(Object.entries(initialValues)), listeners = {}, sockets = [], timers = new Map();
  const elements = {
    '#app': { innerHTML: '', querySelectorAll: () => [] },
    '#connection': { textContent: '' },
    '#announcer': { textContent: '' },
    '#toast': { textContent: '', classList: { add() {}, remove() {} } },
    '#player-name': { value: '' },
    '#join-code': { value: '' }
  };
  class BrowserSocket {
    static OPEN = 1; static CLOSING = 2;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    open() { this.readyState = BrowserSocket.OPEN; this.onopen?.(); }
    message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  let timerId = 0;
  const document = { querySelector: selector => elements[selector] || null, addEventListener: (type, handler) => { listeners[type] = handler; } };
  const localStorage = { getItem: key => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  runInNewContext(source, { document, localStorage, WebSocket: BrowserSocket, location: { protocol: 'https:', host: 'game.test' }, setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id), setInterval: () => 0 });
  return { values, listeners, sockets, elements, timers, runNextTimer() { const [id, fn] = [...timers.entries()].sort((a, b) => a[0] - b[0])[0] || []; if (fn) { timers.delete(id); fn(); } } };
}
const click = (h, action, data = {}) => h.listeners.click({ target: { closest: () => ({ dataset: { action, ...data } }) } });

const client = makeClientHarness(appSource);
client.values.set('echo-room', 'ZV88J');
client.values.set('echo-token', 'saved-secret-token');
client.elements['#player-name'].value = 'ReconnectTest1';
client.elements['#join-code'].value = 'ZV88J';
client.listeners.submit({ target: { dataset: { form: 'join-room' } }, preventDefault() {} });
assert.equal(client.sockets.length, 1, 'submitting Join Room should open a WebSocket');
client.sockets[0].open();
const resumeRequest = client.sockets[0].sent[0];
assert.equal(resumeRequest.type, 'reconnect', 'same-room Join Room submit sends reconnect');
assert.equal(resumeRequest.code, 'ZV88J');
assert.equal(resumeRequest.token, 'saved-secret-token');
client.sockets[0].message({ type: 'error', code: 'ROOM_UNAVAILABLE', message: 'Room unavailable.' });
assert.match(client.elements['#app'].innerHTML, /Room connection interrupted/);
assert.match(client.elements['#app'].innerHTML, /room is no longer available/i);
assert.match(client.elements['#app'].innerHTML, /data-action="retry-reconnect"/);
assert.match(client.elements['#app'].innerHTML, /data-action="return-entry"/);
assert.equal(client.values.get('echo-room'), 'ZV88J', 'ambiguous reconnect failure preserves the saved room code');
assert.equal(client.values.get('echo-token'), 'saved-secret-token', 'ambiguous reconnect failure preserves the saved token');
click(client, 'retry-reconnect');
client.sockets[1].open();
assert.equal(client.sockets[1].sent[0].type, 'reconnect', 'retry reuses the saved session token');
client.sockets[1].message({ type: 'error', code: 'SESSION_INVALID', message: 'Saved session token is invalid.' });
assert.equal(client.values.has('echo-room'), false, 'explicit invalid-token response clears the stale room code');
assert.equal(client.values.has('echo-token'), false, 'explicit invalid-token response clears the invalid token');
assert.match(client.elements['#app'].innerHTML, /saved session token is invalid/i, 'explicit invalid token returns to entry with a clear message');
const recoveryUi = makeClientHarness(appSource, { 'echo-room': 'ZV88J', 'echo-token': 'persistent-session-token' });
recoveryUi.sockets[0].open();
recoveryUi.sockets[0].message({ type: 'private', id: 'recovering-player', token: 'persistent-session-token', role: 'crew', clue: 'sealed clue' });
recoveryUi.sockets[0].message({ type: 'state', room: { code: 'ZV88J', phase: 'echo', hostId: 'captain', players: [{ id: 'recovering-player', name: 'Recovering', connected: true }], frequencies: [null, null, null], evidence: [], theories: [], tampered: false, result: null } });
recoveryUi.sockets[0].close();
recoveryUi.runNextTimer();
recoveryUi.sockets[1].open();
assert.equal(recoveryUi.sockets[1].sent[0].type, 'reconnect', 'automatic active-room recovery retries with the saved session');
assert.equal(recoveryUi.sockets[1].sent[0].token, 'persistent-session-token', 'automatic recovery keeps using the saved token');
recoveryUi.sockets[1].message({ type: 'error', code: 'ROOM_UNAVAILABLE', message: 'Room is unavailable.' });
assert.match(recoveryUi.elements['#app'].innerHTML, /Room connection interrupted/);
assert.doesNotMatch(recoveryUi.elements['#app'].innerHTML, /ROOM PHASE \/ ECHO/, 'failed reconnect replaces the stale mission screen');
assert.match(recoveryUi.elements['#app'].innerHTML, /data-action="retry-reconnect"/);
assert.equal(recoveryUi.values.get('echo-room'), 'ZV88J');
assert.equal(recoveryUi.values.get('echo-token'), 'persistent-session-token');
click(recoveryUi, 'return-entry');
assert.equal(recoveryUi.values.has('echo-room'), false, 'intentional return clears the saved room');
assert.equal(recoveryUi.values.has('echo-token'), false, 'intentional return clears the saved token');
assert.match(recoveryUi.elements['#app'].innerHTML, /Choose your entry point/);
client.values.set('echo-room', 'OLD22');
client.values.set('echo-token', 'old-session-token');
client.elements['#player-name'].value = 'FreshCaptain';
client.listeners.submit({ target: { dataset: { form: 'create-room' } }, preventDefault() {} });
client.sockets[2].open();
assert.equal(client.sockets[2].sent[0].type, 'create', 'creating a genuinely new room uses create, not reconnect');
assert.equal(client.values.get('echo-token'), 'old-session-token', 'old credentials remain until the new room is accepted');
client.sockets[2].message({ type: 'private', id: 'fresh-player', token: 'fresh-token', role: null, clue: null });
client.sockets[2].message({ type: 'state', room: { code: 'AB234', phase: 'lobby', hostId: 'fresh-player', players: [{ id: 'fresh-player', name: 'FreshCaptain', connected: true }], frequencies: [null, null, null], evidence: [], theories: [], tampered: false, result: null } });
assert.equal(client.values.get('echo-room'), 'AB234', 'accepted new room replaces the old saved room code');
assert.equal(client.values.get('echo-token'), 'fresh-token', 'accepted new room replaces the old saved token');
const lobbyUi = makeClientHarness(appSource);
lobbyUi.elements['#player-name'].value = 'UICaptain';
lobbyUi.listeners.submit({ target: { dataset: { form: 'create-room' } }, preventDefault() {} });
lobbyUi.sockets[0].open();
lobbyUi.sockets[0].message({ type: 'private', id: 'ui-captain', token: 'ui-token', role: null, clue: null });
const lobbyUiRoom = { code: 'UI234', phase: 'lobby', hostId: 'ui-captain', players: [{ id: 'ui-captain', name: 'UICaptain', connected: true }, { id: 'ui-crew-2', name: 'UICrew2', connected: true }, { id: 'ui-crew-3', name: 'UICrew3', connected: false }], frequencies: [null, null, null], evidence: [], theories: [], tampered: false, result: null };
lobbyUi.sockets[0].message({ type: 'state', room: lobbyUiRoom });
assert.match(lobbyUi.elements['#app'].innerHTML, /2 CONNECTED — NEED 1 MORE TO LAUNCH/);
assert.match(lobbyUi.elements['#app'].innerHTML, /data-action="start" disabled>LAUNCH MISSION/);
lobbyUiRoom.players[2].connected = true;
lobbyUi.sockets[0].message({ type: 'state', room: lobbyUiRoom });
assert.match(lobbyUi.elements['#app'].innerHTML, /CREW READY — 3 CONNECTED/);
assert.doesNotMatch(lobbyUi.elements['#app'].innerHTML, /data-action="start" disabled/);
console.log('PASS: lobby shows connected-player count and gates the launch button until three players are online.');
const votingUiRoom = { ...lobbyUiRoom, phase: 'voting', votesSubmitted: 1, voteTotal: 3, votesAbstained: 0 };
lobbyUi.sockets[0].message({ type: 'private', id: 'ui-captain', token: 'ui-token', role: 'crew', clue: 'private clue', voteStatus: 'eligible' });
lobbyUi.sockets[0].message({ type: 'state', room: votingUiRoom });
assert.match(lobbyUi.elements['#app'].innerHTML, /Results reveal automatically after every eligible player submits a ballot/);
assert.match(lobbyUi.elements['#app'].innerHTML, /1 OF 3 ELIGIBLE BALLOTS/);
assert.doesNotMatch(lobbyUi.elements['#app'].innerHTML, /REVEAL EARLY/);
click(lobbyUi, 'select-vote', { target: 'ui-crew-2' });
assert.match(lobbyUi.elements['#app'].innerHTML, /vote-option selected[^>]*data-target="ui-crew-2"/);
lobbyUi.sockets[0].message({ type: 'state', room: { ...votingUiRoom, votesSubmitted: 2 } });
assert.match(lobbyUi.elements['#app'].innerHTML, /vote-option selected[^>]*data-target="ui-crew-2"/, 'another player voting does not clear this player’s selection');
assert.match(lobbyUi.elements['#announcer'].textContent, /2 of 3 eligible ballots received/i, 'meaningful voting progress is announced');
const lastAnnouncement = lobbyUi.elements['#announcer'].textContent;
lobbyUi.sockets[0].message({ type: 'state', room: { ...votingUiRoom, votesSubmitted: 2 } });
assert.equal(lobbyUi.elements['#announcer'].textContent, lastAnnouncement, 'an unchanged room snapshot is not re-announced');
lobbyUi.sockets[0].message({ type: 'state', room: { ...votingUiRoom, phase: 'discussion' } });
assert.match(lobbyUi.elements['#announcer'].textContent, /Mission phase: crew discussion/i);
lobbyUi.sockets[0].message({ type: 'private', id: 'ui-captain', token: 'ui-token', role: 'crew', clue: 'private clue', voteStatus: 'eligible' });
lobbyUi.sockets[0].message({ type: 'state', room: votingUiRoom });
assert.doesNotMatch(lobbyUi.elements['#app'].innerHTML, /vote-option selected/, 'phase transition clears the old unsubmitted selection');
click(lobbyUi, 'select-vote', { target: 'ui-crew-2' });
click(lobbyUi, 'submit-vote');
assert.equal(lobbyUi.sockets[0].sent.at(-1).type, 'vote');
assert.doesNotMatch(lobbyUi.elements['#app'].innerHTML, /data-action="submit-vote"/, 'pending submission cannot be resubmitted');
lobbyUi.sockets[0].message({ type: 'private', id: 'ui-captain', token: 'ui-token', role: 'crew', clue: 'private clue', voteStatus: 'submitted' });
assert.doesNotMatch(lobbyUi.elements['#app'].innerHTML, /vote-option selected/);
assert.doesNotMatch(lobbyUi.elements['#app'].innerHTML, /data-action="submit-vote"/, 'accepted ballot cannot be changed or submitted again');
lobbyUi.sockets[0].message({ type: 'private', id: 'ui-captain', token: 'ui-token', role: 'crew', clue: 'private clue', voteStatus: 'abstained' });
lobbyUi.sockets[0].message({ type: 'state', room: { ...votingUiRoom, votesAbstained: 1 } });
assert.match(lobbyUi.elements['#app'].innerHTML, /this ballot is forfeited/i);
assert.doesNotMatch(lobbyUi.elements['#app'].innerHTML, /data-action="submit-vote"/);
console.log('PASS: voting UI explains automatic reveal and abstention; no early-reveal control is present.');
console.log('PASS: real Join Room handler resumes with saved token; ambiguous errors preserve it; explicit invalid-token errors clear it; new rooms replace credentials on success.');
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
  send(crew[1], 'reconnect', { code: missingCode, token: 'saved-token' });
  const unavailable = await take(crew[1], 'error');
  assert.equal(unavailable.code, 'ROOM_UNAVAILABLE', 'missing room is ambiguous; it must not be marked as a permanently invalid token');
  assert.equal((await (await fetch('http://127.0.0.1:' + port + '/health')).json()).rooms, roomsBeforeInvalidJoin, 'invalid joins must not create rooms');
  send(crew[1], 'join', { code, name: 'Orion' });
  const firstAuth = await take(crew[1], 'private', m => !!m.token);
  const firstJoinedRoom = await latestRoom(crew[1], r => r.code === code && r.players.length === 2);
  assert.deepEqual(firstJoinedRoom.room.players.map(p => p.name), ['Captain', 'Orion']);
  send(crew[0], 'start', { code, token: hostAuth.token });
  const premature = await take(crew[0], 'error');
  assert.match(premature.message, /at least three (connected )?crew members/i);
  const stillWaiting = await latestRoom(crew[0], r => r.phase === 'lobby' && r.players.length === 2);
  assert.equal(stillWaiting.room.code, code);
  send(crew[2], 'join', { code, name: 'Nova' });
  const secondAuth = await take(crew[2], 'private', m => !!m.token);
  const lobby = await latestRoom(crew[0], r => r.players.length === 3);
  assert.equal(lobby.room.players.length, 3);
  const disconnectedPlayerId = secondAuth.id;
  const disconnectedAt = Date.now();
  crew[2].ws.close();
  const understaffed = await latestRoom(crew[0], r => r.code === code && r.phase === 'lobby' && r.players.some(p => p.id === disconnectedPlayerId && !p.connected) && r.players.filter(p => p.connected).length === 2);
  assert.equal(understaffed.room.players.length, 3, 'disconnecting does not delete the player from the room roster');
  assert.equal(understaffed.room.players.find(p => p.id === disconnectedPlayerId).name, 'Nova', 'the disconnected player keeps the same identity');
  send(crew[0], 'start', { code, token: hostAuth.token });
  const disconnectedLaunch = await take(crew[0], 'error', m => /at least three (connected )?crew members/i.test(m.message));
  assert.match(disconnectedLaunch.message, /at least three (connected )?crew members/i);
  const rejoinedLobby = await connect();
  send(rejoinedLobby, 'reconnect', { code, token: secondAuth.token });
  const rejoinedLobbyPrivate = await take(rejoinedLobby, 'private', m => m.token === secondAuth.token);
  assert.equal(rejoinedLobbyPrivate.id, disconnectedPlayerId, 'reconnect restores the original player identity');
  assert.ok(Date.now() - disconnectedAt < reconnectGraceMs, 'temporary disconnect reconnects within the configured grace period');
  const staffedRoom = await latestRoom(crew[0], r => r.code === code && r.phase === 'lobby' && r.players.filter(p => p.connected).length === 3 && r.players.some(p => p.id === disconnectedPlayerId && p.connected));
  assert.equal(staffedRoom.room.players.filter(p => p.id === disconnectedPlayerId).length, 1, 'reconnect does not add a duplicate roster entry');
  crew[2] = rejoinedLobby;
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
  assert.equal(new Set(hints.map(h => h.index)).size, 3, 'the three signal fragments identify distinct relays');
  const tune = (h, index = h.index) => send(h.player, 'set-frequency', { code, token: secrets[crew.indexOf(h.player)].token, index, value: h.value });
  const [firstHint, secondHint, thirdHint] = hints;
  tune(firstHint);
  await latestRoom(crew[0], r => r.code === code && r.phase === 'echo' && r.frequencies[firstHint.index]?.playerId === secrets[0].id);
  tune(secondHint);
  const twoTunings = await latestRoom(crew[0], r => r.code === code && r.phase === 'echo' && r.frequencies[secondHint.index]?.playerId === secrets[1].id);
  assert.equal(twoTunings.room.frequencies.filter(Boolean).length, 2, 'two distinct players can hold two relays');
  tune(firstHint, thirdHint.index);
  await take(firstHint.player, 'error', m => /one crew member can tune only one relay/i.test(m.message));
  tune(thirdHint);
  const solvedEcho = await latestRoom(crew[0], r => r.code === code && r.phase === 'investigation');
  const expectedFrequencies = Array(3).fill(null);
  for (const h of hints) expectedFrequencies[h.index] = { playerId: secrets[crew.indexOf(h.player)].id, value: h.value };
  assert.deepEqual(solvedEcho.room.frequencies, expectedFrequencies, 'a rejected duplicate ownership claim leaves both valid selections intact and three distinct players solve the puzzle');
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
  const firstVoterIndex = sabIndex === 0 ? 1 : 0;
  const lastVoterIndex = [0, 1, 2].find(i => i !== sabIndex && i !== firstVoterIndex);
  send(crew[firstVoterIndex], 'vote', { code, token: secrets[firstVoterIndex].token, targetId: sabId });
  const partial = await latestRoom(crew[firstVoterIndex], r => r.phase === 'voting' && r.votesSubmitted === 1);
  assert.equal(partial.room.voteTotal, 3);
  assert.equal(partial.room.votesAbstained, 0);
  assert.equal('votes' in partial.room, false, 'ballots stay private before reveal');
  assert.equal(partial.room.result, null, 'no partial result is exposed after one ballot');
  send(crew[0], 'advance', { code, token: secrets[0].token });
  const earlyReveal = await take(crew[0], 'error', m => /automatically.*eligible ballot/i.test(m.message));
  assert.match(earlyReveal.message, /automatically.*eligible ballot/i, 'captain cannot reveal before all eligible players vote');
  crew[sabIndex].ws.close();
  const afterDisconnect = await latestRoom(crew[firstVoterIndex], r => r.phase === 'voting' && r.votesAbstained === 1);
  assert.equal(afterDisconnect.room.votesSubmitted, 1, 'disconnecting uncast voter preserves submitted ballots');
  assert.equal(afterDisconnect.room.voteTotal, 2, 'disconnected uncast voter is removed from the active ballot electorate');
  assert.equal('votes' in afterDisconnect.room, false, 'disconnect does not reveal a partial tally');
  const returningSaboteur = await connect();
  send(returningSaboteur, 'reconnect', { code, token: secrets[sabIndex].token });
  const restoredSaboteur = await take(returningSaboteur, 'private', m => m.id === sabId && !!m.role);
  assert.equal(restoredSaboteur.role, 'saboteur', 'reconnect preserves the private role');
  assert.equal(restoredSaboteur.clue, secrets[sabIndex].clue, 'reconnect preserves the private briefing');
  assert.equal(restoredSaboteur.voteStatus, 'abstained', 'reconnected player remains abstained from this ballot');
  await latestRoom(returningSaboteur, r => r.players.some(p => p.id === sabId && p.connected));
  send(returningSaboteur, 'vote', { code, token: secrets[sabIndex].token, targetId: started.room.players[lastVoterIndex].id });
  await take(returningSaboteur, 'error', m => /not eligible/i.test(m.message));
  const stillSecret = await latestRoom(crew[firstVoterIndex], r => r.phase === 'voting' && r.votesSubmitted === 1 && r.votesAbstained === 1);
  assert.equal(stillSecret.room.result, null, 'ineligible reconnect cannot cast a vote or force reveal');
  send(crew[lastVoterIndex], 'vote', { code, token: secrets[lastVoterIndex].token, targetId: sabId });
  const result = await latestRoom(crew[firstVoterIndex], r => r.phase === 'reveal');
  assert.equal(result.room.result.caught, true);
  assert.equal(result.room.result.saboteur, started.room.players[sabIndex].name);
  assert.ok(result.room.result.votes.some(v => v.voter === started.room.players[sabIndex].name && v.target === 'No vote'), 'disconnected saboteur is shown as abstaining, not as having voted');
  console.log('PASS: 3-player gameplay, protected roles, private puzzle fragments, relay validation, evidence tamper, theory board, secret voting, early-reveal rejection, disconnect abstention, reconnect, and automatic final reveal.');

  crew[sabIndex] = returningSaboteur;
  crew[firstVoterIndex].ws.close();
  const oneDeparted = await latestRoom(crew[lastVoterIndex], r => r.phase === 'reveal' && r.players.find(p => p.id === secrets[firstVoterIndex].id)?.connected === false);
  assert.equal(oneDeparted.room.result.saboteur, started.room.players[sabIndex].name, 'one completed-game departure leaves the room and results available to others');
  crew[lastVoterIndex].ws.close();
  const twoDeparted = await latestRoom(crew[sabIndex], r => r.phase === 'reveal' && r.players.filter(p => p.connected).length === 1);
  assert.equal(twoDeparted.room.result.saboteur, started.room.players[sabIndex].name, 'a second departure still does not destroy the completed game for the remaining player');
  const completedRoomCode = code;
  const completedRoomToken = secrets[sabIndex].token;
  crew[sabIndex].ws.close();
  await new Promise(r => setTimeout(r, 100));
  const graceReconnect = await connect();
  send(graceReconnect, 'reconnect', { code: completedRoomCode, token: completedRoomToken });
  const graceReconnectPrivate = await take(graceReconnect, 'private', m => m.token === completedRoomToken);
  assert.equal(graceReconnectPrivate.id, secrets[sabIndex].id, 'a fully empty completed room remains recoverable during its grace period');
  await latestRoom(graceReconnect, r => r.code === completedRoomCode && r.phase === 'reveal');
  graceReconnect.ws.close();
  await new Promise(r => setTimeout(r, 100));

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

  await new Promise(r => setTimeout(r, reconnectGraceMs + 500));
  const expiredRoomClient = await connect();
  send(expiredRoomClient, 'reconnect', { code: completedRoomCode, token: completedRoomToken });
  const expiredRoomResponse = await take(expiredRoomClient, 'error');
  assert.equal(expiredRoomResponse.code, 'ROOM_UNAVAILABLE', 'room expiration returns the client’s explicit recoverable unavailable-room code');
  console.log('PASS: completed room expires only after every player leaves and the configured reconnect grace period elapses.');
} finally {
  for (const ws of sockets) try { ws.close(); } catch {}
  server.kill();
}
