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

// Coin timing (based on your measurements)
const COIN_IDLE_GAP_MS = 60        // gap that ends ONE coin
const COIN_BATCH_GAP_MS = 120      // gap that ends coin insertion session
const MAX_PULSES_PER_COIN = 25

// Nominal pulse counts per coin
const COIN_DENOMINATIONS = [
  { pulses: 5,  value: 5 },
  { pulses: 10, value: 10 },
  { pulses: 20, value: 20 },
]

// Allowed pulse tolerance (± pulses)
const PULSE_TOLERANCE = 2

// ============================
// STATE
// ============================

let shuttingDown = false
let joystick = null

// Coin batch
let batchCredits = 0
let batchTimer = null

// Current coin
let coinPulseCount = 0
let coinIdleTimer = null
let lastPulseTime = 0
let coinStartTime = 0

// Hopper
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
// COIN RESOLUTION
// ============================

function resolveCoinValue(pulses) {
  let best = null
  let bestDelta = Infinity

  for (const coin of COIN_DENOMINATIONS) {
    const delta = Math.abs(pulses - coin.pulses)
    if (delta <= PULSE_TOLERANCE && delta < bestDelta) {
      best = coin
      bestDelta = delta
    }
  }

  return best?.value ?? null
}

// ============================
// COIN ACCEPTOR
// ============================

function handleCoinPulse() {
  if (shuttingDown) return

  const now = Date.now()

  if (coinPulseCount === 0) {
    coinStartTime = now
    console.log('\n[COIN] START')
  }

  const gap = lastPulseTime ? now - lastPulseTime : 0
  lastPulseTime = now
  coinPulseCount++

  console.log(
    `[COIN] PULSE #${coinPulseCount} (+${gap}ms)`
  )

  // if (coinPulseCount > MAX_PULSES_PER_COIN) {
  //   console.warn('[COIN] OVERFLOW — reset')
  //   resetCoin()
  //   return
  // }

  if (coinIdleTimer) clearTimeout(coinIdleTimer)
  coinIdleTimer = setTimeout(finalizeCoin, COIN_IDLE_GAP_MS)
}

function finalizeCoin() {
  const pulses = coinPulseCount
  const duration = Date.now() - coinStartTime

  resetCoin()

  // const value = resolveCoinValue(pulses)
  // if (!value) {
  //   console.warn(
  //     `[COIN] UNKNOWN pulses=${pulses} duration=${duration}ms`
  //   )
  //   return
  // }

  console.log(
    `[COIN] ACCEPT pulses=${pulses} value=${pulses} duration=${duration}ms`
  )

  // ---- BATCH ACCUMULATION ----
  batchCredits += pulses

  if (batchTimer) clearTimeout(batchTimer)
  batchTimer = setTimeout(flushBatch, COIN_BATCH_GAP_MS)
}

function flushBatch() {
  if (batchCredits <= 0) return

  console.log(`[COIN] BATCH FINAL credits=${batchCredits}`)

  dispatch({
    type: 'COIN',
    credits: batchCredits,
  })

  batchCredits = 0
  batchTimer = null
}

function resetCoin() {
  coinPulseCount = 0
  coinIdleTimer = null
  lastPulseTime = 0
  coinStartTime = 0
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
