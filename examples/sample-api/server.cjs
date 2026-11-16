// A small API shaped like Stellar Horizon. It uses plain `node:http`, so spans
// carry the raw request path and no route template: the worst case for
// cardinality, and the case Parallax's path normalization exists for.
const http = require("node:http");

const port = Number(process.env.PORT || 8091);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const server = http.createServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0];
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body));
  };

  if (path === "/health") return send(200, { ok: true });

  let match;
  if ((match = /^\/accounts\/([A-Z2-7]{56})$/.exec(path))) {
    await sleep(5 + Math.random() * 30);
    return send(200, { id: match[1], sequence: "1", balances: [{ asset_type: "native", balance: "100.0000000" }] });
  }
  if ((match = /^\/accounts\/([A-Z2-7]{56})\/payments$/.exec(path))) {
    await sleep(20 + Math.random() * 120);
    return send(200, { account: match[1], records: [] });
  }
  if ((match = /^\/transactions\/([0-9a-f]{64})$/.exec(path))) {
    await sleep(10 + Math.random() * 40);
    // One in twenty lookups fails, so the error rate has something to show.
    if (Math.random() < 0.05) return send(503, { title: "Service Unavailable" });
    return send(200, { hash: match[1], successful: true });
  }
  if ((match = /^\/ledgers\/([0-9]+)$/.exec(path))) {
    await sleep(3 + Math.random() * 10);
    return send(200, { sequence: Number(match[1]) });
  }
  return send(404, { title: "Resource Missing" });
});

server.listen(port, () => console.log(JSON.stringify({ level: "info", msg: "sample api listening", port })));
