/**
 * Arcade Input Service (Raspberry Pi)
 * ----------------------------------
 * - USB arcade encoder (joystick)
 * - Coin acceptor (pulse-based)
 * - Coin hopper (12V via relay + hopper coin slot feedback)
 *
 * GPIO handled via libgpiod CLI (gpioset / gpiomon)
 */

import http from 'http'

import fetch from 'node-fetch'
import Joystick from 'joystick'
import { spawn } from 'child_process'

// ============================
// CONFIG
// ============================

const API = 'http://localhost:5173/input'

const GPIOCHIP = 'gpiochip0'
const HOPPER_PAY_PIN = 17

const HOPPER_TIMEOUT_MS = 60000

const JOYSTICK_BUTTON_MAP = {
  0: 'SPIN',
  1: 'BET_DOWN',
  2: 'BET_UP',
  3: 'AUTO',
  4: 'COIN',           // deposit coin pulses
  5: 'WITHDRAW',       // UI request
  6: 'WITHDRAW_COIN',  // hopper coin slot pulses
  7: 'TURBO',
  8: 'MENU',
  9: 'START',
}

// Coin timing (measured FAST mode)
const COIN_IDLE_GAP_MS = 130
const COIN_BATCH_GAP_MS = 180

// ============================
// STATE
// ============================

let shuttingDown = false
let joystick = null

// -------- Deposit coins --------
let depositPulseCount = 0
let depositIdleTimer = null
let depositBatchCredits = 0
let depositBatchTimer = null
let depositLastPulseTime = 0
let depositStartTime = 0

// -------- Hopper / withdrawal --------
let hopperActive = false
let hopperTarget = 0
let hopperDispensed = 0
let hopperTimeout = null

// ============================
// BOOT
// ============================

console.log(`
ARCADE INPUT SERVICE
--------------------
USB Encoder : /dev/input/js0
GPIO Chip   : ${GPIOCHIP}

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
// DEPOSIT COIN HANDLING
// ============================

function handleDepositPulse() {
  const now = Date.now()

  if (depositPulseCount === 0) {
    depositStartTime = now
    console.log('\n[DEPOSIT] START')
  }

  const gap = depositLastPulseTime ? now - depositLastPulseTime : 0
  depositLastPulseTime = now
  depositPulseCount++

  dispatch({
    type: 'COIN',
    credits: 5,
  })

  console.log(`[DEPOSIT] PULSE #${depositPulseCount} (+${gap}ms)`)

  if (depositIdleTimer) clearTimeout(depositIdleTimer)
  depositIdleTimer = setTimeout(finalizeDepositCoin, COIN_IDLE_GAP_MS)
}

function finalizeDepositCoin() {
  const pulses = depositPulseCount
  const duration = Date.now() - depositStartTime

  resetDepositCoin()

  console.log(`[DEPOSIT] COIN pulses=${pulses} duration=${duration}ms`)

  depositBatchCredits += pulses

  if (depositBatchTimer) clearTimeout(depositBatchTimer)
  depositBatchTimer = setTimeout(flushDepositBatch, COIN_BATCH_GAP_MS)
}

function flushDepositBatch() {
  if (depositBatchCredits <= 0) return

  const finalCredits = depositBatchCredits * 5

  console.log(`[DEPOSIT] BATCH FINAL credits=${finalCredits}`)

  // dispatch({
  //   type: 'COIN',
  //   credits: finalCredits,
  // })

  depositBatchCredits = 0
  depositBatchTimer = null
}

function resetDepositCoin() {
  depositPulseCount = 0
  depositIdleTimer = null
  depositLastPulseTime = 0
  depositStartTime = 0
}

// ============================
// HOPPER CONTROL
// ============================

function startHopper(amount) {
  if (shuttingDown || hopperActive || amount <=0 ) return

  hopperActive = true
  hopperTarget = amount
  hopperDispensed = 0

  console.log('[HOPPER] START target=', amount)

  gpioset(HOPPER_PAY_PIN, 1)

  hopperTimeout = setTimeout(() => {
    console.error('[HOPPER] TIMEOUT — FORCED STOP')
    stopHopper()
  }, (amount/20) * 1200)
}

function handleWithdrawPulse() {
  if (!hopperActive) return

  hopperDispensed += 5

  console.log(`[HOPPER] DISPENSED ${hopperDispensed}/${hopperTarget}`)

  dispatch({
    type: 'WITHDRAW_COIN',
    dispensed: 5,
  })
  if (hopperDispensed >= hopperTarget) {
    stopHopper()
  }
}

function stopHopper() {
  if (!hopperActive) return
  //
  gpioset(HOPPER_PAY_PIN, 0)
  hopperActive = false

  if (hopperTimeout) {
    clearTimeout(hopperTimeout)
    hopperTimeout = null
  }

  console.log('[HOPPER] STOP dispensed=', hopperDispensed)

  dispatch({
    type: 'WITHDRAW_COMPLETE',
    dispensed: hopperDispensed,
  })
}

// ============================
// GPIO HELPERS
// ============================

function gpioset(pin, value) {
  spawn('gpioset', [
    GPIOCHIP,
    `${pin}=${value}`,
  ])
}

// ============================
// USB ENCODER
// ============================

function startUsbEncoder() {
  joystick = new Joystick(0, 3500, 350)
  console.log('[JOYSTICK] Ready')

  try {
    joystick.on('button', e => {
      if (shuttingDown || e.value !== 1) return

      const action = JOYSTICK_BUTTON_MAP[e.number]
      if (!action) return

      console.log('[JOYSTICK]', e.number, action)

      switch (action) {
        case 'COIN':
          handleDepositPulse()
          break

        case 'WITHDRAW_COIN':
          handleWithdrawPulse()
          break

        default:
          dispatch({ type: 'ACTION', action })
      }
    })
  } catch (error) {
    console.log('JOYSTICK ERROR', error)
  }
}

// ============================
// SHUTDOWN
// ============================

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true

  console.log('[SYSTEM] SHUTDOWN')

  // try { gpioset(HOPPER_PAY_PIN, 0) } catch {}
  try { joystick?.close?.() } catch {}

  setTimeout(() => process.exit(0), 50)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ============================
// START
// ============================

startUsbEncoder()

const COMMAND_PORT = 5174

http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405)
      return res.end()
    }

    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      try {
        const payload = JSON.parse(body)

        console.log('[CMD]', payload)

        if (payload.type === 'WITHDRAW') {
          startHopper(Number(payload.amount) || 0)
        }

        res.writeHead(200)
        res.end('OK')
      } catch (e) {
        res.writeHead(400)
        res.end('BAD JSON')
      }
    })
  })
  .listen(COMMAND_PORT, () => {
    console.log(`[CMD] Listening on ${COMMAND_PORT}`)
  })
