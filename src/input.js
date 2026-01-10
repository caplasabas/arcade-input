/**
 * Arcade Input Service
 * --------------------
 * Supports:
 * - Keyboard input (dev / fallback)
 * - USB arcade encoder via Linux joystick (/dev/input/js0)
 * - HTTP dispatch to SuperAce
 * - GPIO scaffold (Pi, optional)
 */

import readline from 'readline'
import fetch from 'node-fetch'
import Joystick from 'joystick'

// ============================
// CONFIG
// ============================

const API = 'http://localhost:5173/input'

// Keyboard map (DEV)
const KEY_MAP = {
  s: 'SPIN',
  u: 'BET_UP',
  d: 'BET_DOWN',
  t: 'START',
  a: 'AUTO',
  m: 'MENU',
  c: 'COIN'
}

// Joystick button → action map
// Matches jstest button numbers
const JOYSTICK_BUTTON_MAP = {
  0: 'SPIN',       // Button 1
  1: 'BET_DOWN',  // Button 2
  2: 'BET_UP',    // Button 3
  3: 'AUTO',      // Button 4
  8: 'MENU',      // SELECT
  9: 'START'      // START
}

// ============================
// BOOT MESSAGE
// ============================

console.log(`
ARCADE INPUT SERVICE
--------------------
Modes:
- Keyboard (DEV)
- USB Encoder (Joystick)

Keyboard:
s = spin
u = bet up
d = bet down
t = start
a = auto
m = menu
c = coin

Ctrl+C to exit
`)

// ============================
// DISPATCH
// ============================

async function send(action) {
  try {
    console.log('[SEND]', action)

    await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    })
  } catch (err) {
    console.error('[ERROR] Dispatch failed:', err.message)
  }
}

// ============================
// KEYBOARD INPUT (DEV)
// ============================

function startKeyboardInput() {
  readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  process.stdin.setRawMode(true)

  process.stdin.on('data', (key) => {
    const k = key.toString()

    if (k === '\u0003') shutdown()

    const action = KEY_MAP[k]
    if (action) send(action)
  })
}

// ============================
// USB ENCODER (JOYSTICK)
// ============================

let joystick = null

function startUsbEncoder() {
  try {
    // js0 = first encoder
    joystick = new Joystick(0, 3500, 350)

    console.log('[JOYSTICK] Listening on /dev/input/js0')

    joystick.on('button', (index, value) => {
      // value: 1 = press, 0 = release
      if (value !== 1) return

      const action = JOYSTICK_BUTTON_MAP[index]
      if (!action) return

      console.log('[JOYSTICK]', index, action)
      send(action)
    })

  } catch (err) {
    console.warn('[JOYSTICK] Not available:', err.message)
  }
}

// ============================
// GPIO INPUT (OPTIONAL, PI)
// ============================
//
// import { Gpio } from 'onoff'
//
// const GPIO_INPUTS = {
//   SPIN: 17,
//   BET_UP: 18,
//   BET_DOWN: 27,
//   START: 22,
//   MENU: 23,
//   COIN: 24
// }
//
// const gpioHandles = []
//
// function startGpioInput() {
//   for (const [action, pin] of Object.entries(GPIO_INPUTS)) {
//     const gpio = new Gpio(pin, 'in', 'falling', { debounceTimeout: 10 })
//
//     gpio.watch(() => {
//       console.log('[GPIO]', action)
//       send(action)
//     })
//
//     gpioHandles.push(gpio)
//   }
// }

// ============================
// CLEAN SHUTDOWN
// ============================

function shutdown() {
  console.log('\nShutting down input service...')

  if (joystick) {
    joystick.removeAllListeners()
  }

  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ============================
// STARTUP
// ============================

startKeyboardInput()
startUsbEncoder()
// startGpioInput() // enable only on Pi with GPIO
