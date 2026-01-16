/**
 * Arcade Input Service (Raspberry Pi)
 * ----------------------------------
 * - USB arcade encoder (joystick)
 * - Coin acceptor (pulse-based)
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

// GPIO (BCM)
const GPIOCHIP = 'gpiochip0'
const HOPPER_PAY_PIN = 17      // Relay / MOSFET
const HOPPER_COUNT_PIN = 27    // Coin-out opto

// Hopper safety
const HOPPER_TIMEOUT_MS = 15000

// Joystick map
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

// Coin acceptor pulses
const COIN_PULSE_WINDOW_MS = 400
const MIN_COIN_INTERVAL_MS = 700
const MAX_PULSES_PER_COIN = 12

const COIN_PULSE_MAP = {
  1: 1,
  5: 5,
  10: 10,
}

// ============================
// STATE
// ============================

let shuttingDown = false
let joystick = null

// Coin-in
let coinPulseCount = 0
let coinPulseTimer = null
let lastCoinTime = 0

// Hopper
let hopperActive = false
let hopperTarget = 0
let hopperDispensed = 0
let hopperTimeout = null
let hopperMonitor = null

// ============================
// DISPATCH
// ============================

async function dispatch(payload) {
  if (shuttingDown) return
  try {
    await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (err) {
    console.error('[DISPATCH]', err.message)
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

    dispatch({
      type: 'COIN',
      credits,
    })
  }, COIN_PULSE_WINDOW_MS)
}

// ============================
// HOPPER CONTROL (libgpiod)
// ============================

function gpioset(pin, value) {
  spawn('gpioset', [GPIOCHIP, `${pin}=${value}`])
}

function startHopper(amount) {
  if (shuttingDown || hopperActive) return

  hopperActive = true
  hopperTarget = amount
  hopperDispensed = 0

  console.log('[HOPPER] Start payout', amount)

  gpioset(HOPPER_PAY_PIN, 1)

  hopperMonitor = spawn('gpiomon', [
    '--rising-edge',
    '--num-events=0',
    GPIOCHIP,
    `${HOPPER_COUNT_PIN}`,
  ])

  hopperMonitor.stdout.on('data', () => {
    if (!hopperActive) return

    hopperDispensed++
    console.log('[HOPPER] Coin out', hopperDispensed)

    if (hopperDispensed >= hopperTarget) {
      stopHopper()
    }
  })

  hopperTimeout = setTimeout(() => {
    console.error('[HOPPER] Timeout / jam')
    stopHopper()
  }, HOPPER_TIMEOUT_MS)
}

function stopHopper() {
  if (!hopperActive) return

  gpioset(HOPPER_PAY_PIN, 0)

  hopperActive = false

  if (hopperMonitor) {
    hopperMonitor.kill()
    hopperMonitor = null
  }

  if (hopperTimeout) {
    clearTimeout(hopperTimeout)
    hopperTimeout = null
  }

  console.log('[HOPPER] Stop payout', hopperDispensed)

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

  joystick.on('button', (e) => {
    if (shuttingDown || e.value !== 1) return

    const action = JOYSTICK_BUTTON_MAP[e.number]
    if (!action) return

    if (action === 'COIN') {
      handleCoinPulse()
      return
    }

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
// CLEAN SHUTDOWN
// ============================

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true

  console.log('[SYSTEM] Shutdown')

  try { gpioset(HOPPER_PAY_PIN, 0) } catch {}
  try { hopperMonitor?.kill() } catch {}

  if (joystick) {
    joystick.removeAllListeners()
    joystick.close?.()
  }

  setTimeout(() => process.exit(0), 50)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ============================
// START
// ============================

startUsbEncoder()
