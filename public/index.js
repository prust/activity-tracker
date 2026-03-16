let SEC = 1000;
let MIN = 60 * SEC;
let client = new WebSocket(`ws://${location.host}/`);
client.addEventListener('error', console.error);

let ping_timeout;
function heartbeat() {
  console.log('heartbeat!');
  if (ping_timeout)
    clearTimeout(ping_timeout);

  // Use `WebSocket#terminate()`, which immediately destroys the connection,
  // instead of `WebSocket#close()`, which waits for the close timer.
  // Delay should be equal to the interval at which your server
  // sends out pings plus a conservative assumption of the latency.
  let timeout = 5 * 1000 + 1000;
  ping_timeout = setTimeout(() => {
    console.warn(`Closing connection from client due to no heartbeat in ${timeout}`);
    client.close();
  }, timeout);
}

client.addEventListener('open', heartbeat);
client.addEventListener('close', () => clearTimeout(ping_timeout));
client.addEventListener('message', function(evt) {
  console.log('received ping, sending pong');
  let data = JSON.parse(evt.data);
  let pct = data.pct || 0;
  let clocked_min = (data.clocked_ms/MIN) || 0;
  let className = pct >= 98 ? 'success' : (pct >= 95) ? 'warn' : 'danger';
  document.body.innerHTML = `<div class="hud"><div class="pct ${className}">${pct}%</div><div class="min">of ${(clocked_min).toFixed(2)}min</div></div>`;
  client.send(JSON.stringify({evt: 'pong'}));
  heartbeat();
});

// let functions = ['getTables'];
// let server = {};
// for (let fn_name of functions) {
//   server[fn_name] = proxyToServer.bind(null, fn_name);
// }

// let req_id = 0;
// function proxyToServer() {
//   req_id++;
//   client.send(JSON.stringify(arguments));
//   return new Promise(resolve => {
//     client.addEventListener('message', function() {

//     });
//   });
// }
