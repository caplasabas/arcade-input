import readline from 'readline';
import fetch from 'node-fetch';

const API = 'http://localhost:5173/input';

const map = {
  s: 'SPIN',
  u: 'BET_UP',
  d: 'BET_DOWN',
  t: 'START',
  a: 'AUTO',
  m: 'MENU'
};

console.log(`
INPUT TEST MODE (MAC)
---------------------
s = spin
u = bet up
d = bet down
t = start
m = menu
c = coin
Ctrl+C to exit
`);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

process.stdin.setRawMode(true);

process.stdin.on('data', async (key) => {
  const k = key.toString();

  if (k === '\u0003') process.exit();

  if (k === 'c') {
    send('COIN');
    return;
  }

  const action = map[k];
  if (action) send(action);
});

async function send(action) {
  console.log('SEND:', action);
  await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action })
  });
}

// import { Gpio } from 'onoff';
//
// const inputs = {
//   spin: new Gpio(17, 'in', 'falling', { debounceTimeout: 10 }),
//   betUp: new Gpio(18, 'in', 'falling', { debounceTimeout: 10 }),
//   betDown: new Gpio(27, 'in', 'falling', { debounceTimeout: 10 }),
//   start: new Gpio(22, 'in', 'falling', { debounceTimeout: 10 }),
//   menu: new Gpio(23, 'in', 'falling', { debounceTimeout: 10 }),
//   collect: new Gpio(24, 'in', 'falling', { debounceTimeout: 10 }),
//
//   joyUp: new Gpio(5, 'in', 'falling', { debounceTimeout: 10 }),
//   joyDown: new Gpio(6, 'in', 'falling', { debounceTimeout: 10 }),
//   joyLeft: new Gpio(13, 'in', 'falling', { debounceTimeout: 10 }),
//   joyRight: new Gpio(19, 'in', 'falling', { debounceTimeout: 10 }),
// };
//
// for (const [name, gpio] of Object.entries(inputs)) {
//   gpio.watch(() => console.log('INPUT:', name));
// }
//
// process.on('SIGINT', () => {
//   Object.values(inputs).forEach(i => i.unexport());
//   process.exit();
// });


