/**
 * Arcade Input Service (Raspberry Pi)
 * ----------------------------------
 * - USB arcade encoder (joystick)
 * - Coin acceptor via optocoupler → GPIO
 * - Coin hopper (12V via relay + coin-out sensor)
 *
 * GPIO handled via libgpiod (gpiomon / gpioset)
 */

import fetch from 'node-fetch'
import Joystick from 'joystick'
import { spawn } from 'child_process'

// ============================
// CONFIG
// ============================

const API = 'http://localhost:5173/input'

// GPIO (BCM numbering)
const COIN_IN_PIN = 22        // Physical pin 15
const HOPPER_PAY_PIN = 17     // Physical pin 11
const HOPPER_COUNT_PIN = 27   // Physical pin 13

const HOPPER_TIMEOUT_MS = 15000

// USB encoder mapping
const JOYSTICK_BUTTON_MAP = {
  0: 'SPIN',
  1: 'BET_DOWN',
  2: 'BET_UP',
  3: 'AUTO',
  5: 'WITHDRAW',
  6: 'TURBO',
  8: 'MENU',
  9: 'START',
}

// Coin pulse timing (optocoupler-safe)
const COIN_PULSE_WINDOW_MS = 2500
const MIN_COIN_INTERVAL_MS = 1200
const MAX_PULSES_PER_COIN = 20

// Pulse → credit mapping
const COIN_PULSE_MAP = {
  5: 5,
  10: 10,
  20: 20,
}

// ============================
// STATE
// ============================

let shuttingDown = false
let joystick = null

let coinPulseCount = 0
let coinPulseTimer = null
let lastCoinTime = 0
let coinMonitor = null

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
USB Encoder : /dev/input/js0
Coin GPIO   : GPIO${COIN_IN_PIN} (Pin 15)
Hopper Pay  : GPIO${HOPPER_PAY_PIN} (Pin 11)
Hopper Cnt  : GPIO${HOPPER_COUNT_PIN} (Pin 13)

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
// COIN ACCEPTOR (GPIO)
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

    if (pulses <= 0 || pulses > MAX_PULSES_PER_COIN) return
    if (now - lastCoinTime < MIN_COIN_INTERVAL_MS) return

    const credits = COIN_PULSE_MAP[pulses]
    if (!credits) {
      console.warn('[COIN] Unknown pulse count:', pulses)
      return
    }

    lastCoinTime = now

    console.log('[COIN] Pulses:', pulses, 'Credits:', credits)

    dispatch({
      type: 'COIN',
      credits,
    })
  }, COIN_PULSE_WINDOW_MS)
}

function startCoinMonitor() {
  console.log('[COIN] Listening on GPIO', COIN_IN_PIN)

  coinMonitor = spawn('gpiomon', [
    '-e', 'falling',
    `GPIO${COIN_IN_PIN}`,
  ])

  coinMonitor.stdout.on('data', data => {
    console.error('[COIN GPIO DATA]', data.toString())
    handleCoinPulse()
  })

  coinMonitor.stderr.on('data', data => {
    console.error('[COIN GPIO ERROR]', data.toString())
  })
}

// ============================
// GPIO HELPERS
// ============================

function gpioset(pin, value) {
  spawn('gpioset', [
    '--mode=signal',
    `GPIO${pin}=${value}`,
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
    '-e', 'rising',
    `GPIO${HOPPER_COUNT_PIN}`,
  ])

  hopperMonitor.stdout.on('data', () => {
    if (!hopperActive) return

    hopperDispensed++
    console.log('[HOPPER] COIN OUT', hopperDispensed)

    if (hopperDispensed >= hopperTarget) {
      stopHopper()
    }
  })

  hopperMonitor.stderr.on('data', data => {
    console.error('[HOPPER GPIO ERROR]', data.toString())
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

    if (action === 'WITHDRAW') {
      dispatch({ type: 'WITHDRAW_REQUEST' })
      return
    }

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
  try { coinMonitor?.kill() } catch {}
  try { joystick?.close?.() } catch {}

  setTimeout(() => process.exit(0), 50)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ============================
// START
// ============================

startUsbEncoder()
startCoinMonitor()
