import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 8088);
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (req.url === '/health/live') {
    res.writeHead(200).end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.url === '/health/ready') {
    res.writeHead(200).end(JSON.stringify({ status: 'ready', dependencies: 'not-yet-wired' }));
    return;
  }
  if (req.url === '/v1/capabilities') {
    res.writeHead(200).end(JSON.stringify({
      canonicalState: ['git','postgresql','temporal-history','immutable-artifacts'],
      providers: ['mock-agent'],
      experimental: ['rtk-output-reducer','caveman-style-human-summary']
    }));
    return;
  }
  res.writeHead(404).end(JSON.stringify({ error: 'not_found' }));
});

server.listen(port, () => console.log(`ASEP control-plane reference API listening on :${port}`));
