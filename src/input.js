/**
 * Arcade Input Service
 * --------------------
 * Supports:
 * - Keyboard input (dev / fallback)
 * - USB arcade encoder via Linux joystick (/dev/input/js0)
 * - HTTP dispatch to SuperAce
 */

import readline from 'readline'
import fetch from 'node-fetch'
import Joystick from 'joystick'

// ============================
// CONFIG
// ============================

const API = 'http://localhost:5173/input'

// Keyboard map (DEV ONLY)
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
// Matches jstest button indices
const JOYSTICK_BUTTON_MAP = {
  0: 'SPIN',
  1: 'BET_DOWN',
  2: 'BET_UP',
  3: 'AUTO',
  8: 'MENU',
  9: 'START'
}

// ============================
// STATE
// ============================

let joystick = null
let rl = null
let shuttingDown = false

// ============================
// BOOT MESSAGE
// ============================

console.log(`
ARCADE INPUT SERVICE
--------------------
Inputs:
- USB Encoder (/dev/input/js0)
- Keyboard (DEV fallback)

Keyboard map:
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

async function dispatch(action) {
  if (shuttingDown) return

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
// KEYBOARD INPUT (DEV MODE)
// ============================

function startKeyboardInput() {
  if (!process.stdin.isTTY) {
    console.warn('[KEYBOARD] stdin is not TTY, keyboard input disabled')
    return
  }

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  process.stdin.setRawMode(true)

  process.stdin.on('data', (key) => {
    const k = key.toString()

    if (k === '\u0003') {
      shutdown()
      return
    }

    const action = KEY_MAP[k]
    if (action) dispatch(action)
  })

  console.log('[KEYBOARD] Enabled')
}

// ============================
// USB ENCODER (JOYSTICK)
// ============================

function startUsbEncoder() {
  try {
    joystick = new Joystick(0, 3500, 350)

    console.log('[JOYSTICK] Listening on /dev/input/js0')

    joystick.on('button', (index, value) => {
      // value: 1 = pressed, 0 = released
      if (value !== 1) return

      const action = JOYSTICK_BUTTON_MAP[index]
      if (!action) return

      console.log('[JOYSTICK]', index, action)
      dispatch(action)
    })

  } catch (err) {
    console.error('[JOYSTICK] Failed to initialize:', err.message)
  }
}

// ============================
// CLEAN SHUTDOWN
// ============================

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true

  console.log('\nShutting down input service...')

  try {
    if (joystick) {
      joystick.removeAllListeners()
      joystick = null
    }

    if (rl) {
      rl.close()
      rl = null
    }
  } catch (err) {
    console.error('[SHUTDOWN ERROR]', err.message)
  } finally {
    process.exit(0)
  }
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('uncaughtException', err => {
  console.error('[FATAL]', err)
  shutdown()
})

// ============================
// STARTUP
// ============================

startUsbEncoder()
startKeyboardInput()
