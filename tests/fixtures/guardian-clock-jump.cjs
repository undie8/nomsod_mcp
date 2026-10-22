// Advance the child guardian's wall clock without suspending the test host.
const actualNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => actualNow() + offset;
process.on('message', message => {
  if (message && message.type === 'advance-clock') {
    offset += message.ms;
    if (process.send) process.send({ type: 'clock-advanced' });
  }
});
