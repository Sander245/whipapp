const { startRelay } = require('./relay');

const port = process.env.PORT || 8080;
startRelay(
  port,
  () => console.log('whip relay listening on ' + port),
  err => {
    console.error('relay failed to start: ' + err.message);
    process.exit(1);
  }
);
