import fetch from 'node-fetch'
import Joystick from 'joystick'
import { Gpio } from 'onoff'

// ============================
// CONFIG
// ============================

const API = 'http://localhost:5173/input'

// GPIO pins (BCM numbering)
const HOPPER_PAY_PIN = 17
const HOPPER_COUNT_PIN = 27

// Hopper safety
const HOPPER_TIMEOUT_MS = 15000 // max run per payout

// Joystick button → action map
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

// Coin pulse aggregation
const COIN_PULSE_WINDOW_MS = 400
const MIN_COIN_INTERVAL_MS = 700
const MAX_PULSES_PER_COIN = 12

const COIN_PULSE_MAP = {
  1: 1,
  5: 5,
  10: 10,
}

// ============================
// GLOBAL STATE
// ============================

let shuttingDown = false
let joystick = null

// Coin state
let coinPulseCount = 0
let coinPulseTimer = null
let lastCoinTime = 0

// Hopper GPIO
const hopperPay = new Gpio(HOPPER_PAY_PIN, 'out')
const hopperCount = new Gpio(HOPPER_COUNT_PIN, 'in', 'falling', {
  debounceTimeout: 5,
})

// Hopper state
let hopperActive = false
let hopperTarget = 0
let hopperDispensed = 0
let hopperTimeout = null

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
    console.error('[DISPATCH] Failed:', err.message)
  }
}

// ============================
// COIN INPUT (ACCEPTOR)
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
// HOPPER CONTROL
// ============================

function startHopper(amount) {
  if (shuttingDown) return
  if (hopperActive) return

  hopperActive = true
  hopperTarget = amount
  hopperDispensed = 0

  console.log('[HOPPER] Start payout:', amount)

  try {
    hopperPay.writeSync(1)
  } catch (err) {
    console.error('[HOPPER] Failed to enable:', err.message)
    stopHopper()
    return
  }

  hopperTimeout = setTimeout(() => {
    console.error('[HOPPER] Timeout / jam detected')
    stopHopper()
  }, HOPPER_TIMEOUT_MS)
}

function stopHopper() {
  if (!hopperActive) return

  try {
    hopperPay.writeSync(0)
  } catch {}

  hopperActive = false

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

// Hopper coin-out sensor
hopperCount.watch(() => {
  if (shuttingDown) return
  if (!hopperActive) return

  hopperDispensed++
  console.log('[HOPPER] Coin out', hopperDispensed)

  if (hopperDispensed >= hopperTarget) {
    stopHopper()
  }
})

// ============================
// USB ENCODER
// ============================

function startUsbEncoder() {
  joystick = new Joystick(0, 3500, 350)

  joystick.on('button', (event) => {
    if (shuttingDown) return
    if (event.value !== 1) return

    const action = JOYSTICK_BUTTON_MAP[event.number]
    if (!action) return

    if (action === 'COIN') {
      handleCoinPulse()
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

  console.log('[SYSTEM] Shutting down')

  // ---- Timers ----
  if (coinPulseTimer) {
    clearTimeout(coinPulseTimer)
    coinPulseTimer = null
  }

  if (hopperTimeout) {
    clearTimeout(hopperTimeout)
    hopperTimeout = null
  }

  // ---- Hopper ----
  try {
    hopperPay.writeSync(0)
  } catch {}

  // ---- GPIO ----
  try {
    hopperCount.unwatchAll()
    hopperCount.unexport()
  } catch {}

  try {
    hopperPay.unexport()
  } catch {}

  // ---- Joystick ----
  if (joystick) {
    joystick.removeAllListeners()
    if (typeof joystick.close === 'function') {
      joystick.close()
    }
    joystick = null
  }

  // ---- Exit ----
  setTimeout(() => {
    process.exit(0)
  }, 50)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ============================
// START
// ============================

startUsbEncoder()
