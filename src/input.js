/**
 * Arcade Input Service
 * --------------------
 * Supports:
 * - Keyboard input (dev / fallback)
 * - USB arcade encoder (HID gamepad)
 * - HTTP dispatch to SuperAce
 * - GPIO scaffold (Pi, optional)
 */

import readline from 'readline'
import fetch from 'node-fetch'
import HID from 'node-hid'

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

// USB encoder button map (adjust after logging)
const GAMEPAD_BUTTON_MAP = {
  0: 'SPIN',      // A
  1: 'BET_DOWN', // B
  2: 'BET_UP',   // X
  3: 'AUTO',     // Y
  8: 'MENU',     // SELECT
  9: 'START'     // START
}

// ============================
// BOOT MESSAGE
// ============================

console.log(`
ARCADE INPUT SERVICE
--------------------
Modes:
- Keyboard (DEV)
- USB Encoder (HID)

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
// KEYBOARD INPUT
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
// USB ENCODER (HID GAMEPAD)
// ============================

let hidDevice = null
let lastButtonState = {}

function startUsbEncoder() {
  const devices = HID.devices()

  const gamepad = devices.find(d =>
    d.usagePage === 0x01 &&
    (d.usage === 0x04 || d.usage === 0x05)
  )

  if (!gamepad) {
    console.warn('[HID] No USB gamepad encoder found')
    return
  }

  console.log('[HID] Using device:', gamepad.product)

  hidDevice = new HID.HID(gamepad.path)

  hidDevice.on('data', (data) => {
    // Typical zero-delay encoder format:
    // data[0] = buttons bitmask (varies per model)
    const buttons = data[0]

    for (let i = 0; i < 8; i++) {
      const pressed = (buttons & (1 << i)) !== 0
      const wasPressed = lastButtonState[i]

      if (pressed && !wasPressed) {
        const action = GAMEPAD_BUTTON_MAP[i]
        if (action) {
          console.log('[HID]', i, action)
          send(action)
        }
      }

      lastButtonState[i] = pressed
    }
  })

  hidDevice.on('error', err => {
    console.error('[HID ERROR]', err.message)
  })
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

  if (hidDevice) {
    hidDevice.close()
  }

  // gpioHandles.forEach(gpio => gpio.unexport())

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
