/**
 * Arcade Input Service (Raspberry Pi)
 * ----------------------------------
 * - USB arcade encoder (joystick)
 * - Coin acceptor (pulse-based via relay)
 * - Coin hopper (12V via relay + coin-out sensor)
 *
 * GPIO handled via libgpiod CLI (gpioset / gpiomon)
 */

import fetch from 'node-fetch'
import Joystick from 'joystick'
import { spawn } from 'child_process'

// ============================
// CONFIG
// ============================

const API = 'http://localhost:5173/input'

const GPIOCHIP = 'gpiochip0'
const HOPPER_PAY_PIN = 17
const HOPPER_COUNT_PIN = 27

const HOPPER_TIMEOUT_MS = 15000

const JOYSTICK_BUTTON_MAP = {
  0: 'SPIN',
  1: 'BET_DOWN',
  2: 'BET_UP',
  3: 'AUTO',
  4: 'COIN',
  5: 'WITHDRAW',
  6: 'TURBO',
  8: 'MENU',
  9: 'START',
}

const COIN_PULSE_WINDOW_MS = 3000   // relay-safe
const MIN_COIN_INTERVAL_MS = 1500
const MAX_PULSES_PER_COIN = 20

const COIN_PULSE_MAP = {
  5: 5,
  10: 10,
  20: 20
}

// ============================
// STATE
// ============================

let shuttingDown = false
let joystick = null

let coinPulseCount = 0
let coinPulseTimer = null
let lastCoinTime = 0

let hopperActive = false
let hopperTarget = 0
let hopperDispensed = 0
let hopperTimeout = null
let hopperMonitor = null

// ============================
// BOOT
// ============================

console.log(`
ARCADE INPUT SERVICE
--------------------
USB Encoder: /dev/input/js0
GPIO: ${GPIOCHIP}

Ctrl+C to exit
`)

// ============================
// DISPATCH
// ============================

async function dispatch(payload) {
  if (shuttingDown) return

  try {
    console.log('[SEND]', payload)
    await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (err) {
    console.error('[DISPATCH ERROR]', err.message)
  }
}

// ============================
// COIN ACCEPTOR
// ============================

function handleCoinPulse() {
  if (shuttingDown) return

  coinPulseCount++

  if (coinPulseTimer) return

  coinPulseTimer = setTimeout(() => {
    const pulses = coinPulseCount
    coinPulseCount = 0
    coinPulseTimer = null

    const now = Date.now()

    if (pulses > MAX_PULSES_PER_COIN) return
    if (now - lastCoinTime < MIN_COIN_INTERVAL_MS) return

    const credits = COIN_PULSE_MAP[pulses]
    if (!credits) return

    lastCoinTime = now

    console.log('[COIN] Pulses:', pulses, 'Credits:', credits)

    dispatch({
      type: 'COIN',
      credits,
    })
  }, COIN_PULSE_WINDOW_MS)
}

// ============================
// GPIO HELPERS
// ============================

function gpioset(pin, value) {
  spawn('gpioset', [
    '--mode=signal',
    GPIOCHIP,
    `${pin}=${value}`,
  ])
}

// ============================
// HOPPER
// ============================

function startHopper(amount) {
  if (shuttingDown || hopperActive) return

  hopperActive = true
  hopperTarget = amount
  hopperDispensed = 0

  console.log('[HOPPER] START', amount)

  gpioset(HOPPER_PAY_PIN, 1)

  hopperMonitor = spawn('gpiomon', [
    '--rising-edge',
    GPIOCHIP,
    `${HOPPER_COUNT_PIN}`,
  ])

  hopperMonitor.stdout.on('data', data => {
    const lines = data.toString().trim().split('\n')
    for (const _ of lines) {
      if (!hopperActive) return
      hopperDispensed++
      console.log('[HOPPER] COIN OUT', hopperDispensed)
      if (hopperDispensed >= hopperTarget) {
        stopHopper()
      }
    }
  })

  hopperTimeout = setTimeout(() => {
    console.error('[HOPPER] TIMEOUT / JAM')
    stopHopper()
  }, HOPPER_TIMEOUT_MS)
}

function stopHopper() {
  if (!hopperActive) return

  gpioset(HOPPER_PAY_PIN, 0)
  hopperActive = false

  hopperMonitor?.kill()
  hopperMonitor = null

  if (hopperTimeout) {
    clearTimeout(hopperTimeout)
    hopperTimeout = null
  }

  console.log('[HOPPER] STOP', hopperDispensed)

  dispatch({
    type: 'WITHDRAW_COMPLETE',
    dispensed: hopperDispensed,
  })
}

// ============================
// USB ENCODER
// ============================

function startUsbEncoder() {
  joystick = new Joystick(0, 3500, 350)
  console.log('[JOYSTICK] Ready')

  joystick.on('button', e => {
    if (shuttingDown || e.value !== 1) return

    const action = JOYSTICK_BUTTON_MAP[e.number]
    if (!action) return

    console.log('[JOYSTICK]', e.number, action)

    if (action === 'COIN') return handleCoinPulse()
    if (action === 'WITHDRAW') return dispatch({ type: 'WITHDRAW_REQUEST' })

    dispatch({
      type: 'ACTION',
      action,
    })
  })
}

// ============================
// SHUTDOWN
// ============================

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true

  console.log('[SYSTEM] SHUTDOWN')

  try { gpioset(HOPPER_PAY_PIN, 0) } catch {}
  try { hopperMonitor?.kill() } catch {}
  try { joystick?.close?.() } catch {}

  setTimeout(() => process.exit(0), 50)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ============================
// START
// ============================

startUsbEncoder()
