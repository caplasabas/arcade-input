/**
 * Arcade Input Service (Raspberry Pi)
 * ----------------------------------
 * - USB arcade encoder (joystick)
 * - Coin acceptor (pulse-based)
 * - Coin hopper (12V via relay + coin-out sensor)
 *
 * GPIO handled via libgpiod
 */

import fetch from 'node-fetch'
import Joystick from 'joystick'
import { spawn } from 'child_process'

// ============================
// CONFIG
// ============================

const API = 'http://localhost:5173/input'

// Hopper GPIO
const GPIOCHIP = 'gpiochip0'
const HOPPER_PAY_PIN = 17
const HOPPER_COUNT_PIN = 27
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

// Coin pulse behavior
const COIN_IDLE_GAP_MS = 350        // gap that ends ONE coin
const MAX_PULSES_PER_COIN = 20

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
let coinIdleTimer = null

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
GPIO Chip  : ${GPIOCHIP}

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
// COIN ACCEPTOR (GAP-BASED)
// ============================

function handleCoinPulse() {
  if (shuttingDown) return

  coinPulseCount++

  if (coinPulseCount > MAX_PULSES_PER_COIN) {
    resetCoin()
    return
  }

  if (coinIdleTimer) clearTimeout(coinIdleTimer)

  coinIdleTimer = setTimeout(finalizeCoin, COIN_IDLE_GAP_MS)
}

function finalizeCoin() {
  const pulses = coinPulseCount
  resetCoin()

  const credits = COIN_PULSE_MAP[pulses]
  if (!credits) {
    console.warn('[COIN] Unknown pulse count:', pulses)
    return
  }

  console.log('[COIN] Pulses:', pulses, 'Credits:', credits)

  dispatch({
    type: 'COIN',
    credits,
  })
}

function resetCoin() {
  coinPulseCount = 0
  coinIdleTimer = null
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
  try { joystick?.close?.() } catch {}

  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ============================
// START
// ============================

startUsbEncoder()
