// test-joystick.js
import Joystick from 'joystick'

const js = new Joystick(0)

console.log('Listening…')

js.on('button', (index, value) => {
  console.log('BUTTON', index, value)
})
