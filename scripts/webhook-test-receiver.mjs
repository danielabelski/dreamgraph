import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.SECRET || "abcdefghijklmnopqrstuvwx";
const PORT = Number(process.env.PORT || 9999);

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const ts = req.headers["x-dreamgraph-timestamp"];
    const deliveryId = req.headers["x-dreamgraph-delivery"];
    const sigHeader = req.headers["x-dreamgraph-signature"];
    const expected = "sha256=" + createHmac("sha256", SECRET).update(`${deliveryId}.${ts}.${body}`).digest("hex");
    const valid =
      typeof sigHeader === "string" &&
      sigHeader.length === expected.length &&
      timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
    console.log(JSON.stringify({
      event: req.headers["x-dreamgraph-event"],
      event_id: req.headers["x-dreamgraph-event-id"],
      instance: req.headers["x-dreamgraph-instance"],
      delivery: deliveryId,
      timestamp: ts,
      signature_valid: valid,
      body_preview: body.slice(0, 160),
    }));
    res.writeHead(valid ? 200 : 401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: valid }));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`webhook receiver listening on :${PORT}`);
});
